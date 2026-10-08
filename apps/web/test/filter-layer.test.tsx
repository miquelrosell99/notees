/**
 * The transient filter layer, end to end (jsdom over the in-process
 * WorkspaceClient + MemoryRelay): the FilterQuery applies
 * POST-RESOLUTION/PRE-WINDOWING (a windowed section renders the filtered
 * window, never the first-N-then-filtered), the eager count stays
 * UNFILTERED (an active filter reads "0 of N" and never hides the
 * section), the query is one instance per section view/tab (two backlinks
 * tabs never share), and the three filterable sections — linked
 * references, unlinked mentions, classed nodes — render the bar while a
 * non-filterable section (Child pages) renders none. The structured panel
 * is the block query builder — these tests drive its add menu, rows and
 * wire controls end to end (the pure builder interactions live in
 * filter-builder.test.tsx).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeView } from "../src/ui/App.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

/** Members seeded past the default window (100) in the windowing tests. */
const BIG = 120;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

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

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** WORKAROUND(store applier): class.create's contentAst never lands — seed
 * the title through object.update instead. */
async function seedClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

/** The classed-nodes table's rendered row count. */
function tableRowCount(): number {
  return screen.getAllByRole("table")[0]!.querySelectorAll(".nt-table-name-label").length;
}

/** The classed-nodes section wrapper (a class page renders the backlinks
 * strip's bar too — every bar query scopes to its own section). */
function classedNodesSection(): HTMLElement {
  const header = screen.getByRole("button", { name: /classed nodes/i });
  const section = header.closest("section");
  if (section === null) throw new Error("no classed-nodes section");
  return section as HTMLElement;
}

/** The selected tab's panel (only the active panel mounts). */
function activePanel(): HTMLElement {
  const panel = document.querySelector('[role="tabpanel"]');
  if (panel === null) throw new Error("no active tabpanel");
  return panel as HTMLElement;
}

/** The open structured-facet panel of the visible FilterBar. */
function structuredPanel(): HTMLElement {
  const panel = document.querySelector(".nt-filter-bar__panel");
  if (panel === null) throw new Error("no structured filter panel open");
  return panel as HTMLElement;
}

/** The `.nt-backlinks` strip. */
function backlinksStrip(): HTMLElement {
  const strip = document.querySelector(".nt-backlinks");
  if (strip === null) throw new Error("no .nt-backlinks strip rendered");
  return strip as HTMLElement;
}

describe("the classed-nodes filter bar", () => {
  async function seedBigClass(client: WorkspaceClient): Promise<string> {
    const classId = await seedClass(client, "project");
    for (let i = 0; i < BIG; i += 1) {
      const member = await client.createObject({
        presentAsMain: true,
        name: `Row ${String(i).padStart(3, "0")}`,
      });
      await client.assignClass(member, classId);
    }
    return classId;
  }

  it("filtering applies post-resolution/pre-windowing: the windowed table shows the filtered rows, not the first N filtered", async () => {
    const client = await seedClient();
    const classId = await seedBigClass(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();

    // The untouched section: the 100-row window over 120 members.
    expect(tableRowCount()).toBe(100);
    expect(screen.getByRole("button", { name: "Show more (20 remaining)" })).not.toBeNull();

    // "Row 1" matches exactly Row 100..Row 119 — twenty rows that ALL live
    // past the first window. First-N-then-filtered would show none;
    // post-resolution/pre-windowing shows all twenty.
    fireEvent.change(within(section).getByLabelText("Filter by text"), {
      target: { value: "Row 1" },
    });
    expect(tableRowCount()).toBe(20);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();

    // The eager badge stays UNFILTERED.
    expect(screen.getByRole("button", { name: /classed nodes 120/i })).not.toBeNull();
    expect(within(section).getByText("20 of 120")).not.toBeNull();
  });

  it("an emptying filter reads 0 of N, keeps the count badge and the section, and clears back", async () => {
    const client = await seedClient();
    const classId = await seedBigClass(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(100);

    fireEvent.change(within(section).getByLabelText("Filter by text"), {
      target: { value: "zzz" },
    });

    // 0 of N — the count unfiltered; the section never vanishes.
    expect(within(section).getByText("0 of 120")).not.toBeNull();
    expect(screen.getByRole("button", { name: /classed nodes 120/i })).not.toBeNull();
    expect(within(section).getByText("No classed nodes.")).not.toBeNull();
    // The create affordance survives the emptied filter (the container owns
    // its empty state).
    expect(within(section).getAllByRole("button", { name: "Add member" }).length).toBeGreaterThan(0);

    fireEvent.click(within(section).getByRole("button", { name: "Clear filter" }));
    expect(tableRowCount()).toBe(100);
    expect(within(section).queryByText(/of 120/)).toBeNull();
  });

  it("the structured panel's class condition filters through the extends closure", async () => {
    const client = await seedClient();
    const projectId = await seedClass(client, "project");
    const clientId = await seedClass(client, "client");
    await client.setClassExtends(clientId, [projectId]);
    await client.createObject({ presentAsMain: true, name: "Alpha", classIds: [projectId] });
    await client.createObject({ presentAsMain: true, name: "Beta", classIds: [projectId] });
    await client.createObject({ presentAsMain: true, name: "Gamma", classIds: [clientId] });

    render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    // The hierarchy-aware read lists all three (client extends project).
    expect(tableRowCount()).toBe(3);

    fireEvent.click(within(section).getByRole("button", { name: "Structured filters" }));
    const panel = structuredPanel();
    // The builder's add menu (portaled to document.body) → a class condition row.
    fireEvent.click(within(panel).getByRole("button", { name: "Add condition" }));
    fireEvent.click(
      within(document.querySelector(".btn-panel") as HTMLElement).getByRole("button", { name: /^Class/ }),
    );
    fireEvent.change(within(panel).getByLabelText("Class"), { target: { value: clientId } });

    // Only the client-classed member survives; the bar names 1 of 3.
    expect(tableRowCount()).toBe(1);
    expect(within(section).getByText("1 of 3")).not.toBeNull();
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("Gamma")).not.toBeNull();
    expect(within(table).queryByText("Alpha")).toBeNull();
  });

  it("a property condition row narrows the table through the builder", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "task");
    const schemaId = await client.createPropertySchema({ name: "impact", type: "number" });
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const low = await client.createObject({ presentAsMain: true, name: "Low impact" });
    await client.assignClass(low, classId);
    await client.setProperty(low, schemaId, 1, 0);
    const high = await client.createObject({ presentAsMain: true, name: "High impact" });
    await client.assignClass(high, classId);
    await client.setProperty(high, schemaId, 9, 0);

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(2);

    fireEvent.click(within(section).getByRole("button", { name: "Structured filters" }));
    const panel = structuredPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "Add condition" }));
    fireEvent.click(
      within(document.querySelector(".btn-panel") as HTMLElement).getByRole("button", { name: /^Property/ }),
    );
    fireEvent.change(within(panel).getByLabelText("Property"), { target: { value: schemaId } });
    fireEvent.change(within(panel).getByLabelText("Operator"), { target: { value: "gte" } });
    fireEvent.change(within(panel).getByLabelText("Value"), { target: { value: "5" } });

    expect(tableRowCount()).toBe(1);
    expect(within(section).getByText("1 of 2")).not.toBeNull();
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("High impact")).not.toBeNull();
    expect(within(table).queryByText("Low impact")).toBeNull();

    // Removing the condition row restores the full set.
    fireEvent.click(within(panel).getByRole("button", { name: "Remove Property condition" }));
    expect(tableRowCount()).toBe(2);
  });
});

describe("the backlinks strip filter bars", () => {
  async function seedReferencedPage(
    client: WorkspaceClient,
  ): Promise<{ pageId: string; plainSourceId: string }> {
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const linkedSource = await client.createObject({ presentAsMain: true, name: "Linked Source" });
    await client.createObject({
      parentId: linkedSource,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    const plainSourceId = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plainSourceId,
      contentAst: [{ type: "text", text: "Zebra" }],
    });
    return { pageId, plainSourceId };
  }

  it("both reference tabs render a bar; a non-filterable section renders none", async () => {
    const client = await seedClient();
    const { pageId } = await seedReferencedPage(client);
    await client.createObject({ presentAsMain: true, name: "Kid", parentId: pageId });

    render(<PageView client={client} pageId={pageId} />);

    // The selected Backlinks panel carries its bar…
    expect(within(activePanel()).getByLabelText("Filter by text")).not.toBeNull();
    // …the Child pages section (not filterable) carries none.
    const childHeader = screen.getByRole("button", { name: /Child pages/ });
    const childSection = childHeader.closest("section")!;
    expect(within(childSection).queryByLabelText("Filter by text")).toBeNull();

    // The unlinked panel's bar too.
    fireEvent.click(screen.getByRole("tab", { name: /Unlinked mentions/ }));
    expect(within(activePanel()).getByLabelText("Filter by text")).not.toBeNull();
    expect(within(activePanel()).getAllByText("Plain Source")).not.toHaveLength(0);
  });

  it("the spec is one instance per tab: a filter on Backlinks never leaks into Unlinked mentions", async () => {
    const client = await seedClient();
    const { pageId } = await seedReferencedPage(client);

    render(<PageView client={client} pageId={pageId} />);
    const backlinksPanel = activePanel();

    // Empty the Backlinks tab through its own bar.
    fireEvent.change(within(backlinksPanel).getByLabelText("Filter by text"), {
      target: { value: "zzz" },
    });
    expect(within(backlinksPanel).getByText("0 of 1")).not.toBeNull();
    expect(within(backlinksPanel).getByText("No backlinks.")).not.toBeNull();
    // The eager tab label stays unfiltered.
    expect(screen.getByRole("tab", { name: "Backlinks 1" })).not.toBeNull();

    // The Unlinked tab owns a DIFFERENT instance: untouched bar, live rows.
    fireEvent.click(screen.getByRole("tab", { name: /Unlinked mentions/ }));
    const unlinkedPanel = activePanel();
    expect((within(unlinkedPanel).getByLabelText("Filter by text") as HTMLInputElement).value).toBe("");
    expect(within(unlinkedPanel).queryByText(/of 1/)).toBeNull();
    expect(within(unlinkedPanel).getAllByText("Plain Source")).not.toHaveLength(0);

    // …and switching back finds the Backlinks filter exactly as left.
    fireEvent.click(screen.getByRole("tab", { name: /Backlinks/ }));
    const backAgain = activePanel();
    expect((within(backAgain).getByLabelText("Filter by text") as HTMLInputElement).value).toBe("zzz");
    expect(within(backAgain).getByText("0 of 1")).not.toBeNull();
  });

  it("the filter applies to fresh resolutions too: a notification re-runs the tab's query, the spec still narrows it", async () => {
    const client = await seedClient();
    const { pageId, plainSourceId } = await seedReferencedPage(client);

    render(<PageView client={client} pageId={pageId} />);
    const unlinkedSpy = vi.spyOn(client, "getUnlinkedReferences");

    fireEvent.click(screen.getByRole("tab", { name: /Unlinked mentions/ }));
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);
    const unlinkedPanel = activePanel();
    fireEvent.change(within(unlinkedPanel).getByLabelText("Filter by text"), {
      target: { value: "zzz" },
    });
    expect(within(unlinkedPanel).getByText("0 of 1")).not.toBeNull();
    // The spec change re-ran NOTHING — the resolution cache is untouched.
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);

    // A live notification re-derives the loaded tab's rows (the keepFresh
    // contract)…
    await act(async () => {
      await client.createObject({
        parentId: plainSourceId,
        contentAst: [{ type: "text", text: "unrelated" }],
      });
    });
    expect(unlinkedSpy.mock.calls.length).toBeGreaterThan(1);
    // …and the spec still narrows the FRESH rows.
    expect(within(activePanel()).getByText("0 of 1")).not.toBeNull();
  });
});
