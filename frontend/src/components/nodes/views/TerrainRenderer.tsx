/**
 * TerrainRenderer Component
 *
 * Renders the terrain visualization with contour lines and coloured plateau fills.
 * Uses useNodePhysics hook for CPU physics simulation.
 * Contour lines are rendered by TerrainWebGLRenderer (GPU, analytical iso-lines).
 * Handles:
 * - Height map generation from node mass/positions (stamps + ridges + blur)
 * - GPU texture upload: height map (R32F), ownership colour (RGBA8), selection mask (R8)
 * - Plateau-based hit testing for click/hover (CPU owner-map)
 * - Mouse interactions (pan, zoom, click)
 * - Overlay canvas: crosshair, hover labels, selection outlines
 * - Reference path A* routing (drawn on the 2D ref-path canvas)
 */

import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { TerrainWebGLRenderer } from './terrainWebGLRenderer';
import type { TerrainCameraState } from './terrainWebGLRenderer';
import { Card } from '../../core/Card';
import type {
  GraphNode,
  GraphLink,
  GraphSettings,
  VisibilityFilters,
  ClassColor,
  Dimensions,
} from './viewTypes';
import {
  // Constants
  CONTOUR_LEVELS,
  TERRAIN_GRID_RES,
  TERRAIN_BASE_PLATEAU_RADIUS,
  TERRAIN_PEAK_PLATEAU_BONUS,
  TERRAIN_BASE_SLOPE_RADIUS,
  TERRAIN_PEAK_SLOPE_RADIUS_BONUS,
  TERRAIN_ANISOTROPY,
  TERRAIN_NOISE_STRENGTH,
  TERRAIN_SLOPE_POWER,
  TERRAIN_RIDGE_HEIGHT_FACTOR,
  TERRAIN_RIDGE_WIDTH,
  TERRAIN_RIDGE_FALLOFF_POWER,
  TERRAIN_RIDGE_SAG,
  TERRAIN_REF_PATH_KE_THRESHOLD,
  TERRAIN_SLEEP_THRESHOLD,
  // Helpers
  getNodeColor,
} from './viewTypes';
import { useNodePhysics } from './useNodePhysics';
import { computeReferencePaths, applyPathErosion, type ReferencePath, type RefLink, type NodePeakInfo } from './terrainReferencePaths';
import './graph-renderer.css';

// ==================== Types ====================

export interface TerrainRendererProps {
  nodes: GraphNode[];
  links: GraphLink[];
  settings: GraphSettings;
  visibilityFilters: VisibilityFilters;
  classColors: ClassColor[];
  selectedNodeIds: number[];
  currentNodeId: number | null;
  onNodeClick?: (node: GraphNode, modifiers: { shiftKey: boolean; ctrlKey: boolean }) => void;
  onNodeDoubleClick?: (node: GraphNode) => void;
  onNodeRightClick?: (node: GraphNode) => void;
  onSelectionChange?: (nodeIds: number[]) => void;
  onHoveredNodeChange?: (node: GraphNode | null) => void;
  className?: string;
}

export interface TerrainRendererRef {
  recenter: () => void;
  triggerCreationAnimation: () => void;
  createNode: (node: GraphNode) => void;
  destroyNode: (nodeId: number) => void;
  updateLinks: (links: GraphLink[]) => void;
  pauseSimulation: () => void;
  resumeSimulation: () => void;
  simulationPausedRef: React.MutableRefObject<boolean>;
}

// ==================== Helpers ====================

/** Fast integer hash for deterministic per-cell noise (no Math.random, stable across frames) */
const ihash = (a: number, b: number): number => {
  let h = (a * 374761393 + b * 668265263 + 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) & 0x7fffffff) / 0x7fffffff; // 0..1
};

// ==================== Per-Node Stamp System ====================
// Each node has a local height grid ("stamp") computed independently.
// Stamps are position-independent and cached — only recomputed when
// the node's height, peak size, grid resolution, or child directions change.
// Building the global height map is just blitting (MAX-merging) stamps
// onto the grid at each node's position, which is much cheaper than
// re-doing sqrt/atan2/pow/noise per cell every frame.

interface NodeStamp {
  /** Local height values (centered at cx,cy) */
  heights: Float32Array;
  /** Stamp dimensions in grid cells */
  w: number;
  h: number;
  /** Center offset in stamp-local coords (grid cells) */
  cx: number;
  cy: number;
}

/** Cache entry stores the stamp and the parameters it was computed for */
interface StampCacheEntry {
  stamp: NodeStamp;
  H: number;
  peakSize: number;
  gs: number;
  dirsHash: number;
}

/**
 * Quantize child directions into a stable hash.
 * Directions are snapped to 16 compass points so the cache stays
 * valid across small angular changes during simulation.
 */
const hashChildDirs = (dirs: Array<{nx: number, ny: number}>): number => {
  if (dirs.length === 0) return 0;
  let h = dirs.length * 97;
  for (const d of dirs) {
    // Quantize angle to 16 compass directions (22.5° steps)
    const angle = Math.round(Math.atan2(d.ny, d.nx) * 8 / Math.PI);
    h = (h * 31 + (angle + 8)) | 0; // +8 to avoid negatives
  }
  return h;
};

/**
 * Compute a height stamp for a single node.
 * The stamp is a local grid centered at (0,0) in grid-cell units.
 */
const computeNodeStamp = (
  nodeId: number,
  H: number,
  peakSize: number,
  gs: number,
  dirs: Array<{nx: number, ny: number}>,
): NodeStamp => {
  const Rp = (TERRAIN_BASE_PLATEAU_RADIUS + TERRAIN_PEAK_PLATEAU_BONUS * peakSize) / gs;
  const Rs = (TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_RADIUS_BONUS * peakSize) / gs;
  const RpSq = Rp * Rp;
  const RsSq = Rs * Rs;
  const invSlopeRangeSq = 1 / (RsSq - RpSq);
  const hasDirs = dirs.length > 0;

  // Stamp radius (in grid cells) — expanded for anisotropy
  const radius = Math.ceil(Rs * (hasDirs ? (1 + TERRAIN_ANISOTROPY) : 1));
  const w = radius * 2 + 1;
  const h = w; // square stamp
  const cx = radius;
  const cy = radius;
  const heights = new Float32Array(w * h);

  for (let sy = 0; sy < h; sy++) {
    const dy = sy - cy;
    const rowOff = sy * w;
    for (let sx = 0; sx < w; sx++) {
      const dx = sx - cx;
      let distSq = dx * dx + dy * dy;

      // Star-shaped: reduce effective distance when aligned with child directions
      if (hasDirs && distSq > 0.01) {
        const invDist = 1 / Math.sqrt(distSq);
        const udx = dx * invDist;
        const udy = dy * invDist;
        let maxAlign = 0;
        for (let d = 0; d < dirs.length; d++) {
          const dot = udx * dirs[d].nx + udy * dirs[d].ny;
          if (dot > maxAlign) maxAlign = dot;
        }
        if (maxAlign > 0.4) {
          const ramp = (maxAlign - 0.4) / 0.6;
          const shrink = 1 / (1 + TERRAIN_ANISOTROPY * ramp * ramp);
          distSq *= shrink * shrink;
        }
      }

      if (distSq > RsSq) continue;

      // Angular noise for organic shape
      if (TERRAIN_NOISE_STRENGTH > 0 && distSq > 0.01) {
        const ang = Math.atan2(dy, dx);
        const n1 = ihash(nodeId, Math.floor(ang * 3 + 100)) * 2 - 1;
        const n2 = ihash(nodeId, Math.floor(ang * 7 + 200)) * 2 - 1;
        const noise = (n1 * 0.7 + n2 * 0.3) * TERRAIN_NOISE_STRENGTH;
        distSq *= (1 + noise) * (1 + noise);
      }

      const ndSq = distSq <= RpSq ? 0 : (distSq - RpSq) * invSlopeRangeSq;
      const falloff = Math.pow(1 - ndSq, TERRAIN_SLOPE_POWER);
      heights[rowOff + sx] = H * falloff;
    }
  }

  return { heights, w, h, cx, cy };
};

// ==================== Component ====================

export const TerrainRenderer = forwardRef<TerrainRendererRef, TerrainRendererProps>(({
  nodes: inputNodes,
  links: inputLinks,
  settings,
  visibilityFilters,
  classColors,
  selectedNodeIds,
  currentNodeId,
  onNodeClick,
  onNodeDoubleClick,
  onNodeRightClick,
  onSelectionChange,
  onHoveredNodeChange,
  className = '',
}, ref) => {
  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Cursor screen position for crosshair + profiles (-1 = not hovering)
  const mouseScreenRef = useRef({ x: -1, y: -1 });
  
  // SVG profile path state
  const [profileXPath, setProfileXPath] = useState('');
  const [profileYPath, setProfileYPath] = useState('');
  const [profileXCursor, setProfileXCursor] = useState({ x: -1, visible: false });
  const [profileYCursor, setProfileYCursor] = useState({ y: -1, visible: false });
  const [profileXDots, setProfileXDots] = useState<Array<{ x: number; y: number; color: string; opacity: number }>>([]);
  const [profileYDots, setProfileYDots] = useState<Array<{ x: number; y: number; color: string; opacity: number }>>([]);
  
  // Node label state
  const [nodeLabels, setNodeLabels] = useState<Array<{ id: number; x: number; y: number; text: string; isSelected: boolean }>>([]);
  
  // Elevation tooltip state (shown near crosshair)
  const [elevationTooltip, setElevationTooltip] = useState<{ x: number; y: number; text: string; visible: boolean }>({ x: 0, y: 0, text: '', visible: false });
  
  // Profile SVG viewBox dimensions (computed based on actual dimensions)
  const [profileViewBoxX, setProfileViewBoxX] = useState({ width: 800, height: 48 });
  const [profileViewBoxY, setProfileViewBoxY] = useState({ width: 48, height: 600 });
  
  // State
  const [dimensions, setDimensions] = useState<Dimensions>({ width: 800, height: 600 });
  const dimensionsRef = useRef<Dimensions>({ width: 800, height: 600 });
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const overlaysVisibleRef = useRef(false);
  
  // Pan state
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const didDragMoveRef = useRef(false);
  const wasJustDraggingRef = useRef(false);
  
  // Click tracking
  const lastClickTimeRef = useRef(0);
  const lastClickedNodeRef = useRef<number | null>(null);
  
  // Selected node IDs ref for render access
  const selectedNodeIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    selectedNodeIdsRef.current = new Set(selectedNodeIds);
  }, [selectedNodeIds]);
  
  // Visibility filters ref for render access (render callback reads from refs)
  const visibilityFiltersRef = useRef(visibilityFilters);
  useEffect(() => {
    visibilityFiltersRef.current = visibilityFilters;
  }, [visibilityFilters]);
  
  // Reference path fade animation state
  const refPathOpacityRef = useRef(0);       // current opacity 0..1
  const refPathFadeRafRef = useRef(0);        // RAF id for fade animation
  const refPathLastFrameRef = useRef(0);      // last frame timestamp for delta time
  const REF_PATH_FADE_IN_SPEED = 2.5;        // per second (0→1 in 400ms)
  const REF_PATH_FADE_OUT_SPEED = 5.0;        // per second (1→0 in 200ms)
  
  // Physics hook
  const physics = useNodePhysics({
    inputNodes,
    inputLinks,
    viewMode: 'terrain',
    settings,
    visibilityFilters,
    classColors,
    selectedNodeIds,
    currentNodeId,
    dimensions,
    isTerrainMode: true,
  });
  
  // Destructure physics
  const {
    frameDataRef,
    transformRef,
    setTransformDirect,
    dragNodeRef,
    dragStartTimeRef,
    wakeSimulation,
    simulationSleepingRef,
    kineticEnergyRef,
    pauseSimulation,
    resumeSimulation,
    simulationPausedRef,
    ctxRef,
    renderRef,
    recenter,
    createNode,
    destroyNode,
    updateLinks,
    triggerCreationAnimation,
    screenToWorld,
    getNodeAtPosition,
    classColorsRef,
    cssVarsRef,
  } = physics;
  
  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    recenter,
    triggerCreationAnimation,
    createNode,
    destroyNode,
    updateLinks,
    pauseSimulation,
    resumeSimulation,
    simulationPausedRef,
  }), [recenter, triggerCreationAnimation, createNode, destroyNode, updateLinks, pauseSimulation, resumeSimulation]);
  
  // Overlay canvas for crosshair, hover labels, selected outlines (lightweight layer)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const renderOverlayRef = useRef<((ctx: CanvasRenderingContext2D) => void) | null>(null);
  
  // Profile card refs for direct DOM class toggling (avoids React re-render)
  const profileYCardRef = useRef<HTMLDivElement>(null);
  const profileXCardRef = useRef<HTMLDivElement>(null);
  
  // Helper: toggle overlay visibility via ref + DOM (no state update)
  const setOverlaysVisible = useCallback((visible: boolean) => {
    if (overlaysVisibleRef.current === visible) return;
    overlaysVisibleRef.current = visible;
    profileYCardRef.current?.classList.toggle('terrain-overlay--visible', visible);
    profileXCardRef.current?.classList.toggle('terrain-overlay--visible', visible);
  }, []);
  
  // Container resize
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          const dims = { width: w, height: h };
          dimensionsRef.current = dims;
          setDimensions(dims);
        }
      }
    });
    
    resizeObserver.observe(canvasRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // ── WebGL terrain renderer lifecycle ─────────────────────────────────
  // Initialise the WebGL2 renderer once when the webgl canvas mounts.
  // The renderer is destroyed on unmount to prevent WebGL context leaks.
  useEffect(() => {
    const canvas = webglCanvasRef.current;
    if (!canvas) return;
    let renderer: TerrainWebGLRenderer | null = null;
    try {
      renderer = new TerrainWebGLRenderer();
      renderer.init(canvas);
      terrainGLRef.current = renderer;
      // Force a cache invalidation so the next render re-uploads all textures
      terrainCacheRef.current.valid = false;
    } catch (err) {
      console.error('[TerrainWebGL] Failed to initialise WebGL2 renderer:', err);
    }
    return () => {
      renderer?.destroy();
      terrainGLRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the WebGL canvas backing-buffer in sync with the container size.
  useEffect(() => {
    const canvas = webglCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(dimensions.width  * dpr);
    const h = Math.round(dimensions.height * dpr);
    canvas.width  = w;
    canvas.height = h;
    terrainGLRef.current?.resize(w, h);
  }, [dimensions]);
  
  // ==================== Cached CSS Colors ====================
  
  // Cache CSS variables to avoid getComputedStyle every frame.
  // lowHex / highHex are the raw CSS strings passed directly to the WebGL
  // renderer as uniforms; the decomposed RGB fields are kept for reference-path
  // colour tinting on the Canvas 2D overlay.
  const cssColorsRef = useRef<{
    lowR: number; lowG: number; lowB: number;
    highR: number; highG: number; highB: number;
    lowHex: string; highHex: string;
  } | null>(null);
  const cssColorsDirtyRef = useRef(true);
  
  // Invalidate CSS cache on theme changes
  useEffect(() => {
    cssColorsDirtyRef.current = true;
    const observer = new MutationObserver(() => { cssColorsDirtyRef.current = true; });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => observer.disconnect();
  }, []);
  
  // Reusable typed-array buffers to avoid per-frame allocation
  const heightMapBufRef = useRef<Float32Array | null>(null);
  const tempMapBufRef = useRef<Float32Array | null>(null);
  const ownerMapRef = useRef<Int32Array | null>(null);
  // Per-cell highest single-node contribution (for ownership with additive heights)
  const maxContribRef = useRef<Float32Array | null>(null);

  // ── WebGL terrain renderer (GPU iso-contour lines) ────────────────────────
  const webglCanvasRef = useRef<HTMLCanvasElement>(null);
  const terrainGLRef   = useRef<TerrainWebGLRenderer | null>(null);

  // Time-throttle terrain rebuilds during active simulation
  const lastTerrainRebuildRef = useRef(0);
  
  // Hysteresis for resolution switching: prevents flickering between low-res
  // (during simulation) and full-res (when settled). Requires the simulation
  // to stay settled for a minimum duration before upgrading to full resolution.
  const terrainLowResRef = useRef(true);        // currently using low-res grid?
  const terrainSettledAtRef = useRef(0);          // timestamp when KE first dropped below threshold
  const HIRES_SETTLE_DELAY = 500;                 // ms energy must stay low before switching to full-res
  
  // Per-node stamp cache: nodeId → cached stamp + parameters
  const stampCacheRef = useRef(new Map<number, StampCacheEntry>());
  
  // Store grid dims + owner map for plateau hit testing
  const plateauGridRef = useRef({ gridW: 0, gridH: 0, gs: TERRAIN_GRID_RES, originX: 0, originY: 0 });
  
  // Hovered contour level index (-1 = none)
  const hoveredContourLevelRef = useRef(-1);
  
  // ==================== Terrain Cache ====================
  // Cache the expensive terrain computation (height map, contour chains, color map)
  // and only recompute when node positions, transform, or selection actually changed.
  
  // Snapshot of node positions + transform used to generate current cache.
  // GPU texture uploads happen inside the same cache-rebuild block so they are
  // also skipped when the cache is still valid (e.g. camera pan/zoom only).
  const terrainCacheRef = useRef<{
    positionHash: number;
    selectionHash: number;
    classColorsHash: number;
    gridW: number;
    gridH: number;
    gs: number;
    originX: number;
    originY: number;
    nodeChildDirs: Array<Array<{nx: number, ny: number}>>;
    idToIdx: Map<number, number>;
    nodeColors: Array<[number, number, number]>;
    lowR: number; lowG: number; lowB: number;
    highR: number; highG: number; highB: number;
    hasClassColors: boolean;
    hasSelection: boolean;
    selectedNodeIndices: Set<number>;
    referencePaths: ReferencePath[];
    heightMap: Float32Array | null;
    valid: boolean;
  }>({
    positionHash: 0, selectionHash: 0, classColorsHash: 0,
    gridW: 0, gridH: 0, gs: 4, originX: 0, originY: 0,
    nodeChildDirs: [], idToIdx: new Map(), nodeColors: [],
    lowR: 0, lowG: 0, lowB: 0, highR: 0, highG: 0, highB: 0,
    hasClassColors: false, hasSelection: false, selectedNodeIndices: new Set(),
    referencePaths: [],
    heightMap: null,
    valid: false,
  });
  
  // ==================== Render Function ====================
  
  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: w, height: h } = dimensionsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const t = transformRef.current;
    
    // Reset transform and clear full backing store, then apply DPR scale
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w * dpr, h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    const { visibleNodes } = frameDataRef.current;
    const terrainHeights = frameDataRef.current.terrainHeights;
    const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
    const { accentColor } = cssVarsRef.current;
    const currentClassColors = classColorsRef.current;
    
    // Skip contour rendering if not enough nodes
    if (visibleNodes.length < 2) {
      if (visibleNodes.length === 1) {
        const node = visibleNodes[0];
        const sx = node.x * t.scale + t.x;
        const sy = node.y * t.scale + t.y;
        const nodeColor = getNodeColor(node, currentClassColors, accentColor);
        const plateauR = TERRAIN_BASE_PLATEAU_RADIUS * t.scale;
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.fillStyle = nodeColor;
        ctx.arc(sx, sy, plateauR, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Label handled by DOM element now
      }
      terrainCacheRef.current.valid = false;
      return;
    }
    
    // Generate height field in world space — zoom/pan changes do NOT trigger recomputation.
    // Compute world-space bounding box of all visible nodes with padding for slope radii.
    let minWX = Infinity, maxWX = -Infinity, minWY = Infinity, maxWY = -Infinity;
    for (const node of visibleNodes) {
      if (node.x < minWX) minWX = node.x;
      if (node.x > maxWX) maxWX = node.x;
      if (node.y < minWY) minWY = node.y;
      if (node.y > maxWY) maxWY = node.y;
    }
    // Find maximum slope radius for bounding box padding
    let maxSlopeR = TERRAIN_BASE_SLOPE_RADIUS;
    for (const node of visibleNodes) {
      const ps = terrainPeakRadii.get(node.id) ?? 0;
      const sR = TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_RADIUS_BONUS * ps;
      if (sR > maxSlopeR) maxSlopeR = sR;
    }
    const worldPad = maxSlopeR * (1 + TERRAIN_ANISOTROPY) * 1.1;
    const originX = minWX - worldPad;
    const originY = minWY - worldPad;
    const worldW = Math.max(maxWX - minWX, 50) + worldPad * 2;
    const worldH = Math.max(maxWY - minWY, 50) + worldPad * 2;
    // Use coarser grid during active simulation for faster rebuilds.
    // Hysteresis prevents flickering: switch to low-res immediately when
    // simulation wakes, but require it to stay settled for HIRES_SETTLE_DELAY
    // before upgrading back to full resolution.
    const rawSimActive = !simulationSleepingRef.current && kineticEnergyRef.current >= TERRAIN_SLEEP_THRESHOLD;
    const now0 = performance.now();
    if (rawSimActive) {
      // Simulation is active → low-res immediately, reset settle timer
      terrainLowResRef.current = true;
      terrainSettledAtRef.current = 0;
    } else if (terrainLowResRef.current) {
      // Simulation just settled — start or continue the settle timer
      if (terrainSettledAtRef.current === 0) {
        terrainSettledAtRef.current = now0;
      } else if (now0 - terrainSettledAtRef.current >= HIRES_SETTLE_DELAY) {
        // Stayed settled long enough → upgrade to full resolution
        terrainLowResRef.current = false;
      }
    }
    const isSimActive = terrainLowResRef.current;
    let gs = isSimActive ? TERRAIN_GRID_RES * 2 : TERRAIN_GRID_RES;
    let gridW = Math.ceil(worldW / gs);
    let gridH = Math.ceil(worldH / gs);
    // Cap grid dimensions for performance
    const MAX_GRID_DIM = isSimActive ? 600 : 1200;
    if (gridW > MAX_GRID_DIM || gridH > MAX_GRID_DIM) {
      gs = Math.ceil(Math.max(worldW / MAX_GRID_DIM, worldH / MAX_GRID_DIM));
      gridW = Math.ceil(worldW / gs);
      gridH = Math.ceil(worldH / gs);
    }
    const gridSize = gridW * gridH;
    
    // ==================== Cache Validation ====================
    // Compute cheap hash of node world positions to detect changes.
    // Zoom/pan changes do NOT invalidate the cache — only node positions do.
    // During active simulation use a coarser snap so the expensive terrain
    // rebuild doesn't run every frame — contours appear immediately and
    // progressively sharpen as nodes settle.
    const posSnap = isSimActive ? gs * 8 : gs * 0.5;
    let positionHash = (visibleNodes.length * 97) | 0;
    for (let i = 0; i < visibleNodes.length; i++) {
      const n = visibleNodes[i];
      // Snap positions to half-grid-cell precision — finer changes are invisible
      positionHash = (positionHash * 31 + Math.round(n.x / posSnap)) | 0;
      positionHash = (positionHash * 31 + Math.round(n.y / posSnap)) | 0;
    }
    let selectionHash = 0;
    const selIdSet = selectedNodeIdsRef.current;
    const hasSelection = selIdSet.size > 0;
    if (hasSelection) {
      for (const id of selIdSet) selectionHash += id * 37;
    }
    let classColorsHash = currentClassColors.length;
    for (let i = 0; i < currentClassColors.length; i++) {
      classColorsHash += (currentClassColors[i].order ?? 0) * (i + 1);
    }
    
    const cache = terrainCacheRef.current;
    // Time-throttle rebuilds during active simulation: at most once per 150ms
    const now = performance.now();
    const MIN_REBUILD_INTERVAL = 150; // ms
    const throttled = isSimActive && (now - lastTerrainRebuildRef.current) < MIN_REBUILD_INTERVAL;
    const cacheValid = (cache.valid
      && cache.positionHash === positionHash
      && cache.selectionHash === selectionHash
      && cache.classColorsHash === classColorsHash
      && cache.gridW === gridW
      && cache.gridH === gridH)
      || (throttled && cache.valid);
    
    
    if (!cacheValid) {
      // ==================== Rebuild Terrain Cache ====================
    
      // Reuse typed-array buffers across frames
    if (!heightMapBufRef.current || heightMapBufRef.current.length < gridSize) {
      heightMapBufRef.current = new Float32Array(gridSize);
      tempMapBufRef.current = new Float32Array(gridSize);
      ownerMapRef.current = new Int32Array(gridSize);
      maxContribRef.current = new Float32Array(gridSize);
    }
    const heightMap = heightMapBufRef.current;
    const tempMap = tempMapBufRef.current!;
    const ownerMap = ownerMapRef.current!;
    heightMap.fill(0, 0, gridSize);
    ownerMap.fill(-1, 0, gridSize);
    
    // Per-node peak heights for plateau fill thresholds
    const nodePeakH: number[] = new Array(visibleNodes.length);
    
    // Store grid dims for hit testing
    plateauGridRef.current.gridW = gridW;
    plateauGridRef.current.gridH = gridH;
    plateauGridRef.current.gs = gs;
    plateauGridRef.current.originX = originX;
    plateauGridRef.current.originY = originY;
    
    // Precompute per-node anisotropy direction from parent links
    // Each node accumulates a stretch direction toward its parent/child connections
    const visibleLinks = frameDataRef.current.visibleLinks;
    // Build id → index lookup
    const idToIdx = new Map<number, number>();
    for (let i = 0; i < visibleNodes.length; i++) {
      idToIdx.set(visibleNodes[i].id, i);
    }
    
    // Build per-node child direction list for star-shaped plateau distortion
    // Each node stores normalized directions toward its children (in world space)
    const nodeChildDirs: Array<Array<{nx: number, ny: number}>> = new Array(visibleNodes.length);
    for (let i = 0; i < visibleNodes.length; i++) nodeChildDirs[i] = [];
    for (const link of visibleLinks) {
      if (link.type !== 'parent') continue;
      // link.source = parent, link.target = child
      const pi = idToIdx.get(link.source);
      const ci = idToIdx.get(link.target);
      if (pi === undefined || ci === undefined) continue;
      const pn = visibleNodes[pi];
      const cn = visibleNodes[ci];
      const ldx = cn.x - pn.x;
      const ldy = cn.y - pn.y;
      const llen = Math.sqrt(ldx * ldx + ldy * ldy);
      if (llen < 1) continue;
      nodeChildDirs[pi].push({ nx: ldx / llen, ny: ldy / llen });
      // Also stretch child toward parent
      nodeChildDirs[ci].push({ nx: -ldx / llen, ny: -ldy / llen });
    }
    
    // Build height map via per-node stamp cache + blit
    // Each node's height footprint is pre-computed into a local "stamp" grid.
    // Stamps are position-independent and cached — only recomputed when
    // the node's shape parameters (H, peakSize, gs, child directions) change.
    // Building the global height map additively merges stamps at each
    // node's position — overlapping peaks sum their heights, creating
    // natural saddles and ridges where nodes are close together.
    // Ownership is tracked by whichever node contributes the most at each cell.
    const stampCache = stampCacheRef.current;
    let nodeIdx = 0;
    for (const node of visibleNodes) {
      const H = terrainHeights.get(node.id) ?? 0;
      const peakSize = terrainPeakRadii.get(node.id) ?? 0;
      
      if (H <= 0) { nodeIdx++; continue; }
      nodePeakH[nodeIdx] = H;
      
      const dirs = nodeChildDirs[nodeIdx];
      const dirsHash = hashChildDirs(dirs);
      
      // Check stamp cache — reuse if shape parameters haven't changed
      let stamp: NodeStamp;
      const cached = stampCache.get(node.id);
      if (cached && cached.H === H && cached.peakSize === peakSize
          && cached.gs === gs && cached.dirsHash === dirsHash) {
        stamp = cached.stamp;
      } else {
        // Compute new stamp (expensive: sqrt/atan2/pow/noise per cell)
        stamp = computeNodeStamp(node.id, H, peakSize, gs, dirs);
        stampCache.set(node.id, { stamp, H, peakSize, gs, dirsHash });
      }
      
      // Blit stamp onto global height map at node's grid position (additive merge)
      const gxCenter = Math.round((node.x - originX) / gs);
      const gyCenter = Math.round((node.y - originY) / gs);
      const stampW = stamp.w;
      const stampH = stamp.h;
      const stampCx = stamp.cx;
      const stampCy = stamp.cy;
      const stampHeights = stamp.heights;
      
      // Global grid bounds for this stamp
      const gxStart = gxCenter - stampCx;
      const gyStart = gyCenter - stampCy;
      // Clamp to grid bounds
      const sxMin = Math.max(0, -gxStart);
      const syMin = Math.max(0, -gyStart);
      const sxMax = Math.min(stampW, gridW - gxStart);
      const syMax = Math.min(stampH, gridH - gyStart);
      
      for (let sy = syMin; sy < syMax; sy++) {
        const gy = gyStart + sy;
        const globalRowOff = gy * gridW;
        const stampRowOff = sy * stampW;
        for (let sx = sxMin; sx < sxMax; sx++) {
          const ht = stampHeights[stampRowOff + sx];
          if (ht <= 0) continue;
          const gx = gxStart + sx;
          const globalIdx = globalRowOff + gx;
          // MAX merge: tallest contribution wins
          if (ht > heightMap[globalIdx]) {
            heightMap[globalIdx] = ht;
            ownerMap[globalIdx] = nodeIdx;
          }
        }
      }
      nodeIdx++;
    }
    
    // Evict stamps for nodes no longer visible
    if (stampCache.size > visibleNodes.length * 2) {
      const visibleIds = new Set(visibleNodes.map(n => n.id));
      for (const id of stampCache.keys()) {
        if (!visibleIds.has(id)) stampCache.delete(id);
      }
    }
    
    // ==================== Ridge Stamps (Option A: Cordillera Connectivity) ====================
    // For each parent→child link, stamp a ridge connecting the two peaks.
    // Uses proper 2D distance-to-segment so ridges render cleanly at any angle.
    // Height along the spine lerps between peak heights with a catenary sag.
    const ridgeHalfWWorld = TERRAIN_RIDGE_WIDTH; // half-width in world units
    for (const link of visibleLinks) {
      if (link.type !== 'parent') continue;
      const pi = idToIdx.get(link.source);
      const ci = idToIdx.get(link.target);
      if (pi === undefined || ci === undefined) continue;
      const pn = visibleNodes[pi];
      const cn = visibleNodes[ci];
      const pH = terrainHeights.get(pn.id) ?? 0;
      const cH = terrainHeights.get(cn.id) ?? 0;
      if (pH <= 0 && cH <= 0) continue;
      
      // Edge vector in world coords
      const edx = cn.x - pn.x;
      const edy = cn.y - pn.y;
      const edgeLenSq = edx * edx + edy * edy;
      const edgeLen = Math.sqrt(edgeLenSq);
      if (edgeLen < 1) continue;
      
      // Ridge width tapers between the two peaks' slope radii
      const pPeakSize = terrainPeakRadii.get(pn.id) ?? 0;
      const cPeakSize = terrainPeakRadii.get(cn.id) ?? 0;
      const pSlopeW = (TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_RADIUS_BONUS * pPeakSize) * 0.45;
      const cSlopeW = (TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_RADIUS_BONUS * cPeakSize) * 0.45;
      const maxHalfW = Math.max(pSlopeW, cSlopeW, ridgeHalfWWorld);
      
      // Bounding box in grid coords (padded by max ridge width)
      const minWX2 = Math.min(pn.x, cn.x) - maxHalfW;
      const maxWX2 = Math.max(pn.x, cn.x) + maxHalfW;
      const minWY2 = Math.min(pn.y, cn.y) - maxHalfW;
      const maxWY2 = Math.max(pn.y, cn.y) + maxHalfW;
      const gxMin = Math.max(0, Math.floor((minWX2 - originX) / gs));
      const gxMax = Math.min(gridW - 1, Math.ceil((maxWX2 - originX) / gs));
      const gyMin = Math.max(0, Math.floor((minWY2 - originY) / gs));
      const gyMax = Math.min(gridH - 1, Math.ceil((maxWY2 - originY) / gs));
      
      for (let gy = gyMin; gy <= gyMax; gy++) {
        const wy = originY + gy * gs;
        const globalRowOff = gy * gridW;
        for (let gx = gxMin; gx <= gxMax; gx++) {
          const wx = originX + gx * gs;
          
          // Project cell onto the line segment: frac = dot(cell-P, edge) / |edge|²
          const dpx = wx - pn.x;
          const dpy = wy - pn.y;
          const dot = dpx * edx + dpy * edy;
          const frac = dot / edgeLenSq; // 0..1 along segment
          if (frac < 0 || frac > 1) continue;
          
          // Perpendicular distance from cell to the segment
          const projX = pn.x + edx * frac;
          const projY = pn.y + edy * frac;
          const perpDx = wx - projX;
          const perpDy = wy - projY;
          const perpDistSq = perpDx * perpDx + perpDy * perpDy;
          
          // Local ridge half-width at this position (lerp between endpoints)
          const localHalfW = Math.max(pSlopeW + (cSlopeW - pSlopeW) * frac, ridgeHalfWWorld);
          if (perpDistSq > localHalfW * localHalfW) continue;
          
          // Catenary envelope: high at endpoints, gentle sag in the middle
          const mid = 2 * Math.abs(frac - 0.5); // 1 at endpoints, 0 at midpoint
          const envelope = 1 - TERRAIN_RIDGE_SAG * (1 - mid * mid);
          
          // Lerp height along the spine + apply envelope
          const lerpH = pH + (cH - pH) * frac;
          const spineH = TERRAIN_RIDGE_HEIGHT_FACTOR * lerpH * envelope;
          if (spineH <= 0) continue;
          
          // Lateral falloff from centerline
          const perpDist = Math.sqrt(perpDistSq);
          const nd = perpDist / localHalfW; // 0 at center, 1 at edge
          const lateralFalloff = Math.pow(1 - nd * nd, TERRAIN_RIDGE_FALLOFF_POWER);
          const ht = spineH * lateralFalloff;
          if (ht <= 0) continue;
          
          const globalIdx = globalRowOff + gx;
          if (ht > heightMap[globalIdx]) {
            heightMap[globalIdx] = ht;
            ownerMap[globalIdx] = frac < 0.5 ? pi : ci;
          }
        }
      }
    }
    
    // Apply gaussian blur (2 passes)
    const blurKernel = (src: Float32Array, dst: Float32Array, bw: number, bh: number) => {
      for (let y = 1; y < bh - 1; y++) {
        const row = y * bw;
        const rowAbove = row - bw;
        const rowBelow = row + bw;
        for (let x = 1; x < bw - 1; x++) {
          dst[row + x] = (
            src[rowAbove + x - 1] + src[rowAbove + x] * 2 + src[rowAbove + x + 1] +
            src[row + x - 1] * 2 + src[row + x] * 4 + src[row + x + 1] * 2 +
            src[rowBelow + x - 1] + src[rowBelow + x] * 2 + src[rowBelow + x + 1]
          ) / 16;
        }
      }
      for (let x = 0; x < bw; x++) { dst[x] = src[x]; dst[(bh - 1) * bw + x] = src[(bh - 1) * bw + x]; }
      for (let y = 0; y < bh; y++) { dst[y * bw] = src[y * bw]; dst[y * bw + bw - 1] = src[y * bw + bw - 1]; }
    };
    
    blurKernel(heightMap, tempMap, gridW, gridH);
    blurKernel(tempMap, heightMap, gridW, gridH);
    
    // ==================== Normalize Height Map ====================
    // Heights are raw (additive stamps + ridges). Normalize to [0,1]
    // so contour levels (0.125 … 1.0) span the actual range.
    let maxH = 0;
    for (let i = 0; i < gridSize; i++) {
      if (heightMap[i] > maxH) maxH = heightMap[i];
    }
    if (maxH > 0) {
      const invMaxH = 1 / maxH;
      for (let i = 0; i < gridSize; i++) {
        heightMap[i] *= invMaxH;
      }
      // Normalize per-node peak heights for plateau detection
      for (let i = 0; i < nodePeakH.length; i++) {
        if (nodePeakH[i] !== undefined) nodePeakH[i] *= invMaxH;
      }
    }
    
    // ==================== Reference Link Paths ====================
    // Compute least-slope A* paths for reference links after heightMap is built.
    // Paths are cached alongside terrain data and only recomputed when layout changes.
    let computedReferencePaths: ReferencePath[] = [];
    const isNearlySettled = simulationSleepingRef.current || kineticEnergyRef.current < TERRAIN_REF_PATH_KE_THRESHOLD;
    if (visibilityFiltersRef.current.showReferenceLinks && isNearlySettled) {
      // Collect reference links from visible links
      const refLinks: RefLink[] = [];
      for (const link of visibleLinks) {
        if (link.type === 'reference' || link.type === 'property-reference') {
          // Only include links where both endpoints are visible
          if (idToIdx.has(link.source) && idToIdx.has(link.target)) {
            refLinks.push({ source: link.source, target: link.target });
          }
        }
      }
      
      if (refLinks.length > 0) {
        // Build node peak info map (world position + plateau radius in world units)
        const nodePeaks = new Map<number, NodePeakInfo>();
        for (const node of visibleNodes) {
          const peakSize = terrainPeakRadii.get(node.id) ?? 0;
          const plateauRadius = TERRAIN_BASE_PLATEAU_RADIUS + TERRAIN_PEAK_PLATEAU_BONUS * peakSize;
          nodePeaks.set(node.id, { x: node.x, y: node.y, plateauRadius });
        }
        
        // Build set of protected peak grid cells (node centers ± small radius)
        const nodePeakGridCells = new Set<number>();
        const peakProtectRadius = 3; // grid cells around each peak to protect
        for (const node of visibleNodes) {
          const cx = Math.round((node.x - originX) / gs);
          const cy = Math.round((node.y - originY) / gs);
          for (let dy = -peakProtectRadius; dy <= peakProtectRadius; dy++) {
            for (let dx = -peakProtectRadius; dx <= peakProtectRadius; dx++) {
              const px = cx + dx;
              const py = cy + dy;
              if (px >= 0 && px < gridW && py >= 0 && py < gridH) {
                nodePeakGridCells.add(py * gridW + px);
              }
            }
          }
        }
        
        // Compute paths via A* on heightMap
        const result = computeReferencePaths(
          heightMap, gridW, gridH, gs,
          originX, originY,
          refLinks, nodePeaks,
        );
        computedReferencePaths = result.paths;
        
        // Apply subtle erosion along paths (creates shallow valleys)
        if (computedReferencePaths.length > 0) {
          applyPathErosion(heightMap, gridW, gridH, gs, originX, originY, computedReferencePaths, nodePeakGridCells);
        }
      }
    }
    
    // Read CSS variables (cached, refreshed on theme change)
    if (cssColorsDirtyRef.current || !cssColorsRef.current) {
      const style = getComputedStyle(document.documentElement);
      const colorLow = style.getPropertyValue('--color-outline').trim() || '#a3a3a3';
      const colorHigh = style.getPropertyValue('--color-accent').trim() || '#404040';
      const parseHex = (hex: string): [number, number, number] => {
        let hx = hex.replace('#', '');
        if (hx.length === 3) hx = hx.split('').map(c => c + c).join('');
        return [
          parseInt(hx.substring(0, 2), 16),
          parseInt(hx.substring(2, 4), 16),
          parseInt(hx.substring(4, 6), 16),
        ];
      };
      const [lR, lG, lB] = parseHex(colorLow);
      const [hR, hG, hB] = parseHex(colorHigh);
      cssColorsRef.current = {
        lowR: lR, lowG: lG, lowB: lB,
        highR: hR, highG: hG, highB: hB,
        lowHex: colorLow, highHex: colorHigh,
      };
      cssColorsDirtyRef.current = false;
    }
    const { lowR, lowG, lowB, highR, highG, highB } = cssColorsRef.current;
    
    // Build per-node color cache (index → [r, g, b])
    const nodeColors: Array<[number, number, number]> = new Array(visibleNodes.length);
    const parseHexRGB = (hex: string): [number, number, number] => {
      let hx = hex.replace('#', '');
      if (hx.length === 3) hx = hx.split('').map(c => c + c).join('');
      return [
        parseInt(hx.substring(0, 2), 16),
        parseInt(hx.substring(2, 4), 16),
        parseInt(hx.substring(4, 6), 16),
      ];
    };
    const hasClassColors = currentClassColors.length > 0;
    for (let i = 0; i < visibleNodes.length; i++) {
      const color = getNodeColor(visibleNodes[i], currentClassColors, accentColor);
      nodeColors[i] = parseHexRGB(color);
    }
    
    // ── GPU texture uploads ────────────────────────────────────────────────────
    // These replace the old Canvas 2D colour-map + selection-mask offscreen
    // canvases.  Bilinear filtering on the GPU gives equivalent smooth-edge
    // blending for free, without any JS per-pixel loops.
    
    // Build selected-node index set for the GPU selection mask texture.
    const selectedNodeIndices = new Set<number>();
    if (hasSelection) {
      for (let i = 0; i < visibleNodes.length; i++) {
        if (selIdSet.has(visibleNodes[i].id)) selectedNodeIndices.add(i);
      }
    }

    {
      const terrainGL = terrainGLRef.current;
      if (terrainGL) {
        // Height map: R32F texture — the shader derives gradient and iso-distances.
        terrainGL.uploadHeightMap(heightMap, gridW, gridH, originX, originY, gs);
        // Ownership colour: RGBA8, bilinear → free smooth blending between owners.
        terrainGL.uploadOwnershipColors(ownerMap, gridW, gridH, nodeColors, [lowR, lowG, lowB]);
        // Selection mask: R8, bilinear → smooth dim/bright region boundaries.
        terrainGL.uploadSelectionMask(ownerMap, gridW, gridH, selectedNodeIndices);
      }
    }

    // Store to cache (contours are GPU-rendered via analytical fragment shader)
    cache.positionHash = positionHash;
    cache.selectionHash = selectionHash;
    cache.classColorsHash = classColorsHash;
    cache.gridW = gridW;
    cache.gridH = gridH;
    cache.gs = gs;
    cache.originX = originX;
    cache.originY = originY;
    cache.nodeChildDirs = nodeChildDirs;
    cache.idToIdx = idToIdx;
    cache.nodeColors = nodeColors;
    cache.lowR = lowR; cache.lowG = lowG; cache.lowB = lowB;
    cache.highR = highR; cache.highG = highG; cache.highB = highB;
    cache.hasClassColors = hasClassColors;
    cache.hasSelection = hasSelection;
    lastTerrainRebuildRef.current = now;
    cache.selectedNodeIndices = selectedNodeIndices;
    cache.referencePaths = computedReferencePaths;
    cache.heightMap = heightMap;
    cache.valid = true;
    
    } // end if (!cacheValid)

    // ── Read from cache — only what reference-path drawing needs ───────────────
    const cachedLowR = cache.lowR, cachedLowG = cache.lowG, cachedLowB = cache.lowB;
    const cachedIdToIdx = cache.idToIdx;
    const cachedNodeColors = cache.nodeColors;
    // Grid geometry used by the DEBUG overlay and reference-path transforms
    const drawOriginX = cache.originX;
    const drawOriginY = cache.originY;
    const drawGridW = cache.gridW;
    const drawGridH = cache.gridH;
    const drawGs = cache.gs;

    // ── GPU contour render ────────────────────────────────────────────────────
    // setCamera() is cheap (stores 3 floats); called every frame so pan/zoom
    // is reflected without a texture re-upload.
    // setContourStyle() sets 4 uniforms.  render() runs the fullscreen-quad
    // fragment shader — the GPU computes analytical per-pixel iso-line
    // distances from the cached R32F height-map texture.
    {
      const terrainGL = terrainGLRef.current;
      if (terrainGL) {
        const camState: TerrainCameraState = { translateX: t.x, translateY: t.y, scale: t.scale };
        terrainGL.setCamera(camState);
        const cssColors = cssColorsRef.current;
        terrainGL.setContourStyle({
          hoveredLevelIndex: hoveredContourLevelRef.current,
          hasClassColors:    cache.hasClassColors,
          hasSelection:      cache.hasSelection,
          lowColor:          cssColors?.lowHex  ?? '#a3a3a3',
          highColor:         cssColors?.highHex ?? '#404040',
        });
        terrainGL.render();
      }
    }
    
    // ==================== DEBUG: Draw Height Map Grid ====================
    if (settings.showDebugGrid && heightMapBufRef.current && drawGridW > 0 && drawGridH > 0) {
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.scale, t.scale);
      const dbgHeightMap = heightMapBufRef.current;
      // Draw each grid cell as a semi-transparent colored rectangle
      // Color: red channel = height, blue = owner-based hue
      for (let gy = 0; gy < drawGridH; gy++) {
        for (let gx = 0; gx < drawGridW; gx++) {
          const idx = gy * drawGridW + gx;
          const val = dbgHeightMap[idx];
          if (val <= 0.001) continue;
          const wx = drawOriginX + gx * drawGs;
          const wy = drawOriginY + gy * drawGs;
          // Heat map: black→blue→cyan→green→yellow→red
          const v = Math.min(1, val);
          const r = Math.min(255, Math.max(0, Math.round(v < 0.5 ? 0 : (v - 0.5) * 2 * 255)));
          const g = Math.min(255, Math.max(0, Math.round(v < 0.25 ? 0 : v < 0.75 ? (v - 0.25) * 2 * 255 : 255)));
          const b = Math.min(255, Math.max(0, Math.round(v < 0.5 ? v * 2 * 255 : (1 - v) * 2 * 255)));
          ctx.fillStyle = `rgba(${r},${g},${b},0.35)`;
          ctx.fillRect(wx, wy, drawGs, drawGs);
        }
      }
      // Draw grid lines (very faint)
      ctx.strokeStyle = 'rgba(128,128,128,0.08)';
      ctx.lineWidth = 0.5 / t.scale;
      for (let gy = 0; gy <= drawGridH; gy += 10) {
        const wy = drawOriginY + gy * drawGs;
        ctx.beginPath();
        ctx.moveTo(drawOriginX, wy);
        ctx.lineTo(drawOriginX + drawGridW * drawGs, wy);
        ctx.stroke();
      }
      for (let gx = 0; gx <= drawGridW; gx += 10) {
        const wx = drawOriginX + gx * drawGs;
        ctx.beginPath();
        ctx.moveTo(wx, drawOriginY);
        ctx.lineTo(wx, drawOriginY + drawGridH * drawGs);
        ctx.stroke();
      }
      // Draw each node's stamp footprint
      const dbgStampCache = stampCacheRef.current;
      for (const node of visibleNodes) {
        const stampEntry = dbgStampCache.get(node.id);
        if (!stampEntry) continue;
        const { stamp: dbgStamp } = stampEntry;
        const gxCenter = Math.round((node.x - drawOriginX) / drawGs);
        const gyCenter = Math.round((node.y - drawOriginY) / drawGs);
        const gxStart = gxCenter - dbgStamp.cx;
        const gyStart = gyCenter - dbgStamp.cy;
        const stampWorldX = drawOriginX + gxStart * drawGs;
        const stampWorldY = drawOriginY + gyStart * drawGs;
        const stampWorldW = dbgStamp.w * drawGs;
        const stampWorldH = dbgStamp.h * drawGs;
        // Stamp bounding box
        ctx.strokeStyle = 'rgba(255,0,0,0.5)';
        ctx.lineWidth = 1 / t.scale;
        ctx.strokeRect(stampWorldX, stampWorldY, stampWorldW, stampWorldH);
        // Node center cross
        ctx.strokeStyle = 'rgba(255,255,0,0.8)';
        ctx.lineWidth = 1.5 / t.scale;
        const crossSize = 6 / t.scale;
        ctx.beginPath();
        ctx.moveTo(node.x - crossSize, node.y);
        ctx.lineTo(node.x + crossSize, node.y);
        ctx.moveTo(node.x, node.y - crossSize);
        ctx.lineTo(node.x, node.y + crossSize);
        ctx.stroke();
      }
      // Grid bounding box
      ctx.strokeStyle = 'rgba(0,255,0,0.4)';
      ctx.lineWidth = 2 / t.scale;
      ctx.strokeRect(drawOriginX, drawOriginY, drawGridW * drawGs, drawGridH * drawGs);
      ctx.restore();
    }
    // ==================== END DEBUG ====================
    
    // ==================== Draw Reference Link Paths ====================
    // Rendered after contour lines but before overlays.
    // Thin, subtle polylines following terrain curvature.
    // Paths fade in when simulation stabilizes and fade out when it wakes.
    
    // Evolve opacity based on simulation state
    const showRefPaths = visibilityFiltersRef.current.showReferenceLinks && cache.referencePaths.length > 0;
    const isSettledForPaths = simulationSleepingRef.current || kineticEnergyRef.current < TERRAIN_REF_PATH_KE_THRESHOLD;
    const targetOpacity = (showRefPaths && isSettledForPaths) ? 1 : 0;
    let curOpacity = refPathOpacityRef.current;
    
    if (curOpacity !== targetOpacity) {
      const now = performance.now();
      const dt = refPathLastFrameRef.current > 0
        ? Math.min((now - refPathLastFrameRef.current) / 1000, 0.05) // cap delta to 50ms
        : 0.016; // first frame default ~60fps
      refPathLastFrameRef.current = now;
      
      if (targetOpacity > curOpacity) {
        curOpacity = Math.min(1, curOpacity + REF_PATH_FADE_IN_SPEED * dt);
      } else {
        curOpacity = Math.max(0, curOpacity - REF_PATH_FADE_OUT_SPEED * dt);
      }
      refPathOpacityRef.current = curOpacity;
      
      // Schedule another render frame to continue the fade animation
      if (curOpacity !== targetOpacity) {
        cancelAnimationFrame(refPathFadeRafRef.current);
        refPathFadeRafRef.current = requestAnimationFrame(() => {
          if (ctxRef.current && renderRef.current) {
            renderRef.current(ctxRef.current);
          }
        });
      }
    } else {
      refPathLastFrameRef.current = 0; // reset for next transition
    }
    
    if (curOpacity > 0.001 && cache.referencePaths.length > 0) {
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.scale, t.scale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      for (const path of cache.referencePaths) {
        const pts = path.worldPoints;
        const mult = path.pointMultiplicity;
        if (pts.length < 2) continue;
        
        // Determine path color from source node's color (subtle tint)
        const srcIdx = cachedIdToIdx.get(path.sourceId);
        let pathR = cachedLowR, pathG = cachedLowG, pathB = cachedLowB;
        if (srcIdx !== undefined && cachedNodeColors[srcIdx]) {
          const [cr, cg, cb] = cachedNodeColors[srcIdx];
          // Blend node color with neutral at 40% — keeps paths subtle
          pathR = Math.round(cr * 0.4 + cachedLowR * 0.6);
          pathG = Math.round(cg * 0.4 + cachedLowG * 0.6);
          pathB = Math.round(cb * 0.4 + cachedLowB * 0.6);
        }
        
        // Slope-based base width
        const slopeScale = Math.max(0.4, 1.0 - path.avgSlope * 3);
        
        // Draw segments with variable width based on per-point multiplicity.
        // Where paths merge (multiplicity > 1) the stroke is bolder.
        for (let i = 0; i < pts.length - 1; i++) {
          const segMult = Math.max(mult[i] || 1, mult[i + 1] || 1);
          const baseWidth = 1.2 + (segMult - 1) * 0.6; // wider for merged segments
          const lineWidth = baseWidth * slopeScale;
          const opacityBoost = Math.min(1, 0.35 + (segMult - 1) * 0.08);
          
          ctx.beginPath();
          // Use Catmull-Rom for segment smoothness (prev/next neighbors)
          const p0 = pts[i > 0 ? i - 1 : 0];
          const p1 = pts[i];
          const p2 = pts[i + 1];
          const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
          ctx.moveTo(p1[0], p1[1]);
          ctx.bezierCurveTo(
            p1[0] + (p2[0] - p0[0]) / 6,
            p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6,
            p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1],
          );
          
          // Outer glow stroke
          ctx.strokeStyle = `rgba(${pathR}, ${pathG}, ${pathB}, ${0.12 * curOpacity})`;
          ctx.lineWidth = (lineWidth + 1.5) / t.scale;
          ctx.stroke();
          
          // Main stroke — bolder where paths merge
          ctx.strokeStyle = `rgba(${pathR}, ${pathG}, ${pathB}, ${opacityBoost * curOpacity})`;
          ctx.lineWidth = lineWidth / t.scale;
          ctx.stroke();
        }
      }
      
      ctx.restore();
    }
    
    // Also repaint the overlay (labels, outlines, crosshair) since node positions may have changed
    if (overlayCtxRef.current && renderOverlayRef.current) {
      renderOverlayRef.current(overlayCtxRef.current);
    }
  }, []); // stable callback — reads from refs
  
  // ==================== Overlay Render Function (lightweight) ====================
  // Draws crosshair, hover labels, selected outlines on the overlay canvas.
  // This is called on every mouse move but is very cheap (no height map / contours).
  
  const renderOverlay = useCallback((overlayCtx: CanvasRenderingContext2D) => {
    const { width: w, height: h } = dimensionsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const t = transformRef.current;
    
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, w * dpr, h * dpr);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    const { visibleNodes } = frameDataRef.current;
    const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
    const { accentColor, textColor } = cssVarsRef.current;
    const currentClassColors = classColorsRef.current;
    const cache = terrainCacheRef.current;
    const idToIdx = cache.idToIdx;
    const nodeChildDirs = cache.nodeChildDirs;
    
    // ==================== Update Node Labels (DOM elements) ====================
    const labels: Array<{ id: number; x: number; y: number; text: string; isSelected: boolean }> = [];
    
    // Hovered node label
    const hovNode = hoveredNodeRef.current;
    if (hovNode) {
      const sx = hovNode.x * t.scale + t.x;
      const sy = hovNode.y * t.scale + t.y;
      if (sx >= -60 && sx <= w + 60 && sy >= -20 && sy <= h + 20) {
        const displayName = hovNode.displayName.length > 35 
          ? hovNode.displayName.slice(0, 35) + '...' 
          : hovNode.displayName;
        labels.push({ id: hovNode.id, x: sx, y: sy, text: displayName, isSelected: false });
      }
    }
    
    // ==================== Draw Selected Peak Outlines ====================
    const selIds = selectedNodeIdsRef.current;
    if (selIds.size > 0 && idToIdx && nodeChildDirs) {
      overlayCtx.save();
      
      const OUTLINE_SAMPLES = 48;
      const OUTLINE_PAD = 8;
      const MAX_STRETCH = 1.6;
      
      for (const node of visibleNodes) {
        if (!selIds.has(node.id)) continue;
        
        const nIdx = idToIdx.get(node.id);
        if (nIdx === undefined) continue;
        
        const sx = node.x * t.scale + t.x;
        const sy = node.y * t.scale + t.y;
        if (sx < -200 || sx > w + 200 || sy < -200 || sy > h + 200) continue;
        
        const peakSize = terrainPeakRadii.get(node.id) ?? 0;
        const baseR = (TERRAIN_BASE_PLATEAU_RADIUS + TERRAIN_PEAK_PLATEAU_BONUS * peakSize) * t.scale;
        const dirs = nodeChildDirs[nIdx];
        const hasDirs = dirs && dirs.length > 0;
        
        const nodeColor = getNodeColor(node, currentClassColors, accentColor);
        
        overlayCtx.beginPath();
        for (let si = 0; si <= OUTLINE_SAMPLES; si++) {
          const ang = (si / OUTLINE_SAMPLES) * 2 * Math.PI;
          const cosA = Math.cos(ang);
          const sinA = Math.sin(ang);
          
          let r = baseR;
          
          if (hasDirs) {
            let maxAlign = 0;
            for (let d = 0; d < dirs.length; d++) {
              const dot = cosA * dirs[d].nx + sinA * dirs[d].ny;
              if (dot > maxAlign) maxAlign = dot;
            }
            if (maxAlign > 0.5) {
              const ramp = (maxAlign - 0.5) * 2;
              const stretch = 1 + TERRAIN_ANISOTROPY * ramp * ramp;
              r *= Math.min(Math.sqrt(stretch), MAX_STRETCH);
            }
          }
          
          if (TERRAIN_NOISE_STRENGTH > 0) {
            const n1 = ihash(node.id, Math.floor(ang * 3 + 100)) * 2 - 1;
            const n2 = ihash(node.id, Math.floor(ang * 7 + 200)) * 2 - 1;
            const noise = (n1 * 0.7 + n2 * 0.3) * TERRAIN_NOISE_STRENGTH;
            r *= 1 / (1 + noise);
          }
          
          const px = sx + cosA * (r + OUTLINE_PAD);
          const py = sy + sinA * (r + OUTLINE_PAD);
          
          if (si === 0) overlayCtx.moveTo(px, py);
          else overlayCtx.lineTo(px, py);
        }
        overlayCtx.closePath();
        
        overlayCtx.globalAlpha = 0.3;
        overlayCtx.strokeStyle = nodeColor;
        overlayCtx.lineWidth = 4;
        overlayCtx.setLineDash([4, 3]);
        overlayCtx.stroke();
        
        overlayCtx.globalAlpha = 0.8;
        overlayCtx.strokeStyle = textColor;
        overlayCtx.lineWidth = 1.5;
        overlayCtx.stroke();
        
        overlayCtx.setLineDash([]);
        overlayCtx.globalAlpha = 1;
        
        // Add label for selected node
        const displayName = node.displayName.length > 35 
          ? node.displayName.slice(0, 35) + '...' 
          : node.displayName;
        // Only add if not already added as hovered (avoid duplicate)
        if (!labels.find(l => l.id === node.id)) {
          labels.push({ id: node.id, x: sx, y: sy, text: displayName, isSelected: true });
        }
      }
      
      overlayCtx.restore();
    }
    
    // Update label state
    setNodeLabels(labels);
    
    // ==================== Draw Crosshair Lines ====================
    const mx = mouseScreenRef.current.x;
    const my = mouseScreenRef.current.y;
    if (mx >= 0 && my >= 0 && !isPanningRef.current && !dragNodeRef.current) {
      // Parse textColor hex to rgb for rgba usage
      const hx = textColor.replace('#', '');
      const cr = parseInt(hx.substring(0, 2), 16) || 0;
      const cg = parseInt(hx.substring(2, 4), 16) || 0;
      const cb = parseInt(hx.substring(4, 6), 16) || 0;
      
      overlayCtx.save();
      overlayCtx.setLineDash([6, 4]);
      overlayCtx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.15)`;
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.moveTo(mx, 0);
      overlayCtx.lineTo(mx, h);
      overlayCtx.stroke();
      overlayCtx.beginPath();
      overlayCtx.moveTo(0, my);
      overlayCtx.lineTo(w, my);
      overlayCtx.stroke();
      
      const CROSS_SIZE = 8;
      overlayCtx.setLineDash([]);
      overlayCtx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.7)`;
      overlayCtx.lineWidth = 1.5;
      overlayCtx.beginPath();
      overlayCtx.moveTo(mx - CROSS_SIZE, my);
      overlayCtx.lineTo(mx + CROSS_SIZE, my);
      overlayCtx.stroke();
      overlayCtx.beginPath();
      overlayCtx.moveTo(mx, my - CROSS_SIZE);
      overlayCtx.lineTo(mx, my + CROSS_SIZE);
      overlayCtx.stroke();
      overlayCtx.restore();
    }
  }, []); // stable — reads from refs
  
  // Set up render function and context
  useEffect(() => {
    renderRef.current = render;
  }, [render, renderRef]);
  
  useEffect(() => {
    renderOverlayRef.current = renderOverlay;
  }, [renderOverlay]);
  
  // ==================== Profile Path Generation ====================
  
  /** Convert an array of [x,y] sample points into an SVG Catmull-Rom cubic Bezier path string.
   *  Returns the curve portion only (caller adds M start, closing L, and Z). */
  const catmullRomSvg = (pts: Array<[number, number]>): string => {
    if (pts.length < 2) return '';
    if (pts.length === 2) return `L ${pts[1][0]},${pts[1][1]}`;
    const cmds: string[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i > 0 ? i - 1 : 0];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      cmds.push(`C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`);
    }
    return cmds.join(' ');
  };
  
  const updateProfiles = useCallback(() => {
    const heightMap = heightMapBufRef.current;
    const { gridW: gW, gridH: gH, gs: pGs, originX: pOX, originY: pOY } = plateauGridRef.current;
    if (!heightMap || gW === 0) {
      setProfileXPath('');
      setProfileYPath('');
      setProfileXCursor({ x: -1, visible: false });
      setProfileYCursor({ y: -1, visible: false });
      setProfileXDots([]);
      setProfileYDots([]);
      setNodeLabels([]);
      return;
    }
    
    const mx = mouseScreenRef.current.x;
    const my = mouseScreenRef.current.y;
    const { width: w, height: h } = dimensionsRef.current;
    const { accentColor: profileAccentColor } = cssVarsRef.current;
    
    // Card inset constants (must match CSS)
    const INSET = 12;
    const CROSS_INSET = 68;
    const PROFILE_X_HEIGHT = 48;
    const PROFILE_Y_WIDTH = 48;
    
    // Calculate actual card dimensions
    const cardXWidth = w - INSET - CROSS_INSET;
    const cardYHeight = h - INSET - CROSS_INSET;
    
    // Update viewBox dimensions
    setProfileViewBoxX({ width: cardXWidth, height: PROFILE_X_HEIGHT });
    setProfileViewBoxY({ width: PROFILE_Y_WIDTH, height: cardYHeight });
    
    // --- Bottom profile (X axis): sample heightMap along row at cursor Y ---
    if (mx >= 0 && my >= 0) {
      const tProf = transformRef.current;
      const worldMy = (my - tProf.y) / tProf.scale;
      const gy = Math.floor((worldMy - pOY) / pGs);
      if (gy >= 0 && gy < gH) {
        const tLeft = INSET;
        const tRight = w - CROSS_INSET;
        const tSpan = tRight - tLeft;
        const cw = tRight - tLeft;
        const ch = PROFILE_X_HEIGHT;
        
        // Build SVG path (area + smooth Catmull-Rom curve)
        const samplePts: Array<[number, number]> = [];
        for (let px = 0; px <= cw; px += 6) {
          const terrainX = tLeft + (px / cw) * tSpan;
          const worldTerrainX = (terrainX - tProf.x) / tProf.scale;
          const gx = Math.min(Math.max(Math.floor((worldTerrainX - pOX) / pGs), 0), gW - 1);
          const val = heightMap[gy * gW + gx];
          const py = ch - val * (ch - 4);
          samplePts.push([px, py]);
        }
        // Ensure last point is at cw
        if (samplePts.length === 0 || samplePts[samplePts.length - 1][0] !== cw) {
          const worldEndX = (tLeft + tSpan - tProf.x) / tProf.scale;
          const gxEnd = Math.min(Math.max(Math.floor((worldEndX - pOX) / pGs), 0), gW - 1);
          const valEnd = heightMap[gy * gW + gxEnd];
          samplePts.push([cw, ch - valEnd * (ch - 4)]);
        }
        const curvePath = catmullRomSvg(samplePts);
        setProfileXPath(`M 0,${ch} L ${samplePts[0][0]},${samplePts[0][1]} ${curvePath} L ${cw},${ch} Z`);
        
        // Cursor position
        const cardMx = (mx - tLeft) / tSpan * cw;
        setProfileXCursor({ x: cardMx, visible: true });
        
        // Node position dots
        const t = transformRef.current;
        const { visibleNodes } = frameDataRef.current;
        const NODE_DOT_MAX_DIST = 80;
        const dots: Array<{ x: number; y: number; color: string; opacity: number }> = [];
        for (const node of visibleNodes) {
          const nsx = node.x * t.scale + t.x;
          const nsy = node.y * t.scale + t.y;
          const distY = Math.abs(nsy - my);
          if (distY > NODE_DOT_MAX_DIST) continue;
          if (nsx < tLeft || nsx > tRight) continue;
          const cardNx = (nsx - tLeft) / tSpan * cw;
          const ngx = Math.min(Math.max(Math.floor((node.x - pOX) / pGs), 0), gW - 1);
          const nVal = heightMap[gy * gW + ngx];
          const ndotY = ch - nVal * (ch - 4);
          const prox = 1 - distY / NODE_DOT_MAX_DIST;
          const proxSq = prox * prox;
          const cc = classColorsRef.current;
          dots.push({
            x: cardNx,
            y: ndotY,
            color: cc.length > 0 ? getNodeColor(node, cc, profileAccentColor) : profileAccentColor,
            opacity: 0.15 + proxSq * 0.65
          });
        }
        setProfileXDots(dots);
      } else {
        setProfileXPath('');
        setProfileXCursor({ x: -1, visible: false });
        setProfileXDots([]);
      }
    } else {
      setProfileXPath('');
      setProfileXCursor({ x: -1, visible: false });
      setProfileXDots([]);
    }
    
    // --- Right profile (Y axis): sample heightMap along column at cursor X ---
    if (mx >= 0 && my >= 0) {
      const tProf2 = transformRef.current;
      const worldMx = (mx - tProf2.x) / tProf2.scale;
      const gx = Math.min(Math.max(Math.floor((worldMx - pOX) / pGs), 0), gW - 1);
      if (gx >= 0 && gx < gW) {
        const tTop = INSET;
        const tBottom = h - CROSS_INSET;
        const tSpan = tBottom - tTop;
        const cw = PROFILE_Y_WIDTH;
        const ch = tBottom - tTop;
        
        // Build SVG path (inverted: height grows right-to-left, smooth Catmull-Rom curve)
        const samplePts: Array<[number, number]> = [];
        for (let py = 0; py <= ch; py += 6) {
          const terrainY = tTop + (py / ch) * tSpan;
          const worldTerrainY = (terrainY - tProf2.y) / tProf2.scale;
          const gy = Math.min(Math.max(Math.floor((worldTerrainY - pOY) / pGs), 0), gH - 1);
          const val = heightMap[gy * gW + gx];
          const px = cw - val * (cw - 4);
          samplePts.push([px, py]);
        }
        // Ensure last point is at ch
        if (samplePts.length === 0 || samplePts[samplePts.length - 1][1] !== ch) {
          const worldEndY = (tTop + tSpan - tProf2.y) / tProf2.scale;
          const gyEnd = Math.min(Math.max(Math.floor((worldEndY - pOY) / pGs), 0), gH - 1);
          const valEnd = heightMap[gyEnd * gW + gx];
          samplePts.push([cw - valEnd * (cw - 4), ch]);
        }
        const curvePath = catmullRomSvg(samplePts);
        setProfileYPath(`M ${cw},0 L ${samplePts[0][0]},${samplePts[0][1]} ${curvePath} L ${cw},${ch} Z`);
        
        // Cursor position
        const cardMy = (my - tTop) / tSpan * ch;
        setProfileYCursor({ y: cardMy, visible: true });
        
        // Node position dots
        const t = transformRef.current;
        const { visibleNodes } = frameDataRef.current;
        const NODE_DOT_MAX_DIST = 80;
        const dots: Array<{ x: number; y: number; color: string; opacity: number }> = [];
        for (const node of visibleNodes) {
          const nsx = node.x * t.scale + t.x;
          const nsy = node.y * t.scale + t.y;
          const distX = Math.abs(nsx - mx);
          if (distX > NODE_DOT_MAX_DIST) continue;
          if (nsy < tTop || nsy > tBottom) continue;
          const cardNy = (nsy - tTop) / tSpan * ch;
          const ngy = Math.min(Math.max(Math.floor((node.y - pOY) / pGs), 0), gH - 1);
          const nVal = heightMap[ngy * gW + gx];
          const ndotX = cw - nVal * (cw - 4);
          const prox = 1 - distX / NODE_DOT_MAX_DIST;
          const proxSq = prox * prox;
          const cc = classColorsRef.current;
          dots.push({
            x: ndotX,
            y: cardNy,
            color: cc.length > 0 ? getNodeColor(node, cc, profileAccentColor) : profileAccentColor,
            opacity: 0.15 + proxSq * 0.65
          });
        }
        setProfileYDots(dots);
      } else {
        setProfileYPath('');
        setProfileYCursor({ y: -1, visible: false });
        setProfileYDots([]);
      }
    } else {
      setProfileYPath('');
      setProfileYCursor({ y: -1, visible: false });
      setProfileYDots([]);
    }
  }, []); // stable — reads from dimensionsRef
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctxRef.current = ctx;
    }
  }, [ctxRef]);
  
  // Set up overlay canvas context
  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (ctx) overlayCtxRef.current = ctx;
  }, []);
  
  // ==================== Event Handlers ====================
  
  const getCanvasCoordinates = useCallback((e: React.MouseEvent<HTMLCanvasElement | HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    // Coordinates are in CSS pixels (render uses ctx.scale(dpr) for HiDPI)
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }, []);
  
  /** Look up the ownership map to find which node owns the plateau at this screen position */
  const getNodeInPlateau = useCallback((screenX: number, screenY: number): GraphNode | null => {
    const ownerMap = ownerMapRef.current;
    const heightMap = heightMapBufRef.current;
    const { gridW, gridH, gs: hitGs, originX: hitOX, originY: hitOY } = plateauGridRef.current;
    if (!ownerMap || !heightMap || gridW === 0) return null;
    
    const tHit = transformRef.current;
    const worldX = (screenX - tHit.x) / tHit.scale;
    const worldY = (screenY - tHit.y) / tHit.scale;
    const gx = Math.floor((worldX - hitOX) / hitGs);
    const gy = Math.floor((worldY - hitOY) / hitGs);
    if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) return null;
    
    const idx = gy * gridW + gx;
    const owner = ownerMap[idx];
    if (owner < 0) return null;
    
    // Only count as hit if height is visible (above lowest contour)
    if (heightMap[idx] < 0.06) return null;
    
    const { visibleNodes } = frameDataRef.current;
    return owner < visibleNodes.length ? visibleNodes[owner] : null;
  }, []);
  
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const canvas = canvasRef.current;
    
    // Always keep mouse position up to date (avoids snapping back after drag release)
    mouseScreenRef.current = { x: screenX, y: screenY };
    
    if (isPanningRef.current) {
      const dx = screenX - panStartRef.current.x;
      const dy = screenY - panStartRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        didDragMoveRef.current = true;
        setOverlaysVisible(false);
      }
      const prev = transformRef.current;
      setTransformDirect({
        x: prev.x + dx,
        y: prev.y + dy,
        scale: prev.scale
      });
      panStartRef.current = { x: screenX, y: screenY };
      if (canvas) canvas.style.cursor = 'grabbing';
    } else if (dragNodeRef.current) {
      const { x, y } = screenToWorld(screenX, screenY);
      const dx = x - dragNodeRef.current.x;
      const dy = y - dragNodeRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        didDragMoveRef.current = true;
        setOverlaysVisible(false);
      }
      dragNodeRef.current.x = x;
      dragNodeRef.current.y = y;
      dragNodeRef.current.vx = 0;
      dragNodeRef.current.vy = 0;
      wakeSimulation();
      if (canvas) canvas.style.cursor = 'grabbing';
    } else {
      const node = getNodeAtPosition(screenX, screenY) || getNodeInPlateau(screenX, screenY);
      
      // Determine hovered contour level from heightMap
      let newContourLevel = -1;
      const heightMap = heightMapBufRef.current;
      const { gridW: gW, gridH: gH, gs: hitGs, originX: hitOX, originY: hitOY } = plateauGridRef.current;
      if (heightMap && gW > 0) {
        const tHit = transformRef.current;
        const hitWX = (screenX - tHit.x) / tHit.scale;
        const hitWY = (screenY - tHit.y) / tHit.scale;
        const gx = Math.floor((hitWX - hitOX) / hitGs);
        const gy = Math.floor((hitWY - hitOY) / hitGs);
        if (gx >= 0 && gx < gW && gy >= 0 && gy < gH) {
          const h = heightMap[gy * gW + gx];
          if (h > 0) {
            for (let i = CONTOUR_LEVELS.length - 1; i >= 0; i--) {
              if (CONTOUR_LEVELS[i] <= h) { newContourLevel = i; break; }
            }
          }
        }
      }
      
      // Contour level change requires full terrain redraw (contour styles change)
      if (newContourLevel !== hoveredContourLevelRef.current) {
        hoveredContourLevelRef.current = newContourLevel;
        if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
      }
      
      // Update elevation tooltip
      if (heightMap && gW > 0) {
        const tHit = transformRef.current;
        const hitWX = (screenX - tHit.x) / tHit.scale;
        const hitWY = (screenY - tHit.y) / tHit.scale;
        const gx = Math.floor((hitWX - hitOX) / hitGs);
        const gy = Math.floor((hitWY - hitOY) / hitGs);
        if (gx >= 0 && gx < gW && gy >= 0 && gy < gH) {
          const h = heightMap[gy * gW + gx];
          const meters = Math.round(h * 4000);
          setElevationTooltip({ x: screenX + 12, y: screenY - 24, text: `${meters} m`, visible: true });
        } else {
          setElevationTooltip(prev => ({ ...prev, visible: false }));
        }
      }
      
      // Update overlays and redraw profiles
      setOverlaysVisible(true);
      updateProfiles();
      
      // Redraw overlay only (crosshair, labels) — NOT the full terrain canvas
      if (overlayCtxRef.current && renderOverlayRef.current) {
        renderOverlayRef.current(overlayCtxRef.current);
      }
      
      if (canvas) {
        canvas.style.cursor = 'none';
      }
      
      if (node !== hoveredNodeRef.current) {
        hoveredNodeRef.current = node;
        onHoveredNodeChange?.(node);
        // Overlay already redrawn above — just re-render overlay for label update
        if (overlayCtxRef.current && renderOverlayRef.current) {
          renderOverlayRef.current(overlayCtxRef.current);
        }
      }
    }
  }, [getCanvasCoordinates, getNodeAtPosition, getNodeInPlateau, screenToWorld, onHoveredNodeChange, setTransformDirect, wakeSimulation, updateProfiles, setOverlaysVisible]);
  
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY) || getNodeInPlateau(screenX, screenY);
    
    if (node) {
      dragNodeRef.current = node;
      dragStartTimeRef.current = Date.now();
    } else {
      isPanningRef.current = true;
      panStartRef.current = { x: screenX, y: screenY };
    }
  }, [getCanvasCoordinates, getNodeAtPosition, getNodeInPlateau, dragNodeRef, dragStartTimeRef]);
  
  const handleMouseUp = useCallback(() => {
    const didMove = didDragMoveRef.current;
    
    if (dragNodeRef.current) {
      if (dragNodeRef.current.pinned) {
        dragNodeRef.current.targetX = dragNodeRef.current.x;
        dragNodeRef.current.targetY = dragNodeRef.current.y;
      }
    }
    
    dragNodeRef.current = null;
    dragStartTimeRef.current = null;
    isPanningRef.current = false;
    didDragMoveRef.current = false;
    setOverlaysVisible(true);
    
    // Restore hidden cursor after drag
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'none';
    
    if (didMove) {
      wasJustDraggingRef.current = true;
      setTimeout(() => {
        wasJustDraggingRef.current = false;
      }, 50);
    }
  }, [dragNodeRef, dragStartTimeRef, setOverlaysVisible]);
  
  const handleMouseLeave = useCallback(() => {
    handleMouseUp();
    mouseScreenRef.current = { x: -1, y: -1 };
    hoveredContourLevelRef.current = -1;
    hoveredNodeRef.current = null;
    setElevationTooltip(prev => ({ ...prev, visible: false }));
    setOverlaysVisible(false);
    updateProfiles();
    // Clear overlay canvas
    if (overlayCtxRef.current) {
      const dpr = window.devicePixelRatio || 1;
      const { width: w, height: h } = dimensionsRef.current;
      overlayCtxRef.current.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtxRef.current.clearRect(0, 0, w * dpr, h * dpr);
    }
    // Redraw terrain (contour highlight removed)
    if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
      renderRef.current(ctxRef.current);
    }
  }, [handleMouseUp, updateProfiles, setOverlaysVisible]);
  
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (wasJustDraggingRef.current) return;
    
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const now = Date.now();
    
    const node = getNodeAtPosition(screenX, screenY) || getNodeInPlateau(screenX, screenY);
    
    if (!node) {
      onSelectionChange?.([]);
      return;
    }
    
    const isDoubleClick = 
      lastClickedNodeRef.current === node.id && 
      now - lastClickTimeRef.current < 300;
    
    lastClickTimeRef.current = now;
    lastClickedNodeRef.current = node.id;
    
    if (isDoubleClick) {
      onNodeDoubleClick?.(node);
    } else {
      onNodeClick?.(node, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
    }
  }, [getCanvasCoordinates, getNodeAtPosition, getNodeInPlateau, onNodeClick, onNodeDoubleClick, onSelectionChange]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY) || getNodeInPlateau(screenX, screenY);
    
    if (node) {
      onNodeRightClick?.(node);
    }
  }, [getCanvasCoordinates, getNodeAtPosition, getNodeInPlateau, onNodeRightClick]);
  
  // Wheel handler
  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Coordinates are in CSS pixels (render uses ctx.scale(dpr) for HiDPI)
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    
    const cur = transformRef.current;
    const delta = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.001;
    const zoomFactor = Math.exp(delta);
    const newScale = Math.min(Math.max(cur.scale * zoomFactor, 0.1), 5);
    
    const scaleChange = newScale / cur.scale;
    const newX = screenX - (screenX - cur.x) * scaleChange;
    const newY = screenY - (screenY - cur.y) * scaleChange;
    
    setTransformDirect({
      x: newX,
      y: newY,
      scale: newScale
    });
  };
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => handleWheelRef.current(e);
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, []);
  
  // Cleanup fade animation RAF on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(refPathFadeRafRef.current);
  }, []);
  
  // ==================== Render ====================

  return (
    <div className={`node-graph-renderer ${className}`} ref={containerRef}>
      {/* WebGL canvas — bottom layer: GPU-rendered terrain contours */}
      <canvas
        ref={webglCanvasRef}
        width={dimensions.width * (window.devicePixelRatio || 1)}
        height={dimensions.height * (window.devicePixelRatio || 1)}
        className="node-graph-renderer__canvas"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      {/* Canvas 2D — middle layer: reference paths + drives physics render callback */}
      <canvas
        ref={canvasRef}
        width={dimensions.width * (window.devicePixelRatio || 1)}
        height={dimensions.height * (window.devicePixelRatio || 1)}
        className="node-graph-renderer__canvas"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: 'none', background: 'transparent' }}
      />
      <canvas
        ref={overlayCanvasRef}
        width={dimensions.width * (window.devicePixelRatio || 1)}
        height={dimensions.height * (window.devicePixelRatio || 1)}
        className="node-graph-renderer__overlay"
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', width: '100%', height: '100%' }}
      />
      {/* Elevation tooltip */}
      {elevationTooltip.visible && (
        <div
          className="terrain-elevation-tooltip"
          style={{
            position: 'absolute',
            left: elevationTooltip.x,
            top: elevationTooltip.y,
            pointerEvents: 'none',
            background: 'var(--color-surface)',
            color: 'var(--color-on-surface)',
            padding: '2px 6px',
            borderRadius: '4px',
            fontSize: '11px',
            fontWeight: 600,
            opacity: 0.85,
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            zIndex: 10,
          }}
        >
          {elevationTooltip.text}
        </div>
      )}
      {/* Right profile (Y axis) */}
      <div
        ref={profileYCardRef}
        className="terrain-profile-card terrain-profile-card--right"
      >
        <Card variant="dashed" elevation="none" padding={false} radius="sm" className="terrain-profile-card__inner">
          <svg 
            className="terrain-profile-canvas" 
            viewBox={`0 0 ${profileViewBoxY.width} ${profileViewBoxY.height}`}
            preserveAspectRatio="none"
          >
            {profileYPath && (
              <>
                <path
                  d={profileYPath}
                  fill="var(--color-on-surface)"
                  fillOpacity="0.08"
                  stroke="var(--color-on-surface)"
                  strokeWidth="1"
                  strokeOpacity="0.4"
                  vectorEffect="non-scaling-stroke"
                />
                {profileYCursor.visible && (
                  <line
                    x1="0"
                    y1={profileYCursor.y}
                    x2={profileViewBoxY.width}
                    y2={profileYCursor.y}
                    stroke="var(--color-on-surface)"
                    strokeWidth="1"
                    strokeDasharray="4 3"
                    strokeOpacity="0.3"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {profileYDots.map((dot, i) => (
                  <circle
                    key={i}
                    cx={dot.x}
                    cy={dot.y}
                    r="3"
                    fill={dot.color}
                    opacity={dot.opacity}
                  />
                ))}
              </>
            )}
          </svg>
        </Card>
      </div>
      {/* Bottom profile (X axis) */}
      <div
        ref={profileXCardRef}
        className="terrain-profile-card terrain-profile-card--bottom"
      >
        <Card variant="dashed" elevation="none" padding={false} radius="sm" className="terrain-profile-card__inner">
          <svg 
            className="terrain-profile-canvas" 
            viewBox={`0 0 ${profileViewBoxX.width} ${profileViewBoxX.height}`}
            preserveAspectRatio="none"
          >
            {profileXPath && (
              <>
                <path
                  d={profileXPath}
                  fill="var(--color-on-surface)"
                  fillOpacity="0.08"
                  stroke="var(--color-on-surface)"
                  strokeWidth="1"
                  strokeOpacity="0.4"
                  vectorEffect="non-scaling-stroke"
                />
                {profileXCursor.visible && (
                  <line
                    x1={profileXCursor.x}
                    y1="0"
                    x2={profileXCursor.x}
                    y2={profileViewBoxX.height}
                    stroke="var(--color-on-surface)"
                    strokeWidth="1"
                    strokeDasharray="4 3"
                    strokeOpacity="0.3"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {profileXDots.map((dot, i) => (
                  <circle
                    key={i}
                    cx={dot.x}
                    cy={dot.y}
                    r="3"
                    fill={dot.color}
                    opacity={dot.opacity}
                  />
                ))}
              </>
            )}
          </svg>
        </Card>
      </div>
      {/* Node labels */}
      {nodeLabels.map((label) => (
        <div
          key={label.id}
          className="terrain-node-label-wrapper"
          style={{
            position: 'absolute',
            left: `${label.x}px`,
            top: `${label.y}px`,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <Card className="terrain-node-label-card">
            <span className="terrain-node-label-text">{label.text}</span>
          </Card>
        </div>
      ))}
    </div>
  );
});

TerrainRenderer.displayName = 'TerrainRenderer';

export default TerrainRenderer;