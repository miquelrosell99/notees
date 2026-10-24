/**
 * Sources settings section tests (owner 2026-10-24, source-library slice 3
 * task 5): the Features-tab Sources block mounted through the real
 * WorkspaceSettingsModal + WorkspaceClient (MemoryRelay + sql.js, the
 * day-features convention). A seeded source-library roster (the 39
 * type-classes + extends [source] + the 18 archived-by-default flips) backs
 * the class-visibility list.
 *
 *  - rendering: the section lands under Features with the default pattern,
 *    the live preview of the owner-ruling sample, and 39 checked-state
 *    rows (archived ones unchecked).
 *  - toggle writes: ONE workspace.feature.set per change, read-modify-merge
 *    semantics (the three keys never clobber each other).
 *  - pattern writes: valid on blur, invalid refused client-side with the
 *    inline error.
 *  - the class list: uncheck archives (the gallery's SAME active bit),
 *    recheck un-archives — a round-trip through the store.
 *  - the undo journal: the feature-set capture restores the prior enabled
 *    AND prior settings.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  type SystemClassName,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { WorkspaceSettingsModal } from "../src/features/workspaces/WorkspaceSettingsModal.js";
import {
  CITEKEY_SAMPLE_ENTRY,
  DEFAULT_CITEKEY_PATTERN,
} from "../src/features/sources/citekey.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";
const DEVICE = "test-device";

/** The 39 source type-classes (the bindings roster — every key extends source). */
const ROSTER = Object.keys(SYSTEM_SOURCE_CLASS_BINDINGS) as SystemClassName[];
const ARCHIVED = new Set<SystemClassName>(SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES);

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  // jsdom lacks ResizeObserver; Tabs.List uses it for the active indicator.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

function seedEnvelope(opType: string, payload: Record<string, unknown>, physical: number): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: DEVICE,
    client: "seed",
    hlc: { physical, logical: 0 },
    affectedNodeIds: [],
    opType,
    payload,
  });
}

const text = (s: string) => [{ type: "text", text: s }];

/** The roster seed op stream (the store test's shapes, relay-held). */
function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
  const step = () => (t += 1000);
  envelopes.push(
    seedEnvelope(
      "class.create",
      {
        classId: SYSTEM_CLASS_UUIDS.source,
        contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.source),
        icon: SYSTEM_CLASS_ICONS.source,
      },
      step(),
    ),
  );
  for (const name of ROSTER) {
    envelopes.push(
      seedEnvelope(
        "class.create",
        {
          classId: SYSTEM_CLASS_UUIDS[name],
          contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES[name]),
          icon: SYSTEM_CLASS_ICONS[name],
        },
        step(),
      ),
    );
  }
  for (const name of ROSTER) {
    envelopes.push(
      seedEnvelope(
        "class.setExtends",
        { classId: SYSTEM_CLASS_UUIDS[name], parentClassIds: [SYSTEM_CLASS_UUIDS.source] },
        step(),
      ),
    );
  }
  for (const name of SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES) {
    envelopes.push(
      seedEnvelope("object.update", { objectId: SYSTEM_CLASS_UUIDS[name], active: false }, step()),
    );
  }
  relay.ingest(envelopes);
  return relay;
}

async function seedClient(relay: MemoryRelay = seededRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

function renderModal(client: WorkspaceClient) {
  return render(
    <WorkspaceSettingsModal
      isOpen
      onClose={() => {}}
      serverUrl="https://notees.example.com"
      credential="session-token"
      workspaceId={WS}
      workspaceName="Garden"
      workspaceRole="owner"
      initialTab="features"
      client={client}
    />,
  );
}

function sourcesRow(client: WorkspaceClient) {
  return client.listFeatureRows().find((row) => row.feature === "sources");
}

// --- rendering -------------------------------------------------------------------

describe("SourcesSettingsSection rendering", () => {
  it("renders the default pattern, the live preview, and the 39-row visibility list", async () => {
    const client = await seedClient();
    renderModal(client);

    expect(screen.getByRole("heading", { name: "Sources" })).toBeInTheDocument();
    const input = screen.getByLabelText("Citekey pattern");
    expect(input).toHaveValue(DEFAULT_CITEKEY_PATTERN);
    expect(screen.getByText(/lovelace1843notesonthe/)).toBeInTheDocument();
    expect(screen.getByText(/never workspace content/i)).toBeInTheDocument();

    const list = screen.getByRole("group", { name: /source types/i });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes).toHaveLength(39);
    // Archived-by-default rows are unchecked; the everyday types are checked.
    expect(within(list).getByRole("checkbox", { name: "Artwork source type" })).not.toBeChecked();
    expect(within(list).getByRole("checkbox", { name: "Book source type" })).toBeChecked();
    expect(
      within(list).getByRole("checkbox", { name: "Journal article source type" }),
    ).toBeChecked();
  });

  it("the preview follows the draft as it is typed (live preview)", async () => {
    const client = await seedClient();
    renderModal(client);

    const input = screen.getByLabelText("Citekey pattern");
    fireEvent.change(input, { target: { value: "[auth]_[year]_[title:lower:1]" } });
    expect(screen.getByText(/Lovelace_1843_notes/)).toBeInTheDocument();

    // An invalid draft swaps the preview for the inline error and the
    // write is refused client-side.
    fireEvent.change(input, { target: { value: "[bogus]" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Unknown token/);
    fireEvent.blur(input);
    await flushWrites();
    expect(sourcesRow(client)).toBeUndefined(); // nothing was written
  });
});

// --- toggle + pattern writes -------------------------------------------------------

describe("SourcesSettingsSection writes", () => {
  it("ONE workspace.feature.set per toggle, read-modify-merged so the keys never clobber", async () => {
    const client = await seedClient();
    const first = renderModal(client);

    // The resolver default is ON (absent row/key allows, the server gate's
    // contract) — the toggle renders checked; clicking turns it OFF.
    expect(first.getByRole("switch", { name: /metadata resolver/i })).toBeChecked();
    fireEvent.click(first.getByRole("switch", { name: /metadata resolver/i }));
    await waitFor(() => {
      expect(sourcesRow(client)?.settings).toEqual({ resolverEnabled: false });
    });
    expect(sourcesRow(client)?.enabled).toBe(true);

    // A fresh mount mirrors the stored OFF; clicking turns it back ON.
    first.unmount();
    const second = renderModal(client);
    expect(second.getByRole("switch", { name: /metadata resolver/i })).not.toBeChecked();
    fireEvent.click(second.getByRole("switch", { name: /metadata resolver/i }));
    await waitFor(() => {
      expect(sourcesRow(client)?.settings).toEqual({ resolverEnabled: true });
    });

    // The second toggle merges against the current row — the first key rides.
    fireEvent.click(second.getByRole("switch", { name: /auto-citekey/i }));
    await waitFor(() => {
      expect(sourcesRow(client)?.settings).toEqual({
        resolverEnabled: true,
        autoCitekey: true,
      });
    });
  });

  it("a valid pattern commits on blur, merged into the current settings", async () => {
    const client = await seedClient();
    await client.setFeatureSettings("sources", { resolverEnabled: true });
    await flushWrites();
    renderModal(client);

    const input = screen.getByLabelText("Citekey pattern");
    fireEvent.change(input, { target: { value: "[auth]_[year]" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(sourcesRow(client)?.settings).toEqual({
        resolverEnabled: true,
        citekeyPattern: "[auth]_[year]",
      });
    });
  });

  it("the converged settings feed the controls on re-render", async () => {
    const client = await seedClient();
    await client.setFeatureSettings("sources", {
      citekeyPattern: "[auth][year]",
      resolverEnabled: true,
    });
    await flushWrites();
    renderModal(client);

    expect(screen.getByLabelText("Citekey pattern")).toHaveValue("[auth][year]");
    expect(screen.getByRole("switch", { name: /metadata resolver/i })).toBeChecked();
    expect(screen.getByRole("switch", { name: /auto-citekey/i })).not.toBeChecked();
  });
});

// --- the class-visibility list -----------------------------------------------------

describe("SourcesSettingsSection class visibility", () => {
  it("uncheck archives (the gallery's SAME active bit); recheck un-archives", async () => {
    const client = await seedClient();
    const { unmount } = renderModal(client);

    const book = SYSTEM_CLASS_UUIDS.book;
    expect(client.getNodeRaw(book)?.isActive).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Book source type" }),
    );
    await waitFor(() => expect(client.getNodeRaw(book)?.isActive).toBe(false));

    unmount();
    const second = renderModal(client);
    expect(second.getByRole("checkbox", { name: "Book source type" })).not.toBeChecked();

    fireEvent.click(second.getByRole("checkbox", { name: "Book source type" }));
    await waitFor(() => expect(client.getNodeRaw(book)?.isActive).toBe(true));
  });

  it("enabling an archived-by-default class un-archives it (two doors to one switch)", async () => {
    const client = await seedClient();
    const artwork = SYSTEM_CLASS_UUIDS.artwork;
    expect(client.getNodeRaw(artwork)?.isActive).toBe(false);

    renderModal(client);
    fireEvent.click(screen.getByRole("checkbox", { name: "Artwork source type" }));
    await waitFor(() => expect(client.getNodeRaw(artwork)?.isActive).toBe(true));
  });
});

// --- the toggle's settings-carrying fix (review round 1) ------------------------------

describe("the family toggle vs a settings row (whole-row LWW)", () => {
  it("toggling a feature whose row carries settings keeps them — off then on loses nothing", async () => {
    const client = await seedClient();
    await client.setFeatureSettings("sources", { citekeyPattern: "[auth][year]" });
    await flushWrites();
    expect(sourcesRow(client)?.settings).toEqual({ citekeyPattern: "[auth][year]" });

    // The modal's Sources family ToggleSwitch rides this same client write.
    await client.setFeatureEnabled("sources", false);
    await flushWrites();
    expect(sourcesRow(client)?.enabled).toBe(false);
    // The settings survive the OFF write (read-modify-merge, not old-shape).
    expect(sourcesRow(client)?.settings).toEqual({ citekeyPattern: "[auth][year]" });

    // …and the ON write. Two clicks in the same tab clear nothing.
    await client.setFeatureEnabled("sources", true);
    await flushWrites();
    expect(sourcesRow(client)?.enabled).toBe(true);
    expect(sourcesRow(client)?.settings).toEqual({ citekeyPattern: "[auth][year]" });
  });

  it("a feature with NO settings row keeps the old-shape write (nothing to lose)", async () => {
    const client = await seedClient();
    await client.setFeatureEnabled("tasks", false);
    await flushWrites();
    const row = client.listFeatureRows().find((entry) => entry.feature === "tasks");
    expect(row?.enabled).toBe(false);
    expect(row?.settings).toBeUndefined(); // no settings key was minted
  });
});

// --- the undo journal ----------------------------------------------------------------

describe("SourcesSettingsSection undo capture", () => {
  it("the feature-set write restores the prior enabled AND prior settings on undo", async () => {
    const client = await seedClient();
    await client.setFeatureSettings("sources", {
      citekeyPattern: "[auth][year]",
      resolverEnabled: false,
    });
    await flushWrites();
    expect(sourcesRow(client)?.settings).toEqual({
      citekeyPattern: "[auth][year]",
      resolverEnabled: false,
    });

    renderModal(client);
    fireEvent.click(screen.getByRole("switch", { name: /metadata resolver/i }));
    await waitFor(() => {
      expect(sourcesRow(client)?.settings?.resolverEnabled).toBe(true);
    });

    // The journal captured the WHOLE prior row — undo restores both the
    // toggle and the settings record.
    await client.undo();
    await flushWrites();
    const row = sourcesRow(client);
    expect(row?.enabled).toBe(true);
    expect(row?.settings).toEqual({ citekeyPattern: "[auth][year]", resolverEnabled: false });
  });
});
