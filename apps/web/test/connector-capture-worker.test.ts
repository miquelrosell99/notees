// @vitest-environment node
/**
 * Connector captures through the REAL WorkerClient — the main-thread proxy
 * with its eventually-consistent render cache — over a REAL WorkerCore store
 * (the in-process drive-the-same-code harness worker-core.test.ts uses).
 *
 * Why this file exists: captureWebPage makes WRITE-time decisions (the
 * URL-dedupe lookup, the "Read later" find-or-create, the seed deploy's
 * no-op guards, the staged-kind re-derivation). Through the WorkerClient a
 * cold/dirty cache key answers the empty default synchronously, and a client
 * that never received a "changed" push for a key keeps that default — so a
 * capture against a store seeded behind the client's back used to duplicate
 * web_page nodes, mint a second "Read later" collection, and re-stamp the
 * seed deploy's envelopes. These tests pin the fresh-read + single-flight
 * contract through the real RPC boundary (the fake worker resolves RPCs in
 * microtasks and never forwards "changed", so the cache's stale window spans
 * the whole capture — the write-time reads must not consult it at all).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkerClient } from "../src/core/worker-client.js";
import { captureWebPage } from "../src/features/connector/captureWebPage.js";
import type { OpfsStore } from "../src/worker/opfs.js";
import { WorkerCore } from "../src/worker/worker-core.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const FILE = `${WS}.db`;
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const NOW = new Date("2026-11-08T10:00:00Z");

/** Deploy-path write RPCs — a no-op deploy on a warm store must issue NONE. */
const DEPLOY_WRITES = new Set([
  "createClass",
  "setClassExtends",
  "createPropertySchema",
  "setClassProperty",
  "updateClassDisplayTemplate",
  "setFeatureEnabled",
  "updateObject", // the un-archive branch of a re-deploy
]);

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const cores: WorkerCore[] = [];
const clients: WorkerClient[] = [];

afterEach(async () => {
  // Let the render cache's scheduled drainRefresh macrotasks settle before
  // closing (a closed client rejects a pending multiRead loudly by design).
  await new Promise((resolve) => setTimeout(resolve, 5));
  while (clients.length > 0) clients.pop()!.close();
  while (cores.length > 0) await cores.pop()!.close();
});

/** In-memory OpfsStore fake with a copy-on-write file map (like OPFS). */
function createMemoryOpfs(): OpfsStore {
  const files = new Map<string, Uint8Array>();
  return {
    loadFile: async (name) => {
      const bytes = files.get(name);
      return bytes === undefined ? null : new Uint8Array(bytes);
    },
    saveFile: async (name, bytes) => {
      files.set(name, new Uint8Array(bytes));
    },
  };
}

/**
 * One store, many clients: every WorkerClient spawns a fake worker that
 * delegates the wire protocol straight to the SAME core (init is a no-op —
 * the harness builds the core beforehand). `calls` records every RPC method
 * so a test can assert which writes a capture issued.
 */
async function makeStore(): Promise<{ core: WorkerCore; calls: string[]; client: () => Promise<WorkerClient> }> {
  const core = await WorkerCore.create({
    SQL: sqlModule,
    opfs: createMemoryOpfs(),
    fileName: FILE,
    workspaceId: WS,
    actorId: ACTOR,
    transport: new MemoryTransport(new MemoryRelay()),
  });
  cores.push(core);
  const calls: string[] = [];
  const client = async (): Promise<WorkerClient> => {
    const c = await WorkerClient.create({
      serverUrl: "http://localhost:8377",
      apiKey: "test-key",
      workspaceId: WS,
      sqlWasmUrl: "/sql-wasm.wasm",
      spawn: () => {
        const listeners: Array<(event: MessageEvent) => void> = [];
        const worker = {
          postMessage(message: { id: number; method: string; args: unknown[] }) {
            calls.push(message.method);
            const run =
              message.method === "init"
                ? Promise.resolve(null)
                : Promise.resolve(core.invoke(message.method, message.args));
            void run
              .then(
                (result) => ({ id: message.id, result }),
                (error: unknown) => ({
                  id: message.id,
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
              .then((response) => {
                for (const listener of listeners) listener({ data: response } as MessageEvent);
              });
          },
          terminate() {},
        };
        Object.defineProperty(worker, "onmessage", {
          set(listener: (event: MessageEvent) => void) {
            listeners.length = 0;
            listeners.push(listener);
          },
        });
        return worker as unknown as Worker;
      },
    });
    clients.push(c);
    return c;
  };
  return { core, calls, client };
}

/** The store-side truth (never the client cache — this harness never forwards "changed"). */
async function webPageMembers(core: WorkerCore): Promise<Array<{ id: string }>> {
  return (await core.invoke("getClassMembers", [SYSTEM_CLASS_UUIDS.web_page])) as Array<{ id: string }>;
}

async function collectionMembers(core: WorkerCore): Promise<Array<{ id: string }>> {
  return (await core.invoke("getClassMembers", [SYSTEM_CLASS_UUIDS.collection])) as Array<{ id: string }>;
}

describe("captureWebPage through the WorkerClient render cache", () => {
  it("a re-capture through a COLD client reuses the node seeded behind its back — no duplicate web_page", async () => {
    const { core, client } = await makeStore();
    // Seed the store through one client…
    const first = await captureWebPage(
      await client(),
      { url: "https://example.com/essay", title: "An Essay", mode: "source" },
      NOW,
    );
    expect(await webPageMembers(core)).toHaveLength(1);

    // …then capture the SAME url through a fresh client whose render cache
    // never saw the write (no "changed" push, drains never beat the RPCs).
    const cold = await client();
    const again = await captureWebPage(
      cold,
      { url: "https://example.com/essay", title: "An Essay, re-captured", mode: "source" },
      NOW,
    );
    expect(again).toBe(first);
    expect(await webPageMembers(core)).toHaveLength(1);
  });

  it("back-to-back read-later captures through a cold client mint exactly ONE 'Read later' collection", async () => {
    const { core, client } = await makeStore();
    const cold = await client();
    await captureWebPage(
      cold,
      { url: "https://example.com/later-1", title: "Later 1", mode: "readlater" },
      NOW,
    );
    await captureWebPage(
      cold,
      { url: "https://example.com/later-2", title: "Later 2", mode: "readlater" },
      NOW,
    );
    expect(await collectionMembers(core)).toHaveLength(1);
    expect(await webPageMembers(core)).toHaveLength(2);
  });

  it("the seed deploy is a true no-op on a warm store: a capture issues zero deploy write RPCs (nothing re-stamped, nothing journaled)", async () => {
    const { core, calls, client } = await makeStore();
    // Warm the store (first capture authors the web_page seed family).
    await captureWebPage(
      await client(),
      { url: "https://example.com/warm", title: "Warm", mode: "source" },
      NOW,
    );

    // A cold client capturing a NEW url: deploy must fresh-read the seeded
    // rows, skip every step, and write ONLY the capture's own node.
    calls.length = 0;
    await captureWebPage(
      await client(),
      { url: "https://example.com/fresh-url", title: "Fresh", mode: "source" },
      NOW,
    );
    const deployWrites = calls.filter((method) => DEPLOY_WRITES.has(method));
    expect(deployWrites).toEqual([]);
    expect(await webPageMembers(core)).toHaveLength(2);
  });

  it("two interleaved same-url captures serialize through the single-flight queue — one node, both answers the first", async () => {
    const { core, client } = await makeStore();
    const cold = await client();
    const [a, b] = await Promise.all([
      captureWebPage(cold, { url: "https://example.com/race", title: "Race A", mode: "source" }, NOW),
      captureWebPage(cold, { url: "https://example.com/race", title: "Race B", mode: "source" }, NOW),
    ]);
    expect(b).toBe(a);
    expect(await webPageMembers(core)).toHaveLength(1);
  });
});
