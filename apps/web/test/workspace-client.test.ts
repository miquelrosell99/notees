// @vitest-environment node
/**
 * WorkspaceClient core tests: two clients on one in-process MemoryRelay —
 * client A writes (page + blocks + mention), both sync, client B's local
 * store sees everything. Pure Node, no browser.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { deriveDisplayName, DEFAULT_CLASS_ICON, DEFAULT_PAGE_ICON } from "@notees/domain";
import { MemoryRelay, MemoryTransport, type SyncConflict } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { classIconMap, nodeIcon } from "../src/ui/iconFor.js";

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

interface TestContext {
  relay: MemoryRelay;
}

interface ClientGate {
  offline: boolean;
}

async function createClient(
  ctx: TestContext,
  options: {
    onConflict?: (conflicts: SyncConflict[]) => void;
    onSyncError?: (error: Error) => void;
    gate?: ClientGate;
  } = {},
): Promise<WorkspaceClient> {
  const gate = options.gate ?? { offline: false };
  const transport = new MemoryTransport(ctx.relay, {
    hooks: {
      beforeSendBatch: async () => {
        if (gate.offline) throw new Error("transport offline (test gate)");
      },
    },
  });
  const client = await WorkspaceClient.create({
    transport,
    actorId: ACTOR,
    sqlJs: sqlModule,
    ...(options.onConflict ? { onConflict: options.onConflict } : {}),
    ...(options.onSyncError ? { onSyncError: options.onSyncError } : {}),
  });
  clients.push(client);
  return client;
}

function makeContext(): TestContext {
  return { relay: new MemoryRelay() };
}

/** Let fire-and-forget pushes settle (they fail fast while offline). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("WorkspaceClient over a shared MemoryRelay", () => {
  it("converges writes from client A to client B's local store", async () => {
    const ctx = makeContext();
    const clientA = await createClient(ctx);
    const clientB = await createClient(ctx);

    await clientA.bootstrapWorkspace(WS);
    await clientB.bootstrapWorkspace(WS);
    expect(clientB.listPages()).toEqual([]);

    // A creates a page, a plain block, and a block mentioning the page.
    const pageId = await clientA.createObject({ presentAsMain: true, name: "Hello Page" });
    const blockId = await clientA.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "World", marks: ["bold"] }],
    });
    const mentionBlockId = await clientA.createObject({
      parentId: pageId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Hello Page" }],
    });

    // A's own optimistic local state already sees the writes.
    expect(deriveDisplayName(clientA.getPage(pageId)!)).toBe("Hello Page");
    expect(clientA.getBlockTree(pageId)).toHaveLength(2);

    // Sync both (A pushes any stragglers; B pulls the log).
    await clientA.sync();
    await clientB.sync();

    // B sees the page via getPage / listPages.
    expect(deriveDisplayName(clientB.getPage(pageId)!)).toBe("Hello Page");
    expect(clientB.listPages().map((p) => p.id)).toContain(pageId);

    // B sees the block tree in child order with parsed content.
    const tree = clientB.getBlockTree(pageId);
    expect(tree).toHaveLength(2);
    expect(tree[0]?.node.id).toBe(blockId);
    expect(tree[1]?.node.id).toBe(mentionBlockId);
    expect(tree[0]?.node.contentAst).toEqual([{ type: "text", text: "World", marks: ["bold"] }]);

    // B sees the mention backlink on the page.
    const backlinks = clientB.getBacklinks(pageId);
    expect(backlinks.some((e) => e.type === "mention" && e.sourceId === mentionBlockId)).toBe(true);
    expect(backlinks.some((e) => e.type === "mention" && e.targetId === pageId)).toBe(true);
  });

  it("converges updates and deletes bidirectionally", async () => {
    const ctx = makeContext();
    const clientA = await createClient(ctx);
    const clientB = await createClient(ctx);
    await clientA.bootstrapWorkspace(WS);
    await clientB.bootstrapWorkspace(WS);

    const pageId = await clientA.createObject({ presentAsMain: true, name: "Rename Me" });
    await clientA.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "before" }],
    });
    await clientB.sync();
    expect(deriveDisplayName(clientB.getPage(pageId)!)).toBe("Rename Me");

    // B updates the block content; A receives it.
    const blockId = clientB.getBlockTree(pageId)[0]!.node.id;
    await clientB.updateObject(blockId, { contentAst: [{ type: "text", text: "after" }] });
    await clientA.sync();
    expect(clientA.getBlockTree(pageId)[0]?.node.contentAst).toEqual([{ type: "text", text: "after" }]);

    // A renames the page (title-is-content: the rename IS a content write) and
    // trashes it; B converges.
    await clientA.updateObject(pageId, { contentAst: [{ type: "text", text: "Renamed" }] });
    await clientA.deleteObject(pageId);
    await clientB.sync();
    expect(clientB.getPage(pageId)).toBeUndefined();
    expect(clientB.listPages().map((p) => p.id)).not.toContain(pageId);
    // A's own local view agrees.
    expect(clientA.getPage(pageId)).toBeUndefined();
  });

  it("surfaces semantic conflicts to the caller's onConflict callback", async () => {
    const ctx = makeContext();
    const conflicts: SyncConflict[] = [];
    const syncErrors: Error[] = [];
    const gateA: ClientGate = { offline: false };
    const clientA = await createClient(ctx, {
      onConflict: (c) => conflicts.push(...c),
      onSyncError: (e) => syncErrors.push(e),
      gate: gateA,
    });
    const clientB = await createClient(ctx);
    await clientA.bootstrapWorkspace(WS);
    await clientB.bootstrapWorkspace(WS);

    // B creates a page and delivers it to A.
    const pageId = await clientB.createObject({ presentAsMain: true, name: "Conflict Page" });
    await clientB.push();
    await clientA.pull();
    expect(clientA.getPage(pageId)).toBeDefined();

    // A goes offline and deletes the page locally (push fails, op stays pending).
    gateA.offline = true;
    await clientA.deleteObject(pageId);
    await tick();
    expect(syncErrors.length).toBeGreaterThan(0);
    expect(clientA.getPage(pageId)).toBeUndefined();

    // B edits the page and pushes the edit to the relay.
    await clientB.updateObject(pageId, {
      contentAst: [{ type: "text", text: "Edited after delete" }],
    });
    await clientB.push();

    // A comes back online and pulls: the remote edit lands while A's delete
    // is still unacknowledged — the engine must report a node_deleted conflict.
    gateA.offline = false;
    await clientA.pull();
    expect(conflicts.some((c) => c.conflictType === "node_deleted" && c.nodeId === pageId)).toBe(true);

    // Full sync converges both sides to the delete.
    await clientA.sync();
    await clientB.sync();
    expect(clientA.getPage(pageId)).toBeUndefined();
    expect(clientB.getPage(pageId)).toBeUndefined();
  });

  it("searches the local store", async () => {
    const ctx = makeContext();
    const client = await createClient(ctx);
    await client.bootstrapWorkspace(WS);

    // The FTS index covers content plaintext — page titles live in their
    // content, so a title search matches the page node's own text.
    const pageId = await client.createObject({ presentAsMain: true, name: "Search Page" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Findable needle" }],
    });
    await client.sync();
    const hits = client.search("Findable");
    expect(hits.some((n) => n.id === blockId)).toBe(true);
    // Title search: the page itself is found by its title content.
    const byName = client.search("Search Page");
    expect(byName.some((n) => n.id === pageId)).toBe(true);
    expect(byName.some((n) => n.id === blockId)).toBe(false);
  });
});

describe("effective icons (display-time defaults)", () => {
  async function seedIconClient(): Promise<WorkspaceClient> {
    const client = await createClient(makeContext());
    await client.bootstrapWorkspace(WS);
    return client;
  }

  it("effectiveClassIcon: a class with no icon renders the class default", async () => {
    const client = await seedIconClient();
    const classId = await client.createClass("Plain Class");
    expect(client.effectiveClassIcon(classId)).toBe(DEFAULT_CLASS_ICON);
    // Display-time only: nothing was written to the store.
    expect(client.getNode(classId)?.icon ?? null).toBeNull();
  });

  it("effectiveClassIcon: own icon wins; the extends chain is walked", async () => {
    const client = await seedIconClient();
    const parentId = await client.createClass("Parent", { icon: "mdi-star" });
    const childId = await client.createClass("Child");
    await client.setClassExtends(childId, [parentId]);
    expect(client.effectiveClassIcon(childId)).toBe("mdi-star");

    const ownId = await client.createClass("Own", { icon: "mdi-heart" });
    await client.setClassExtends(ownId, [parentId]);
    expect(client.effectiveClassIcon(ownId)).toBe("mdi-heart");
  });

  it("effectiveClassIcon: inheritance reaches across a multi-hop chain", async () => {
    const client = await seedIconClient();
    const grandId = await client.createClass("Grand", { icon: "mdi-label" });
    const midId = await client.createClass("Mid");
    const leafId = await client.createClass("Leaf");
    await client.setClassExtends(midId, [grandId]);
    await client.setClassExtends(leafId, [midId]);
    expect(client.effectiveClassIcon(leafId)).toBe("mdi-label");
  });

  it("effectiveNodeIcon: own icon wins, then the first class with an icon (class order)", async () => {
    const client = await seedIconClient();
    const clsA = await client.createClass("A", { icon: "mdi-star" });
    const clsB = await client.createClass("B", { icon: "mdi-heart" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Icon Page" });
    await client.assignClass(pageId, clsA);
    await client.assignClass(pageId, clsB);
    expect(client.effectiveNodeIcon(client.getNode(pageId)!)).toBe("mdi-star");

    await client.updateObject(pageId, { icon: "mdi-home" });
    expect(client.effectiveNodeIcon(client.getNode(pageId)!)).toBe("mdi-home");
  });

  it("effectiveNodeIcon: pages default to the page glyph — the class default never leaks into a node", async () => {
    const client = await seedIconClient();
    // Parentless: document chrome by the second cascade branch, bit unread.
    const parentless = await client.createObject({ presentAsMain: false, name: "Parentless" });
    expect(client.effectiveNodeIcon(client.getNode(parentless)!)).toBe(DEFAULT_PAGE_ICON);
    // Parented with the render bit set: the third cascade branch.
    const parentId = await client.createObject({ presentAsMain: true, name: "Parent" });
    const mainChild = await client.createObject({ presentAsMain: true, parentId, name: "Main" });
    expect(client.effectiveNodeIcon(client.getNode(mainChild)!)).toBe(DEFAULT_PAGE_ICON);

    // An iconless class contributes no glyph to its member pages.
    const iconlessClass = await client.createClass("Iconless");
    const classed = await client.createObject({ presentAsMain: true, name: "Classed" });
    await client.assignClass(classed, iconlessClass);
    expect(client.effectiveNodeIcon(client.getNode(classed)!)).toBe(DEFAULT_PAGE_ICON);
    // Display-time only: the node's stored icon stays empty.
    expect(client.getNode(classed)?.icon ?? null).toBeNull();
  });

  it("effectiveNodeIcon: inline blocks have no default — the bullet dot stays", async () => {
    const client = await seedIconClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "inline" }],
    });
    expect(client.effectiveNodeIcon(client.getNode(blockId)!)).toBeNull();
  });

  it("effectiveNodeIcon: class nodes resolve to the class default", async () => {
    const client = await seedIconClient();
    const classId = await client.createClass("ClassNode");
    expect(client.effectiveNodeIcon(client.getNode(classId)!)).toBe(DEFAULT_CLASS_ICON);
  });

  it("nodeIcon helper (ui/iconFor): same fallback chain as the client resolver", async () => {
    const client = await seedIconClient();
    const cls = await client.createClass("Mapped", { icon: "mdi-tag" });
    const pageId = await client.createObject({ presentAsMain: true, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "b" }],
    });
    const classedId = await client.createObject({ presentAsMain: true, name: "C" });
    await client.assignClass(classedId, cls);

    const map = classIconMap(client.listClasses());
    expect(nodeIcon(client.getNode(pageId)!, map)).toBe(DEFAULT_PAGE_ICON);
    expect(nodeIcon(client.getNode(blockId)!, map)).toBeNull();
    expect(nodeIcon(client.getNode(classedId)!, map)).toBe("mdi-tag");

    await client.updateObject(classedId, { icon: "mdi-star" });
    expect(nodeIcon(client.getNode(classedId)!, map)).toBe("mdi-star");
  });
});

describe("WorkspaceClient render-path list reads — the §34.92 revision cache", () => {
  it("memoizes listPages/roots/listClasses within a store revision", async () => {
    const ctx = makeContext();
    const client = await createClient(ctx);
    await client.bootstrapWorkspace(WS);

    // No store change between calls → same reference, no re-query: dozens of
    // components call these per render, and the profile showed the unmemoized
    // reads were the main-thread jank.
    const pages = client.listPages();
    expect(client.listPages()).toBe(pages);
    expect(client.roots()).toBe(client.roots());
    expect(client.listClasses()).toBe(client.listClasses());
  });

  it("invalidates on local writes and on remote syncs", async () => {
    const ctx = makeContext();
    const clientA = await createClient(ctx);
    const clientB = await createClient(ctx);
    await clientA.bootstrapWorkspace(WS);
    await clientB.bootstrapWorkspace(WS);

    const classesBefore = clientA.listClasses();
    const pagesBefore = clientA.listPages();

    const pageId = await clientA.createObject({ presentAsMain: true, name: "Cached" });
    const classId = await clientA.createClass("CachedClass");

    const pagesAfter = clientA.listPages();
    expect(pagesAfter).not.toBe(pagesBefore);
    expect(pagesAfter.map((p) => p.id)).toContain(pageId);
    const classesAfter = clientA.listClasses();
    expect(classesAfter).not.toBe(classesBefore);
    expect(classesAfter.map((c) => c.id)).toContain(classId);
    expect(clientA.roots().map((p) => p.id)).toContain(pageId);

    // The receiving client re-reads after its pull-driven notify.
    const bPagesBefore = clientB.listPages();
    expect(clientB.listPages()).toBe(bPagesBefore);
    await clientA.sync();
    await clientB.sync();
    expect(clientB.listPages()).not.toBe(bPagesBefore);
    expect(clientB.listPages().map((p) => p.id)).toContain(pageId);
    expect(clientB.listClasses().map((c) => c.id)).toContain(classId);
  });

  it("reuses ClientNode identity for unchanged rows across revisions (§34.92 fix 5)", async () => {
    const ctx = makeContext();
    const client = await createClient(ctx);
    await client.bootstrapWorkspace(WS);
    const pageA = await client.createObject({ presentAsMain: true, name: "A" });
    const pageB = await client.createObject({ presentAsMain: true, name: "B" });
    const aBefore = client.listPages().find((p) => p.id === pageA)!;
    const aBeforeList = client.listPages();
    expect(client.getNode(pageA)).toBe(aBefore); // single read shares the cache

    // An unrelated write re-reads the list, but A's mapped node is reused
    // (the per-row identity cache — no re-parse/re-allocate of every row).
    await client.updateObject(pageB, { contentAst: [{ type: "text", text: "B2" }] });
    const pagesAfter = client.listPages();
    expect(pagesAfter).not.toBe(aBeforeList); // new list array for the new revision
    expect(pagesAfter.find((p) => p.id === pageA)).toBe(aBefore); // row identity reused
    // B's own change busts exactly B.
    expect(deriveDisplayName(pagesAfter.find((p) => p.id === pageB)!)).toBe("B2");
  });

  it("membership recomputes bust the row without an hlc/updated_at bump (§34.92 fix 5)", async () => {
    // The soundness case: recomputeClassIds changes class_ids but not the
    // row's hlc/updated_at — the identity stamp must cover the values.
    const ctx = makeContext();
    const client = await createClient(ctx);
    await client.bootstrapWorkspace(WS);
    const cls = await client.createClass("Member");
    const page = await client.createObject({ presentAsMain: true, name: "M" });
    const before = client.listPages().find((p) => p.id === page)!;

    await client.assignClass(page, cls);

    const after = client.listPages().find((p) => p.id === page)!;
    expect(after).not.toBe(before);
    expect(after.classIds).toContain(cls);
  });

  it("classIcons: the narrow id→icon read tracks updates and hides tombstoned classes", async () => {
    const ctx = makeContext();
    const client = await createClient(ctx);
    await client.bootstrapWorkspace(WS);
    const cls = await client.createClass("Ico", { icon: "mdi-tag" });
    expect(client.classIcons().get(cls)).toBe("mdi-tag");

    await client.updateObject(cls, { icon: "mdi-star" });
    expect(client.classIcons().get(cls)).toBe("mdi-star");

    await client.deleteObject(cls);
    expect(client.classIcons().has(cls)).toBe(false);
  });

  it("getBlockTree rides the revision cache (the deferred §34.92 follow-up)", async () => {
    const ctx = makeContext();
    const client = await createClient(ctx);
    await client.bootstrapWorkspace(WS);
    const page = await client.createObject({ presentAsMain: true, name: "T" });
    await client.createObject({ parentId: page, contentAst: [{ type: "text", text: "b" }] });

    const tree = client.getBlockTree(page);
    expect(client.getBlockTree(page)).toBe(tree);

    await client.createObject({ parentId: page, contentAst: [{ type: "text", text: "c" }] });
    expect(client.getBlockTree(page)).not.toBe(tree);
    expect(client.getBlockTree(page)).toHaveLength(2);
  });
});
