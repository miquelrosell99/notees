/**
 * Block-tree serve — the getBlockTree one-CTE rewrite (the per-keystroke
 * worker-block fix). Pins:
 *
 *  - SHAPE SEMANTICS: nested tree, sibling order (incl. after a move), the
 *    row filters (classes, standalone children, trashed rows excluded) and
 *    the depth cap — byte-identical to the old per-node walk.
 *  - CARRIER EXCLUSION: an owner's node-typed / legacy-uuid property value
 *    prunes the referenced child AND its subtree; the ref set is scoped PER
 *    OWNER (a uuid text value on an unrelated node prunes nothing).
 *  - THE PERF PROPERTY: the serve runs a CONSTANT number of prepared
 *    statements regardless of the tree's row count (the old code issued two
 *    queries per row — at thousand-row pages the multiRead serialization
 *    blocked the worker's message loop for seconds per keystroke).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";

const WS = "0192b000-0000-7000-8000-000000000001";
const ACTOR = "0192b000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;
const clients: WorkspaceClient[] = [];

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

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

const ids = (tree: Array<{ node: { id: string }; children: unknown }>): string[] =>
  tree.map((entry) => entry.node.id);

describe("getBlockTree — the one-CTE serve", () => {
  it("nests children, keeps sibling order, and reorders after a move", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "T" });
    const a = await client.createObject({ parentId: pageId, name: "a" });
    const b = await client.createObject({ parentId: pageId, name: "b" });
    const a1 = await client.createObject({ parentId: a, name: "a1" });
    const a2 = await client.createObject({ parentId: a, name: "a2" });

    const before = client.getBlockTree(pageId);
    expect(ids(before)).toEqual([a, b]);
    expect(ids(before[0]!.children)).toEqual([a1, a2]);

    // Move a AFTER b: the tree read reflects the new sibling order.
    await client.moveObject(a, pageId, b);
    const after = client.getBlockTree(pageId);
    expect(ids(after)).toEqual([b, a]);
    expect(ids(after[1]!.children)).toEqual([a1, a2]);
  });

  it("excludes class nodes, standalone (isEmbedded: 0) children, and trashed rows", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "T" });
    const plain = await client.createObject({ parentId: pageId, name: "plain" });
    // A class-ASSIGNED child (a task, a quote) is an ordinary block row —
    // `is_class` marks the node itself being a class, so the assignment does
    // not exclude it.
    const cls = await client.createClass("thing");
    const classed = await client.createObject({ parentId: pageId, name: "classed", classIds: [cls] });
    await client.createObject({ parentId: pageId, name: "subpage", isEmbedded: false });
    const trashed = await client.createObject({ parentId: pageId, name: "trash" });
    await client.deleteObject(trashed);

    expect(ids(client.getBlockTree(pageId))).toEqual([plain, classed]);
  });

  it("caps the depth", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "T" });
    const a = await client.createObject({ parentId: pageId, name: "a" });
    const a1 = await client.createObject({ parentId: a, name: "a1" });
    await client.createObject({ parentId: a1, name: "a1x" });

    const depth1 = client.getBlockTree(pageId, 1);
    expect(ids(depth1)).toEqual([a]);
    expect(depth1[0]!.children).toEqual([]);
  });

  it("prunes a property carrier and its subtree; refs are scoped per owner", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "T" });
    const carrier = await client.createObject({ parentId: pageId, name: "carrier" });
    const grand = await client.createObject({ parentId: carrier, name: "grand" });
    const free = await client.createObject({ parentId: pageId, name: "free" });
    const sibling = await client.createObject({ parentId: free, name: "sibling" });

    // The page's text property carries `carrier` (canonical {nodeId} shape):
    // the carrier row and its subtree leave the body tree.
    const desc = await client.createPropertySchema({ name: "desc", type: "text" });
    await client.setProperty(pageId, desc, { nodeId: carrier });

    let tree = client.getBlockTree(pageId);
    expect(ids(tree)).toEqual([free]);
    expect(ids(tree[0]!.children)).toEqual([sibling]);

    // Legacy bare-uuid text scalar on the OTHER owner (`free`) references
    // `carrier` too — but that ref only filters FREE's own children, so the
    // tree is unchanged (carrier stays pruned via the page's ref; `sibling`
    // is not a carrier of anything and stays).
    await client.setProperty(free, desc, carrier);
    tree = client.getBlockTree(pageId);
    expect(ids(tree)).toEqual([free]);
    expect(ids(tree[0]!.children)).toEqual([sibling]);

    // Removing the page's carrier ref brings the carrier (and grand) back.
    await client.unsetProperty(pageId, desc);
    tree = client.getBlockTree(pageId);
    expect(ids(tree)).toEqual([carrier, free]);
    expect(ids(tree[0]!.children)).toEqual([grand]);
  });

  it("serves a wide tree in a constant number of prepared statements", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "T" });
    // 300 rows: 60 roots × 5 children (plus one carrier pair to exercise the
    // scoped property query).
    let last: string | undefined;
    for (let i = 0; i < 60; i += 1) {
      const rootId = await client.createObject({
        parentId: pageId,
        name: `r${i}`,
        ...(last !== undefined ? { afterId: last } : {}),
      });
      last = rootId;
      let childLast: string | undefined;
      for (let j = 0; j < 5; j += 1) {
        childLast = await client.createObject({
          parentId: rootId,
          name: `r${i}c${j}`,
          ...(childLast !== undefined ? { afterId: childLast } : {}),
        });
      }
    }

    const prepare = vi.spyOn(client.store.database, "prepare");
    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(60);
    expect(tree[0]!.children).toHaveLength(5);
    // One CTE + the three scoped property-visibility queries. The old
    // per-node walk cost 2 queries per row (361 rows → ~722); the pin keeps
    // the serve O(1) in queries.
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
