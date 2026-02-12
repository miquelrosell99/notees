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

import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo } from 'react';
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
    
    const heightMap = new Float32Array(gridW * gridH);
    
    // Build height map with MAX merge
    for (const node of visibleNodes) {
      let H = terrainHeights.get(node.id) ?? 0;
      const peakSize = terrainPeakRadii.get(node.id) ?? 0;
      
      if (H > 0) H = Math.max(H, TERRAIN_MIN_HEIGHT);
      if (H <= 0) continue;
      
      const Rp = (TERRAIN_BASE_PLATEAU_RADIUS + TERRAIN_PEAK_PLATEAU_BONUS * peakSize) * t.scale / TERRAIN_GRID_RES;
      const Rs = (TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_BONUS * peakSize) * t.scale / TERRAIN_GRID_RES;
      
      const centerX = (node.x * t.scale + t.x) / TERRAIN_GRID_RES;
      const centerY = (node.y * t.scale + t.y) / TERRAIN_GRID_RES;
      
      const rsInt = Math.ceil(Rs);
      const minGx = Math.max(0, Math.floor(centerX - rsInt));
      const maxGx = Math.min(gridW - 1, Math.ceil(centerX + rsInt));
      const minGy = Math.max(0, Math.floor(centerY - rsInt));
      const maxGy = Math.min(gridH - 1, Math.ceil(centerY + rsInt));
      
      for (let gy = minGy; gy <= maxGy; gy++) {
        for (let gx = minGx; gx <= maxGx; gx++) {
          const dx = gx - centerX;
          const dy = gy - centerY;
          const d = Math.sqrt(dx * dx + dy * dy);
          
          if (d > Rs) continue;
          
          let ht: number;
          if (d <= Rp) {
            ht = H;
          } else {
            ht = H * (1 - (d - Rp) / (Rs - Rp));
          }
          
          const idx = gy * gridW + gx;
          if (ht > heightMap[idx]) {
            heightMap[idx] = ht;
          }
        }
      }
    }
    
    // Apply gaussian blur
    const blurKernel = (src: Float32Array, dst: Float32Array, bw: number, bh: number) => {
      for (let y = 1; y < bh - 1; y++) {
        for (let x = 1; x < bw - 1; x++) {
          const i = y * bw + x;
          dst[i] = (
            src[i - bw - 1] + src[i - bw] * 2 + src[i - bw + 1] +
            src[i - 1] * 2 + src[i] * 4 + src[i + 1] * 2 +
            src[i + bw - 1] + src[i + bw] * 2 + src[i + bw + 1]
          ) / 16;
        }
      }
      for (let x = 0; x < bw; x++) { dst[x] = src[x]; dst[(bh - 1) * bw + x] = src[(bh - 1) * bw + x]; }
      for (let y = 0; y < bh; y++) { dst[y * bw] = src[y * bw]; dst[y * bw + bw - 1] = src[y * bw + bw - 1]; }
    };
    
    const tempMap = new Float32Array(gridW * gridH);
    blurKernel(heightMap, tempMap, gridW, gridH);
    blurKernel(tempMap, heightMap, gridW, gridH);
    blurKernel(heightMap, tempMap, gridW, gridH);
    blurKernel(tempMap, heightMap, gridW, gridH);
    
    const getHeight = (gx: number, gy: number): number => {
      if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) return 0;
      return heightMap[gy * gridW + gx];
    };
    
    // Read CSS variables for contour color gradient
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
    const [lowR, lowG, lowB] = parseHex(colorLow);
    const [highR, highG, highB] = parseHex(colorHigh);
    
    const getContourColor = (level: number, opacity: number): string => {
      const tVal = level;
      const r = Math.round(lowR + (highR - lowR) * tVal);
      const g = Math.round(lowG + (highG - lowG) * tVal);
      const b = Math.round(lowB + (highB - lowB) * tVal);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    };
    
    // Draw contour lines
    ctx.save();
    // Draw in screen space (no transform needed, heightMap is already transformed)
    
    for (const level of CONTOUR_LEVELS) {
      const opacity = 0.25 + level * 0.5;
      ctx.strokeStyle = getContourColor(level, opacity);
      ctx.lineWidth = 0.6 + level * 0.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash(LINE_DASH_NONE);
      
      // Marching squares
      const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
      
      for (let gy = 0; gy < gridH - 1; gy++) {
        for (let gx = 0; gx < gridW - 1; gx++) {
          const v00 = getHeight(gx, gy);
          const v10 = getHeight(gx + 1, gy);
          const v01 = getHeight(gx, gy + 1);
          const v11 = getHeight(gx + 1, gy + 1);
          
          const code = (v00 >= level ? 8 : 0) | (v10 >= level ? 4 : 0) |
                       (v11 >= level ? 2 : 0) | (v01 >= level ? 1 : 0);
          
          if (code === 0 || code === 15) continue;
          
          const lerp = (va: number, vb: number): number => {
            const d = vb - va;
            return d === 0 ? 0.5 : (level - va) / d;
          };
          
          const top = lerp(v00, v10);
          const right = lerp(v10, v11);
          const bottom = lerp(v01, v11);
          const left = lerp(v00, v01);
          
          const px = gx * TERRAIN_GRID_RES;
          const py = gy * TERRAIN_GRID_RES;
          const gs = TERRAIN_GRID_RES;
          
          const edgePoints: Record<string, [number, number]> = {
            top: [px + top * gs, py],
            right: [px + gs, py + right * gs],
            bottom: [px + bottom * gs, py + gs],
            left: [px, py + left * gs],
          };
          
          const addSegment = (e1: string, e2: string) => {
            const [x1, y1] = edgePoints[e1];
            const [x2, y2] = edgePoints[e2];
            segments.push({ x1, y1, x2, y2 });
          };
          
          switch (code) {
            case 1: addSegment('left', 'bottom'); break;
            case 2: addSegment('bottom', 'right'); break;
            case 3: addSegment('left', 'right'); break;
            case 4: addSegment('top', 'right'); break;
            case 5: addSegment('left', 'top'); addSegment('bottom', 'right'); break;
            case 6: addSegment('top', 'bottom'); break;
            case 7: addSegment('left', 'top'); break;
            case 8: addSegment('top', 'left'); break;
            case 9: addSegment('top', 'bottom'); break;
            case 10: addSegment('top', 'right'); addSegment('left', 'bottom'); break;
            case 11: addSegment('top', 'right'); break;
            case 12: addSegment('left', 'right'); break;
            case 13: addSegment('bottom', 'right'); break;
            case 14: addSegment('left', 'bottom'); break;
          }
        }
      }
      
      // Chain segments into polylines
      if (segments.length > 0) {
        const EPS = 0.5;
        const ptKey = (x: number, y: number) => `${Math.round(x / EPS)},${Math.round(y / EPS)}`;
        const chains: Array<Array<[number, number]>> = [];
        const used = new Uint8Array(segments.length);
        
        const endpointIndex = new Map<string, number[]>();
        for (let i = 0; i < segments.length; i++) {
          const s = segments[i];
          const k1 = ptKey(s.x1, s.y1);
          const k2 = ptKey(s.x2, s.y2);
          if (!endpointIndex.has(k1)) endpointIndex.set(k1, []);
          if (!endpointIndex.has(k2)) endpointIndex.set(k2, []);
          endpointIndex.get(k1)!.push(i);
          endpointIndex.get(k2)!.push(i);
        }
        
        for (let i = 0; i < segments.length; i++) {
          if (used[i]) continue;
          used[i] = 1;
          const s = segments[i];
          const chain: Array<[number, number]> = [[s.x1, s.y1], [s.x2, s.y2]];
          
          // Extend forward
          let currentEnd = ptKey(s.x2, s.y2);
          let extended = true;
          while (extended) {
            extended = false;
            const candidates = endpointIndex.get(currentEnd);
            if (candidates) {
              for (const ci of candidates) {
                if (used[ci]) continue;
                const cs = segments[ci];
                const k1 = ptKey(cs.x1, cs.y1);
                const k2 = ptKey(cs.x2, cs.y2);
                if (k1 === currentEnd) {
                  used[ci] = 1;
                  chain.push([cs.x2, cs.y2]);
                  currentEnd = k2;
                  extended = true;
                  break;
                } else if (k2 === currentEnd) {
                  used[ci] = 1;
                  chain.push([cs.x1, cs.y1]);
                  currentEnd = k1;
                  extended = true;
                  break;
                }
              }
            }
          }
          
          // Extend backward
          let currentStart = ptKey(chain[0][0], chain[0][1]);
          extended = true;
          while (extended) {
            extended = false;
            const candidates = endpointIndex.get(currentStart);
            if (candidates) {
              for (const ci of candidates) {
                if (used[ci]) continue;
                const cs = segments[ci];
                const k1 = ptKey(cs.x1, cs.y1);
                const k2 = ptKey(cs.x2, cs.y2);
                if (k1 === currentStart) {
                  used[ci] = 1;
                  chain.unshift([cs.x2, cs.y2]);
                  currentStart = k2;
                  extended = true;
                  break;
                } else if (k2 === currentStart) {
                  used[ci] = 1;
                  chain.unshift([cs.x1, cs.y1]);
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
        
        // Smooth chain points
        const smoothChain = (pts: Array<[number, number]>): Array<[number, number]> => {
          if (pts.length < 5) return pts;
          const smoothed: Array<[number, number]> = [[pts[0][0], pts[0][1]]];
          for (let i = 1; i < pts.length - 1; i++) {
            const x = (pts[i - 1][0] + pts[i][0] * 2 + pts[i + 1][0]) / 4;
            const y = (pts[i - 1][1] + pts[i][1] * 2 + pts[i + 1][1]) / 4;
            smoothed.push([x, y]);
          }
          smoothed.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
          return smoothed;
        };
        
        // Draw chains as Catmull-Rom splines
        for (let chain of chains) {
          if (chain.length < 2) continue;
          
          if (chain.length >= 5) {
            chain = smoothChain(chain);
            chain = smoothChain(chain);
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
              
              const cp1x = p1[0] + (p2[0] - p0[0]) / tension;
              const cp1y = p1[1] + (p2[1] - p0[1]) / tension;
              const cp2x = p2[0] - (p3[0] - p1[0]) / tension;
              const cp2y = p2[1] - (p3[1] - p1[1]) / tension;
              
              ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
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
        {terrainNodes.map(({ id, node, x, y, height }) => {
          const screenX = x * transform.scale + transform.x;
          const screenY = y * transform.scale + transform.y;
          return (
            <div
              key={id}
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
              onDoubleClick={(e) => {
                e.stopPropagation();
                onNodeDoubleClick?.(node);
              }}
            >
              <Bullet 
                nodeId={node.id} 
                isPage={node.type === 'page'}
                hasChildren={false}
                interactive={true}
                title={node.name}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  onNodeClick?.(node, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
                }}
                onContextMenu={(_nodeId: number, e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onNodeRightClick?.(node);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

TerrainRenderer.displayName = 'TerrainRenderer';

export default TerrainRenderer;
