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
  PhysicsSharedBufferMessage,
  PhysicsTerrainDataMessage,
} from './graphPhysicsWorkerProtocol';
import { META_SEQ, META_COUNT, META_TICKS, META_ALPHA, META_ENERGY } from './graphPhysicsWorkerProtocol';

// Typed alias for the worker's postMessage that supports the transferable overload.
const workerPost = (
  msg: PhysicsFrameMessage | PhysicsReadyMessage | PhysicsSharedBufferMessage,
  transfer?: Transferable[],
) => (self as unknown as Worker).postMessage(msg, transfer as StructuredSerializeOptions);

// ============================================================
// Constants
// ============================================================

/** Target physics update interval in ms.  ~60 Hz. */
const TICK_MS = 16;

/** Maximum time budget per tick in ms.  If a step overruns, subsequent ticks
 *  are scheduled immediately but never stacked. */
const MAX_TICK_BUDGET_MS = 50;

/**
 * Warm-up convergence target.  Run physics steps synchronously until alpha
 * drops below this value so the layout is visually stable on the first frame.
 * alpha 0.1 ≈ 1150 steps at default decay (0.002) — well past the major
 * re-arrangement phase.  A hard time-budget cap prevents blocking the worker
 * for too long on very large graphs.
 */
const WARMUP_ALPHA_TARGET = 0.005;
/** Maximum wall-clock milliseconds to spend on warm-up. */
const WARMUP_TIME_BUDGET_MS = 3000;



// ============================================================
// Worker State
// ============================================================

let engine: SemanticGraphEngine | null = null;

/** Node IDs in the same order as the engine's internal node array. */
let nodeIds: Int32Array = new Int32Array(0);

/** True once the engine is initialised. */
let ready = false;

/** Timeout handle for the physics tick loop. */
let tickTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

// ============================================================
// Terrain mode state
// ============================================================

/**
 * When true, the tick loop splits engine.step() into
 * computeForces() → applyTerrainForces() → integrate().
 */
let isTerrainMode = false;

/** Per-node height lookup (double-log-compressed) keyed by node ID. */
const terrainHeightMap = new Map<number, number>();
/** Per-node peak-radius fraction [0..1] keyed by node ID. */
const terrainPeakMap   = new Map<number, number>();

/** Ref-link arrays (source, target, type) for minimum-separation forces. */
let refLinkSrcs:  Int32Array = new Int32Array(0);
let refLinkTgts:  Int32Array = new Int32Array(0);
let refLinkTypes: Uint8Array  = new Uint8Array(0);
let refLinkCount  = 0;

/**
 * Mirrors the pinned/dragged state of the engine so that terrain forces
 * can skip immovable nodes without querying engine internals.
 */
const pinnedWorkerSet = new Set<number>();

/**
 * Cached nodeId→slot mapping for the engine's internal typed arrays.
 * Rebuilt whenever topology changes (set dirty by idToSlotDirty flag).
 * Used to look up positions by node ID in reference-link force phase.
 */
const idToSlotCache = new Map<number, number>();
let   idToSlotDirty = true;

// Terrain physics constants — must match viewTypes.ts
const T_BASE_FP = 60;    // TERRAIN_BASE_FOOTPRINT
const T_PEAK_FP = 120;   // TERRAIN_PEAK_FOOTPRINT
const T_SEP_STR = 0.15;  // TERRAIN_SEPARATION_STRENGTH
const T_REF_SEP = 240;   // TERRAIN_REF_LINK_MIN_SEPARATION
const T_REF_STR = 0.06;  // TERRAIN_REF_LINK_SEPARATION_STRENGTH

// ============================================================
// SharedArrayBuffer path (active when crossOriginIsolated)
// ============================================================

/**
 * When cross-origin isolation is enabled the worker writes positions directly
 * into a SharedArrayBuffer that the main thread reads in its RAF loop via
 * Atomics.load.  No per-frame postMessage or structured-clone overhead.
 */
const SAB_ENABLED = typeof SharedArrayBuffer !== 'undefined' &&
  (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false);

let sPosF32:  Float32Array | null  = null;  // view of posSAB
let sMetaI32: Int32Array  | null  = null;  // view of metaSAB (int fields)
let sMetaF32: Float32Array | null  = null;  // view of metaSAB (float fields)
let posSAB:   SharedArrayBuffer | null = null;
let metaSAB:  SharedArrayBuffer | null = null;

/** (Re)allocate SABs when node count changes.  Sends sharedBuffer message when done. */
function ensureSABs(n: number): void {
  if (!SAB_ENABLED) return;
  const neededBytes = n * 2 * 4;
  if (!posSAB || posSAB.byteLength < neededBytes) {
    posSAB  = new SharedArrayBuffer(neededBytes);
    metaSAB = new SharedArrayBuffer(5 * 4);
    sPosF32  = new Float32Array(posSAB);
    sMetaI32 = new Int32Array(metaSAB);
    sMetaF32 = new Float32Array(metaSAB);
    Atomics.store(sMetaI32, META_SEQ, 0);
  }
}

/** Write current positions + meta into the SABs and signal the main thread. */
function writeSABFrame(): void {
  if (!sPosF32 || !sMetaI32 || !sMetaF32 || !engine) return;
  const state = engine.getState();
  const n     = state.nodeCount;
  const posX  = state.posX, posY = state.posY;
  for (let i = 0; i < n; i++) {
    sPosF32[i * 2]     = posX[i];
    sPosF32[i * 2 + 1] = posY[i];
  }
  sMetaF32[META_ALPHA]  = state.alpha;
  sMetaF32[META_ENERGY] = state.energy;
  Atomics.store(sMetaI32, META_COUNT, n);
  Atomics.store(sMetaI32, META_TICKS, state.ticks);
  // Increment seq last — main thread uses this as the "data ready" signal.
  Atomics.add(sMetaI32, META_SEQ, 1);
}

/** Send SharedArrayBuffer references to the main thread (once per topology change). */
function postSharedBufferRefs(): void {
  if (!SAB_ENABLED || !posSAB || !metaSAB) return;
  const msg: PhysicsSharedBufferMessage = {
    type: 'sharedBuffer',
    positions: posSAB,
    meta:      metaSAB,
    nodeIds,   // regular clone — only sent on topology change
  };
  workerPost(msg); // SABs clone by reference (spec); no transfer list needed
}

// ============================================================
// Transferable triple-buffer fallback (no crossOriginIsolated)
// ============================================================

/**
 * Triple buffer: we cycle through 3 buffers so that:
 *   - One was just transferred (ownership with main thread, byteLength=0)
 *   - One may still be in the message queue
 *   - One is always available to write to
 * Buffers are allocated to the EXACT size needed (n*2 floats) so they can
 * be transferred directly without .slice() — zero per-frame allocation.
 */
let bufs: Float32Array[] = [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
let bufIdx = 0;
let allocatedSize = 0;

// ============================================================
// Helpers
// ============================================================

function ensureBuffers(n: number): void {
  // SAB path: handled by ensureSABs.
  if (SAB_ENABLED) { ensureSABs(n); return; }
  // Fallback: transferable triple-buffer.
  const needed = n * 2;
  if (needed !== allocatedSize) {
    for (let i = 0; i < bufs.length; i++) {
      bufs[i] = new Float32Array(needed);
    }
    allocatedSize = needed;
  }
}

/** Post a frame message with the current node positions (transferable fallback). */
function postFrame(): void {
  if (!engine) return;
  if (SAB_ENABLED) { writeSABFrame(); return; }
  const state = engine.getState();
  const n = state.nodeCount;

  if (n === 0) return;

  // Find a buffer that hasn't been transferred (byteLength > 0)
  let buf: Float32Array | null = null;
  for (let attempts = 0; attempts < bufs.length; attempts++) {
    const idx = bufIdx % bufs.length;
    bufIdx++;
    if (bufs[idx].byteLength > 0) {
      buf = bufs[idx];
      break;
    }
  }

  // Fallback: all 3 buffers transferred (very fast ticks, slow main thread)
  if (!buf) {
    buf = new Float32Array(n * 2);
    bufs[bufIdx % bufs.length] = buf;
    bufIdx++;
  }

  // Pack positions from SoA typed arrays
  const posX = state.posX, posY = state.posY;
  for (let i = 0; i < n; i++) {
    buf[i * 2]     = posX[i];
    buf[i * 2 + 1] = posY[i];
  }

  const msg: PhysicsFrameMessage = {
    type: 'frame',
    positions: buf,
    nodeIds,          // shared reference — not transferred; re-sent on topology change
    nodeCount: n,
    alpha: state.alpha,
    energy: state.energy,
    ticks: state.ticks,
  };

  // Transfer the positions buffer (zero-copy to main thread)
  workerPost(msg, [buf.buffer]);
}

// ============================================================
// Terrain force injection
// ============================================================

/**
 * Apply terrain-specific forces AFTER computeForces() and BEFORE integrate().
 *
 * Two phases:
 *  1. Cone-collision avoidance — shorter nodes are pushed away from taller
 *     nodes' cone footprints, proportional to height difference.
 *  2. Reference-link minimum separation — reference/property-reference linked
 *     node pairs are gently pushed apart when too close.
 */
function applyTerrainForces(): void {
  if (!engine || terrainHeightMap.size === 0) return;
  const state = engine.getState();
  const { posX, posY, nodeIdArr, nodeCount, alpha } = state;

  // --- Phase 1: Cone-based collision avoidance  O(n²) ---
  for (let i = 0; i < nodeCount; i++) {
    const idI = nodeIdArr[i];
    if (pinnedWorkerSet.has(idI)) continue;
    const shortH    = terrainHeightMap.get(idI) ?? 0;
    const shortPeak = terrainPeakMap.get(idI) ?? 0;
    const shortRp   = T_BASE_FP * 0.25 + T_PEAK_FP * 0.25 * shortPeak;
    const xi = posX[i], yi = posY[i];
    for (let j = 0; j < nodeCount; j++) {
      if (i === j) continue;
      const idJ   = nodeIdArr[j];
      const tallH = terrainHeightMap.get(idJ) ?? 0;
      if (tallH <= shortH) continue; // only repel from taller peaks
      const tallPeak = terrainPeakMap.get(idJ) ?? 0;
      const tallRp   = T_BASE_FP * 0.25 + T_PEAK_FP * 0.25 * tallPeak;
      const tallRs   = T_BASE_FP         + T_PEAK_FP           * tallPeak;
      const hRatio   = (tallH - shortH) / tallH;
      const coneR    = tallRp + (tallRs - tallRp) * hRatio;
      const dx = xi - posX[j], dy = yi - posY[j];
      const dist     = Math.sqrt(dx * dx + dy * dy) || 1;
      const effR     = coneR - shortRp * 0.5;
      if (dist >= effR) continue;
      const overlap = effR - dist;
      const force   = overlap * T_SEP_STR * alpha;
      engine.applyForce(idI, (dx / dist) * force, (dy / dist) * force);
    }
  }

  // --- Phase 2: Reference-link minimum separation  O(links) ---
  if (refLinkCount === 0) return;

  // Build / refresh nodeId→slot cache (topology-stable; only dirty on change).
  if (idToSlotDirty) {
    idToSlotCache.clear();
    for (let i = 0; i < nodeCount; i++) idToSlotCache.set(nodeIdArr[i], i);
    idToSlotDirty = false;
  }

  for (let e = 0; e < refLinkCount; e++) {
    const srcId = refLinkSrcs[e], tgtId = refLinkTgts[e];
    const iA = idToSlotCache.get(srcId), iB = idToSlotCache.get(tgtId);
    if (iA === undefined || iB === undefined) continue;
    const pinnedA = pinnedWorkerSet.has(srcId);
    const pinnedB = pinnedWorkerSet.has(tgtId);
    if (pinnedA && pinnedB) continue;
    const dx = posX[iB] - posX[iA];
    const dy = posY[iB] - posY[iA];
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const peakA   = terrainPeakMap.get(srcId) ?? 0;
    const peakB   = terrainPeakMap.get(tgtId) ?? 0;
    const avgPeak = (peakA + peakB) * 0.5;
    const minSep  = T_REF_SEP + avgPeak * 60;
    if (dist >= minSep) continue;
    const overlap = minSep - dist;
    const force   = overlap * T_REF_STR * alpha;
    const nx = dx / dist, ny = dy / dist;
    if (!pinnedA) engine.applyForce(srcId, -nx * force, -ny * force);
    if (!pinnedB) engine.applyForce(tgtId,  nx * force,  ny * force);
  }
}

/** Build the nodeIds Int32Array from the engine's current state. */
function rebuildNodeIds(): void {
  if (!engine) { nodeIds = new Int32Array(0); return; }
  const state = engine.getState();
  // Copy the subarray view (can't transfer a view; need an owned copy)
  nodeIds = new Int32Array(state.nodeIdArr);
}

// ============================================================
// Tick loop
// ============================================================

function startLoop(): void {
  if (tickTimeout !== undefined) return;
  // Reset accumulator so we don't run many catch-up steps after a pause
  accumulator  = 0;
  lastTickTime = 0;
  scheduleTick();
}

function stopLoop(): void {
  if (tickTimeout !== undefined) {
    clearTimeout(tickTimeout);
    tickTimeout = undefined;
  }
}

function scheduleTick(): void {
  tickTimeout = setTimeout(tick, TICK_MS);
}

// Fixed-timestep accumulator — decouples wall-clock variability from simulation dt.
// Each real-time millisecond maps to one physics step.  We cap substeps at 4 to
// prevent a spiral-of-death when the host is heavily loaded.
const FIXED_DT_MS  = TICK_MS;   // one physics step per 16ms
const MAX_SUBSTEPS = 4;
let   accumulator  = 0;
let   lastTickTime = 0;

function tick(): void {
  tickTimeout = undefined;
  if (!engine) return;

  const now     = performance.now();
  const frameMs = lastTickTime > 0 ? Math.min(now - lastTickTime, TICK_MS * 4) : TICK_MS;
  lastTickTime  = now;
  accumulator  += frameMs;

  const t0 = now;
  let   substeps = 0;
  while (accumulator >= FIXED_DT_MS && substeps < MAX_SUBSTEPS) {
    if (isTerrainMode) {
      // Split step so we can inject terrain forces between computeForces and integrate.
      engine.computeForces();
      applyTerrainForces();
      engine.integrate();
    } else {
      engine.step();
    }
    accumulator -= FIXED_DT_MS;
    substeps++;
  }
  // Drain leftover accumulator if we hit the substep cap (avoid runaway growth)
  if (accumulator >= FIXED_DT_MS * MAX_SUBSTEPS) accumulator = 0;

  const elapsed = performance.now() - t0;
  if (elapsed > 50) {
    console.warn(`[SGE] ${substeps} step(s) took ${elapsed.toFixed(0)}ms (${engine.nodeCount} nodes)`);
  }

  postFrame();

  // Schedule next tick: if step was slow, fire immediately (0ms) to maximise
  // throughput; otherwise honour the target interval.
  const delay = elapsed > MAX_TICK_BUDGET_MS ? 0 : Math.max(0, TICK_MS - elapsed);
  tickTimeout = setTimeout(tick, delay);
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

      // ── Warm-up: run physics synchronously until the layout stabilises so
      //    nodes are well-separated before the first frame.  This ensures all
      //    edges are long enough to be visible immediately.
      {
        const t0 = performance.now();
        while (engine.getState().alpha > WARMUP_ALPHA_TARGET) {
          engine.step();
          // Bail out if we've spent too long (large graphs)
          if (performance.now() - t0 > WARMUP_TIME_BUDGET_MS) break;
        }
      }

      rebuildNodeIds();
      ensureBuffers(msg.nodes.length);
      if (SAB_ENABLED) postSharedBufferRefs();

      ready = true;

      const readyMsg: PhysicsReadyMessage = { type: 'ready', nodeCount: msg.nodes.length };
      workerPost(readyMsg);

      startLoop();
      break;
    }

    // ── Full topology swap ───────────────────────────────────
    case 'setTopology': {
      pinnedWorkerSet.clear();
      idToSlotDirty = true;
      if (!engine) break;
      // Snapshot positions from typed SoA arrays
      const prevPositions = new Map<number, { x: number; y: number; vx: number; vy: number }>();
      {
        const oldState = engine.getState();
        const { posX, posY, velX, velY, nodeIdArr, nodeCount } = oldState;
        for (let i = 0; i < nodeCount; i++) {
          prevPositions.set(nodeIdArr[i], { x: posX[i], y: posY[i], vx: velX[i], vy: velY[i] });
        }
      }

      engine.dispose();
      engine = new SemanticGraphEngine(msg.nodes, msg.edges);

      // Restore positions of surviving nodes
      {
        const newState = engine.getState();
        const { nodeIdArr, nodeCount } = newState;
        for (let i = 0; i < nodeCount; i++) {
          const prev = prevPositions.get(nodeIdArr[i]);
          if (prev) engine.syncPosition(nodeIdArr[i], prev.x, prev.y, prev.vx, prev.vy);
        }
      }

      engine.reheat();
      rebuildNodeIds();
      ensureBuffers(msg.nodes.length);
      if (SAB_ENABLED) postSharedBufferRefs();

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
      idToSlotDirty = true;
      if (SAB_ENABLED) postSharedBufferRefs();
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
      pinnedWorkerSet.add(msg.nodeId);
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
      if (tickTimeout === undefined) startLoop();
      break;
    }

    // ── Drag: release ────────────────────────────────────────
    case 'dragEnd': {
      if (!engine) break;
      engine.unpinNode(msg.nodeId);
      pinnedWorkerSet.delete(msg.nodeId);
      startLoop();
      break;
    }

    // ── Static pin ───────────────────────────────────────────
    case 'pinNode': {
      engine?.pinNode(msg.nodeId);
      pinnedWorkerSet.add(msg.nodeId);
      break;
    }

    // ── Static unpin ─────────────────────────────────────────
    case 'unpinNode': {
      if (!engine) break;
      engine.unpinNode(msg.nodeId);
      pinnedWorkerSet.delete(msg.nodeId);
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
      isTerrainMode = false;
      pinnedWorkerSet.clear();
      terrainHeightMap.clear();
      terrainPeakMap.clear();
      refLinkCount = 0;
      idToSlotDirty = true;
      break;
    }

    // ── Enable/disable terrain mode ───────────────────────────
    case 'setTerrainMode': {
      isTerrainMode = msg.enabled;
      break;
    }

    // ── Update per-node terrain data ──────────────────────────
    case 'terrainData': {
      const d = msg as PhysicsTerrainDataMessage;
      terrainHeightMap.clear();
      terrainPeakMap.clear();
      for (let i = 0; i < d.nodeIds.length; i++) {
        terrainHeightMap.set(d.nodeIds[i], d.heights[i]);
        terrainPeakMap.set(d.nodeIds[i], d.peakRadii[i]);
      }
      refLinkSrcs  = d.refLinkSources;
      refLinkTgts  = d.refLinkTargets;
      refLinkTypes = d.refLinkTypes;
      refLinkCount = d.refLinkSources.length;
      idToSlotDirty = true; // position cache may have shifted
      break;
    }
  }
};
