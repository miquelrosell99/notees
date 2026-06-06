/**
 * SGE Physics Worker Protocol
 *
 * Type definitions for messages between the main thread and the
 * sgePhysicsWorker — the Web Worker that runs the SGE (Semantic Graph Engine)
 * simulation off the main thread.
 *
 * Data flow:
 *   Main thread  →  (postMessage)  →  Physics Worker
 *     - init         : full graph topology + SGE config
 *     - setTopology  : full node/edge replacement (graph reloads)
 *     - addNode      : incremental node addition
 *     - removeNode   : incremental node removal
 *     - addEdge      : incremental edge addition
 *     - removeEdge   : incremental edge removal
 *     - dragStart    : pin a node (user picks up)
 *     - dragMove     : move a pinned node each pointer-move event
 *     - dragEnd      : unpin a node (user releases)
 *     - pinNode      : permanently pin a node
 *     - unpinNode    : permanently unpin a node
 *     - setConfig    : live-update physics parameters
 *     - reheat       : restart cooling schedule
 *     - destroy      : clean up and terminate
 *
 *   Physics Worker  →  (postMessage)  →  Main thread
 *     - ready     : worker initialized and simulation running
 *     - frame     : Float32Array of [x0,y0, x1,y1, …] positions
 *                   plus current alpha + energy for UI feedback
 */

import type { SGEEdge, SGEUserConfig } from './SemanticGraphEngine';

// ============================================================
// Shared-memory descriptor  (requires crossOriginIsolated)
// ============================================================

/**
 * Sent once by the worker after every init / topology change when
 * SharedArrayBuffer is available (crossOriginIsolated === true).
 *
 * The main thread stores these views and polls them in its RAF loop
 * via Atomics.load(meta, META_SEQ) instead of receiving a postMessage
 * every physics tick — eliminating per-frame serialisation entirely.
 *
 * Memory layout
 * ─────────────
 *  positions  Float32Array  [x0,y0, x1,y1, …]   n × 2 floats
 *  meta                                           5 × 4 bytes
 *   Int32 view:  [0]=seq  [1]=nodeCount  [2]=ticks
 *   Float32 view:[3]=energy
 */
export const META_SEQ    = 0;  // Int32 slot: incremented by worker after each write
export const META_COUNT  = 1;  // Int32 slot: active node count
export const META_TICKS  = 2;  // Int32 slot: simulation tick counter
export const META_ENERGY = 3;  // Float32 slot: kinetic energy

export interface PhysicsSharedBufferMessage {
  type: 'sharedBuffer';
  /** Interleaved [x0,y0, x1,y1, …] Float32 positions.  Size = n × 2 × 4 bytes. */
  positions: SharedArrayBuffer;
  /** 5-slot metadata buffer; use Int32Array and Float32Array views simultaneously. */
  meta: SharedArrayBuffer;
  /** Node IDs matching the positions order.  Owned copy, not transferred. */
  nodeIds: Int32Array;
}

// ============================================================
// Main → Worker
// ============================================================

/** Compact node descriptor (no rendering data needed by the physics engine) */
export interface PhysicsNode {
  id: number;
  x?: number;
  y?: number;
}

/** Full graph init — sent once (or on full reload). */
export interface PhysicsInitMessage {
  type: 'init';
  nodes: PhysicsNode[];
  edges: SGEEdge[];
  config?: SGEUserConfig;
}

/**
 * Full topology replacement without re-creating the worker.
 * Useful for hard graph switches (e.g., workspace change).
 * Positions of surviving nodes are preserved.
 */
export interface PhysicsSetTopologyMessage {
  type: 'setTopology';
  nodes: PhysicsNode[];
  edges: SGEEdge[];
}

/** Incremental: add a single node (placed near its connected neighbors). */
export interface PhysicsAddNodeMessage {
  type: 'addNode';
  node: PhysicsNode;
  /** IDs of already-existing neighbors used to seed placement. */
  connectedToIds?: number[];
}

/** Incremental: remove a single node and all its edges. */
export interface PhysicsRemoveNodeMessage {
  type: 'removeNode';
  nodeId: number;
}

/** Incremental: add a single edge. Both endpoints must already exist. */
export interface PhysicsAddEdgeMessage {
  type: 'addEdge';
  edge: SGEEdge;
}

/** Incremental: remove a single edge. */
export interface PhysicsRemoveEdgeMessage {
  type: 'removeEdge';
  source: number;
  target: number;
}

/** User picks up a node — pin it so physics doesn't pull it away. */
export interface PhysicsDragStartMessage {
  type: 'dragStart';
  nodeId: number;
}

/**
 * User moves a dragged node — update its pinned world-space position.
 * Sent every pointermove event while a drag is active.
 */
export interface PhysicsDragMoveMessage {
  type: 'dragMove';
  nodeId: number;
  x: number;
  y: number;
}

/** User releases a node — unpin it and reheat the simulation. */
export interface PhysicsDragEndMessage {
  type: 'dragEnd';
  nodeId: number;
}

/** Permanently pin a node (user toggle). */
export interface PhysicsPinNodeMessage {
  type: 'pinNode';
  nodeId: number;
}

/** Permanently unpin a node (user toggle). */
export interface PhysicsUnpinNodeMessage {
  type: 'unpinNode';
  nodeId: number;
}

/** Live-update one or more SGE config values without recreating the engine. */
export interface PhysicsSetConfigMessage {
  type: 'setConfig';
  config: SGEUserConfig;
}

/** Restart the cooling schedule (e.g., window resize, view switch). */
export interface PhysicsReheatMessage {
  type: 'reheat';
}

/** Pause the physics tick loop without destroying the engine state. */
export interface PhysicsPauseMessage {
  type: 'pause';
}

/** Resume the physics tick loop (alias for reheat + restart). */
export interface PhysicsResumeMessage {
  type: 'resume';
}

/** Shut down the simulation and free resources. */
export interface PhysicsDestroyMessage {
  type: 'destroy';
}

export type MainToPhysicsMessage =
  | PhysicsInitMessage
  | PhysicsSetTopologyMessage
  | PhysicsAddNodeMessage
  | PhysicsRemoveNodeMessage
  | PhysicsAddEdgeMessage
  | PhysicsRemoveEdgeMessage
  | PhysicsDragStartMessage
  | PhysicsDragMoveMessage
  | PhysicsDragEndMessage
  | PhysicsPinNodeMessage
  | PhysicsUnpinNodeMessage
  | PhysicsSetConfigMessage
  | PhysicsReheatMessage
  | PhysicsPauseMessage
  | PhysicsResumeMessage
  | PhysicsDestroyMessage;

// ============================================================
// Worker → Main
// ============================================================

/** Emitted once after the engine is created and the first tick has run. */
export interface PhysicsReadyMessage {
  type: 'ready';
  nodeCount: number;
}

/**
 * Emitted every physics tick while the simulation is running.
 *
 * Buffer layout (Float32Array, transferred ownership):
 *   [x0, y0,  x1, y1,  x2, y2, …]   (2 floats per node, ordered by init/setTopology order)
 *
 * Energy lets the main thread show activity status.
 */
export interface PhysicsFrameMessage {
  type: 'frame';
  /**
   * Transferable position buffer.  Length = nodeCount * 2.
   * Order matches the nodeIds array sent in the last init/setTopology.
   */
  positions: Float32Array;
  /** Node IDs in the same order as the positions buffer. */
  nodeIds: Int32Array;
  nodeCount: number;
  energy: number;
  ticks: number;
}

export type PhysicsToMainMessage = PhysicsReadyMessage | PhysicsFrameMessage | PhysicsSharedBufferMessage;
