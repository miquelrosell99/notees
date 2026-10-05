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
}

interface WorkerToMain {
  type: "ready" | "frame";
  positions?: Float32Array;
  nodeIds?: string[];
  nodeCount?: number;
  energy?: number;
  ticks?: number;
}

export class EngineController {
  private worker: Worker | null = null;
  private mainThread: GraphEngine | null = null;
  private onFrame: (frame: EngineFrame) => void;
  private ready = false;
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
            this.onFrame({
              positions: msg.positions,
              nodeIds: msg.nodeIds ?? [],
              nodeCount: msg.nodeCount ?? 0,
              energy: msg.energy ?? 0,
              ticks: msg.ticks ?? 0,
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
    if (this.mainThread !== null) this.mainThread.setConfig(buildGraphEngineConfig(physics));
    else this.send({ type: "setConfig", config: physics });
  }

  /** Advance one physics step (main-thread path only; the worker self-ticks). */
  step(): void {
    this.mainThread?.step();
    if (this.mainThread !== null) {
      const s = this.mainThread.getState();
      this.onFrame({
        positions: new Float32Array(s.posX),
        nodeIds: s.nodeIdArr.slice(0, s.nodeCount),
        nodeCount: s.nodeCount,
        energy: s.energy,
        ticks: s.ticks,
      });
    }
  }

  /** True when the engine runs on the main thread (the worker self-ticks). */
  get runsOnMainThread(): boolean {
    return this.mainThread !== null;
  }

  dragStart(nodeId: string): void {
    if (this.mainThread !== null) {
      this.mainThread.pinNode(nodeId);
    } else {
      this.send({ type: "dragStart", nodeId });
    }
  }

  dragMove(nodeId: string, x: number, y: number): void {
    if (this.mainThread !== null) {
      this.mainThread.moveNode(nodeId, x, y);
    } else {
      this.send({ type: "dragMove", nodeId, x, y });
    }
  }

  dragEnd(nodeId: string): void {
    if (this.mainThread !== null) {
      this.mainThread.unpinNode(nodeId);
    } else {
      this.send({ type: "dragEnd", nodeId });
    }
  }

  pin(nodeId: string): void {
    if (this.mainThread !== null) this.mainThread.pinNode(nodeId);
    else this.send({ type: "pin", nodeId });
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
