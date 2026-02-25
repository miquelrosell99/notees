/**
 * terrainPhysicsCore.ts
 *
 * Terrain-mode physics helpers for useNodePhysics:
 *
 *   runTerrainWorkerSync         – syncs drag/pin state with the off-thread physics worker
 *                                  and reads back positions from the SharedArrayBuffer or
 *                                  a transferable frame message (fallback).
 *
 *   computeAndDispatchTerrainData – computes per-node heights and peak radii, then sends
 *                                  the result to the physics worker so it can apply
 *                                  terrain-aware separation forces off-thread.
 *
 * All functions are pure (no React hooks) so they can be called directly from inside
 * the rAF loop without hook-ordering constraints.
 */

import type { MutableRefObject } from 'react';
import type { GraphNode, GraphLink, GraphSettings, FrameData } from './viewTypes';
import {
  TERRAIN_BASE_SLOPE_RADIUS,
  TERRAIN_PEAK_SLOPE_RADIUS_BONUS,
} from './viewTypes';
import type { MainToPhysicsMessage, PhysicsTerrainDataMessage } from './graphPhysicsWorkerProtocol';
import { META_SEQ, META_COUNT, META_ALPHA, META_ENERGY } from './graphPhysicsWorkerProtocol';

// ==================== Types ====================

/** Refs needed to sync interaction state with the terrain physics worker. */
export interface TerrainWorkerSyncRefs {
  terrainWorkerRef:      MutableRefObject<Worker | null>;
  terrainSabPosRef:      MutableRefObject<Float32Array | null>;
  terrainSabMetaI32Ref:  MutableRefObject<Int32Array   | null>;
  terrainSabMetaF32Ref:  MutableRefObject<Float32Array | null>;
  terrainSabNodeIdsRef:  MutableRefObject<Int32Array   | null>;
  terrainSabSeqRef:      MutableRefObject<number>;
  terrainFramePosRef:    MutableRefObject<Float32Array | null>;
  terrainFrameIdsRef:    MutableRefObject<Int32Array   | null>;
  terrainPrevDragIdRef:  MutableRefObject<number | null>;
  terrainPinnedTrackRef: MutableRefObject<Set<number>>;
  dragNodeRef:           MutableRefObject<GraphNode | null>;
  kineticEnergyRef:      MutableRefObject<number>;
  alphaRef:              MutableRefObject<number>;
}

/** Refs needed to compute and dispatch terrain heights / peak-radii. */
export interface TerrainDataRefs {
  frameDataRef:               MutableRefObject<FrameData>;
  terrainDataDirtyRef:        MutableRefObject<boolean>;
  terrainWorkerRef:           MutableRefObject<Worker | null>;
  terrainWorkerReadyRef:      MutableRefObject<boolean>;
  massCacheRef:               MutableRefObject<Map<number, number>>;
  inLinkCountsRef:            MutableRefObject<Map<number, number>>;
  inReferenceLinkCountsRef:   MutableRefObject<Map<number, number>>;
  outReferenceLinkCountsRef:  MutableRefObject<Map<number, number>>;
  allReferenceLinkCountsRef:  MutableRefObject<Map<number, number>>;
}

// ==================== Terrain Worker Sync ====================

/**
 * Relays drag/pin state to the off-thread worker, then reads back node positions
 * from the SharedArrayBuffer (preferred) or a transferable frame message (fallback).
 *
 * This is the entire terrain-mode branch inside simulate() and runs every frame
 * when `usingTerrainWorker` is true.
 */
export function runTerrainWorkerSync(
  refs: TerrainWorkerSyncRefs,
  nodes: GraphNode[],
  nodeMap: Map<number, GraphNode>,
): void {
  const {
    terrainWorkerRef,
    terrainSabPosRef, terrainSabMetaI32Ref, terrainSabMetaF32Ref, terrainSabNodeIdsRef,
    terrainSabSeqRef,
    terrainFramePosRef, terrainFrameIdsRef,
    terrainPrevDragIdRef, terrainPinnedTrackRef,
    dragNodeRef, kineticEnergyRef, alphaRef,
  } = refs;

  const worker = terrainWorkerRef.current!;

  // Detect drag state changes and relay to worker.
  const currentDragId = dragNodeRef.current?.id ?? null;
  const prevDragId    = terrainPrevDragIdRef.current;
  if (currentDragId !== prevDragId) {
    if (prevDragId !== null) {
      worker.postMessage({ type: 'dragEnd', nodeId: prevDragId } satisfies MainToPhysicsMessage);
    }
    if (currentDragId !== null) {
      worker.postMessage({ type: 'dragStart', nodeId: currentDragId } satisfies MainToPhysicsMessage);
    }
    terrainPrevDragIdRef.current = currentDragId;
  }

  // Relay drag position every frame (worker needs up-to-date coordinates).
  if (currentDragId !== null && dragNodeRef.current) {
    worker.postMessage({
      type:   'dragMove',
      nodeId: currentDragId,
      x:      dragNodeRef.current.x,
      y:      dragNodeRef.current.y,
    } satisfies MainToPhysicsMessage);
  }

  // Diff pinned-node set and send delta pin/unpin messages.
  {
    const currentPinSet = new Set<number>();
    for (const node of nodes) { if (node.pinned) currentPinSet.add(node.id); }
    const prev = terrainPinnedTrackRef.current;
    for (const id of currentPinSet) {
      if (!prev.has(id)) {
        worker.postMessage({ type: 'pinNode', nodeId: id } satisfies MainToPhysicsMessage);
      }
    }
    for (const id of prev) {
      if (!currentPinSet.has(id) && id !== currentDragId) {
        worker.postMessage({ type: 'unpinNode', nodeId: id } satisfies MainToPhysicsMessage);
      }
    }
    terrainPinnedTrackRef.current = currentPinSet;
  }

  // Read positions from worker — prefer SAB zero-copy poll.
  const sabMeta  = terrainSabMetaI32Ref.current;
  const sabMetaF = terrainSabMetaF32Ref.current;
  const sabPos   = terrainSabPosRef.current;
  const sabIds   = terrainSabNodeIdsRef.current;
  if (sabMeta && sabPos && sabIds) {
    const seq = Atomics.load(sabMeta, META_SEQ);
    if (seq !== terrainSabSeqRef.current) {
      terrainSabSeqRef.current = seq;
      const n = Atomics.load(sabMeta, META_COUNT);
      for (let _i = 0; _i < n; _i++) {
        const graphNode = nodeMap.get(sabIds[_i]);
        if (graphNode && !graphNode.pinned && dragNodeRef.current?.id !== graphNode.id) {
          graphNode.x = sabPos[_i * 2];
          graphNode.y = sabPos[_i * 2 + 1];
        }
      }
      kineticEnergyRef.current = sabMetaF![META_ENERGY];
      alphaRef.current         = sabMetaF![META_ALPHA];
    }
  } else {
    // Fallback: transferable frame message (latest received in onmessage).
    const fPos = terrainFramePosRef.current;
    const fIds = terrainFrameIdsRef.current;
    if (fPos && fIds) {
      for (let _i = 0; _i < fIds.length; _i++) {
        const graphNode = nodeMap.get(fIds[_i]);
        if (graphNode && !graphNode.pinned && dragNodeRef.current?.id !== graphNode.id) {
          graphNode.x = fPos[_i * 2];
          graphNode.y = fPos[_i * 2 + 1];
        }
      }
    }
  }
}

// ==================== Terrain Data Computation + Dispatch ====================

/**
 * Computes per-node heights and peak radii from the current topology/settings,
 * stores them in `frameDataRef.current.terrainHeights` / `.terrainPeakRadii`,
 * and sends a `terrainData` message to the physics worker (if running) so it can
 * apply terrain-aware separation forces off-thread.
 *
 * Only runs when `refs.terrainDataDirtyRef.current` is true.
 * Clears the dirty flag on completion.
 */
export function computeAndDispatchTerrainData(
  refs: TerrainDataRefs,
  nodes: GraphNode[],
  links: GraphLink[],
  currentSettings: GraphSettings,
): void {
  const {
    frameDataRef, terrainDataDirtyRef,
    terrainWorkerRef, terrainWorkerReadyRef,
    massCacheRef, inLinkCountsRef,
    inReferenceLinkCountsRef, outReferenceLinkCountsRef, allReferenceLinkCountsRef,
  } = refs;

  const terrainHeights   = frameDataRef.current.terrainHeights;
  const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
  terrainHeights.clear();
  terrainPeakRadii.clear();

  // ---- Heights ----
  const massCache    = massCacheRef.current;
  const inCnts       = inLinkCountsRef.current;
  const inRefCnts    = inReferenceLinkCountsRef.current;
  const heightMode   = currentSettings.heightMode;
  let   maxHeightRaw = 0;
  const rawHeights   = new Map<number, number>();

  for (const node of nodes) {
    const h = heightMode === 'hierarchy'
      ? (massCache.get(node.id) ?? 1)
      : heightMode === 'references'
        ? 1 + (inRefCnts.get(node.id) || 0)
        : 1 + (inCnts.get(node.id) || 0);
    rawHeights.set(node.id, h);
    if (h > maxHeightRaw) maxHeightRaw = h;
  }

  // Double-log-compress heights to reduce dynamic range before stamp creation.
  // Raw hierarchy masses can be 50:1+ (root vs leaf). Double-log compression
  // keeps parents taller than children but prevents them from towering.
  // log(1+log(1+1))=0.53, log(1+log(1+10))=0.93, log(1+log(1+50))=1.22
  for (const [id, h] of rawHeights) {
    terrainHeights.set(id, Math.log(1 + Math.log(1 + h)));
  }

  // ---- Peak radii (size) ----
  // Base size comes from the chosen mode (links or pageSize), then
  // we blend in child count so parent nodes get wider mountain bases.
  const peakSizeMode = currentSettings.peakSizeMode;
  let   maxRawSize   = 0;
  let   maxChildCount = 0;
  const rawRadii    = new Map<number, number>();
  const childCounts = new Map<number, number>();

  // Pre-compute child counts from mass cache (mass = 1 + Σ recursive descendants)
  for (const node of nodes) {
    const m  = massCache.get(node.id) ?? 1;
    const cc = m - 1;
    childCounts.set(node.id, cc);
    if (cc > maxChildCount) maxChildCount = cc;
  }

  if (peakSizeMode === 'pageSize') {
    for (const node of nodes) {
      const size = node.displayName.length;
      rawRadii.set(node.id, size);
      if (size > maxRawSize) maxRawSize = size;
    }
  } else {
    // 'links' mode — use reference link counts based on linkDirection
    const ld        = currentSettings.linkDirection;
    const inCounts  = inReferenceLinkCountsRef.current;
    const outCounts = outReferenceLinkCountsRef.current;
    const allCounts = allReferenceLinkCountsRef.current;
    for (const node of nodes) {
      let count: number;
      if (ld === 'in') {
        count = inCounts.get(node.id) || 0;
      } else if (ld === 'out') {
        count = outCounts.get(node.id) || 0;
      } else {
        count = allCounts.get(node.id) || 0;
      }
      rawRadii.set(node.id, count);
      if (count > maxRawSize) maxRawSize = count;
    }
  }

  // Blend base size with child count: 60% mode-based size + 40% hierarchy size
  // This ensures parents with many children get wider mountain bases.
  const CHILD_COUNT_WEIGHT = 0.4;
  for (const [id, c] of rawRadii) {
    const baseFrac  = maxRawSize > 0 ? c / maxRawSize : 0;
    const childFrac = maxChildCount > 0
      ? Math.log(1 + (childCounts.get(id) ?? 0)) / Math.log(1 + maxChildCount)
      : 0;
    terrainPeakRadii.set(id, baseFrac * (1 - CHILD_COUNT_WEIGHT) + childFrac * CHILD_COUNT_WEIGHT);
  }

  terrainDataDirtyRef.current = false;

  // ---- Dispatch to physics worker (if running) ----
  if (terrainWorkerRef.current && terrainWorkerReadyRef.current) {
    const nodeArr = nodes;
    const nCount  = nodeArr.length;
    const tIds    = new Int32Array(nCount);
    const tH      = new Float32Array(nCount);
    const tPR     = new Float32Array(nCount);
    for (let _ti = 0; _ti < nCount; _ti++) {
      tIds[_ti] = nodeArr[_ti].id;
      tH[_ti]   = terrainHeights.get(nodeArr[_ti].id)   ?? 0;
      tPR[_ti]  = terrainPeakRadii.get(nodeArr[_ti].id) ?? 0;
    }

    // Collect reference links for the worker.
    const refLinks = links.filter(l => l.type === 'reference' || l.type === 'property-reference');
    const rSrc   = new Int32Array(refLinks.length);
    const rTgt   = new Int32Array(refLinks.length);
    const rTypes = new Uint8Array(refLinks.length);
    for (let _ri = 0; _ri < refLinks.length; _ri++) {
      rSrc[_ri]   = refLinks[_ri].source;
      rTgt[_ri]   = refLinks[_ri].target;
      rTypes[_ri] = refLinks[_ri].type === 'property-reference' ? 1 : 0;
    }

    const terrainDataMsg: PhysicsTerrainDataMessage = {
      type:           'terrainData',
      nodeIds:        tIds,
      heights:        tH,
      peakRadii:      tPR,
      refLinkSources: rSrc,
      refLinkTargets: rTgt,
      refLinkTypes:   rTypes,
    };
    terrainWorkerRef.current.postMessage(terrainDataMsg satisfies MainToPhysicsMessage);
  }
}

// Re-export constants used by TerrainRenderer for recenter calculations
// (avoids a second import of viewTypes just for these values).
export { TERRAIN_BASE_SLOPE_RADIUS, TERRAIN_PEAK_SLOPE_RADIUS_BONUS };
