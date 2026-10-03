// @vitest-environment node
/**
 * Worker protocol tests: drive WorkerCore through the exact `{id, method,
 * args}` → `{id, result}` | `{id, error}` message shapes the worker entry
 * (store-worker.ts) uses, via the shared handleMessage(). Init builds the
 * core in-memory (sql.js + Map-backed OpfsStore + MemoryTransport — no Worker
 * globals, no real OPFS).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import type { OpfsStore } from "../src/worker/opfs.js";
import {
  WorkerCore,
  handleMessage,
  type WorkerContext,
  type WorkerInitMessage,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from "../src/worker/worker-core.js";

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

/** A WorkerContext shaped like the worker entry's, but with in-memory wiring. */
function createTestContext(): { ctx: WorkerContext; files: Map<string, Uint8Array> } {
  const { opfs, files } = createMemoryOpfs();
  const ctx: WorkerContext = {
    core: null,
    init: async (init: WorkerInitMessage) => {
      const core = await WorkerCore.create({
        SQL: sqlModule,
        opfs,
        fileName: `${init.workspaceId}.db`,
        workspaceId: init.workspaceId,
        transport: new MemoryTransport(new MemoryRelay()),
      });
      cores.push(core);
      ctx.core = core;
    },
  };
  return { ctx, files };
}

async function send(
  ctx: WorkerContext,
  method: string,
  args: unknown[] = [],
  id = 1,
): Promise<WorkerResponseMessage> {
  const message: WorkerRequestMessage = { id, method, args };
  return handleMessage(ctx, message);
}

describe("worker message protocol (handleMessage)", () => {
  it("requires init before any other method", async () => {
    const { ctx } = createTestContext();
    const response = await send(ctx, "listPages");
    expect(response.result).toBeUndefined();
    expect(response.error).toMatch(/init required/);
  });

  it("drives init → write → read → flush over the wire shapes", async () => {
    const { ctx, files } = createTestContext();

    const initResponse = await send(ctx, "init", [
      {
        sqlWasmUrl: "/assets/sql-wasm.wasm",
        workspaceId: WS,
        serverUrl: "https://notees.example.com",
        apiKey: "test-key",
      } satisfies WorkerInitMessage,
    ]);
    expect(initResponse).toEqual({ id: 1, result: null });

    const created = await send(ctx, "createObject", [{ presentAsMain: true, name: "Via Protocol" }], 2);
    expect(created.error).toBeUndefined();
    const pageId = created.result as string;
    expect(pageId).toBeTruthy();

    const listed = await send(ctx, "listPages", [], 3);
    expect(listed.error).toBeUndefined();
    const pages = listed.result as Array<{ id: string; contentAst: Array<{ type: string; text: string }> }>;
    expect(pages).toHaveLength(1);
    // Title-is-content: the create convenience became the page's text content;
    // there is no stored `name` field anymore.
    expect(pages[0]).toMatchObject({ id: pageId });
    expect(pages[0]!.contentAst).toEqual([{ type: "text", text: "Via Protocol" }]);

    const page = await send(ctx, "getPage", [pageId], 4);
    expect(page.error).toBeUndefined();
    expect(page.result).toMatchObject({ id: pageId, isClass: false, presentAsMain: true });

    const flushed = await send(ctx, "flush", [], 5);
    expect(flushed.error).toBeUndefined();
    expect(files.has(FILE)).toBe(true);

    const stats = await send(ctx, "stats", [], 6);
    expect(stats.error).toBeUndefined();
    expect(stats.result).toMatchObject({ nodes: 1, activeNodes: 1, appliedEnvelopes: 1 });
  });

  it("returns {id, error} for unknown methods", async () => {
    const { ctx } = createTestContext();
    await send(ctx, "init", [
      { sqlWasmUrl: "/x.wasm", workspaceId: WS, serverUrl: "https://x.example.com", apiKey: "k" },
    ]);
    const response = await send(ctx, "noSuchMethod", [], 7);
    expect(response.result).toBeUndefined();
    expect(response.error).toMatch(/unknown method/);
  });

  it("roots returns top-level pages only, while listPages includes main children", async () => {
    const { ctx } = createTestContext();
    await send(ctx, "init", [
      { sqlWasmUrl: "/x.wasm", workspaceId: WS, serverUrl: "https://x.example.com", apiKey: "k" },
    ]);
    const root = await send(ctx, "createObject", [{ presentAsMain: true, name: "Root Page" }], 2);
    const rootId = root.result as string;
    const sub = await send(
      ctx,
      "createObject",
      [{ parentId: rootId, presentAsMain: true, name: "Subpage" }],
      3,
    );
    expect(sub.error).toBeUndefined();

    const roots = await send(ctx, "roots", [], 4);
    expect(roots.error).toBeUndefined();
    expect((roots.result as Array<{ id: string }>).map((n) => n.id)).toEqual([rootId]);

    // listPages is the broader document-chrome read (parentless OR main
    // children) — the seam must keep the two distinct.
    const listed = await send(ctx, "listPages", [], 5);
    expect(listed.error).toBeUndefined();
    expect((listed.result as Array<{ id: string }>).map((n) => n.id).sort()).toEqual(
      [rootId, sub.result as string].sort(),
    );
  });

  it("getBlockTree treats a JSON-null depth (omitted optional over RPC) as the default cap", async () => {
    const { ctx } = createTestContext();
    await send(ctx, "init", [
      { sqlWasmUrl: "/x.wasm", workspaceId: WS, serverUrl: "https://x.example.com", apiKey: "k" },
    ]);
    const page = await send(ctx, "createObject", [{ presentAsMain: true, name: "P" }], 2);
    const pageId = page.result as string;
    const block = await send(
      ctx,
      "createObject",
      [{ parentId: pageId, contentAst: [{ type: "text", text: "child" }] }],
      3,
    );
    expect(block.error).toBeUndefined();

    // PageView calls getBlockTree(pageId) with the depth omitted; the worker
    // wire carries it as JSON null. null <= 0 is true — the tree must not be
    // empty (regression: every page rendered with zero block rows).
    const tree = await send(ctx, "getBlockTree", [pageId, null], 4);
    expect(tree.error).toBeUndefined();
    const rows = tree.result as Array<{ node: { isClass: boolean; presentAsMain: boolean } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node: { isClass: false, presentAsMain: false } });
  });
});
