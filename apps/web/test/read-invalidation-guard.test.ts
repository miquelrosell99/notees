/**
 * Read-cache dirty-key guard (op-lag slice 5) — pins slices 2 + 3 against
 * regression: which cached read keys the WorkerClient re-fetches for a
 * given change notification. Through the fake-worker harness, seeding one
 * key per invalidation class, the spec asserts:
 *
 *  - a content-only scoped change (affected = the edited node + its
 *    ancestors) re-fetches ONLY the affected node's scoped keys and the
 *    content-global reads — never roots/listPages (structure), never
 *    off-page scoped keys, never another node's reference keys;
 *  - a listing-affecting (structural) change re-fetches everything,
 *    roots/listPages included;
 *  - an edge-target payload (the mention/link target Q in the affected
 *    set — slice 3's store-level invariant) re-fetches exactly the
 *    Q-parameterized reference family, not P's.
 */

import { describe, expect, it, vi } from "vitest";

import { WorkerClient } from "../src/core/worker-client.js";

/** Minimal fake Worker speaking the worker-core wire protocol; captures the
 *  method of every key in every multiRead batch (in request order). */
function captureWorker(
  handler: (method: string, args: unknown[]) => unknown | Promise<unknown>,
): { worker: Worker; pushChanged: (payload?: Record<string, unknown>) => void; batches: () => string[][] } {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const captured: string[][] = [];
  const worker = {
    postMessage(message: { id: number; method: string; args: unknown[] }) {
      let run: Promise<unknown>;
      if (message.method === "multiRead") {
        const keys = message.args[0] as string[];
        captured.push(keys.map((key) => (JSON.parse(key) as [string, unknown[]])[0]));
        run = Promise.all(
          keys.map((key) => {
            const [method, args] = JSON.parse(key) as [string, unknown[]];
            return Promise.resolve(handler(method, args));
          }),
        );
      } else {
        run = Promise.resolve(handler(message.method, message.args));
      }
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
    batches: () => captured,
  };
}

async function makeClient() {
  const { worker, pushChanged, batches } = captureWorker((method) => {
    if (method === "init") return null;
    return null;
  });
  const client = await WorkerClient.create({
    serverUrl: "http://localhost:8377",
    apiKey: "test-key",
    workspaceId: "3b30e070-039b-47bc-ad0d-2440a2f173c5",
    sqlWasmUrl: "/sql-wasm.wasm",
    spawn: () => worker,
  });
  return { client, pushChanged, batches };
}

/** Seed one cached key per read class and wait for the initial drain. */
async function seedKeys(client: WorkerClient, batches: () => string[][]): Promise<void> {
  client.roots();
  client.listPages();
  client.search("q");
  client.getNode("X");
  client.getNode("P");
  client.getBlockTree("P");
  client.getBacklinks("Q");
  client.getLinkedReferences("Q");
  client.getReferences("Q");
  client.getUnlinkedReferenceCount("Q");
  await vi.waitFor(() => {
    expect(batches().length).toBeGreaterThan(0);
  });
}

describe("read-cache dirty-key guard (slices 2 + 3)", () => {
  it("a content-only scoped change refetches only the affected node's keys + content-global reads", async () => {
    const { client, pushChanged, batches } = await makeClient();
    try {
      await seedKeys(client, batches);
      batches().length = 0;

      // Content edit of X (payload ancestor-expanded by the worker).
      pushChanged({ revision: 1, affectedNodeIds: ["X", "X-root"], structural: false });
      await vi.waitFor(() => {
        expect(batches().length).toBeGreaterThan(0);
      });

      const batch = batches().flat();
      expect(batch).toContain("getNode"); // the X-scoped key
      expect(batch).toContain("search"); // content-global
      expect(batch).not.toContain("roots"); // structure (slice 2)
      expect(batch).not.toContain("listPages"); // structure (slice 2)
      expect(batch).not.toContain("getBlockTree"); // P-scoped, untouched
      expect(batch).not.toContain("getBacklinks"); // Q-scoped, untouched
      expect(batch).not.toContain("getLinkedReferences");
      expect(batch).not.toContain("getReferences");
      expect(batch).not.toContain("getUnlinkedReferenceCount");
    } finally {
      client.close();
    }
  });

  it("a listing-affecting (structural) change refetches the listings too", async () => {
    const { client, pushChanged, batches } = await makeClient();
    try {
      await seedKeys(client, batches);
      batches().length = 0;

      pushChanged({ revision: 2, structural: true });
      await vi.waitFor(() => {
        expect(batches().length).toBeGreaterThan(0);
      });

      const batch = batches().flat();
      expect(batch).toContain("roots");
      expect(batch).toContain("listPages");
      expect(batch).toContain("search");
    } finally {
      client.close();
    }
  });

  it("an edge-target payload refetches exactly the target's reference family", async () => {
    const { client, pushChanged, batches } = await makeClient();
    try {
      await seedKeys(client, batches);
      batches().length = 0;

      // X mentions Q: slice 3's store invariant puts Q in the affected set.
      pushChanged({ revision: 3, affectedNodeIds: ["X", "Q"], structural: false });
      await vi.waitFor(() => {
        expect(batches().length).toBeGreaterThan(0);
      });

      const batch = batches().flat();
      expect(batch).toContain("getBacklinks"); // the Q-parameterized key
      expect(batch).toContain("getLinkedReferences");
      expect(batch).toContain("getReferences");
      expect(batch).toContain("getUnlinkedReferenceCount");
      expect(batch).toContain("getNode"); // X's own scoped key
      expect(batch).toContain("search"); // content-global
      expect(batch).not.toContain("getBlockTree"); // P-scoped, untouched
      expect(batch).not.toContain("roots"); // structure
      expect(batch).not.toContain("listPages"); // structure
    } finally {
      client.close();
    }
  });
});
