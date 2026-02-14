/**
 * GraphRenderer Component
 * 
 * Renders the standard graph visualization (normal, circle, tree modes).
 * Uses useNodePhysics hook for simulation.
 * Handles:
 * - Canvas rendering of nodes, links, glare effects
 * - Level circle guides (tree/circle modes)
 * - Mouse interactions (pan, zoom, drag, click)
 * - Node/link hit testing
 */

import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import type {
  GraphNode,
  GraphLink,
  GraphSettings,
  VisibilityFilters,
  GraphLayoutMode,
  ClassColor,
  Dimensions,
} from './viewTypes';
import {
  // Constants
  NODE_HOVER_RADIUS_EXTRA,
  GLARE_SCALE_NORMAL,
  GLARE_SCALE_BRIGHT,
  GLARE_SCALE_CURRENT,
  GLARE_OPACITY_NORMAL,
  GLARE_OPACITY_BRIGHT,
  GLARE_OPACITY_DIM,
  LABEL_FADE_ZOOM_MIN,
  LABEL_FADE_ZOOM_MAX,
  LINE_DASH_NONE,
  LINE_DASH_DOTTED,
  // Helpers
  pairKey,
  linkTypeId,
  getNodeRadius,
  getGlareRadius,
  getNodeColor,
  hexToRgba,
} from './viewTypes';
import { useNodePhysics } from './useNodePhysics';
import './graph-renderer.css';

// ==================== Types ====================

export interface GraphRendererProps {
  nodes: GraphNode[];
  links: GraphLink[];
  viewMode: GraphLayoutMode;
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

export interface GraphRendererRef {
  recenter: () => void;
  triggerCreationAnimation: () => void;
  createNode: (node: GraphNode) => void;
  destroyNode: (nodeId: number) => void;
  updateLinks: (links: GraphLink[]) => void;
  pauseSimulation: () => void;
  resumeSimulation: () => void;
  simulationPausedRef: React.MutableRefObject<boolean>;
}

// ==================== Component ====================

export const GraphRenderer = forwardRef<GraphRendererRef, GraphRendererProps>(({
  nodes: inputNodes,
  links: inputLinks,
  viewMode,
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
  const lastClickedLinkRef = useRef<{ source: number; target: number } | null>(null);
  
  // Link direction cache (reused per frame)
  const linkDirCacheRef = useRef(new Map<number, number>());
  const drawnLinksCacheRef = useRef(new Set<number>());
  
  // Physics hook
  const physics = useNodePhysics({
    inputNodes,
    inputLinks,
    viewMode,
    settings,
    visibilityFilters,
    classColors,
    selectedNodeIds,
    currentNodeId,
    dimensions,
    isTerrainMode: false,
  });
  
  // Destructure physics
  const {
    frameDataRef,
    transformRef,
    setTransformDirect,
    dragNodeRef,
    dragStartTimeRef,
    dragLiftProgressRef,
    wakeSimulation,
    simulationSleepingRef,
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
    getLinkAtPosition,
    settingsRef,
    classColorsRef,
    viewModeRef,
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
    const currentSettings = settingsRef.current;
    const currentClassColors = classColorsRef.current;
    const currentViewMode = viewModeRef.current;
    
    ctx.clearRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);
    
    const { textColor, accentColor, dimColor, outlineColor, warningColor } = cssVarsRef.current;
    const { visibleNodes, visibleLinks, nodeMap, maxConnections, maxMass } = frameDataRef.current;
    
    // Build link direction map
    const linkDirections = linkDirCacheRef.current;
    linkDirections.clear();
    for (const link of visibleLinks) {
      const key = pairKey(link.source, link.target);
      const prev = linkDirections.get(key) || 0;
      if (link.source < link.target) {
        linkDirections.set(key, prev | 1);
      } else {
        linkDirections.set(key, prev | 2);
      }
    }
    
    // Draw links
    const drawnLinks = drawnLinksCacheRef.current;
    drawnLinks.clear();
    
    for (const link of visibleLinks) {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (!source || !target) continue;
      
      const linkKey = pairKey(link.source, link.target) * 10 + linkTypeId(link.type);
      if (drawnLinks.has(linkKey)) continue;
      drawnLinks.add(linkKey);
      
      const isParentLink = link.type === 'parent';
      const isClassLink = link.type === 'class';
      const isExtendsLink = link.type === 'extends';
      const dirBits = linkDirections.get(pairKey(link.source, link.target)) || 0;
      const hasFwd = !!(dirBits & 1);
      const hasRev = !!(dirBits & 2);
      
      const renderAsParent = isParentLink || isExtendsLink;
      
      ctx.beginPath();
      ctx.strokeStyle = hexToRgba(outlineColor, 0.4);
      ctx.lineWidth = 1.5;
      
      if (renderAsParent || isClassLink) {
        ctx.setLineDash(LINE_DASH_NONE);
      } else {
        ctx.setLineDash(LINE_DASH_DOTTED);
      }
      
      const arrowGap = 2;
      const sourceLineGlare = getGlareRadius(source, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
      const targetLineGlare = getGlareRadius(target, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
      
      const dotSize = 4;
      const hasTargetDot = !renderAsParent && link.source === source.id;
      const hasSourceDot = renderAsParent || (!renderAsParent && hasFwd && hasRev);
      
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < 0.001) continue;
      
      const ux = dx / dist;
      const uy = dy / dist;
      
      const targetOffset = hasTargetDot ? (arrowGap + dotSize) : arrowGap;
      const sourceOffset = hasSourceDot ? (arrowGap + dotSize) : arrowGap;
      const trimStart = sourceLineGlare + sourceOffset;
      const trimEnd = targetLineGlare + targetOffset;
      
      if (trimStart + trimEnd >= dist) continue;
      
      const lineStartX = source.x + ux * trimStart;
      const lineStartY = source.y + uy * trimStart;
      const lineEndX = target.x - ux * trimEnd;
      const lineEndY = target.y - uy * trimEnd;
      
      const lineAngle = Math.atan2(dy, dx);
      
      // Draw line
      if (isClassLink) {
        // Wavy line for class links
        const lineDx = lineEndX - lineStartX;
        const lineDy = lineEndY - lineStartY;
        const lineLength = Math.sqrt(lineDx * lineDx + lineDy * lineDy);
        const waveFrequency = 0.3;
        const waveAmplitude = 3;
        const segments = Math.max(Math.floor(lineLength / 2), 10);
        
        ctx.beginPath();
        ctx.moveTo(lineStartX, lineStartY);
        
        for (let i = 1; i < segments; i++) {
          const tParam = i / segments;
          const baseX = lineStartX + lineDx * tParam;
          const baseY = lineStartY + lineDy * tParam;
          
          const waveOffset = Math.sin(tParam * lineLength * waveFrequency) * waveAmplitude;
          const perpAngle = lineAngle + Math.PI / 2;
          const x = baseX + waveOffset * Math.cos(perpAngle);
          const y = baseY + waveOffset * Math.sin(perpAngle);
          
          ctx.lineTo(x, y);
        }
        ctx.lineTo(lineEndX, lineEndY);
        ctx.stroke();
      } else {
        ctx.moveTo(lineStartX, lineStartY);
        ctx.lineTo(lineEndX, lineEndY);
        ctx.stroke();
      }
      
      // Draw arrow dots
      const skipTargetDot = target.uuid === '00000000-0000-0000-0001-000000000001' || target.uuid === '00000000-0000-0000-0001-000000000002';
      const skipSourceDot = source.uuid === '00000000-0000-0000-0001-000000000001' || source.uuid === '00000000-0000-0000-0001-000000000002';
      
      if (renderAsParent) {
        if (!skipSourceDot) {
          const revAngle = lineAngle + Math.PI;
          const cx = source.x - (sourceLineGlare + 2 + dotSize / 2) * Math.cos(revAngle);
          const cy = source.y - (sourceLineGlare + 2 + dotSize / 2) * Math.sin(revAngle);
          ctx.beginPath();
          ctx.arc(cx, cy, dotSize / 2, 0, 2 * Math.PI);
          ctx.strokeStyle = hexToRgba(outlineColor, 0.8);
          ctx.lineWidth = 1.5;
          ctx.setLineDash(LINE_DASH_NONE);
          ctx.stroke();
        }
      } else {
        if (link.source === source.id && !skipTargetDot) {
          const cx = target.x - (targetLineGlare + 2 + dotSize / 2) * Math.cos(lineAngle);
          const cy = target.y - (targetLineGlare + 2 + dotSize / 2) * Math.sin(lineAngle);
          ctx.beginPath();
          ctx.arc(cx, cy, dotSize / 2, 0, 2 * Math.PI);
          ctx.fillStyle = hexToRgba(outlineColor, 0.8);
          ctx.fill();
        }
        
        if (hasFwd && hasRev && !skipSourceDot) {
          const revAngle = lineAngle + Math.PI;
          const cx = source.x - (sourceLineGlare + 2 + dotSize / 2) * Math.cos(revAngle);
          const cy = source.y - (sourceLineGlare + 2 + dotSize / 2) * Math.sin(revAngle);
          ctx.beginPath();
          ctx.arc(cx, cy, dotSize / 2, 0, 2 * Math.PI);
          ctx.fillStyle = hexToRgba(outlineColor, 0.8);
          ctx.fill();
        }
      }
    }
    
    ctx.setLineDash(LINE_DASH_NONE);
    
    // Draw level circle guides (tree/circle modes)
    if (currentViewMode === 'tree' || currentViewMode === 'circle') {
      const centerX = w / 2;
      const centerY = h / 2;
      
      const radiiWithNodes = new Set<number>();
      for (const node of visibleNodes) {
        const treeRadius = (node as GraphNode & { _treeRadius?: number })._treeRadius;
        if (treeRadius !== undefined && treeRadius > 0) {
          radiiWithNodes.add(treeRadius);
        }
      }
      
      ctx.strokeStyle = hexToRgba(outlineColor, 0.1);
      ctx.lineWidth = 1;
      ctx.setLineDash(LINE_DASH_NONE);
      
      for (const radius of radiiWithNodes) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
    
    // Draw nodes
    const draggedNodeId = dragNodeRef.current?.id ?? null;
    const liftProgress = dragLiftProgressRef.current;
    const currentHoveredNode = hoveredNodeRef.current;
    
    let draggedNode: GraphNode | null = null;
    for (const node of visibleNodes) {
      if (node.id === draggedNodeId) { draggedNode = node; continue; }
      
      const isHovered = currentHoveredNode?.id === node.id;
      const isDragging = node.id === draggedNodeId;
      const baseRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
      const circleRadius = isHovered ? baseRadius + NODE_HOVER_RADIUS_EXTRA : baseRadius;
      const nodeColor = getNodeColor(node, currentClassColors, accentColor);
      
      // Shadow for dragged node
      if (isDragging && liftProgress > 0) {
        const shadowOffset = 4 * liftProgress;
        const shadowBlur = 12 * liftProgress;
        const shadowOpacity = 0.3 * liftProgress;
        
        ctx.save();
        ctx.shadowColor = hexToRgba(outlineColor, shadowOpacity);
        ctx.shadowBlur = shadowBlur;
        ctx.shadowOffsetX = shadowOffset;
        ctx.shadowOffsetY = shadowOffset;
        
        ctx.beginPath();
        ctx.fillStyle = nodeColor;
        ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.restore();
      }
      
      // Glare
      let glareScale = GLARE_SCALE_NORMAL;
      let glareOpacity = GLARE_OPACITY_NORMAL;
      
      switch (node.glare) {
        case 'bright':
          glareScale = GLARE_SCALE_BRIGHT;
          glareOpacity = GLARE_OPACITY_BRIGHT;
          break;
        case 'dim':
          glareOpacity = GLARE_OPACITY_DIM;
          break;
        case 'path':
          glareOpacity = GLARE_OPACITY_NORMAL;
          break;
        case 'current':
          glareScale = GLARE_SCALE_CURRENT;
          glareOpacity = 0.5;
          break;
      }
      
      const glareRadius = baseRadius * glareScale;
      
      ctx.beginPath();
      const glareColor = node.glare === 'current' 
        ? hexToRgba(warningColor, glareOpacity)
        : hexToRgba(nodeColor, glareOpacity);
      ctx.fillStyle = glareColor;
      ctx.arc(node.x, node.y, glareRadius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Node circle
      let displayColor = nodeColor;
      let nodeOpacity = 1;
      if (node.glare === 'dim') {
        displayColor = dimColor;
        nodeOpacity = 0.25;
      }
      
      ctx.beginPath();
      ctx.globalAlpha = nodeOpacity;
      ctx.fillStyle = displayColor;
      ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
      
      // Pin indicator
      if (node.pinned) {
        const pinRadius = circleRadius * 0.3;
        
        ctx.save();
        ctx.shadowColor = hexToRgba(outlineColor, 0.3);
        ctx.shadowBlur = 3;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        
        ctx.beginPath();
        ctx.fillStyle = textColor;
        ctx.arc(node.x, node.y, pinRadius, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.restore();
      }
      
      // Label
      const currentScale = transformRef.current.scale;
      const zoomOpacity = currentScale <= LABEL_FADE_ZOOM_MIN 
        ? 0 
        : currentScale >= LABEL_FADE_ZOOM_MAX 
          ? 1 
          : (currentScale - LABEL_FADE_ZOOM_MIN) / (LABEL_FADE_ZOOM_MAX - LABEL_FADE_ZOOM_MIN);
      const dimOpacity = node.glare === 'dim' ? 0.12 : 1;
      const labelOpacity = zoomOpacity * dimOpacity;
      
      ctx.fillStyle = textColor;
      ctx.globalAlpha = labelOpacity;
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      
      const displayName = node.displayName.length > 35 
        ? node.displayName.slice(0, 35) + '...' 
        : node.displayName;
      ctx.fillText(displayName, node.x, node.y + baseRadius + 10);
      ctx.globalAlpha = 1;
    }
    
    // Second pass: draw dragged node on top
    if (draggedNode) {
      const node = draggedNode;
      const isHovered = currentHoveredNode?.id === node.id;
      const baseRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
      const circleRadius = isHovered ? baseRadius + NODE_HOVER_RADIUS_EXTRA : baseRadius;
      const nodeColor = getNodeColor(node, currentClassColors, accentColor);
      
      if (liftProgress > 0) {
        const shadowOffset = 4 * liftProgress;
        const shadowBlur = 12 * liftProgress;
        const shadowOpacity = 0.3 * liftProgress;
        ctx.save();
        ctx.shadowColor = hexToRgba(outlineColor, shadowOpacity);
        ctx.shadowBlur = shadowBlur;
        ctx.shadowOffsetX = shadowOffset;
        ctx.shadowOffsetY = shadowOffset;
        ctx.beginPath();
        ctx.fillStyle = nodeColor;
        ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }
      
      let glareScale = GLARE_SCALE_NORMAL;
      let glareOpacity = GLARE_OPACITY_NORMAL;
      switch (node.glare) {
        case 'bright': glareScale = GLARE_SCALE_BRIGHT; glareOpacity = GLARE_OPACITY_BRIGHT; break;
        case 'dim': glareOpacity = GLARE_OPACITY_DIM; break;
        case 'path': break;
        case 'current': glareScale = GLARE_SCALE_CURRENT; glareOpacity = 0.5; break;
      }
      const glareRadius = baseRadius * glareScale;
      ctx.beginPath();
      ctx.fillStyle = node.glare === 'current'
        ? hexToRgba(warningColor, glareOpacity)
        : hexToRgba(nodeColor, glareOpacity);
      ctx.arc(node.x, node.y, glareRadius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      if (node.glare === 'dim') {
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = dimColor;
      } else {
        ctx.fillStyle = nodeColor;
      }
      ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (node.pinned) {
        ctx.save();
        ctx.shadowColor = hexToRgba(outlineColor, 0.3); ctx.shadowBlur = 3; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1;
        ctx.beginPath(); ctx.fillStyle = textColor;
        ctx.arc(node.x, node.y, circleRadius * 0.3, 0, 2 * Math.PI); ctx.fill();
        ctx.restore();
      }
      const currentScale = transformRef.current.scale;
      const zoomOpacity = currentScale <= LABEL_FADE_ZOOM_MIN ? 0 : currentScale >= LABEL_FADE_ZOOM_MAX ? 1 : (currentScale - LABEL_FADE_ZOOM_MIN) / (LABEL_FADE_ZOOM_MAX - LABEL_FADE_ZOOM_MIN);
      const dimOp = node.glare === 'dim' ? 0.12 : 1;
      ctx.fillStyle = textColor; ctx.globalAlpha = zoomOpacity * dimOp;
      ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const displayName = node.name.length > 35 ? node.name.slice(0, 35) + '...' : node.name;
      ctx.fillText(displayName, node.x, node.y + baseRadius + 10);
      ctx.globalAlpha = 1;
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
  
  const getCanvasCoordinates = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
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
      // Constrain to ring in tree/circle modes
      if (viewModeRef.current === 'tree' || viewModeRef.current === 'circle') {
        const treeRadius = (dragNodeRef.current as GraphNode & { _treeRadius?: number })._treeRadius;
        if (treeRadius !== undefined) {
          const cx = dimensions.width / 2;
          const cy = dimensions.height / 2;
          const ddx = dragNodeRef.current.x - cx;
          const ddy = dragNodeRef.current.y - cy;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
          dragNodeRef.current.x = cx + (ddx / dist) * treeRadius;
          dragNodeRef.current.y = cy + (ddy / dist) * treeRadius;
        }
      }
      dragNodeRef.current.vx = 0;
      dragNodeRef.current.vy = 0;
      wakeSimulation();
      if (canvas) canvas.style.cursor = 'grabbing';
    } else {
      const node = getNodeAtPosition(screenX, screenY);
      const link = node ? null : getLinkAtPosition(screenX, screenY);
      
      if (canvas) {
        if (node) {
          canvas.style.cursor = 'pointer';
        } else if (link) {
          canvas.style.cursor = 'pointer';
        } else {
          canvas.style.cursor = 'grab';
        }
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
  }, [getCanvasCoordinates, getNodeAtPosition, getLinkAtPosition, screenToWorld, onHoveredNodeChange, setTransformDirect, wakeSimulation, dimensions]);
  
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
    
    // Check link click
    const link = getLinkAtPosition(screenX, screenY);
    if (link) {
      const lastLink = lastClickedLinkRef.current;
      const isSameLink = lastLink && 
        ((lastLink.source === link.source && lastLink.target === link.target) ||
         (lastLink.source === link.target && lastLink.target === link.source));
      
      const currentSelection = selectedNodeIds;
      const bothSelected = currentSelection.includes(link.source) && currentSelection.includes(link.target);
      
      if (isSameLink && bothSelected) {
        onSelectionChange?.([]);
        lastClickedLinkRef.current = null;
      } else {
        onSelectionChange?.([link.source, link.target]);
        lastClickedLinkRef.current = { source: link.source, target: link.target };
      }
      return;
    }
    
    lastClickedLinkRef.current = null;
    
    // Check node click
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
  }, [getCanvasCoordinates, getNodeAtPosition, getLinkAtPosition, onNodeClick, onNodeDoubleClick, onSelectionChange, selectedNodeIds]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    
    if (node) {
      onNodeRightClick?.(node);
    }
  }, [getCanvasCoordinates, getNodeAtPosition, onNodeRightClick]);
  
  // Wheel handler (native for passive: false)
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

GraphRenderer.displayName = 'GraphRenderer';

export default GraphRenderer;
