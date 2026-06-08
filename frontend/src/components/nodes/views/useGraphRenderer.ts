/**
 * useGraphRenderer
 *
 * React hook that wires together:
 *   • The SGE physics Web Worker (sgeWorker.ts)
 *   • The WebGL2 renderer (graphWebGLRenderer.ts)
 *   • Camera pan / zoom interaction
 *   • Node drag interaction
 *   • 60-fps render loop (requestAnimationFrame)
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { GraphWebGLRenderer, type NodeVisual, getCssEdgeColor, getCssEdgeCooccurrenceColor, getCssEdgePathColor, getCssNodePathColor } from './graphWebGLRenderer';
import type { SGEPhysicsConfig } from './sge';
import type { GraphNode, GraphLink } from './viewTypes';
import { LINK_TYPE_IDS, LINK_TYPE_CURVATURE } from './graphConstants';

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
  return undefined;
}

// ─── CSS label colour cache (theme-reactive) ──────────────────────────────────

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
  if (!hex) return fallback;
  const c = hex.replace('#', '');
  let r = 0, g = 0, b = 0;
  if (c.length === 3) {
    r = parseInt(c[0] + c[0], 16);
    g = parseInt(c[1] + c[1], 16);
    b = parseInt(c[2] + c[2], 16);
  } else if (c.length >= 6) {
    r = parseInt(c.slice(0, 2), 16);
    g = parseInt(c.slice(2, 4), 16);
    b = parseInt(c.slice(4, 6), 16);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function getLabelRegularColor(): string {
  _ensureLabelThemeObserver();
  if (!labelColorCache.regular) {
    labelColorCache.regular = _hexVarToRgba('--color-on-surface', 0.85, 'rgba(220,220,220,0.85)');
  }
  return labelColorCache.regular;
}

function getLabelEmphasisColor(): string {
  _ensureLabelThemeObserver();
  if (!labelColorCache.emphasis) {
    labelColorCache.emphasis = _hexVarToRgba('--color-on-surface', 1.0, 'rgba(240,240,240,1.0)');
  }
  return labelColorCache.emphasis;
}

function getLabelShadowColor(): string {
  _ensureLabelThemeObserver();
  if (!labelColorCache.shadow) {
    labelColorCache.shadow = _hexVarToRgba('--color-surface', 0.9, 'rgba(18,18,18,0.9)');
  }
  return labelColorCache.shadow;
}

function nodeRadius(n: GraphNode, maxConn: number, base: number): number {
  if (maxConn <= 0) return base;
  const scale = 1 + (n.connectionCount / maxConn) * 0.6;
  return base * scale;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GraphRendererStats {
  nodeCount: number;
  edgeCount: number;
  visibleNodes: number;
  visibleEdges: number;
  arrowInstCount: number;
  glowInstCount: number;
  energy: number;
  ticks: number;
  fps: number;
}

export interface GraphRendererOptions {
  /** Graph nodes to display. */
  nodes: GraphNode[];
  /** Graph edges. */
  edges: GraphLink[];
  /** Semantic physics preset + toggles. */
  config?: SGEPhysicsConfig;
  /** Scale node radius by connection count. Default: true */
  sizeByConnections?: boolean;
  /** Base node radius in world units. Default: 7 */
  baseNodeRadius?: number;
  /** Node IDs on a highlighted path. */
  pathNodeIds?: Set<number>;
  /** Edge keys on a highlighted path. */
  pathEdgeKeys?: Set<string>;
  /** Callback when user clicks a node (no drag involved). */
  onNodeClick?: (nodeId: number) => void;
  /** Callback when user double-clicks a node. */
  onNodeDblClick?: (nodeId: number) => void;
  /** Callback when user clicks on empty space. */
  onEmptyClick?: () => void;
  /** Enable curved edges. Default: true. */
  curvedEdges?: boolean;
  /** Enable colored edge gradients. Default: true. */
  coloredEdges?: boolean;
  /** Enable tapered edge widths. Default: true. */
  taperedEdges?: boolean;
  /** Enable link-type LOD based on zoom. Default: true. */
  enableLinkLOD?: boolean;
}

export interface GraphRendererHandle {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  labelCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  stats: GraphRendererStats;
  selectedNodeId: number;
  hoveredNode: { id: number; name: string; screenX: number; screenY: number } | null;
  hoveredEdge: { source: number; target: number; type: string; screenX: number; screenY: number } | null;
  pause: () => void;
  resume: () => void;
  setConfig: (cfg: SGEPhysicsConfig) => void;
  recenter: () => void;
  panBy: (dx: number, dy: number) => void;
  zoomBy: (factor: number) => void;
  clearSelection: () => void;
  screenToWorld: (x: number, y: number) => { x: number; y: number };
}

const BASE_RADIUS = 7;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGraphRenderer(opts: GraphRendererOptions): GraphRendererHandle {
  const { nodes, edges, config, sizeByConnections = true, baseNodeRadius = BASE_RADIUS,
    curvedEdges = true, coloredEdges = false, taperedEdges = false, enableLinkLOD: _enableLinkLOD,
    pathNodeIds, pathEdgeKeys } = opts;

  const canvasRef  = useRef<HTMLCanvasElement | null>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendRef    = useRef<GraphWebGLRenderer | null>(null);
  const workerRef  = useRef<Worker | null>(null);
  const rafRef     = useRef<number>(0);
  const optsRef    = useRef(opts);

  // SharedArrayBuffer shared-memory path
  const sabPosRef    = useRef<Float32Array  | null>(null);
  const sabMetaI32   = useRef<Int32Array    | null>(null);
  const sabMetaF32   = useRef<Float32Array  | null>(null);
  const sabNodeIds   = useRef<Int32Array    | null>(null);
  const sabSeq       = useRef<number>(0);

  const camRef = useRef({ x: 0, y: 0, zoom: 1 });

  const hoveredNodeRef = useRef(-1);
  const selectedRef    = useRef(-1);
  const [selectedNodeId, setSelectedNodeId] = useState<number>(-1);
  const [hoveredNode, setHoveredNode] = useState<{ id: number; name: string; screenX: number; screenY: number } | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<{ source: number; target: number; type: string; screenX: number; screenY: number } | null>(null);

  const nodeNamesRef = useRef(new Map<number, string>());
  const nodeRadiiRef = useRef(new Map<number, number>());

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

  const [stats, setStats] = useState<GraphRendererStats>({
    nodeCount: 0, edgeCount: 0, visibleNodes: 0, visibleEdges: 0,
    arrowInstCount: 0, glowInstCount: 0,
    energy: 0, ticks: 0, fps: 0,
  });

  const statsAccRef = useRef({ energy: 0, ticks: 0 });
  const fpsRef      = useRef({ frames: 0, last: performance.now() });

  const needsAutoFitRef = useRef(false);

  const dirtyRef = useRef({
    positions: false,
    camera: false,
    hover: false,
    lastCamX: 0, lastCamY: 0, lastCamZoom: 1,
    lastFontZoom: -1,
    cachedFont: '',
  });

  useEffect(() => { optsRef.current = opts; }, [opts]);

  // ─── Post-to-worker helper ──────────────────────────────────────────────────
  const post = useCallback((msg: Record<string, unknown>): void => {
    workerRef.current?.postMessage(msg);
  }, []);

  // ─── Renderer + worker init ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    {
      const rect = canvas.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      canvas.width  = Math.round(rect.width  * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }

    const renderer = new GraphWebGLRenderer({ cullMargin: 200 });
    renderer.init(canvas);
    rendRef.current = renderer;

    const worker = new Worker(
      new URL('./sgeWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    const autoFit = (pos: Float32Array, nn: number): void => {
      const c = canvasRef.current;
      if (!c) return;
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
        ? Math.min((c.width - pad * 2) / worldW, (c.height - pad * 2) / worldH, 40)
        : 1;
    };

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ready') {
        statsAccRef.current.energy = 0;
        statsAccRef.current.ticks = 0;
        return;
      }

      if (msg.type === 'sharedBuffer') {
        sabPosRef.current  = new Float32Array(msg.positions);
        sabMetaI32.current = new Int32Array(msg.meta);
        sabMetaF32.current = new Float32Array(msg.meta);
        sabNodeIds.current = msg.nodeIds;
        sabSeq.current     = Atomics.load(sabMetaI32.current, 0);
        return;
      }

      if (msg.type === 'frame') {
        renderer.updatePositions(msg.positions, msg.nodeIds);
        statsAccRef.current.energy = msg.energy;
        statsAccRef.current.ticks = msg.ticks;
        dirtyRef.current.positions = true;
        if (needsAutoFitRef.current && msg.nodeCount > 0) {
          needsAutoFitRef.current = false;
          autoFit(msg.positions, msg.nodeCount);
        }
      }
    };

    worker.onerror = (e) => console.error('[SGEWorker]', e);

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const rend = rendRef.current;
      if (!rend) return;

      // SAB poll
      const metaI32 = sabMetaI32.current;
      const metaF32 = sabMetaF32.current;
      const sabPos = sabPosRef.current;
      const sabNids = sabNodeIds.current;
      if (metaI32 && metaF32 && sabPos && sabNids) {
        const seq = Atomics.load(metaI32, 0);
        if (seq !== sabSeq.current) {
          sabSeq.current = seq;
          const n = Atomics.load(metaI32, 1);
          rend.updatePositions(sabPos.subarray(0, n * 2), sabNids.subarray(0, n));
          statsAccRef.current.energy = metaF32[3];
          statsAccRef.current.ticks = Atomics.load(metaI32, 2);
          dirtyRef.current.positions = true;
          if (needsAutoFitRef.current && n > 0) {
            needsAutoFitRef.current = false;
            autoFit(sabPos, n);
          }
        }
      }

      const cam   = camRef.current;
      const dirty = dirtyRef.current;

      if (cam.x !== dirty.lastCamX || cam.y !== dirty.lastCamY || cam.zoom !== dirty.lastCamZoom) {
        dirty.camera   = true;
        dirty.lastCamX = cam.x;
        dirty.lastCamY = cam.y;
        dirty.lastCamZoom = cam.zoom;
      }

      const needsRender = dirty.positions || dirty.camera || dirty.hover;
      if (!needsRender) {
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
            energy: s.energy,
            ticks:  s.ticks,
            fps,
          }));
          fr.frames = 0;
          fr.last   = now;
        }
        return;
      }

      dirty.positions = false;
      dirty.camera    = false;
      dirty.hover     = false;

      rend.setCamera(cam.x, cam.y, cam.zoom);

      const lodEnabled = optsRef.current.enableLinkLOD ?? true;
      if (lodEnabled) {
        const z = cam.zoom;
        let mask = (1 << LINK_TYPE_IDS.parent) | (1 << LINK_TYPE_IDS.class) | (1 << LINK_TYPE_IDS.extends) | (1 << LINK_TYPE_IDS.alias);
        if (z >= 0.30) mask |= (1 << LINK_TYPE_IDS.reference);
        if (z >= 0.60) mask |= (1 << LINK_TYPE_IDS['property-reference']);
        if (z >= 1.00) mask |= (1 << LINK_TYPE_IDS.cooccurrence) | (1 << LINK_TYPE_IDS.temporal);
        rend.setEdgeMask(mask);
      } else {
        rend.setEdgeMask(0xFFFFFFFF);
      }

      rend.render();

      const lc = labelCanvasRef.current;
      if (lc) {
        const ctx = lc.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, lc.width, lc.height);
          const zoom = cam.zoom;
          if (zoom >= 0.12 && rend.nodeOrder.length > 0) {
            const pos   = rend.nodePositions;
            const order = rend.nodeOrder;
            const names = nodeNamesRef.current;
            const n     = order.length;
            const dpr   = window.devicePixelRatio || 1;

            const fontSize  = Math.round(Math.min(14, Math.max(9, 11 * zoom)) * dpr);
            if (dirty.lastFontZoom !== fontSize) {
              dirty.lastFontZoom = fontSize;
              dirty.cachedFont   = `${fontSize}px system-ui, -apple-system, sans-serif`;
            }
            const labelAlpha = Math.min(1, (zoom - 0.12) / 0.35);
            const maxLabels = zoom < 0.3 ? 40 : zoom < 0.6 ? 100 : zoom < 1.0 ? 200 : 500;

            ctx.save();
            ctx.globalAlpha  = labelAlpha;
            ctx.font         = dirty.cachedFont;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'top';
            ctx.shadowColor   = getLabelShadowColor();
            ctx.shadowBlur    = 4 * dpr;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;

            const cw      = lc.width;
            const ch      = lc.height;
            const margin  = 100;
            let rendered  = 0;

            ctx.fillStyle = getLabelRegularColor();
            for (let i = 0; i < n && rendered < maxLabels; i++) {
              const id = order[i];
              if (id === selectedRef.current || id === hoveredNodeRef.current) continue;
              const name = names.get(id);
              if (!name) continue;

              const wx = pos[i * 2];
              const wy = pos[i * 2 + 1];
              const sp = rend.worldToScreen(wx, wy);
              const sx = sp.x;
              const sy = sp.y;

              if (sx < -margin || sx > cw + margin || sy < -40 || sy > ch + 40) continue;

              const baseR = optsRef.current.baseNodeRadius ?? BASE_RADIUS;
              const worldRadius = nodeRadiiRef.current.get(id) ?? baseR;
              const screenRadius = worldRadius * zoom * dpr;
              const labelOffset = screenRadius + 4 * dpr;

              const label = name.length > 28 ? name.slice(0, 27) + '\u2026' : name;
              ctx.fillText(label, sx, sy + labelOffset);
              rendered++;
            }

            if (hoveredNodeRef.current >= 0 && hoveredNodeRef.current !== selectedRef.current) {
              const hIdx = rend.nodeOrder.indexOf(hoveredNodeRef.current);
              if (hIdx >= 0) {
                const hName = names.get(hoveredNodeRef.current);
                if (hName) {
                  const sx = rend.worldToScreen(pos[hIdx * 2], pos[hIdx * 2 + 1]).x;
                  const sy = rend.worldToScreen(pos[hIdx * 2], pos[hIdx * 2 + 1]).y;
                  const baseR = optsRef.current.baseNodeRadius ?? BASE_RADIUS;
                  const worldRadius = nodeRadiiRef.current.get(hoveredNodeRef.current) ?? baseR;
                  const screenRadius = worldRadius * zoom * dpr;
                  const labelOffset = screenRadius + 4 * dpr;
                  ctx.fillStyle = getLabelEmphasisColor();
                  const label = hName.length > 28 ? hName.slice(0, 27) + '\u2026' : hName;
                  ctx.fillText(label, sx, sy + labelOffset);
                }
              }
            }

            if (selectedRef.current >= 0) {
              const sIdx = rend.nodeOrder.indexOf(selectedRef.current);
              if (sIdx >= 0) {
                const sName = names.get(selectedRef.current);
                if (sName) {
                  const sx = rend.worldToScreen(pos[sIdx * 2], pos[sIdx * 2 + 1]).x;
                  const sy = rend.worldToScreen(pos[sIdx * 2], pos[sIdx * 2 + 1]).y;
                  const baseR = optsRef.current.baseNodeRadius ?? BASE_RADIUS;
                  const worldRadius = nodeRadiiRef.current.get(selectedRef.current) ?? baseR;
                  const screenRadius = worldRadius * zoom * dpr;
                  const labelOffset = screenRadius + 4 * dpr;
                  ctx.fillStyle = getLabelEmphasisColor();
                  const label = sName.length > 28 ? sName.slice(0, 27) + '\u2026' : sName;
                  ctx.fillText(label, sx, sy + labelOffset);
                }
              }
            }

            ctx.restore();
          }
        }
      }

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
      worker.postMessage({ type: 'destroy' });
      worker.terminate();
      workerRef.current = null;
      renderer.destroy();
      rendRef.current = null;
    };
  }, []);

  // ─── Canvas resize observer ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.round(width  * dpr);
        canvas.height = Math.round(height * dpr);
        rendRef.current?.resize(canvas.width, canvas.height);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ─── Topology sync: nodes + edges → physics + renderer ──────────────────────
  const topoFingerprintRef = useRef('');
  const topoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const renderer = rendRef.current;
    if (!renderer) return;

    const nodeIdStr = nodes.map(n => n.id).join(',');
    const edgeStr   = edges.map(e => `${e.source}-${e.target}`).join(',');
    const pathNodeStr = pathNodeIds ? [...pathNodeIds].sort().join(',') : '';
    const pathEdgeStr = pathEdgeKeys ? [...pathEdgeKeys].sort().join(',') : '';
    const fingerprint = `${nodeIdStr}|${edgeStr}|${sizeByConnections}|${baseNodeRadius}|${curvedEdges}|${coloredEdges}|${taperedEdges}|${pathNodeStr}|${pathEdgeStr}`;

    if (fingerprint === topoFingerprintRef.current) return;
    topoFingerprintRef.current = fingerprint;

    if (topoTimerRef.current) clearTimeout(topoTimerRef.current);

    topoTimerRef.current = setTimeout(() => {
      topoTimerRef.current = null;

      const maxConn = nodes.reduce((m, n) => Math.max(m, n.connectionCount), 0);

      const COOCCURRENCE_COLOR = getCssEdgeCooccurrenceColor();
      const maxCooccurrenceWeight = Math.max(
        ...edges.filter(e => e.type === 'cooccurrence').map(e => e.weight ?? 1),
        1
      );

      const nodeColorMap = new Map<number, [number, number, number, number]>();
      for (const n of nodes) {
        const c = nodeColor(n);
        if (c) nodeColorMap.set(n.id, [c[0], c[1], c[2], c[3]]);
      }
      const defaultEdgeColor = getCssEdgeColor();

      const PATH_EDGE_COLOR = getCssEdgePathColor();
      const physEdges = edges.map(e => {
        const edgeKey = `${Math.min(e.source, e.target)}-${Math.max(e.source, e.target)}`;
        const isPath = pathEdgeKeys?.has(edgeKey) ?? false;
        const srcColor = coloredEdges ? (nodeColorMap.get(e.source) ?? defaultEdgeColor) : undefined;
        const tgtColor = coloredEdges ? (nodeColorMap.get(e.target) ?? defaultEdgeColor) : undefined;
        const baseWidth = e.type === 'cooccurrence'
          ? 0.8 + 2.0 * ((e.weight ?? 1) / maxCooccurrenceWeight)
          : e.type === 'parent' || e.type === 'extends' ? 2.0
          : e.type === 'class' ? 1.2
          : 1.0;
        return {
          source: e.source,
          target: e.target,
          type: e.type,
          dashed: false,
          color: (!coloredEdges && e.type === 'cooccurrence') ? COOCCURRENCE_COLOR : undefined,
          colorSrc: isPath ? PATH_EDGE_COLOR : (coloredEdges ? srcColor : undefined),
          colorTgt: isPath ? PATH_EDGE_COLOR : (coloredEdges ? tgtColor : undefined),
          width: isPath ? baseWidth * 1.6 : (taperedEdges ? baseWidth : baseWidth * 0.8),
          curvature: curvedEdges ? (LINK_TYPE_CURVATURE[e.type] ?? 0.0) : 0.0,
          linkType: LINK_TYPE_IDS[e.type] ?? 0,
        };
      });

      const PATH_COLOR = getCssNodePathColor();

      const visuals = new Map<number, NodeVisual>();
      for (const n of nodes) {
        const isPath = pathNodeIds?.has(n.id) ?? false;
        visuals.set(n.id, {
          radius: sizeByConnections ? nodeRadius(n, maxConn, baseNodeRadius) : baseNodeRadius,
          color: isPath ? PATH_COLOR : nodeColor(n),
        });
      }

      const idArr = new Int32Array(nodes.map(n => n.id));
      renderer.setNodeVisuals(idArr, visuals);
      renderer.setEdges(physEdges);

      const names = nodeNamesRef.current;
      names.clear();
      const radii = nodeRadiiRef.current;
      radii.clear();
      for (const n of nodes) {
        names.set(n.id, n.displayName || n.name || String(n.id));
        radii.set(n.id, sizeByConnections ? nodeRadius(n, maxConn, baseNodeRadius) : baseNodeRadius);
      }

      const physNodes = nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
      workerRef.current?.postMessage({ type: 'init', nodes: physNodes, edges, config });

      if (nodes.length > 0) {
        needsAutoFitRef.current = true;
      }

      setStats(prev => ({ ...prev, nodeCount: nodes.length, edgeCount: edges.length }));
    }, 30);

    return () => {
      if (topoTimerRef.current) {
        clearTimeout(topoTimerRef.current);
        topoTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, sizeByConnections, baseNodeRadius, curvedEdges, coloredEdges, taperedEdges, pathNodeIds, pathEdgeKeys]);

  // ─── Visual-only updates (radius, color) ────────────────────────────────────
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
  }, [nodes, baseNodeRadius, sizeByConnections]);

  // ─── Label canvas resize observer ─────────────────────────────────────────
  useEffect(() => {
    const lc = labelCanvasRef.current;
    if (!lc) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        lc.width  = Math.round(width  * dpr);
        lc.height = Math.round(height * dpr);
      }
    });
    ro.observe(lc);
    return () => ro.disconnect();
  }, []);

  // ─── DPR change listener ──────────────────────────────────────────────────
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
      register();
    };

    const register = () => {
      if (mql && listener) mql.removeEventListener('change', listener);
      mql      = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      listener = applyDpr;
      mql.addEventListener('change', listener);
    };

    register();
    return () => { if (mql && listener) mql.removeEventListener('change', listener); };
  }, []);

  // ─── Pointer interaction ────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const canvas  = canvasRef.current!;
    const rect    = canvas.getBoundingClientRect();
    const px      = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const py      = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const world   = rendRef.current?.screenToWorld(px, py);
    if (!world) return;

    const hitNode = rendRef.current?.pickNode(world.x, world.y, 8 / camRef.current.zoom);

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
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d      = dragRef.current;
    const canvas = canvasRef.current!;
    const rect   = canvas.getBoundingClientRect();
    const px     = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const py     = (e.clientY - rect.top)  * (canvas.height / rect.height);

    const rend = rendRef.current;
    if (rend) {
      const world  = rend.screenToWorld(px, py);
      const hit    = rend.pickNode(world.x, world.y, 8 / camRef.current.zoom) ?? -1;
      if (hit !== hoveredNodeRef.current) {
        hoveredNodeRef.current = hit;
        rend.setHoveredNode(hit);
        dirtyRef.current.hover = true;
        if (hit >= 0) {
          const rect = canvas.getBoundingClientRect();
          const cssX = (px / (canvas.width / rect.width));
          const cssY = (py / (canvas.height / rect.height));
          const name = nodeNamesRef.current.get(hit) ?? '';
          setHoveredNode({ id: hit, name, screenX: cssX, screenY: cssY });
        } else {
          setHoveredNode(null);
        }
        setHoveredEdge(null);
        rend.setHoveredEdge(-1);
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
      rend?.overridePosition(d.nodeId, world.x, world.y);
      dirtyRef.current.positions = true;
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;

    if (d.mode === 'node') {
      post({ type: 'dragEnd', nodeId: d.nodeId });
      if (!d.moved) {
        const nodeId = d.nodeId;
        selectedRef.current = nodeId;
        setSelectedNodeId(nodeId);
        rendRef.current?.setSelectedNode(nodeId);
        dirtyRef.current.hover = true;
        optsRef.current.onNodeClick?.(nodeId);
      }
    } else if (d.mode === 'camera' && !d.moved) {
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
  }, []);

  const onDblClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const rend   = rendRef.current;
    if (!canvas || !rend) return;
    const rect = canvas.getBoundingClientRect();
    const px   = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const py   = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const world = rend.screenToWorld(px, py);
    const hit   = rend.pickNode(world.x, world.y, 8 / camRef.current.zoom);
    if (hit !== null && hit !== undefined && hit >= 0) {
      optsRef.current.onNodeDblClick?.(hit);
    }
  }, [canvasRef]);

  const onWheel = useCallback((e: WheelEvent) => {
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
    cam.zoom     = Math.min(cam.zoom, 40);
    cam.x       += (world.x - cam.x) * (1 - 1 / factor);
    cam.y       += (world.y - cam.y) * (1 - 1 / factor);
  }, []);

  // ─── Public API ─────────────────────────────────────────────────────────────
  const pause = useCallback(() => {
    workerRef.current?.postMessage({ type: 'pause' });
  }, []);

  const resume = useCallback(() => {
    workerRef.current?.postMessage({ type: 'resume' });
  }, []);

  const setConfig = useCallback((cfg: SGEPhysicsConfig) => {
    workerRef.current?.postMessage({ type: 'setConfig', config: cfg });
  }, []);

  const recenter = useCallback(() => {
    const rend = rendRef.current;
    const canvas = canvasRef.current;
    if (!rend || !canvas) return;
    const n = rend.nodeOrder.length;
    if (n === 0) return;

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
    const pad = 60 * devicePixelRatio;
    const worldW = (maxX - minX) + 32;
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
    camRef.current.zoom = Math.min(zoom, 40);
    dirtyRef.current.camera = true;
  }, []);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    return rendRef.current?.screenToWorld(sx, sy) ?? { x: 0, y: 0 };
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    const cam = camRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = devicePixelRatio;
    cam.x -= (dx * dpr) / cam.zoom;
    cam.y += (dy * dpr) / cam.zoom;
    dirtyRef.current.camera = true;
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const cam = camRef.current;
    cam.zoom *= factor;
    cam.zoom = Math.min(cam.zoom, 40);
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
    hoveredEdge,
    stats,
    pause,
    resume,
    setConfig,
    recenter,
    panBy,
    zoomBy,
    clearSelection,
    screenToWorld,
    _pointerDown:  onPointerDown,
    _pointerMove:  onPointerMove,
    _pointerUp:    onPointerUp,
    _wheel:        onWheel,
    _dblClick:     onDblClick,
  } as GraphRendererHandle & {
    _pointerDown:  React.PointerEventHandler<HTMLCanvasElement>;
    _pointerMove:  React.PointerEventHandler<HTMLCanvasElement>;
    _pointerUp:    React.PointerEventHandler<HTMLCanvasElement>;
    _wheel:        (e: WheelEvent) => void;
    _dblClick:     React.MouseEventHandler<HTMLCanvasElement>;
  };
}
