// @vitest-environment node
/**
 * Create-refresh breadth gate (regression test for the block-creation
 * latency fix):
 *
 *  A plain `object.create` is a shape op, so bumpLocal() bumps the coarse
 *  `edges` and `listing` counters (read-revisions.ts: op.startsWith("object.")
 *  → edges += 1) and the structural notification dirties the main thread's
 *  whole read cache. Reads stamped on the global `e:` (backlinks /
 *  references / aliases), `q:` (search), and `c:` (class MEMBERSHIP) families
 *  legitimately re-execute on a create.
 *
 *  The per-node effective icon/color reads are the exception: they resolve
 *  from the arg-carried node fields plus class DEFINITIONS only, so they
 *  stamp on the definitions family (`d:${classes}`) and must NOT re-serve
 *  when an unrelated node is created. Before the split they rode `edges` and
 *  re-executed per visible row on EVERY block creation (~1000 re-serves per
 *  create at session scale — the seconds the app felt).
 *
 *  The decomposition still prints per-family re-serve counts for diagnosis.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { isReadUnchanged } from "../src/core/workspace-client/read-revisions.js";
import { WorkerCore } from "../src/worker/worker-core.js";
import type { OpfsStore } from "../src/worker/opfs.js";

const WS = "0192a000-0000-7000-8000-0000000000c7";
const FILE = `${WS}.db`;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const cores: WorkerCore[] = [];

afterEach(async () => {
  while (cores.length > 0) await cores.pop()!.close();
  vi.restoreAllMocks();
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

async function createCore(): Promise<WorkerCore> {
  const core = await WorkerCore.create({
    SQL: sqlModule,
    opfs: createMemoryOpfs(),
    fileName: FILE,
    workspaceId: WS,
    transport: new MemoryTransport(new MemoryRelay()),
  });
  cores.push(core);
  return core;
}

const key = (m: string, ...args: unknown[]) => JSON.stringify([m, args]);

describe("create-refresh breadth", () => {
  it("one plain block create: per-node icon/color reads stay delta'd; the page tree re-serves", async () => {
    const core = await createCore();

    // --- workspace: page P with 500 blocks, 5 sibling pages × 20 blocks ---
    const pageId = await core.createObject({ isEmbedded: false, name: "The Page" });
    const classId = (await core.invoke("createClass", ["Task"])) as string;

    const blockIds: string[] = [];
    const classed = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const isClassed = i % 10 === 0; // 50 classed blocks
      const id = await core.createObject({
        parentId: pageId,
        contentAst: [{ type: "text", text: `block ${i} body text` }],
        ...(isClassed ? { classIds: [classId] } : {}),
      });
      blockIds.push(id);
      if (isClassed) classed.add(id);
    }
    for (let s = 0; s < 5; s += 1) {
      const sib = await core.createObject({ isEmbedded: false, name: `Sibling ${s}` });
      for (let i = 0; i < 20; i += 1) {
        await core.createObject({
          parentId: sib,
          contentAst: [{ type: "text", text: `sibling ${s} block ${i}` }],
        });
      }
    }

    // --- session cache key set (mirrors WorkerClient.cachedRead shapes) ---
    const keys: string[] = [];
    keys.push(key("getBlockTree", pageId));
    keys.push(key("listPages"));
    keys.push(key("roots"));
    keys.push(key("listClasses"));
    keys.push(key("classIcons"));
    keys.push(key("effectiveClassIcons"));
    keys.push(key("search", "block 1"));
    keys.push(key("search", "block 2"));
    keys.push(key("search", "sibling"));
    for (const id of blockIds) {
      keys.push(key("getNode", id));
      const classIds = classed.has(id) ? [classId] : [];
      keys.push(
        key("effectiveNodeIcon", {
          icon: null,
          classIds,
          isClass: false,
          isEmbedded: true,
          parentId: pageId,
        }),
      );
      keys.push(key("effectiveNodeColor", { color: null, classIds }));
    }
    for (const id of blockIds.slice(0, 20)) {
      keys.push(key("getLinkedReferences", id));
    }

    // --- prime ---
    let t = performance.now();
    const primed = (await core.invoke("multiRead", [keys])) as unknown[];
    const primeMs = performance.now() - t;
    // null IS a legitimate read value (effectiveNodeIcon/Color answer null
    // for an unclassed block) — only `undefined` means the read failed.
    const primeUnresolved = primed.filter((v) => v === undefined).length;

    // --- measurement helper ---
    async function measureCreate(label: string): Promise<{ newId: string; after: unknown[] }> {
      const t0 = performance.now();
      const newId = await core.createObject({
        parentId: pageId,
        contentAst: [{ type: "text", text: "hello" }],
      });
      const createMs = performance.now() - t0;

      t = performance.now();
      const after = (await core.invoke("multiRead", [keys])) as unknown[];
      const refreshMs = performance.now() - t;

      let reServed = 0;
      const byMethod = new Map<string, number>();
      const unresolved: string[] = [];
      after.forEach((v, i) => {
        if (isReadUnchanged(v)) return;
        reServed += 1;
        const method = (JSON.parse(keys[i]!) as [string, unknown[]])[0];
        byMethod.set(method, (byMethod.get(method) ?? 0) + 1);
        if (v === undefined) unresolved.push(keys[i]!);
      });
      console.log(`\n=== ${label} (new id ${newId}) ===`);
      console.log(
        `keys total: ${keys.length} | re-served: ${reServed} | ` +
          `create ${createMs.toFixed(1)} ms | post-create multiRead ${refreshMs.toFixed(1)} ms`,
      );
      console.log(
        "re-served by method:",
        JSON.stringify(Object.fromEntries([...byMethod.entries()].sort()), null, 2),
      );
      if (unresolved.length > 0) {
        console.log(`undefined values among re-served: ${unresolved.length}`, unresolved.slice(0, 5));
      }
      return { newId, after };
    }

    const first = await measureCreate("create #1");
    const second = await measureCreate("create #2 (steady state)");

    console.log(`\n=== prime multiRead: ${primeMs.toFixed(1)} ms for ${keys.length} keys ` +
      `(undefined values on prime: ${primeUnresolved}) ===`);

    // --- the gate ---

    // The new row actually lands: the page tree re-serves and contains it.
    // getBlockTree rows are { node, children } subtrees; the new block is a
    // direct child of P, so it sits at the top level.
    const treeIndex = keys.indexOf(key("getBlockTree", pageId));
    for (const { newId, after } of [first, second]) {
      expect(isReadUnchanged(after[treeIndex])).toBe(false);
      const tree = after[treeIndex] as Array<{ node: { id: string } }>;
      expect(tree.some((row) => row.node.id === newId)).toBe(true);
    }

    // Per-node icon/color reads (cached per visible row) must NOT re-serve
    // when an unrelated block is created — this was ~1000 re-serves per
    // create before the definitions-family split.
    for (const { after } of [first, second]) {
      after.forEach((v, i) => {
        const method = (JSON.parse(keys[i]!) as [string, unknown[]])[0];
        if (method === "effectiveNodeIcon" || method === "effectiveNodeColor") {
          expect(isReadUnchanged(v), keys[i]).toBe(true);
        }
      });
    }

    // Soundness of the split: a class-DEFINITION op DOES re-serve them
    // (the resolution walks the class chain, and the `classes` counter moves).
    await core.invoke("createClass", ["Iconed", { icon: "mdi-star" }]);
    const afterClass = (await core.invoke("multiRead", [keys])) as unknown[];
    const iconKey = keys.indexOf(
      key("effectiveNodeIcon", { icon: null, classIds: [classId], isClass: false, isEmbedded: true, parentId: pageId }),
    );
    expect(isReadUnchanged(afterClass[iconKey])).toBe(false);

    // Anchor the test to the delta protocol's contract (not a perf gate):
    // with no change between two refreshes everything must delta away.
    const quiet = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(quiet.every((v) => isReadUnchanged(v))).toBe(true);
    expect(primeUnresolved).toBe(0);
  }, 120_000);
});
