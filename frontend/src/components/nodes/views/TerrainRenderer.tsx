/**
 * TerrainRenderer Component
 * 
 * Renders the terrain visualization with contour lines and DOM bullet overlay.
 * Uses useNodePhysics hook for simulation.
 * Handles:
 * - Canvas rendering of contour lines (marching squares + Catmull-Rom splines)
 * - Height map generation from node mass/positions
 * - DOM overlay with Bullet components for each node
 * - Mouse interactions (pan, zoom, click)
 */

import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo, memo } from 'react';
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
} from './viewTypes';
import { useNodePhysics } from './useNodePhysics';
import Bullet from '../../blocks/Bullet';
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
  
  // Terrain node positions for DOM overlay
  const [terrainNodePositions, setTerrainNodePositions] = useState<Map<number, { x: number; y: number; height: number }>>(new Map());
  const terrainUpdateRafRef = useRef<number>(0);
  
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
    transform,
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
  // Flat segment buffer: stored as [x1, y1, x2, y2, x1, y1, x2, y2, ...]
  const segBufRef = useRef<Float32Array>(new Float32Array(4096));
  
  // ==================== Render Function ====================
  
  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: w, height: h } = dimensions;
    const t = transformRef.current;
    
    ctx.clearRect(0, 0, w, h);
    
    const { visibleNodes } = frameDataRef.current;
    const terrainHeights = frameDataRef.current.terrainHeights;
    const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
    
    // Update DOM overlay positions (throttled)
    if (!terrainUpdateRafRef.current) {
      terrainUpdateRafRef.current = requestAnimationFrame(() => {
        terrainUpdateRafRef.current = 0;
        const positions = new Map<number, { x: number; y: number; height: number }>();
        for (const node of visibleNodes) {
          const ht = terrainHeights.get(node.id) ?? 0;
          positions.set(node.id, { x: node.x, y: node.y, height: ht });
        }
        setTerrainNodePositions(positions);
      });
    }
    
    // Skip contour rendering if not enough nodes
    if (visibleNodes.length < 2) return;
    
    // Generate height field using overlapping terrain with preserved plateaus
    const gridW = Math.ceil(w / TERRAIN_GRID_RES);
    const gridH = Math.ceil(h / TERRAIN_GRID_RES);
    const gridSize = gridW * gridH;
    
    // Reuse typed-array buffers across frames
    if (!heightMapBufRef.current || heightMapBufRef.current.length < gridSize) {
      heightMapBufRef.current = new Float32Array(gridSize);
      tempMapBufRef.current = new Float32Array(gridSize);
    }
    const heightMap = heightMapBufRef.current;
    const tempMap = tempMapBufRef.current!;
    heightMap.fill(0, 0, gridSize);
    
    // Build height map with MAX merge
    for (const node of visibleNodes) {
      let H = terrainHeights.get(node.id) ?? 0;
      const peakSize = terrainPeakRadii.get(node.id) ?? 0;
      
      if (H > 0) H = Math.max(H, TERRAIN_MIN_HEIGHT);
      if (H <= 0) continue;
      
      const Rp = (TERRAIN_BASE_PLATEAU_RADIUS + TERRAIN_PEAK_PLATEAU_BONUS * peakSize) * t.scale / TERRAIN_GRID_RES;
      const Rs = (TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_BONUS * peakSize) * t.scale / TERRAIN_GRID_RES;
      const invSlopeWidth = 1 / (Rs - Rp);
      
      const centerX = (node.x * t.scale + t.x) / TERRAIN_GRID_RES;
      const centerY = (node.y * t.scale + t.y) / TERRAIN_GRID_RES;
      
      const rsInt = Math.ceil(Rs);
      const minGx = Math.max(0, Math.floor(centerX - rsInt));
      const maxGx = Math.min(gridW - 1, Math.ceil(centerX + rsInt));
      const minGy = Math.max(0, Math.floor(centerY - rsInt));
      const maxGy = Math.min(gridH - 1, Math.ceil(centerY + rsInt));
      const RsSq = Rs * Rs;
      
      for (let gy = minGy; gy <= maxGy; gy++) {
        const dy = gy - centerY;
        const dySq = dy * dy;
        const rowOff = gy * gridW;
        for (let gx = minGx; gx <= maxGx; gx++) {
          const dx = gx - centerX;
          const distSq = dx * dx + dySq;
          
          if (distSq > RsSq) continue;
          
          const d = Math.sqrt(distSq);
          const ht = d <= Rp ? H : H * (1 - (d - Rp) * invSlopeWidth);
          
          const idx = rowOff + gx;
          if (ht > heightMap[idx]) {
            heightMap[idx] = ht;
          }
        }
      }
    }
    
    // Apply gaussian blur (2 passes instead of 4 — sufficient with larger grid)
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
      // Copy edges
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
    
    // Draw contour lines
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(LINE_DASH_NONE);
    
    // Pre-compute grid height lookups inline (avoid function call overhead)
    const gs = TERRAIN_GRID_RES;
    
    for (const level of CONTOUR_LEVELS) {
      const opacity = 0.25 + level * 0.5;
      const r = Math.round(lowR + (highR - lowR) * level);
      const g = Math.round(lowG + (highG - lowG) * level);
      const b = Math.round(lowB + (highB - lowB) * level);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
      ctx.lineWidth = 0.6 + level * 0.8;
      
      // Marching squares with flat segment buffer
      let segCount = 0;
      let segBuf = segBufRef.current;
      
      const pushSeg = (x1: number, y1: number, x2: number, y2: number) => {
        const off = segCount * 4;
        if (off + 3 >= segBuf.length) {
          const newBuf = new Float32Array(segBuf.length * 2);
          newBuf.set(segBuf);
          segBuf = newBuf;
          segBufRef.current = newBuf;
        }
        segBuf[off] = x1; segBuf[off + 1] = y1;
        segBuf[off + 2] = x2; segBuf[off + 3] = y2;
        segCount++;
      };
      
      for (let gy = 0; gy < gridH - 1; gy++) {
        const rowOff = gy * gridW;
        const nextRowOff = rowOff + gridW;
        for (let gx = 0; gx < gridW - 1; gx++) {
          const v00 = heightMap[rowOff + gx];
          const v10 = heightMap[rowOff + gx + 1];
          const v01 = heightMap[nextRowOff + gx];
          const v11 = heightMap[nextRowOff + gx + 1];
          
          const code = (v00 >= level ? 8 : 0) | (v10 >= level ? 4 : 0) |
                       (v11 >= level ? 2 : 0) | (v01 >= level ? 1 : 0);
          
          if (code === 0 || code === 15) continue;
          
          // Compute edge interpolations inline
          const px = gx * gs;
          const py = gy * gs;
          
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
          
          switch (code) {
            case 1: pushSeg(leftX, leftY, bottomX, bottomY); break;
            case 2: pushSeg(bottomX, bottomY, rightX, rightY); break;
            case 3: pushSeg(leftX, leftY, rightX, rightY); break;
            case 4: pushSeg(topX, topY, rightX, rightY); break;
            case 5: pushSeg(leftX, leftY, topX, topY); pushSeg(bottomX, bottomY, rightX, rightY); break;
            case 6: pushSeg(topX, topY, bottomX, bottomY); break;
            case 7: pushSeg(leftX, leftY, topX, topY); break;
            case 8: pushSeg(topX, topY, leftX, leftY); break;
            case 9: pushSeg(topX, topY, bottomX, bottomY); break;
            case 10: pushSeg(topX, topY, rightX, rightY); pushSeg(leftX, leftY, bottomX, bottomY); break;
            case 11: pushSeg(topX, topY, rightX, rightY); break;
            case 12: pushSeg(leftX, leftY, rightX, rightY); break;
            case 13: pushSeg(bottomX, bottomY, rightX, rightY); break;
            case 14: pushSeg(leftX, leftY, bottomX, bottomY); break;
          }
        }
      }
      
      // Chain segments into polylines using integer key hashing
      if (segCount > 0) {
        const EPS_INV = 2; // 1/0.5
        const intKey = (x: number, y: number) => (Math.round(x * EPS_INV) + 100000) * 200001 + (Math.round(y * EPS_INV) + 100000);
        const chains: Array<Array<[number, number]>> = [];
        const used = new Uint8Array(segCount);
        
        const endpointIndex = new Map<number, number[]>();
        for (let i = 0; i < segCount; i++) {
          const off = i * 4;
          const k1 = intKey(segBuf[off], segBuf[off + 1]);
          const k2 = intKey(segBuf[off + 2], segBuf[off + 3]);
          let arr1 = endpointIndex.get(k1);
          if (!arr1) { arr1 = []; endpointIndex.set(k1, arr1); }
          arr1.push(i);
          let arr2 = endpointIndex.get(k2);
          if (!arr2) { arr2 = []; endpointIndex.set(k2, arr2); }
          arr2.push(i);
        }
        
        for (let i = 0; i < segCount; i++) {
          if (used[i]) continue;
          used[i] = 1;
          const off = i * 4;
          const chain: Array<[number, number]> = [
            [segBuf[off], segBuf[off + 1]],
            [segBuf[off + 2], segBuf[off + 3]]
          ];
          
          // Extend forward
          let currentEnd = intKey(segBuf[off + 2], segBuf[off + 3]);
          let extended = true;
          while (extended) {
            extended = false;
            const candidates = endpointIndex.get(currentEnd);
            if (candidates) {
              for (const ci of candidates) {
                if (used[ci]) continue;
                const co = ci * 4;
                const k1 = intKey(segBuf[co], segBuf[co + 1]);
                const k2 = intKey(segBuf[co + 2], segBuf[co + 3]);
                if (k1 === currentEnd) {
                  used[ci] = 1;
                  chain.push([segBuf[co + 2], segBuf[co + 3]]);
                  currentEnd = k2;
                  extended = true;
                  break;
                } else if (k2 === currentEnd) {
                  used[ci] = 1;
                  chain.push([segBuf[co], segBuf[co + 1]]);
                  currentEnd = k1;
                  extended = true;
                  break;
                }
              }
            }
          }
          
          // Extend backward
          let currentStart = intKey(chain[0][0], chain[0][1]);
          extended = true;
          while (extended) {
            extended = false;
            const candidates = endpointIndex.get(currentStart);
            if (candidates) {
              for (const ci of candidates) {
                if (used[ci]) continue;
                const co = ci * 4;
                const k1 = intKey(segBuf[co], segBuf[co + 1]);
                const k2 = intKey(segBuf[co + 2], segBuf[co + 3]);
                if (k1 === currentStart) {
                  used[ci] = 1;
                  chain.unshift([segBuf[co + 2], segBuf[co + 3]]);
                  currentStart = k2;
                  extended = true;
                  break;
                } else if (k2 === currentStart) {
                  used[ci] = 1;
                  chain.unshift([segBuf[co], segBuf[co + 1]]);
                  currentStart = k1;
                  extended = true;
                  break;
                }
              }
            }
          }
          
          if (chain.length >= 2) {
            chains.push(chain);
          }
        }
        
        // Draw chains as Catmull-Rom splines (single smoothing pass)
        for (let chain of chains) {
          if (chain.length < 2) continue;
          
          // Single smooth pass for chains long enough
          if (chain.length >= 5) {
            const smoothed: Array<[number, number]> = [[chain[0][0], chain[0][1]]];
            for (let i = 1; i < chain.length - 1; i++) {
              smoothed.push([
                (chain[i - 1][0] + chain[i][0] * 2 + chain[i + 1][0]) / 4,
                (chain[i - 1][1] + chain[i][1] * 2 + chain[i + 1][1]) / 4
              ]);
            }
            smoothed.push([chain[chain.length - 1][0], chain[chain.length - 1][1]]);
            chain = smoothed;
          }
          
          ctx.beginPath();
          
          if (chain.length === 2) {
            ctx.moveTo(chain[0][0], chain[0][1]);
            ctx.lineTo(chain[1][0], chain[1][1]);
          } else if (chain.length === 3) {
            ctx.moveTo(chain[0][0], chain[0][1]);
            ctx.quadraticCurveTo(chain[1][0], chain[1][1], chain[2][0], chain[2][1]);
          } else {
            const tension = 4;
            ctx.moveTo(chain[0][0], chain[0][1]);
            
            for (let j = 0; j < chain.length - 1; j++) {
              const p0 = chain[Math.max(0, j - 1)];
              const p1 = chain[j];
              const p2 = chain[j + 1];
              const p3 = chain[Math.min(chain.length - 1, j + 2)];
              
              ctx.bezierCurveTo(
                p1[0] + (p2[0] - p0[0]) / tension,
                p1[1] + (p2[1] - p0[1]) / tension,
                p2[0] - (p3[0] - p1[0]) / tension,
                p2[1] - (p3[1] - p1[1]) / tension,
                p2[0], p2[1]
              );
            }
          }
          
          ctx.stroke();
        }
      }
    }
    
    ctx.restore();
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
      const node = getNodeAtPosition(screenX, screenY);
      
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
  }, [getCanvasCoordinates, getNodeAtPosition, screenToWorld, onHoveredNodeChange, setTransformDirect, wakeSimulation]);
  
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    
    if (node) {
      dragNodeRef.current = node;
      dragStartTimeRef.current = Date.now();
    } else {
      isPanningRef.current = true;
      panStartRef.current = { x: screenX, y: screenY };
    }
  }, [getCanvasCoordinates, getNodeAtPosition, dragNodeRef, dragStartTimeRef]);
  
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
    
    const node = getNodeAtPosition(screenX, screenY);
    
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
  }, [getCanvasCoordinates, getNodeAtPosition, onNodeClick, onNodeDoubleClick, onSelectionChange]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    
    if (node) {
      onNodeRightClick?.(node);
    }
  }, [getCanvasCoordinates, getNodeAtPosition, onNodeRightClick]);
  
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
  
  // ==================== Terrain Nodes ====================
  
  const terrainNodes = useMemo(() => {
    return Array.from(terrainNodePositions.entries()).map(([id, pos]) => {
      const node = frameDataRef.current.nodeMap.get(id);
      return node ? { id, node, ...pos } : null;
    }).filter(Boolean) as Array<{ id: number; node: GraphNode; x: number; y: number; height: number }>;
  }, [terrainNodePositions]);
  
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
      <div className="node-graph-renderer__terrain-overlay" style={{ pointerEvents: 'none' }}>
        {terrainNodes.map(({ id, node, x, y, height }) => (
          <TerrainNodeOverlay
            key={id}
            node={node}
            screenX={x * transform.scale + transform.x}
            screenY={y * transform.scale + transform.y}
            height={height}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeRightClick={onNodeRightClick}
          />
        ))}
      </div>
    </div>
  );
});

TerrainRenderer.displayName = 'TerrainRenderer';

// Memoized terrain node overlay to prevent re-rendering unchanged nodes
interface TerrainNodeOverlayProps {
  node: GraphNode;
  screenX: number;
  screenY: number;
  height: number;
  onNodeClick?: (node: GraphNode, modifiers: { shiftKey: boolean; ctrlKey: boolean }) => void;
  onNodeDoubleClick?: (node: GraphNode) => void;
  onNodeRightClick?: (node: GraphNode) => void;
}

const TerrainNodeOverlay = memo(function TerrainNodeOverlay({
  node,
  screenX,
  screenY,
  height,
  onNodeClick,
  onNodeDoubleClick,
  onNodeRightClick,
}: TerrainNodeOverlayProps) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onNodeClick?.(node, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
  }, [node, onNodeClick]);
  
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onNodeDoubleClick?.(node);
  }, [node, onNodeDoubleClick]);
  
  const handleContextMenu = useCallback((_nodeId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onNodeRightClick?.(node);
  }, [node, onNodeRightClick]);
  
  return (
    <div
      className="terrain-node"
      style={{
        position: 'absolute',
        left: screenX,
        top: screenY,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'auto',
        opacity: node.glare === 'dim' ? 0.3 : 1,
      }}
      data-height={height.toFixed(2)}
      onDoubleClick={handleDoubleClick}
    >
      <Bullet 
        nodeId={node.id} 
        isPage={node.type === 'page'}
        hasChildren={false}
        interactive={true}
        title={node.name}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
}, (prev, next) => {
  // Custom comparison: skip re-render if position barely changed
  return prev.node.id === next.node.id &&
    prev.node.glare === next.node.glare &&
    Math.abs(prev.screenX - next.screenX) < 0.5 &&
    Math.abs(prev.screenY - next.screenY) < 0.5;
});

export default TerrainRenderer;