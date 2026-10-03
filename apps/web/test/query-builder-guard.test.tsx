/**
 * §34.31 C1 — the builder read-back guard: an AST using constructs the
 * builder can't represent (or-roots, NOT, property conditions, multi-sort,
 * multi-dimension aggregations) opens the popover on a READ-ONLY summary
 * naming what would be lost; the lossy form unlocks only through the
 * explicit "Edit anyway" opt-in, and Apply before that opt-in is impossible.
 * Representable ASTs (incl. the §34.31 V2 created window + single sort) open
 * the editable form directly and round-trip.
 *
 * §34.31 C2 — coalesced live re-runs: a synchronous burst of notifications
 * costs exactly one re-run, not one per notification.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";
import type { Child, QueryAst, Scope } from "@notees/query";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

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

function makeAst(scope: Scope, children: Child[] = [], extra: Partial<QueryAst> = {}): QueryAst {
  return { version: 1, scope, root: { type: "group", logic: "and", children }, ...extra };
}

const WORKSPACE = (): Scope => ({ type: "entire_workspace" });

async function seedWorld(client: WorkspaceClient) {
  const city = await client.createClass("City");
  const paris = await client.createObject({ presentAsMain: true, name: "Paris", classIds: [city] });
  const host = await client.createObject({ presentAsMain: true, name: "Host" });
  return { city, paris, host };
}

function tokenAstOf(client: WorkspaceClient, block: string): QueryAst {
  const token = client.getNode(block)!.contentAst[0] as unknown as { queryAst: QueryAst };
  return token.queryAst;
}

describe("query builder read-back guard (§34.31 C1)", () => {
  it("an OR-rooted AST opens on a read-only summary naming the lost constructs", async () => {
    const client = await seedClient();
    const { city, host } = await seedWorld(client);
    await client.createObject({
      parentId: host,
      contentAst: queryToken(
        makeAst(WORKSPACE(), [
          {
            type: "group",
            logic: "or",
            children: [
              { type: "class", classId: city },
              { type: "content", op: "contains", value: "capital" },
            ],
          },
        ]),
      ),
    });

    render(<PageView client={client} pageId={host} />);
    await screen.findByText("Query");
    fireEvent.click(screen.getByLabelText("Query settings"));

    const dialog = screen.getByRole("dialog", { name: "Query builder" });
    // Read-only: the guard names the construct, the summary lists what the
    // builder CAN represent, and there is no Apply to clobber with.
    expect(within(dialog).getByRole("alert").textContent).toContain("an OR group");
    expect(within(dialog).getByText(/Scope: entire workspace/)).not.toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Apply" })).toBeNull();

    // Cancel leaves the AST untouched.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const block = client
      .getChildren(host)
      .find((node) => (node.contentAst as unknown[]).some((t) => (t as { type?: string }).type === "query"))!;
    expect(tokenAstOf(client, block.id).root.logic).toBe("and");
    expect(
      (tokenAstOf(client, block.id).root.children[0] as { type: string }).type,
    ).toBe("group");
  });

  it("rich constructs (NOT + property + multi-sort) are all named; edit-anyway unlocks the lossy form", async () => {
    const client = await seedClient();
    const { city, host } = await seedWorld(client);
    const rating = await client.createPropertySchema({ name: "rating", type: "number" });
    const block = await client.createObject({
      parentId: host,
      contentAst: queryToken(
        makeAst(WORKSPACE(), [{ type: "not", child: { type: "class", classId: city } }], {
          sort: [
            { field: "name", dir: "asc" },
            { field: "createdAt", dir: "desc" },
          ],
        }),
      ),
    });
    await client.updateObject(block, {
      contentAst: queryToken(
        makeAst(
          WORKSPACE(),
          [
            { type: "not", child: { type: "class", classId: city } },
            { type: "property", schemaId: rating, op: "gt", value: 2 },
          ],
          {
            sort: [
              { field: "name", dir: "asc" },
              { field: "createdAt", dir: "desc" },
            ],
          },
        ),
      ),
    });

    render(<PageView client={client} pageId={host} />);
    await screen.findByText("Query");
    fireEvent.click(screen.getByLabelText("Query settings"));

    const dialog = screen.getByRole("dialog", { name: "Query builder" });
    const alert = within(dialog).getByRole("alert").textContent ?? "";
    expect(alert).toContain("NOT conditions");
    expect(alert).toContain("property conditions");
    expect(alert).toContain("multiple sort levels");

    // The explicit opt-in unlocks the editable form; the warning persists.
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit anyway" }));
    expect(within(dialog).getByLabelText("Text contains")).not.toBeNull();
    expect(within(dialog).getByRole("alert").textContent).toContain("property conditions");

    // Apply now (deliberately) rewrites to the flat-AND subset: the NOT and
    // property conditions drop, the first of the multi-sort survives (the
    // representable single-sort read-back — the guard named the loss).
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });
    const ast = tokenAstOf(client, block);
    expect(ast.root).toEqual({ type: "group", logic: "and", children: [] });
    expect(ast.sort).toEqual([{ field: "name", dir: "asc" }]);
  });

  it("representable ASTs (created window + single sort) open editable directly and round-trip", async () => {
    const client = await seedClient();
    const { host } = await seedWorld(client);
    const block = await client.createObject({
      parentId: host,
      contentAst: queryToken(
        makeAst(WORKSPACE(), [{ type: "createdAfter", timestamp: "{today}" }], {
          sort: [{ field: "name", dir: "desc" }],
        }),
      ),
    });

    render(<PageView client={client} pageId={host} />);
    await screen.findByText("Query");
    fireEvent.click(screen.getByLabelText("Query settings"));

    const dialog = screen.getByRole("dialog", { name: "Query builder" });
    // No guard: directly editable, values read back.
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByLabelText("Created after")).toHaveProperty("value", "{today}");
    expect(within(dialog).getByLabelText("Sort by")).toHaveProperty("value", "name");
    expect(within(dialog).getByLabelText("Sort direction")).toHaveProperty("value", "desc");

    // Tweak + Apply: the created window and sort survive the round-trip.
    fireEvent.change(within(dialog).getByLabelText("Text contains"), {
      target: { value: "capital" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    });
    // composeQueryAst emits conditions in its fixed order (contains before
    // the created window) — the round-trip preserves the conditions, not
    // their original positions.
    expect(tokenAstOf(client, block)).toEqual(
      makeAst(
        WORKSPACE(),
        [
          { type: "content", op: "contains", value: "capital" },
          { type: "createdAfter", timestamp: "{today}" },
        ],
        { sort: [{ field: "name", dir: "desc" }] },
      ),
    );
  });

  it("multi-dimension aggregations are guarded; a single-dimension aggregation opens editable", async () => {
    const client = await seedClient();
    const { city, host } = await seedWorld(client);
    const rich = await client.createObject({
      parentId: host,
      contentAst: queryToken(
        makeAst(WORKSPACE(), [], {
          aggregation: {
            dimensions: [
              { kind: "isClass" },
              { kind: "class", id: city },
            ],
            measures: [{ function: "count" }],
          },
        }),
      ),
    });
    const plain = await client.createObject({
      parentId: host,
      contentAst: queryToken(
        makeAst(WORKSPACE(), [], {
          aggregation: { dimensions: [{ kind: "isClass" }], measures: [{ function: "count" }] },
        }),
      ),
    });

    render(<PageView client={client} pageId={host} />);
    await screen.findAllByText("Query");

    const settingsButtons = screen.getAllByLabelText("Query settings");
    // First block: guarded (two dimensions).
    fireEvent.click(settingsButtons[0]!);
    let dialog = screen.getByRole("dialog", { name: "Query builder" });
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "multiple group-by dimensions",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    // Second block: directly editable.
    fireEvent.click(screen.getAllByLabelText("Query settings")[1]!);
    dialog = screen.getByRole("dialog", { name: "Query builder" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByLabelText("Group by")).toHaveProperty("value", "isClass");

    void rich;
    void plain;
  });
});

describe("coalesced live re-runs (§34.31 C2)", () => {
  it("a synchronous notification burst costs exactly one re-run", async () => {
    const client = await seedClient();
    const { city, host } = await seedWorld(client);
    await client.createObject({
      parentId: host,
      contentAst: queryToken(makeAst(WORKSPACE(), [{ type: "class", classId: city }])),
    });

    // Capture every subscribe listener the tree registers (PageView and its
    // children each subscribe; the query view's is among them).
    const listeners: Array<() => void> = [];
    const realSubscribe = client.subscribe.bind(client);
    vi.spyOn(client, "subscribe").mockImplementation((l: () => void) => {
      listeners.push(l);
      return realSubscribe(l);
    });
    const runSpy = vi.spyOn(client, "runQueryAst");

    render(<PageView client={client} pageId={host} />);
    await screen.findByText("Paris");
    const callsAfterSettle = runSpy.mock.calls.length;
    expect(callsAfterSettle).toBeGreaterThan(0);

    // A burst of three notifications in one synchronous batch coalesces
    // into a single trailing re-run.
    act(() => {
      for (const notify of listeners) notify();
      for (const notify of listeners) notify();
      for (const notify of listeners) notify();
    });
    // The run executes synchronously up to the bridge call; let its result
    // land, then assert exactly one extra execution.
    await act(async () => {
      await Promise.resolve();
    });
    expect(runSpy.mock.calls.length).toBe(callsAfterSettle + 1);
  });
});
