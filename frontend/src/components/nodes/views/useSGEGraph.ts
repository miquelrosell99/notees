/**
 * useSGEGraph
 *
 * React hook that wires together:
 *   • The SGE physics Web Worker (sgePhysicsWorker.ts)
 *   • The WebGL2 renderer (sgeWebGLRenderer.ts)
 *   • Camera pan / zoom interaction
 *   • Node drag interaction
 *   • 60-fps render loop (requestAnimationFrame)
 *
 * Usage
 * ─────
 * const { canvasRef, stats, reheat, setConfig } = useSGEGraph({ nodes, edges, onNodeClick });
 * <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { SGEWebGLRenderer, type NodeVisual } from './sgeWebGLRenderer';
import type {
  MainToPhysicsMessage,
  PhysicsToMainMessage,
} from './sgePhysicsWorkerProtocol';
import type { SGEConfig } from './SemanticGraphEngine';
import type { GraphNode, GraphLink } from './viewTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a CSS hex colour to [r, g, b, a] in 0..1 range. */
function hexToRGBA(hex: string, alpha = 1): Float32Array {
  const c = hex.replace('#', '');
  const len = c.length;
  let r = 0, g = 0, b = 0;
  if (len === 3) {
    r = parseInt(c[0] + c[0], 16);
    g = parseInt(c[1] + c[1], 16);
    b = parseInt(c[2] + c[2], 16);
  } else if (len >= 6) {
    r = parseInt(c.slice(0, 2), 16);
    g = parseInt(c.slice(2, 4), 16);
    b = parseInt(c.slice(4, 6), 16);
  }
  return new Float32Array([r / 255, g / 255, b / 255, alpha]);
}

const COLOR_PAGE    = new Float32Array([0.42, 0.65, 1.00, 1.0]);
const COLOR_DAILY   = new Float32Array([0.35, 0.85, 0.55, 1.0]);
const COLOR_MONTHLY = new Float32Array([0.60, 0.80, 0.40, 1.0]);
const COLOR_YEARLY  = new Float32Array([0.90, 0.70, 0.30, 1.0]);
const COLOR_SYSTEM  = new Float32Array([0.70, 0.70, 0.70, 0.75]);
const COLOR_BLOCK   = new Float32Array([0.55, 0.55, 0.65, 0.85]);
const COLOR_CLASS   = new Float32Array([1.00, 0.65, 0.35, 1.00]);

function nodeColor(n: GraphNode): Float32Array {
  if (n.color) return hexToRGBA(n.color);
  if (n.isClassNode)  return COLOR_CLASS;
  if (n.isSystemPage) return COLOR_SYSTEM;
  if (n.isYearly)     return COLOR_YEARLY;
  if (n.isMonthly)    return COLOR_MONTHLY;
  if (n.isDaily)      return COLOR_DAILY;
  if (n.type === 'page') return COLOR_PAGE;
  return COLOR_BLOCK;
}

const BASE_RADIUS   = 7;
const MAX_RADIUS    = 22;
const MIN_RADIUS    = 4;

function nodeRadius(n: GraphNode, maxConnections: number): number {
  if (maxConnections <= 0) return BASE_RADIUS;
  // Scale logarithmically so hubs don't dominate visually
  const t = Math.log1p(n.connectionCount) / Math.log1p(maxConnections);
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * t;
}

// ─── Public API types ─────────────────────────────────────────────────────────

export interface SGEGraphStats {
  nodeCount: number;
  edgeCount: number;
  visibleNodes: number;
  visibleEdges: number;
  alpha: number;
  energy: number;
  ticks: number;
  fps: number;
}

export interface SGEGraphOptions {
  nodes: GraphNode[];
  edges: GraphLink[];
  /** Initial / overriding physics config. */
  config?: Partial<SGEConfig>;
  /** Scale node size by connection count. Default: true. */
  sizeByConnections?: boolean;
  /** Callback when user clicks a node (no drag involved). */
  onNodeClick?: (nodeId: number) => void;
}

export interface SGEGraphHandle {
  /** Ref to attach to the <canvas> element. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Runtime stats for debug overlays. */
  stats: SGEGraphStats;
  /** Restart the physics simulation cooling schedule. */
  reheat: () => void;
  /** Live-update physics config without restarting the worker. */
  setConfig: (cfg: Partial<SGEConfig>) => void;
  /** Programmatically centre the camera on the graph centroid. */
  recenter: () => void;
  /** Convert canvas pixel coords to world-space. */
  screenToWorld: (x: number, y: number) => { x: number; y: number };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSGEGraph(opts: SGEGraphOptions): SGEGraphHandle {
  const { nodes, edges, config, sizeByConnections = true } = opts;

  const canvasRef  = useRef<HTMLCanvasElement | null>(null);
  const rendRef    = useRef<SGEWebGLRenderer | null>(null);
  const workerRef  = useRef<Worker | null>(null);
  const rafRef     = useRef<number>(0);
  const optsRef    = useRef(opts);

  // Camera state (mutable, not React state — avoid re-renders on every frame)
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });

  // Drag state
  type DragMode = 'none' | 'camera' | 'node';
  const dragRef = useRef<{
    mode: DragMode;
    nodeId: number;
    startPx: number; startPy: number;
    startWx: number; startWy: number;
    camStartX: number; camStartY: number;
    moved: boolean;
  }>({
    mode: 'none', nodeId: -1,
    startPx: 0, startPy: 0,
    startWx: 0, startWy: 0,
    camStartX: 0, camStartY: 0,
    moved: false,
  });

  // Physics stats (only re-render periodically)
  const [stats, setStats] = useState<SGEGraphStats>({
    nodeCount: 0, edgeCount: 0, visibleNodes: 0, visibleEdges: 0,
    alpha: 1, energy: 0, ticks: 0, fps: 0,
  });

  const statsAccRef = useRef({ alpha: 1, energy: 0, ticks: 0 });
  const fpsRef      = useRef({ frames: 0, last: performance.now() });

  // Keep opts ref current so callbacks don't go stale
  useEffect(() => { optsRef.current = opts; }, [opts]);

  // ─── Post-to-worker helper ──────────────────────────────────────────────────
  const post = useCallback((msg: MainToPhysicsMessage): void => {
    workerRef.current?.postMessage(msg);
  }, []);

  // ─── Worker initialisation ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ── WebGL Renderer ──
    const renderer = new SGEWebGLRenderer({ cullMargin: 200 });
    renderer.init(canvas);
    rendRef.current = renderer;

    // ── Worker ──
    const worker = new Worker(
      new URL('./sgePhysicsWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<PhysicsToMainMessage>): void => {
      const msg = e.data;

      if (msg.type === 'ready') {
        statsAccRef.current.alpha  = 1;
        statsAccRef.current.energy = 0;
        statsAccRef.current.ticks  = 0;
        return;
      }

      if (msg.type === 'frame') {
        // Update renderer positions (packs instance buffers on CPU, uploads to GPU)
        renderer.updatePositions(msg.positions, msg.nodeIds);
        // Stash converged stats
        statsAccRef.current.alpha  = msg.alpha;
        statsAccRef.current.energy = msg.energy;
        statsAccRef.current.ticks  = msg.ticks;
      }
    };

    worker.onerror = (e) => console.error('[SGEWorker]', e);

    // ── RAF render loop ──
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);

      const rend = rendRef.current;
      if (!rend) return;

      // Sync camera
      const cam = camRef.current;
      rend.setCamera(cam.x, cam.y, cam.zoom);

      rend.render();

      // FPS counter
      const fr = fpsRef.current;
      fr.frames++;
      const now = performance.now();
      if (now - fr.last >= 1000) {
        const fps     = Math.round((fr.frames * 1000) / (now - fr.last));
        const s       = statsAccRef.current;
        const rStats  = rend.stats;
        setStats(prev => ({
          ...prev,
          visibleNodes: rStats.nodeInstCount,
          visibleEdges: rStats.edgeInstCount,
          alpha:  s.alpha,
          energy: s.energy,
          ticks:  s.ticks,
          fps,
        }));
        fr.frames = 0;
        fr.last   = now;
      }
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      worker.postMessage({ type: 'destroy' } satisfies MainToPhysicsMessage);
      worker.terminate();
      workerRef.current = null;
      renderer.destroy();
      rendRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // ─── Canvas resize observer ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // Update backing buffer size
        canvas.width  = Math.round(width  * devicePixelRatio);
        canvas.height = Math.round(height * devicePixelRatio);
        rendRef.current?.resize(canvas.width, canvas.height);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ─── Topology sync: nodes + edges → worker + renderer ──────────────────────
  useEffect(() => {
    const worker   = workerRef.current;
    const renderer = rendRef.current;
    if (!worker || !renderer) return;

    const maxConn = nodes.reduce((m, n) => Math.max(m, n.connectionCount), 0);

    // Build physics nodes (compact)
    const physNodes = nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));

    // Build edges (only unique source/target pairs)
    const physEdges = edges.map(e => ({ source: e.source, target: e.target }));

    // Build visual metadata map
    const visuals = new Map<number, NodeVisual>();
    for (const n of nodes) {
      visuals.set(n.id, {
        radius: sizeByConnections ? nodeRadius(n, maxConn) : BASE_RADIUS,
        color:  nodeColor(n),
      });
    }

    // Register with renderer
    const idArr = new Int32Array(nodes.map(n => n.id));
    renderer.setNodeVisuals(idArr, visuals);
    renderer.setEdges(physEdges);

    // Send to worker (full topology init/swap)
    worker.postMessage({
      type: 'init',
      nodes: physNodes,
      edges: physEdges,
      config,
    } satisfies MainToPhysicsMessage);

    // Compute a sensible initial camera centre (centroid of all nodes)
    if (nodes.length > 0) {
      let sumX = 0, sumY = 0;
      for (const n of nodes) { sumX += n.x; sumY += n.y; }
      camRef.current.x = sumX / nodes.length;
      camRef.current.y = sumY / nodes.length;
    }

    setStats(prev => ({ ...prev, nodeCount: nodes.length, edgeCount: edges.length }));
  // Stringify key to avoid re-triggering on every JS reference change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, edges.length, sizeByConnections]);

  // ─── Pointer interaction ────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const canvas  = canvasRef.current!;
    const rect    = canvas.getBoundingClientRect();
    const px      = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const py      = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const world   = rendRef.current?.screenToWorld(px, py);
    if (!world) return;

    const hitNode = rendRef.current?.pickNode(world.x, world.y, 20 / camRef.current.zoom);

    const d = dragRef.current;
    d.startPx = px;
    d.startPy = py;
    d.moved   = false;

    if (hitNode !== null && hitNode !== undefined) {
      d.mode   = 'node';
      d.nodeId = hitNode;
      d.startWx = world.x;
      d.startWy = world.y;
      post({ type: 'dragStart', nodeId: hitNode });
    } else {
      d.mode      = 'camera';
      d.camStartX = camRef.current.x;
      d.camStartY = camRef.current.y;
    }
  }, [post]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (d.mode === 'none') return;

    const canvas = canvasRef.current!;
    const rect   = canvas.getBoundingClientRect();
    const px     = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const py     = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const dx     = px - d.startPx;
    const dy     = py - d.startPy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;

    if (d.mode === 'camera') {
      const zoom = camRef.current.zoom;
      camRef.current.x = d.camStartX - dx / zoom;
      camRef.current.y = d.camStartY - dy / zoom;
    } else if (d.mode === 'node') {
      const world = rendRef.current?.screenToWorld(px, py);
      if (!world) return;
      post({ type: 'dragMove', nodeId: d.nodeId, x: world.x, y: world.y });
      // Also override locally so drag feels instant (before next worker frame)
      rendRef.current?.overridePosition(d.nodeId, world.x, world.y);
    }
  }, [post]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;

    if (d.mode === 'node') {
      post({ type: 'dragEnd', nodeId: d.nodeId });
      if (!d.moved) {
        // It was a tap/click — fire the callback
        optsRef.current.onNodeClick?.(d.nodeId);
      }
    }
    d.mode   = 'none';
    d.nodeId = -1;
    d.moved  = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, [post]);

  // Zoom with wheel
  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas  = canvasRef.current!;
    const rect    = canvas.getBoundingClientRect();
    const px      = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const py      = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const world   = rendRef.current?.screenToWorld(px, py);
    if (!world) return;

    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const cam    = camRef.current;
    cam.zoom    *= factor;
    cam.zoom     = Math.max(0.02, Math.min(cam.zoom, 40));
    // Zoom towards cursor
    cam.x       += (world.x - cam.x) * (1 - 1 / factor);
    cam.y       += (world.y - cam.y) * (1 - 1 / factor);
  }, []);

  // ─── Public API ─────────────────────────────────────────────────────────────
  const reheat = useCallback(() => {
    post({ type: 'reheat' });
  }, [post]);

  const setConfig = useCallback((cfg: Partial<SGEConfig>) => {
    post({ type: 'setConfig', config: cfg });
  }, [post]);

  const recenter = useCallback(() => {
    const n = nodes.length;
    if (n === 0) return;
    let sumX = 0, sumY = 0;
    for (const nd of nodes) { sumX += nd.x; sumY += nd.y; }
    camRef.current.x    = sumX / n;
    camRef.current.y    = sumY / n;
    camRef.current.zoom = 1;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    return rendRef.current?.screenToWorld(sx, sy) ?? { x: 0, y: 0 };
  }, []);

  return {
    canvasRef: canvasRef as React.RefObject<HTMLCanvasElement | null>,
    stats,
    reheat,
    setConfig,
    recenter,
    screenToWorld,
    // Expose interaction handlers so the component can attach them to the canvas
    // (returned as extra fields consumed by SGEGraphView)
    _pointerDown:  onPointerDown,
    _pointerMove:  onPointerMove,
    _pointerUp:    onPointerUp,
    _wheel:        onWheel,
  } as SGEGraphHandle & {
    _pointerDown:  React.PointerEventHandler<HTMLCanvasElement>;
    _pointerMove:  React.PointerEventHandler<HTMLCanvasElement>;
    _pointerUp:    React.PointerEventHandler<HTMLCanvasElement>;
    _wheel:        React.WheelEventHandler<HTMLCanvasElement>;
  };
}
