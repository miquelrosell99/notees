/**
 * TerrainRenderer Component
 * 
 * Renders the terrain visualization with contour lines and colored plateau fills.
 * Uses useNodePhysics hook for simulation.
 * Handles:
 * - Canvas rendering of contour lines (marching squares)
 * - Height map generation from node mass/positions
 * - Colored plateau fills per node (ownership map + offscreen canvas)
 * - Plateau-based hit testing for click/hover
 * - Mouse interactions (pan, zoom, click)
 */

import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
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
  LINE_DASH_NONE,
  CONTOUR_LEVELS,
  TERRAIN_GRID_RES,
  TERRAIN_BASE_PLATEAU_RADIUS,
  TERRAIN_PEAK_PLATEAU_BONUS,
  TERRAIN_BASE_SLOPE_RADIUS,
  TERRAIN_PEAK_SLOPE_BONUS,
  TERRAIN_ANISOTROPY,
  TERRAIN_NOISE_STRENGTH,
  // Helpers
  getNodeColor,
} from './viewTypes';
import { useNodePhysics } from './useNodePhysics';
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
}

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
  const profileXCanvasRef = useRef<HTMLCanvasElement>(null); // bottom profile (X axis)
  const profileYCanvasRef = useRef<HTMLCanvasElement>(null); // right profile (Y axis)
  
  // Cursor screen position for crosshair + profiles (-1 = not hovering)
  const mouseScreenRef = useRef({ x: -1, y: -1 });
  
  // State
  const [dimensions, setDimensions] = useState<Dimensions>({ width: 800, height: 600 });
  const [, setHoveredNode] = useState<GraphNode | null>(null);
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  const [overlaysVisible, setOverlaysVisible] = useState(false);
  
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
  }), [recenter, triggerCreationAnimation, createNode, destroyNode, updateLinks]);
  
  // Container resize
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          setDimensions({ width: w, height: h });
        }
      }
    });
    
    resizeObserver.observe(canvasRef.current);
    return () => resizeObserver.disconnect();
  }, []);
  
  // ==================== Cached CSS Colors ====================
  
  // Cache CSS variables to avoid getComputedStyle every frame
  const cssColorsRef = useRef<{ lowR: number; lowG: number; lowB: number; highR: number; highG: number; highB: number } | null>(null);
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
  
  // Store grid dims + owner map for plateau hit testing
  const plateauGridRef = useRef({ gridW: 0, gridH: 0, gs: TERRAIN_GRID_RES });
  
  // Hovered contour level index (-1 = none)
  const hoveredContourLevelRef = useRef(-1);
  
  // ==================== Render Function ====================
  
  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: w, height: h } = dimensions;
    const dpr = window.devicePixelRatio || 1;
    const t = transformRef.current;
    
    // Reset transform and clear full backing store, then apply DPR scale
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w * dpr, h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    const { visibleNodes } = frameDataRef.current;
    const terrainHeights = frameDataRef.current.terrainHeights;
    const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
    const { accentColor, textColor } = cssVarsRef.current;
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
        // Label — only if this single node is hovered
        if (hoveredNodeRef.current?.id === node.id) {
          ctx.fillStyle = textColor;
          ctx.font = '10px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const displayName = node.displayName.length > 35 ? node.displayName.slice(0, 35) + '...' : node.displayName;
          ctx.fillText(displayName, sx, sy + 6);
        }
      }
      return;
    }
    
    // Generate height field — adaptive grid: finer when zoomed out, coarser when zoomed in
    const gs = Math.max(2, Math.min(8, Math.round(TERRAIN_GRID_RES * Math.sqrt(t.scale))));
    const gridW = Math.ceil(w / gs);
    const gridH = Math.ceil(h / gs);
    const gridSize = gridW * gridH;
    
    // Fast integer hash for deterministic per-cell noise (no Math.random, stable across frames)
    // Uses node id + angular octave to create organic per-peak shape variation
    const ihash = (a: number, b: number): number => {
      let h = (a * 374761393 + b * 668265263 + 1274126177) | 0;
      h = Math.imul(h ^ (h >>> 13), 1103515245);
      return ((h ^ (h >>> 16)) & 0x7fffffff) / 0x7fffffff; // 0..1
    };
    
    // Reuse typed-array buffers across frames
    if (!heightMapBufRef.current || heightMapBufRef.current.length < gridSize) {
      heightMapBufRef.current = new Float32Array(gridSize);
      tempMapBufRef.current = new Float32Array(gridSize);
      ownerMapRef.current = new Int32Array(gridSize);
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
    
    // Build height map + ownership map with MAX merge — sqrt-free
    let nodeIdx = 0;
    for (const node of visibleNodes) {
      let H = terrainHeights.get(node.id) ?? 0;
      const peakSize = terrainPeakRadii.get(node.id) ?? 0;
      
      if (H <= 0) { nodeIdx++; continue; }
      nodePeakH[nodeIdx] = H;
      
      const Rp = (TERRAIN_BASE_PLATEAU_RADIUS + TERRAIN_PEAK_PLATEAU_BONUS * peakSize) * t.scale / gs;
      const Rs = (TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_BONUS * peakSize) * t.scale / gs;
      const RpSq = Rp * Rp;
      const RsSq = Rs * Rs;
      const invSlopeRangeSq = 1 / (RsSq - RpSq);
      
      const centerX = (node.x * t.scale + t.x) / gs;
      const centerY = (node.y * t.scale + t.y) / gs;
      
      // Star-shaped distortion: child directions for this node
      const dirs = nodeChildDirs[nodeIdx];
      const hasDirs = dirs.length > 0;
      
      // Expand bounding box to account for stretch
      const rsInt = Math.ceil(Rs * (hasDirs ? (1 + TERRAIN_ANISOTROPY) : 1));
      const minGx = Math.max(0, Math.floor(centerX - rsInt));
      const maxGx = Math.min(gridW - 1, Math.ceil(centerX + rsInt));
      const minGy = Math.max(0, Math.floor(centerY - rsInt));
      const maxGy = Math.min(gridH - 1, Math.ceil(centerY + rsInt));
      
      for (let gy = minGy; gy <= maxGy; gy++) {
        const dy = gy - centerY;
        const rowOff = gy * gridW;
        for (let gx = minGx; gx <= maxGx; gx++) {
          const dx = gx - centerX;
          let distSq = dx * dx + dy * dy;
          
          // Star-shaped: reduce effective distance when aligned with any child direction
          // Each child creates a "finger" extending the plateau toward it
          if (hasDirs && distSq > 0.01) {
            const invDist = 1 / Math.sqrt(distSq);
            const udx = dx * invDist;
            const udy = dy * invDist;
            // Find max alignment with any child direction
            let maxAlign = 0;
            for (let d = 0; d < dirs.length; d++) {
              const dot = udx * dirs[d].nx + udy * dirs[d].ny;
              if (dot > maxAlign) maxAlign = dot;
            }
            // Smooth ramp: only stretch when well-aligned (dot > 0.5)
            if (maxAlign > 0.5) {
              const ramp = (maxAlign - 0.5) * 2; // 0 at dot=0.5, 1 at dot=1.0
              const shrink = 1 / (1 + TERRAIN_ANISOTROPY * ramp * ramp);
              distSq *= shrink * shrink;
            }
          }
          
          if (distSq > RsSq) continue;
          
          // Angular noise: perturb effective distance based on angle from center
          // Uses 6 octaves keyed to node id for stable, per-peak irregularity
          if (TERRAIN_NOISE_STRENGTH > 0 && distSq > 0.01) {
            const ang = Math.atan2(dy, dx);
            // Sum 2 octaves of angular noise for organic shape
            const n1 = ihash(node.id, Math.floor(ang * 3 + 100)) * 2 - 1; // -1..1
            const n2 = ihash(node.id, Math.floor(ang * 7 + 200)) * 2 - 1;
            const noise = (n1 * 0.7 + n2 * 0.3) * TERRAIN_NOISE_STRENGTH;
            distSq *= (1 + noise) * (1 + noise);
          }
          
          // Quartic falloff (1 - t²): height stays high at mid-range, drops steeply at edge
          // Creates wider overlap zones between peaks for natural saddle formation
          const ndSq = distSq <= RpSq ? 0 : (distSq - RpSq) * invSlopeRangeSq; // 0..1
          const ht = H * (1 - ndSq * ndSq);
          
          const idx = rowOff + gx;
          if (ht > heightMap[idx]) {
            heightMap[idx] = ht;
            ownerMap[idx] = nodeIdx;
          }
        }
      }
      nodeIdx++;
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
      cssColorsRef.current = { lowR: lR, lowG: lG, lowB: lB, highR: hR, highG: hG, highB: hB };
      cssColorsDirtyRef.current = false;
    }
    const { lowR, lowG, lowB, highR, highG, highB } = cssColorsRef.current;
    
    // Build set of selected node indices for dimming
    const selIdSet = selectedNodeIdsRef.current;
    const hasSelection = selIdSet.size > 0;
    const selectedNodeIndices = new Set<number>();
    if (hasSelection) {
      for (let i = 0; i < visibleNodes.length; i++) {
        if (selIdSet.has(visibleNodes[i].id)) {
          selectedNodeIndices.add(i);
        }
      }
    }
    
    // Draw contour lines — marching squares with selection-aware gradient blending
    // When nodes are selected, segments blend between dim (non-selected) and bright (selected)
    // based on the ownership of the 4 cell corners, creating smooth gradient transitions
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.setLineDash(LINE_DASH_NONE);
    
    const DIM_OPACITY_FACTOR = 0.25;
    const MIN_SEG_LEN_SQ = 4; // Skip contour segments shorter than 2px (avoids floating islands)
    
    // Reusable segment buffers for gradient buckets: 0%,25%,50%,75%,100% bright
    // Each buffer stores flat x1,y1,x2,y2 coordinates
    const segBufs: number[][] = [[], [], [], [], []];
    
    // Segment emitter: filters short segments, routes to ctx path or gradient buffer
    const emitDirect = (x1: number, y1: number, x2: number, y2: number) => {
      const dx = x2 - x1, dy = y2 - y1;
      if (dx * dx + dy * dy >= MIN_SEG_LEN_SQ) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    };
    const emitBucket = (x1: number, y1: number, x2: number, y2: number, bucket: number) => {
      const dx = x2 - x1, dy = y2 - y1;
      if (dx * dx + dy * dy >= MIN_SEG_LEN_SQ) { segBufs[bucket].push(x1, y1, x2, y2); }
    };
    
    for (let li = 0; li < CONTOUR_LEVELS.length; li++) {
      const level = CONTOUR_LEVELS[li];
      const isMajor = (li + 1) % 5 === 0;
      const isHovered = li === hoveredContourLevelRef.current;
      const baseOpacity = isHovered ? 0.9 : 0.25 + level * 0.5;
      const baseLineWidth = isHovered ? 2.5 : isMajor ? 1.6 + level * 1.2 : 0.8 + level * 0.8;
      
      // Bright style (no selection or selected peaks)
      const brightR = Math.round(lowR + (highR - lowR) * level);
      const brightG = Math.round(lowG + (highG - lowG) * level);
      const brightB = Math.round(lowB + (highB - lowB) * level);
      const dimLW = Math.max(0.5, baseLineWidth * 0.7);
      
      if (hasSelection) {
        for (let b = 0; b < 5; b++) segBufs[b].length = 0;
      } else {
        ctx.strokeStyle = `rgba(${brightR}, ${brightG}, ${brightB}, ${baseOpacity})`;
        ctx.lineWidth = baseLineWidth;
        ctx.beginPath();
      }
      
      // Marching squares grid traversal
      for (let gy = 0; gy < gridH - 1; gy++) {
        const rowOff = gy * gridW;
        const nextRowOff = rowOff + gridW;
        const py = gy * gs;
        for (let gx = 0; gx < gridW - 1; gx++) {
          const v00 = heightMap[rowOff + gx];
          const v10 = heightMap[rowOff + gx + 1];
          const v01 = heightMap[nextRowOff + gx];
          const v11 = heightMap[nextRowOff + gx + 1];
          
          const code = (v00 >= level ? 8 : 0) | (v10 >= level ? 4 : 0) |
                       (v11 >= level ? 2 : 0) | (v01 >= level ? 1 : 0);
          if (code === 0 || code === 15) continue;
          
          const px = gx * gs;
          
          // Edge interpolation
          const topD = v10 - v00;
          const topT = topD === 0 ? 0.5 : (level - v00) / topD;
          const rightD = v11 - v10;
          const rightT = rightD === 0 ? 0.5 : (level - v10) / rightD;
          const bottomD = v11 - v01;
          const bottomT = bottomD === 0 ? 0.5 : (level - v01) / bottomD;
          const leftD = v01 - v00;
          const leftT = leftD === 0 ? 0.5 : (level - v00) / leftD;
          
          const topX = px + topT * gs, topY = py;
          const rightX = px + gs, rightY = py + rightT * gs;
          const bottomX = px + bottomT * gs, bottomY = py + gs;
          const leftX = px, leftY = py + leftT * gs;
          
          if (hasSelection) {
            // Compute ownership-based gradient bucket from 4 corner owners
            const o00 = ownerMap[rowOff + gx];
            const o10 = ownerMap[rowOff + gx + 1];
            const o01 = ownerMap[nextRowOff + gx];
            const o11 = ownerMap[nextRowOff + gx + 1];
            let selCount = 0, validCount = 0;
            if (o00 >= 0) { validCount++; if (selectedNodeIndices.has(o00)) selCount++; }
            if (o10 >= 0) { validCount++; if (selectedNodeIndices.has(o10)) selCount++; }
            if (o01 >= 0) { validCount++; if (selectedNodeIndices.has(o01)) selCount++; }
            if (o11 >= 0) { validCount++; if (selectedNodeIndices.has(o11)) selCount++; }
            const bucket = validCount > 0 ? Math.round(selCount / validCount * 4) : 0;
            
            switch (code) {
              case 1: emitBucket(leftX, leftY, bottomX, bottomY, bucket); break;
              case 2: emitBucket(bottomX, bottomY, rightX, rightY, bucket); break;
              case 3: emitBucket(leftX, leftY, rightX, rightY, bucket); break;
              case 4: emitBucket(topX, topY, rightX, rightY, bucket); break;
              case 5: emitBucket(leftX, leftY, topX, topY, bucket); emitBucket(bottomX, bottomY, rightX, rightY, bucket); break;
              case 6: emitBucket(topX, topY, bottomX, bottomY, bucket); break;
              case 7: emitBucket(leftX, leftY, topX, topY, bucket); break;
              case 8: emitBucket(topX, topY, leftX, leftY, bucket); break;
              case 9: emitBucket(topX, topY, bottomX, bottomY, bucket); break;
              case 10: emitBucket(topX, topY, rightX, rightY, bucket); emitBucket(leftX, leftY, bottomX, bottomY, bucket); break;
              case 11: emitBucket(topX, topY, rightX, rightY, bucket); break;
              case 12: emitBucket(leftX, leftY, rightX, rightY, bucket); break;
              case 13: emitBucket(bottomX, bottomY, rightX, rightY, bucket); break;
              case 14: emitBucket(leftX, leftY, bottomX, bottomY, bucket); break;
            }
          } else {
            // No selection: draw directly into batched path
            switch (code) {
              case 1: emitDirect(leftX, leftY, bottomX, bottomY); break;
              case 2: emitDirect(bottomX, bottomY, rightX, rightY); break;
              case 3: emitDirect(leftX, leftY, rightX, rightY); break;
              case 4: emitDirect(topX, topY, rightX, rightY); break;
              case 5: emitDirect(leftX, leftY, topX, topY); emitDirect(bottomX, bottomY, rightX, rightY); break;
              case 6: emitDirect(topX, topY, bottomX, bottomY); break;
              case 7: emitDirect(leftX, leftY, topX, topY); break;
              case 8: emitDirect(topX, topY, leftX, leftY); break;
              case 9: emitDirect(topX, topY, bottomX, bottomY); break;
              case 10: emitDirect(topX, topY, rightX, rightY); emitDirect(leftX, leftY, bottomX, bottomY); break;
              case 11: emitDirect(topX, topY, rightX, rightY); break;
              case 12: emitDirect(leftX, leftY, rightX, rightY); break;
              case 13: emitDirect(bottomX, bottomY, rightX, rightY); break;
              case 14: emitDirect(leftX, leftY, bottomX, bottomY); break;
            }
          }
        }
      }
      
      if (hasSelection) {
        // Draw each gradient bucket with interpolated dim↔bright style
        for (let b = 0; b < 5; b++) {
          const buf = segBufs[b];
          if (buf.length === 0) continue;
          const frac = b / 4; // 0=fully dim, 1=fully bright
          const r = Math.round(lowR + (brightR - lowR) * frac);
          const g = Math.round(lowG + (brightG - lowG) * frac);
          const bl = Math.round(lowB + (brightB - lowB) * frac);
          const op = baseOpacity * DIM_OPACITY_FACTOR + (baseOpacity - baseOpacity * DIM_OPACITY_FACTOR) * frac;
          const lw = dimLW + (baseLineWidth - dimLW) * frac;
          ctx.strokeStyle = `rgba(${r}, ${g}, ${bl}, ${op})`;
          ctx.lineWidth = lw;
          ctx.beginPath();
          for (let i = 0; i < buf.length; i += 4) {
            ctx.moveTo(buf[i], buf[i + 1]);
            ctx.lineTo(buf[i + 2], buf[i + 3]);
          }
          ctx.stroke();
        }
      } else {
        ctx.stroke();
      }
    }
    
    ctx.restore();
    
    // ==================== Draw Hovered Label ====================
    
    const hovNode = hoveredNodeRef.current;
    if (hovNode) {
      const sx = hovNode.x * t.scale + t.x;
      const sy = hovNode.y * t.scale + t.y;
      
      if (sx >= -60 && sx <= w + 60 && sy >= -20 && sy <= h + 20) {
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = 1;
        
        // Text outline for readability on colored plateaus
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        const displayName = hovNode.displayName.length > 35 
          ? hovNode.displayName.slice(0, 35) + '...' 
          : hovNode.displayName;
        ctx.strokeText(displayName, sx, sy + 6);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(displayName, sx, sy + 6);
      }
    }
    
    // ==================== Draw Selected Peak Outlines ====================
    
    const selIds = selectedNodeIdsRef.current;
    if (selIds.size > 0) {
      ctx.save();
      
      const OUTLINE_SAMPLES = 48; // angular samples for shape tracing
      const OUTLINE_PAD = 8; // px outside plateau edge
      const MAX_STRETCH = 1.6; // clamp elongation so outline stays near peak
      
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
        const hasDirs = dirs.length > 0;
        
        const nodeColor = getNodeColor(node, currentClassColors, accentColor);
        
        // Trace outline path by sampling angles
        ctx.beginPath();
        for (let si = 0; si <= OUTLINE_SAMPLES; si++) {
          const ang = (si / OUTLINE_SAMPLES) * 2 * Math.PI;
          const cosA = Math.cos(ang);
          const sinA = Math.sin(ang);
          
          // Start with base plateau radius, then apply shape modifiers
          let r = baseR;
          
          // Star-shaped stretch toward child directions (same logic as height map)
          if (hasDirs) {
            let maxAlign = 0;
            for (let d = 0; d < dirs.length; d++) {
              const dot = cosA * dirs[d].nx + sinA * dirs[d].ny;
              if (dot > maxAlign) maxAlign = dot;
            }
            if (maxAlign > 0.5) {
              const ramp = (maxAlign - 0.5) * 2;
              const stretch = 1 + TERRAIN_ANISOTROPY * ramp * ramp;
              // Clamp stretch to prevent excessive elongation
              r *= Math.min(Math.sqrt(stretch), MAX_STRETCH);
            }
          }
          
          // Angular noise (same hash as height map)
          if (TERRAIN_NOISE_STRENGTH > 0) {
            const n1 = ihash(node.id, Math.floor(ang * 3 + 100)) * 2 - 1;
            const n2 = ihash(node.id, Math.floor(ang * 7 + 200)) * 2 - 1;
            const noise = (n1 * 0.7 + n2 * 0.3) * TERRAIN_NOISE_STRENGTH;
            r *= 1 / (1 + noise); // inverse because height map multiplies distSq
          }
          
          const px = sx + cosA * (r + OUTLINE_PAD);
          const py = sy + sinA * (r + OUTLINE_PAD);
          
          if (si === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        
        // Outer colored glow
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = nodeColor;
        ctx.lineWidth = 4;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        
        // Inner white ring
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        // Label for selected nodes (always visible)
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        const displayName = node.displayName.length > 35 
          ? node.displayName.slice(0, 35) + '...' 
          : node.displayName;
        ctx.strokeText(displayName, sx, sy + 6);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(displayName, sx, sy + 6);
      }
      
      ctx.restore();
    }
    
    // ==================== Draw Crosshair Lines ====================
    const mx = mouseScreenRef.current.x;
    const my = mouseScreenRef.current.y;
    if (mx >= 0 && my >= 0 && !isPanningRef.current && !dragNodeRef.current) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      // Vertical line
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, h);
      ctx.stroke();
      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(0, my);
      ctx.lineTo(w, my);
      ctx.stroke();
      
      // Center cross marker
      const CROSS_SIZE = 8;
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx - CROSS_SIZE, my);
      ctx.lineTo(mx + CROSS_SIZE, my);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx, my - CROSS_SIZE);
      ctx.lineTo(mx, my + CROSS_SIZE);
      ctx.stroke();
      ctx.restore();
    }
  }, [dimensions]);
  
  // Set up render function and context
  useEffect(() => {
    renderRef.current = render;
  }, [render, renderRef]);
  
  // ==================== Profile Drawing ====================
  
  const drawProfiles = useCallback(() => {
    const heightMap = heightMapBufRef.current;
    const { gridW: gW, gridH: gH, gs: pGs } = plateauGridRef.current;
    if (!heightMap || gW === 0) return;
    
    const mx = mouseScreenRef.current.x;
    const my = mouseScreenRef.current.y;
    const { width: w, height: h } = dimensions;
    
    // Card inset constants (must match CSS)
    const INSET = 12;
    const CROSS_INSET = 68; // space reserved for the perpendicular card + gap
    
    // --- Bottom profile (X axis): sample heightMap along row at cursor Y ---
    const xCanvas = profileXCanvasRef.current;
    if (xCanvas) {
      const xCtx = xCanvas.getContext('2d');
      const xParent = xCanvas.parentElement;
      if (xCtx && xParent) {
        const cw = xParent.clientWidth;
        const ch = xParent.clientHeight;
        xCanvas.width = cw;
        xCanvas.height = ch;
        xCtx.clearRect(0, 0, cw, ch);
        
        if (mx >= 0 && my >= 0) {
          const gy = Math.floor(my / pGs);
          if (gy >= 0 && gy < gH) {
            // Card spans terrain x=[INSET, w - CROSS_INSET]
            const tLeft = INSET;
            const tRight = w - CROSS_INSET;
            const tSpan = tRight - tLeft;
            
            xCtx.beginPath();
            xCtx.moveTo(0, ch);
            for (let px = 0; px < cw; px++) {
              const terrainX = tLeft + (px / cw) * tSpan;
              const gx = Math.min(Math.max(Math.floor(terrainX / pGs), 0), gW - 1);
              const val = heightMap[gy * gW + gx];
              const py = ch - val * (ch - 4);
              if (px === 0) xCtx.lineTo(0, py);
              else xCtx.lineTo(px, py);
            }
            xCtx.lineTo(cw, ch);
            xCtx.closePath();
            xCtx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            xCtx.fill();
            xCtx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            xCtx.lineWidth = 1;
            xCtx.beginPath();
            for (let px = 0; px < cw; px++) {
              const terrainX = tLeft + (px / cw) * tSpan;
              const gx = Math.min(Math.max(Math.floor(terrainX / pGs), 0), gW - 1);
              const val = heightMap[gy * gW + gx];
              const py = ch - val * (ch - 4);
              if (px === 0) xCtx.moveTo(0, py);
              else xCtx.lineTo(px, py);
            }
            xCtx.stroke();
            
            // Cursor marker line (aligned to terrain position)
            const cardMx = (mx - tLeft) / tSpan * cw;
            xCtx.setLineDash([4, 3]);
            xCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            xCtx.beginPath();
            xCtx.moveTo(cardMx, 0);
            xCtx.lineTo(cardMx, ch);
            xCtx.stroke();
            
            // Dot at cursor position on the profile outline
            const curGx = Math.min(Math.max(Math.floor(mx / pGs), 0), gW - 1);
            const curVal = heightMap[gy * gW + curGx];
            const dotY = ch - curVal * (ch - 4);
            xCtx.setLineDash([]);
            xCtx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            xCtx.beginPath();
            xCtx.arc(cardMx, dotY, 3, 0, Math.PI * 2);
            xCtx.fill();
            
            // Node position dots — show dots where nodes project onto X axis
            const t = transformRef.current;
            const { visibleNodes } = frameDataRef.current;
            const NODE_DOT_MAX_DIST = 120; // pixels: max distance for dot to appear
            for (const node of visibleNodes) {
              const nsx = node.x * t.scale + t.x;
              const nsy = node.y * t.scale + t.y;
              // Distance from cursor's Y line to node's Y position
              const distY = Math.abs(nsy - my);
              if (distY > NODE_DOT_MAX_DIST) continue;
              // Map node screen X to card X
              if (nsx < tLeft || nsx > tRight) continue;
              const cardNx = (nsx - tLeft) / tSpan * cw;
              // Sample height at node's grid position for Y placement
              const ngx = Math.min(Math.max(Math.floor(nsx / pGs), 0), gW - 1);
              const nVal = heightMap[gy * gW + ngx];
              const ndotY = ch - nVal * (ch - 4);
              // Proximity factor: 1 at dist=0, 0 at dist=NODE_DOT_MAX_DIST
              const prox = 1 - distY / NODE_DOT_MAX_DIST;
              const dotR = 1.5 + prox * 2; // radius 1.5 → 3.5
              xCtx.globalAlpha = 0.2 + prox * 0.5;
              xCtx.fillStyle = '#ffffff';
              xCtx.beginPath();
              xCtx.arc(cardNx, ndotY, dotR, 0, Math.PI * 2);
              xCtx.fill();
            }
            xCtx.globalAlpha = 1;
          }
        }
      }
    }
    
    // --- Right profile (Y axis): sample heightMap along column at cursor X ---
    // Inverted: height grows right-to-left (profile faces toward the terrain)
    const yCanvas = profileYCanvasRef.current;
    if (yCanvas) {
      const yCtx = yCanvas.getContext('2d');
      const yParent = yCanvas.parentElement;
      if (yCtx && yParent) {
        const cw = yParent.clientWidth;
        const ch = yParent.clientHeight;
        yCanvas.width = cw;
        yCanvas.height = ch;
        yCtx.clearRect(0, 0, cw, ch);
        
        if (mx >= 0 && my >= 0) {
          const gx = Math.min(Math.max(Math.floor(mx / pGs), 0), gW - 1);
          if (gx >= 0 && gx < gW) {
            // Card spans terrain y=[INSET, h - CROSS_INSET]
            const tTop = INSET;
            const tBottom = h - CROSS_INSET;
            const tSpan = tBottom - tTop;
            
            // Inverted: fill from right edge, profile line goes left
            yCtx.beginPath();
            yCtx.moveTo(cw, 0);
            for (let py = 0; py < ch; py++) {
              const terrainY = tTop + (py / ch) * tSpan;
              const gy = Math.min(Math.max(Math.floor(terrainY / pGs), 0), gH - 1);
              const val = heightMap[gy * gW + gx];
              const px = cw - val * (cw - 4);
              if (py === 0) yCtx.lineTo(px, 0);
              else yCtx.lineTo(px, py);
            }
            yCtx.lineTo(cw, ch);
            yCtx.closePath();
            yCtx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            yCtx.fill();
            yCtx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            yCtx.lineWidth = 1;
            yCtx.beginPath();
            for (let py = 0; py < ch; py++) {
              const terrainY = tTop + (py / ch) * tSpan;
              const gy = Math.min(Math.max(Math.floor(terrainY / pGs), 0), gH - 1);
              const val = heightMap[gy * gW + gx];
              const px = cw - val * (cw - 4);
              if (py === 0) yCtx.moveTo(px, 0);
              else yCtx.lineTo(px, py);
            }
            yCtx.stroke();
            
            // Cursor marker line (aligned to terrain position)
            const cardMy = (my - tTop) / tSpan * ch;
            yCtx.setLineDash([4, 3]);
            yCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            yCtx.beginPath();
            yCtx.moveTo(0, cardMy);
            yCtx.lineTo(cw, cardMy);
            yCtx.stroke();
            
            // Dot at cursor position on the profile outline
            const curGy = Math.min(Math.max(Math.floor(my / pGs), 0), gH - 1);
            const curValY = heightMap[curGy * gW + gx];
            const dotX = cw - curValY * (cw - 4);
            yCtx.setLineDash([]);
            yCtx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            yCtx.beginPath();
            yCtx.arc(dotX, cardMy, 3, 0, Math.PI * 2);
            yCtx.fill();
            
            // Node position dots — show dots where nodes project onto Y axis
            const t = transformRef.current;
            const { visibleNodes } = frameDataRef.current;
            const NODE_DOT_MAX_DIST = 120;
            for (const node of visibleNodes) {
              const nsx = node.x * t.scale + t.x;
              const nsy = node.y * t.scale + t.y;
              // Distance from cursor's X line to node's X position
              const distX = Math.abs(nsx - mx);
              if (distX > NODE_DOT_MAX_DIST) continue;
              // Map node screen Y to card Y
              if (nsy < tTop || nsy > tBottom) continue;
              const cardNy = (nsy - tTop) / tSpan * ch;
              // Sample height at node's grid position for X placement (inverted)
              const ngy = Math.min(Math.max(Math.floor(nsy / pGs), 0), gH - 1);
              const nVal = heightMap[ngy * gW + gx];
              const ndotX = cw - nVal * (cw - 4);
              // Proximity factor
              const prox = 1 - distX / NODE_DOT_MAX_DIST;
              const dotR = 1.5 + prox * 2;
              yCtx.globalAlpha = 0.2 + prox * 0.5;
              yCtx.fillStyle = '#ffffff';
              yCtx.beginPath();
              yCtx.arc(ndotX, cardNy, dotR, 0, Math.PI * 2);
              yCtx.fill();
            }
            yCtx.globalAlpha = 1;
          }
        }
      }
    }
  }, [dimensions]);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctxRef.current = ctx;
    }
  }, [ctxRef]);
  
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
    const { gridW, gridH } = plateauGridRef.current;
    if (!ownerMap || !heightMap || gridW === 0) return null;
    
    const { gs: hitGs } = plateauGridRef.current;
    const gx = Math.floor(screenX / hitGs);
    const gy = Math.floor(screenY / hitGs);
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
      const { gridW: gW, gridH: gH, gs: hitGs } = plateauGridRef.current;
      if (heightMap && gW > 0) {
        const gx = Math.floor(screenX / hitGs);
        const gy = Math.floor(screenY / hitGs);
        if (gx >= 0 && gx < gW && gy >= 0 && gy < gH) {
          const h = heightMap[gy * gW + gx];
          if (h > 0) {
            // Find the outermost (lowest) contour level that the cursor is inside
            // i.e. the highest contour level still <= current height
            for (let i = CONTOUR_LEVELS.length - 1; i >= 0; i--) {
              if (CONTOUR_LEVELS[i] <= h) { newContourLevel = i; break; }
            }
          }
        }
      }
      
      if (newContourLevel !== hoveredContourLevelRef.current) {
        hoveredContourLevelRef.current = newContourLevel;
        if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
      }
      
      // Update mouse position and redraw profiles
      mouseScreenRef.current = { x: screenX, y: screenY };
      setOverlaysVisible(true);
      drawProfiles();
      // Redraw main canvas for crosshair lines
      if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
        renderRef.current(ctxRef.current);
      }
      
      if (canvas) {
        canvas.style.cursor = 'none';
      }
      
      if (node !== hoveredNodeRef.current) {
        hoveredNodeRef.current = node;
        setHoveredNode(node);
        onHoveredNodeChange?.(node);
        if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
      }
    }
  }, [getCanvasCoordinates, getNodeAtPosition, getNodeInPlateau, screenToWorld, onHoveredNodeChange, setTransformDirect, wakeSimulation, drawProfiles]);
  
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
  }, [dragNodeRef, dragStartTimeRef]);
  
  const handleMouseLeave = useCallback(() => {
    handleMouseUp();
    mouseScreenRef.current = { x: -1, y: -1 };
    hoveredContourLevelRef.current = -1;
    setOverlaysVisible(false);
    drawProfiles();
    if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
      renderRef.current(ctxRef.current);
    }
  }, [handleMouseUp, drawProfiles]);
  
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
  
  // ==================== Render ====================
  
  return (
    <div className={`node-graph-renderer ${className}`} ref={containerRef}>
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
        style={{ cursor: 'none' }}
      />
      <Card
        variant="dashed"
        elevation="none"
        padding={false}
        radius="sm"
        className={`terrain-profile-card terrain-profile-card--right${overlaysVisible ? ' terrain-overlay--visible' : ''}`}
      >
        <canvas ref={profileYCanvasRef} className="terrain-profile-canvas" />
      </Card>
      <Card
        variant="dashed"
        elevation="none"
        padding={false}
        radius="sm"
        className={`terrain-profile-card terrain-profile-card--bottom${overlaysVisible ? ' terrain-overlay--visible' : ''}`}
      >
        <canvas ref={profileXCanvasRef} className="terrain-profile-canvas" />
      </Card>
    </div>
  );
});

TerrainRenderer.displayName = 'TerrainRenderer';

export default TerrainRenderer;