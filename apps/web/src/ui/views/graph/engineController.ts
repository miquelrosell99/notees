/**
 * engineController.ts — one control surface over the force-layout engine,
 * running it in a Web Worker when available and on the main thread otherwise
 * (tests, worker-less realms). The graph view talks to this class only; the
 * frame callback receives a fresh Float32Array of world positions per tick.
 */

import {
  GraphEngine,
  buildGraphEngineConfig,
  type GraphEngineEdge,
  type GraphEngineNode,
  type GraphEnginePhysicsConfig,
} from "./engine/index.js";

export interface EngineFrame {
  positions: Float32Array;
  nodeIds: string[];
  nodeCount: number;
  energy: number;
  ticks: number;
  settled: boolean;
}

interface WorkerToMain {
  type: "ready" | "frame";
  positions?: Float32Array;
  nodeIds?: string[];
  nodeCount?: number;
  energy?: number;
  ticks?: number;
  settled?: boolean;
}

export class EngineController {
  private worker: Worker | null = null;
  private mainThread: GraphEngine | null = null;
  private mainThreadDragWasPinned = false;
  private onFrame: (frame: EngineFrame) => void;
  private ready = false;
  private settled = false;
  private pending: Array<Record<string, unknown>> = [];

  constructor(onFrame: (frame: EngineFrame) => void) {
    this.onFrame = onFrame;
  }

  /**
   * Start the engine with an initial topology. Spawns the physics worker;
   * falls back to a main-thread engine when Worker is unavailable. The
   * worker protocol takes the PHYSICS PRESET bag and builds its own numeric
   * config — a pre-built config would crash it (`preset` is not on it).
   */
  init(nodes: GraphEngineNode[], edges: GraphEngineEdge[], physics: GraphEnginePhysicsConfig): void {
    if (typeof Worker !== "undefined") {
      try {
        this.worker = new Worker(new URL("./engine/worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
          const msg = event.data;
          if (msg.type === "ready") {
            this.ready = true;
            this.flush();
            return;
          }
          if (msg.type === "frame" && msg.positions !== undefined) {
            this.settled = msg.settled ?? false;
            this.onFrame({
              positions: msg.positions,
              nodeIds: msg.nodeIds ?? [],
              nodeCount: msg.nodeCount ?? 0,
              energy: msg.energy ?? 0,
              ticks: msg.ticks ?? 0,
              settled: this.settled,
            });
          }
        };
        this.post({ type: "init", nodes, edges, config: physics });
        return;
      } catch {
        this.worker = null;
      }
    }
    this.mainThread = new GraphEngine(nodes, edges, buildGraphEngineConfig(physics));
    this.ready = true;
  }

  private post(msg: Record<string, unknown>): void {
    this.worker?.postMessage(msg);
  }

  private flush(): void {
    for (const msg of this.pending) this.post(msg);
    this.pending = [];
  }

  private send(msg: Record<string, unknown>): void {
    if (this.worker !== null) {
      if (this.ready) this.post(msg);
      else this.pending.push(msg);
    }
  }

  setTopology(nodes: GraphEngineNode[], edges: GraphEngineEdge[]): void {
    if (this.mainThread !== null) this.mainThread.setTopology(nodes, edges);
    else this.send({ type: "setTopology", nodes, edges });
  }

  setConfig(physics: GraphEnginePhysicsConfig): void {
    if (this.mainThread !== null) {
      this.mainThread.setConfig(buildGraphEngineConfig(physics));
      // Owner-facing physics change: re-animate so the new constants show.
      this.mainThread.reheat();
    } else {
      this.send({ type: "setConfig", config: physics });
    }
  }

  /** Pause/resume the worker's self-ticking clock (main-thread stepping is gated by the render loop). */
  setPaused(paused: boolean): void {
    if (this.worker !== null) this.send({ type: paused ? "pause" : "resume" });
  }

  /** Advance one physics step (main-thread path only; the worker self-ticks). */
  step(): void {
    if (this.mainThread === null || this.mainThread.settled) return;
    const s0 = this.mainThread.getState();
    this.settled = s0.settled;
    this.mainThread.step();
    if (this.mainThread !== null) {
      const s = this.mainThread.getState();
      this.settled = s.settled;
      this.onFrame({
        positions: new Float32Array(s.posX),
        nodeIds: s.nodeIdArr.slice(0, s.nodeCount),
        nodeCount: s.nodeCount,
        energy: s.energy,
        ticks: s.ticks,
        settled: s.settled,
      });
    }
  }

  /** True when the engine has converged and frozen (no force is acting). */
  get isSettled(): boolean {
    return this.settled;
  }

  /** True when the engine runs on the main thread (the worker self-ticks). */
  get runsOnMainThread(): boolean {
    return this.mainThread !== null;
  }

  /** Reheat only the neighborhood of a node (main-thread path). */
  private reheatAround(nodeId: string): void {
    if (this.mainThread === null) return;
    const pos = this.mainThread.getNodePosition(nodeId);
    if (pos === undefined) return;
    this.mainThread.reheatLocal(pos.x, pos.y, this.mainThread.config.influenceRadius, this.mainThread.config.reheatAlpha);
  }

  dragStart(nodeId: string): void {
    if (this.mainThread !== null) {
      this.mainThreadDragWasPinned = this.mainThread.isPinned(nodeId);
      this.mainThread.pinNode(nodeId);
      this.reheatAround(nodeId);
    } else {
      this.send({ type: "dragStart", nodeUuid: nodeId });
    }
  }

  dragMove(nodeId: string, x: number, y: number): void {
    if (this.mainThread !== null) {
      this.mainThread.moveNode(nodeId, x, y);
      this.reheatAround(nodeId);
    } else {
      this.send({ type: "dragMove", nodeUuid: nodeId, x, y });
    }
  }

  dragEnd(nodeId: string): void {
    if (this.mainThread !== null) {
      // Only unpin nodes that were not already pinned by the user.
      if (!this.mainThreadDragWasPinned) {
        this.mainThread.unpinNode(nodeId);
      }
      this.mainThreadDragWasPinned = false;
      this.reheatAround(nodeId);
    } else {
      this.send({ type: "dragEnd", nodeUuid: nodeId });
    }
  }

  pin(nodeId: string): void {
    if (this.mainThread !== null) this.mainThread.pinNode(nodeId);
    else this.send({ type: "pin", nodeUuid: nodeId });
  }

  unpin(nodeId: string): void {
    if (this.mainThread !== null) {
      this.mainThread.unpinNode(nodeId);
      this.reheatAround(nodeId);
    } else {
      this.send({ type: "unpin", nodeUuid: nodeId });
    }
  }

  dispose(): void {
    if (this.worker !== null) {
      this.send({ type: "destroy" });
      this.worker.terminate();
      this.worker = null;
    }
    this.mainThread?.dispose();
    this.mainThread = null;
  }
}
