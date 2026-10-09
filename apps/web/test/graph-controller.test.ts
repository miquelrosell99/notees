/**
 * engineController tests: the main↔worker wire protocol. The v2 port renamed
 * the engine's node identifier to `nodeUuid`, but the controller kept
 * forwarding v1's `nodeId` field — the worker's drag/pin handlers read
 * `nodeUuid`, so every drag silently no-op'd. These tests pin the field
 * names the worker actually reads (worker.ts is the other side of this
 * contract).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EngineController,
  type EngineFrame,
} from "../src/ui/views/graph/engineController.js";
import type { GraphEnginePhysicsConfig } from "../src/ui/views/graph/engine/index.js";

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: Array<Record<string, unknown>> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  terminated = false;

  constructor(
    public url: URL,
    public options?: unknown,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: unknown): void {
    this.posted.push(msg as Record<string, unknown>);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate the worker finishing its module load. */
  ready(): void {
    this.onmessage?.({ data: { type: "ready" } } as MessageEvent);
  }

  frame(positions: Float32Array): void {
    this.onmessage?.({
      data: { type: "frame", positions, nodeIds: ["n1"], nodeCount: 1, energy: 0, ticks: 1 },
    } as MessageEvent);
  }
}

const physics: GraphEnginePhysicsConfig = { preset: "balanced", centralGravity: 30, linkCountAttraction: false, clustering: true };
const node = { nodeUuid: "n1", x: 1, y: 2, connectionCount: 0, pinned: false };

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe("EngineController worker protocol", () => {
  it("forwards drag/pin messages with the nodeUuid field the worker reads", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new EngineController((_frame: EngineFrame) => {});
    controller.init([node], [], physics);
    const worker = FakeWorker.instances[0]!;

    // Before 'ready' the messages queue, then flush — same field assertions.
    controller.dragStart("n1");
    controller.dragMove("n1", 10, 20);
    controller.pin("n1");
    controller.dragEnd("n1");
    worker.ready();

    const sent = worker.posted.slice(1); // skip the init message
    expect(sent.map((m) => m.type)).toEqual(["dragStart", "dragMove", "pin", "dragEnd"]);
    for (const m of sent) expect(m.nodeUuid).toBe("n1");
    expect(sent[1]).toMatchObject({ x: 10, y: 20 });
  });

  it("delivers frames to the onFrame callback and forwards pause/resume", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const frames: EngineFrame[] = [];
    const controller = new EngineController((frame: EngineFrame) => frames.push(frame));
    controller.init([node], [], physics);
    const worker = FakeWorker.instances[0]!;
    worker.ready();

    worker.frame(new Float32Array([3, 4]));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.positions[0]).toBe(3);
    expect(frames[0]!.nodeIds).toEqual(["n1"]);

    controller.setPaused(true);
    controller.setPaused(false);
    expect(worker.posted.slice(-2).map((m) => m.type)).toEqual(["pause", "resume"]);
  });

  it("dispose terminates the worker", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new EngineController(() => {});
    controller.init([node], [], physics);
    const worker = FakeWorker.instances[0]!;
    worker.ready();
    controller.dispose();
    expect(worker.terminated).toBe(true);
  });
});
