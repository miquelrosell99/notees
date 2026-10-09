/**
 * Hosted section views tests (the custom-tabs slice):
 *
 *  - resolution (sectionViewResolve): the stored AST refines the section's
 *    base row set — base-column predicates evaluate on the materialized rows
 *    (class hierarchy-aware, isClass/presentAsMain, the created window,
 *    content-contains over the flattened title, the wire-field predicates,
 *    property conditions over the effective-values read model — the
 *    one-evaluation ruling, owner 2026-10-08), only fts/linkedTo fall back
 *    to one membership probe per leaf through runQueryAst, the stored scope
 *    AND aggregation are ignored (a tab refines rows; the AST round-trips
 *    verbatim), sort applies with the compiler's semantics, groups refine
 *    consistently;
 *  - the sectionViews store: load-once per section, optimistic create with
 *    server-row replacement, failure reverts + surfaces lastWriteError;
 *  - the chrome: Default permanent first, custom tabs additive in sequence,
 *    "+" persists the FilterBuilderModal's composed AST verbatim, the tab
 *    refines the rendered rows, rename/reorder/delete/reset ride the manage
 *    row, and an empty table renders factory behavior.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderHook } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient, type ClientNode } from "../src/core/workspace-client.js";
import {
  applySectionView,
  planSectionView,
  resolveSectionViewProbed,
  useSectionViewResolution,
  type SectionViewResolveClient,
} from "../src/ui/views/sectionViewResolve.js";
import type { NodeCollectionItem } from "../src/ui/views/index.js";
import { NodeCollection } from "../src/ui/views/index.js";
import {
  ensureSectionViewsLoaded,
  resetSectionViewsForTests,
  useSectionViews,
  type SectionViewsClient,
} from "../src/ui/components/sectionViews.js";
import type { SectionView } from "../src/core/workspace-client.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const SERVER = "https://notees.example.com";
const CREDENTIAL = "nt_testsession";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

beforeEach(() => {
  localStorage.clear();
  resetSectionViewsForTests();
});

// --- fixtures ---------------------------------------------------------------------

let idCounter = 0;
function node(partial: Partial<ClientNode> & { id?: string }): ClientNode {
  idCounter += 1;
  return {
    id: partial.id ?? `0192c000-0000-7000-8000-${String(idCounter).padStart(12, "0")}`,
    workspaceId: WS,
    isClass: false,
    presentAsMain: true,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: null,
    contentAst: [{ type: "text", text: `Node ${idCounter}` }],
    icon: null,
    color: null,
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
    isActive: true,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...partial,
  };
}

function item(nodeValue: ClientNode, meta?: Record<string, unknown>): NodeCollectionItem {
  return meta === undefined ? { node: nodeValue } : { node: nodeValue, meta };
}

function astOf(...children: unknown[]): unknown {
  return {
    version: 1,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children },
  };
}

function resolveClient(overrides: Partial<SectionViewResolveClient> = {}): SectionViewResolveClient {
  return {
    getNode: () => undefined,
    getClassChildren: () => [],
    getEffectiveProperties: () => [],
    runQueryAst: async () => ({ ids: [] }),
    subscribe: () => () => {},
    ...overrides,
  };
}

const CLASS_A = "0192d000-0000-7000-8000-0000000000a1";
const CLASS_B = "0192d000-0000-7000-8000-0000000000a2";

// --- resolution: the sync (base-column) path ---------------------------------------

describe("section view resolution (sync path)", () => {
  it("an empty refinement is the identity (emptying restores factory behavior)", () => {
    const base = [item(node({})), item(node({}))];
    const plan = planSectionView(astOf());
    expect(applySectionView(resolveClient(), { items: base, groups: undefined }, plan).items).toBe(base);
  });

  it("filters by isClass / presentAsMain on the row's own columns", () => {
    const rows = [
      item(node({ isClass: false, presentAsMain: true })),
      item(node({ isClass: true, presentAsMain: false })),
      item(node({ isClass: false, presentAsMain: false })),
    ];
    const plan = planSectionView(astOf({ type: "isClass", isClass: false }));
    const result = applySectionView(resolveClient(), { items: rows, groups: undefined }, plan);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((entry) => !entry.node.isClass)).toBe(true);
  });

  it("class conditions are hierarchy-aware (the closure + extending classes)", () => {
    const memberOfB = node({ classIds: [CLASS_B] });
    const memberOfA = node({ classIds: [CLASS_A] });
    const unclassed = node({ classIds: [] });
    const client = resolveClient({
      getClassChildren: (id) => (id === CLASS_A ? [node({ id: CLASS_B, isClass: true })] : []),
    });
    const plan = planSectionView(astOf({ type: "class", classId: CLASS_A }));
    const result = applySectionView(client, { items: [item(memberOfB), item(memberOfA), item(unclassed)], groups: undefined }, plan);
    // B extends A, so B's member matches A's view too.
    expect(result.items.map((entry) => entry.node.id)).toEqual([memberOfB.id, memberOfA.id]);
  });

  it("content contains is an ASCII case-insensitive substring over the flattened title", () => {
    const alpha = node({ contentAst: [{ type: "text", text: "Alpha Beta" }] });
    const gamma = node({ contentAst: [{ type: "text", text: "gamma" }] });
    const plan = planSectionView(astOf({ type: "content", op: "contains", value: "ALPHA" }));
    const result = applySectionView(resolveClient(), { items: [item(alpha), item(gamma)], groups: undefined }, plan);
    expect(result.items.map((entry) => entry.node.id)).toEqual([alpha.id]);
  });

  it("property conditions evaluate synchronously over the effective-values read model (no probe)", () => {
    const hit = node({});
    const miss = node({});
    const client = resolveClient({
      getEffectiveProperties: (id) =>
        id === hit.id
          ? [
              {
                propertySchemaId: CLASS_B,
                idx: 0,
                elementId: "el-1",
                schema: null,
                value: 9,
                source: "authored",
              } as never,
            ]
          : [],
    });
    const plan = planSectionView(astOf({ type: "property", schemaId: CLASS_B, op: "gte", value: 5 }));
    // The one-evaluation ruling: needsProbe stays false — the property arm
    // reads the same effective-values model the compiler reads.
    expect(plan.needsProbe).toBe(false);
    const result = applySectionView(client, { items: [item(hit), item(miss)], groups: undefined }, plan);
    expect(result.items.map((entry) => entry.node.id)).toEqual([hit.id]);
  });

  it("the created window compares ISO timestamps inclusively", () => {
    const oldRow = node({ createdAt: "2026-09-01T00:00:00.000Z" });
    const newRow = node({ createdAt: "2026-10-05T12:00:00.000Z" });
    const plan = planSectionView(
      astOf({ type: "createdAfter", timestamp: "2026-10-01T00:00:00.000Z" }),
    );
    const result = applySectionView(resolveClient(), { items: [item(oldRow), item(newRow)], groups: undefined }, plan);
    expect(result.items.map((entry) => entry.node.id)).toEqual([newRow.id]);
  });

  it("wire-field predicates read the node's own columns with SQL NULL semantics", () => {
    const covered = node({ coverAssetId: "0192e000-0000-7000-8000-0000000000c1" });
    const bare = node({ coverAssetId: null });
    const exists = planSectionView(astOf({ type: "coverAsset", op: "exists" }));
    const result = applySectionView(resolveClient(), { items: [item(covered), item(bare)], groups: undefined }, exists);
    expect(result.items.map((entry) => entry.node.id)).toEqual([covered.id]);
    // neq never matches an unset field (neq requires a value comparison).
    const neq = planSectionView(
      astOf({ type: "coverAsset", op: "neq", value: "0192e000-0000-7000-8000-0000000000c1" }),
    );
    const neqResult = applySectionView(resolveClient(), { items: [item(covered), item(bare)], groups: undefined }, neq);
    expect(neqResult.items).toEqual([]);
  });

  it("group/not/or compose over the base rows", () => {
    const classed = node({ classIds: [CLASS_A] });
    const plainMain = node({ presentAsMain: true });
    const plainInline = node({ presentAsMain: false });
    const orAst = {
      version: 1,
      scope: { type: "entire_workspace" },
      root: {
        type: "group",
        logic: "or",
        children: [
          { type: "class", classId: CLASS_A },
          { type: "presentAsMain", presentAsMain: true },
        ],
      },
    };
    const plan = planSectionView(orAst);
    const result = applySectionView(
      resolveClient(),
      { items: [item(classed), item(plainMain), item(plainInline)], groups: undefined },
      plan,
    );
    expect(result.items.map((entry) => entry.node.id)).toEqual([classed.id, plainMain.id]);
  });

  it("the stored scope is ignored — the base set IS the scope", () => {
    const scoped = {
      version: 1,
      scope: { type: "subtree", pageId: "0192f000-0000-7000-8000-0000000000e1" },
      root: { type: "group", logic: "and", children: [{ type: "isClass", isClass: false }] },
    };
    const outsideSubtree = node({});
    const plan = planSectionView(scoped);
    const result = applySectionView(resolveClient(), { items: [item(outsideSubtree)], groups: undefined }, plan);
    expect(result.items).toHaveLength(1); // not restricted to the subtree
  });

  it("a stored aggregation is not a row refinement — rows still refine, nothing is dropped", () => {
    const withAggregation = {
      ...(astOf({ type: "isClass", isClass: false }) as Record<string, unknown>),
      aggregation: { dimensions: [], measures: [{ function: "count", kind: "node" }] },
    };
    const rows = [item(node({})), item(node({ isClass: true }))];
    const plan = planSectionView(withAggregation);
    const result = applySectionView(resolveClient(), { items: rows, groups: undefined }, plan);
    expect(result.items).toHaveLength(1);
  });

  it("sort applies with the compiler's semantics (name NULLs-last, id tiebreak)", () => {
    const b = node({ contentAst: [{ type: "text", text: "Beta" }] });
    const a = node({ contentAst: [{ type: "text", text: "Alpha" }] });
    const empty = node({ contentAst: [] });
    const sorted = {
      version: 1,
      scope: { type: "entire_workspace" },
      root: { type: "group", logic: "and", children: [] },
      sort: [{ field: "name", dir: "asc" }],
    };
    const plan = planSectionView(sorted);
    const result = applySectionView(
      resolveClient(),
      { items: [item(b), item(empty), item(a)], groups: undefined },
      plan,
    );
    expect(result.items.map((entry) => entry.node.id)).toEqual([a.id, b.id, empty.id]);
  });

  it("groups refine alongside items; emptied groups drop", () => {
    const match = node({ presentAsMain: true });
    const miss = node({ presentAsMain: false });
    const groups = [
      { id: "g1", label: "Kept", items: [item(match), item(miss)] },
      { id: "g2", label: "Dropped", items: [item(miss)] },
    ];
    const plan = planSectionView(astOf({ type: "presentAsMain", presentAsMain: true }));
    const result = applySectionView(resolveClient(), { items: [item(match), item(miss)], groups }, plan);
    expect(result.groups?.map((group) => group.id)).toEqual(["g1"]);
    expect(result.groups?.[0]?.items.map((entry) => entry.node.id)).toEqual([match.id]);
  });

  it("an invalid stored AST fails loud at plan time", () => {
    expect(() => planSectionView({ version: 2 })).toThrow();
  });
});

// --- resolution: the probe (joined-metadata) fallback ------------------------------

describe("section view resolution (probe fallback)", () => {
  it("plans linkedTo conditions as probes and intersects the membership set", async () => {
    const hit = node({});
    const miss = node({});
    const probeCalls: unknown[] = [];
    const client = resolveClient({
      runQueryAst: async (rawAst) => {
        probeCalls.push(rawAst);
        return { ids: [hit.id] };
      },
    });
    const plan = planSectionView(
      astOf({ type: "linkedTo", nodeId: CLASS_B }),
    );
    expect(plan.needsProbe).toBe(true);
    const result = await resolveSectionViewProbed(
      client,
      { items: [item(hit), item(miss)], groups: undefined },
      plan,
    );
    expect(result.items.map((entry) => entry.node.id)).toEqual([hit.id]);
    expect(probeCalls).toHaveLength(1);
    const probeAst = probeCalls[0] as { scope: { type: string }; root: { children: unknown[] } };
    expect(probeAst.scope).toEqual({ type: "entire_workspace" });
    expect(probeAst.root.children).toHaveLength(1);
  });

  it("mixed and/or trees evaluate direct and probed leaves together", async () => {
    const classedHit = node({ classIds: [CLASS_A] });
    const classedMiss = node({ classIds: [CLASS_A] });
    const plain = node({ classIds: [] });
    const client = resolveClient({
      getClassChildren: () => [],
      runQueryAst: async () => ({ ids: [classedHit.id] }),
    });
    const ast = {
      version: 1,
      scope: { type: "entire_workspace" },
      root: {
        type: "group",
        logic: "and",
        children: [
          { type: "class", classId: CLASS_A },
          { type: "linkedTo", nodeId: CLASS_B },
        ],
      },
    };
    const plan = planSectionView(ast);
    expect(plan.needsProbe).toBe(true);
    const result = await resolveSectionViewProbed(
      client,
      { items: [item(classedHit), item(classedMiss), item(plain)], groups: undefined },
      plan,
    );
    expect(result.items.map((entry) => entry.node.id)).toEqual([classedHit.id]);
  });
});

// --- the store ---------------------------------------------------------------------

function viewRow(partial: Partial<SectionView> & { id: string }): SectionView {
  return {
    nodeId: NODE,
    sectionKey: "linked-references",
    name: partial.id,
    sequence: 0,
    queryAst: astOf(),
    viewMode: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

const NODE = "0192b000-0000-7000-8000-0000000000a1";

function stubViewsClient(behavior: {
  list?: SectionView[] | (() => Promise<SectionView[]>);
  failWrites?: boolean;
}): SectionViewsClient & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  let seq = 0;
  const guard = <T,>(value: T): Promise<T> => {
    if (behavior.failWrites === true) throw new Error("network down");
    return Promise.resolve(value);
  };
  return {
    calls,
    listSectionViews: (...args) => {
      calls.push({ method: "list", args });
      const list = behavior.list ?? [];
      return typeof list === "function" ? list() : Promise.resolve(list);
    },
    createSectionView: (input) => {
      calls.push({ method: "create", args: [input] });
      seq += 1;
      return guard(
        viewRow({
          id: `server-view-${seq}`,
          name: input.name,
          sequence: seq - 1, // the server appends: first view is sequence 0
          queryAst: input.queryAst,
        }),
      );
    },
    renameSectionView: (_nodeId, _sectionKey, viewId, name) => {
      calls.push({ method: "rename", args: [viewId, name] });
      return guard(viewRow({ id: viewId, name }));
    },
    reorderSectionViews: (_nodeId, _sectionKey, orderedIds) => {
      calls.push({ method: "reorder", args: [orderedIds] });
      return guard(orderedIds.map((id, index) => viewRow({ id, sequence: index })));
    },
    deleteSectionView: (...args) => {
      calls.push({ method: "delete", args });
      return guard(undefined);
    },
  };
}

describe("the sectionViews store", () => {
  it("loads once per section and serves the server list", async () => {
    const client = stubViewsClient({ list: [viewRow({ id: "v1", sequence: 0 }), viewRow({ id: "v2", sequence: 1 })] });
    const { result } = renderHook(() => useSectionViews(client, NODE, "linked-references"));
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.views.map((view) => view.id)).toEqual(["v1", "v2"]);
    expect(client.calls.filter((call) => call.method === "list")).toHaveLength(1);
    // A second hook for the same section does not refetch.
    renderHook(() => useSectionViews(client, NODE, "linked-references"));
    await act(async () => {});
    expect(client.calls.filter((call) => call.method === "list")).toHaveLength(1);
    // A different section does.
    renderHook(() => useSectionViews(client, NODE, "classed-nodes"));
    await waitFor(() =>
      expect(client.calls.filter((call) => call.method === "list")).toHaveLength(2),
    );
  });

  it("create applies the optimistic row, then replaces it with the server row", async () => {
    const client = stubViewsClient({ list: [] });
    const { result } = renderHook(() => useSectionViews(client, NODE, "linked-references"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let created: SectionView | null = null;
    await act(async () => {
      created = await result.current.createView(client, NODE, "linked-references", {
        name: "Mine",
        queryAst: astOf({ type: "isClass", isClass: false }),
      });
    });
    expect(created).not.toBeNull();
    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0]).toMatchObject({ id: "server-view-1", name: "Mine", sequence: 0 });
    expect(client.calls.filter((call) => call.method === "create")).toHaveLength(1);
  });

  it("a failed write reverts and surfaces lastWriteError", async () => {
    const client = stubViewsClient({ list: [viewRow({ id: "keep", sequence: 0 })], failWrites: true });
    const { result } = renderHook(() => useSectionViews(client, NODE, "linked-references"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let created: SectionView | null = null;
    await act(async () => {
      created = await result.current.createView(client, NODE, "linked-references", {
        name: "Nope",
        queryAst: astOf(),
      });
    });
    expect(created).toBeNull();
    expect(result.current.views.map((view) => view.id)).toEqual(["keep"]);
    expect(result.current.lastWriteError).toMatch(/create view failed/);
  });

  it("a failed load serves the device cache (offline reads stay honest)", async () => {
    const offline = stubViewsClient({ list: () => Promise.reject(new Error("offline")) });
    const { result } = renderHook(() => useSectionViews(offline, NODE, "linked-references"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.views).toEqual([]);
  });
});

// --- the chrome (over a real client + stubbed REST) ---------------------------------

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The in-memory "server" table the fetch stub serves. */
let serverViews: SectionView[];
let restCalls: { method: string; url: string; body?: unknown }[];

function stubViewsFetch(): void {
  serverViews = [];
  restCalls = [];
  const listPath = /\/api\/me\/nodes\/([^/]+)\/sections\/([^/]+)\/views(?:\/([^/]+)|\/order)?$/;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const match = listPath.exec(url);
    if (match === null) {
      return new Response("not found", { status: 404 });
    }
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    restCalls.push({ method, url, body });
    const sectionViews = () => serverViews.filter((view) => `${view.nodeId}|${view.sectionKey}` === `${match[1]}|${match[2]}`);
    if (method === "GET" && match[3] === undefined) {
      return Response.json({ views: sectionViews().sort((a, b) => a.sequence - b.sequence) });
    }
    if (method === "POST" && match[3] === undefined) {
      const input = body as { name: string; queryAst: unknown; viewMode?: string | null };
      const existing = sectionViews();
      if (existing.some((view) => view.name === input.name)) {
        return Response.json({ error: { code: "conflict" } }, { status: 409 });
      }
      const view = viewRow({
        id: crypto.randomUUID(),
        nodeId: match[1]!,
        sectionKey: match[2]! as SectionView["sectionKey"],
        name: input.name,
        sequence: existing.reduce((max, entry) => Math.max(max, entry.sequence), -1) + 1,
        queryAst: input.queryAst,
        viewMode: input.viewMode ?? null,
      });
      serverViews.push(view);
      return Response.json({ view }, { status: 201 });
    }
    if (method === "PATCH" && match[3] !== undefined) {
      const view = serverViews.find((entry) => entry.id === match[3]);
      if (view === undefined) return Response.json({ error: { code: "not_found" } }, { status: 404 });
      view.name = (body as { name: string }).name;
      return Response.json({ view });
    }
    if (method === "PUT" && match[3] === "order") {
      const ordered = (body as { orderedIds: string[] }).orderedIds;
      ordered.forEach((id, index) => {
        const view = serverViews.find((entry) => entry.id === id);
        if (view !== undefined) view.sequence = index;
      });
      return Response.json({ views: serverViews.sort((a, b) => a.sequence - b.sequence) });
    }
    if (method === "DELETE" && match[3] !== undefined) {
      serverViews = serverViews.filter((entry) => entry.id !== match[3]);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }));
}

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
    serverUrl: SERVER,
    apiKey: CREDENTIAL,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

async function seedClassWorld(client: WorkspaceClient): Promise<{ cityId: string; members: string[]; plain: string[] }> {
  const cityId = await client.createClass("City");
  const m1 = await client.createObject({ presentAsMain: true, name: "Paris", classIds: [cityId] });
  const m2 = await client.createObject({ presentAsMain: true, name: "London", classIds: [cityId] });
  const p1 = await client.createObject({ presentAsMain: true, name: "Rome notes" });
  const p2 = await client.createObject({ presentAsMain: true, name: "Berlin diary" });
  return { cityId, members: [m1, m2], plain: [p1, p2] };
}

function memberItemsOf(client: WorkspaceClient, ids: string[]): NodeCollectionItem[] {
  return ids
    .map((id) => client.getNode(id))
    .filter((entry): entry is ClientNode => entry !== undefined)
    .map((entry) => ({ node: entry }));
}

describe("the hosted-views chrome", () => {
  it("renders the permanent Default tab and factory rows; an empty table changes nothing", async () => {
    stubViewsFetch();
    const client = await seedClient();
    const { members } = await seedClassWorld(client);
    render(
      <NodeCollection
        viewMode="table"
        client={client}
        items={memberItemsOf(client, members)}
        hostedViews={{ nodeId: members[0]!, sectionKey: "classed-nodes" }}
      />,
    );
    const defaultTab = await screen.findByRole("tab", { name: "Default" });
    expect(defaultTab.getAttribute("aria-selected")).toBe("true");
    // The default tab renders exactly the base rows (all members visible).
    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(screen.getByText("London")).not.toBeNull();
    // No custom tabs, nothing to reset; the add affordance is present.
    expect(screen.getByRole("button", { name: "Add custom view" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
  });

  it("an empty collection keeps the tabs visible — the container's empty line rides the selected tab's body", async () => {
    stubViewsFetch();
    const client = await seedClient();
    const { cityId } = await seedClassWorld(client);
    render(
      <NodeCollection
        viewMode="table"
        client={client}
        items={[]}
        hostedViews={{ nodeId: cityId, sectionKey: "classed-nodes" }}
        emptyText="No classed nodes yet."
      />,
    );
    const defaultTab = await screen.findByRole("tab", { name: "Default" });
    expect(defaultTab.getAttribute("aria-selected")).toBe("true");
    // The tabs chrome survives the empty section: the "+" affordance stays
    // and the container's empty line renders inside the tab body.
    expect(screen.getByRole("button", { name: "Add custom view" })).not.toBeNull();
    expect(screen.getByText("No classed nodes yet.")).not.toBeNull();
  });

  it("a custom tab refined to empty answers 'No matching rows.' inside the tab", async () => {
    stubViewsFetch();
    const client = await seedClient();
    const { cityId, members } = await seedClassWorld(client);
    const ghostId = await client.createClass("Ghost"); // no members — the refinement empties the tab
    render(
      <NodeCollection
        viewMode="table"
        client={client}
        items={memberItemsOf(client, members)}
        hostedViews={{ nodeId: cityId, sectionKey: "classed-nodes" }}
        emptyText="No classed nodes yet."
      />,
    );
    await screen.findByRole("tab", { name: "Default" });

    fireEvent.click(screen.getByRole("button", { name: "Add custom view" }));
    const dialog = await screen.findByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: ghostId } });
    fireEvent.change(within(dialog).getByLabelText("View name"), { target: { value: "Ghosts" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
    });

    fireEvent.click(await screen.findByRole("tab", { name: "Ghosts" }));
    // The refinement emptied the tab: the honest line, not the container's default-empty text.
    expect(await screen.findByText("No matching rows.")).not.toBeNull();
    expect(screen.queryByText("No classed nodes yet.")).toBeNull();
    // The Default tab keeps the factory rows.
    fireEvent.click(screen.getByRole("tab", { name: "Default" }));
    expect(await screen.findByText("Paris")).not.toBeNull();
  });

  it("the '+' flow persists the FilterBuilderModal's composed AST verbatim and the tab refines the rows", async () => {
    stubViewsFetch();
    const client = await seedClient();
    const { cityId, members, plain } = await seedClassWorld(client);
    render(
      <NodeCollection
        viewMode="table"
        client={client}
        items={memberItemsOf(client, [...members, ...plain])}
        hostedViews={{ nodeId: cityId, sectionKey: "classed-nodes" }}
      />,
    );
    await screen.findByRole("tab", { name: "Default" });

    fireEvent.click(screen.getByRole("button", { name: "Add custom view" }));
    const dialog = await screen.findByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: cityId } });
    fireEvent.change(within(dialog).getByLabelText("View name"), { target: { value: "Cities" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
    });

    // The POST carried the composed AST verbatim (a transient filter persisted as-is).
    const post = restCalls.find((call) => call.method === "POST");
    expect(post).not.toBeUndefined();
    expect((post!.body as { name: string }).name).toBe("Cities");
    expect((post!.body as { queryAst: unknown }).queryAst).toEqual({
      version: 1,
      scope: { type: "entire_workspace" },
      root: { type: "group", logic: "and", children: [{ type: "class", classId: cityId }] },
    });

    // The custom tab appears; selecting it refines the base set to the class members.
    const citiesTab = await screen.findByRole("tab", { name: "Cities" });
    fireEvent.click(citiesTab);
    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(screen.getByText("London")).not.toBeNull();
    expect(screen.queryByText("Rome notes")).toBeNull();
    expect(screen.queryByText("Berlin diary")).toBeNull();

    // The Default tab still renders exactly the factory behavior (all four rows).
    fireEvent.click(screen.getByRole("tab", { name: "Default" }));
    expect(await screen.findByText("Rome notes")).not.toBeNull();
    expect(screen.getByText("Berlin diary")).not.toBeNull();
  });

  it("reset to default deletes every custom view and returns to the factory tab", async () => {
    stubViewsFetch();
    const client = await seedClient();
    const { cityId, members, plain } = await seedClassWorld(client);
    render(
      <NodeCollection
        viewMode="table"
        client={client}
        items={memberItemsOf(client, [...members, ...plain])}
        hostedViews={{ nodeId: cityId, sectionKey: "classed-nodes" }}
      />,
    );
    await screen.findByRole("tab", { name: "Default" });

    fireEvent.click(screen.getByRole("button", { name: "Add custom view" }));
    const dialog = await screen.findByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: cityId } });
    fireEvent.change(within(dialog).getByLabelText("View name"), { target: { value: "Cities" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
    });
    await screen.findByRole("tab", { name: "Cities" });
    expect(screen.getByRole("button", { name: "Reset to default" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("Reset to default?")).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Reset to default" }));
    });

    await waitFor(() => expect(screen.queryByRole("tab", { name: "Cities" })).toBeNull());
    expect(serverViews).toHaveLength(0);
    expect(screen.getByRole("tab", { name: "Default" }).getAttribute("aria-selected")).toBe("true");
    expect(restCalls.some((call) => call.method === "DELETE")).toBe(true);
  });

  it("rename / reorder / delete ride the manage row of the active custom tab", async () => {
    stubViewsFetch();
    const client = await seedClient();
    const { cityId, members } = await seedClassWorld(client);
    render(
      <NodeCollection
        viewMode="table"
        client={client}
        items={memberItemsOf(client, members)}
        hostedViews={{ nodeId: cityId, sectionKey: "classed-nodes" }}
      />,
    );
    await screen.findByRole("tab", { name: "Default" });

    // Create two views.
    for (const name of ["One", "Two"]) {
      fireEvent.click(screen.getByRole("button", { name: "Add custom view" }));
      const dialog = await screen.findByRole("dialog", { name: "Query builder" });
      fireEvent.change(within(dialog).getByLabelText("View name"), { target: { value: name } });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
      });
      await screen.findByRole("tab", { name });
    }

    // Select the first and move it right: the PUT carries the swapped order.
    fireEvent.click(screen.getByRole("tab", { name: "One" }));
    fireEvent.click(screen.getByRole("button", { name: "Move One right" }));
    await waitFor(() => expect(restCalls.some((call) => call.method === "PUT")).toBe(true));
    await waitFor(() => {
      const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
      expect(tabs.indexOf("Two")).toBeLessThan(tabs.indexOf("One"));
    });

    // Rename it.
    fireEvent.click(screen.getByRole("button", { name: "Rename One" }));
    const renameDialog = await screen.findByRole("dialog", { name: "Rename view" });
    fireEvent.change(within(renameDialog).getByLabelText("View name"), { target: { value: "Uno" } });
    await act(async () => {
      fireEvent.click(within(renameDialog).getByRole("button", { name: "Rename" }));
    });
    await screen.findByRole("tab", { name: "Uno" });
    expect(restCalls.some((call) => call.method === "PATCH")).toBe(true);

    // Delete it.
    fireEvent.click(screen.getByRole("button", { name: "Delete Uno" }));
    const deleteDialog = await screen.findByRole("dialog");
    expect(within(deleteDialog).getByText("Delete Uno?")).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Uno" })).toBeNull());
    expect(screen.getByRole("tab", { name: "Two" })).not.toBeNull();
  });
});

describe("useSectionViewResolution hook", () => {
  it("serves the base rows with no view and the error with an invalid AST", () => {
    const rows = [item(node({}))];
    const client = resolveClient();
    const { result } = renderHook(() => useSectionViewResolution(client, rows, undefined, null));
    expect(result.current.items).toBe(rows);
    expect(result.current.error).toBeNull();

    const badView = { id: "v", queryAst: { version: 2 } };
    const { result: bad } = renderHook(() => useSectionViewResolution(client, rows, undefined, badView));
    expect(bad.current.error).not.toBeNull();
    expect(bad.current.items).toBe(rows);
  });

  it("re-resolves when the client notifies (the probe path's freshness)", async () => {
    const hit = node({});
    const miss = node({});
    let probeIds: string[] = [hit.id];
    let listener: (() => void) | null = null;
    const client = resolveClient({
      runQueryAst: async () => ({ ids: probeIds }),
      subscribe: (l) => {
        listener = l;
        return () => {};
      },
    });
    const view = { id: "v", queryAst: astOf({ type: "linkedTo", nodeId: CLASS_B }) };
    const { result } = renderHook(() =>
      useSectionViewResolution(client, [item(hit), item(miss)], undefined, view),
    );
    await waitFor(() => expect(result.current.items.map((entry) => entry.node.id)).toEqual([hit.id]));

    // The probe answers change → notify → re-probe → both rows now match.
    probeIds = [hit.id, miss.id];
    act(() => listener?.());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
  });
});

// ensureSectionViewsLoaded is exercised through the hook tests above; direct
// call kept for the no-seam client path (hand-rolled test doubles).
describe("ensureSectionViewsLoaded edge", () => {
  it("a client without the views seam answers from the device cache without crashing", () => {
    const bare = {} as SectionViewsClient;
    ensureSectionViewsLoaded(bare, NODE, "linked-references");
    const { result } = renderHook(() => useSectionViews(bare, NODE, "linked-references"));
    expect(result.current.loaded).toBe(true);
    expect(result.current.views).toEqual([]);
  });
});
