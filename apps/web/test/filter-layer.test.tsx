/**
 * The transient filter layer, end to end (jsdom over the in-process
 * WorkspaceClient + MemoryRelay): the FilterQuery applies
 * POST-RESOLUTION/PRE-WINDOWING (a windowed section renders the filtered
 * window, never the first-N-then-filtered), the eager count stays
 * UNFILTERED (an active filter reads "0 of N" and never hides the
 * section), the query is one instance per section view (the two reference
 * sections never share), and the three filterable sections — Backlinks,
 * Unlinked mentions, classed nodes — render the shared FilterBar's chrome
 * while a non-filterable section (Child pages) renders none. Since the bar rides the hosted top bar's FAR RIGHT (the
 * NodeCollection's `toolbarContent`, composed by NodeCollectionTopBar — one
 * row with the tabs, every button
 * right): the quick search COLLAPSES by default (the kit CollapsibleSearchField
 * — a ghost magnifier button expands the field in flow, the pill's × folds it
 * back), the
 * structured builder opens in a wrapped full-width panel beneath the row
 * (the toolbar renders last in the cluster, so the wrap never moves the
 * other controls), and each section owns its query instance — a filter on
 * Backlinks never leaks into Unlinked mentions. The quick search itself is
 * the RANKED search since the global search's priority
 * ordering (exact title > ordered terms > partials > fuzzy) replaces the
 * old title substring, for membership AND order (the GMI Ecuador / GMI
 * Dental Implantology regression shape is pinned below). The structured
 * panel is the
 * block query builder — these tests drive its add menu, rows and wire
 * controls end to end (the pure builder interactions live in
 * filter-builder.test.tsx).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
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
  vi.unstubAllGlobals();
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
  return screen.getAllByRole("table")[0]!.querySelectorAll("td.nt-table-name").length;
}

/** The classed-nodes section wrapper (a class page renders the backlinks
 * strip's bar too — every bar query scopes to its own section). */
function classedNodesSection(): HTMLElement {
  const header = screen.getByRole("button", { name: /classed nodes/i });
  const section = header.closest("section");
  if (section === null) throw new Error("no classed-nodes section");
  return section as HTMLElement;
}

/** Section header button + its containing <section> for within() scoping. */
function section(headerName: RegExp): HTMLElement {
  const header = screen.getByRole("button", { name: headerName });
  const el = header.closest("section");
  if (el === null) throw new Error(`no section for ${headerName}`);
  return el as HTMLElement;
}

/** The open structured-facet panel of a visible FilterBar. */
function structuredPanel(): HTMLElement {
  const panel = document.querySelector(".nt-node-collection-toolbar__panel");
  if (panel === null) throw new Error("no structured filter panel open");
  return panel as HTMLElement;
}

/** The quick search COLLAPSES by default (the magnifier toggle) — expand it
 * before typing into it, and hand back the field. */
function openQuickSearch(scope: HTMLElement): HTMLElement {
  if (within(scope).queryByLabelText("Filter by text") === null) {
    fireEvent.click(within(scope).getByRole("button", { name: "Search rows" }));
  }
  return within(scope).getByLabelText("Filter by text") as HTMLElement;
}

describe("the classed-nodes filter bar", () => {
  async function seedBigClass(client: WorkspaceClient): Promise<string> {
    const classId = await seedClass(client, "project");
    for (let i = 0; i < BIG; i += 1) {
      const member = await client.createObject({
        isEmbedded: false,
        name: `Row ${String(i).padStart(3, "0")}`,
      });
      await client.assignClass(member, classId);
    }
    return classId;
  }

  it("filtering applies post-resolution/pre-windowing AND ranks the pool: the quick search is the ranked search, not a substring", async () => {
    const client = await seedClient();
    const classId = await seedBigClass(client);
    render(<NodeView client={client} onOpenNode={() => {}} nodeId={classId} />);
    const section = classedNodesSection();

    // The untouched section: the 100-row window over 120 members.
    expect(tableRowCount()).toBe(100);
    expect(screen.getByRole("button", { name: "Show more (20 remaining)" })).not.toBeNull();

    // "Row 1" ranks the WHOLE pool: the twenty literal title matches (Row
    // 100..Row 119 — all past the first window) lead by the search's exact-
    // title tier; the shared term "row" keeps every other row in the pool
    // via the partial tier, BELOW the literal matches. First-N-then-
    // filtered could never show Row 119; post-resolution/pre-windowing
    // ranking shows it, and a partial-tier row (Row 000) ranks out of the
    // first window entirely.
    fireEvent.change(openQuickSearch(section), {
      target: { value: "Row 1" },
    });
    expect(tableRowCount()).toBe(100);
    expect(screen.getByRole("button", { name: "Show more (20 remaining)" })).not.toBeNull();
    const table = screen.getAllByRole("table")[0]!;
    // The literal matches past the unfiltered window render…
    expect(within(table).getByText("Row 100")).not.toBeNull();
    expect(within(table).getByText("Row 119")).not.toBeNull();
    // …and the pool is ranked, not just narrowed: Row 000 (partial tier
    // only) falls behind every literal match — out of the first window.
    expect(within(table).queryByText("Row 000")).toBeNull();

    // The section never vanishes behind the emptied filter.
    expect(screen.getByRole("button", { name: /classed nodes/i })).not.toBeNull();
    expect(within(section).getByText("120 of 120")).not.toBeNull();
  });

  it("a multi-word quick search ranks the exact title first, ordered terms next, one-word partials last", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    await client.createObject({ isEmbedded: false, name: "Alpha Beta", classIds: [classId] });
    await client.createObject({ isEmbedded: false, name: "Alphabet soup beta edition", classIds: [classId] });
    await client.createObject({ isEmbedded: false, name: "Alpha", classIds: [classId] });
    await client.createObject({ isEmbedded: false, name: "Beta", classIds: [classId] });

    render(<NodeView client={client} onOpenNode={() => {}} nodeId={classId} />);
    const section = classedNodesSection();
    fireEvent.change(openQuickSearch(section), {
      target: { value: "alpha beta" },
    });

    expect(within(section).getByText("4 of 4")).not.toBeNull();
    const labels = Array.from(
      screen.getAllByRole("table")[0]!.querySelectorAll("td.nt-table-name .nt-title-content"),
      (el) => el.textContent,
    );
    // The search's tiers: the whole-query title match, then the ordered-
    // terms match, then the rows carrying only one query word (whose
    // relative order the search's recency/id tiebreak owns).
    expect(labels[0]).toBe("Alpha Beta");
    expect(labels[1]).toBe("Alphabet soup beta edition");
    expect(labels.slice(2)).toContain("Alpha");
    expect(labels.slice(2)).toContain("Beta");
  });

  it("the real-world regression shape: 'gmi dental' lists GMI Dental Implantology FIRST", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    await client.createObject({ isEmbedded: false, name: "GMI Ecuador", classIds: [classId] });
    await client.createObject({ isEmbedded: false, name: "GMI Dental Implantology", classIds: [classId] });

    render(<NodeView client={client} onOpenNode={() => {}} nodeId={classId} />);
    const section = classedNodesSection();
    fireEvent.change(openQuickSearch(section), {
      target: { value: "gmi dental" },
    });

    expect(within(section).getByText("2 of 2")).not.toBeNull();
    const labels = Array.from(
      screen.getAllByRole("table")[0]!.querySelectorAll("td.nt-table-name .nt-title-content"),
      (el) => el.textContent,
    );
    // The exact-title match leads; the single-term partial follows. Plain
    // substring matched NEITHER row ("gmi dental" is no row's substring), so
    // this also pins the ranked membership replacing the old predicate.
    expect(labels).toEqual(["GMI Dental Implantology", "GMI Ecuador"]);
  });

  it("an emptying filter reads 0 of N, keeps the section, and clears back", async () => {
    const client = await seedClient();
    const classId = await seedBigClass(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(100);

    fireEvent.change(openQuickSearch(section), {
      target: { value: "zzz" },
    });

    // 0 of N — the count unfiltered; the section never vanishes.
    expect(within(section).getByText("0 of 120")).not.toBeNull();
    expect(screen.getByRole("button", { name: /classed nodes/i })).not.toBeNull();
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
    await client.createObject({ isEmbedded: false, name: "Alpha", classIds: [projectId] });
    await client.createObject({ isEmbedded: false, name: "Beta", classIds: [projectId] });
    await client.createObject({ isEmbedded: false, name: "Gamma", classIds: [clientId] });

    render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    // The hierarchy-aware read lists all three (client extends project).
    expect(tableRowCount()).toBe(3);

    fireEvent.click(within(section).getByRole("button", { name: "Structured filters" }));
    const panel = structuredPanel();
    // The builder's add menu (portaled to document.body) → a class condition row.
    fireEvent.click(within(panel).getByRole("button", { name: "Add condition" }));
    fireEvent.click(
      within(document.querySelector(".btn-panel") as HTMLElement).getByRole("menuitem", { name: /^Class/ }),
    );
    // The default Class row binds the LIST — the picked class rides a pill
    // through the "+ Add class" picker.
    fireEvent.click(within(panel).getByRole("button", { name: "Add class" }));
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "project" } });
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );
    // "Contains" rides the extends closure (the row's default): Gamma is
    // classed client, client extends project — all three survive.
    expect(tableRowCount()).toBe(3);
    expect(within(section).getByText("3 of 3")).not.toBeNull();

    // "Is" is the SAME closure membership in the single-pill register
    //: the picked id carries across the morph, all three stay.
    fireEvent.click(within(panel).getByLabelText("Operator"));
    fireEvent.click(
      within(document.querySelector(".dropdown-menu--portal") as HTMLElement).getByRole("option", { name: "is" }),
    );
    expect(tableRowCount()).toBe(3);
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("Gamma")).not.toBeNull();

    // The negative register empties the section.
    fireEvent.click(within(panel).getByLabelText("Operator"));
    fireEvent.click(
      within(document.querySelector(".dropdown-menu--portal") as HTMLElement).getByRole("option", { name: "is not" }),
    );
    // The emptied table reads the empty state ("No classed nodes.").
    expect(within(section).getByText("No classed nodes.")).not.toBeNull();
    expect(within(section).getByText("0 of 3")).not.toBeNull();
  });

  it("a property condition row narrows the table through the builder", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "task");
    const schemaId = await client.createPropertySchema({ name: "impact", type: "number" });
    await client.setClassProperty(classId, schemaId, {});
    const low = await client.createObject({ isEmbedded: false, name: "Low impact" });
    await client.assignClass(low, classId);
    await client.setProperty(low, schemaId, 1, 0);
    const high = await client.createObject({ isEmbedded: false, name: "High impact" });
    await client.assignClass(high, classId);
    await client.setProperty(high, schemaId, 9, 0);

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(2);

    fireEvent.click(within(section).getByRole("button", { name: "Structured filters" }));
    const panel = structuredPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "Add condition" }));
    fireEvent.click(
      within(document.querySelector(".btn-panel") as HTMLElement).getByRole("menuitem", { name: /^Property/ }),
    );
    fireEvent.click(within(panel).getByLabelText("Property"));
    fireEvent.click(
      within(document.querySelector(".dropdown-menu--portal") as HTMLElement).getByRole("option", { name: "impact" }),
    );
    fireEvent.click(within(panel).getByLabelText("Operator"));
    fireEvent.click(
      within(document.querySelector(".dropdown-menu--portal") as HTMLElement).getByRole("option", { name: "≥" }),
    );
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

  it("the + rides the tablist's end and the view chrome stays put when the panel opens", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    await client.createObject({ isEmbedded: false, name: "Alpha", classIds: [classId] });

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    // The toolbar rides the top bar (NodeCollectionTopBar) — the wrapping
    // line that hosts both the tabs strip and the toolbar cluster.
    const bar = section.querySelector(".nt-node-collection-topbar") as HTMLElement;

    // "+" is the LAST item of the tablist.
    const add = within(bar).getByRole("button", { name: "Add custom view" });
    expect(add.closest('[role="tablist"]')).not.toBeNull();

    // Ordering contract (the owner's register, viewChrome.tsx): the quick
    // search is FIRST; the view chrome (the table's own toolbar, ported into
    // the ViewChromeSlot) and the view switcher ride AFTER it. (The
    // structured panel portals into the bar's full-width seat beneath the
    // row, so nothing on the row moves when it opens.)
    const search = openQuickSearch(bar);
    const follows = (el: Element | null): boolean =>
      el !== null && (search.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(bar.querySelector(".selection-button"))).toBe(true);
    expect(follows(bar.querySelector(".nt-table-toolbar"))).toBe(true);

    // Open the structured panel: everything stays inside the bar, on the
    // row above the panel — nothing moved.
    fireEvent.click(within(section).getByRole("button", { name: "Structured filters" }));
    const panel = structuredPanel();
    expect(bar.contains(panel)).toBe(true);
    expect(bar.contains(add)).toBe(true);
    expect(follows(bar.querySelector(".selection-button"))).toBe(true);
  });

  it("the structured panel rides a full-width topbar slot, not the capped cluster", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    await client.createObject({ isEmbedded: false, name: "Alpha", classIds: [classId] });

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    const bar = section.querySelector(".nt-node-collection-topbar") as HTMLElement;
    const cluster = bar.querySelector(".nt-node-collection-topbar__cluster") as HTMLElement;

    fireEvent.click(within(section).getByRole("button", { name: "Structured filters" }));
    const panel = structuredPanel();

    // The panel ports OUT of the width-capped toolbar cluster into a slot
    // the topbar owns — the wrapped line spans the bar side to side, below
    // the tabs+controls row (never squeezed into the cluster's right-hand
    // mini-column).
    expect(cluster.contains(panel)).toBe(false);
    const host = bar.querySelector(".nt-node-collection-topbar__panel-host");
    expect(host).not.toBeNull();
    expect(host!.contains(panel)).toBe(true);
    expect(
      cluster.compareDocumentPosition(host!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("the narrow-viewport search fold", () => {
  /** jsdom has no matchMedia: stub a narrow viewport (≤768px matches). */
  function stubNarrowViewport(): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("768"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  it("at ≤768px the quick search is a magnifier toggle whose popup carries the field; typing filters live", async () => {
    stubNarrowViewport();
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    await client.createObject({ isEmbedded: false, name: "Alpha", classIds: [classId] });
    await client.createObject({ isEmbedded: false, name: "Beta", classIds: [classId] });

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    // No inline field at narrow widths — the magnifier toggle renders instead.
    expect(within(section).queryByLabelText("Filter by text")).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Search rows" }));
    // The popup carries the field; typing filters the table live.
    fireEvent.change(screen.getByLabelText("Filter by text"), { target: { value: "Alpha" } });
    expect(tableRowCount()).toBe(1);
    // A re-click toggles the popup closed.
    fireEvent.click(within(section).getByRole("button", { name: "Search rows" }));
    expect(screen.queryByLabelText("Filter by text")).toBeNull();
  });
});

describe("the reference sections' filter bars", () => {
  /** Expand the collapsed Unlinked mentions section. */
  function expandUnlinkedMentions(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
    return section(/Unlinked mentions/);
  }

  async function seedReferencedPage(
    client: WorkspaceClient,
  ): Promise<{ pageId: string; plainSourceId: string }> {
    const pageId = await client.createObject({ isEmbedded: false, name: "Zebra" });
    const linkedSource = await client.createObject({ isEmbedded: false, name: "Linked Source" });
    await client.createObject({
      parentId: linkedSource,
      contentAst: [{ type: "mention", targetNodeId: pageId }],
    });
    const plainSourceId = await client.createObject({ isEmbedded: false, name: "Plain Source" });
    await client.createObject({
      parentId: plainSourceId,
      contentAst: [{ type: "text", text: "Zebra" }],
    });
    return { pageId, plainSourceId };
  }

  it("each reference section renders the shared filter chrome on the hosted tab bar; a non-filterable section renders none", async () => {
    const client = await seedClient();
    const { pageId } = await seedReferencedPage(client);
    await client.createObject({ isEmbedded: false, name: "Kid", parentId: pageId });

    render(<PageView client={client} pageId={pageId} />);
    // Backlinks is expanded by default: its chrome (the collapsible quick
    // search's magnifier toggle + the structured-filters toggle) rides the
    // hosted top bar's right. The section composes through the
    // CollectionSection skin.
    const backlinks = section(/Backlinks/);
    expect(backlinks.classList.contains("nt-collection-section")).toBe(true);
    expect(within(backlinks).queryByLabelText("Filter by text")).toBeNull();
    expect(within(backlinks).getByRole("button", { name: "Search rows" })).not.toBeNull();
    expect(within(backlinks).getByRole("button", { name: "Structured filters" })).not.toBeNull();
    // …the Child pages section (not filterable) carries none.
    const childSection = section(/Child pages/);
    expect(within(childSection).queryByLabelText("Filter by text")).toBeNull();
    expect(within(childSection).queryByRole("button", { name: "Search rows" })).toBeNull();

    // The Unlinked mentions section starts collapsed — no chrome until the
    // first expand (a collapsed section renders no body).
    const unlinked = expandUnlinkedMentions();
    expect(within(unlinked).queryByLabelText("Filter by text")).toBeNull();
    expect(within(unlinked).getByRole("button", { name: "Search rows" })).not.toBeNull();
    expect(within(unlinked).getByRole("button", { name: "Structured filters" })).not.toBeNull();
    expect(within(unlinked).getAllByText("Plain Source")).not.toHaveLength(0);
  });

  it("the spec is one instance per section: a filter on Backlinks never leaks into Unlinked mentions", async () => {
    const client = await seedClient();
    const { pageId } = await seedReferencedPage(client);

    render(<PageView client={client} pageId={pageId} />);
    const backlinks = section(/Backlinks/);

    // Empty the Backlinks section through its own chrome.
    fireEvent.change(openQuickSearch(backlinks), {
      target: { value: "zzz" },
    });
    expect(within(backlinks).getByText("0 of 1")).not.toBeNull();
    expect(within(backlinks).getByText("No backlinks.")).not.toBeNull();
    // The section stays (the gate reads the unfiltered count).
    expect(screen.getByRole("button", { name: "Backlinks" })).not.toBeNull();

    // The Unlinked section owns a DIFFERENT instance: its field reads the
    // untouched query — the rows are live.
    const unlinked = expandUnlinkedMentions();
    expect((openQuickSearch(unlinked) as HTMLInputElement).value).toBe("");
    expect(within(unlinked).queryByText(/of 1/)).toBeNull();
    expect(within(unlinked).getAllByText("Plain Source")).not.toHaveLength(0);
  });

  it("the filter applies to fresh resolutions too: a notification re-runs the section's query, the spec still narrows it", async () => {
    const client = await seedClient();
    const { pageId, plainSourceId } = await seedReferencedPage(client);

    render(<PageView client={client} pageId={pageId} />);
    const unlinkedSpy = vi.spyOn(client, "getUnlinkedReferences");
    const unlinked = expandUnlinkedMentions();
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(openQuickSearch(unlinked), {
      target: { value: "zzz" },
    });
    expect(within(unlinked).getByText("0 of 1")).not.toBeNull();
    // The spec change re-ran NOTHING — the resolution cache is untouched.
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);

    // A live notification re-derives the expanded section's rows…
    await act(async () => {
      await client.createObject({
        parentId: plainSourceId,
        contentAst: [{ type: "text", text: "unrelated" }],
      });
    });
    expect(unlinkedSpy.mock.calls.length).toBeGreaterThan(1);
    // …and the spec still narrows the FRESH rows.
    expect(within(unlinked).getByText("0 of 1")).not.toBeNull();
  });

  it("the structured builder opens below the bar and each section keeps its own draft", async () => {
    const client = await seedClient();
    const { pageId } = await seedReferencedPage(client);

    render(<PageView client={client} pageId={pageId} />);
    const backlinks = section(/Backlinks/);

    // Open the builder on Backlinks: the panel drops a wrapped full-width
    // line beneath the tab row.
    fireEvent.click(within(backlinks).getByRole("button", { name: "Structured filters" }));
    const panel = structuredPanel();
    expect(backlinks.contains(panel)).toBe(true);

    // Add a class condition on the Backlinks section's draft…
    fireEvent.click(within(panel).getByRole("button", { name: "Add condition" }));
    fireEvent.click(
      within(document.querySelector(".btn-panel") as HTMLElement).getByRole("menuitem", { name: /^Class/ }),
    );
    expect(panel.textContent).toContain("Class");

    // …expand the other section: its builder slot is a DIFFERENT instance —
    // the Backlinks draft survives on its own.
    const unlinked = expandUnlinkedMentions();
    expect(unlinked.querySelector(".nt-node-collection-toolbar__panel")).toBeNull();
    expect(structuredPanel().textContent).toContain("Class");
  });
});
