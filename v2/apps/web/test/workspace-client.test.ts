// @vitest-environment node
/**
 * WorkspaceClient core tests: two clients on one in-process MemoryRelay —
 * client A writes (page + blocks + mention), both sync, client B's local
 * store sees everything. Pure Node, no browser.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport, type SyncConflict } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";

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
    const pageId = await clientA.createObject({ nodeType: "page", name: "Hello Page" });
    const blockId = await clientA.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "World", marks: ["bold"] }],
    });
    const mentionBlockId = await clientA.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Hello Page" }],
    });

    // A's own optimistic local state already sees the writes.
    expect(clientA.getPage(pageId)?.name).toBe("Hello Page");
    expect(clientA.getBlockTree(pageId)).toHaveLength(2);

    // Sync both (A pushes any stragglers; B pulls the log).
    await clientA.sync();
    await clientB.sync();

    // B sees the page via getPage / listPages.
    expect(clientB.getPage(pageId)?.name).toBe("Hello Page");
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

    const pageId = await clientA.createObject({ nodeType: "page", name: "Rename Me" });
    await clientA.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "before" }],
    });
    await clientB.sync();
    expect(clientB.getPage(pageId)?.name).toBe("Rename Me");

    // B updates the block content; A receives it.
    const blockId = clientB.getBlockTree(pageId)[0]!.node.id;
    await clientB.updateObject(blockId, { contentAst: [{ type: "text", text: "after" }] });
    await clientA.sync();
    expect(clientA.getBlockTree(pageId)[0]?.node.contentAst).toEqual([{ type: "text", text: "after" }]);

    // A renames the page and trashes it; B converges.
    await clientA.updateObject(pageId, { name: "Renamed" });
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
    const pageId = await clientB.createObject({ nodeType: "page", name: "Conflict Page" });
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
    await clientB.updateObject(pageId, { name: "Edited after delete" });
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

    // The FTS index covers content plaintext AND stored node names.
    const pageId = await client.createObject({ nodeType: "page", name: "Search Page" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "Findable needle" }],
    });
    await client.sync();
    const hits = client.search("Findable");
    expect(hits.some((n) => n.id === blockId)).toBe(true);
    // Title search: the page itself is found by its stored name.
    const byName = client.search("Search Page");
    expect(byName.some((n) => n.id === pageId)).toBe(true);
    expect(byName.some((n) => n.id === blockId)).toBe(false);
  });
});
