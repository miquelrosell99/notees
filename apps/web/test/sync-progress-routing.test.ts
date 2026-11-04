// @vitest-environment node
/**
 * syncProgress routing (WorkerClient): the worker pushes engine catch-up
 * progress as `{type:"syncProgress"}` messages — the client routes them to
 * the onSyncProgress option and NEVER treats them as RPC responses (the
 * pending map is untouched). Mirrors the syncPhase routing spec.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerClient } from "../src/core/worker-client.js";

interface FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
  sent: Array<{ id: number; method: string; args: unknown[] }>;
  /** Auto-answer the init RPC so WorkerClient.create() resolves. */
  autoInit: boolean;
}

function makeFakeWorker(): FakeWorker {
  const worker: FakeWorker = {
    onmessage: null,
    sent: [],
    autoInit: true,
    postMessage(message: unknown) {
      const request = message as { id: number; method: string; args: unknown[] };
      worker.sent.push(request);
      if (worker.autoInit && request.method === "init") {
        queueMicrotask(() =>
          worker.onmessage?.({ data: { id: request.id, result: null } } as MessageEvent),
        );
      }
    },
  };
  return worker;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkerClient syncProgress routing", () => {
  it("routes syncProgress to the listener and leaves the RPC channel working", async () => {
    const worker = makeFakeWorker();
    const payloads: Array<[number, number]> = [];
    const client = await WorkerClient.create({
      serverUrl: "https://notees.example.com",
      apiKey: "test-key",
      workspaceId: "3b30e070-039b-47bc-ad0d-2440a2f173c5",
      sqlWasmUrl: "/sql-wasm.wasm",
      onSyncProgress: (applied, total) => payloads.push([applied, total]),
      spawn: () => worker as unknown as Worker,
    });

    // A progress push shares NO id with the RPC table.
    worker.onmessage?.({
      data: { type: "syncProgress", applied: 42, total: 100 },
    } as MessageEvent);
    expect(payloads).toEqual([[42, 100]]);

    // The RPC channel still round-trips after the push (a public RPC method).
    const historyPromise = client.conflictHistory();
    const request = worker.sent.at(-1)!;
    expect(request.method).toBe("conflictHistory");
    worker.onmessage?.({ data: { id: request.id, result: [{ conflictType: "move_move" }] } } as MessageEvent);
    await expect(historyPromise).resolves.toEqual([{ conflictType: "move_move" }]);
  });

  it("without a listener, a syncProgress push is a quiet no-op (no throw, no RPC misrouting)", async () => {
    const worker = makeFakeWorker();
    await WorkerClient.create({
      serverUrl: "https://notees.example.com",
      apiKey: "test-key",
      workspaceId: "3b30e070-039b-47bc-ad0d-2440a2f173c5",
      sqlWasmUrl: "/sql-wasm.wasm",
      spawn: () => worker as unknown as Worker,
    });
    expect(() =>
      worker.onmessage?.({
        data: { type: "syncProgress", applied: 1, total: 2 },
      } as MessageEvent),
    ).not.toThrow();
  });
});
