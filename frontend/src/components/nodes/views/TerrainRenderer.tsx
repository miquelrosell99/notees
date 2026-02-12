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
  TERRAIN_MIN_HEIGHT,
  TERRAIN_ANISOTROPY,
  TERRAIN_SADDLE_STRENGTH,
  LABEL_FADE_ZOOM_MIN,
  LABEL_FADE_ZOOM_MAX,
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
  
  // State
  const [dimensions, setDimensions] = useState<Dimensions>({ width: 800, height: 600 });
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const hoveredNodeRef = useRef<GraphNode | null>(null);
  
  // Pan state
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const didDragMoveRef = useRef(false);
  const wasJustDraggingRef = useRef(false);
  
  // Click tracking
  const lastClickTimeRef = useRef(0);
  const lastClickedNodeRef = useRef<number | null>(null);
  
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
  
  // ==================== Render Function ====================
  
  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: w, height: h } = dimensions;
    const t = transformRef.current;
    
    ctx.clearRect(0, 0, w, h);
    
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
        // Label
        ctx.fillStyle = textColor;
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const displayName = node.displayName.length > 35 ? node.displayName.slice(0, 35) + '...' : node.displayName;
        ctx.fillText(displayName, sx, sy + 6);
      }
      return;
    }
    
    // Generate height field — adaptive grid: finer when zoomed out, coarser when zoomed in
    const gs = Math.max(2, Math.min(8, Math.round(TERRAIN_GRID_RES * Math.sqrt(t.scale))));
    const gridW = Math.ceil(w / gs);
    const gridH = Math.ceil(h / gs);
    const gridSize = gridW * gridH;
    
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
    
    // Track second-best height per cell for saddle contrast
    const secondBest = new Float32Array(gridSize);
    
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
      
      if (H > 0) H = Math.max(H, TERRAIN_MIN_HEIGHT);
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
          
          // Squared-distance interpolation: avoids Math.sqrt entirely
          // Produces a smooth cosine-like falloff instead of linear
          const ht = distSq <= RpSq ? H : H * (1 - (distSq - RpSq) * invSlopeRangeSq);
          
          const idx = rowOff + gx;
          if (ht > heightMap[idx]) {
            secondBest[idx] = heightMap[idx]; // demote current best to second
            heightMap[idx] = ht;
            ownerMap[idx] = nodeIdx;
          } else if (ht > secondBest[idx]) {
            secondBest[idx] = ht; // track second-best from different owner
          }
        }
      }
      nodeIdx++;
    }
    
    // Saddle contrast: depress height where two peaks compete
    // The closer secondBest is to heightMap, the more we dip
    if (TERRAIN_SADDLE_STRENGTH > 0) {
      for (let i = 0; i < gridSize; i++) {
        const best = heightMap[i];
        const second = secondBest[i];
        if (second > 0 && best > 0) {
          // Competition ratio: 0 when second is tiny, 1 when second equals best
          const ratio = second / best;
          // Smooth ramp: only dip when ratio > 0.3 (peaks are close in height)
          if (ratio > 0.3) {
            const ramp = (ratio - 0.3) / 0.7; // 0 at ratio=0.3, 1 at ratio=1.0
            const dip = TERRAIN_SADDLE_STRENGTH * ramp * ramp;
            heightMap[i] = best * (1 - dip);
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
    
    // Draw contour lines — direct segment drawing, no chaining or splines
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.setLineDash(LINE_DASH_NONE);
    
    for (let li = 0; li < CONTOUR_LEVELS.length; li++) {
      const level = CONTOUR_LEVELS[li];
      const isMajor = (li + 1) % 5 === 0;
      const opacity = 0.25 + level * 0.5;
      const r = Math.round(lowR + (highR - lowR) * level);
      const g = Math.round(lowG + (highG - lowG) * level);
      const b = Math.round(lowB + (highB - lowB) * level);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
      ctx.lineWidth = isMajor ? 1.6 + level * 1.2 : 0.8 + level * 0.8;
      
      // Single batched path: marching squares segments drawn directly
      ctx.beginPath();
      
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
          
          // Inline edge interpolation
          const topD = v10 - v00;
          const topT = topD === 0 ? 0.5 : (level - v00) / topD;
          const rightD = v11 - v10;
          const rightT = rightD === 0 ? 0.5 : (level - v10) / rightD;
          const bottomD = v11 - v01;
          const bottomT = bottomD === 0 ? 0.5 : (level - v01) / bottomD;
          const leftD = v01 - v00;
          const leftT = leftD === 0 ? 0.5 : (level - v00) / leftD;
          
          // Edge midpoints
          const topX = px + topT * gs, topY = py;
          const rightX = px + gs, rightY = py + rightT * gs;
          const bottomX = px + bottomT * gs, bottomY = py + gs;
          const leftX = px, leftY = py + leftT * gs;
          
          // Draw segments directly into the batched path
          switch (code) {
            case 1: ctx.moveTo(leftX, leftY); ctx.lineTo(bottomX, bottomY); break;
            case 2: ctx.moveTo(bottomX, bottomY); ctx.lineTo(rightX, rightY); break;
            case 3: ctx.moveTo(leftX, leftY); ctx.lineTo(rightX, rightY); break;
            case 4: ctx.moveTo(topX, topY); ctx.lineTo(rightX, rightY); break;
            case 5: ctx.moveTo(leftX, leftY); ctx.lineTo(topX, topY); ctx.moveTo(bottomX, bottomY); ctx.lineTo(rightX, rightY); break;
            case 6: ctx.moveTo(topX, topY); ctx.lineTo(bottomX, bottomY); break;
            case 7: ctx.moveTo(leftX, leftY); ctx.lineTo(topX, topY); break;
            case 8: ctx.moveTo(topX, topY); ctx.lineTo(leftX, leftY); break;
            case 9: ctx.moveTo(topX, topY); ctx.lineTo(bottomX, bottomY); break;
            case 10: ctx.moveTo(topX, topY); ctx.lineTo(rightX, rightY); ctx.moveTo(leftX, leftY); ctx.lineTo(bottomX, bottomY); break;
            case 11: ctx.moveTo(topX, topY); ctx.lineTo(rightX, rightY); break;
            case 12: ctx.moveTo(leftX, leftY); ctx.lineTo(rightX, rightY); break;
            case 13: ctx.moveTo(bottomX, bottomY); ctx.lineTo(rightX, rightY); break;
            case 14: ctx.moveTo(leftX, leftY); ctx.lineTo(bottomX, bottomY); break;
          }
        }
      }
      
      ctx.stroke();
    }
    
    ctx.restore();
    
    // ==================== Draw Labels ====================
    
    const currentScale = t.scale;
    const zoomOpacity = currentScale <= LABEL_FADE_ZOOM_MIN 
      ? 0 
      : currentScale >= LABEL_FADE_ZOOM_MAX 
        ? 1 
        : (currentScale - LABEL_FADE_ZOOM_MIN) / (LABEL_FADE_ZOOM_MAX - LABEL_FADE_ZOOM_MIN);
    
    if (zoomOpacity > 0) {
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      
      for (const node of visibleNodes) {
        const sx = node.x * t.scale + t.x;
        const sy = node.y * t.scale + t.y;
        
        // Skip off-screen
        if (sx < -60 || sx > w + 60 || sy < -20 || sy > h + 20) continue;
        
        const dimOpacity = node.glare === 'dim' ? 0.4 : 1;
        ctx.globalAlpha = zoomOpacity * dimOpacity;
        
        // Text halo for readability on colored plateaus
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        const displayName = node.displayName.length > 35 
          ? node.displayName.slice(0, 35) + '...' 
          : node.displayName;
        ctx.strokeText(displayName, sx, sy + 6);
        ctx.fillStyle = textColor;
        ctx.fillText(displayName, sx, sy + 6);
      }
      ctx.globalAlpha = 1;
    }
  }, [dimensions]);
  
  // Set up render function and context
  useEffect(() => {
    renderRef.current = render;
  }, [render, renderRef]);
  
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
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
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
      }
      dragNodeRef.current.x = x;
      dragNodeRef.current.y = y;
      dragNodeRef.current.vx = 0;
      dragNodeRef.current.vy = 0;
      wakeSimulation();
      if (canvas) canvas.style.cursor = 'grabbing';
    } else {
      const node = getNodeAtPosition(screenX, screenY) || getNodeInPlateau(screenX, screenY);
      
      if (canvas) {
        canvas.style.cursor = node ? 'pointer' : 'grab';
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
  }, [getCanvasCoordinates, getNodeAtPosition, getNodeInPlateau, screenToWorld, onHoveredNodeChange, setTransformDirect, wakeSimulation]);
  
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
    
    if (didMove) {
      wasJustDraggingRef.current = true;
      setTimeout(() => {
        wasJustDraggingRef.current = false;
      }, 50);
    }
  }, [dragNodeRef, dragStartTimeRef]);
  
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
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const screenX = (e.clientX - rect.left) * scaleX;
    const screenY = (e.clientY - rect.top) * scaleY;
    
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
        width={dimensions.width}
        height={dimensions.height}
        className="node-graph-renderer__canvas"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ cursor: hoveredNode ? 'pointer' : isPanningRef.current ? 'grabbing' : 'grab' }}
      />
    </div>
  );
});

TerrainRenderer.displayName = 'TerrainRenderer';

export default TerrainRenderer;