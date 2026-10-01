/**
 * Query block tests: the live `query` content token (QueryBlockView) over
 * PageView (jsdom) — result rendering from the @notees/query bridge, the
 * notify-driven live re-run, the count badge, the builder popover's AST
 * persistence, the list/table view toggle (persisted in the token's view
 * record), the aggregate grid for aggregated ASTs, the builder's minimal
 * aggregation section, export-on-query (markdown construction + the anchor
 * download), the invalid-AST placeholder, scope limits, the result cap,
 * node_type navigation, and the worker passthrough (WorkerCore.invoke).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";
import type { Aggregation, Child, QueryAst, Scope } from "@notees/query";

import { InvalidQueryAstError, WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import {
  QUERY_RESULT_CAP,
  buildQueryExportMarkdown,
  composeQueryAst,
  queryExportFileName,
} from "../src/ui/QueryBlockView.js";
import { WorkerCore } from "../src/worker/worker-core.js";
import type { OpfsStore } from "../src/worker/opfs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
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

const WORKSPACE = (): Scope => ({ type: "entire_workspace" });

const countByType: Aggregation = {
  dimensions: [{ kind: "nodeType" }],
  measures: [{ function: "count" }],
};

/** France-shaped fixture: a class, two member pages, a body block. */
async function seedWorld(client: WorkspaceClient) {
  const city = await client.createClass("City");
  const paris = await client.createObject({ nodeType: "page", name: "Paris", classIds: [city] });
  const london = await client.createObject({ nodeType: "page", name: "London", classIds: [city] });
  await client.createObject({
    nodeType: "block",
    parentId: paris,
    contentAst: text("The capital city"),
  });
  return { city, paris, london };
}

function badge(container: HTMLElement): string {
  return container.querySelector(".nt-query-badge")?.textContent ?? "";
}

describe("query block (live query token)", () => {
  it("renders the result rows with names and nodeType chips", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);

    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(screen.getByText("London")).not.toBeNull();
    // Two member pages → badge 2; each row carries its nodeType chip.
    expect(badge(container)).toBe("2");
    const items = container.querySelectorAll(".nt-query-item");
    expect(items.length).toBe(2);
    expect(items[0]?.querySelector(".nt-query-chip")?.textContent).toBe("page");
  });

  it("re-renders live: a matching node appears after a client-side create (notify)", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    render(<PageView client={client} pageId={host} />);
    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(screen.queryByText("Lyon")).toBeNull();

    await act(async () => {
      await client.createObject({ nodeType: "page", name: "Lyon", classIds: [city] });
    });

    expect(await screen.findByText("Lyon")).not.toBeNull();
    // A non-matching page does not appear.
    await act(async () => {
      await client.createObject({ nodeType: "page", name: "Notes" });
    });
    expect(screen.queryByText("Notes")).toBeNull();
    expect(screen.getByText("Paris")).not.toBeNull();
  });

  it("count badge reflects the result count and updates on change", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    expect(badge(container)).toBe("2");

    const lyon = await act(async () =>
      client.createObject({ nodeType: "page", name: "Lyon", classIds: [city] }),
    );
    expect(badge(container)).toBe("3");

    await act(async () => {
      await client.deleteObject(lyon as unknown as string);
    });
    expect(badge(container)).toBe("2");
  });

  it("scope = this page limits the results to the page subtree", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const body = await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: text("host body"),
    });
    await client.createObject({
      nodeType: "block",
      parentId: body,
      contentAst: text("nested body"),
    });
    await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst({ type: "subtree", pageId: host })),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("host body");

    // Subtree: the host page + its two body blocks + the query block itself —
    // nothing from other pages.
    const items = Array.from(container.querySelectorAll(".nt-query-item")).map(
      (el) => el.textContent ?? "",
    );
    expect(items.length).toBe(4);
    expect(items.some((t) => t.includes("host body"))).toBe(true);
    expect(items.some((t) => t.includes("nested body"))).toBe(true);
    expect(items.some((t) => t.includes("Paris"))).toBe(false);
  });

  it("content-contains and nodeType conditions filter the results", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const queryBlock = await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(
        makeAst(WORKSPACE(), [{ type: "content", op: "contains", value: "capital" }]),
      ),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("The capital city");
    // Only the block carries the text; the chip shows its nodeType.
    let items = container.querySelectorAll(".nt-query-item");
    expect(items.length).toBe(1);
    expect(items[0]?.querySelector(".nt-query-chip")?.textContent).toBe("block");

    // Add a nodeType=page condition via the content update path: the block
    // drops out and the list goes empty.
    await act(async () => {
      await client.updateObject(queryBlock, {
        contentAst: queryToken(
          makeAst(WORKSPACE(), [
            { type: "content", op: "contains", value: "capital" },
            { type: "nodeType", nodeType: "page" },
          ]),
        ),
      });
    });
    expect(await screen.findByText("No results.")).not.toBeNull();
    items = container.querySelectorAll(".nt-query-item");
    expect(items.length).toBe(0);
  });

  it("builder edits persist the AST through the content update path", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const block = await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");

    // Open the builder, switch the class filter off + text-contains on, apply.
    fireEvent.click(screen.getByLabelText("Query settings"));
    const dialog = screen.getByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("Text contains"), {
      target: { value: "capital" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });

    // The token's AST in the store carries the new flat-AND composition.
    const token = client.getNode(block)!.contentAst[0] as unknown as {
      type: string;
      queryAst: QueryAst;
    };
    expect(token.type).toBe("query");
    expect(token.queryAst).toEqual(
      makeAst(WORKSPACE(), [{ type: "content", op: "contains", value: "capital" }]),
    );
    // Re-render reflects the new filter: only the body block matches now.
    await screen.findByText("The capital city");
    expect(container.querySelectorAll(".nt-query-item").length).toBe(1);
    expect(screen.queryByText("Paris")).toBeNull();
  });

  it("builder scope select writes the this-page subtree scope", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const block = await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE())),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Query");

    fireEvent.click(screen.getByLabelText("Query settings"));
    const dialog = screen.getByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Scope"), { target: { value: "page" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });

    // The written AST is exactly what composeQueryAst produces for the state.
    const token = client.getNode(block)!.contentAst[0] as unknown as { queryAst: QueryAst };
    expect(token.queryAst).toEqual(
      composeQueryAst({ scope: "page", classId: null, nodeType: "", contains: "" }, host, true),
    );
    expect(token.queryAst.scope).toEqual({ type: "subtree", pageId: host });
    // Re-render: only the host subtree remains (host page + the query block).
    const items = Array.from(container.querySelectorAll(".nt-query-item"));
    expect(items.length).toBe(2);
    expect(items.some((el) => el.textContent?.includes("Paris"))).toBe(false);
  });

  it("aggregated AST renders the aggregate grid (count by nodeType matches the seeded data)", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken({ ...makeAst(WORKSPACE()), aggregation: countByType }),
    });

    const { container } = render(<PageView client={client} pageId={host} />);

    // Grid headers: the dimension label + the measure label.
    expect(await screen.findByText("Type")).not.toBeNull();
    expect(screen.getByText("Count")).not.toBeNull();
    // Workspace contents: 3 pages (host, Paris, London), 2 blocks (the body
    // block + the query block itself), 1 class node (City). An aggregation
    // renders the grid in any view mode (no list projection exists for
    // measures); the badge counts groups.
    const cells = Array.from(container.querySelectorAll(".nt-query-table td")).map(
      (td) => td.textContent,
    );
    expect(cells).toEqual(["block", "2", "class", "1", "page", "3"]);
    expect(badge(container)).toBe("3");
    expect(container.querySelector(".nt-query-list")).toBeNull();
  });

  it("table mode renders a Name/Type/Created table and the toggle persists in the token view", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const block = await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    expect(container.querySelector(".nt-query-table")).toBeNull();
    expect(screen.getByLabelText("List view").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByLabelText("Table view"));

    const headers = await screen.findAllByRole("columnheader");
    expect(headers.map((th) => th.textContent)).toEqual(["Name", "Type", "Created"]);
    const rows = container.querySelectorAll(".nt-query-table tbody tr");
    expect(rows.length).toBe(2);
    const names = Array.from(rows).map((row) => row.querySelector(".nt-query-item-name")?.textContent);
    expect(names.sort()).toEqual(["London", "Paris"]);
    const created = rows[0]!.querySelector(".nt-query-num")?.textContent ?? "";
    expect(created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByLabelText("Table view").getAttribute("aria-pressed")).toBe("true");

    // The mode persisted in the token's view record via the update path.
    let token = client.getNode(block)!.contentAst[0] as unknown as {
      type: string;
      view?: { mode?: string };
    };
    expect(token.type).toBe("query");
    expect(token.view).toEqual({ mode: "table" });

    // Toggling back restores the list and rewrites the token.
    fireEvent.click(screen.getByLabelText("List view"));
    await screen.findByRole("list", { name: "Query results" });
    expect(container.querySelector(".nt-query-table")).toBeNull();
    token = client.getNode(block)!.contentAst[0] as unknown as typeof token;
    expect(token.view).toEqual({ mode: "list" });
  });

  it("builder group-by + measure writes the aggregation and the grid updates", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const block = await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");

    fireEvent.click(screen.getByLabelText("Query settings"));
    const dialog = screen.getByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Group by"), { target: { value: "nodeType" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });

    // The written AST carries the minimal aggregation (count default measure).
    const token = client.getNode(block)!.contentAst[0] as unknown as { queryAst: QueryAst };
    expect(token.queryAst.aggregation).toEqual(countByType);
    // The grid replaces the member list: two pages in one group.
    expect(await screen.findByText("Count")).not.toBeNull();
    const cells = Array.from(container.querySelectorAll(".nt-query-table td")).map(
      (td) => td.textContent,
    );
    expect(cells).toEqual(["page", "2"]);
    expect(screen.queryByText("Paris")).toBeNull();
  });

  it("builder sums a numeric bound property grouped by the property value", async () => {
    const client = await seedClient();
    const { city, london } = await seedWorld(client);
    const rating = await client.createPropertySchema({ name: "rating", type: "number" });
    await client.setClassProperty(city, rating, { defaultValue: 1 });
    await client.setProperty(london, rating, 5);

    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const block = await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");

    fireEvent.click(screen.getByLabelText("Query settings"));
    const dialog = screen.getByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Group by"), {
      target: { value: `property:${rating}` },
    });
    fireEvent.change(within(dialog).getByLabelText("Measure"), {
      target: { value: `sum:${rating}` },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });

    const token = client.getNode(block)!.contentAst[0] as unknown as { queryAst: QueryAst };
    expect(token.queryAst.aggregation).toEqual({
      dimensions: [{ kind: "property", id: rating }],
      measures: [{ function: "sum", kind: "property", id: rating }],
    });

    // Grid: one row per effective rating (Paris rides the binding default 1,
    // London carries the authored 5); dimension cells align left, sums right.
    expect(await screen.findByText("sum(rating)")).not.toBeNull();
    const cells = Array.from(container.querySelectorAll(".nt-query-table td")).map(
      (td) => td.textContent,
    );
    expect(cells).toEqual(["1", "1", "5", "5"]);
  });

  it("invalid AST renders the placeholder without crashing", async () => {
    const client = await seedClient();
    await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken({
        version: 2,
        scope: { type: "entire_workspace" },
        root: { type: "group", logic: "and", children: [] },
      }),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    expect(await screen.findByText("invalid query")).not.toBeNull();
    // No result list rendered for the invalid token.
    expect(container.querySelector(".nt-query-list")).toBeNull();

    // The bridge fails loud with the typed error (unit-level contract).
    expect(() => client.runQueryAst({ nope: true })).toThrow(InvalidQueryAstError);
  });

  it("result list caps at 200 rows with an N-more line", async () => {
    const client = await seedClient();
    const city = await client.createClass("City");
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });
    const total = QUERY_RESULT_CAP + 5;
    for (let i = 0; i < total; i += 1) {
      await client.createObject({ nodeType: "page", name: `City ${i}`, classIds: [city] });
    }

    const { container } = render(<PageView client={client} pageId={host} />);
    await screen.findByText("City 0");
    expect(container.querySelectorAll(".nt-query-item").length).toBe(QUERY_RESULT_CAP);
    expect(badge(container)).toBe(String(total));
    expect(screen.getByText("5 more")).not.toBeNull();
  });

  it("result clicks navigate per the node_type rule (block → containing page)", async () => {
    const client = await seedClient();
    const { city, paris } = await seedWorld(client);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const queryBlock = await client.createObject({
      nodeType: "block",
      parentId: host,
      contentAst: queryToken(
        makeAst(WORKSPACE(), [{ type: "content", op: "contains", value: "capital" }]),
      ),
    });

    const opened: string[] = [];
    render(<PageView client={client} pageId={host} onOpenPage={(id) => opened.push(id)} />);
    await screen.findByText("The capital city");

    // A block result resolves to its containing page (Paris).
    fireEvent.click(screen.getByText("The capital city"));
    expect(opened).toEqual([paris]);

    // Rewrite the token to a page-level query: a page result opens directly.
    await act(async () => {
      await client.updateObject(queryBlock, {
        contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
      });
    });
    const parisRow = await screen.findByText("Paris");
    fireEvent.click(parisRow);
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
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    await client.createObject({
      nodeType: "block",
      parentId: host,
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
      fireEvent.click(screen.getByRole("button", { name: "Export" }));

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
      aggregation: countByType,
    });
    expect(result.columns).toEqual(["nodeType", "count"]);
    expect(result.rows).toEqual([["page", 2]]);

    // The two bridges are strict about their shapes: runQueryAst refuses
    // aggregation ASTs, runAggregateAst refuses plain/invalid ones.
    const aggregated = { ...makeAst(WORKSPACE()), aggregation: countByType };
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
        { nodeType: "page", name: "Paris", classIds: [city] },
      ])) as string;
      await core.invoke("createObject", [
        { nodeType: "block", parentId: paris, contentAst: text("block one") },
      ]);
      await core.invoke("createObject", [
        { nodeType: "block", parentId: paris, contentAst: text("block two") },
      ]);

      const result = (await core.invoke("runQueryAst", [
        makeAst(WORKSPACE(), [{ type: "class", classId: city }]),
      ])) as {
        ids: string[];
        rows: Array<{ id: string; name: string | null; nodeType: string; parentId: string | null }>;
      };
      expect(result.ids).toEqual([paris]);
      // Title-is-content: the query summary's `name` column is retired (always
      // null); the title lives in the node's own content.
      expect(result.rows[0]).toMatchObject({ id: paris, nodeType: "page", parentId: null });
      expect(result.rows[0]!.name).toBe("Paris");
      const parisNode = (await core.invoke("getPage", [paris])) as { contentAst: unknown };
      expect(parisNode.contentAst).toEqual(text("Paris"));

      const children = (await core.invoke("getChildren", [paris])) as Array<{ id: string }>;
      expect(children.length).toBe(2);

      // The aggregation bridge crosses the wire too (grouped grid).
      const aggregate = (await core.invoke("runAggregateAst", [
        {
          ...makeAst(WORKSPACE(), [{ type: "class", classId: city }]),
          aggregation: countByType,
        },
      ])) as { columns: string[]; rows: unknown[][] };
      expect(aggregate.columns).toEqual(["nodeType", "count"]);
      expect(aggregate.rows).toEqual([["page", 1]]);

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
