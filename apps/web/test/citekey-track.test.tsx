/**
 * Citekey tracking (the Zotero-parity pinning slice):
 *
 * ENGINE (`syncSourceCitekey` — the one pass behind PageView's open-backfill
 * guard and App's change watcher):
 *  - backfills a missing citekey (always on while the Sources feature is on
 *    — no generation toggle); idempotent no-op once converged;
 *  - the Sources FEATURE toggle (enabled:false) gates every automatic
 *    write — the only off switch;
 *  - a pinned citekey (per-value metadata `{ pinned: true }`) is never
 *    rewritten; an explicit `{ pinned: false }` reads unpinned;
 *  - an unpinned citekey rewrites when the metadata render drifts;
 *  - empty metadata (nothing to generate from) and non-source/class nodes
 *    are honest no-ops;
 *  - the collision scan covers the live library (deterministic suffix);
 *  - a manual carrier-shaped key reads as the current value (shape-aware
 *    contract) — converged, no duplicate write.
 *
 * PIN BUTTON (TextPropertyRow, beside the property name):
 *  - renders on the citekey row of a source-lineage node only;
 *  - disabled while no non-empty value exists;
 *  - click pins (value-preserving metadata write), re-click unpins;
 *  - a manual edit auto-pins (the BBT precedent).
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js), the
 * text-property-blocks conventions — the source family classes, the scoped
 * citekey/authors/publicationDate schemas + base bindings, flushWrites.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PropertiesTable } from "../src/features/metadata/index.js";
import {
  citekeyIsPinned,
  syncSourceCitekey,
} from "../src/features/sources/citekeyTrack.js";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

const flushWrites = (): Promise<void> => act(async () => {});

/** The source base class + the scoped bibliographic schemas + base bindings. */
async function seedSourceFamily(client: WorkspaceClient): Promise<void> {
  await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES.source, { id: SYSTEM_CLASS_UUIDS.source });
  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  const P = SYSTEM_PROPERTY_UUIDS;
  await client.createPropertySchema({
    id: P.citekey,
    name: "Citekey",
    type: "text",
    scopeClassIds: [SOURCE],
    defaultValue: "",
  });
  await client.createPropertySchema({
    id: P.authors,
    name: "Authors",
    type: "text",
    multi: true,
    scopeClassIds: [SOURCE],
  });
  await client.createPropertySchema({
    id: P.publicationDate,
    name: "Publication date",
    type: "datetime",
    scopeClassIds: [SOURCE],
  });
  for (const key of ["citekey", "authors", "publicationDate"] as const) {
    await client.setClassProperty(SOURCE, P[key], {});
  }
}

function authoredCitekeyRows(client: WorkspaceClient, nodeId: string) {
  return client
    .getEffectiveProperties(nodeId)
    .filter(
      (row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey && row.source === "authored",
    );
}

/** A source node with the Lovelace metadata (renders lovelace1843notesonthe). */
async function seedLovelaceSource(client: WorkspaceClient): Promise<string> {
  const sourceId = await client.createObject({
    isEmbedded: false,
    name: "Notes on the Analytical Engine",
    classIds: [SYSTEM_CLASS_UUIDS.source],
  });
  await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.authors, "Lovelace, Ada", 0);
  const { year } = await client.ensureDateChain("1843-01-01");
  await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: year }, 0);
  return sourceId;
}

describe("syncSourceCitekey (the tracking engine)", () => {
  it("backfills a missing citekey out of the box — then idempotently no-ops", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await seedLovelaceSource(client);

    await expect(syncSourceCitekey(client, sourceId)).resolves.toBe(true);
    const rows = authoredCitekeyRows(client, sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("lovelace1843notesonthe");
    // Converged: re-runs (open guard, watcher echo) write nothing.
    await expect(syncSourceCitekey(client, sourceId)).resolves.toBe(false);
    expect(authoredCitekeyRows(client, sourceId)).toHaveLength(1);
  });

  it("writes nothing when the Sources feature itself is off (the family toggle — the only off switch)", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await seedLovelaceSource(client);
    await client.setFeatureEnabled("sources", false);

    await expect(syncSourceCitekey(client, sourceId)).resolves.toBe(false);
    expect(authoredCitekeyRows(client, sourceId)).toHaveLength(0);
  });

  it("rewrites an unpinned citekey when the metadata render drifts", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await seedLovelaceSource(client);
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.citekey, "stalekey", 0);

    await client.updateObject(sourceId, {
      contentAst: [{ type: "text", text: "The Difference Engine Notes" }],
    });
    await expect(syncSourceCitekey(client, sourceId)).resolves.toBe(true);
    const rows = authoredCitekeyRows(client, sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("lovelace1843thedifferenceengine");
  });

  it("never touches a pinned citekey; an explicit pinned:false reads unpinned", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const pinnedId = await seedLovelaceSource(client);
    await client.setProperty(pinnedId, SYSTEM_PROPERTY_UUIDS.citekey, "handpicked", 0, {
      pinned: true,
    });
    const unpinnedId = await seedLovelaceSource(client);
    await client.setProperty(unpinnedId, SYSTEM_PROPERTY_UUIDS.citekey, "stalekey", 0, {
      pinned: false,
    });

    for (const id of [pinnedId, unpinnedId]) {
      await client.updateObject(id, {
        contentAst: [{ type: "text", text: "The Difference Engine Notes" }],
      });
    }
    await expect(syncSourceCitekey(client, pinnedId)).resolves.toBe(false);
    expect(authoredCitekeyRows(client, pinnedId)[0]!.value).toBe("handpicked");

    await expect(syncSourceCitekey(client, unpinnedId)).resolves.toBe(true);
    expect(authoredCitekeyRows(client, unpinnedId)[0]!.value).toBe(
      "lovelace1843thedifferenceengine",
    );
  });

  it("citekeyIsPinned: only metadata.pinned === true pins (absent or false = unpinned)", async () => {
    const P = SYSTEM_PROPERTY_UUIDS.citekey;
    expect(citekeyIsPinned([{ propertySchemaId: P, metadata: null }])).toBe(false);
    expect(citekeyIsPinned([{ propertySchemaId: P, metadata: { pinned: false } }])).toBe(false);
    expect(citekeyIsPinned([{ propertySchemaId: P, metadata: { pinned: true } }])).toBe(true);
    // Other properties' metadata never gates the citekey.
    expect(
      citekeyIsPinned([{ propertySchemaId: SYSTEM_PROPERTY_UUIDS.authors, metadata: { pinned: true } }]),
    ).toBe(false);
  });

  it("empty metadata (nothing to generate from) is an honest no-op", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await client.createObject({
      isEmbedded: false,
      classIds: [SYSTEM_CLASS_UUIDS.source],
    });

    await expect(syncSourceCitekey(client, sourceId)).resolves.toBe(false);
    expect(authoredCitekeyRows(client, sourceId)).toHaveLength(0);
  });

  it("plain pages and class nodes are no-ops", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });

    await expect(syncSourceCitekey(client, pageId)).resolves.toBe(false);
    await expect(syncSourceCitekey(client, SYSTEM_CLASS_UUIDS.source)).resolves.toBe(false);
  });

  it("collision-suffixes against the live library (the sibling holding the natural render)", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const siblingId = await client.createObject({
      isEmbedded: false,
      name: "Whatever",
      classIds: [SYSTEM_CLASS_UUIDS.source],
    });
    await client.setProperty(siblingId, SYSTEM_PROPERTY_UUIDS.citekey, "lovelace1843notesonthe", 0);
    const sourceId = await seedLovelaceSource(client);

    await expect(syncSourceCitekey(client, sourceId)).resolves.toBe(true);
    expect(authoredCitekeyRows(client, sourceId)[0]!.value).toBe("lovelace1843notesonthea");
  });

  it("a manual carrier-shaped key reads as the current value — converged, no duplicate write", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await seedLovelaceSource(client);
    const carrier = await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "text", text: "lovelace1843notesonthe" }],
    });
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.citekey, { nodeId: carrier }, 0);

    await expect(syncSourceCitekey(client, sourceId)).resolves.toBe(false);
    // The manual carrier value survives untouched (no scalar overwrite).
    expect(authoredCitekeyRows(client, sourceId)[0]!.value).toEqual({ nodeId: carrier });
  });
});

describe("the citekey pin button (TextPropertyRow)", () => {
  /** The one property row li carrying the given schema id. */
  function rowOf(container: HTMLElement, schemaId: string): HTMLElement {
    const row = [...container.querySelectorAll<HTMLElement>("li.nt-property")].find((li) =>
      li.querySelector(`.nt-property-name[data-property-schema-id="${schemaId}"]`),
    );
    if (row === undefined) throw new Error(`no row for ${schemaId}`);
    return row;
  }

  it("renders beside the citekey row of a source node — and nowhere else", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await seedLovelaceSource(client);
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.citekey, "handpicked", 0);

    const { container } = render(<PropertiesTable client={client} nodeId={sourceId} />);
    const button = rowOf(container, SYSTEM_PROPERTY_UUIDS.citekey).querySelector<HTMLButtonElement>(
      'button[aria-label="Pin citekey"]',
    );
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
    expect(button!.getAttribute("aria-pressed")).toBe("false");
    // The authors row (a text row on the same node) carries none.
    expect(
      rowOf(container, SYSTEM_PROPERTY_UUIDS.authors).querySelector(
        'button[aria-label="Pin citekey"]',
      ),
    ).toBeNull();
  });

  it("is absent on a non-source node carrying a citekey", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Citekey", type: "text" });
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    await client.setProperty(pageId, schemaId, "manual", 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    expect(
      rowOf(container, schemaId).querySelector('button[aria-label="Pin citekey"]'),
    ).toBeNull();
  });

  it("is disabled while no non-empty citekey exists (nothing to protect)", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await client.createObject({
      isEmbedded: false,
      classIds: [SYSTEM_CLASS_UUIDS.source],
    });

    const { container } = render(<PropertiesTable client={client} nodeId={sourceId} />);
    const button = rowOf(container, SYSTEM_PROPERTY_UUIDS.citekey).querySelector<HTMLButtonElement>(
      'button[aria-label="Pin citekey"]',
    );
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(true);
  });

  it("click pins the current value (value-preserving); re-click unpins", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await seedLovelaceSource(client);
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.citekey, "handpicked", 0);

    const { container } = render(<PropertiesTable client={client} nodeId={sourceId} />);
    // The label flips with the state — query both.
    const button = () =>
      rowOf(container, SYSTEM_PROPERTY_UUIDS.citekey).querySelector<HTMLButtonElement>(
        'button[aria-label="Pin citekey"], button[aria-label="Unpin citekey"]',
      )!;
    expect(button().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button());
    await flushWrites();
    await flushWrites();
    let rows = authoredCitekeyRows(client, sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("handpicked");
    expect(rows[0]!.metadata).toEqual({ pinned: true });
    expect(button().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button());
    await flushWrites();
    await flushWrites();
    rows = authoredCitekeyRows(client, sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("handpicked");
    expect(rows[0]!.metadata).toEqual({ pinned: false });
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("a manual edit auto-pins the citekey (the hand-typed key is never auto-overwritten)", async () => {
    const client = await seedClient();
    await seedSourceFamily(client);
    const sourceId = await seedLovelaceSource(client);

    const { container } = render(<PropertiesTable client={client} nodeId={sourceId} />);
    const cell = rowOf(container, SYSTEM_PROPERTY_UUIDS.citekey).querySelector<HTMLInputElement>(
      'input.nt-property-value[placeholder="Type something"]',
    );
    expect(cell).not.toBeNull();
    fireEvent.change(cell!, { target: { value: "handwritten" } });
    fireEvent.blur(cell!);
    await flushWrites();
    await flushWrites();

    const rows = authoredCitekeyRows(client, sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata?.["pinned"]).toBe(true);
  });
});
