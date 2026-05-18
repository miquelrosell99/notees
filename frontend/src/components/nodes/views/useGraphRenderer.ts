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
import { GraphWebGLRenderer, type NodeVisual } from './graphWebGLRenderer';
import type {
  MainToPhysicsMessage,
  PhysicsToMainMessage,
} from './graphPhysicsWorkerProtocol';
import { META_SEQ, META_COUNT, META_TICKS, META_ALPHA, META_ENERGY } from './graphPhysicsWorkerProtocol';
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

function nodeColor(n: GraphNode): Float32Array | undefined {
  if (n.color) return hexToRGBA(n.color);
  return undefined; // renderer reads --color-outline from CSS
}

// ─── CSS label colour cache (theme-reactive) ──────────────────────────────────
// 2D canvas contexts don't support CSS variables natively, so we read them
// via getComputedStyle and cache the results until the theme changes.

const labelColorCache: {
  regular:  string | null;
  emphasis: string | null;
  shadow:   string | null;
} = { regular: null, emphasis: null, shadow: null };

function _invalidateLabelColors() {
  labelColorCache.regular  = null;
  labelColorCache.emphasis = null;
  labelColorCache.shadow   = null;
}

let _labelThemeObserverReady = false;
function _ensureLabelThemeObserver() {
  if (_labelThemeObserverReady || typeof MutationObserver === 'undefined') return;
  _labelThemeObserverReady = true;
  new MutationObserver(_invalidateLabelColors).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ['data-theme', 'class'] },
  );
}

/** Hex CSS variable → `rgba(r,g,b,a)` string. Returns fallback if variable missing. */
function _hexVarToRgba(varName: string, alpha: number, fallback: string): string {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!hex || hex[0] !== '#') return fallback;
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Dimmed label color for non-focused nodes (--color-on-surface-variant @ 80%). */
function getLabelRegularColor(): string {
  if (!labelColorCache.regular) {
    _ensureLabelThemeObserver();
    labelColorCache.regular = _hexVarToRgba('--color-on-surface-variant', 0.80, 'rgba(160,160,165,0.80)');
  }
  return labelColorCache.regular;
}

/** Bright label color for hovered/selected nodes (--color-on-surface @ 95%). */
function getLabelEmphasisColor(): string {
  if (!labelColorCache.emphasis) {
    _ensureLabelThemeObserver();
    labelColorCache.emphasis = _hexVarToRgba('--color-on-surface', 0.95, 'rgba(228,228,228,0.95)');
  }
  return labelColorCache.emphasis;
}

/** Text shadow color for label halos (--color-scrim, already an rgba value). */
function getLabelShadowColor(): string {
  if (!labelColorCache.shadow) {
    _ensureLabelThemeObserver();
    const val = getComputedStyle(document.documentElement).getPropertyValue('--color-scrim').trim();
    labelColorCache.shadow = val || 'rgba(0,0,0,0.5)';
  }
  return labelColorCache.shadow;
}

const BASE_RADIUS   = 20;
const MAX_RADIUS    = 50;

function nodeRadius(n: GraphNode, maxConnections: number, base = BASE_RADIUS): number {
  if (maxConnections <= 0) return base;
  // Scale logarithmically so hubs don't dominate visually
  const t = Math.log1p(n.connectionCount) / Math.log1p(maxConnections);
  return base + (MAX_RADIUS - base) * t;
}

// ─── Public API types ─────────────────────────────────────────────────────────

export interface GraphRendererStats {
  nodeCount: number;
  edgeCount: number;
  visibleNodes: number;
  visibleEdges: number;
  arrowInstCount: number;
  glowInstCount: number;
  alpha: number;
  energy: number;
  ticks: number;
  fps: number;
}

export interface GraphRendererOptions {
  nodes: GraphNode[];
  edges: GraphLink[];
  /** Initial / overriding physics config. */
  config?: Partial<SGEConfig>;
  /** Scale node size by connection count. Default: true. */
  sizeByConnections?: boolean;
  /** Base node radius in world units when not scaling by connections. Default: 7. */
  baseNodeRadius?: number;
  /** Callback when user clicks a node (no drag involved). */
  onNodeClick?: (nodeId: number) => void;
  /** Callback when user double-clicks a node. */
  onNodeDblClick?: (nodeId: number) => void;
  /** Callback when user clicks on empty space (no node hit). */
  onEmptyClick?: () => void;
}

export interface GraphRendererHandle {
  /** Ref to attach to the <canvas> element. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Ref to attach to the 2D label overlay <canvas>. */
  labelCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Runtime stats for debug overlays. */
  stats: GraphRendererStats;
  /** Currently selected node ID (-1 = none). */
  selectedNodeId: number;
  /** Currently hovered node info for tooltip (null = none). */
  hoveredNode: { id: number; name: string; screenX: number; screenY: number } | null;
  /** Restart the physics simulation cooling schedule. */
  reheat: () => void;
  /** Pause the physics simulation without destroying state. */
  pause: () => void;
  /** Resume the physics simulation. */
  resume: () => void;
  /** Live-update physics config without restarting the worker. */
  setConfig: (cfg: Partial<SGEConfig>) => void;
  /** Programmatically centre the camera on the graph centroid. */
  recenter: () => void;
  /** Pan the camera by a screen-pixel delta. */
  panBy: (dx: number, dy: number) => void;
  /** Zoom by a factor (1 = no change, >1 = in, <1 = out). */
  zoomBy: (factor: number) => void;
  /** Clear the current node selection. */
  clearSelection: () => void;
  /** Convert canvas pixel coords to world-space. */
  screenToWorld: (x: number, y: number) => { x: number; y: number };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGraphRenderer(opts: GraphRendererOptions): GraphRendererHandle {
  const { nodes, edges, config, sizeByConnections = true, baseNodeRadius = BASE_RADIUS } = opts;

  const canvasRef  = useRef<HTMLCanvasElement | null>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendRef    = useRef<GraphWebGLRenderer | null>(null);
  const workerRef  = useRef<Worker | null>(null);
  const rafRef     = useRef<number>(0);
  const optsRef    = useRef(opts);

  // ── SharedArrayBuffer shared-memory path ──────────────────────────────────
  // When crossOriginIsolated, the worker writes positions into a SAB each tick
  // and increments a seq counter.  RAF polls the counter; when it changes, reads
  // positions directly — no postMessage overhead per frame.
  const sabPosRef    = useRef<Float32Array  | null>(null);
  const sabMetaI32   = useRef<Int32Array    | null>(null);
  const sabMetaF32   = useRef<Float32Array  | null>(null);
  const sabNodeIds   = useRef<Int32Array    | null>(null);
  const sabSeq       = useRef<number>(0);

  // Camera state (mutable, not React state — avoid re-renders on every frame)
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });

  // Hover / selection (mutable refs = no re-renders on mouse move)
  const hoveredNodeRef = useRef(-1);
  const selectedRef    = useRef(-1);
  const [selectedNodeId, setSelectedNodeId] = useState<number>(-1);
  const [hoveredNode, setHoveredNode] = useState<{ id: number; name: string; screenX: number; screenY: number } | null>(null);

  // Node name map for label rendering (id → displayName)
  const nodeNamesRef = useRef(new Map<number, string>());

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
  const [stats, setStats] = useState<GraphRendererStats>({
    nodeCount: 0, edgeCount: 0, visibleNodes: 0, visibleEdges: 0,
    arrowInstCount: 0, glowInstCount: 0,
    alpha: 1, energy: 0, ticks: 0, fps: 0,
  });

  const statsAccRef = useRef({ alpha: 1, energy: 0, ticks: 0 });
  const fpsRef      = useRef({ frames: 0, last: performance.now() });

  // When a real topology init fires, auto-fit the camera to the physics
  // layout on the first position frame so all nodes/edges are visible.
  const needsAutoFitRef = useRef(false);

  // ── Dirty tracking for skip-frame optimisation ──
  // We only re-render when something actually changed:
  //   • Physics delivered new positions
  //   • Camera moved (pan/zoom)
  //   • Hover or selection changed
  const dirtyRef = useRef({
    positions: false,
    camera: false,
    hover: false,
    /** Last camera state we rendered at */
    lastCamX: 0, lastCamY: 0, lastCamZoom: 1,
    /** Cached font string — only rebuild when zoom changes */
    lastFontZoom: -1,
    cachedFont: '',
  });

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

    // ── Prime canvas backing-buffer size at device resolution ──
    // The ResizeObserver fires asynchronously, so canvas.width/height are still
    // the browser defaults (300×150) when renderer.init() runs.  Set them now
    // from getBoundingClientRect() so the initial viewport is correct.
    {
      const rect = canvas.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      canvas.width  = Math.round(rect.width  * dpr);
      canvas.height = Math.round(rect.height * dpr);
      // Note: style.width/height are intentionally NOT set here.
      // The CSS class already has `width: 100%; height: 100%` which controls
      // the layout size; canvas.width/height only control the backing buffer.
    }

    // ── WebGL Renderer ──
    const renderer = new GraphWebGLRenderer({ cullMargin: 200 });
    renderer.init(canvas);
    rendRef.current = renderer;

    // ── Worker ──
    const worker = new Worker(
      new URL('./graphPhysicsWorker.ts', import.meta.url),
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

      // ── SharedArrayBuffer path ─ store views, reset seq counter ────────
      if (msg.type === 'sharedBuffer') {
        sabPosRef.current  = new Float32Array(msg.positions);
        sabMetaI32.current = new Int32Array(msg.meta);
        sabMetaF32.current = new Float32Array(msg.meta);
        sabNodeIds.current = msg.nodeIds;
        sabSeq.current     = Atomics.load(sabMetaI32.current, META_SEQ);
        return;
      }

      // ── Transferable fallback (no crossOriginIsolated) ────────────────
      if (msg.type === 'frame') {
        // Update renderer positions (packs instance buffers on CPU, uploads to GPU)
        renderer.updatePositions(msg.positions, msg.nodeIds);
        // Stash converged stats
        statsAccRef.current.alpha  = msg.alpha;
        statsAccRef.current.energy = msg.energy;
        statsAccRef.current.ticks  = msg.ticks;
        // Mark frame dirty so the RAF loop knows to re-render
        dirtyRef.current.positions = true;

        // Auto-fit the camera on the first position frame after a topology init
        if (needsAutoFitRef.current && msg.nodeCount > 0) {
          needsAutoFitRef.current = false;
          const c = canvasRef.current;
          if (c) {
            const pos = msg.positions;
            const nn  = msg.nodeCount;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < nn; i++) {
              const x = pos[i * 2], y = pos[i * 2 + 1];
              if (x < minX) minX = x; if (y < minY) minY = y;
              if (x > maxX) maxX = x; if (y > maxY) maxY = y;
            }
            const pad = 60 * (window.devicePixelRatio || 1);
            const worldW = (maxX - minX) + 32;
            const worldH = (maxY - minY) + 32;
            const cam = camRef.current;
            cam.x = (minX + maxX) / 2;
            cam.y = (minY + maxY) / 2;
            cam.zoom = (worldW > 0 && worldH > 0)
              ? Math.max(0.02, Math.min(
                  (c.width  - pad * 2) / worldW,
                  (c.height - pad * 2) / worldH,
                  40,
                ))
              : 1;
          }
        }
      }
    };

    worker.onerror = (e) => console.error('[SGEWorker]', e);

    // ── RAF render loop ────────────────────────────────────────────────────────────────────────────
    // Only does GPU/canvas work when something actually changed.
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);

      const rend = rendRef.current;
      if (!rend) return;

      // ── SAB poll: check if worker wrote new physics data ────────────────
      const metaI32  = sabMetaI32.current;
      const metaF32  = sabMetaF32.current;
      const sabPos   = sabPosRef.current;
      const sabNids  = sabNodeIds.current;
      if (metaI32 && metaF32 && sabPos && sabNids) {
        const seq = Atomics.load(metaI32, META_SEQ);
        if (seq !== sabSeq.current) {
          sabSeq.current = seq;
          const n = Atomics.load(metaI32, META_COUNT);
          rend.updatePositions(sabPos.subarray(0, n * 2), sabNids.subarray(0, n));
          statsAccRef.current.alpha  = metaF32[META_ALPHA];
          statsAccRef.current.energy = metaF32[META_ENERGY];
          statsAccRef.current.ticks  = Atomics.load(metaI32, META_TICKS);
          dirtyRef.current.positions = true;

          // Auto-fit the camera on the first position frame after a topology init
          // so all nodes (and their edges) are in view from the start.
          if (needsAutoFitRef.current && n > 0) {
            needsAutoFitRef.current = false;
            const canvas = canvasRef.current;
            if (canvas) {
              const pos = sabPos;
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (let i = 0; i < n; i++) {
                const x = pos[i * 2], y = pos[i * 2 + 1];
                if (x < minX) minX = x; if (y < minY) minY = y;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y;
              }
              const pad = 60 * (window.devicePixelRatio || 1);
              const worldW = (maxX - minX) + 32;
              const worldH = (maxY - minY) + 32;
              camRef.current.x = (minX + maxX) / 2;
              camRef.current.y = (minY + maxY) / 2;
              camRef.current.zoom = (worldW > 0 && worldH > 0)
                ? Math.max(0.02, Math.min(
                    (canvas.width  - pad * 2) / worldW,
                    (canvas.height - pad * 2) / worldH,
                    40,
                  ))
                : 1;
            }
          }
        }
      }
      const cam   = camRef.current;
      const dirty = dirtyRef.current;

      // Detect camera movement
      if (cam.x !== dirty.lastCamX || cam.y !== dirty.lastCamY || cam.zoom !== dirty.lastCamZoom) {
        dirty.camera   = true;
        dirty.lastCamX = cam.x;
        dirty.lastCamY = cam.y;
        dirty.lastCamZoom = cam.zoom;
      }

      // Skip entire frame if nothing changed
      const needsRender = dirty.positions || dirty.camera || dirty.hover;
      if (!needsRender) {
        // Still count FPS even on skipped frames
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
        return;
      }

      // Clear dirty flags
      dirty.positions = false;
      dirty.camera    = false;
      dirty.hover     = false;

      // Sync camera & render WebGL
      rend.setCamera(cam.x, cam.y, cam.zoom);
      rend.render();

      // ── 2D label overlay ──
      const lc = labelCanvasRef.current;
      if (lc) {
        const ctx = lc.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, lc.width, lc.height);
          const zoom = cam.zoom;
          // Only render labels when zoomed in enough to read them
          if (zoom >= 0.25 && rend.nodeOrder.length > 0) {
            const pos   = rend.nodePositions;
            const order = rend.nodeOrder;
            const names = nodeNamesRef.current;
            const n     = order.length;
            // dpr is used only for font/shadow sizing — coordinates are already
            // physical pixels because worldToScreen uses the DPR-scaled canvasW/H.
            const dpr   = window.devicePixelRatio || 1;

            // Cache font string — only rebuild when zoom changes.
            // Font size is in physical pixels (no ctx.scale; canvas is DPR-scaled).
            const fontSize  = Math.round(Math.min(14, Math.max(9, 11 * zoom)) * dpr);
            if (dirty.lastFontZoom !== fontSize) {
              dirty.lastFontZoom = fontSize;
              dirty.cachedFont   = `${fontSize}px system-ui, -apple-system, sans-serif`;
            }
            const labelAlpha = Math.min(1, (zoom - 0.25) / 0.4); // fade in

            // Limit label count to avoid CPU thrash at low zoom with many nodes.
            // At zoom < 1, many labels overlap and are unreadable anyway.
            const maxLabels = zoom < 0.5 ? 60 : zoom < 1.0 ? 150 : 500;

            ctx.save();
            ctx.globalAlpha  = labelAlpha;
            ctx.font         = dirty.cachedFont;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'top';

            // Use shadow for text halo instead of expensive strokeText.
            // One fillText call per label instead of strokeText + fillText.
            ctx.shadowColor   = getLabelShadowColor();
            ctx.shadowBlur    = 4 * dpr;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;

            // Pre-compute viewport bounds for culling (physical pixels)
            const cw      = lc.width;
            const ch      = lc.height;
            const margin  = 100;
            let rendered  = 0;

            // Batch by fill color to minimise state changes.
            // Phase 1: default color labels
            ctx.fillStyle = getLabelRegularColor();
            for (let i = 0; i < n && rendered < maxLabels; i++) {
              const id = order[i];
              if (id === selectedRef.current || id === hoveredNodeRef.current) continue;
              const name = names.get(id);
              if (!name) continue;

              const wx = pos[i * 2];
              const wy = pos[i * 2 + 1];
              // worldToScreen already returns physical pixels — do NOT multiply by dpr
              const sp = rend.worldToScreen(wx, wy);
              const sx = sp.x;
              const sy = sp.y;

              if (sx < -margin || sx > cw + margin || sy < -40 || sy > ch + 40) continue;

              const label = name.length > 28 ? name.slice(0, 27) + '\u2026' : name;
              ctx.fillText(label, sx, sy + 12 * dpr);
              rendered++;
            }

            // Phase 2: hovered label (on top, brighter)
            if (hoveredNodeRef.current >= 0 && hoveredNodeRef.current !== selectedRef.current) {
              const hIdx = rend.nodeOrder.indexOf(hoveredNodeRef.current);
              if (hIdx >= 0) {
                const hName = names.get(hoveredNodeRef.current);
                if (hName) {
                  // worldToScreen already returns physical pixels
                  const sx = rend.worldToScreen(pos[hIdx * 2], pos[hIdx * 2 + 1]).x;
                  const sy = rend.worldToScreen(pos[hIdx * 2], pos[hIdx * 2 + 1]).y;
                  ctx.fillStyle = getLabelEmphasisColor();
                  const label = hName.length > 28 ? hName.slice(0, 27) + '\u2026' : hName;
                  ctx.fillText(label, sx, sy + 12 * dpr);
                }
              }
            }

            // Phase 3: selected label (on top, bright white)
            if (selectedRef.current >= 0) {
              const sIdx = rend.nodeOrder.indexOf(selectedRef.current);
              if (sIdx >= 0) {
                const sName = names.get(selectedRef.current);
                if (sName) {
                  // worldToScreen already returns physical pixels
                  const sx = rend.worldToScreen(pos[sIdx * 2], pos[sIdx * 2 + 1]).x;
                  const sy = rend.worldToScreen(pos[sIdx * 2], pos[sIdx * 2 + 1]).y;
                  ctx.fillStyle = getLabelEmphasisColor();
                  const label = sName.length > 28 ? sName.slice(0, 27) + '\u2026' : sName;
                  ctx.fillText(label, sx, sy + 12 * dpr);
                }
              }
            }

            ctx.restore();
          }
        }
      }

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
        const dpr = window.devicePixelRatio || 1;
        // Set backing-buffer size at device resolution.
        // CSS layout size is owned by the class (`width: 100%; height: 100%`);
        // do NOT set style.width/height or it locks the canvas at a fixed CSS
        // pixel size and breaks responsiveness.
        canvas.width  = Math.round(width  * dpr);
        canvas.height = Math.round(height * dpr);
        rendRef.current?.resize(canvas.width, canvas.height);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ─── Topology sync: nodes + edges → worker + renderer ──────────────────────
  // Track the last topology fingerprint to skip no-op re-inits (e.g., TanStack
  // Query returning a new reference with identical data).
  const topoFingerprintRef = useRef('');
  // Debounce timer to coalesce rapid successive topology changes (e.g.,
  // placeholder → real data transitions) into a single worker init.
  const topoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const worker   = workerRef.current;
    const renderer = rendRef.current;
    if (!worker || !renderer) return;

    // Build a fingerprint from node IDs + edge pairs + sizing mode.
    // Cheap string comparison prevents duplicate worker re-inits.
    const nodeIdStr = nodes.map(n => n.id).join(',');
    const edgeStr   = edges.map(e => `${e.source}-${e.target}`).join(',');
    const fingerprint = `${nodeIdStr}|${edgeStr}|${sizeByConnections}`;

    if (fingerprint === topoFingerprintRef.current) return;
    topoFingerprintRef.current = fingerprint;

    // Clear any pending debounced init
    if (topoTimerRef.current) clearTimeout(topoTimerRef.current);

    // Debounce: wait a tick before committing to let rapid changes coalesce
    topoTimerRef.current = setTimeout(() => {
      topoTimerRef.current = null;

      const maxConn = nodes.reduce((m, n) => Math.max(m, n.connectionCount), 0);

      // Build physics nodes (compact)
      const physNodes = nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));

      // Build edges (only unique source/target pairs), with dashed flag and width by type
      // Parent/class/extends links are solid and thicker; reference links are dashed and thinner
      const SEMANTIC_COLOR: [number, number, number, number] = [0.65, 0.3, 0.9, 0.65];
      const physEdges = edges.map(e => ({
        source: e.source,
        target: e.target,
        dashed: e.type === 'reference' || e.type === 'property-reference' || e.type === 'semantic',
        color: e.type === 'semantic' ? SEMANTIC_COLOR : undefined,
        width: e.type === 'parent' || e.type === 'extends' ? 1.2
          : e.type === 'class' ? 1.0
          : 0.6,
      }));

      // Build visual metadata map
      const visuals = new Map<number, NodeVisual>();
      for (const n of nodes) {
        visuals.set(n.id, {
          radius: sizeByConnections ? nodeRadius(n, maxConn, baseNodeRadius) : baseNodeRadius,
          color:  nodeColor(n),
        });
      }

      // Register with renderer
      const idArr = new Int32Array(nodes.map(n => n.id));
      renderer.setNodeVisuals(idArr, visuals);
      renderer.setEdges(physEdges);

      // Populate label name map
      const names = nodeNamesRef.current;
      names.clear();
      for (const n of nodes) {
        names.set(n.id, n.displayName || n.name || String(n.id));
      }

      // Send to worker (full topology init/swap)
      worker.postMessage({
        type: 'init',
        nodes: physNodes,
        edges: physEdges,
        config,
      } satisfies MainToPhysicsMessage);

      // Request auto-fit once the first physics frame arrives so the camera
      // zoom encompasses all nodes (physics positions differ from input positions).
      if (nodes.length > 0) {
        needsAutoFitRef.current = true;
      }

      setStats(prev => ({ ...prev, nodeCount: nodes.length, edgeCount: edges.length }));
    }, 30); // 30ms debounce — coalesces fast successive updates without visible delay

    return () => {
      if (topoTimerRef.current) {
        clearTimeout(topoTimerRef.current);
        topoTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, sizeByConnections, baseNodeRadius]);

  // ─── Visual-only updates (radius, color) ────────────────────────────────────
  // These don't affect physics, so we skip the worker re-init and update the
  // renderer directly. We mark the RAF dirty so the new radii appear immediately.
  useEffect(() => {
    const renderer = rendRef.current;
    if (!renderer) return;

    const maxConn = nodes.reduce((m, n) => Math.max(m, n.connectionCount), 0);
    const visuals = new Map<number, NodeVisual>();
    for (const n of nodes) {
      visuals.set(n.id, {
        radius: sizeByConnections ? nodeRadius(n, maxConn, baseNodeRadius) : baseNodeRadius,
        color: nodeColor(n),
      });
    }
    const idArr = new Int32Array(nodes.map(n => n.id));
    renderer.setNodeVisuals(idArr, visuals);
    dirtyRef.current.positions = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, baseNodeRadius, sizeByConnections]);

  // ─── Label canvas resize observer ─────────────────────────────────────────
  useEffect(() => {
    const lc = labelCanvasRef.current;
    if (!lc) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        // Backing buffer at device resolution; CSS layout handled by `inset: 0`.
        lc.width  = Math.round(width  * dpr);
        lc.height = Math.round(height * dpr);
      }
    });
    ro.observe(lc);
    return () => ro.disconnect();
  }, []);

  // ─── DPR change listener (monitor switch) ──────────────────────────────────
  // ResizeObserver only fires when CSS layout size changes.  Moving the window
  // to a monitor with a different devicePixelRatio leaves CSS size identical, so
  // ResizeObserver never fires and the backing buffers stay at the wrong DPR.
  //
  // Fix: watch `(resolution: Xdppx)` via matchMedia.  When the query stops
  // matching (DPR changed), re-apply BoundingClientRect × new DPR to both
  // canvases and re-register for the next change.
  useEffect(() => {
    let mql: MediaQueryList | null = null;
    let listener: (() => void) | null = null;

    const applyDpr = () => {
      const dpr    = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      const lc     = labelCanvasRef.current;

      if (canvas) {
        const rect    = canvas.getBoundingClientRect();
        canvas.width  = Math.round(rect.width  * dpr);
        canvas.height = Math.round(rect.height * dpr);
        rendRef.current?.resize(canvas.width, canvas.height);
      }
      if (lc) {
        const rect  = lc.getBoundingClientRect();
        lc.width    = Math.round(rect.width  * dpr);
        lc.height   = Math.round(rect.height * dpr);
      }

      // Re-register: the current MQL no longer matches after DPR changed,
      // so we need a fresh query at the new DPR to catch the *next* change.
      register(); // eslint-disable-line @typescript-eslint/no-use-before-define
    };

    const register = () => {
      if (mql && listener) mql.removeEventListener('change', listener);
      mql      = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      listener = applyDpr;
      mql.addEventListener('change', listener);
    };

    register();
    return () => { if (mql && listener) mql.removeEventListener('change', listener); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    const d      = dragRef.current;
    const canvas = canvasRef.current!;
    const rect   = canvas.getBoundingClientRect();
    const px     = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const py     = (e.clientY - rect.top)  * (canvas.height / rect.height);

    // Hover detection (always, even when not dragging)
    const rend = rendRef.current;
    if (rend) {
      const world  = rend.screenToWorld(px, py);
      const hit    = rend.pickNode(world.x, world.y, 20 / camRef.current.zoom) ?? -1;
      if (hit !== hoveredNodeRef.current) {
        hoveredNodeRef.current = hit;
        rend.setHoveredNode(hit);
        dirtyRef.current.hover = true;
        // Update tooltip state (convert canvas pixels to CSS pixels for positioning)
        if (hit >= 0) {
          const rect = canvas.getBoundingClientRect();
          const cssX = (px / (canvas.width / rect.width));
          const cssY = (py / (canvas.height / rect.height));
          const name = nodeNamesRef.current.get(hit) ?? '';
          setHoveredNode({ id: hit, name, screenX: cssX, screenY: cssY });
        } else {
          setHoveredNode(null);
        }
      }
      if (d.mode === 'none') {
        canvas.style.cursor = hit >= 0 ? 'pointer' : 'grab';
      } else if (d.mode === 'node') {
        canvas.style.cursor = 'grabbing';
      } else {
        canvas.style.cursor = 'grabbing';
      }
    }

    if (d.mode === 'none') return;

    const dx = px - d.startPx;
    const dy = py - d.startPy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;

    if (d.mode === 'camera') {
      const zoom = camRef.current.zoom;
      camRef.current.x = d.camStartX - dx / zoom;
      camRef.current.y = d.camStartY - dy / zoom;
    } else if (d.mode === 'node') {
      const world = rend?.screenToWorld(px, py);
      if (!world) return;
      post({ type: 'dragMove', nodeId: d.nodeId, x: world.x, y: world.y });
      // Also override locally so drag feels instant (before next worker frame)
      rend?.overridePosition(d.nodeId, world.x, world.y);
    }
  }, [post]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;

    if (d.mode === 'node') {
      post({ type: 'dragEnd', nodeId: d.nodeId });
      if (!d.moved) {
        // It was a tap/click — select node and fire the callback
        const nodeId = d.nodeId;
        selectedRef.current = nodeId;
        setSelectedNodeId(nodeId);
        rendRef.current?.setSelectedNode(nodeId);
        dirtyRef.current.hover = true;
        optsRef.current.onNodeClick?.(nodeId);
      }
    } else if (d.mode === 'camera' && !d.moved) {
      // Click on empty space — deselect and notify parent
      if (selectedRef.current >= 0) {
        selectedRef.current = -1;
        setSelectedNodeId(-1);
        rendRef.current?.setSelectedNode(-1);
        dirtyRef.current.hover = true;
      }
      optsRef.current.onEmptyClick?.();
    }
    d.mode   = 'none';
    d.nodeId = -1;
    d.moved  = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, [post]);

  // Zoom with wheel
  const onDblClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const rend   = rendRef.current;
    if (!canvas || !rend) return;
    const rect = canvas.getBoundingClientRect();
    const px   = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const py   = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const world = rend.screenToWorld(px, py);
    const hit   = rend.pickNode(world.x, world.y, 20 / camRef.current.zoom);
    if (hit !== null && hit !== undefined && hit >= 0) {
      optsRef.current.onNodeDblClick?.(hit);
    }
  }, [canvasRef]);

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

  const pause = useCallback(() => {
    post({ type: 'pause' });
  }, [post]);

  const resume = useCallback(() => {
    post({ type: 'resume' });
  }, [post]);

  const setConfig = useCallback((cfg: Partial<SGEConfig>) => {
    post({ type: 'setConfig', config: cfg });
  }, [post]);

  const recenter = useCallback(() => {
    const rend = rendRef.current;
    const canvas = canvasRef.current;
    if (!rend || !canvas) return;
    const n = rend.nodeOrder.length;
    if (n === 0) return;

    // Compute AABB from live physics positions
    const pos = rend.nodePositions;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    const cx  = (minX + maxX) / 2;
    const cy  = (minY + maxY) / 2;
    const pad = 60 * devicePixelRatio; // pixels
    const worldW = (maxX - minX) + 32; // add rough node radius margin
    const worldH = (maxY - minY) + 32;

    let zoom = 1;
    if (worldW > 0 && worldH > 0) {
      zoom = Math.min(
        (canvas.width  - pad * 2) / worldW,
        (canvas.height - pad * 2) / worldH,
      );
    }
    camRef.current.x    = cx;
    camRef.current.y    = cy;
    camRef.current.zoom = Math.max(0.02, Math.min(zoom, 40));
    dirtyRef.current.camera = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    return rendRef.current?.screenToWorld(sx, sy) ?? { x: 0, y: 0 };
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    const cam = camRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Convert screen-pixel delta to world-space delta
    const dpr = devicePixelRatio;
    cam.x -= (dx * dpr) / cam.zoom;
    cam.y += (dy * dpr) / cam.zoom;
    dirtyRef.current.camera = true;
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const cam = camRef.current;
    cam.zoom *= factor;
    cam.zoom = Math.max(0.02, Math.min(cam.zoom, 40));
    dirtyRef.current.camera = true;
  }, []);

  const clearSelection = useCallback(() => {
    selectedRef.current = -1;
    setSelectedNodeId(-1);
    dirtyRef.current.hover = true;
  }, []);

  return {
    canvasRef: canvasRef as React.RefObject<HTMLCanvasElement | null>,
    labelCanvasRef,
    selectedNodeId,
    hoveredNode,
    stats,
    reheat,
    pause,
    resume,
    setConfig,
    recenter,
    panBy,
    zoomBy,
    clearSelection,
    screenToWorld,
    // Expose interaction handlers so the component can attach them to the canvas
    // (returned as extra fields consumed by SGEGraphView)
    _pointerDown:  onPointerDown,
    _pointerMove:  onPointerMove,
    _pointerUp:    onPointerUp,
    _wheel:        onWheel,
    _dblClick:     onDblClick,
  } as GraphRendererHandle & {
    _pointerDown:  React.PointerEventHandler<HTMLCanvasElement>;
    _pointerMove:  React.PointerEventHandler<HTMLCanvasElement>;
    _pointerUp:    React.PointerEventHandler<HTMLCanvasElement>;
    _wheel:        React.WheelEventHandler<HTMLCanvasElement>;
    _dblClick:     React.MouseEventHandler<HTMLCanvasElement>;
  };
}
