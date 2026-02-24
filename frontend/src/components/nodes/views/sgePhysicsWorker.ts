/**
 * SGE Physics Worker
 *
 * Runs the SemanticGraphEngine simulation in a dedicated Web Worker so the
 * heavy n-body + cluster-cohesion + spring force calculations never block
 * the main thread render pipeline.
 *
 * Physics loop strategy
 * ─────────────────────
 * • Uses setInterval(tick, TICK_MS) as the driving clock (requestAnimationFrame
 *   is not available in all worker environments and ties physics to display
 *   frame-rate, which we explicitly want to decouple).
 * • After each tick, current positions are packed into a Float32Array and
 *   transferred (zero-copy) to the main thread via postMessage transferable.
 * • The main thread decides when to apply those positions to GPU buffers —
 *   it can render at 60fps even if physics ticks are slower (or faster).
 *
 * GC optimisation
 * ───────────────
 * • Double-buffered position arrays: worker alternates between bufA / bufB.
 *   When buf is transferred (ownership moves to main thread), worker switches
 *   to the other pre-allocated buffer.  This eliminates per-frame allocation.
 * • nodeIds Int32Array is sent once at init/topology change, not every frame.
 */

import { SemanticGraphEngine } from './SemanticGraphEngine';
import type { SGEEdge } from './SemanticGraphEngine';
import type {
  MainToPhysicsMessage,
  PhysicsFrameMessage,
  PhysicsReadyMessage,
} from './sgePhysicsWorkerProtocol';

// Typed alias for the worker's postMessage that supports the transferable overload.
const workerPost = (
  msg: PhysicsFrameMessage | PhysicsReadyMessage,
  transfer?: Transferable[],
) => (self as unknown as Worker).postMessage(msg, transfer as StructuredSerializeOptions);

// ============================================================
// Constants
// ============================================================

/** Target physics update interval in ms.  ~60 Hz. */
const TICK_MS = 16;

/**
 * If alpha has cooled below this threshold AND kinetic energy is tiny,
 * the worker pauses the interval and waits for a reheat signal.
 */
const SLEEP_ALPHA = 0.002;
const SLEEP_ENERGY = 0.0005;

// ============================================================
// Worker State
// ============================================================

let engine: SemanticGraphEngine | null = null;

/** Node IDs in the same order as the engine's internal node array. */
let nodeIds: Int32Array = new Int32Array(0);

/** True once the engine is initialised. */
let ready = false;

/** Interval handle for the physics tick loop. */
let tickInterval: ReturnType<typeof setInterval> | undefined = undefined;

/** Double buffer: we alternate which buffer is "live" each frame.
 *  When a buffer is transferred its byteLength drops to 0; we detect that
 *  and use the other buffer next frame.                                  */
let bufA = new Float32Array(0);
let bufB = new Float32Array(0);
let useA = true;

// ============================================================
// Helpers
// ============================================================

function ensureBuffers(n: number): void {
  const needed = n * 2;
  if (bufA.length < needed) bufA = new Float32Array(Math.max(needed, 16));
  if (bufB.length < needed) bufB = new Float32Array(Math.max(needed, 16));
}

/** Post a frame message with the current node positions. */
function postFrame(): void {
  if (!engine) return;
  const state = engine.getState();
  const nodes = state.nodes;
  const n = nodes.length;

  if (n === 0) return;

  ensureBuffers(n);

  // Pick the active buffer; if it was transferred (byteLength = 0), use the other.
  let buf: Float32Array;
  if (useA) {
    buf = bufA.byteLength > 0 ? bufA : (useA = false, bufB);
  } else {
    buf = bufB.byteLength > 0 ? bufB : (useA = true, bufA);
  }

  // Pack positions
  for (let i = 0; i < n; i++) {
    buf[i * 2]     = nodes[i].x;
    buf[i * 2 + 1] = nodes[i].y;
  }

  // Slice only the used portion so transfer is minimal
  const slice = buf.slice(0, n * 2);

  // Alternate for next frame
  useA = !useA;

  const msg: PhysicsFrameMessage = {
    type: 'frame',
    positions: slice,
    nodeIds,          // shared reference — not transferred; re-sent on topology change
    nodeCount: n,
    alpha: state.alpha,
    energy: state.energy,
    ticks: state.ticks,
  };

  // Transfer the positions buffer (zero-copy)
  workerPost(msg, [slice.buffer]);
}

/** Build the nodeIds Int32Array from the engine's current node list. */
function rebuildNodeIds(): void {
  if (!engine) { nodeIds = new Int32Array(0); return; }
  const nodes = engine.getState().nodes;
  nodeIds = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    nodeIds[i] = nodes[i].id;
  }
}

// ============================================================
// Tick loop
// ============================================================

function startLoop(): void {
  if (tickInterval !== undefined) return;
  tickInterval = setInterval(tick, TICK_MS);
}

function stopLoop(): void {
  if (tickInterval !== undefined) {
    clearInterval(tickInterval);
    tickInterval = undefined;
  }
}

function tick(): void {
  if (!engine) return;

  engine.step();

  const state = engine.getState();

  // Auto-sleep when converged
  if (state.alpha < SLEEP_ALPHA && state.energy < SLEEP_ENERGY) {
    // Post one final frame then pause
    postFrame();
    stopLoop();
    return;
  }

  postFrame();
}

// ============================================================
// Message Handler
// ============================================================

self.onmessage = (e: MessageEvent<MainToPhysicsMessage>): void => {
  const msg = e.data;

  switch (msg.type) {
    // ── Initialisation ──────────────────────────────────────
    case 'init': {
      engine?.dispose();
      stopLoop();

      engine = new SemanticGraphEngine(msg.nodes, msg.edges, msg.config);
      rebuildNodeIds();
      ensureBuffers(msg.nodes.length);

      ready = true;

      const readyMsg: PhysicsReadyMessage = { type: 'ready', nodeCount: msg.nodes.length };
      workerPost(readyMsg);

      startLoop();
      break;
    }

    // ── Full topology swap ───────────────────────────────────
    case 'setTopology': {
      if (!engine) break;
      const prevPositions = new Map<number, { x: number; y: number; vx: number; vy: number }>();
      for (const n of engine.getState().nodes) {
        prevPositions.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
      }

      engine.dispose();
      engine = new SemanticGraphEngine(msg.nodes, msg.edges);

      // Restore positions of surviving nodes
      for (const n of engine.getState().nodes) {
        const prev = prevPositions.get(n.id);
        if (prev) {
          engine.syncPosition(n.id, prev.x, prev.y, prev.vx, prev.vy);
        }
      }

      engine.reheat();
      rebuildNodeIds();
      ensureBuffers(msg.nodes.length);

      if (!ready) {
        const readyMsg: PhysicsReadyMessage = { type: 'ready', nodeCount: msg.nodes.length };
        workerPost(readyMsg);
        ready = true;
      }

      startLoop();
      break;
    }

    // ── Incremental: add node ────────────────────────────────
    case 'addNode': {
      if (!engine) break;
      engine.addNode(msg.node, msg.connectedToIds);
      rebuildNodeIds();
      ensureBuffers(engine.nodeCount);
      startLoop();
      break;
    }

    // ── Incremental: remove node ─────────────────────────────
    case 'removeNode': {
      if (!engine) break;
      engine.removeNode(msg.nodeId);
      rebuildNodeIds();
      break;
    }

    // ── Incremental: add edge ────────────────────────────────
    case 'addEdge': {
      if (!engine) break;
      engine.addEdge(msg.edge);
      startLoop();
      break;
    }

    // ── Incremental: remove edge ─────────────────────────────
    case 'removeEdge': {
      if (!engine) break;
      // SGE doesn't have a removeEdge; rebuild edges list without it
      const oldEdges = (engine as unknown as { edges: SGEEdge[] }).edges;
      const newEdges = oldEdges.filter(
        (e: SGEEdge) => !(e.source === msg.source && e.target === msg.target) &&
              !(e.source === msg.target && e.target === msg.source),
      );
      engine.setEdges(newEdges);
      startLoop();
      break;
    }

    // ── Drag: pin node ───────────────────────────────────────
    case 'dragStart': {
      if (!engine) break;
      engine.pinNode(msg.nodeId);
      engine.reheat();
      startLoop();
      break;
    }

    // ── Drag: move pinned node ───────────────────────────────
    case 'dragMove': {
      if (!engine) break;
      engine.moveNode(msg.nodeId, msg.x, msg.y);
      // Post a frame immediately so the renderer sees the updated drag position
      postFrame();
      if (tickInterval === undefined) startLoop();
      break;
    }

    // ── Drag: release ────────────────────────────────────────
    case 'dragEnd': {
      if (!engine) break;
      engine.unpinNode(msg.nodeId);
      startLoop();
      break;
    }

    // ── Static pin ───────────────────────────────────────────
    case 'pinNode': {
      engine?.pinNode(msg.nodeId);
      break;
    }

    // ── Static unpin ─────────────────────────────────────────
    case 'unpinNode': {
      if (!engine) break;
      engine.unpinNode(msg.nodeId);
      startLoop();
      break;
    }

    // ── Live config update ───────────────────────────────────
    case 'setConfig': {
      if (!engine) break;
      engine.setConfig(msg.config);
      engine.reheat();
      startLoop();
      break;
    }

    // ── Reheat ───────────────────────────────────────────────
    case 'reheat': {
      if (!engine) break;
      engine.reheat();
      startLoop();
      break;
    }

    // ── Pause physics ─────────────────────────────────────────
    case 'pause': {
      stopLoop();
      break;
    }

    // ── Resume physics ────────────────────────────────────────
    case 'resume': {
      if (!engine) break;
      engine.reheat();
      startLoop();
      break;
    }

    // ── Destroy ──────────────────────────────────────────────
    case 'destroy': {
      stopLoop();
      engine?.dispose();
      engine = null;
      ready = false;
      break;
    }
  }
};
