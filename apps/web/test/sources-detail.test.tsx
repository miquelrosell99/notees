/**
 * Sources hub detail-pane tests (task 4 — the type-aware detail editor):
 *
 * - Selecting a row renders the detail: the type chip (the table's
 *   primary-type pick), the inline-editable title, and the Metadata
 *   section hosting the shared properties panel.
 * - The TYPE-AWARE field set (the binding fix): a journal article shows its
 *   own bound fields — Volume (valued), Issue and Pages (bound-but-empty
 *   synthesis) — and NEVER a Docket number row (the schema exists in the
 *   pool but the type binds it to nothing); a web page doesn't show the
 *   journal-only fields either (type-aware in both directions).
 * - The title edits inline through the content path (title-is-content):
 *   click swaps in the input, Enter commits one `object.update` text run,
 *   Esc cancels.
 * - Open navigates through the App's page-view seam.
 * - Delete asks in the reusable ConfirmationModal (danger, naming the
 *   display name) and trashes through deleteObject; the hub clears the
 *   selection back to the honest empty state.
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js), the
 * sources-data convention — journal ×1 (volume authored), web_page ×1,
 * the bibliographic bindings on `source`, the journal_article field-set
 * bindings (publicationTitle + volume/issue/pages), the docketNumber
 * schema in the pool bound to NOTHING (the case-orphan ruling).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
  deriveDisplayName,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { SourcesHub } from "../src/features/sources/SourcesHub.js";
import { DEFAULT_SOURCES_QUERY } from "../src/features/sources/sourcesQuery.js";

const WS = "0192b000-0000-7000-8000-00000000d001";
const ACTOR = "0192b000-0000-7000-8000-00000000d002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
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
  window.localStorage.clear();
});

export interface LibraryItems {
  journal: string;
  web: string;
}

async function seedClient(): Promise<{ client: WorkspaceClient; items: LibraryItems }> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);

  for (const name of ["source", "journal_article", "web_page"] as const) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id: SYSTEM_CLASS_UUIDS[name] });
  }
  for (const name of ["journal_article", "web_page"] as const) {
    await client.setClassExtends(SYSTEM_CLASS_UUIDS[name], [SYSTEM_CLASS_UUIDS.source]);
  }
  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  const P = SYSTEM_PROPERTY_UUIDS;
  const schema = async (key: keyof typeof SYSTEM_PROPERTY_UUIDS, multi = false) => {
    await client.createPropertySchema({
      id: P[key],
      name: SYSTEM_PROPERTY_DISPLAY_NAMES[key],
      type: "text",
      multi,
      scopeClassIds: [SOURCE],
    });
  };
  await schema("authors", true);
  await schema("citekey");
  await schema("publicationTitle");
  await schema("volume");
  await schema("issue");
  await schema("pages");
  // The docketNumber schema EXISTS in the pool (scope: the family) but no
  // class binds it — the case-orphan ruling (a journal article never shows
  // a docket-number row; the seed carries no reserved uuid for it, so the
  // test mints one, exactly like a runtime-created schema).
  await client.createPropertySchema({
    id: "0192c000-0000-7000-8000-00000000d000",
    name: "Docket number",
    type: "text",
    multi: false,
    scopeClassIds: [SOURCE],
  });
  for (const key of ["authors", "citekey"] as const) {
    await client.setClassProperty(SOURCE, P[key], {});
  }
  for (const key of ["publicationTitle", "volume", "issue", "pages"] as const) {
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.journal_article, P[key], {});
  }
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.web_page, P.publicationTitle, {});

  const items: LibraryItems = { journal: "", web: "" };
  items.journal = await client.createObject({
    isEmbedded: false,
    name: "On the Analytical Engine",
    classIds: [SYSTEM_CLASS_UUIDS.journal_article],
  });
  await client.setProperty(items.journal, P.volume, "42", 0);
  await client.setProperty(items.journal, P.citekey, "lovelace1843analytical", 0);
  items.web = await client.createObject({
    isEmbedded: false,
    name: "A Great Article",
    classIds: [SYSTEM_CLASS_UUIDS.web_page],
  });
  return { client, items };
}

function renderHub(
  client: WorkspaceClient,
  onOpenNode: ((nodeId: string) => void) | undefined = undefined,
) {
  return render(
    <SourcesHub client={client} query={DEFAULT_SOURCES_QUERY} {...(onOpenNode !== undefined ? { onOpenNode } : {})} />,
  );
}

function detailPane(): HTMLElement {
  return screen.getByRole("complementary", { name: "Source details" });
}

/** The metadata section's row labels (the properties list's name spans). */
function metadataLabels(pane: HTMLElement): string[] {
  return Array.from(pane.querySelectorAll(".nt-properties-list .nt-property-name")).map((el) => {
    // The from-class hint rides inside the name span — strip it, the label
    // is the text proper.
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".nt-property-hint").forEach((hint) => hint.remove());
    return (clone.textContent ?? "").trim();
  });
}

async function rowsReady(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  });
}

async function selectRow(client: WorkspaceClient, id: string): Promise<void> {
  await waitFor(() => {
    expect(client.getNode(id)).not.toBeUndefined();
  });
  const row = document.querySelector(`tr[data-node-id="${id}"]`) as HTMLElement;
  // The title cell selects (the row-click seam); the title text also rides
  // other chrome, so aim at the cell's own span (the Title column is the
  // second td — owner review round 2 dropped the cell's own class).
  const titleCell = row.querySelectorAll("td")[1] ?? row;
  fireEvent.click(titleCell);
}

describe("SourcesDetail — the type-aware detail editor", () => {
  it("renders the type chip, the title, and the metadata section for the selection", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();
    await selectRow(client, items.journal);

    const pane = detailPane();
    expect(within(pane).getByRole("heading", { name: "On the Analytical Engine" })).not.toBeNull();
    // The type chip: the class's live title (the table's primary-type pick).
    expect(within(pane).getByText("Journal article")).not.toBeNull();
    // The metadata section hosts the shared properties panel.
    expect(within(pane).getByRole("button", { name: /^metadata/i })).not.toBeNull();
    expect(within(pane).getByRole("list")).not.toBeNull();
  });

  it("the field set is type-aware: the journal article shows volume/issue/pages, never docketNumber", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();
    await selectRow(client, items.journal);

    const labels = metadataLabels(detailPane());
    // The journal article's own bound fields — Volume valued, Issue/Pages
    // bound-but-empty synthesized rows.
    expect(labels).toContain("Volume");
    expect(labels).toContain("Issue");
    expect(labels).toContain("Pages");
    // The family-base bindings ride too (extends-aware).
    expect(labels).toContain("Authors");
    expect(labels).toContain("Citekey");
    // The binding fix, pinned: docketNumber is NOT a journal-article field.
    expect(labels.some((label) => label.startsWith("Docket"))).toBe(false);
    // The valued row reads back (a legacy bare-string text value renders
    // inline as plain text — the first click mints a carrier block).
    expect(within(detailPane()).getByText("42")).not.toBeNull();
  });

  it("the field set follows the picked type: a web page shows no journal-only fields", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();
    await selectRow(client, items.web);

    const labels = metadataLabels(detailPane());
    expect(within(detailPane()).getByText("Web page")).not.toBeNull();
    expect(labels.some((label) => label.startsWith("Volume"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Issue"))).toBe(false);
    expect(labels.some((label) => label.startsWith("Pages"))).toBe(false);
  });

  it("the title edits inline through the content path (Enter commits a text-run update)", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();
    await selectRow(client, items.journal);

    const pane = detailPane();
    fireEvent.click(within(pane).getByRole("heading", { name: "On the Analytical Engine" }));
    const input = within(pane).getByLabelText("Source title") as HTMLInputElement;
    expect(input.value).toBe("On the Analytical Engine");
    fireEvent.change(input, { target: { value: "Notes on the Analytical Engine" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Title-is-content: one object.update rewrote the node's content.
    await waitFor(() => {
      expect(deriveDisplayName(client.getNode(items.journal)!)).toBe("Notes on the Analytical Engine");
    });
    await waitFor(() => {
      expect(
        within(detailPane()).getByRole("heading", { name: "Notes on the Analytical Engine" }),
      ).not.toBeNull();
    });
  });

  it("Esc cancels the title edit without writing", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();
    await selectRow(client, items.journal);

    const pane = detailPane();
    fireEvent.click(within(pane).getByRole("heading", { name: "On the Analytical Engine" }));
    const input = within(pane).getByLabelText("Source title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "A discarded title" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(within(pane).getByRole("heading", { name: "On the Analytical Engine" })).not.toBeNull();
    expect(deriveDisplayName(client.getNode(items.journal)!)).toBe("On the Analytical Engine");
  });

  it("Open navigates through the App's page-view seam", async () => {
    const { client, items } = await seedClient();
    const onOpenNode = vi.fn();
    renderHub(client, onOpenNode);
    await rowsReady();
    await selectRow(client, items.journal);

    fireEvent.click(within(detailPane()).getByRole("button", { name: "Open page" }));
    expect(onOpenNode).toHaveBeenCalledWith(items.journal);
  });

  it("Delete asks in the confirm modal, trashes the node, and clears the selection", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();
    await selectRow(client, items.journal);

    fireEvent.click(within(detailPane()).getByRole("button", { name: "Delete source" }));
    // The confirm pattern: danger variant, the node named by its display name.
    expect(
      screen.getByText('This will delete "On the Analytical Engine" and everything it contains.'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(client.getNode(items.journal)).toBeUndefined();
    });
    // The hub clears the selection — and the detail pane hides with it
    // (the pane renders only with a selection, so
    // the "Select a source" empty state never shows).
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: "Source details" })).toBeNull();
    });
    expect(screen.queryByText("Select a source")).toBeNull();
  });

  it("the confirm's Cancel keeps the node", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();
    await selectRow(client, items.journal);

    fireEvent.click(within(detailPane()).getByRole("button", { name: "Delete source" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(client.getNode(items.journal)).not.toBeUndefined();
    expect(
      within(detailPane()).getByRole("heading", { name: "On the Analytical Engine" }),
    ).not.toBeNull();
  });
});
