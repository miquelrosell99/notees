/**
 * Query node tests: the `query` content token as a nodecollection surface
 * (QueryNodeSection) over PageView (jsdom) — the
 * token renders nothing inside the content row; below the row the block
 * carries the NodeCollectionTabs + NodeCollectionToolbar chrome (the toggleable
 * full-grammar builder with the per-tab "Apply to <tab>" commit) and the
 * shared QueryResults body: result rendering from the @notees/query bridge,
 * the notify-driven live re-run, the active-tab count badge, the aggregate
 * grid for aggregated ASTs, the transient (never persisted) list/table
 * switch, export-on-query (markdown construction + the anchor download),
 * the invalid-AST placeholder, scope limits, the result cap, render-cascade
 * navigation, and the worker passthrough (WorkerCore.invoke).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";
import type { Aggregation, Child, QueryAst, Scope } from "@notees/query";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { InvalidQueryAstError, WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { QUERY_RESULT_CAP } from "../src/ui/queryResults.js";
import {
  buildQueryExportMarkdown,
  queryExportFileName,
} from "../src/ui/queryExport.js";
import { WorkerCore } from "../src/worker/worker-core.js";
import type { OpfsStore } from "../src/worker/opfs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const QUERY_CLASS_ID = SYSTEM_CLASS_UUIDS.query;
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

function text(value: string): ContentAst {
  return [{ type: "text", text: value }];
}

function queryToken(queryAst: unknown): ContentAst {
  return [{ type: "query", queryAst }] as unknown as ContentAst;
}

function makeAst(scope: Scope, children: Child[] = []): QueryAst {
  return { version: 1, scope, root: { type: "group", logic: "and", children } };
}

/** The query node's section below the content row. */
function querySection(container: HTMLElement): HTMLElement {
  const section = container.querySelector(".nt-query-node");
  if (section === null) throw new Error("no query node section rendered");
  return section as HTMLElement;
}

/** The active tab's total-count badge. */
function activeTabBadge(container: HTMLElement): string {
  return (
    querySection(container).querySelector(".nt-node-collection-tabs__tab-count")?.textContent ??
    ""
  );
}

/** Open the bar's structured builder panel inside the section. */
function openBuilder(container: HTMLElement): HTMLElement {
  const section = querySection(container);
  fireEvent.click(within(section).getByRole("button", { name: "Structured filters" }));
  const panel = document.querySelector(".nt-node-collection-toolbar__panel");
  if (panel === null) throw new Error("no structured builder panel open");
  return panel as HTMLElement;
}

/** The panel's add menu → pick one entry by label (the menu portals to body). */
function addCondition(scope: HTMLElement, label: RegExp): void {
  fireEvent.click(within(scope).getByRole("button", { name: "Add condition" }));
  const menu = document.querySelector(".btn-panel") as HTMLElement;
  fireEvent.click(within(menu).getByRole("menuitem", { name: label }));
}

const WORKSPACE = (): Scope => ({ type: "entire_workspace" });

const countByRenderState: Aggregation = {
  dimensions: [{ kind: "isClass" }],
  measures: [{ function: "count" }],
};

/** France-shaped fixture: a class, two member pages, a body block. */
async function seedWorld(client: WorkspaceClient) {
  const city = await client.createClass("City");
  const paris = await client.createObject({ isEmbedded: false, name: "Paris", classIds: [city] });
  const london = await client.createObject({ isEmbedded: false, name: "London", classIds: [city] });
  await client.createObject({
    parentId: paris,
    contentAst: text("The capital city"),
  });
  return { city, paris, london };
}

/** Drive a kit Dropdown (the pivot's dimension/measure pickers): open the
 * trigger by aria-label, pick the menu item by name (the menu portals to
 * document.body). */
function pickOption(label: string, option: string): void {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(
    within(document.querySelector(".dropdown-menu--portal") as HTMLElement).getByRole("option", { name: option }),
  );
}

/** Drive the registry-backed view switcher: primary modes are strip radios,
 * secondary modes (pivot) ride the "…" overflow dropdown. */
function pickViewMode(label: string): void {
  const radio = screen.queryByRole("radio", { name: label });
  if (radio !== null) {
    fireEvent.click(radio);
    return;
  }
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

describe("query node (nodecollection surface below the content row)", () => {
  it("renders the results below the row; the token renders nothing inside the content row", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);

    // The section chrome exists below the row: the Default tab + the results.
    const section = querySection(container);
    expect(within(section).getByRole("tab", { name: "Default" })).not.toBeNull();
    expect(await within(section).findByText("Paris")).not.toBeNull();
    expect(within(section).getByText("London")).not.toBeNull();
    // Two member pages → the active tab's badge names 2.
    expect(activeTabBadge(container)).toBe("2");
    const items = section.querySelectorAll(".outline-flat > li");
    expect(items.length).toBe(2);
    const labels = [...items].map((el) => el.querySelector(".nt-block-content")?.textContent).sort();
    expect(labels).toEqual(["London", "Paris"]);
  });

  it("re-renders live: a matching node appears after a client-side create (notify)", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    render(<PageView client={client} pageId={host} />);
    const section = querySection(document.body as unknown as HTMLElement);
    expect(await within(section).findByText("Paris")).not.toBeNull();
    expect(screen.queryByText("Lyon")).toBeNull();

    await act(async () => {
      await client.createObject({ isEmbedded: false, name: "Lyon", classIds: [city] });
    });

    expect(await screen.findByText("Lyon")).not.toBeNull();
    // A non-matching page does not appear.
    await act(async () => {
      await client.createObject({ isEmbedded: false, name: "Notes" });
    });
    expect(screen.queryByText("Notes")).toBeNull();
    expect(screen.getByText("Paris")).not.toBeNull();
  });

  it("count badge reflects the result count and updates on change", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    expect(activeTabBadge(container)).toBe("2");

    const lyon = await act(async () =>
      client.createObject({ isEmbedded: false, name: "Lyon", classIds: [city] }),
    );
    await waitFor(() => expect(activeTabBadge(container)).toBe("3"));

    await act(async () => {
      await client.deleteObject(lyon as unknown as string);
    });
    await waitFor(() => expect(activeTabBadge(container)).toBe("2"));
  });

  it("scope = this page limits the results to the page subtree", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const body = await client.createObject({
      parentId: host,
      contentAst: text("host body"),
    });
    await client.createObject({
      parentId: body,
      contentAst: text("nested body"),
    });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst({ type: "subtree", pageId: host })),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    // Scoped to the body tree: the context column's TOC lists the one-line
    // block, and the subtree query result below echoes it in a row.
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    await within(tree).findByText("host body");

    // Subtree: the host page + its two body blocks + the query block itself —
    // nothing from other pages. (The row read retries: the query re-runs
    // async after mount, so the result list can land a tick after the page
    // body that findByText above matched.) The list view renders full rows:
    // the host row nests its own children, so top-level <li> rows are
    // counted, not every nested block.
    await waitFor(() => {
      const items = Array.from(
        querySection(container).querySelectorAll(".outline-flat > li"),
      ).map((el) => el.textContent ?? "");
      expect(items.length).toBe(4);
      expect(items.some((t) => t.includes("host body"))).toBe(true);
      expect(items.some((t) => t.includes("nested body"))).toBe(true);
      expect(items.some((t) => t.includes("Paris"))).toBe(false);
    });
  });

  it("content-contains and isEmbedded conditions filter the results", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const queryBlock = await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(
        makeAst(WORKSPACE(), [{ type: "content", op: "contains", value: "capital" }]),
      ),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("The capital city");
    // Only the block matches; the list view renders it as a full block row.
    let items = querySection(container).querySelectorAll(".outline-flat > li");
    expect(items.length).toBe(1);
    expect(items[0]?.textContent).toContain("The capital city");

    // Add a isEmbedded condition via the content update path: the block
    // drops out and the list goes empty.
    await act(async () => {
      await client.updateObject(queryBlock, {
        contentAst: queryToken(
          makeAst(WORKSPACE(), [
            { type: "content", op: "contains", value: "capital" },
            { type: "isEmbedded", isEmbedded: false },
          ]),
        ),
      });
    });
    expect(await screen.findByText("No results.")).not.toBeNull();
    items = querySection(container).querySelectorAll(".outline-flat > li");
    expect(items.length).toBe(0);
  });

  it("the builder's Apply-to-Default rewrites the token's AST through the content update path", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const block = await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");

    // Open the toggleable builder, drop a content-contains condition in,
    // commit to the DEFAULT tab (the per-tab apply).
    const panel = openBuilder(container);
    addCondition(panel, /^Content/);
    fireEvent.change(within(panel).getByLabelText("Content"), {
      target: { value: "capital" },
    });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Apply to Default" }));
    });

    // The token's AST in the store carries the new composition.
    const token = client.getNode(block)!.contentAst[0] as unknown as {
      type: string;
      queryAst: QueryAst;
    };
    expect(token.type).toBe("query");
    expect(token.queryAst).toEqual(
      makeAst(WORKSPACE(), [{ type: "content", op: "contains", value: "capital" }]),
    );
    // Re-render reflects the new filter: only the body block matches now.
    // (Paris drops out as a ROW — its name legitimately survives in the
    // row's containing-page breadcrumb trail.)
    await screen.findByText("The capital city");
    const rows = querySection(container).querySelectorAll(".outline-flat > li");
    expect(rows.length).toBe(1);
    const ownContent = rows[0]!.querySelector(".nt-block-content")?.textContent ?? "";
    expect(ownContent).toContain("The capital city");
    expect(ownContent).not.toContain("Paris");
  });

  it("aggregated AST renders the aggregate grid (count by isClass matches the seeded data)", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken({ ...makeAst(WORKSPACE()), aggregation: countByRenderState }),
    });

    const { container } = render(<PageView client={client} pageId={host} />);

    // Grid headers: the dimension label + the measure label.
    expect(await screen.findByText("Class")).not.toBeNull();
    expect(screen.getByText("Count")).not.toBeNull();
    // Non-class workspace contents: 5 nodes (host page, Paris, London, the
    // body block + the query block itself — the isClass bit is 0). The
    // class-side count is NOT pinned: merely rendering the page runs the
    // alias self-heal, which authors the alias property schema on first
    // view — the workspace-wide aggregate legitimately sees the write. The
    // seeded City is one of them; the group count stays 2 (the two bit
    // values).
    const cells = Array.from(querySection(container).querySelectorAll(".nt-query-table td")).map(
      (td) => td.textContent,
    );
    expect(cells.slice(0, 2)).toEqual(["0", "5"]);
    expect(cells[2]).toBe("1");
    expect(Number(cells[3])).toBeGreaterThanOrEqual(1);
    expect(activeTabBadge(container)).toBe("2");
    expect(querySection(container).querySelector(".outline-flat")).toBeNull();
  });

  it("table mode renders a Name/Type/Created table; the switch is transient (never persisted)", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const block = await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    const section = () => querySection(container);
    expect(container.querySelector(".nt-table")).toBeNull();
    expect(within(section()).getByRole("radio", { name: "Outline" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(section()).getByRole("radio", { name: "Table" }));

    const headers = await screen.findAllByRole("columnheader");
    // Leading selection checkbox column, then Name / Class / Main / Created.
    expect(headers.map((th) => th.textContent)).toEqual(["", "Name", "Class", "Embedded", "Created"]);
    const rows = container.querySelectorAll(".nt-table tbody tr");
    expect(rows.length).toBe(2);
    const names = Array.from(rows).map((row) => row.querySelector("td.nt-table-name .nt-title-content")?.textContent);
    expect(names.sort()).toEqual(["London", "Paris"]);
    const created = rows[0]!.querySelector(".nt-table-created")?.textContent ?? "";
    expect(created).toMatch(/\d{4}/);
    expect(within(section()).getByRole("radio", { name: "Table" }).getAttribute("aria-checked")).toBe("true");

    // The mode is TRANSIENT surface state: the
    // token carries no view record.
    const token = client.getNode(block)!.contentAst[0] as unknown as {
      type: string;
      view?: unknown;
    };
    expect(token.type).toBe("query");
    expect(token.view).toBeUndefined();

    // Toggling back restores the list — still nothing persisted.
    fireEvent.click(within(section()).getByRole("radio", { name: "Outline" }));
    expect(await screen.findByText("London")).not.toBeNull();
    expect(container.querySelector(".nt-table")).toBeNull();
  });

  it("an unspecified (empty match-all) query renders no results — not the whole graph", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      // The /query starter AST: workspace scope, bare AND group, no
      // conditions — the user has not said what they are looking for.
      contentAst: queryToken(makeAst(WORKSPACE())),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    const section = querySection(container);
    // The honest empty state — not the workspace's every node.
    expect(await within(section).findByText("Set a query to see results.")).not.toBeNull();
    expect(section.querySelectorAll(".outline-flat > li").length).toBe(0);
    expect(activeTabBadge(container)).toBe("");
    // Export has nothing to ride.
    expect(within(section).getByRole("button", { name: "Export results" })).toHaveProperty("disabled", true);
  });


  it("pivot mode groups the full result set by two transient dimensions (count cells)", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    pickViewMode("Pivot");

    // Class bit × structural role: the two member pages are non-class pages.
    pickOption("Rows", "Class bit");
    pickOption("Columns", "Structural role");
    const pivot = () => container.querySelector(".nt-query-pivot") as HTMLElement;
    expect(pivot()).not.toBeNull();
    expect(await within(pivot()).findByText("Not a class")).not.toBeNull();
    expect(within(pivot()).getByText("Page")).not.toBeNull();
    const cells = Array.from(pivot().querySelectorAll("td")).map((td) => td.textContent);
    expect(cells).toEqual(["2"]);
  });

  it("pivot measures: sum over a number property groups by property value", async () => {
    const client = await seedClient();
    const { city, london } = await seedWorld(client);
    const rating = await client.createPropertySchema({ name: "rating", type: "number" });
    await client.setClassProperty(city, rating, {});
    await client.updatePropertySchema(rating, { defaultValue: 1 });
    await client.setProperty(london, rating, 5);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const block = await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    pickViewMode("Pivot");
    pickOption("Rows", "Property: rating");
    pickOption("Measure", "Sum of rating");

    const pivot = () => container.querySelector(".nt-query-pivot") as HTMLElement;
    // Paris rides the binding default (1); London carries the authored 5.
    // (The "5" reads twice — the rating row header and the sum cell.)
    await waitFor(() => {
      const cells = Array.from(pivot().querySelectorAll("td")).map((td) => td.textContent);
      expect(cells.sort()).toEqual(["1", "5"]);
    });

    // EVERYTHING is transient: no view record, the
    // token's AST is untouched.
    const token = client.getNode(block)!.contentAst[0] as unknown as { type: string; view?: unknown; queryAst: unknown };
    expect(token.type).toBe("query");
    expect(token.view).toBeUndefined();
    expect(token.queryAst).toEqual(makeAst(WORKSPACE(), [{ type: "class", classId: city }]));

    // Switching back to the list restores the rows.
    fireEvent.click(screen.getByRole("radio", { name: "Outline" }));
    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(container.querySelector(".nt-query-pivot")).toBeNull();
  });

  it("gantt mode: offered only when the results carry a valued date property; bars render on the axis", async () => {
    const client = await seedClient();
    const { city, paris } = await seedWorld(client);
    // A bound datetime property valued on ONE member: the gate arms.
    const due = await client.createPropertySchema({ name: "due", type: "datetime" });
    await client.setClassProperty(city, due, {});
    const { day } = await client.ensureDateChain("2026-03-10");
    await client.setProperty(paris, due, { nodeId: day }, 0);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    // The date gate passes (one valued member) → Gantt rides the overflow…
    pickViewMode("Gantt");
    const gantt = () => container.querySelector(".gantt") as HTMLElement;
    expect(gantt()).not.toBeNull();
    // …the start picker defaults to the bound date property, the scheduled
    // member draws one bar, the unscheduled member rides the lane.
    expect(within(gantt()).getByLabelText("Start")).not.toBeNull();
    expect(gantt()!.querySelectorAll(".gantt__bar")).toHaveLength(1);
    expect(within(gantt()).getByText("London")).not.toBeNull();

    // Back to the list: the gantt unmounts.
    fireEvent.click(screen.getByRole("radio", { name: "Outline" }));
    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(container.querySelector(".gantt")).toBeNull();
  });

  it("gantt mode: a date-less result set offers no Gantt (the availability gate)", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    // outline + table on the strip; the overflow carries pivot but NOT Gantt.
    expect(screen.queryByRole("radio", { name: "Gantt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const overflow = document.querySelector(".selection-button__overflow-dropdown") as HTMLElement;
    expect(within(overflow).queryByRole("menuitem", { name: "Gantt" })).toBeNull();
    expect(within(overflow).getByRole("menuitem", { name: "Pivot" })).not.toBeNull();
  });

  it("calendar mode: offered when the results carry a valued date property; the grid renders", async () => {
    const client = await seedClient();
    const { city, paris } = await seedWorld(client);
    const when = await client.createPropertySchema({ name: "when", type: "datetime" });
    await client.setClassProperty(city, when, {});
    const { day } = await client.ensureDateChain("2026-03-10");
    await client.setProperty(paris, when, { nodeId: day }, 0);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    pickViewMode("Calendar");
    const grid = () => container.querySelector(".collection-calendar") as HTMLElement;
    expect(grid()).not.toBeNull();
    expect(within(grid()).getByLabelText("Date property")).not.toBeNull();
    expect(grid()!.textContent).toContain("March 2026");
    const cell = grid()!.querySelector('.collection-calendar__cell[data-iso="2026-03-10"]') as HTMLElement;
    expect(within(cell).getByText("Paris")).not.toBeNull();

    // Back to the list: the grid unmounts.
    fireEvent.click(screen.getByRole("radio", { name: "Outline" }));
    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(container.querySelector(".collection-calendar")).toBeNull();
  });

  it("invalid AST renders the placeholder without crashing", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken({
        version: 2,
        scope: { type: "entire_workspace" },
        root: { type: "group", logic: "and", children: [] },
      }),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    expect(await screen.findByText("invalid query")).not.toBeNull();
    // No result list rendered for the invalid token.
    expect(querySection(container).querySelector(".outline-flat")).toBeNull();

    // The bridge fails loud with the typed error (unit-level contract).
    expect(() => client.runQueryAst({ nope: true })).toThrow(InvalidQueryAstError);
  });

  it("result list windows at 200 rows; load-more widens past the cap", async () => {
    const client = await seedClient();
    const city = await client.createClass("City");
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });
    const total = QUERY_RESULT_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      await client.createObject({ isEmbedded: false, name: `City ${i}`, classIds: [city] });
    }

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("City 0");
    expect(querySection(container).querySelectorAll(".outline-flat > li").length).toBe(QUERY_RESULT_CAP);
    expect(activeTabBadge(container)).toBe(String(total));

    // The cap is a render window, not a result ceiling: load-more widens it.
    fireEvent.click(screen.getByRole("button", { name: /5 more/ }));
    expect(querySection(container).querySelectorAll(".outline-flat > li").length).toBe(total);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("result clicks navigate per the render cascade (inline block → containing main node)", async () => {
    const client = await seedClient();
    const { city, paris } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const queryBlock = await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(
        makeAst(WORKSPACE(), [{ type: "content", op: "contains", value: "capital" }]),
      ),
    });

    const opened: string[] = [];
    render(<PageView client={client} pageId={host} onOpenPage={(id) => opened.push(id)} />);
    await screen.findByText("The capital city");

    // The list view's read-only rows are INERT: clicking the content does
    // nothing; opening rides the bullet element.
    fireEvent.click(screen.getByText("The capital city"));
    expect(opened).toEqual([]);
    const row = document.querySelector(".outline-flat > li .nt-block") as HTMLElement;
    fireEvent.click(row.querySelector(".nt-bullet") as HTMLElement);
    expect(opened).toEqual([paris]);

    // Rewrite the token to a page-level query: a page result opens directly.
    await act(async () => {
      await client.updateObject(queryBlock, {
        contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
      });
    });
    const parisRow = await screen.findByText("Paris");
    fireEvent.click(parisRow);
    expect(opened).toEqual([paris]);
    const pageRow = document.querySelector(".outline-flat > li .nt-block") as HTMLElement;
    fireEvent.click(pageRow.querySelector(".nt-bullet") as HTMLElement);
    expect(opened).toEqual([paris, paris]);
  });

  it("export markdown contains the matched page's markdown (direct construction)", async () => {
    const client = await seedClient();
    const { paris, london } = await seedWorld(client);

    const markdown = buildQueryExportMarkdown(client, [paris]);

    // nodeToMarkdown shape: YAML frontmatter + the page heading + the body
    // block as a nested bullet.
    expect(markdown).toContain("name: Paris");
    expect(markdown).toContain("# Paris");
    expect(markdown).toContain("- The capital city");
    // Single node → no bundle separator (the frontmatter's own --- lines
    // aside, concatBundleMarkdown joins files with "\n\n---\n\n").
    expect(markdown).not.toContain("\n\n---\n\n");

    // Two nodes → concatenated with the --- separator.
    const both = buildQueryExportMarkdown(client, [paris, london]);
    expect(both).toContain("\n\n---\n\n");
    expect(both).toContain("# Paris");
    expect(both).toContain("# London");

    // Filename: first result id's short prefix.
    expect(queryExportFileName([paris])).toBe(`notees-export-${paris.slice(0, 8)}.md`);
  });

  it("export button downloads the concatenated markdown via an anchor", async () => {
    const client = await seedClient();
    const { city, paris } = await seedWorld(client);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    await client.createObject({
      parentId: host,
      classIds: [QUERY_CLASS_ID],
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    let blob: Blob | null = null;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (b: Blob) => {
        blob = b;
        return "blob:notees-test";
      },
      revokeObjectURL: () => {},
    });
    const downloads: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      downloads.push(this.download);
    };

    try {
      render(<PageView client={client} pageId={host} />);
      await screen.findByText("Paris");
      fireEvent.click(screen.getByRole("button", { name: "Export results" }));

      expect(downloads).toEqual([`notees-export-${paris.slice(0, 8)}.md`]);
      expect(blob).not.toBeNull();
      // jsdom's Blob has no .text() — read the captured blob via FileReader.
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob as unknown as Blob);
      });
      // Both matched pages render, concatenated with a --- separator.
      expect(content).toContain("# Paris");
      expect(content).toContain("# London");
      expect(content).toContain("\n\n---\n\n");
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
      vi.unstubAllGlobals();
    }
  });

  it("runAggregateAst bridge: grouped grid; runQueryAst rejects aggregation ASTs", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);

    const result = client.runAggregateAst({
      ...makeAst(WORKSPACE(), [{ type: "class", classId: city }]),
      aggregation: countByRenderState,
    });
    expect(result.columns).toEqual(["isClass", "count"]);
    expect(result.rows).toEqual([[0, 2]]);

    // The two bridges are strict about their shapes: runQueryAst refuses
    // aggregation ASTs, runAggregateAst refuses plain/invalid ones.
    const aggregated = { ...makeAst(WORKSPACE()), aggregation: countByRenderState };
    expect(() => client.runQueryAst(aggregated)).toThrow(InvalidQueryAstError);
    expect(() => client.runAggregateAst(makeAst(WORKSPACE()))).toThrow(InvalidQueryAstError);
    expect(() => client.runAggregateAst({ bogus: true })).toThrow(InvalidQueryAstError);
  });

  it("worker passthrough: runQueryAst + getChildren over invoke()", async () => {
    const files = new Map<string, Uint8Array>();
    const opfs: OpfsStore = {
      loadFile: async (name) => files.get(name) ?? null,
      saveFile: async (name, bytes) => {
        files.set(name, new Uint8Array(bytes));
      },
    };
    const core = await WorkerCore.create({
      SQL: sqlModule,
      opfs,
      fileName: `${WS}.db`,
      workspaceId: WS,
      transport: new MemoryTransport(new MemoryRelay()),
    });
    try {
      const city = (await core.invoke("createClass", ["City"])) as string;
      const paris = (await core.invoke("createObject", [
        { isEmbedded: false, name: "Paris", classIds: [city] },
      ])) as string;
      await core.invoke("createObject", [
        { parentId: paris, contentAst: text("block one") },
      ]);
      await core.invoke("createObject", [
        { parentId: paris, contentAst: text("block two") },
      ]);

      const result = (await core.invoke("runQueryAst", [
        makeAst(WORKSPACE(), [{ type: "class", classId: city }]),
      ])) as {
        ids: string[];
        rows: Array<{
          id: string;
          name: string | null;
          isClass: boolean;
          isEmbedded: boolean;
          parentId: string | null;
        }>;
      };
      expect(result.ids).toEqual([paris]);
      // Title-is-content: the query summary's `name` column is retired (always
      // null); the title lives in the node's own content.
      expect(result.rows[0]).toMatchObject({ id: paris, isEmbedded: false, parentId: null });
      expect(result.rows[0]!.name).toBe("Paris");
      const parisNode = (await core.invoke("getPage", [paris])) as { contentAst: unknown };
      expect(parisNode.contentAst).toEqual(text("Paris"));

      const children = (await core.invoke("getChildren", [paris])) as Array<{ id: string }>;
      expect(children.length).toBe(2);

      // The aggregation bridge crosses the wire too (grouped grid).
      const aggregate = (await core.invoke("runAggregateAst", [
        {
          ...makeAst(WORKSPACE(), [{ type: "class", classId: city }]),
          aggregation: countByRenderState,
        },
      ])) as { columns: string[]; rows: unknown[][] };
      expect(aggregate.columns).toEqual(["isClass", "count"]);
      expect(aggregate.rows).toEqual([[0, 1]]);

      // Invalid ASTs reject with the typed error's message across the wire.
      await expect(core.invoke("runQueryAst", [{ bogus: true }])).rejects.toThrow(
        /invalid query AST/,
      );
      await expect(core.invoke("runAggregateAst", [{ bogus: true }])).rejects.toThrow(
        /invalid query AST/,
      );
    } finally {
      await core.close();
    }
  });
});
