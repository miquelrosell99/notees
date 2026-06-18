/**
 * SGE v2 Physics Worker
 *
 * Thin wrapper around SGEEngine that runs physics off the main thread.
 * Communicates with the main thread via postMessage.
 *
 * Protocol
 * ────────
 * Main → Worker:
 *   { type: 'init', nodes, edges, config }
 *   { type: 'setTopology', nodes, edges }
 *   { type: 'setConfig', config }
 *   { type: 'dragStart', nodeId }
 *   { type: 'dragMove', nodeId, x, y }
 *   { type: 'dragEnd', nodeId }
 *   { type: 'pin', nodeId }
 *   { type: 'unpin', nodeId }
 *   { type: 'destroy' }
 *
 * Worker → Main:
 *   { type: 'ready' }
 *   { type: 'frame', positions, nodeIds, nodeCount, energy, ticks }
 *   { type: 'sharedBuffer', positions: SharedArrayBuffer, meta: SharedArrayBuffer, nodeIds }
 */

import { SGEEngine, buildSGEConfig } from './sge';
import type { SGEPhysicsConfig, SGENode, SGEEdge } from './sge';

// ─── Constants ────────────────────────────────────────────────────────────────

const TICK_MS = 16;

const WARMUP_TICKS = 50;
const WARMUP_DT_MULT = 2.0;

const META_SEQ = 0;
const META_COUNT = 1;
const META_TICKS = 2;

// ─── State ────────────────────────────────────────────────────────────────────

let engine: SGEEngine | null = null;
let tickTimeout: ReturnType<typeof setTimeout> | undefined;
let running = false;
let nodeIds: Int32Array = new Int32Array(0);
let dragWasPinned = false;

// SharedArrayBuffer path
const SAB_ENABLED = typeof SharedArrayBuffer !== 'undefined' &&
  (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false);

let sPosF32: Float32Array | null = null;
let sMetaI32: Int32Array | null = null;
let posSAB: SharedArrayBuffer | null = null;
let metaSAB: SharedArrayBuffer | null = null;

// Fallback triple-buffer: 3 buffers so one is always writable
// even if the main thread is slow to process frames.
const bufs: Float32Array[] = [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
let bufIdx = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureSABs(n: number): void {
  if (!SAB_ENABLED) return;
  const neededBytes = n * 2 * 4;
  if (!posSAB || posSAB.byteLength < neededBytes) {
    posSAB  = new SharedArrayBuffer(neededBytes);
    metaSAB = new SharedArrayBuffer(5 * 4);
    sPosF32  = new Float32Array(posSAB);
    sMetaI32 = new Int32Array(metaSAB);
    Atomics.store(sMetaI32, META_SEQ, 0);
  }
}

function ensureFallbackBuffers(n: number): void {
  if (SAB_ENABLED) return;
  const needed = n * 2;
  if (bufs[0].length !== needed) {
    bufs[0] = new Float32Array(needed);
    bufs[1] = new Float32Array(needed);
    bufs[2] = new Float32Array(needed);
  }
}

function writeFrame(): void {
  if (!engine) return;
  const state = engine.getState();
  const n = state.nodeCount;
  if (n === 0) return;

  if (SAB_ENABLED && sPosF32 && sMetaI32) {
    const posX = state.posX, posY = state.posY;
    for (let i = 0; i < n; i++) {
      sPosF32[i * 2]     = posX[i];
      sPosF32[i * 2 + 1] = posY[i];
    }
    sMetaI32[META_COUNT] = n;
    sMetaI32[META_TICKS] = state.ticks;
    (sMetaI32 as unknown as Float32Array)[3] = state.energy;
    Atomics.add(sMetaI32, META_SEQ, 1);
  } else {
    // Find a buffer whose ArrayBuffer hasn't been transferred yet
    let buf: Float32Array | null = null;
    for (let attempts = 0; attempts < bufs.length; attempts++) {
      const idx = bufIdx % bufs.length;
      bufIdx++;
      if (bufs[idx].byteLength > 0) {
        buf = bufs[idx];
        break;
      }
    }
    // Fallback: all buffers in flight — allocate a fresh one
    if (!buf) {
      buf = new Float32Array(n * 2);
      bufs[bufIdx % bufs.length] = buf;
      bufIdx++;
    }
    const posX = state.posX, posY = state.posY;
    for (let i = 0; i < n; i++) {
      buf[i * 2]     = posX[i];
      buf[i * 2 + 1] = posY[i];
    }
    const msg = {
      type: 'frame' as const,
      positions: buf,
      nodeIds,
      nodeCount: n,
      energy: state.energy,
      ticks: state.ticks,
    };
    (self as unknown as Worker).postMessage(msg, [buf.buffer]);
  }
}

function postSharedBufferRefs(): void {
  if (!SAB_ENABLED || !posSAB || !metaSAB) return;
  self.postMessage({
    type: 'sharedBuffer' as const,
    positions: posSAB,
    meta: metaSAB,
    nodeIds,
  });
}

function doTick(): void {
  if (!engine || !running) return;
  const t0 = performance.now();
  engine.step();
  writeFrame();
  const elapsed = performance.now() - t0;
  const delay = Math.max(0, TICK_MS - elapsed);
  tickTimeout = setTimeout(doTick, delay);
}

function fastForward(ticks: number, dtMult: number): void {
  if (!engine) return;
  const origDt = engine.config.dt;
  engine.config.dt *= dtMult;
  for (let i = 0; i < ticks; i++) engine.step();
  engine.config.dt = origDt;
}

function initEngine(nodes: SGENode[], edges: SGEEdge[], cfg: SGEPhysicsConfig): void {
  const config = buildSGEConfig(cfg);
  engine = new SGEEngine(nodes, edges, config);
  nodeIds = new Int32Array(nodes.map(n => n.id));
  ensureSABs(nodes.length);
  ensureFallbackBuffers(nodes.length);
  running = true;

  // Fast-forward warm-up instead of synchronous burst
  fastForward(WARMUP_TICKS, WARMUP_DT_MULT);

  if (SAB_ENABLED) postSharedBufferRefs();
  self.postMessage({ type: 'ready' as const });
  doTick();
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'init': {
      if (tickTimeout) clearTimeout(tickTimeout);
      running = false;
      if (engine) {
        // Engine already exists — treat as topology update to preserve warm state
        engine.setTopology(msg.nodes, msg.edges);
        engine.setConfig(buildSGEConfig(msg.config));
        nodeIds = new Int32Array(msg.nodes.map((n: SGENode) => n.id));
        ensureSABs(nodeIds.length);
        ensureFallbackBuffers(nodeIds.length);
        if (SAB_ENABLED) postSharedBufferRefs();
        running = true;
        doTick();
      } else {
        initEngine(msg.nodes, msg.edges, msg.config);
      }
      break;
    }
    case 'setTopology': {
      if (!engine) break;
      engine.setTopology(msg.nodes, msg.edges);
      nodeIds = new Int32Array(msg.nodes.map((n: SGENode) => n.id));
      ensureSABs(nodeIds.length);
      ensureFallbackBuffers(nodeIds.length);
      if (SAB_ENABLED) postSharedBufferRefs();
      break;
    }
    case 'setConfig': {
      if (!engine) break;
      const config = buildSGEConfig(msg.config);
      engine.setConfig(config);
      break;
    }
    case 'dragStart': {
      if (!engine) break;
      dragWasPinned = engine.isPinned(msg.nodeId);
      engine.pinNode(msg.nodeId);
      break;
    }
    case 'dragMove': {
      if (!engine) break;
      engine.moveNode(msg.nodeId, msg.x, msg.y);
      break;
    }
    case 'dragEnd': {
      if (!engine) break;
      // Only unpin nodes that were not already pinned by the user.
      if (!dragWasPinned) {
        engine.unpinNode(msg.nodeId);
      }
      dragWasPinned = false;
      break;
    }
    case 'pin': {
      if (!engine) break;
      engine.pinNode(msg.nodeId);
      break;
    }
    case 'unpin': {
      if (!engine) break;
      engine.unpinNode(msg.nodeId);
      break;
    }
    case 'pause': {
      running = false;
      if (tickTimeout) clearTimeout(tickTimeout);
      break;
    }
    case 'resume': {
      if (!running && engine) {
        running = true;
        doTick();
      }
      break;
    }
    case 'destroy': {
      running = false;
      if (tickTimeout) clearTimeout(tickTimeout);
      engine?.dispose();
      engine = null;
      break;
    }
  }
};
