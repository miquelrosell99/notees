// @vitest-environment node
/**
 * applyOps tests (the generic batch-write primitive):
 *
 *  - in-process: N ops apply as ONE undo entry (one undo restores the whole
 *    gesture), the batch verb labels it ("Undo import"), created ids come
 *    back per op, and anchors may reference ids created earlier in the
 *    same batch (parents before children);
 *  - worker dispatch: the "applyOps" case routes through the same write
 *    domain, honoring the verb.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { WorkerCore } from "../src/worker/worker-core.js";
import type { OpfsStore } from "../src/worker/opfs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(async () => {
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

describe("applyOps (in-process)", () => {
  it("N ops apply as ONE undo entry; the verb labels it; created ids come back per op", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });

    const ids = await client.applyOps(
      [
        { kind: "create", input: { id: "0192a000-0000-7000-8000-0000000000a1", parentId: pageId, name: "A" } },
        { kind: "create", input: { id: "0192a000-0000-7000-8000-0000000000a2", parentId: "0192a000-0000-7000-8000-0000000000a1", name: "B" } },
        { kind: "update", id: "0192a000-0000-7000-8000-0000000000a1", fields: { listStyle: "numbered" } },
        { kind: "move", id: "0192a000-0000-7000-8000-0000000000a2", parentId: pageId },
      ],
      { verb: "import" },
    );

    expect(ids).toEqual([
      "0192a000-0000-7000-8000-0000000000a1",
      "0192a000-0000-7000-8000-0000000000a2",
      undefined,
      undefined,
    ]);
    const tree = client.getBlockTree(pageId);
    expect(tree.map((r) => r.node.id)).toEqual([
      "0192a000-0000-7000-8000-0000000000a1",
      "0192a000-0000-7000-8000-0000000000a2",
    ]);
    expect(tree[0]!.node.listStyle).toBe("numbered");

    // ONE undo entry restores the whole gesture.
    const state = await client.undoState();
    expect(state.undoLabel).toBe("Undo import");
    await client.undo();
    expect(client.getBlockTree(pageId)).toHaveLength(0);
    expect(client.getNode("0192a000-0000-7000-8000-0000000000a1")).toBeUndefined();

    // Redo re-applies the whole batch as one entry.
    const redoState = await client.undoState();
    expect(redoState.redoLabel).toBe("Redo import");
    await client.redo();
    expect(client.getBlockTree(pageId)).toHaveLength(2);
  });

  it("anchors resolve against ids created earlier in the same batch", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    await client.applyOps(
      [
        { kind: "create", input: { id: "0192a000-0000-7000-8000-0000000000b1", parentId: pageId, name: "parent" } },
        { kind: "create", input: { id: "0192a000-0000-7000-8000-0000000000b2", parentId: "0192a000-0000-7000-8000-0000000000b1", name: "child" } },
      ],
      { verb: "duplicate" },
    );
    const tree = client.getBlockTree(pageId);
    expect(tree[0]!.node.id).toBe("0192a000-0000-7000-8000-0000000000b1");
    expect(tree[0]!.children[0]!.node.id).toBe("0192a000-0000-7000-8000-0000000000b2");
  });
});

describe("applyOps (worker dispatch)", () => {
  const cores: WorkerCore[] = [];
  afterEach(async () => {
    while (cores.length > 0) await cores.pop()!.close();
  });

  function createMemoryOpfs(): OpfsStore {
    const files = new Map<string, Uint8Array>();
    return {
      loadFile: async (name) => files.get(name) ?? null,
      saveFile: async (name, bytes) => {
        files.set(name, new Uint8Array(bytes));
      },
    };
  }

  it("the applyOps case applies the batch with its verb", async () => {
    const core = await WorkerCore.create({
      SQL: sqlModule,
      opfs: createMemoryOpfs(),
      fileName: `${WS}.db`,
      workspaceId: WS,
      transport: new MemoryTransport(new MemoryRelay()),
    });
    cores.push(core);
    const pageId = await core.createObject({ isEmbedded: false, name: "P" });
    const ids = (await core.invoke("applyOps", [
      [
        { kind: "create", input: { id: "0192a000-0000-7000-8000-0000000000c1", parentId: pageId, name: "A" } },
        { kind: "create", input: { id: "0192a000-0000-7000-8000-0000000000c2", parentId: pageId, name: "B" } },
      ],
      { verb: "paste" },
    ])) as Array<string | undefined>;
    expect(ids[0]).toBe("0192a000-0000-7000-8000-0000000000c1");
    expect(core.getBlockTree(pageId)).toHaveLength(2);
    const undo = (await core.invoke("undoState", [])) as { undoLabel: string | null };
    expect(undo.undoLabel).toBe("Undo paste");
  });
});
