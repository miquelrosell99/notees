// @vitest-environment node
/**
 * WorkerCore tests (browser persistence): OPFS round-trip (boot empty →
 * write → persist → boot again over the same bytes → identical state),
 * debounced/coalesced + serialized persistence, and two cores over two OPFS
 * instances converging against one MemoryRelay. Pure Node: the OPFS store is
 * an in-memory Map-backed fake behind the OpfsStore interface.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { deriveDisplayName } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import type { OpfsStore } from "../src/worker/opfs.js";
import { WorkerCore, type WorkerCoreOptions } from "../src/worker/worker-core.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const FILE = `${WS}.db`;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const cores: WorkerCore[] = [];

afterEach(async () => {
  while (cores.length > 0) {
    await cores.pop()!.close();
  }
});

/** In-memory OpfsStore fake with a copy-on-write file map (like OPFS). */
function createMemoryOpfs(): { opfs: OpfsStore; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const opfs: OpfsStore = {
    loadFile: async (name) => {
      const bytes = files.get(name);
      return bytes === undefined ? null : new Uint8Array(bytes);
    },
    saveFile: async (name, bytes) => {
      files.set(name, new Uint8Array(bytes));
    },
  };
  return { opfs, files };
}

async function createCore(
  options: Pick<WorkerCoreOptions, "opfs" | "fileName" | "workspaceId" | "transport"> &
    Partial<WorkerCoreOptions>,
): Promise<WorkerCore> {
  const core = await WorkerCore.create({ SQL: sqlModule, ...options });
  cores.push(core);
  return core;
}

describe("WorkerCore OPFS persistence", () => {
  it("persists mutations to OPFS and restores identical state on the next boot", async () => {
    const { opfs, files } = createMemoryOpfs();
    const relay = new MemoryRelay();

    const core = await createCore({ opfs, fileName: FILE, workspaceId: WS, transport: new MemoryTransport(relay) });
    expect(core.listPages()).toEqual([]);

    const pageId = await core.createObject({ presentAsMain: true, name: "Persisted" });
    const blockId = await core.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "World", marks: ["bold"] }],
    });
    const mentionBlockId = await core.createObject({
      parentId: pageId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Persisted" }],
    });

    await core.flush();
    expect(files.has(FILE)).toBe(true);
    const persistedBytes = new Uint8Array(files.get(FILE)!);
    expect(persistedBytes.byteLength).toBeGreaterThan(0);
    await core.close();

    // Boot a fresh core over the SAME opfs bytes — no sync, state must come
    // entirely from the persisted image.
    const core2 = await createCore({ opfs, fileName: FILE, workspaceId: WS, transport: new MemoryTransport(relay) });
    expect(core2.listPages().map((p) => p.id)).toContain(pageId);
    expect(deriveDisplayName(core2.getPage(pageId)!)).toBe("Persisted");

    const tree = core2.getBlockTree(pageId);
    expect(tree.map((t) => t.node.id)).toEqual([blockId, mentionBlockId]);
    expect(tree[0]?.node.contentAst).toEqual([{ type: "text", text: "World", marks: ["bold"] }]);

    const backlinks = core2.getBacklinks(pageId);
    expect(backlinks.some((e) => e.type === "mention" && e.sourceId === mentionBlockId)).toBe(true);
    expect(backlinks.some((e) => e.type === "mention" && e.targetId === pageId)).toBe(true);

    // The restored image also carries the sync watermark (app_meta lives in
    // the sqlite file), so stats agree without any network traffic.
    const stats = core2.stats();
    expect(stats).toMatchObject({ nodes: 3, activeNodes: 3, lastPersistError: null });
    expect(stats.appliedEnvelopes).toBe(3);
    expect(core2.exportBytes().byteLength).toBe(persistedBytes.byteLength);
    await core2.close();
  });

  it("roots() returns top-level pages only (parented children excluded)", async () => {
    const { opfs } = createMemoryOpfs();
    const core = await createCore({
      opfs,
      fileName: FILE,
      workspaceId: WS,
      transport: new MemoryTransport(new MemoryRelay()),
    });
    const pageId = await core.createObject({ presentAsMain: true, name: "Top" });
    await core.createObject({ parentId: pageId, presentAsMain: true, name: "Sub" });
    await core.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "inline" }] });
    expect(core.roots().map((n) => n.id)).toEqual([pageId]);
    expect(core.listPages()).toHaveLength(2);
    await core.close();
  });

  it("debounces OPFS writes (coalesced) and serializes them behind one chain", async () => {
    vi.useFakeTimers();
    try {
      const { opfs, files } = createMemoryOpfs();
      let saves = 0;
      const counting: OpfsStore = {
        loadFile: opfs.loadFile,
        saveFile: async (name, bytes) => {
          saves += 1;
          await opfs.saveFile(name, bytes);
        },
      };

      const core = await createCore({
        opfs: counting,
        fileName: FILE,
        workspaceId: WS,
        transport: new MemoryTransport(new MemoryRelay()),
        debounceMs: 500,
      });
      // Boot pulls nothing and must not write.
      expect(saves).toBe(0);

      await core.createObject({ presentAsMain: true, name: "A" });
      await core.createObject({ presentAsMain: true, name: "B" });
      await core.createObject({ presentAsMain: true, name: "C" });
      expect(saves).toBe(0); // debounced: nothing written yet
      // Settle the fire-and-forget push acknowledgements (microtasks only;
      // the 500 ms debounce timer must not fire).
      await vi.advanceTimersByTimeAsync(0);
      expect(saves).toBe(0);

      await vi.advanceTimersByTimeAsync(600);
      expect(saves).toBe(1); // three mutations coalesced into one write
      expect(files.has(FILE)).toBe(true);

      await core.flush();
      expect(saves).toBe(1); // clean: no pending dirty state

      await core.createObject({ presentAsMain: true, name: "D" });
      await vi.advanceTimersByTimeAsync(0);
      await core.flush();
      expect(saves).toBe(2); // a later mutation persists on demand
      await core.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("converges two cores over two OPFS instances against one MemoryRelay", async () => {
    const relay = new MemoryRelay();
    const a = createMemoryOpfs();
    const b = createMemoryOpfs();

    const coreA = await createCore({ opfs: a.opfs, fileName: FILE, workspaceId: WS, transport: new MemoryTransport(relay) });
    const coreB = await createCore({ opfs: b.opfs, fileName: FILE, workspaceId: WS, transport: new MemoryTransport(relay) });

    const pageId = await coreA.createObject({ presentAsMain: true, name: "From A" });
    await coreA.syncOnce();
    await coreB.syncOnce();
    expect(deriveDisplayName(coreB.getPage(pageId)!)).toBe("From A");

    const blockId = await coreB.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "from B" }],
    });
    await coreB.syncOnce();
    await coreA.syncOnce();
    expect(coreA.getBlockTree(pageId).map((t) => t.node.id)).toContain(blockId);
    expect(coreA.getBlockTree(pageId)[0]?.node.contentAst).toEqual([{ type: "text", text: "from B" }]);

    // Synced state lands in both OPFS images; a fresh boot of A's device
    // sees B's block without any network traffic.
    await coreA.flush();
    await coreB.flush();
    await coreA.close();
    await coreB.close();

    const coreA2 = await createCore({ opfs: a.opfs, fileName: FILE, workspaceId: WS, transport: new MemoryTransport(relay) });
    expect(deriveDisplayName(coreA2.getPage(pageId)!)).toBe("From A");
    expect(coreA2.getBlockTree(pageId).map((t) => t.node.id)).toContain(blockId);
    await coreA2.close();
  });
});
