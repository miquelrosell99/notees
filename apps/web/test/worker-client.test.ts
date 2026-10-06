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
      const run =
        message.method === "multiRead"
          ? Promise.all(
              (message.args[0] as string[]).map((key) => {
                const [method, args] = JSON.parse(key) as [string, unknown[]];
                return Promise.resolve(handler(method, args));
              }),
            )
          : Promise.resolve(handler(message.method, message.args));
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

  it("serves getReferences / getReferenceCount through the read cache (the References tab mirror)", async () => {
    const client = await makeClient((method) => {
      if (method === "init") return null;
      if (method === "getReferences") return [{ id: "page-9", presentAsMain: true, name: "R" }];
      if (method === "getReferenceCount") return 1;
      return null;
    });
    try {
      // Seeds: empty list / 0, converging on the worker result.
      expect(client.getReferences("page-9")).toEqual([]);
      expect(client.getReferenceCount("page-9")).toBe(0);
      await vi.waitFor(() => {
        expect(client.getReferences("page-9").map((n) => n.id)).toEqual(["page-9"]);
        expect(client.getReferenceCount("page-9")).toBe(1);
      });
    } finally {
      client.close();
    }
  });
});

describe("incremental cache invalidation (§34.114)", () => {
  /** Fake worker that also lets the test push `{type:"changed"}` messages in. */
  function controllableWorker(
    handler: (method: string, args: unknown[]) => unknown | Promise<unknown>,
    onRequest?: (method: string) => void,
  ): { worker: Worker; pushChanged: (payload?: Record<string, unknown>) => void } {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const worker = {
      postMessage(message: { id: number; method: string; args: unknown[] }) {
        onRequest?.(message.method);
        const run =
          message.method === "multiRead"
            ? Promise.all(
                (message.args[0] as string[]).map((key) => {
                  const [method, args] = JSON.parse(key) as [string, unknown[]];
                  return Promise.resolve(handler(method, args));
                }),
              )
            : Promise.resolve(handler(message.method, message.args));
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
    return {
      worker: worker as unknown as Worker,
      pushChanged: (payload = {}) => {
        for (const listener of listeners) {
          listener({ data: { type: "changed", ...payload } } as MessageEvent);
        }
      },
    };
  }

  async function makeControlled(
    handler: (method: string, args: unknown[]) => unknown,
  ): Promise<{ client: WorkerClient; pushChanged: (payload?: Record<string, unknown>) => void; calls: Map<string, number> }> {
    const calls = new Map<string, number>();
    const counted = (method: string, args: unknown[]) => {
      calls.set(method, (calls.get(method) ?? 0) + 1);
      return handler(method, args);
    };
    const { worker, pushChanged } = controllableWorker(counted, (method) => {
      calls.set(method, (calls.get(method) ?? 0) + 1);
    });
    const client = await WorkerClient.create({
      serverUrl: "http://localhost:8377",
      apiKey: "test-key",
      workspaceId: "3b30e070-039b-47bc-ad0d-2440a2f173c5",
      sqlWasmUrl: "/sql-wasm.wasm",
      spawn: () => worker,
    });
    return { client, pushChanged, calls };
  }

  const seedHandler = (method: string, args: unknown[]) => {
    if (method === "init") return null;
    if (method === "search") return [{ id: "hit-1", presentAsMain: true, name: "Hit" }];
    if (method === "roots") return [{ id: "root-1", presentAsMain: true, name: "R" }];
    if (method === "getNode") return { id: (args as string[])[0], presentAsMain: false };
    if (method === "listClasses") return [];
    return null;
  };

  it("a scoped content change refetches only scoped + content-global keys", async () => {
    const { client, pushChanged, calls } = await makeControlled(seedHandler);
    try {
      client.search("q");
      client.roots();
      client.getNode("n1");
      client.getNode("n2");
      client.listClasses();
      await vi.waitFor(() => {
        expect(calls.get("multiRead")).toBeGreaterThanOrEqual(1);
      });
      calls.clear();

      // Content edit of n1 (ancestor-expanded payload from the worker).
      pushChanged({ revision: 1, affectedNodeIds: ["n1"], structural: false });
      await vi.waitFor(() => {
        expect(calls.size).toBeGreaterThan(0);
      });

      expect(calls.get("getNode")).toBe(1); // only n1 — n2 untouched
      expect(calls.has("search")).toBe(true); // content-global
      expect(calls.has("roots")).toBe(true); // content-global
      expect(calls.has("listClasses")).toBe(false); // structural-global: untouched
      // Exactly ONE multiRead round-trip for the whole refresh.
      expect(calls.get("multiRead")).toBe(1);
    } finally {
      client.close();
    }
  });

  it("a structural change refetches every cached key", async () => {
    const { client, pushChanged, calls } = await makeControlled(seedHandler);
    try {
      client.search("q");
      client.getNode("n1");
      client.listClasses();
      await vi.waitFor(() => expect(calls.get("multiRead")).toBeGreaterThanOrEqual(1));
      calls.clear();

      pushChanged({ revision: 2, structural: true });
      await vi.waitFor(() => expect(calls.get("multiRead")).toBe(1));
      expect(calls.get("getNode")).toBe(1); // the one cached node key
      expect(calls.has("search")).toBe(true);
      expect(calls.has("listClasses")).toBe(true);
    } finally {
      client.close();
    }
  });

  it("a scope-unknown change (no payload fields) refetches everything", async () => {
    const { client, pushChanged, calls } = await makeControlled(seedHandler);
    try {
      client.search("q");
      client.listClasses();
      await vi.waitFor(() => expect(calls.get("multiRead")).toBeGreaterThanOrEqual(1));
      calls.clear();

      pushChanged({ revision: 3 });
      await vi.waitFor(() => expect(calls.get("multiRead")).toBe(1));
      expect(calls.has("search")).toBe(true);
      expect(calls.has("listClasses")).toBe(true);
    } finally {
      client.close();
    }
  });

  it("an empty scoped change runs the notify cycle but refetches nothing", async () => {
    const { client, pushChanged, calls } = await makeControlled(seedHandler);
    try {
      client.search("q");
      await vi.waitFor(() => expect(calls.get("multiRead")).toBeGreaterThanOrEqual(1));
      calls.clear();

      pushChanged({ revision: 4, affectedNodeIds: [], structural: false });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.size).toBe(0);
    } finally {
      client.close();
    }
  });
});
