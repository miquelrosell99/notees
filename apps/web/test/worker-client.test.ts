/**
 * WorkerClient tests — the main-thread proxy over the store worker.
 *
 * Covers the read-cache contract that hid the FTS5 search outage: cachedRead
 * seeds an empty value and converges asynchronously, and a worker-side read
 * failure must stay VISIBLE (console.error) instead of silently keeping the
 * stale value.
 */

import { describe, expect, it, vi } from "vitest";

import { WorkerClient } from "../src/core/worker-client.js";

/** Minimal fake Worker speaking the worker-core wire protocol. */
function fakeWorker(
  handler: (method: string, args: unknown[]) => unknown | Promise<unknown>,
): Worker {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const worker = {
    postMessage(message: { id: number; method: string; args: unknown[] }) {
      void Promise.resolve()
        .then(() => handler(message.method, message.args))
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
}

async function makeClient(handler: (method: string, args: unknown[]) => unknown): Promise<WorkerClient> {
  return WorkerClient.create({
    serverUrl: "http://localhost:8377",
    apiKey: "test-key",
    workspaceId: "3b30e070-039b-47bc-ad0d-2440a2f173c5",
    sqlWasmUrl: "/sql-wasm.wasm",
    spawn: () => fakeWorker(handler),
  });
}

describe("WorkerClient read cache", () => {
  it("serves reads from the seed value, then converges on the worker result", async () => {
    const client = await makeClient((method) => {
      if (method === "init") return null;
      if (method === "search") return [{ id: "page-1", presentAsMain: true, name: "Hit" }];
      return null;
    });
    try {
      // First read: cache seeded with the empty value, refresh in flight.
      expect(client.search("anything")).toEqual([]);
      await vi.waitFor(() => {
        expect(client.search("anything").map((n) => n.id)).toEqual(["page-1"]);
      });
    } finally {
      client.close();
    }
  });

  it("serves roots() through the read cache", async () => {
    const client = await makeClient((method) => {
      if (method === "init") return null;
      if (method === "roots") return [{ id: "root-1", presentAsMain: true, name: "R" }];
      return null;
    });
    try {
      expect(client.roots()).toEqual([]);
      await vi.waitFor(() => {
        expect(client.roots().map((n) => n.id)).toEqual(["root-1"]);
      });
    } finally {
      client.close();
    }
  });

  it("keeps the cached value on read failure but surfaces the error loudly", async () => {
    const client = await makeClient((method) => {
      if (method === "init") return null;
      throw new Error("no such module: fts5");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(client.search("anything")).toEqual([]);
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledWith(
          expect.stringContaining('read "search" failed'),
          expect.stringContaining("no such module: fts5"),
        );
      });
      // Previous (stale) value is kept until a "changed" refresh succeeds.
      expect(client.search("anything")).toEqual([]);
    } finally {
      spy.mockRestore();
      client.close();
    }
  });

  it("fetches keys seeded while a refresh drain is running (no stranded seeds)", async () => {
    const client = await makeClient((method) => {
      if (method === "init") return null;
      if (method === "listPages")
        // Slow read: stays pending while the next key is seeded below.
        return new Promise((resolve) =>
          setTimeout(() => resolve([{ id: "page-1", presentAsMain: true, name: "P" }]), 25),
        );
      if (method === "search") return [{ id: "hit-1", presentAsMain: true, name: "Hit" }];
      return null;
    });
    try {
      expect(client.listPages()).toEqual([]); // seed → drain starts, listPages pending
      // Seed a second key while the drain is awaiting the listPages response.
      expect(client.search("x")).toEqual([]);
      await vi.waitFor(() => {
        expect(client.listPages().map((n) => n.id)).toEqual(["page-1"]);
        expect(client.search("x").map((n) => n.id)).toEqual(["hit-1"]);
      });
    } finally {
      client.close();
    }
  });
});
