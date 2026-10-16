/**
 * Block → page extraction tests (owner 2026-10-16): the "Convert to page"
 * context-menu gesture. The composition (extractBlockToPage) is asserted
 * against stub read/write surfaces — the link block lands in the block's
 * old slot (beforeId/afterId anchors), the block moves to the workspace
 * root keeping its identity and content, and the children either stay in
 * the original page (reparented onto the link block, order preserved) or
 * follow the extracted page (keepChildren — no child moves). Plus the menu
 * wiring: the "Convert to page ›" submenu shows for inline blocks only
 * (never pages, never parent-locked date-chain nodes) and each variant is
 * a self-describing plain click.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { fireEvent, render, waitFor, within } from "@testing-library/react";

import { dayNodeId } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { extractBlockToPage } from "../src/core/extractToPage.js";
import { WorkspaceClient, type ClientNode } from "../src/core/workspace-client.js";
import { NodeContextMenu } from "../src/ui/components/NodeContextMenu.js";
import { notificationStore } from "../src/ui/components/ui/notificationStore.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

function nodeOf(partial: Partial<ClientNode> & { id: string }): ClientNode {
  return {
    workspaceId: WS,
    isClass: false,
    isEmbedded: true,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: null,
    contentAst: [{ type: "text", text: "Node" }],
    icon: null,
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
    description: null,
    color: null,
    isActive: true,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

/** Recording stub surfaces: reads from a fixed map, captures every write. */
function stubSurfaces(entries: Map<string, ClientNode[]>) {
  const nodes = new Map<string, ClientNode>();
  for (const list of entries.values()) for (const n of list) nodes.set(n.id, n);
  const creates: Array<Record<string, unknown>> = [];
  const moves: Array<{
    id: string;
    parentId: string | null;
    afterId?: string | undefined;
    beforeId?: string | undefined;
  }> = [];
  let nextId = 0;
  const reads = {
    getNode: (id: string) => nodes.get(id),
    getChildren: (id: string) => entries.get(id) ?? [],
    // The fresh read the extraction actually plans from — tests can stub
    // it independently of the (possibly stale) cached read.
    getChildrenFresh: async (id: string) => entries.get(id) ?? [],
  };
  const writes = {
    createObject: async (partial: Record<string, unknown>) => {
      creates.push(partial);
      nextId += 1;
      return `link-${nextId}`;
    },
    moveObject: async (
      id: string,
      parentId: string | null,
      afterId?: string | undefined,
      beforeId?: string | undefined,
    ) => {
      moves.push({ id, parentId, afterId, beforeId });
    },
  };
  return { reads, writes, creates, moves };
}

describe("extractBlockToPage composition", () => {
  it("extracts to root, drops a mention link block in the old slot, children stay (order preserved)", async () => {
    const parent = "p1";
    const target = nodeOf({ id: "t1", parentId: parent, contentAst: [{ type: "text", text: "Question?" }] });
    const a = nodeOf({ id: "a1", parentId: parent });
    const b = nodeOf({ id: "b1", parentId: parent });
    const c1 = nodeOf({ id: "c1", parentId: "t1" });
    const c2 = nodeOf({ id: "c2", parentId: "t1" });
    const { reads, writes, creates, moves } = stubSurfaces(
      new Map([
        [parent, [a, target, b]],
        ["t1", [c1, c2]],
      ]),
    );

    const linkId = await extractBlockToPage(reads, writes, "t1");

    expect(linkId).toBe("link-1");
    expect(creates).toEqual([
      {
        parentId: "p1",
        contentAst: [{ type: "mention", targetNodeId: "t1", text: "Question?" }],
        // Anchored AT THE SOURCE: the link lands immediately before the
        // block and inherits its slot when the block leaves — no sibling
        // lookup that a stale cached read can break (the "link lands last"
        // bug).
        beforeId: "t1",
      },
    ]);
    expect(moves).toEqual([
      { id: "t1", parentId: null },
      { id: "c1", parentId: "link-1", afterId: undefined, beforeId: undefined },
      { id: "c2", parentId: "link-1", afterId: "c1", beforeId: undefined },
    ]);
  });

  it("anchors beforeId the source itself on every position (first, middle, only child)", async () => {
    const target = nodeOf({ id: "t1", parentId: "p1" });
    const b = nodeOf({ id: "b1", parentId: "p1" });
    for (const siblings of [[target, b], [b, target], [target]] as const) {
      const stub = stubSurfaces(new Map([["p1", [...siblings]]]));
      await extractBlockToPage(stub.reads, stub.writes, "t1");
      expect(stub.creates[0]).toMatchObject({ beforeId: "t1" });
      expect(stub.creates[0]).not.toHaveProperty("afterId");
    }
  });

  it("keepChildren moves nothing but the block itself (children follow the page)", async () => {
    const target = nodeOf({ id: "t1", parentId: "p1" });
    const a = nodeOf({ id: "a1", parentId: "p1" });
    const c1 = nodeOf({ id: "c1", parentId: "t1" });
    const { reads, writes, moves } = stubSurfaces(
      new Map([
        ["p1", [a, target]],
        ["t1", [c1]],
      ]),
    );

    await extractBlockToPage(reads, writes, "t1", { keepChildren: true });

    expect(moves).toEqual([{ id: "t1", parentId: null, afterId: undefined, beforeId: undefined }]);
  });

  it("a stale CACHED children read cannot drop the child moves (the fresh read carries the plan)", async () => {
    // The production bug (owner report 2026-10-16): the WorkerClient's
    // cachedRead answered the children key with the cold-cache default []
    // — the composition planned zero child moves and the children stayed
    // with the extracted page despite "children stay here". The plan now
    // rides the fresh read; the cached read is irrelevant to it.
    const target = nodeOf({ id: "t1", parentId: "p1" });
    const a = nodeOf({ id: "a1", parentId: "p1" });
    const c1 = nodeOf({ id: "c1", parentId: "t1" });
    const c2 = nodeOf({ id: "c2", parentId: "t1" });
    const { reads, writes, moves } = stubSurfaces(
      new Map([
        ["p1", [a, target]],
        ["t1", [c1, c2]],
      ]),
    );
    // Simulate the cold render cache: cached getChildren always [].
    reads.getChildren = () => [];

    await extractBlockToPage(reads, writes, "t1", { keepChildren: false });

    expect(moves.map((m) => m.id)).toEqual(["t1", "c1", "c2"]);
    expect(moves.filter((m) => m.parentId === "link-1").map((m) => m.id)).toEqual(["c1", "c2"]);
  });

  it("fails loud for a parentless node and a date-chain node, writing nothing", async () => {
    const page = nodeOf({ id: "r1", parentId: null, isEmbedded: false });
    const parentless = stubSurfaces(new Map([["ws-root", [page]]]));
    await expect(extractBlockToPage(parentless.reads, parentless.writes, "r1")).rejects.toThrow(
      /only an inline block/,
    );
    expect(parentless.creates).toEqual([]);
    expect(parentless.moves).toEqual([]);

    const dayId = dayNodeId("2026-10-16");
    const day = nodeOf({ id: dayId, parentId: "m1" });
    const dateLocked = stubSurfaces(new Map([["m1", [day]]]));
    await expect(extractBlockToPage(dateLocked.reads, dateLocked.writes, dayId)).rejects.toThrow(
      /parent-locked/,
    );
    expect(dateLocked.creates).toEqual([]);
    expect(dateLocked.moves).toEqual([]);
  });
});

describe('NodeContextMenu "Convert to page" submenu', () => {
  function stubClient(entries: Map<string, ClientNode[]>) {
    const base = stubSurfaces(entries);
    const client = {
      ...base.writes,
      unassignClass: async () => {},
      deleteObject: async () => {},
      updateObject: async () => {},
      setProperty: async () => {},
      getEffectiveProperties: () => [],
      getNode: base.reads.getNode,
      getChildren: base.reads.getChildren,
      getChildrenFresh: base.reads.getChildrenFresh,
      listPropertySchemas: () => [],
      effectiveClassColor: () => null,
      effectiveClassIcons: () => new Map<string, string | null>(),
      getDisplayName: () => null,
    };
    return { client, ...base };
  }

  function renderMenu(node: ClientNode, client: unknown) {
    return render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node, isPage: false }}
        client={client as never}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
  }

  const inlineTarget = nodeOf({
    id: "t1",
    parentId: "p1",
    contentAst: [{ type: "text", text: "Question?" }],
  });
  const scenario = () =>
    new Map<string, ClientNode[]>([
      ["p1", [nodeOf({ id: "a1", parentId: "p1" }), inlineTarget, nodeOf({ id: "b1", parentId: "p1" })]],
      ["t1", [nodeOf({ id: "c1", parentId: "t1" })]],
    ]);

  it("offers the submenu on an inline block only (not pages, not date-chain nodes)", () => {
    // The menu portals to document.body, so each case renders alone and
    // unmounts before the next (default queries bind to the body).
    const shown = renderMenu(inlineTarget, stubClient(scenario()).client);
    expect(shown.queryByText("Convert to page")).not.toBeNull();
    shown.unmount();

    const page = nodeOf({ id: "r1", parentId: null, isEmbedded: false });
    const pageRender = renderMenu(page, stubClient(new Map()).client);
    expect(pageRender.queryByText("Convert to page")).toBeNull();
    pageRender.unmount();

    const mainChild = nodeOf({ id: "m1", parentId: "p1", isEmbedded: false });
    const mainRender = renderMenu(mainChild, stubClient(new Map()).client);
    expect(mainRender.queryByText("Convert to page")).toBeNull();
    mainRender.unmount();

    const dayId = dayNodeId("2026-10-16");
    const day = nodeOf({ id: dayId, parentId: "m1" });
    const dayRender = renderMenu(day, stubClient(new Map()).client);
    expect(dayRender.queryByText("Convert to page")).toBeNull();
    dayRender.unmount();
  });

  it("the submenu names all three variants (parent name, both root extractions)", () => {
    const { getByText } = renderMenu(inlineTarget, stubClient(scenario()).client);
    fireEvent.click(getByText("Convert to page"));
    // The stub cannot resolve the parent node itself — the fallback reads
    // "parent"; the production label carries the parent's display name.
    expect(getByText('Keep under "parent"')).not.toBeNull();
    expect(getByText("Extract without children")).not.toBeNull();
    expect(getByText("Extract with children")).not.toBeNull();
  });

  it("the extract rows carry the explanation as hover tooltips (short labels, full text on hover)", () => {
    const { getByText } = renderMenu(inlineTarget, stubClient(scenario()).client);
    fireEvent.click(getByText("Convert to page"));
    // The owner's ruling (2026-10-16): the rows read short; the full
    // explanation — a link block takes the block's place, and "follow"
    // means the SAME node keeps its children (the page is not new; the
    // block's parent_id is removed, identity untouched) — rides the
    // native title tooltips.
    const stay = getByText("Extract without children").closest("button")!;
    expect(stay.getAttribute("title")).toBe(
      "The block becomes a root page; a link block takes its place in this page, and the children stay nested under the link.",
    );
    const follow = getByText("Extract with children").closest("button")!;
    expect(follow.getAttribute("title")).toBe(
      "The block becomes a root page; a link block takes its place, and the children stay with the block — the same node, now a root page.",
    );
    // The visible explanation line is gone — the row carries no second-line
    // text (the tooltip owns the explanation).
    expect(within(stay).queryByText(/takes its place/)).toBeNull();
  });

  it("a plain click on 'children stay here' reparents the children to the link block", async () => {
    notificationStore.clearAll();
    const stub = stubClient(scenario());
    const { getByText } = renderMenu(inlineTarget, stub.client);

    fireEvent.click(getByText("Convert to page"));
    fireEvent.click(getByText("Extract without children"));

    await waitFor(() => expect(stub.moves.map((m) => m.id)).toEqual(["t1", "c1"]));
    expect(stub.creates).toEqual([
      {
        parentId: "p1",
        contentAst: [{ type: "mention", targetNodeId: "t1", text: "Question?" }],
        beforeId: "t1",
      },
    ]);
    expect(notificationStore.notifications.at(-1)?.title).toBe("Converted to page");
  });

  it("'children follow' moves nothing but the block itself", async () => {
    notificationStore.clearAll();
    const stub = stubClient(scenario());
    const { getByText } = renderMenu(inlineTarget, stub.client);

    fireEvent.click(getByText("Convert to page"));
    fireEvent.click(getByText("Extract with children"));

    await waitFor(() =>
      expect(stub.moves).toEqual([{ id: "t1", parentId: null, afterId: undefined, beforeId: undefined }]),
    );
    expect(stub.creates).toHaveLength(1);
  });
});

describe("extractBlockToPage against the real store (slot placement)", () => {
  // The composition tests above assert the op payloads on stub surfaces;
  // these run the gesture through the real client + applier — the owner
  // reported the link block landing as the LAST sibling, which a stale
  // sibling read produced; anchoring beforeId the source itself keeps the
  // slot on every position.
  let sqlModule: Awaited<ReturnType<typeof initSqlJs>>;
  const clients: WorkspaceClient[] = [];

  beforeAll(async () => {
    sqlModule = await initSqlJs();
  });
  afterEach(() => {
    while (clients.length > 0) clients.pop()!.close();
  });

  async function seed() {
    const client = await WorkspaceClient.create({
      transport: new MemoryTransport(new MemoryRelay()),
      actorId: ACTOR,
      sqlJs: sqlModule,
    });
    clients.push(client);
    await client.bootstrapWorkspace(WS);
    return client;
  }

  async function block(client: WorkspaceClient, parentId: string, text: string) {
    return client.createObject({ parentId, contentAst: [{ type: "text", text }] });
  }

  it("the link inherits the slot — middle, first, and last child", async () => {
    const client = await seed();
    const page = await client.createObject({ isEmbedded: false, name: "P" });
    const a = await block(client, page, "A");
    const t1 = await block(client, page, "T1");
    const b = await block(client, page, "B");

    // Middle of three.
    const link1 = await extractBlockToPage(client, client, t1, { keepChildren: false });
    expect(client.getChildren(page).map((c) => c.id)).toEqual([a, link1, b]);

    // First of the remaining.
    const link2 = await extractBlockToPage(client, client, a, { keepChildren: false });
    expect(client.getChildren(page).map((c) => c.id)).toEqual([link2, link1, b]);

    // Last of the remaining.
    const link3 = await extractBlockToPage(client, client, b, { keepChildren: false });
    expect(client.getChildren(page).map((c) => c.id)).toEqual([link2, link1, link3]);
  });

  it("the link is the only child left when the block was the only child", async () => {
    const client = await seed();
    const page = await client.createObject({ isEmbedded: false, name: "P" });
    const t = await block(client, page, "T");
    const link = await extractBlockToPage(client, client, t, { keepChildren: false });
    expect(client.getChildren(page).map((c) => c.id)).toEqual([link]);
  });

  it("children stay: they land under the link block in their order", async () => {
    const client = await seed();
    const page = await client.createObject({ isEmbedded: false, name: "P" });
    const target = await block(client, page, "TARGET");
    const c1 = await block(client, target, "c1");
    const c2 = await block(client, target, "c2");

    const linkId = await extractBlockToPage(client, client, target, { keepChildren: false });

    expect(client.getChildren(linkId).map((c) => c.id)).toEqual([c1, c2]);
    expect(client.getNode(target)!.parentId).toBeNull();
  });
});
