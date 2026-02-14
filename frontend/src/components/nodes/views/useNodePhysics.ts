/**
 * useNodePhysics Hook
 * 
 * Extracts the physics simulation engine from NodeGraphRenderer.
 * Handles:
 * - Barnes-Hut N-body simulation (O(n log n))
 * - Node position updates with velocity/damping
 * - Topology caching (adjacency, mass, connection counts)
 * - Constrained mode positioning (circle/tree layouts)
 * - Transform state (pan/zoom)
 * - Node dragging
 * 
 * Used by both GraphRenderer and TerrainRenderer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GraphNode,
  GraphLink,
  GraphSettings,
  VisibilityFilters,
  GraphLayoutMode,
  QuadNode,
  FrameData,
  Transform,
  Dimensions,
  ClassColor,
} from './viewTypes';
import {
  // Constants
  LINKED_ATTRACTION_DISTANCE,
  ATTRACTION_STRENGTH,
  ATTRACTION_STRENGTH_LINK_COUNT,
  LINK_DAMPING,
  REPULSION_STRENGTH,
  UNLINKED_REPULSION_DISTANCE,
  MIN_REPULSION_DISTANCE,
  RETURN_FORCE,
  CENTER_GRAVITY,
  MAX_VELOCITY,
  VELOCITY_DAMPING,
  VELOCITY_DEADZONE,
  TERRAIN_VELOCITY_DAMPING,
  TERRAIN_VELOCITY_DEADZONE,
  TERRAIN_LINK_DAMPING,
  TERRAIN_MAX_VELOCITY,
  GRAPH_SLEEP_THRESHOLD,
  GRAPH_SLEEP_FRAMES,
  TERRAIN_SLEEP_THRESHOLD,
  TERRAIN_SLEEP_FRAMES,
  DRAG_PULL_STRENGTH,
  PARENT_MASS_PER_CHILD,
  REFERENCE_LINK_FORCE_MULTIPLIER,
  WARMUP_DURATION_FRAMES,
  MAX_SIMULATION_TIME_MS,
  TERRAIN_BASE_FOOTPRINT,
  TERRAIN_PEAK_FOOTPRINT,
  TERRAIN_SEPARATION_STRENGTH,
  TERRAIN_REF_LINK_MIN_SEPARATION,
  TERRAIN_REF_LINK_SEPARATION_STRENGTH,
  TERRAIN_BASE_SLOPE_RADIUS,
  TERRAIN_PEAK_SLOPE_RADIUS_BONUS,
  LINK_TYPE_PRIORITY,
  // Helpers
  getMaxSimulationFrames,
  getRenderSkip,
  getTerrainRenderSkip,
  pairKey,
  getGlareRadius,
  getNodeRadius,
  findPathBetweenNodes,
} from './viewTypes';

// ==================== Hook Props ====================

export interface UseNodePhysicsProps {
  inputNodes: GraphNode[];
  inputLinks: GraphLink[];
  viewMode: GraphLayoutMode | 'terrain';
  settings: GraphSettings;
  visibilityFilters: VisibilityFilters;
  classColors: ClassColor[];
  selectedNodeIds: number[];
  currentNodeId: number | null;
  dimensions: Dimensions;
  isTerrainMode?: boolean;
}

export interface UseGraphPhysicsReturn {
  // Node/link state
  nodesRef: React.MutableRefObject<GraphNode[]>;
  linksRef: React.MutableRefObject<GraphLink[]>;
  frameDataRef: React.MutableRefObject<FrameData>;
  
  // Transform state
  transform: Transform;
  transformRef: React.MutableRefObject<Transform>;
  setTransformDirect: (t: Transform) => void;
  
  // Drag state
  dragNodeRef: React.MutableRefObject<GraphNode | null>;
  dragStartTimeRef: React.MutableRefObject<number | null>;
  dragLiftProgressRef: React.MutableRefObject<number>;
  
  // Topology cache refs
  connectedPairsRef: React.MutableRefObject<Map<number, GraphLink['type']>>;
  adjacencyRef: React.MutableRefObject<Map<number, Set<number>>>;
  massCacheRef: React.MutableRefObject<Map<number, number>>;
  connectionCountsRef: React.MutableRefObject<Map<number, number>>;
  inLinkCountsRef: React.MutableRefObject<Map<number, number>>;
  outLinkCountsRef: React.MutableRefObject<Map<number, number>>;
  
  // Simulation control
  wakeSimulation: () => void;
  requestRender: () => void;
  simulationSleepingRef: React.MutableRefObject<boolean>;
  kineticEnergyRef: React.MutableRefObject<number>;
  simulationPausedRef: React.MutableRefObject<boolean>;
  pauseSimulation: () => void;
  resumeSimulation: () => void;
  
  // Canvas context (set by renderer)
  ctxRef: React.MutableRefObject<CanvasRenderingContext2D | null>;
  renderRef: React.MutableRefObject<((ctx: CanvasRenderingContext2D) => void) | null>;
  
  // Methods
  recenter: () => void;
  createNode: (node: GraphNode) => void;
  destroyNode: (nodeId: number) => void;
  updateLinks: (links: GraphLink[]) => void;
  triggerCreationAnimation: () => void;
  screenToWorld: (screenX: number, screenY: number) => { x: number; y: number };
  getNodeAtPosition: (screenX: number, screenY: number) => GraphNode | null;
  getLinkAtPosition: (screenX: number, screenY: number) => GraphLink | null;
  
  // Settings refs (for render access)
  settingsRef: React.MutableRefObject<GraphSettings>;
  classColorsRef: React.MutableRefObject<ClassColor[]>;
  selectedNodeIdsRef: React.MutableRefObject<number[]>;
  currentNodeIdRef: React.MutableRefObject<number | null>;
  viewModeRef: React.MutableRefObject<GraphLayoutMode | 'terrain'>;
  visibilityFiltersRef: React.MutableRefObject<VisibilityFilters>;
  
  // CSS vars cache
  cssVarsRef: React.MutableRefObject<{ textColor: string; accentColor: string; dimColor: string }>;
}

// ==================== Hook Implementation ====================

export function useNodePhysics({
  inputNodes,
  inputLinks,
  viewMode,
  settings,
  visibilityFilters,
  classColors,
  selectedNodeIds,
  currentNodeId,
  dimensions,
  isTerrainMode: _isTerrainMode = false,
}: UseNodePhysicsProps): UseGraphPhysicsReturn {
  
  // ==================== Refs ====================
  
  // Node/link state
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  
  // Settings refs (stable references for simulation closure)
  const settingsRef = useRef<GraphSettings>(settings);
  const classColorsRef = useRef<ClassColor[]>([...classColors].sort((a, b) => a.order - b.order));
  const selectedNodeIdsRef = useRef<number[]>(selectedNodeIds);
  const currentNodeIdRef = useRef<number | null>(currentNodeId);
  const viewModeRef = useRef<GraphLayoutMode | 'terrain'>(viewMode);
  const visibilityFiltersRef = useRef<VisibilityFilters>(visibilityFilters);
  const dimensionsRef = useRef<Dimensions>(dimensions);
  
  // CSS vars cache
  const cssVarsRef = useRef({ textColor: '#111111', accentColor: '#404040', dimColor: '#555555', outlineColor: '#a3a3a3', warningColor: '#d97706' });
  
  // Simulation state
  const animationRef = useRef<number>(0);
  const warmupFrameRef = useRef(0);
  const initialFitDoneRef = useRef(false);
  const centerGravityActiveRef = useRef(true);
  const topologyDirtyRef = useRef(true);
  
  // Drag state
  const dragNodeRef = useRef<GraphNode | null>(null);
  const dragStartTimeRef = useRef<number | null>(null);
  const dragLiftProgressRef = useRef(0);
  
  // Topology caches
  const connectedPairsRef = useRef<Map<number, GraphLink['type']>>(new Map());
  const adjacencyRef = useRef<Map<number, Set<number>>>(new Map());
  const childrenOfRef = useRef<Map<number, number[]>>(new Map());
  const massCacheRef = useRef<Map<number, number>>(new Map());
  const connectionCountsRef = useRef<Map<number, number>>(new Map());
  const inLinkCountsRef = useRef<Map<number, number>>(new Map());
  const outLinkCountsRef = useRef<Map<number, number>>(new Map());
  const inReferenceLinkCountsRef = useRef<Map<number, number>>(new Map());
  const outReferenceLinkCountsRef = useRef<Map<number, number>>(new Map());
  const allReferenceLinkCountsRef = useRef<Map<number, number>>(new Map());
  const linkForceJitterRef = useRef<Map<number, number>>(new Map()); // pairKey → random force multiplier [0.6, 1.0]
  const linkDistJitterRef = useRef<Map<number, number>>(new Map()); // pairKey → random rest distance multiplier [0.8, 1.2]
  
  // Barnes-Hut quadtree pool
  const quadPoolRef = useRef<QuadNode[]>([]);
  const quadPoolIdxRef = useRef(0);
  const bhStackRef = useRef<Array<QuadNode | null>>(new Array(256).fill(null));
  
  // Frame data (shared with render)
  const frameDataRef = useRef<FrameData>({
    visibleNodes: [],
    visibleLinks: [],
    nodeMap: new Map(),
    maxConnections: 0,
    maxMass: 0,
    terrainHeights: new Map(),
    terrainPeakRadii: new Map(),
  });
  const frameNodeMapRef = useRef<Map<number, GraphNode>>(new Map());
  const frameVisibleLinksRef = useRef<GraphLink[]>([]);
  
  // Terrain data dirty flag — only recompute heights/radii when topology or settings change
  const terrainDataDirtyRef = useRef(true);  
  // Canvas context and render function (set by renderer)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const renderRef = useRef<((ctx: CanvasRenderingContext2D) => void) | null>(null);
  
  // Convergence-based simulation sleep
  const simulationSleepingRef = useRef(false);
  const kineticEnergyRef = useRef(0);
  const wakeSimulationRef = useRef<() => void>(() => {});
  const simulationGenerationRef = useRef(0);
  const sleepCounterRef = useRef(0);
  
  // User-controlled pause
  const simulationPausedRef = useRef(false);
  
  // Transform state
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const transformRafRef = useRef<number>(0);
  
  // Input node storage for filter comparison
  const inputNodesMapRef = useRef<Map<number, GraphNode>>(new Map());
  const allLinksRef = useRef<GraphLink[]>([]);
  
  // ==================== Transform Helpers ====================
  
  // Debounce timer for React state update (avoids re-render on every frame during pan)
  const transformDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const setTransformDirect = useCallback((t: Transform) => {
    transformRef.current = t;
    // Render canvas immediately via rAF (no React re-render)
    if (!transformRafRef.current) {
      transformRafRef.current = requestAnimationFrame(() => {
        transformRafRef.current = 0;
        if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
      });
    }
    // Debounce React state sync — only fires when panning stops (150ms idle)
    if (transformDebounceRef.current) clearTimeout(transformDebounceRef.current);
    transformDebounceRef.current = setTimeout(() => {
      transformDebounceRef.current = null;
      setTransform(transformRef.current);
    }, 150);
  }, []);
  
  const requestRender = useCallback(() => {
    if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
      renderRef.current(ctxRef.current);
    }
  }, []);
  
  const pauseSimulation = useCallback(() => {
    simulationPausedRef.current = true;
  }, []);
  
  const resumeSimulation = useCallback(() => {
    simulationPausedRef.current = false;
    wakeSimulationRef.current();
  }, []);
  
  // ==================== Coordinate Conversion ====================
  
  const screenToWorld = useCallback((screenX: number, screenY: number) => {
    const t = transformRef.current;
    return {
      x: (screenX - t.x) / t.scale,
      y: (screenY - t.y) / t.scale
    };
  }, []);
  
  // ==================== Visibility Helpers ====================
  
  const shouldNodeBeVisible = useCallback((node: GraphNode, filters: VisibilityFilters): boolean => {
    if (viewModeRef.current === 'terrain' && node.isClassNode) return false;
    if (node.isClassNode && !filters.showClassNodes) return false;
    if (node.isDaily && !filters.showDayPages) return false;
    if (node.isMonthly && !filters.showMonthPages) return false;
    if (node.isYearly && !filters.showYearPages) return false;
    if (node.isSystemPage && !filters.showSystemPages) return false;
    return true;
  }, []);
  
  const shouldLinkBeActive = useCallback((link: GraphLink, filters: VisibilityFilters): boolean => {
    if (link.type === 'class' && !filters.showClassLinks) return false;
    if ((link.type === 'parent' || link.type === 'extends') && !filters.showParentLinks) return false;
    if ((link.type === 'reference' || link.type === 'property-reference') && !filters.showReferenceLinks) return false;
    return true;
  }, []);
  
  // ==================== Position Calculation ====================
  
  const calculatePositions = useCallback((
    nodes: GraphNode[],
    mode: GraphLayoutMode | 'terrain',
    w: number,
    h: number,
    constraintMode: 'physics' | 'equidistant' = 'physics',
    nodeSizeMode: 'uniform' | 'connections' | 'mass' = 'uniform'
  ) => {
    const centerX = w / 2;
    const centerY = h / 2;
    
    // Compute max connections and mass for radius calculations
    let maxConn = 0, maxMass = 0;
    for (const n of nodes) {
      if (n.connectionCount > maxConn) maxConn = n.connectionCount;
      const m = (n as GraphNode & { _mass?: number })._mass ?? 1;
      if (m > maxMass) maxMass = m;
    }
    
    // Find the largest glare radius among all nodes to set spacing
    let maxGlareRadius = 0;
    for (const n of nodes) {
      const gr = getGlareRadius(n, nodeSizeMode, maxConn, maxMass);
      if (gr > maxGlareRadius) maxGlareRadius = gr;
    }
    if (maxGlareRadius === 0) maxGlareRadius = 6 * 2.5; // NODE_RADIUS_BASE * GLARE_SCALE_NORMAL
    
    const nodeSpacing = maxGlareRadius * 2 + 8;
    const levelGap = maxGlareRadius * 2 + 40;
    
    if (mode === 'circle') {
      const preferredRadius = Math.min(centerX, centerY) * 0.8;
      const minRadiusForCount = (nodes.length * nodeSpacing) / (2 * Math.PI);
      const radius = Math.max(preferredRadius, minRadiusForCount);
      nodes.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
        node.targetX = centerX + radius * Math.cos(angle);
        node.targetY = centerY + radius * Math.sin(angle);
        (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
        if (node.x === 0 && node.y === 0) {
          node.x = node.targetX;
          node.y = node.targetY;
        }
      });
    } else if (mode === 'tree') {
      // Build children map
      const childrenByParent = new Map<number, GraphNode[]>();
      for (const node of nodes) {
        if (node.parentId !== null) {
          const siblings = childrenByParent.get(node.parentId) || [];
          siblings.push(node);
          childrenByParent.set(node.parentId, siblings);
        }
      }
      
      // Calculate depth for each node using BFS
      const nodeDepth = new Map<number, number>();
      const visibleNodeIds = new Set(nodes.map(n => n.id));
      
      const classRoots = nodes.filter(n => n.isClassNode && (n.parentId === null || !visibleNodeIds.has(n.parentId)));
      const regularRoots = nodes.filter(n => !n.isClassNode && (n.parentId === null || !visibleNodeIds.has(n.parentId)));
      const hasVisibleClasses = classRoots.length > 0;
      
      for (const node of classRoots) {
        nodeDepth.set(node.id, 0);
      }
      
      const classQueue = [...classRoots];
      let maxClassDepth = 0;
      while (classQueue.length > 0) {
        const parent = classQueue.shift()!;
        const parentDepth = nodeDepth.get(parent.id)!;
        const children = childrenByParent.get(parent.id) || [];
        for (const child of children) {
          if (child.isClassNode) {
            const childDepth = parentDepth + 1;
            nodeDepth.set(child.id, childDepth);
            maxClassDepth = Math.max(maxClassDepth, childDepth);
            classQueue.push(child);
          }
        }
      }
      
      const regularRootLevel = hasVisibleClasses ? maxClassDepth + 1 : 0;
      for (const node of regularRoots) {
        nodeDepth.set(node.id, regularRootLevel);
      }
      
      const queue = [...regularRoots];
      for (const node of classRoots) queue.push(node);
      for (const node of nodes) {
        if (node.isClassNode && nodeDepth.has(node.id) && !classRoots.includes(node)) {
          queue.push(node);
        }
      }
      
      while (queue.length > 0) {
        const parent = queue.shift()!;
        const parentDepth = nodeDepth.get(parent.id)!;
        const children = childrenByParent.get(parent.id) || [];
        for (const child of children) {
          if (!nodeDepth.has(child.id)) {
            nodeDepth.set(child.id, parentDepth + 1);
            queue.push(child);
          }
        }
      }
      
      let maxDepth = 0;
      for (const depth of nodeDepth.values()) {
        maxDepth = Math.max(maxDepth, depth);
      }
      
      const nodesByDepth = new Map<number, GraphNode[]>();
      for (const node of nodes) {
        const depth = nodeDepth.get(node.id);
        if (depth !== undefined) {
          const nodesAtDepth = nodesByDepth.get(depth) || [];
          nodesAtDepth.push(node);
          nodesByDepth.set(depth, nodesAtDepth);
        }
      }
      
      const radiusByDepth = new Map<number, number>();
      for (let depth = 0; depth <= maxDepth; depth++) {
        radiusByDepth.set(depth, levelGap * (depth + 1));
      }
      
      if (constraintMode === 'equidistant') {
        const ringNodes = new Map<number, GraphNode[]>();
        for (let depth = 0; depth <= maxDepth; depth++) {
          const nodesAtDepth = nodesByDepth.get(depth) || [];
          if (nodesAtDepth.length === 0) continue;
          const radius = radiusByDepth.get(depth)!;
          const existing = ringNodes.get(radius) || [];
          existing.push(...nodesAtDepth);
          ringNodes.set(radius, existing);
        }
        
        for (const [baseRadius, nodesOnRing] of ringNodes) {
          const count = nodesOnRing.length;
          const minRadiusForCount = (count * nodeSpacing) / (2 * Math.PI);
          const radius = Math.max(baseRadius, minRadiusForCount);
          
          nodesOnRing.forEach((node, i) => {
            const angle = (2 * Math.PI * i) / count - Math.PI / 2;
            node.targetX = centerX + radius * Math.cos(angle);
            node.targetY = centerY + radius * Math.sin(angle);
            (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
            if (node.x === 0 && node.y === 0) {
              node.x = node.targetX;
              node.y = node.targetY;
            }
          });
        }
      } else {
        // Physics mode: angular width calculation (bottom-up subtree)
        const subtreeAngularWidth = new Map<number, number>();
        
        for (let depth = maxDepth; depth >= 0; depth--) {
          const nodesAtDepth = nodesByDepth.get(depth) || [];
          for (const node of nodesAtDepth) {
            const children = (childrenByParent.get(node.id) || []).filter(c => nodeDepth.has(c.id));
            
            if (children.length === 0) {
              const radius = radiusByDepth.get(depth)!;
              subtreeAngularWidth.set(node.id, nodeSpacing / radius);
            } else {
              const childDepth = depth + 1;
              const childRadius = radiusByDepth.get(childDepth)!;
              
              let totalChildrenWidth = 0;
              for (const child of children) {
                const childWidth = subtreeAngularWidth.get(child.id) || (nodeSpacing / childRadius);
                totalChildrenWidth += childWidth;
              }
              
              const ownRadius = radiusByDepth.get(depth)!;
              const ownMinWidth = nodeSpacing / ownRadius;
              subtreeAngularWidth.set(node.id, Math.max(ownMinWidth, totalChildrenWidth));
            }
          }
        }
        
        // Top-down positioning
        const nodeAngleRange = new Map<number, { start: number; end: number }>();
        const level0Nodes = nodesByDepth.get(0) || [];
        const radius0 = radiusByDepth.get(0)!;
        
        let totalLevel0Width = 0;
        for (const node of level0Nodes) {
          totalLevel0Width += subtreeAngularWidth.get(node.id) || (nodeSpacing / radius0);
        }
        const totalAngle0 = Math.max(2 * Math.PI, totalLevel0Width);
        const scale0 = totalAngle0 / totalLevel0Width;
        
        let currentAngle0 = -Math.PI / 2;
        for (const node of level0Nodes) {
          const rawWidth = subtreeAngularWidth.get(node.id) || (nodeSpacing / radius0);
          const allocatedWidth = rawWidth * scale0;
          const angle = currentAngle0 + allocatedWidth / 2;
          
          node.targetX = centerX + radius0 * Math.cos(angle);
          node.targetY = centerY + radius0 * Math.sin(angle);
          (node as GraphNode & { _treeRadius?: number })._treeRadius = radius0;
          
          nodeAngleRange.set(node.id, { start: currentAngle0, end: currentAngle0 + allocatedWidth });
          currentAngle0 += allocatedWidth;
        }
        
        for (let depth = 1; depth <= maxDepth; depth++) {
          const nodesAtDepth = nodesByDepth.get(depth) || [];
          const radius = radiusByDepth.get(depth)!;
          
          const nodesWithParent = nodesAtDepth.filter(n => n.parentId !== null && nodeAngleRange.has(n.parentId));
          const rootNodesAtThisLevel = nodesAtDepth.filter(n => n.parentId === null || !nodeAngleRange.has(n.parentId));
          
          if (rootNodesAtThisLevel.length > 0) {
            let totalRootWidth = 0;
            for (const node of rootNodesAtThisLevel) {
              totalRootWidth += subtreeAngularWidth.get(node.id) || (nodeSpacing / radius);
            }
            const totalAngleRoot = Math.max(2 * Math.PI, totalRootWidth);
            const scaleRoot = totalAngleRoot / totalRootWidth;
            
            let currentAngleRoot = -Math.PI / 2;
            for (const node of rootNodesAtThisLevel) {
              const rawWidth = subtreeAngularWidth.get(node.id) || (nodeSpacing / radius);
              const allocatedWidth = rawWidth * scaleRoot;
              const angle = currentAngleRoot + allocatedWidth / 2;
              
              node.targetX = centerX + radius * Math.cos(angle);
              node.targetY = centerY + radius * Math.sin(angle);
              (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
              
              nodeAngleRange.set(node.id, { start: currentAngleRoot, end: currentAngleRoot + allocatedWidth });
              currentAngleRoot += allocatedWidth;
            }
          }
          
          const siblingGroups = new Map<number, GraphNode[]>();
          for (const node of nodesWithParent) {
            const parentId = node.parentId!;
            const group = siblingGroups.get(parentId) || [];
            group.push(node);
            siblingGroups.set(parentId, group);
          }
          
          for (const [parentId, siblings] of siblingGroups) {
            const parentRange = nodeAngleRange.get(parentId)!;
            const parentCenter = (parentRange.start + parentRange.end) / 2;
            const parentSpan = parentRange.end - parentRange.start;
            
            let totalSiblingWidth = 0;
            for (const sibling of siblings) {
              totalSiblingWidth += subtreeAngularWidth.get(sibling.id) || (nodeSpacing / radius);
            }
            
            const actualSpan = Math.max(parentSpan, totalSiblingWidth);
            const startAngle = parentCenter - actualSpan / 2;
            
            let currentAngle = startAngle;
            for (const sibling of siblings) {
              const childWidth = subtreeAngularWidth.get(sibling.id) || (nodeSpacing / radius);
              const allocatedWidth = (childWidth / totalSiblingWidth) * actualSpan;
              const angle = currentAngle + allocatedWidth / 2;
              
              sibling.targetX = centerX + radius * Math.cos(angle);
              sibling.targetY = centerY + radius * Math.sin(angle);
              (sibling as GraphNode & { _treeRadius?: number })._treeRadius = radius;
              
              nodeAngleRange.set(sibling.id, { start: currentAngle, end: currentAngle + allocatedWidth });
              currentAngle += allocatedWidth;
            }
          }
        }
      }
      
      // Handle orphans
      const orphans = nodes.filter(n => !nodeDepth.has(n.id));
      if (orphans.length > 0) {
        const orphanRadius = levelGap * (maxDepth + 2);
        orphans.forEach((node, i) => {
          const angle = (2 * Math.PI * i) / Math.max(orphans.length, 1) + Math.PI;
          node.targetX = centerX + orphanRadius * Math.cos(angle);
          node.targetY = centerY + orphanRadius * Math.sin(angle);
          (node as GraphNode & { _treeRadius?: number })._treeRadius = orphanRadius;
        });
      }
    } else {
      // Normal or terrain mode: random initial positions
      nodes.forEach(node => {
        if (node.x === 0 && node.y === 0) {
          node.x = centerX + (Math.random() - 0.5) * w * 0.5;
          node.y = centerY + (Math.random() - 0.5) * h * 0.5;
        }
        node.targetX = node.x;
        node.targetY = node.y;
      });
    }
  }, []);
  
  // ==================== Topology Cache ====================
  
  const rebuildTopologyCache = useCallback(() => {
    const nodes = nodesRef.current;
    const links = linksRef.current;
    const allLinks = allLinksRef.current; // All links including those to hidden nodes
    
    const connectedPairs = new Map<number, GraphLink['type']>();
    const adjacency = new Map<number, Set<number>>();
    const childrenOf = new Map<number, number[]>();
    const connectionCounts = new Map<number, number>();
    const inLinkCounts = new Map<number, number>();
    const outLinkCounts = new Map<number, number>();
    const inReferenceLinkCounts = new Map<number, number>();
    const outReferenceLinkCounts = new Map<number, number>();
    const allReferenceLinkCounts = new Map<number, number>();
    
    for (const node of nodes) {
      adjacency.set(node.id, new Set());
    }
    
    for (const link of links) {
      adjacency.get(link.source)?.add(link.target);
      adjacency.get(link.target)?.add(link.source);
      
      const key = pairKey(link.source, link.target);
      const existing = connectedPairs.get(key);
      if (!existing || LINK_TYPE_PRIORITY[link.type] > LINK_TYPE_PRIORITY[existing]) {
        connectedPairs.set(key, link.type);
      }
      
      connectionCounts.set(link.source, (connectionCounts.get(link.source) || 0) + 1);
      connectionCounts.set(link.target, (connectionCounts.get(link.target) || 0) + 1);
      outLinkCounts.set(link.source, (outLinkCounts.get(link.source) || 0) + 1);
      inLinkCounts.set(link.target, (inLinkCounts.get(link.target) || 0) + 1);
      
      // Count reference links only for terrain plateau sizing
      if (link.type === 'reference') {
        outReferenceLinkCounts.set(link.source, (outReferenceLinkCounts.get(link.source) || 0) + 1);
        inReferenceLinkCounts.set(link.target, (inReferenceLinkCounts.get(link.target) || 0) + 1);
        allReferenceLinkCounts.set(link.source, (allReferenceLinkCounts.get(link.source) || 0) + 1);
        allReferenceLinkCounts.set(link.target, (allReferenceLinkCounts.get(link.target) || 0) + 1);
      }
    }
    
    // Build childrenOf map from ALL links (including hidden nodes) for correct mass accumulation
    // This ensures parent nodes (like years) accumulate mass from all their children (months)
    // even when the parent is hidden by visibility filters
    for (const link of allLinks) {
      if (link.type === 'parent') {
        const children = childrenOf.get(link.source) || [];
        children.push(link.target);
        childrenOf.set(link.source, children);
      } else if (link.type === 'class') {
        const children = childrenOf.get(link.target) || [];
        children.push(link.source);
        childrenOf.set(link.target, children);
      } else if (link.type === 'extends') {
        const children = childrenOf.get(link.target) || [];
        children.push(link.source);
        childrenOf.set(link.target, children);
      }
    }
    
    // Compute mass cache - compute for ALL nodes seen in hierarchy, not just visible ones
    // This allows hidden parent nodes to accumulate mass correctly
    const massCache = new Map<number, number>();
    const computing = new Set<number>();
    const computeMass = (nodeId: number): number => {
      if (massCache.has(nodeId)) return massCache.get(nodeId)!;
      if (computing.has(nodeId)) return 1;
      computing.add(nodeId);
      let mass = 1;
      const children = childrenOf.get(nodeId);
      if (children) {
        for (const childId of children) {
          mass += computeMass(childId) * PARENT_MASS_PER_CHILD;
        }
      }
      computing.delete(nodeId);
      massCache.set(nodeId, mass);
      return mass;
    };
    
    // Compute mass for all visible nodes
    for (const node of nodes) {
      computeMass(node.id);
    }
    
    // Also compute mass for all parent nodes referenced in the hierarchy
    // (in case they're hidden but have visible children)
    for (const [parentId] of childrenOf) {
      computeMass(parentId);
    }
    
    for (const node of nodes) {
      node.connectionCount = connectionCounts.get(node.id) || 0;
      node.inLinkCount = inLinkCounts.get(node.id) || 0;
      node.outLinkCount = outLinkCounts.get(node.id) || 0;
    }
    
    // Generate per-link random jitter for parent and sibling links
    // Force jitter [0.6, 1.0]: varies how strongly links pull
    // Distance jitter [0.8, 1.2]: varies the equilibrium rest distance
    const linkForceJitter = new Map<number, number>();
    const linkDistJitter = new Map<number, number>();
    const nodeParent = new Map<number, number>(); // nodeId → parentId
    for (const link of links) {
      if (link.type === 'parent') {
        nodeParent.set(link.target, link.source); // target is child, source is parent
      }
    }
    for (const link of links) {
      const key = pairKey(link.source, link.target);
      if (linkForceJitter.has(key)) continue;
      const isParentLink = link.type === 'parent';
      const isSiblingLink = !isParentLink && 
        nodeParent.get(link.source) !== undefined && 
        nodeParent.get(link.source) === nodeParent.get(link.target);
      if (isParentLink || isSiblingLink) {
        linkForceJitter.set(key, 0.6 + Math.random() * 0.4);
        linkDistJitter.set(key, 0.8 + Math.random() * 0.4);
      }
    }
    linkForceJitterRef.current = linkForceJitter;
    linkDistJitterRef.current = linkDistJitter;
    
    connectedPairsRef.current = connectedPairs;
    adjacencyRef.current = adjacency;
    childrenOfRef.current = childrenOf;
    massCacheRef.current = massCache;
    connectionCountsRef.current = connectionCounts;
    inLinkCountsRef.current = inLinkCounts;
    outLinkCountsRef.current = outLinkCounts;
    inReferenceLinkCountsRef.current = inReferenceLinkCounts;
    outReferenceLinkCountsRef.current = outReferenceLinkCounts;
    allReferenceLinkCountsRef.current = allReferenceLinkCounts;
    topologyDirtyRef.current = false;
    terrainDataDirtyRef.current = true; // Recompute terrain heights/radii on topology change
  }, []);
  
  // ==================== Barnes-Hut Quadtree ====================
  
  const allocQuadNode = (x0: number, y0: number, x1: number, y1: number): QuadNode => {
    const pool = quadPoolRef.current;
    const idx = quadPoolIdxRef.current;
    if (idx < pool.length) {
      const n = pool[idx];
      quadPoolIdxRef.current = idx + 1;
      n.cx = 0; n.cy = 0; n.mass = 0;
      n.x0 = x0; n.y0 = y0; n.x1 = x1; n.y1 = y1;
      n.c0 = null; n.c1 = null; n.c2 = null; n.c3 = null;
      n.nodeIdx = -1;
      return n;
    }
    const n: QuadNode = { cx: 0, cy: 0, mass: 0, x0, y0, x1, y1, c0: null, c1: null, c2: null, c3: null, nodeIdx: -1 };
    pool.push(n);
    quadPoolIdxRef.current = idx + 1;
    return n;
  };
  
  const getChild = (node: QuadNode, q: number): QuadNode | null => {
    switch (q) { case 0: return node.c0; case 1: return node.c1; case 2: return node.c2; default: return node.c3; }
  };
  
  const setChild = (node: QuadNode, q: number, child: QuadNode): void => {
    switch (q) { case 0: node.c0 = child; break; case 1: node.c1 = child; break; case 2: node.c2 = child; break; default: node.c3 = child; break; }
  };
  
  const buildQuadtree = (nodes: GraphNode[], masses: Map<number, number>): QuadNode | null => {
    if (nodes.length === 0) return null;
    
    quadPoolIdxRef.current = 0;
    
    const maxPoolSize = Math.max(nodes.length * 8, 1000);
    const pool = quadPoolRef.current;
    if (pool.length > maxPoolSize) {
      pool.length = maxPoolSize;
    }
    
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      if (n.x < x0) x0 = n.x;
      if (n.y < y0) y0 = n.y;
      if (n.x > x1) x1 = n.x;
      if (n.y > y1) y1 = n.y;
    }
    const pad = Math.max(x1 - x0, y1 - y0, 100) * 0.01;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    
    const root = allocQuadNode(x0, y0, x1, y1);
    
    const insert = (tree: QuadNode, idx: number, nx: number, ny: number, nm: number) => {
      const size = tree.x1 - tree.x0;
      if (size < 0.01) return;
      
      if (tree.mass === 0) {
        tree.cx = nx; tree.cy = ny; tree.mass = nm; tree.nodeIdx = idx;
        return;
      }
      
      if (tree.nodeIdx >= 0) {
        const existIdx = tree.nodeIdx;
        const ecx = tree.cx, ecy = tree.cy, em = tree.mass;
        tree.nodeIdx = -1;
        insertIntoQuadrant(tree, existIdx, ecx, ecy, em);
      }
      
      insertIntoQuadrant(tree, idx, nx, ny, nm);
      
      const totalMass = tree.mass + nm;
      tree.cx = (tree.cx * tree.mass + nx * nm) / totalMass;
      tree.cy = (tree.cy * tree.mass + ny * nm) / totalMass;
      tree.mass = totalMass;
    };
    
    const insertIntoQuadrant = (tree: QuadNode, idx: number, nx: number, ny: number, nm: number) => {
      const mx = (tree.x0 + tree.x1) / 2;
      const my = (tree.y0 + tree.y1) / 2;
      const q = (nx < mx ? 0 : 1) + (ny < my ? 0 : 2);
      
      let child = getChild(tree, q);
      if (!child) {
        const qx0 = q & 1 ? mx : tree.x0;
        const qy0 = q & 2 ? my : tree.y0;
        const qx1 = q & 1 ? tree.x1 : mx;
        const qy1 = q & 2 ? tree.y1 : my;
        child = allocQuadNode(qx0, qy0, qx1, qy1);
        setChild(tree, q, child);
      }
      
      insert(child, idx, nx, ny, nm);
    };
    
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      insert(root, i, n.x, n.y, masses.get(n.id) || 1);
    }
    
    return root;
  };
  
  // ==================== Node Management ====================
  
  const createNode = useCallback((node: GraphNode) => {
    const exists = nodesRef.current.find(n => n.id === node.id);
    if (exists) {
      exists.visible = true;
      exists.x = node.x;
      exists.y = node.y;
      exists.vx = node.vx || 0;
      exists.vy = node.vy || 0;
      return;
    }
    
    const newNode: GraphNode = {
      ...node,
      x: node.x || dimensionsRef.current.width / 2,
      y: node.y || dimensionsRef.current.height / 2,
      vx: node.vx || 0,
      vy: node.vy || 0,
      targetX: node.targetX || node.x || dimensionsRef.current.width / 2,
      targetY: node.targetY || node.y || dimensionsRef.current.height / 2,
      visible: node.visible !== undefined ? node.visible : true,
    };
    
    nodesRef.current.push(newNode);
    
    if (viewModeRef.current === 'circle' || viewModeRef.current === 'tree') {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode, settingsRef.current.nodeSizeMode);
    }
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
  }, [calculatePositions]);
  
  const destroyNode = useCallback((nodeId: number) => {
    const index = nodesRef.current.findIndex(n => n.id === nodeId);
    if (index !== -1) {
      nodesRef.current.splice(index, 1);
    }
    
    linksRef.current = linksRef.current.filter(
      link => link.source !== nodeId && link.target !== nodeId
    );
    
    if (viewModeRef.current === 'circle' || viewModeRef.current === 'tree') {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode, settingsRef.current.nodeSizeMode);
    }
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
  }, [calculatePositions]);
  
  const updateLinks = useCallback((links: GraphLink[]) => {
    linksRef.current = [...links];
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
  }, []);
  
  // ==================== Recenter ====================
  
  const recenter = useCallback(() => {
    const nodes = nodesRef.current.filter(n => n.visible);
    if (nodes.length === 0) return;
    
    const isTerrain = viewModeRef.current === 'terrain';
    const terrainPeakRadii = isTerrain ? frameDataRef.current.terrainPeakRadii : null;
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of nodes) {
      // In terrain mode, each node has a slope radius extending beyond its center
      let footprint = 0;
      if (isTerrain && terrainPeakRadii) {
        const peakSize = terrainPeakRadii.get(node.id) ?? 0;
        footprint = TERRAIN_BASE_SLOPE_RADIUS + TERRAIN_PEAK_SLOPE_RADIUS_BONUS * peakSize;
      }
      minX = Math.min(minX, node.x - footprint);
      maxX = Math.max(maxX, node.x + footprint);
      minY = Math.min(minY, node.y - footprint);
      maxY = Math.max(maxY, node.y + footprint);
    }
    
    const padding = isTerrain ? 20 : 60;
    minX -= padding;
    maxX += padding;
    minY -= padding;
    maxY += padding;
    
    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const graphCenterX = (minX + maxX) / 2;
    const graphCenterY = (minY + maxY) / 2;
    
    const scaleX = dimensionsRef.current.width / graphWidth;
    const scaleY = dimensionsRef.current.height / graphHeight;
    const newScale = Math.min(scaleX, scaleY, 1.5);
    
    const newX = dimensionsRef.current.width / 2 - graphCenterX * newScale;
    const newY = dimensionsRef.current.height / 2 - graphCenterY * newScale;
    
    setTransformDirect({
      x: newX,
      y: newY,
      scale: Math.max(0.2, newScale),
    });
  }, [setTransformDirect]);
  
  // ==================== Creation Animation ====================
  
  const creationAnimationRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  
  const triggerCreationAnimation = useCallback(() => {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    
    creationAnimationRef.current.forEach(timer => clearTimeout(timer));
    creationAnimationRef.current = [];
    
    const sortedNodes = [...nodes].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateA - dateB;
    });
    
    const centerX = dimensionsRef.current.width / 2;
    const centerY = dimensionsRef.current.height / 2;
    const spawnRadius = 50;
    
    nodesRef.current = [];
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
    
    const revealDelay = 80;
    sortedNodes.forEach((sortedNode, index) => {
      const timer = setTimeout(() => {
        const nodeData: GraphNode = {
          ...sortedNode,
          x: centerX + (Math.random() - 0.5) * spawnRadius,
          y: centerY + (Math.random() - 0.5) * spawnRadius,
          vx: (Math.random() - 0.5) * 3,
          vy: (Math.random() - 0.5) * 3,
          visible: true,
        };
        createNode(nodeData);
      }, index * revealDelay);
      creationAnimationRef.current.push(timer);
    });
  }, [createNode]);
  
  // ==================== Hit Testing ====================
  
  const getNodeAtPosition = useCallback((screenX: number, screenY: number): GraphNode | null => {
    const { x, y } = screenToWorld(screenX, screenY);
    const t = transformRef.current;
    const currentSettings = settingsRef.current;
    
    let maxConnections = 0, maxMass = 0;
    const hitLinkDir = currentSettings.linkDirection;
    for (const node of nodesRef.current) {
      const dirCount = hitLinkDir === 'in' ? node.inLinkCount : hitLinkDir === 'out' ? node.outLinkCount : node.connectionCount;
      maxConnections = Math.max(maxConnections, dirCount);
      maxMass = Math.max(maxMass, (node as GraphNode & { _mass?: number })._mass ?? 1);
    }
    
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      if (!node.visible) continue;
      
      const nodeRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
      const hitRadius = (nodeRadius + 2 + 4) / t.scale;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        return node;
      }
    }
    return null;
  }, [screenToWorld]);
  
  const getLinkAtPosition = useCallback((screenX: number, screenY: number): GraphLink | null => {
    const { x, y } = screenToWorld(screenX, screenY);
    const t = transformRef.current;
    const currentSettings = settingsRef.current;
    
    const hitThreshold = 8 / t.scale;
    
    const nodeMap = new Map<number, GraphNode>();
    let maxConnections = 0, maxMass = 0;
    const linkHitDir = currentSettings.linkDirection;
    for (const node of nodesRef.current) {
      if (node.visible) {
        nodeMap.set(node.id, node);
        const dirCount = linkHitDir === 'in' ? node.inLinkCount : linkHitDir === 'out' ? node.outLinkCount : node.connectionCount;
        maxConnections = Math.max(maxConnections, dirCount);
        maxMass = Math.max(maxMass, (node as GraphNode & { _mass?: number })._mass ?? 1);
      }
    }
    
    for (const link of linksRef.current) {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (!source || !target) continue;
      
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const lengthSquared = dx * dx + dy * dy;
      
      if (lengthSquared < 0.001) continue;
      
      const t_param = Math.max(0, Math.min(1, 
        ((x - source.x) * dx + (y - source.y) * dy) / lengthSquared
      ));
      
      const closestX = source.x + t_param * dx;
      const closestY = source.y + t_param * dy;
      
      const distX = x - closestX;
      const distY = y - closestY;
      const distance = Math.sqrt(distX * distX + distY * distY);
      
      if (distance < hitThreshold) {
        const sourceRadius = getNodeRadius(source, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
        const targetRadius = getNodeRadius(target, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
        
        const distToSource = Math.sqrt((x - source.x) ** 2 + (y - source.y) ** 2);
        const distToTarget = Math.sqrt((x - target.x) ** 2 + (y - target.y) ** 2);
        
        const sourceHitRadius = (sourceRadius + 2 + 4) / t.scale;
        const targetHitRadius = (targetRadius + 2 + 4) / t.scale;
        
        if (distToSource > sourceHitRadius && distToTarget > targetHitRadius) {
          return link;
        }
      }
    }
    
    return null;
  }, [screenToWorld]);
  
  // ==================== Simulation ====================
  
  const startSimulation = useCallback(() => {
    const thisGeneration = ++simulationGenerationRef.current;
    
    let totalFrames = 0;
    const simulationStartTime = performance.now();
    
    const wake = () => {
      if (simulationGenerationRef.current !== thisGeneration) return;
      sleepCounterRef.current = 0;
      if (simulationSleepingRef.current) {
        simulationSleepingRef.current = false;
        const maxFrames = getMaxSimulationFrames(nodesRef.current.length);
        if (maxFrames > 0) {
          const burst = Math.min(300, Math.floor(maxFrames * 0.5));
          totalFrames = Math.min(totalFrames, maxFrames - burst);
        }
        animationRef.current = requestAnimationFrame(simulate);
      }
    };
    wakeSimulationRef.current = wake;
    
    const simulate = () => {
      if (simulationGenerationRef.current !== thisGeneration) return;
      
      totalFrames++;
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const currentSettings = settingsRef.current;
      const currentViewMode = viewModeRef.current;
      const isConstrainedMode = currentViewMode === 'circle' || currentViewMode === 'tree';
      const isTerrainModeNow = currentViewMode === 'terrain';
      
      // Sleep: skip all force + integration work when asleep
      if (simulationSleepingRef.current) {
        return;
      }
      
      // Pause: skip physics but keep animation frame alive so we can resume
      if (simulationPausedRef.current) {
        if (ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
        animationRef.current = requestAnimationFrame(simulate);
        return;
      }
      
      if (topologyDirtyRef.current) {
        rebuildTopologyCache();
      }
      
      const connectedPairs = connectedPairsRef.current;
      const linkForceJitter = linkForceJitterRef.current;
      const linkDistJitter = linkDistJitterRef.current;
      const adjacency = adjacencyRef.current;
      const massCache = massCacheRef.current;
      const useMass = currentSettings.heightMode === 'hierarchy';
      
      let maxConnections = 0, maxMass = 0;
      const linkDir = currentSettings.linkDirection;
      for (const node of nodes) {
        const mass = useMass ? (massCache.get(node.id) ?? 1) : 1;
        (node as GraphNode & { _mass?: number })._mass = mass;
        const dirCount = linkDir === 'in' ? node.inLinkCount : linkDir === 'out' ? node.outLinkCount : node.connectionCount;
        if (dirCount > maxConnections) maxConnections = dirCount;
        if (mass > maxMass) maxMass = mass;
      }
      
      const nodeMap = frameNodeMapRef.current;
      nodeMap.clear();
      for (const node of nodes) {
        nodeMap.set(node.id, node);
      }
      
      const usePhysics = !isConstrainedMode || currentSettings.constraintMode === 'physics';
      
      const warmupT = Math.min(1, warmupFrameRef.current / WARMUP_DURATION_FRAMES);
      const warmupMultiplier = warmupT * warmupT;
      warmupFrameRef.current++;
      
      // Return-to-target force (constrained modes)
      if (isConstrainedMode) {
        const returnStrength = currentSettings.constraintMode === 'equidistant' ? 0.5 : RETURN_FORCE * 0.05;
        for (const node of nodes) {
          if (dragNodeRef.current?.id === node.id || node.pinned) continue;
          
          const dx = node.targetX - node.x;
          const dy = node.targetY - node.y;
          
          const connCount = node.connectionCount;
          const multiplier = (currentSettings.constraintMode === 'physics' && connCount === 0) ? 10 : 1;
          
          node.vx += dx * returnStrength * multiplier;
          node.vy += dy * returnStrength * multiplier;
        }
      }
      
      // Centering gravity
      if (!isConstrainedMode && centerGravityActiveRef.current) {
        if (warmupT >= 1) {
          centerGravityActiveRef.current = false;
        }
        const cx = dimensionsRef.current.width / 2;
        const cy = dimensionsRef.current.height / 2;
        for (const node of nodes) {
          if (dragNodeRef.current?.id === node.id || node.pinned) continue;
          const dx = cx - node.x;
          const dy = cy - node.y;
          node.vx += dx * CENTER_GRAVITY * warmupMultiplier;
          node.vy += dy * CENTER_GRAVITY * warmupMultiplier;
        }
      }
      
      // Barnes-Hut N-body simulation
      if (usePhysics) {
        const THETA = 0.7;
        
        const normalizedMasses = new Map<number, number>();
        if (useMass) {
          for (const node of nodes) {
            const raw = massCache.get(node.id) ?? 1;
            normalizedMasses.set(node.id, raw <= 1 ? 1 : 1 + Math.log(raw));
          }
        }
        const tree = buildQuadtree(nodes, useMass ? normalizedMasses : massCacheRef.current);
        
        if (tree) {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (dragNodeRef.current?.id === node.id) continue;
            if (node.pinned) continue;
            
            const nodeMass = useMass ? (normalizedMasses.get(node.id) ?? 1) : 1;
            
            const stack = bhStackRef.current;
            let stackTop = 0;
            stack[stackTop++] = tree;
            while (stackTop > 0) {
              const cell = stack[--stackTop]!;
              if (cell.mass === 0) continue;
              
              const dx = cell.cx - node.x;
              const dy = cell.cy - node.y;
              const distSq = dx * dx + dy * dy;
              const dist = Math.sqrt(distSq) || 1;
              
              if (cell.nodeIdx === i) continue;
              
              const cellSize = cell.x1 - cell.x0;
              
              if (cell.nodeIdx >= 0 || (cellSize / dist) < THETA) {
                if (dist < UNLINKED_REPULSION_DISTANCE) {
                  const clampedDist = Math.max(dist, MIN_REPULSION_DISTANCE);
                  const force = (REPULSION_STRENGTH * cell.mass / (clampedDist * clampedDist)) * warmupMultiplier;
                  const fx = (dx / dist) * force;
                  const fy = (dy / dist) * force;
                  
                  node.vx -= fx / nodeMass;
                  node.vy -= fy / nodeMass;
                }
              } else {
                if (stackTop + 4 > stack.length) stack.length = stack.length * 2;
                if (cell.c0) stack[stackTop++] = cell.c0;
                if (cell.c1) stack[stackTop++] = cell.c1;
                if (cell.c2) stack[stackTop++] = cell.c2;
                if (cell.c3) stack[stackTop++] = cell.c3;
              }
            }
          }
        }
        
        // Link attraction
        for (const link of links) {
          const nodeA = nodeMap.get(link.source);
          const nodeB = nodeMap.get(link.target);
          if (!nodeA || !nodeB) continue;
          if (dragNodeRef.current?.id === nodeA.id || dragNodeRef.current?.id === nodeB.id) continue;
          if (nodeA.pinned && nodeB.pinned) continue;
          
          const key = pairKey(nodeA.id, nodeB.id);
          if (connectedPairs.get(key) !== link.type) continue;
          
          const dx = nodeB.x - nodeA.x;
          const dy = nodeB.y - nodeA.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          let attractionStrength = ATTRACTION_STRENGTH;
          if (currentSettings.linkCountAttraction) {
            const totalConnections = nodeA.connectionCount + nodeB.connectionCount;
            const linkFactor = Math.log2(2 + totalConnections);
            attractionStrength = ATTRACTION_STRENGTH_LINK_COUNT * linkFactor;
          }
          
          // In terrain mode, skip attraction for reference links entirely —
          // they use only the minimum-separation force for valley routing
          if (isTerrainModeNow) {
            if (link.type === 'reference' || link.type === 'property-reference') continue;
          } else {
            if (link.type === 'property-reference') {
              attractionStrength *= REFERENCE_LINK_FORCE_MULTIPLIER;
            } else if (link.type === 'reference') {
              attractionStrength *= REFERENCE_LINK_FORCE_MULTIPLIER * REFERENCE_LINK_FORCE_MULTIPLIER;
            }
          }
          
          let restDist = LINKED_ATTRACTION_DISTANCE;
          
          // Apply per-link random jitter for parent and sibling links
          const forceJitter = linkForceJitter.get(key);
          if (forceJitter !== undefined) {
            attractionStrength *= forceJitter;
            restDist *= linkDistJitter.get(key) ?? 1;
          }
          
          let netForce = (dist - restDist) * attractionStrength * warmupMultiplier;
          
          const massA = useMass ? (normalizedMasses.get(nodeA.id) ?? 1) : 1;
          const massB = useMass ? (normalizedMasses.get(nodeB.id) ?? 1) : 1;
          
          const rvx = nodeB.vx - nodeA.vx;
          const rvy = nodeB.vy - nodeA.vy;
          const relVelAlongSpring = (rvx * dx + rvy * dy) / dist;
          const linkDamping = isTerrainModeNow ? TERRAIN_LINK_DAMPING : LINK_DAMPING;
          netForce += relVelAlongSpring * linkDamping;
          
          const sfx = (dx / dist) * netForce;
          const sfy = (dy / dist) * netForce;
          
          let compAx = 0, compAy = 0, compBx = 0, compBy = 0;
          if (dist < UNLINKED_REPULSION_DISTANCE) {
            const clampedDist = Math.max(dist, MIN_REPULSION_DISTANCE);
            const clampedDistSq = clampedDist * clampedDist;
            const dirX = dx / dist;
            const dirY = dy / dist;
            const compA = (REPULSION_STRENGTH * massB / clampedDistSq) * warmupMultiplier;
            compAx = dirX * compA / massA;
            compAy = dirY * compA / massA;
            const compB = (REPULSION_STRENGTH * massA / clampedDistSq) * warmupMultiplier;
            compBx = dirX * compB / massB;
            compBy = dirY * compB / massB;
          }
          
          if (!nodeA.pinned) {
            nodeA.vx += sfx / massA + compAx;
            nodeA.vy += sfy / massA + compAy;
          }
          if (!nodeB.pinned) {
            nodeB.vx -= sfx / massB - compBx;
            nodeB.vy -= sfy / massB - compBy;
          }
        }
      }
      
      // Terrain mode: cone-based collision avoidance
      if (isTerrainModeNow && usePhysics) {
        const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
        const terrainHeights = frameDataRef.current.terrainHeights;
        
        for (let i = 0; i < nodes.length; i++) {
          const shortNode = nodes[i];
          if (dragNodeRef.current?.id === shortNode.id || shortNode.pinned) continue;
          
          const shortHeight = terrainHeights.get(shortNode.id) ?? 0;
          const shortPeak = terrainPeakRadii.get(shortNode.id) ?? 0;
          
          const shortRp = TERRAIN_BASE_FOOTPRINT * 0.25 + TERRAIN_PEAK_FOOTPRINT * 0.25 * shortPeak;
          
          for (let j = 0; j < nodes.length; j++) {
            if (i === j) continue;
            const tallNode = nodes[j];
            
            const tallHeight = terrainHeights.get(tallNode.id) ?? 0;
            if (tallHeight <= shortHeight) continue;
            
            const tallPeak = terrainPeakRadii.get(tallNode.id) ?? 0;
            const tallRp = TERRAIN_BASE_FOOTPRINT * 0.25 + TERRAIN_PEAK_FOOTPRINT * 0.25 * tallPeak;
            const tallRs = TERRAIN_BASE_FOOTPRINT + TERRAIN_PEAK_FOOTPRINT * tallPeak;
            
            const heightRatio = (tallHeight - shortHeight) / tallHeight;
            const coneRadiusAtShortHeight = tallRp + (tallRs - tallRp) * heightRatio;
            
            const dx = shortNode.x - tallNode.x;
            const dy = shortNode.y - tallNode.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            const effectiveConeRadius = coneRadiusAtShortHeight - shortRp * 0.5;
            
            if (dist >= effectiveConeRadius) continue;
            
            const overlap = effectiveConeRadius - dist;
            const correction = overlap * TERRAIN_SEPARATION_STRENGTH * warmupMultiplier;
            const nx = dx / dist;
            const ny = dy / dist;
            
            shortNode.x += nx * correction;
            shortNode.y += ny * correction;
          }
        }
      }
      
      // Terrain mode: ensure minimum separation between reference-linked nodes
      // so that peaks have a valley between them for path routing
      if (isTerrainModeNow && usePhysics) {
        const refTerrainPeakRadii = frameDataRef.current.terrainPeakRadii;
        for (const link of links) {
          if (link.type !== 'reference' && link.type !== 'property-reference') continue;
          const nodeA = nodeMap.get(link.source);
          const nodeB = nodeMap.get(link.target);
          if (!nodeA || !nodeB) continue;
          if (nodeA.pinned && nodeB.pinned) continue;
          if (dragNodeRef.current?.id === nodeA.id || dragNodeRef.current?.id === nodeB.id) continue;
          
          const dx = nodeB.x - nodeA.x;
          const dy = nodeB.y - nodeA.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          // Scale min separation by average peak size of the pair
          const peakA = refTerrainPeakRadii.get(nodeA.id) ?? 0;
          const peakB = refTerrainPeakRadii.get(nodeB.id) ?? 0;
          const avgPeak = (peakA + peakB) * 0.5;
          const minSep = TERRAIN_REF_LINK_MIN_SEPARATION + avgPeak * 60;
          
          if (dist >= minSep) continue;
          
          const overlap = minSep - dist;
          const force = overlap * TERRAIN_REF_LINK_SEPARATION_STRENGTH * warmupMultiplier;
          const nx = dx / dist;
          const ny = dy / dist;
          
          if (!nodeA.pinned) {
            nodeA.vx -= nx * force;
            nodeA.vy -= ny * force;
          }
          if (!nodeB.pinned) {
            nodeB.vx += nx * force;
            nodeB.vy += ny * force;
          }
        }
      }
      
      const currentNodeSizeMode = currentSettings.nodeSizeMode;
      const currentLinkDirection = currentSettings.linkDirection;
      
      // Tangential overlap prevention (constrained modes)
      if (isConstrainedMode && currentSettings.constraintMode !== 'equidistant') {
        const cx = dimensionsRef.current.width / 2;
        const cy = dimensionsRef.current.height / 2;
        
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          if (dragNodeRef.current?.id === a.id || a.pinned) continue;
          const aRadius = (a as GraphNode & { _treeRadius?: number })._treeRadius;
          if (aRadius === undefined) continue;
          const aGlare = getGlareRadius(a, currentNodeSizeMode, maxConnections, maxMass, currentLinkDirection);
          
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            if (dragNodeRef.current?.id === b.id || b.pinned) continue;
            const bRadius = (b as GraphNode & { _treeRadius?: number })._treeRadius;
            if (bRadius === undefined) continue;
            const bGlare = getGlareRadius(b, currentNodeSizeMode, maxConnections, maxMass, currentLinkDirection);
            
            const minGlareDist = (aGlare + bGlare) * 1.05;
            if (Math.abs(aRadius - bRadius) > minGlareDist) continue;
            
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            if (dist >= minGlareDist) continue;
            
            const dax = a.x - cx;
            const day = a.y - cy;
            const daDist = Math.sqrt(dax * dax + day * day) || 1;
            
            const radialX = dax / daDist;
            const radialY = day / daDist;
            
            const cross = dx * radialY - dy * radialX;
            const sign = cross >= 0 ? 1 : -1;
            const tangX = -radialY * sign;
            const tangY = radialX * sign;
            
            const overlap = minGlareDist - dist;
            const correction = overlap * 0.15;
            
            const aMovable = !a.pinned && dragNodeRef.current?.id !== a.id;
            const bMovable = !b.pinned && dragNodeRef.current?.id !== b.id;
            
            if (aMovable && bMovable) {
              a.x -= tangX * correction * 0.5;
              a.y -= tangY * correction * 0.5;
              b.x += tangX * correction * 0.5;
              b.y += tangY * correction * 0.5;
            } else if (aMovable) {
              a.x -= tangX * correction;
              a.y -= tangY * correction;
            } else if (bMovable) {
              b.x += tangX * correction;
              b.y += tangY * correction;
            }
          }
        }
      }
      
      // Dragged node pulls connected nodes
      if (dragNodeRef.current && dragNodeRef.current.visible) {
        const dragNode = dragNodeRef.current;
        const connected = adjacency.get(dragNode.id);
        
        if (connected) {
          for (const connectedId of connected) {
            const connectedNode = nodeMap.get(connectedId);
            if (!connectedNode || connectedNode.pinned) continue;
            
            const dx = dragNode.x - connectedNode.x;
            const dy = dragNode.y - connectedNode.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            if (dist > LINKED_ATTRACTION_DISTANCE) {
              const rawM = useMass ? (massCache.get(connectedNode.id) ?? 1) : 1;
              const mass = rawM <= 1 ? 1 : 1 + Math.log(rawM);
              const linkType = connectedPairs.get(pairKey(dragNode.id, connectedId)) ?? null;
              let dragMultiplier = 1;
              // In terrain mode, treat all links equally
              if (!isTerrainModeNow) {
                if (linkType === 'property-reference') {
                  dragMultiplier = REFERENCE_LINK_FORCE_MULTIPLIER;
                } else if (linkType === 'reference') {
                  dragMultiplier = REFERENCE_LINK_FORCE_MULTIPLIER * REFERENCE_LINK_FORCE_MULTIPLIER;
                }
              }
              connectedNode.vx += (dx / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE) * dragMultiplier / mass;
              connectedNode.vy += (dy / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE) * dragMultiplier / mass;
            }
          }
        }
        
        if (dragStartTimeRef.current !== null) {
          const elapsed = Date.now() - dragStartTimeRef.current;
          dragLiftProgressRef.current = Math.min(1, elapsed / 150);
        }
      } else {
        if (dragLiftProgressRef.current > 0) {
          dragLiftProgressRef.current = Math.max(0, dragLiftProgressRef.current - 0.1);
        }
      }
      
      // Collision force
      const COLLISION_PADDING = 1.05;
      const COLLISION_STRENGTH = 1.0;
      const skipCollisions = isConstrainedMode && currentSettings.constraintMode === 'equidistant';
      
      if (!skipCollisions) {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          if (!a.visible) continue;
          const aImmovable = dragNodeRef.current?.id === a.id || a.pinned;
          const radiusA = getGlareRadius(a, currentNodeSizeMode, maxConnections, maxMass, currentLinkDirection) * COLLISION_PADDING;
          
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            if (!b.visible) continue;
            const bImmovable = dragNodeRef.current?.id === b.id || b.pinned;
            if (aImmovable && bImmovable) continue;
            
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distSq = dx * dx + dy * dy;
            const radiusB = getGlareRadius(b, currentNodeSizeMode, maxConnections, maxMass, currentLinkDirection) * COLLISION_PADDING;
            const minDist = radiusA + radiusB;
            
            if (distSq >= minDist * minDist) continue;
            
            const dist = Math.sqrt(distSq) || 0.1;
            const overlap = minDist - dist;
            
            const nx = dx / dist;
            const ny = dy / dist;
            
            const impulse = overlap * COLLISION_STRENGTH;
            
            if (aImmovable) {
              b.vx += nx * impulse;
              b.vy += ny * impulse;
            } else if (bImmovable) {
              a.vx -= nx * impulse;
              a.vy -= ny * impulse;
            } else {
              const halfImpulse = impulse * 0.5;
              a.vx -= nx * halfImpulse;
              a.vy -= ny * halfImpulse;
              b.vx += nx * halfImpulse;
              b.vy += ny * halfImpulse;
            }
          }
        }
      }
      
      // Update positions
      const velDamping = isTerrainModeNow ? TERRAIN_VELOCITY_DAMPING : VELOCITY_DAMPING;
      const velDeadzone = isTerrainModeNow ? TERRAIN_VELOCITY_DEADZONE : VELOCITY_DEADZONE;
      const maxVel = isTerrainModeNow ? TERRAIN_MAX_VELOCITY : MAX_VELOCITY;
      for (const node of nodes) {
        if (dragNodeRef.current?.id !== node.id && !node.pinned) {
          const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
          if (speed > maxVel) {
            const scale = maxVel / speed;
            node.vx *= scale;
            node.vy *= scale;
          }
          node.x += node.vx;
          node.y += node.vy;
          node.vx *= velDamping;
          node.vy *= velDamping;
          
          if (Math.abs(node.vx) < velDeadzone) node.vx = 0;
          if (Math.abs(node.vy) < velDeadzone) node.vy = 0;
          
          if (isConstrainedMode) {
            const treeRadius = (node as GraphNode & { _treeRadius?: number })._treeRadius;
            if (treeRadius !== undefined) {
              const cx = dimensionsRef.current.width / 2;
              const cy = dimensionsRef.current.height / 2;
              const nodeToCenter_dx = node.x - cx;
              const nodeToCenter_dy = node.y - cy;
              const distToCenter = Math.sqrt(nodeToCenter_dx * nodeToCenter_dx + nodeToCenter_dy * nodeToCenter_dy) || 1;
              const radialX = nodeToCenter_dx / distToCenter;
              const radialY = nodeToCenter_dy / distToCenter;
              const radiusError = Math.abs(distToCenter - treeRadius);
              
              const radialV = node.vx * radialX + node.vy * radialY;
              node.vx -= radialV * radialX;
              node.vy -= radialV * radialY;
              
              const blendRate = radiusError > 50 ? 0.08 : radiusError > 10 ? 0.5 : 1.0;
              const newDist = distToCenter + (treeRadius - distToCenter) * blendRate;
              node.x = cx + radialX * newDist;
              node.y = cy + radialY * newDist;
            }
          }
        }
      }
      
      // Render skip — terrain mode always renders every tick (cached contours are cheap)
      const renderSkip = isTerrainModeNow ? getTerrainRenderSkip(nodes.length) : getRenderSkip(nodes.length);
      const isDragging = !!dragNodeRef.current;
      if (isDragging || totalFrames % renderSkip === 0) {
        const currentFilters = visibilityFiltersRef.current;
        const visibleLinks = frameVisibleLinksRef.current;
        visibleLinks.length = 0;
        for (const l of links) {
          if (nodeMap.has(l.source) && nodeMap.has(l.target) && shouldLinkBeActive(l, currentFilters)) {
            visibleLinks.push(l);
          }
        }
        frameDataRef.current.visibleNodes = nodes;
        frameDataRef.current.visibleLinks = visibleLinks;
        frameDataRef.current.nodeMap = nodeMap;
        frameDataRef.current.maxConnections = maxConnections;
        frameDataRef.current.maxMass = maxMass;
        
        // Compute terrain heights and peak radii — only when topology or settings changed
        if (isTerrainModeNow && terrainDataDirtyRef.current) {
          const terrainHeights = frameDataRef.current.terrainHeights;
          const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
          terrainHeights.clear();
          terrainPeakRadii.clear();
          
          // --- Heights ---
          let maxHeightRaw = 0;
          const rawHeights = new Map<number, number>();
          const heightMode = currentSettings.heightMode;
          const inCnts = inLinkCountsRef.current;
          const inRefCnts = inReferenceLinkCountsRef.current;
          for (const node of nodes) {
            const h = heightMode === 'hierarchy'
              ? (massCache.get(node.id) ?? 1)
              : heightMode === 'references'
                ? 1 + (inRefCnts.get(node.id) || 0)
                : 1 + (inCnts.get(node.id) || 0);
            rawHeights.set(node.id, h);
            if (h > maxHeightRaw) maxHeightRaw = h;
          }
          // Double-log-compress heights to reduce dynamic range before stamp creation.
          // Raw hierarchy masses can be 50:1+ (root vs leaf). Double-log compression
          // keeps parents taller than children but prevents them from towering.
          // log(1+log(1+1))=0.53, log(1+log(1+10))=0.93, log(1+log(1+50))=1.22
          for (const [id, h] of rawHeights) {
            terrainHeights.set(id, Math.log(1 + Math.log(1 + h)));
          }
          
          // --- Peak radii (size) ---
          // Base size comes from the chosen mode (links or pageSize), then
          // we blend in child count so parent nodes get wider mountain bases.
          const peakSizeMode = currentSettings.peakSizeMode;
          let maxRawSize = 0;
          let maxChildCount = 0;
          const rawRadii = new Map<number, number>();
          const childCounts = new Map<number, number>();
          
          // Pre-compute child counts from mass cache (mass = 1 + Σ children)
          for (const node of nodes) {
            const m = massCache.get(node.id) ?? 1;
            const cc = m - 1; // number of recursive descendants
            childCounts.set(node.id, cc);
            if (cc > maxChildCount) maxChildCount = cc;
          }
          
          if (peakSizeMode === 'pageSize') {
            // Use page content length (displayName chars) as peak size
            for (const node of nodes) {
              const size = node.displayName.length;
              rawRadii.set(node.id, size);
              if (size > maxRawSize) maxRawSize = size;
            }
          } else {
            // 'links' mode — use reference link counts based on linkDirection
            const ld = currentSettings.linkDirection;
            const inCounts = inReferenceLinkCountsRef.current;
            const outCounts = outReferenceLinkCountsRef.current;
            const allCounts = allReferenceLinkCountsRef.current;
            for (const node of nodes) {
              let count: number;
              if (ld === 'in') {
                count = inCounts.get(node.id) || 0;
              } else if (ld === 'out') {
                count = outCounts.get(node.id) || 0;
              } else {
                count = allCounts.get(node.id) || 0;
              }
              rawRadii.set(node.id, count);
              if (count > maxRawSize) maxRawSize = count;
            }
          }
          // Blend base size with child count: 60% mode-based size + 40% hierarchy size
          // This ensures parents with many children get wider mountain bases
          const CHILD_COUNT_WEIGHT = 0.4;
          for (const [id, c] of rawRadii) {
            const baseFrac = maxRawSize > 0 ? c / maxRawSize : 0;
            const childFrac = maxChildCount > 0
              ? Math.log(1 + (childCounts.get(id) ?? 0)) / Math.log(1 + maxChildCount)
              : 0;
            terrainPeakRadii.set(id, baseFrac * (1 - CHILD_COUNT_WEIGHT) + childFrac * CHILD_COUNT_WEIGHT);
          }
          
          terrainDataDirtyRef.current = false;
        }
        
        if (ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
      }
      
      // Cleanup quadtree refs
      const bhStack = bhStackRef.current;
      for (let i = 0, len = bhStack.length; i < len; i++) {
        bhStack[i] = null;
      }
      
      const pool = quadPoolRef.current;
      const usedPoolSize = quadPoolIdxRef.current;
      for (let i = usedPoolSize, len = pool.length; i < len; i++) {
        pool[i].c0 = pool[i].c1 = pool[i].c2 = pool[i].c3 = null;
      }
      
      // Force stop check
      const maxFrames = getMaxSimulationFrames(nodes.length);
      const forceStop = (maxFrames > 0 && totalFrames >= maxFrames) ||
        (MAX_SIMULATION_TIME_MS > 0 && (performance.now() - simulationStartTime) > MAX_SIMULATION_TIME_MS);
      
      if (forceStop) {
        simulationSleepingRef.current = true;
        sleepCounterRef.current = 0;
        if (ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
        return;
      }
      
      // Sleep detection: put simulation to sleep when total kinetic energy is negligible
      {
        const sleepThreshold = isTerrainModeNow ? TERRAIN_SLEEP_THRESHOLD : GRAPH_SLEEP_THRESHOLD;
        const sleepFrames = isTerrainModeNow ? TERRAIN_SLEEP_FRAMES : GRAPH_SLEEP_FRAMES;
        let totalEnergy = 0;
        for (const node of nodes) {
          totalEnergy += node.vx * node.vx + node.vy * node.vy;
        }
        kineticEnergyRef.current = totalEnergy;
        if (totalEnergy < sleepThreshold) {
          sleepCounterRef.current++;
          if (sleepCounterRef.current > sleepFrames) {
            simulationSleepingRef.current = true;
            sleepCounterRef.current = 0;
            if (ctxRef.current && renderRef.current) {
              renderRef.current(ctxRef.current);
            }
            return;
          }
        } else {
          sleepCounterRef.current = 0;
        }
      }
      
      animationRef.current = requestAnimationFrame(simulate);
    };
    
    simulate();
  }, [rebuildTopologyCache, shouldLinkBeActive, buildQuadtree]);
  
  // ==================== Effects ====================
  
  // Keep refs in sync
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { dimensionsRef.current = dimensions; }, [dimensions]);
  
  useEffect(() => {
    const prevConstraintMode = settingsRef.current.constraintMode;
    const prevNodeSizeMode = settingsRef.current.nodeSizeMode;
    settingsRef.current = settings;
    topologyDirtyRef.current = true;
    terrainDataDirtyRef.current = true; // Terrain heights/radii may depend on settings
    const modeChanged = settings.constraintMode !== prevConstraintMode || settings.nodeSizeMode !== prevNodeSizeMode;
    if (modeChanged && (viewModeRef.current === 'circle' || viewModeRef.current === 'tree') && nodesRef.current.length > 0) {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settings.constraintMode, settings.nodeSizeMode);
    }
    wakeSimulationRef.current();
  }, [settings, calculatePositions]);
  
  useEffect(() => { 
    classColorsRef.current = [...classColors].sort((a, b) => a.order - b.order); 
    requestRender(); 
  }, [classColors, requestRender]);
  
  useEffect(() => { selectedNodeIdsRef.current = selectedNodeIds; requestRender(); }, [selectedNodeIds, requestRender]);
  useEffect(() => { currentNodeIdRef.current = currentNodeId; requestRender(); }, [currentNodeId, requestRender]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { visibilityFiltersRef.current = visibilityFilters; }, [visibilityFilters]);
  
  // CSS vars cache
  useEffect(() => {
    const updateCssVars = () => {
      const style = getComputedStyle(document.documentElement);
      cssVarsRef.current = {
        textColor: style.getPropertyValue('--color-on-surface').trim() || '#111111',
        accentColor: style.getPropertyValue('--color-accent').trim() || '#404040',
        dimColor: style.getPropertyValue('--color-on-surface-variant').trim() || '#555555',
        outlineColor: style.getPropertyValue('--color-outline').trim() || '#a3a3a3',
        warningColor: style.getPropertyValue('--color-warning').trim() || '#d97706',
      };
    };
    updateCssVars();
    const observer = new MutationObserver(updateCssVars);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  
  // View mode transitions (terrain enter/leave)
  const prevViewModeRef = useRef(viewMode);
  useEffect(() => {
    if (prevViewModeRef.current === viewMode) return;
    const prevMode = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;
    
    const enteringTerrain = viewMode === 'terrain' && prevMode !== 'terrain';
    const leavingTerrain = viewMode !== 'terrain' && prevMode === 'terrain';
    
    if (enteringTerrain) {
      const classNodeIds = nodesRef.current.filter(n => n.isClassNode).map(n => n.id);
      for (const id of classNodeIds) {
        const index = nodesRef.current.findIndex(n => n.id === id);
        if (index !== -1) nodesRef.current.splice(index, 1);
      }
      const classIdSet = new Set(classNodeIds);
      linksRef.current = linksRef.current.filter(
        l => !classIdSet.has(l.source) && !classIdSet.has(l.target)
      );
      topologyDirtyRef.current = true;
    }
    
    if (leavingTerrain) {
      const currentFilters = visibilityFiltersRef.current;
      inputNodesMapRef.current.forEach((node) => {
        if (node.isClassNode && shouldNodeBeVisible(node, currentFilters)) {
          const exists = nodesRef.current.find(n => n.id === node.id);
          if (!exists) {
            const centerX = dimensionsRef.current.width / 2;
            const centerY = dimensionsRef.current.height / 2;
            nodesRef.current.push({
              ...node,
              x: centerX + (Math.random() - 0.5) * 200,
              y: centerY + (Math.random() - 0.5) * 200,
              vx: 0, vy: 0,
            });
          }
        }
      });
      const visibleIds = new Set(nodesRef.current.map(n => n.id));
      linksRef.current = allLinksRef.current.filter(
        l => visibleIds.has(l.source) && visibleIds.has(l.target) && shouldLinkBeActive(l, currentFilters)
      );
      topologyDirtyRef.current = true;
    }
    
    if (nodesRef.current.length > 0) {
      calculatePositions(nodesRef.current, viewMode, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode, settingsRef.current.nodeSizeMode);
      topologyDirtyRef.current = true;
      wakeSimulationRef.current();
    }
  }, [viewMode, calculatePositions, shouldNodeBeVisible, shouldLinkBeActive]);
  
  // Visibility filter changes
  useEffect(() => {
    const previousFilters = visibilityFiltersRef.current;
    visibilityFiltersRef.current = visibilityFilters;
    
    if (nodesRef.current.length === 0 && inputNodesMapRef.current.size === 0) return;
    if (JSON.stringify(previousFilters) === JSON.stringify(visibilityFilters)) return;
    
    const currentNodeIds = new Set(nodesRef.current.map(n => n.id));
    const nodesToRemove: number[] = [];
    const nodesToAdd: GraphNode[] = [];
    
    inputNodesMapRef.current.forEach((node, id) => {
      const shouldShow = shouldNodeBeVisible(node, visibilityFilters);
      const isCurrentlyShown = currentNodeIds.has(id);
      
      if (shouldShow && !isCurrentlyShown) {
        nodesToAdd.push({ ...node });
      } else if (!shouldShow && isCurrentlyShown) {
        nodesToRemove.push(id);
      }
    });
    
    nodesToRemove.forEach(nodeId => {
      const index = nodesRef.current.findIndex(n => n.id === nodeId);
      if (index !== -1) {
        nodesRef.current.splice(index, 1);
      }
    });
    
    const visibleNodeIds = new Set(nodesRef.current.map(n => n.id));
    const currentFilters = visibilityFiltersRef.current;
    linksRef.current = allLinksRef.current.filter(
      link => visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target) && shouldLinkBeActive(link, currentFilters)
    );
    
    nodesToAdd.forEach(node => {
      const newNode: GraphNode = {
        ...node,
        x: dimensionsRef.current.width / 2 + (Math.random() - 0.5) * 100,
        y: dimensionsRef.current.height / 2 + (Math.random() - 0.5) * 100,
        vx: 0,
        vy: 0,
        visible: true,
      };
      nodesRef.current.push(newNode);
    });
    
    const newVisibleNodeIds = new Set(nodesRef.current.map(n => n.id));
    linksRef.current = allLinksRef.current.filter(
      link => newVisibleNodeIds.has(link.source) && newVisibleNodeIds.has(link.target) && shouldLinkBeActive(link, currentFilters)
    );
    
    if ((nodesToRemove.length > 0 || nodesToAdd.length > 0) && (viewModeRef.current === 'circle' || viewModeRef.current === 'tree')) {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode, settingsRef.current.nodeSizeMode);
    }
    
    if (nodesToRemove.length > 0 || nodesToAdd.length > 0) {
      topologyDirtyRef.current = true;
      wakeSimulationRef.current();
    }
  }, [visibilityFilters, calculatePositions, shouldNodeBeVisible, shouldLinkBeActive]);
  
  // Initialize nodes from input
  useEffect(() => {
    if (inputNodes.length === 0) return;
    
    const { width: dimW, height: dimH } = dimensionsRef.current;
    const centerX = dimW / 2;
    const centerY = dimH / 2;
    const currentFilters = visibilityFiltersRef.current;
    
    inputNodesMapRef.current = new Map(inputNodes.map(n => [n.id, n]));
    allLinksRef.current = [...inputLinks];
    
    const existingMap = new Map(nodesRef.current.map(n => [n.id, n]));
    
    const visibleInputNodes = inputNodes.filter(n => shouldNodeBeVisible(n, currentFilters));
    const inputMap = new Map(visibleInputNodes.map(n => [n.id, n]));
    
    const nodesToRemove = nodesRef.current.filter(n => !inputMap.has(n.id));
    nodesToRemove.forEach(n => destroyNode(n.id));
    
    visibleInputNodes.forEach(inputNode => {
      const existing = existingMap.get(inputNode.id);
      if (existing) {
        Object.assign(existing, {
          ...inputNode,
          x: existing.x,
          y: existing.y,
          vx: existing.vx,
          vy: existing.vy,
          targetX: existing.targetX,
          targetY: existing.targetY,
        });
      } else {
        const nodeCount = visibleInputNodes.length || 1;
        const initialSpread = Math.max(200, Math.sqrt(nodeCount) * LINKED_ATTRACTION_DISTANCE * 1.2);
        const newNode: GraphNode = {
          ...inputNode,
          x: centerX + (Math.random() - 0.5) * initialSpread,
          y: centerY + (Math.random() - 0.5) * initialSpread,
          vx: 0,
          vy: 0,
          targetX: 0,
          targetY: 0,
        };
        createNode(newNode);
      }
    });
    
    const visibleNodeIds = new Set(nodesRef.current.map(n => n.id));
    linksRef.current = inputLinks.filter(
      link => visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target) && shouldLinkBeActive(link, visibilityFilters)
    );
    
    calculatePositions(nodesRef.current, viewMode, dimW, dimH, settings.constraintMode, settings.nodeSizeMode);
    
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
    
    warmupFrameRef.current = 0;
    
    if (!initialFitDoneRef.current && nodesRef.current.length > 0) {
      // For terrain mode, recenter immediately to ensure bullets spawn centered
      // For other modes, allow brief stabilization period
      const delay = viewMode === 'terrain' ? 0 : 500;
      const stabilizationTimer = setTimeout(() => {
        if (!initialFitDoneRef.current) {
          initialFitDoneRef.current = true;
          recenter();
        }
      }, delay);
      return () => clearTimeout(stabilizationTimer);
    }
  }, [inputNodes, inputLinks, viewMode, visibilityFilters, calculatePositions, createNode, destroyNode, shouldNodeBeVisible, shouldLinkBeActive, recenter, settings.constraintMode, settings.nodeSizeMode]);
  
  // Update glare states
  useEffect(() => {
    const nodes = nodesRef.current;
    const selectedIds = selectedNodeIdsRef.current;
    const currentId = currentNodeIdRef.current;
    const links = linksRef.current;
    
    if (currentId !== null) {
      nodes.forEach(n => {
        n.glare = n.id === currentId ? 'current' : 'normal';
      });
    } else if (selectedIds.length === 0) {
      nodes.forEach(n => n.glare = 'normal');
    } else if (selectedIds.length === 1) {
      const selectedId = selectedIds[0];
      
      const connectedNodeIds = new Set<number>();
      for (const link of links) {
        if (link.source === selectedId) {
          connectedNodeIds.add(link.target);
        } else if (link.target === selectedId) {
          connectedNodeIds.add(link.source);
        }
      }
      
      nodes.forEach(n => {
        if (n.id === selectedId) {
          n.glare = 'bright';
        } else if (connectedNodeIds.has(n.id)) {
          n.glare = 'normal';
        } else {
          n.glare = 'dim';
        }
      });
    } else {
      const nodeMap = new Map(nodes.map(n => [n.id, n]));
      
      nodes.forEach(n => n.glare = 'dim');
      
      for (const id of selectedIds) {
        const node = nodeMap.get(id);
        if (node) node.glare = 'bright';
      }
      
      for (let i = 0; i < selectedIds.length - 1; i++) {
        const path = findPathBetweenNodes(selectedIds[i], selectedIds[i + 1], nodes, links);
        
        for (const nodeId of path) {
          const node = nodeMap.get(nodeId);
          if (node && node.glare !== 'bright') {
            node.glare = 'path';
          }
        }
      }
    }
  }, [selectedNodeIds, currentNodeId, viewMode]);
  
  // Start simulation
  useEffect(() => {
    startSimulation();
    
    return () => {
      if (animationRef.current !== 0) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = 0;
      }
      if (transformRafRef.current) {
        cancelAnimationFrame(transformRafRef.current);
        transformRafRef.current = 0;
      }
    };
  }, [startSimulation]);
  
  // ==================== Return ====================
  
  return {
    nodesRef,
    linksRef,
    frameDataRef,
    transform,
    transformRef,
    setTransformDirect,
    dragNodeRef,
    dragStartTimeRef,
    dragLiftProgressRef,
    connectedPairsRef,
    adjacencyRef,
    massCacheRef,
    connectionCountsRef,
    inLinkCountsRef,
    outLinkCountsRef,
    wakeSimulation: wakeSimulationRef.current,
    requestRender,
    simulationSleepingRef,
    kineticEnergyRef,
    simulationPausedRef,
    pauseSimulation,
    resumeSimulation,
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
    selectedNodeIdsRef,
    currentNodeIdRef,
    viewModeRef,
    visibilityFiltersRef,
    cssVarsRef,
  };
}

// Re-export findPathBetweenNodes for use elsewhere
export { findPathBetweenNodes } from './viewTypes';
