/**
 * useGraphWorker Hook
 * 
 * Manages the OffscreenCanvas rendering worker lifecycle.
 * Bridges between useNodePhysics (main-thread physics) and the
 * graphRenderWorker (worker-side rendering).
 * 
 * Responsibilities:
 * - Create/terminate the Web Worker
 * - Transfer OffscreenCanvas to worker on init
 * - Pack per-frame position/state data into compact typed arrays
 * - Send node metadata + style updates when they change
 * - Handle canvas resize
 * 
 * The main thread retains responsibility for:
 * - Physics simulation (useNodePhysics)
 * - Mouse/keyboard events & hit testing
 * - React state management
 */

import { useCallback, useEffect, useRef } from 'react';
import type {
  FrameMessage,
  NodeMetadataMessage,
  StyleMessage,
  WorkerToMainMessage,
} from './graphWorkerProtocol';
import { encodeGlare, encodeLinkType, packNodeFlags } from './graphWorkerProtocol';
import type {
  GraphNode,
  FrameData,
  Transform,
  ClassColor,
  GraphSettings,
  GraphLayoutMode,
} from './viewTypes';

// ==================== Types ====================

interface UseGraphWorkerOptions {
  /** The canvas element to transfer (must not have a context already) */
  canvas: HTMLCanvasElement | null;
  /** Logical canvas size */
  width: number;
  height: number;
  /** Device pixel ratio */
  dpr: number;
  /** Whether worker rendering is enabled */
  enabled: boolean;
}

interface UseGraphWorkerReturn {
  /** Whether the worker is ready to receive frames */
  isReady: boolean;
  /** Send a render frame to the worker. Call this from your render callback. */
  sendFrame: (
    frameData: FrameData,
    transform: Transform,
    settings: GraphSettings,
    viewMode: GraphLayoutMode,
    dragNode: GraphNode | null,
    dragLiftProgress: number,
    hoveredNode: GraphNode | null,
  ) => void;
  /** Update node metadata (call when node list changes) */
  sendNodeMetadata: (nodes: GraphNode[]) => void;
  /** Update style/colors (call when class colors or CSS vars change) */
  sendStyle: (
    classColors: ClassColor[],
    cssVars: { textColor: string; accentColor: string; dimColor: string; outlineColor: string; warningColor: string },
  ) => void;
}

// ==================== Feature Detection ====================

let _offscreenSupported: boolean | null = null;

export function isOffscreenCanvasSupported(): boolean {
  if (_offscreenSupported !== null) return _offscreenSupported;
  try {
    // Check that OffscreenCanvas exists AND we can get a 2d context from it
    const test = new OffscreenCanvas(1, 1);
    const ctx = test.getContext('2d');
    _offscreenSupported = ctx !== null;
  } catch {
    _offscreenSupported = false;
  }
  return _offscreenSupported;
}

// ==================== Reusable Buffers ====================

// Pre-allocated typed arrays that grow as needed.
// These live for the lifetime of the hook to avoid per-frame allocation.
let positionBuf = new Float32Array(0);
let stateBuf = new Uint8Array(0);
let linkBuf = new Int32Array(0);
let linkTypeBuf = new Uint8Array(0);

function ensurePositionBuf(nodeCount: number): Float32Array {
  const needed = nodeCount * 2;
  if (positionBuf.length < needed) {
    positionBuf = new Float32Array(Math.max(needed, 1024));
  }
  return positionBuf;
}

function ensureStateBuf(nodeCount: number): Uint8Array {
  const needed = nodeCount * 4;
  if (stateBuf.length < needed) {
    stateBuf = new Uint8Array(Math.max(needed, 2048));
  }
  return stateBuf;
}

function ensureLinkBuf(linkCount: number): Int32Array {
  const needed = linkCount * 2;
  if (linkBuf.length < needed) {
    linkBuf = new Int32Array(Math.max(needed, 1024));
  }
  return linkBuf;
}

function ensureLinkTypeBuf(linkCount: number): Uint8Array {
  if (linkTypeBuf.length < linkCount) {
    linkTypeBuf = new Uint8Array(Math.max(linkCount, 512));
  }
  return linkTypeBuf;
}

// ==================== Hook ====================

export function useGraphWorker({
  canvas,
  width,
  height,
  dpr,
  enabled,
}: UseGraphWorkerOptions): UseGraphWorkerReturn {
  const workerRef = useRef<Worker | null>(null);
  const isReadyRef = useRef(false);
  const transferredRef = useRef(false);
  // Track the last node order to build index maps for frame packing
  const nodeOrderRef = useRef<Map<number, number>>(new Map()); // nodeId → index

  // ---- Worker lifecycle ----

  useEffect(() => {
    if (!enabled || !canvas || transferredRef.current) return;

    // Feature-detect
    if (!isOffscreenCanvasSupported()) return;

    let offscreen: OffscreenCanvas;
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch {
      // Canvas already has a context or browser doesn't support transfer
      return;
    }

    const worker = new Worker(
      new URL('./graphRenderWorker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
      if (e.data.type === 'ready') {
        isReadyRef.current = true;
      }
    };

    worker.onerror = (e) => {
      console.error('[GraphWorker] Error:', e.message);
    };

    // Send init with transferable OffscreenCanvas
    worker.postMessage(
      { type: 'init', canvas: offscreen, width, height, dpr },
      [offscreen],
    );

    workerRef.current = worker;
    transferredRef.current = true;

    return () => {
      worker.postMessage({ type: 'destroy' });
      worker.terminate();
      workerRef.current = null;
      isReadyRef.current = false;
      transferredRef.current = false;
    };
    // Only create once — canvas identity should not change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, canvas]);

  // ---- Resize ----

  useEffect(() => {
    const w = workerRef.current;
    if (!w || !isReadyRef.current) return;
    w.postMessage({ type: 'resize', width, height, dpr });
  }, [width, height, dpr]);

  // ---- Send frame ----

  const sendFrame = useCallback((
    frameData: FrameData,
    transform: Transform,
    settings: GraphSettings,
    viewMode: GraphLayoutMode,
    dragNode: GraphNode | null,
    dragLiftProgress: number,
    hoveredNode: GraphNode | null,
  ) => {
    const w = workerRef.current;
    if (!w || !isReadyRef.current) return;

    const { visibleNodes, visibleLinks, maxConnections, maxMass, maxContentSize } = frameData;
    const nc = visibleNodes.length;
    const lc = visibleLinks.length;

    // Build node-id → index map (reuse across frames if order is stable)
    const orderMap = nodeOrderRef.current;
    orderMap.clear();
    for (let i = 0; i < nc; i++) {
      orderMap.set(visibleNodes[i].id, i);
    }

    // Pack positions
    const positions = ensurePositionBuf(nc);
    const states = ensureStateBuf(nc);
    const hoveredId = hoveredNode?.id ?? -1;
    const dragId = dragNode?.id ?? -1;
    let dragIdx = -1;

    for (let i = 0; i < nc; i++) {
      const n = visibleNodes[i];
      positions[i * 2] = n.x;
      positions[i * 2 + 1] = n.y;
      const isHovered = n.id === hoveredId;
      const isDragged = n.id === dragId;
      if (isDragged) dragIdx = i;
      states[i * 4] = packNodeFlags(n.visible, isHovered, isDragged, n.pinned);
      states[i * 4 + 1] = encodeGlare(n.glare);
      states[i * 4 + 2] = 0; // reserved
      states[i * 4 + 3] = 0; // reserved
    }

    // Pack links
    const links = ensureLinkBuf(lc);
    const types = ensureLinkTypeBuf(lc);
    for (let i = 0; i < lc; i++) {
      const l = visibleLinks[i];
      const si = orderMap.get(l.source);
      const ti = orderMap.get(l.target);
      if (si === undefined || ti === undefined) {
        links[i * 2] = 0;
        links[i * 2 + 1] = 0;
        types[i] = 0;
        continue;
      }
      links[i * 2] = si;
      links[i * 2 + 1] = ti;
      types[i] = encodeLinkType(l.type);
    }

    // Create transferable copies (sliced from the reusable buffers)
    const posCopy = positions.slice(0, nc * 2);
    const stateCopy = states.slice(0, nc * 4);
    const linkCopy = links.slice(0, lc * 2);
    const typeCopy = types.slice(0, lc);

    const msg: FrameMessage = {
      type: 'frame',
      positionBuffer: posCopy,
      stateBuffer: stateCopy,
      nodeCount: nc,
      linkBuffer: linkCopy,
      linkTypeBuffer: typeCopy,
      linkCount: lc,
      maxConnections,
      maxMass,
      maxContentSize,
      transformX: transform.x,
      transformY: transform.y,
      transformScale: transform.scale,
      dragNodeIndex: dragIdx,
      dragLiftProgress,
      viewMode,
      nodeSizeMode: settings.nodeSizeMode,
      linkDirection: settings.linkDirection,
    };

    w.postMessage(msg, [posCopy.buffer, stateCopy.buffer, linkCopy.buffer, typeCopy.buffer]);
  }, []);

  // ---- Send node metadata ----

  const sendNodeMetadata = useCallback((nodes: GraphNode[]) => {
    const w = workerRef.current;
    if (!w || !isReadyRef.current) return;

    const msg: NodeMetadataMessage = {
      type: 'nodeMetadata',
      nodeIds: nodes.map(n => n.id),
      nodeUuids: nodes.map(n => n.uuid),
      displayNames: nodes.map(n => n.displayName),
      connectionCounts: nodes.map(n => n.connectionCount),
      inLinkCounts: nodes.map(n => n.inLinkCount),
      outLinkCounts: nodes.map(n => n.outLinkCount),
      masses: nodes.map(n => (n as GraphNode & { _mass?: number })._mass ?? 1),
      contentSizes: nodes.map(n => n.contentSize),
      nodeTypeIds: nodes.map(n => n.types || []),
      nodeColors: nodes.map(n => n.color || null),
      isClassNodes: nodes.map(n => n.isClassNode),
      treeRadii: nodes.map(n => (n as GraphNode & { _treeRadius?: number })._treeRadius),
    };

    w.postMessage(msg);
  }, []);

  // ---- Send style ----

  const sendStyle = useCallback((
    classColors: ClassColor[],
    cssVars: { textColor: string; accentColor: string; dimColor: string; outlineColor: string; warningColor: string },
  ) => {
    const w = workerRef.current;
    if (!w || !isReadyRef.current) return;

    const msg: StyleMessage = {
      type: 'style',
      classColors: classColors.map(cc => ({
        classId: cc.classId,
        color: cc.color,
        order: cc.order,
      })),
      textColor: cssVars.textColor,
      accentColor: cssVars.accentColor,
      dimColor: cssVars.dimColor,
      outlineColor: cssVars.outlineColor,
      warningColor: cssVars.warningColor,
    };

    w.postMessage(msg);
  }, []);

  return {
    isReady: isReadyRef.current,
    sendFrame,
    sendNodeMetadata,
    sendStyle,
  };
}
