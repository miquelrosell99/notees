/**
 * useNodePhysics Hook
 * 
 * Extracts the physics simulation engine from NodeGraphRenderer.
 * Handles:
 * - SemanticGraphEngine (cluster-aware hybrid layout) for all physics modes
 * - Node position updates with Verlet integration (via SGE)
 * - Topology caching (adjacency, mass, connection counts)
 * - Constrained mode positioning (circle/tree layouts)
 * - Transform state (pan/zoom)
 * - Node dragging
 * 
 * Used by both GraphRenderer and TerrainRenderer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SemanticGraphEngine } from './SemanticGraphEngine';
import type {
  MainToPhysicsMessage,
  PhysicsToMainMessage,
} from './graphPhysicsWorkerProtocol';
import type {
  GraphNode,
  GraphLink,
  GraphSettings,
  VisibilityFilters,
  GraphLayoutMode,
  NodeSizeMode,
  FrameData,
  Transform,
  Dimensions,
  ClassColor,
} from './viewTypes';
import {
  // Constants
  LINKED_ATTRACTION_DISTANCE,
  UNLINKED_REPULSION_DISTANCE,
  VELOCITY_DAMPING,
  PARENT_MASS_PER_CHILD,
  ALPHA_INITIAL,
  ALPHA_DECAY,
  ALPHA_TARGET,
  ALPHA_REHEAT,
  TERRAIN_BASE_SLOPE_RADIUS,
  TERRAIN_PEAK_SLOPE_RADIUS_BONUS,
  LINK_TYPE_PRIORITY,
  NODE_RADIUS_MAX,
  // Helpers
  getRenderSkip,
  getTerrainRenderSkip,
  pairKey,
  getGlareRadius,
  getNodeRadius,
  findAllShortestPaths,
} from './viewTypes';
import { applyCircleLayout } from './circleLayout';
import { applyTreeLayout } from './treeLayout';
import {
  runMainThreadPhysicsStep,
  applyRingConstraints,
  applyCOMRecentering,
  runEquidistantStep,
  type MainThreadPhysicsRefs,
} from './graphPhysicsCore';
import {
  runTerrainWorkerSync,
  computeAndDispatchTerrainData,
  type TerrainWorkerSyncRefs,
  type TerrainDataRefs,
} from './terrainPhysicsCore';

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
  const alphaRef = useRef(ALPHA_INITIAL);
  const initialFitDoneRef = useRef(false);
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
  
  // SemanticGraphEngine — handles all physics modes (normal, constrained-physics, terrain)
  const sgeRef = useRef<SemanticGraphEngine | null>(null);
  const sgeTopologyDirtyRef = useRef(true);
  
  // Frame data (shared with render)
  const frameDataRef = useRef<FrameData>({
    visibleNodes: [],
    visibleLinks: [],
    nodeMap: new Map(),
    maxConnections: 0,
    maxMass: 0,
    maxContentSize: 0,
    terrainHeights: new Map(),
    terrainPeakRadii: new Map(),
  });
  const frameNodeMapRef = useRef<Map<number, GraphNode>>(new Map());
  const frameVisibleLinksRef = useRef<GraphLink[]>([]);
  
  // Terrain data dirty flag — only recompute heights/radii when topology or settings change
  const terrainDataDirtyRef = useRef(true);

  // ==================== Terrain Physics Worker ====================
  // When isTerrainMode, we offload computeForces() + terrain forces + integrate()
  // to the same physics worker used by GraphRenderer.  The main thread only
  // computes terrain heights/radii (once per topology change) and syncs
  // positions back from the worker's SharedArrayBuffer each RAF.
  const terrainWorkerRef      = useRef<Worker | null>(null);
  const terrainWorkerReadyRef = useRef(false);
  // Preferred path: SharedArrayBuffer zero-copy poll
  const terrainSabPosRef      = useRef<Float32Array | null>(null);
  const terrainSabMetaI32Ref  = useRef<Int32Array   | null>(null);
  const terrainSabMetaF32Ref  = useRef<Float32Array | null>(null);
  const terrainSabNodeIdsRef  = useRef<Int32Array   | null>(null);
  const terrainSabSeqRef      = useRef<number>(0);
  // Fallback path: transferable frame messages (crossOriginIsolated=false)
  const terrainFramePosRef    = useRef<Float32Array | null>(null);
  const terrainFrameIdsRef    = useRef<Int32Array   | null>(null);
  // Per-frame drag & pin delta tracking (so we don't flood the worker with redundant messages)
  const terrainPrevDragIdRef   = useRef<number | null>(null);
  const terrainPinnedTrackRef  = useRef<Set<number>>(new Set());  
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
    if (link.type === 'semantic' && !filters.showSemanticLinks) return false;
    return true;
  }, []);
  
  // ==================== Position Calculation ====================
  
  const calculatePositions = useCallback((
    nodes: GraphNode[],
    mode: GraphLayoutMode | 'terrain',
    w: number,
    h: number,
    constraintMode: 'physics' | 'equidistant' = 'physics',
    nodeSizeMode: NodeSizeMode = 'uniform'
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
      const gr = getGlareRadius(n, nodeSizeMode, maxConn, maxMass, 0);
      if (gr > maxGlareRadius) maxGlareRadius = gr;
    }
    if (maxGlareRadius === 0) maxGlareRadius = 6 * 2.5; // NODE_RADIUS_BASE * GLARE_SCALE_NORMAL
    
    const nodeSpacing = maxGlareRadius * 2 + 8;
    const levelGap = maxGlareRadius * 2 + 40;
    
    if (mode === 'circle') {
      applyCircleLayout(nodes, centerX, centerY, nodeSpacing);
    } else if (mode === 'tree') {
      applyTreeLayout(nodes, centerX, centerY, nodeSpacing, levelGap, constraintMode);
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
    sgeTopologyDirtyRef.current = true; // Signal SGE to rebuild on next tick
    terrainDataDirtyRef.current = true; // Recompute terrain heights/radii on topology change
  }, []);
  
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
    
    // Use cached stats from the last simulation frame instead of recomputing
    const { maxConnections, maxMass, maxContentSize: maxContentSizeHit } = frameDataRef.current;
    
    // Use the largest possible hit radius for a quick bounding-box pre-filter
    const maxHitRadius = (NODE_RADIUS_MAX + 2 + 4) / t.scale;
    
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      if (!node.visible) continue;
      
      // Quick bounding-box reject before expensive radius calculation
      const dx = x - node.x;
      const dy = y - node.y;
      if (Math.abs(dx) > maxHitRadius || Math.abs(dy) > maxHitRadius) continue;
      
      const nodeRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass, maxContentSizeHit, currentSettings.linkDirection);
      const hitRadius = (nodeRadius + 2 + 4) / t.scale;
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
    
    // Use cached nodeMap and stats from the last simulation frame
    const { nodeMap, maxConnections, maxMass, maxContentSize: maxContentSizeLink } = frameDataRef.current;
    
    for (const link of linksRef.current) {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (!source || !target) continue;
      
      // Quick bounding-box reject: skip links far from the click point
      const lMinX = Math.min(source.x, target.x) - hitThreshold;
      const lMaxX = Math.max(source.x, target.x) + hitThreshold;
      const lMinY = Math.min(source.y, target.y) - hitThreshold;
      const lMaxY = Math.max(source.y, target.y) + hitThreshold;
      if (x < lMinX || x > lMaxX || y < lMinY || y > lMaxY) continue;
      
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
        const sourceRadius = getNodeRadius(source, currentSettings.nodeSizeMode, maxConnections, maxMass, maxContentSizeLink, currentSettings.linkDirection);
        const targetRadius = getNodeRadius(target, currentSettings.nodeSizeMode, maxConnections, maxMass, maxContentSizeLink, currentSettings.linkDirection);
        
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
  
  // ==================== Terrain Worker: Lifecycle ====================

  useEffect(() => {
    if (!_isTerrainMode) {
      // If we had a worker from a previous terrain session, clean it up.
      if (terrainWorkerRef.current) {
        terrainWorkerRef.current.postMessage({ type: 'destroy' } satisfies MainToPhysicsMessage);
        terrainWorkerRef.current.terminate();
        terrainWorkerRef.current    = null;
        terrainWorkerReadyRef.current = false;
        terrainSabPosRef.current     = null;
        terrainSabMetaI32Ref.current = null;
        terrainSabMetaF32Ref.current = null;
        terrainSabNodeIdsRef.current = null;
        terrainFramePosRef.current   = null;
        terrainFrameIdsRef.current   = null;
      }
      return;
    }

    // Spawn the physics worker (same bundle as graph mode, but will receive setTerrainMode).
    const worker = new Worker(
      new URL('./graphPhysicsWorker.ts', import.meta.url),
      { type: 'module' },
    );
    terrainWorkerRef.current    = worker;
    terrainWorkerReadyRef.current = false;

    worker.onmessage = (e: MessageEvent<PhysicsToMainMessage>) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        terrainWorkerReadyRef.current = true;
        // Enable terrain force injection in the worker.
        worker.postMessage({ type: 'setTerrainMode', enabled: true } satisfies MainToPhysicsMessage);
        wakeSimulationRef.current();
      } else if (msg.type === 'sharedBuffer') {
        terrainSabPosRef.current     = new Float32Array(msg.positions);
        terrainSabMetaI32Ref.current = new Int32Array(msg.meta);
        terrainSabMetaF32Ref.current = new Float32Array(msg.meta);
        terrainSabNodeIdsRef.current = msg.nodeIds;
        terrainSabSeqRef.current     = 0; // reset so next SAB frame is picked up
      } else if (msg.type === 'frame') {
        // Fallback when SAB is not available.
        terrainFramePosRef.current = msg.positions;
        terrainFrameIdsRef.current = msg.nodeIds;
      }
    };

    // Send initial topology — the worker responds with 'ready' once the engine is created.
    {
      const initNodes = nodesRef.current.filter(n => n.visible).map(n => ({ id: n.id, x: n.x, y: n.y }));
      const initEdges = linksRef.current.map(l => ({ source: l.source, target: l.target }));
      worker.postMessage({
        type: 'init',
        nodes: initNodes,
        edges: initEdges,
        config: {
          seed: 42,
          idealDistance: LINKED_ATTRACTION_DISTANCE,
          localRepelRadius: UNLINKED_REPULSION_DISTANCE,
        },
      } satisfies MainToPhysicsMessage);
      // Flag terrain data as dirty so worker gets heights/peakRadii on the first ready tick.
      terrainDataDirtyRef.current = true;
    }

    return () => {
      worker.postMessage({ type: 'destroy' } satisfies MainToPhysicsMessage);
      worker.terminate();
      terrainWorkerRef.current      = null;
      terrainWorkerReadyRef.current = false;
      terrainSabPosRef.current      = null;
      terrainSabMetaI32Ref.current  = null;
      terrainSabMetaF32Ref.current  = null;
      terrainSabNodeIdsRef.current  = null;
      terrainFramePosRef.current    = null;
      terrainFrameIdsRef.current    = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_isTerrainMode]);

  // ==================== Simulation ====================
  
  const startSimulation = useCallback(() => {
    const thisGeneration = ++simulationGenerationRef.current;
    
    let totalFrames = 0;
    
    const wake = () => {
      if (simulationGenerationRef.current !== thisGeneration) return;
      sleepCounterRef.current = 0;
      // Reheat alpha so forces resume with meaningful strength
      if (alphaRef.current < ALPHA_REHEAT) {
        alphaRef.current = ALPHA_REHEAT;
      }
      if (simulationSleepingRef.current) {
        simulationSleepingRef.current = false;
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
      const adjacency = adjacencyRef.current;
      const massCache = massCacheRef.current;
      const useMass = currentSettings.heightMode === 'hierarchy';
      
      let maxConnections = 0, maxMass = 0, maxContentSize = 0;
      const linkDir = currentSettings.linkDirection;
      
      // Single pass: compute per-node stats + build nodeMap + compute center-of-mass
      // (merges what were 3-4 separate loops over all nodes)
      const nodeMap = frameNodeMapRef.current;
      nodeMap.clear();
      let comX = 0, comY = 0, comCount = 0;
      for (const node of nodes) {
        const mass = useMass ? (massCache.get(node.id) ?? 1) : 1;
        (node as GraphNode & { _mass?: number })._mass = mass;
        const dirCount = linkDir === 'in' ? node.inLinkCount : linkDir === 'out' ? node.outLinkCount : node.connectionCount;
        if (dirCount > maxConnections) maxConnections = dirCount;
        if (mass > maxMass) maxMass = mass;
        if (node.contentSize > maxContentSize) maxContentSize = node.contentSize;
        nodeMap.set(node.id, node);
        if (!node.pinned) {
          comX += node.x;
          comY += node.y;
          comCount++;
        }
      }
      
      const usePhysics = !isConstrainedMode || currentSettings.constraintMode === 'physics';
      
      // Alpha decay (d3-force style): all forces are multiplied by alpha.
      // Alpha decays exponentially each tick toward alphaTarget.
      const alpha = alphaRef.current;
      alphaRef.current += (ALPHA_TARGET - alphaRef.current) * ALPHA_DECAY;
      
      const currentNodeSizeMode = currentSettings.nodeSizeMode;
      const currentLinkDirection = currentSettings.linkDirection;
      
      // ==================== SemanticGraphEngine (all physics modes) ====================
      // Uses cluster-aware hybrid layout (SGE) for normal, constrained-physics, and
      // terrain modes. Core forces (repulsion, springs, clustering) are computed by SGE;
      // mode-specific forces are injected via applyForce() between phases.
      if (usePhysics) {
        // Is the terrain physics worker ready to handle this frame?
        const usingTerrainWorker = isTerrainModeNow && terrainWorkerReadyRef.current;

        // Build/rebuild SGE when topology changes
        if (sgeTopologyDirtyRef.current || (!sgeRef.current && !usingTerrainWorker)) {
          const sgeNodes = nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
          const sgeEdges = links.map(l => ({ source: l.source, target: l.target }));
          if (usingTerrainWorker) {
            // Offload topology change to worker — no local SGE needed in terrain mode.
            terrainWorkerRef.current!.postMessage({
              type: 'setTopology', nodes: sgeNodes, edges: sgeEdges,
            } satisfies MainToPhysicsMessage);
          } else {
            if (sgeRef.current) {
              sgeRef.current.setNodes(sgeNodes);
              sgeRef.current.setEdges(sgeEdges);
            } else {
              sgeRef.current = new SemanticGraphEngine(sgeNodes, sgeEdges, {
                seed: 42,
                idealDistance: LINKED_ATTRACTION_DISTANCE,
                localRepelRadius: UNLINKED_REPULSION_DISTANCE,
              });
            }
            for (const node of nodes) {
              if (sgeRef.current.getNode(node.id)) {
                sgeRef.current.moveNode(node.id, node.x, node.y);
              }
            }
          }
          sgeTopologyDirtyRef.current = false;
        }

        if (usingTerrainWorker) {
          // ================================================================
          // TERRAIN WORKER PATH — positions read back from the off-thread worker.
          // ================================================================
          runTerrainWorkerSync(
            {
              terrainWorkerRef, terrainSabPosRef, terrainSabMetaI32Ref,
              terrainSabMetaF32Ref, terrainSabNodeIdsRef, terrainSabSeqRef,
              terrainFramePosRef, terrainFrameIdsRef,
              terrainPrevDragIdRef, terrainPinnedTrackRef,
              dragNodeRef, kineticEnergyRef, alphaRef,
            } satisfies TerrainWorkerSyncRefs,
            nodes,
            nodeMap,
          );
        } else {
          // ================================================================
          // MAIN THREAD PHYSICS PATH (graph mode, or terrain before worker ready)
          // ================================================================

          // Sync centralGravity setting to SGE config
          if (sgeRef.current) {
            sgeRef.current.setConfig({
              componentCenterStrength: currentSettings.centralGravity ? 0.001 : 0,
            });
          }

          runMainThreadPhysicsStep(
            { sgeRef, dragNodeRef, dimensionsRef, frameDataRef } satisfies MainThreadPhysicsRefs,
            nodes, nodeMap, links,
            adjacency, connectedPairs, massCache,
            alpha, isConstrainedMode, isTerrainModeNow, useMass,
            currentNodeSizeMode, maxConnections, maxMass, maxContentSize, currentLinkDirection,
          );
        } // end if/else usingTerrainWorker
        
        // Ring constraint projection (constrained physics — position-based, after integration)
        if (isConstrainedMode) {
          applyRingConstraints(sgeRef, dragNodeRef, dimensionsRef, nodes);
        }
        
        // COM recentering (normal mode only — keep graph centered on canvas)
        if (!isConstrainedMode && !isTerrainModeNow && comCount > 0) {
          applyCOMRecentering(dragNodeRef, dimensionsRef, nodes, comCount);
        }
      } else {
        // ==================== Equidistant mode (no physics engine) ====================
        runEquidistantStep(dragNodeRef, nodes, nodeMap, adjacency, massCache, isConstrainedMode, useMass);
      }
      
      // Drag lift animation
      if (dragNodeRef.current && dragNodeRef.current.visible) {
        if (dragStartTimeRef.current !== null) {
          const elapsed = Date.now() - dragStartTimeRef.current;
          dragLiftProgressRef.current = Math.min(1, elapsed / 150);
        }
      } else {
        if (dragLiftProgressRef.current > 0) {
          dragLiftProgressRef.current = Math.max(0, dragLiftProgressRef.current - 0.1);
        }
      }
      
      // Integration: SGE handles Verlet integration for physics modes.
      // Only equidistant mode needs Euler integration here.
      let totalKE = 0;
      let mobileCount = 0;
      if (usePhysics) {
        // SGE already integrated — compute KE for sleep detection
        for (const node of nodes) {
          if (dragNodeRef.current?.id !== node.id && !node.pinned) {
            totalKE += node.vx * node.vx + node.vy * node.vy;
            mobileCount++;
          }
        }
      } else {
        const baseDamping = VELOCITY_DAMPING;
        for (const node of nodes) {
          if (dragNodeRef.current?.id !== node.id && !node.pinned) {
            node.vx *= baseDamping;
            node.vy *= baseDamping;
            node.x += node.vx;
            node.y += node.vy;
            totalKE += node.vx * node.vx + node.vy * node.vy;
            mobileCount++;
            // Ring constraint projection (equidistant mode)
            if (isConstrainedMode) {
              const treeRadius = (node as GraphNode & { _treeRadius?: number })._treeRadius;
              if (treeRadius !== undefined) {
                const cx = dimensionsRef.current.width / 2;
                const cy = dimensionsRef.current.height / 2;
                const ndx = node.x - cx;
                const ndy = node.y - cy;
                const distToCenter = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
                const radialX = ndx / distToCenter;
                const radialY = ndy / distToCenter;
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
      }
      
      // Collision resolution (position-based + velocity dampening)
      // Uses spatial hash grid for O(n) average-case instead of O(n²) brute force.
      // Runs AFTER velocity integration so position corrections are the
      // final authority and aren't partially undone by node.x += node.vx.
      // Skip during early warmup — nodes are moving fast and collisions just burn CPU.

      
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
        frameDataRef.current.maxContentSize = maxContentSize;
        
        // Compute terrain heights and peak radii — only when topology or settings changed
        if (isTerrainModeNow && terrainDataDirtyRef.current) {
          computeAndDispatchTerrainData(
            {
              frameDataRef, terrainDataDirtyRef,
              terrainWorkerRef, terrainWorkerReadyRef,
              massCacheRef, inLinkCountsRef,
              inReferenceLinkCountsRef, outReferenceLinkCountsRef, allReferenceLinkCountsRef,
            } satisfies TerrainDataRefs,
            nodes, links, currentSettings,
          );
        }
        
        if (ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
      }
      
      // Track kinetic energy for diagnostics (no sleep — simulation runs forever)
      {
        const avgKE = mobileCount > 0 ? totalKE / mobileCount : 0;
        kineticEnergyRef.current = avgKE;
      }
      
      animationRef.current = requestAnimationFrame(simulate);
    };
    
    simulate();
  }, [rebuildTopologyCache, shouldLinkBeActive]);
  
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
    
    alphaRef.current = ALPHA_INITIAL;
    
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
        const pathNodes = findAllShortestPaths(selectedIds[i], selectedIds[i + 1], nodes, links);
        
        for (const nodeId of pathNodes) {
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

// Re-export path finding function for use elsewhere
export { findAllShortestPaths } from './viewTypes';
