/**
 * NodeGraphRenderer Component
 * 
 * Core graph rendering component that handles:
 * - Canvas-based rendering of nodes and links
 * - Force-directed physics simulation
 * - Multiple view modes (normal, circle, tree)
 * - Pan and zoom
 * - Node interaction (hover, click, drag)
 * - Type-based coloring
 * - Dynamic node management (create/destroy in real-time)
 * 
 * This is a pure visualization component - all data filtering and
 * UI chrome (settings panels, buttons) are handled by parent components.
 * 
 * ## Dynamic Node Management
 * The renderer supports dynamic addition and removal of nodes from the physics
 * simulation in real-time through the exposed ref methods:
 * - `createNode(node)` - Adds a node to the simulation with physics
 * - `destroyNode(nodeId)` - Removes a node and its links from the simulation
 * - `updateLinks(links)` - Updates the link structure dynamically
 * 
 * These methods enable:
 * - Real-time filtering without re-initializing the entire graph
 * - Creation date animation where nodes appear sequentially
 * - Dynamic arrow generation based on current node/link state
 */
import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import './NodeGraphRenderer.css';

// ==================== Configuration ====================

// Physics constants
const LINKED_ATTRACTION_DISTANCE = 120;
const UNLINKED_REPULSION_DISTANCE = 200;
const ATTRACTION_STRENGTH = 0.02;
const ATTRACTION_STRENGTH_LINK_COUNT = 0.008;
const REFERENCE_LINK_FORCE_MULTIPLIER = 0.5;
const REPULSION_STRENGTH = 500;
const VELOCITY_DAMPING = 0.7;
const RETURN_FORCE = 0.08;
const DRAG_PULL_STRENGTH = 0.15;
const PARENT_MASS_PER_CHILD = 2;
const MIN_REPULSION_DISTANCE = 20; // Prevent infinite force when nodes overlap
const MAX_VELOCITY = 10; // Clamp velocity to prevent explosive movement
const WARMUP_DURATION_FRAMES = 60; // Frames over which simulation ramps to full strength
const CENTER_GRAVITY = 0.003; // Gentle pull toward center to prevent drift
const SLEEP_KE_PER_NODE = 0.005; // Per-node contribution to sleep threshold (scales with graph size)
const VELOCITY_DEADZONE = 0.1; // Zero out velocity below this to prevent jitter near equilibrium
const LINK_DAMPING = 0.4; // Dashpot: damp relative velocity along spring axis to prevent oscillation

// Adaptive frame cap: large graphs get fewer frames to prevent OOM
// Base cap for small graphs, inversely scaled for large ones
function getMaxSimulationFrames(nodeCount: number): number {
  // Return 0 to allow unlimited simulation (converges via sleep threshold).
  // Set non-zero values to hard-cap frames if needed.
  if (nodeCount <= 200) return 0;
  if (nodeCount <= 500) return 0;
  if (nodeCount <= 1000) return 0;
  return 0;
}

// Absolute wall-clock time cap (ms) — safety net so simulation never causes OOM
// regardless of frame count or convergence.  Fires before frame cap as a hard limit.
const MAX_SIMULATION_TIME_MS = 0; // 0 = unlimited; set positive value (ms) to hard-cap wall-clock time

// Render skip interval: large graphs only render every Nth frame during physics
// Physics runs every frame but canvas drawing is skipped to reduce memory/GPU pressure
function getRenderSkip(nodeCount: number): number {
  // Return 1 to render every frame. Increase to skip frames for large graphs if needed.
  if (nodeCount <= 200) return 1;
  if (nodeCount <= 500) return 1;
  if (nodeCount <= 1000) return 1;
  return 1;
}

// Pre-allocated arrays for setLineDash (avoids per-frame array creation)
const LINE_DASH_NONE: number[] = [];
const LINE_DASH_DOTTED: number[] = [2, 3];

// Visual constants
const NODE_RADIUS_BASE = 10;
const NODE_RADIUS_MIN = 6;
const NODE_RADIUS_MAX = 20;
const NODE_HOVER_RADIUS_EXTRA = 4;
const GLARE_SCALE_NORMAL = 1.8;
const GLARE_SCALE_BRIGHT = 2.0;
const GLARE_SCALE_CURRENT = 2.4;
const GLARE_OPACITY_NORMAL = 0.2;
const GLARE_OPACITY_BRIGHT = 0.4;
const GLARE_OPACITY_DIM = 0.05;

// Label fade settings
const LABEL_FADE_ZOOM_MIN = 0.4;
const LABEL_FADE_ZOOM_MAX = 0.7;

// ==================== Types ====================

export type GraphViewMode = 'normal' | 'circle' | 'tree';
export type GlareState = 'normal' | 'bright' | 'dim' | 'path' | 'current';
export type NodeSizeMode = 'uniform' | 'connections' | 'mass';
export type ConstraintMode = 'physics' | 'equidistant';

export interface GraphNode {
  id: number;
  uuid: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  name: string;
  type: 'page' | 'block';
  isDaily: boolean;
  isMonthly: boolean;
  isYearly: boolean;
  isSystemPage: boolean;
  tags: string[];
  types: number[];
  parentId: number | null;
  glare: GlareState;
  pinned: boolean;
  color?: string;
  connectionCount: number;
  createdAt?: string;
  visible: boolean;
  isClassNode: boolean;
}

export interface GraphLink {
  source: number;
  target: number;
  type: 'parent' | 'reference' | 'property-reference' | 'class' | 'extends';
}

export interface ClassColor {
  typeId: number;
  typeName: string;
  color: string;
  order: number;
}

export interface GraphSettings {
  linkCountAttraction: boolean;
  nodeSizeMode: NodeSizeMode;
  massAccumulation: boolean;
  constraintMode: ConstraintMode;
}

export interface VisibilityFilters {
  showClassNodes: boolean;
  showClassLinks: boolean;
  showParentLinks: boolean;
  showReferenceLinks: boolean;
  showDayPages: boolean;
  showMonthPages: boolean;
  showYearPages: boolean;
  showSystemPages: boolean;
}

export interface NodeGraphRendererProps {
  /** Nodes to display */
  nodes: GraphNode[];
  /** Links between nodes */
  links: GraphLink[];
  /** Current view mode */
  viewMode?: GraphViewMode;
  /** Graph settings */
  settings?: GraphSettings;
  /** Class colors for node coloring */
  classColors?: ClassColor[];
  /** Visibility filters for node types */
  visibilityFilters?: VisibilityFilters;
  /** Currently highlighted node (for minimap mode) */
  currentNodeId?: number | null;
  /** Selected node IDs */
  selectedNodeIds?: number[];
  /** CSS class */
  className?: string;
  /** Node click handler */
  onNodeClick?: (node: GraphNode, event: { shiftKey: boolean; ctrlKey: boolean }) => void;
  /** Node double-click handler */
  onNodeDoubleClick?: (node: GraphNode) => void;
  /** Node right-click handler (for pinning) */
  onNodeRightClick?: (node: GraphNode) => void;
  /** Selection change handler */
  onSelectionChange?: (nodeIds: number[]) => void;
  /** Hovered node change handler */
  onHoveredNodeChange?: (node: GraphNode | null) => void;
}

export interface NodeGraphRendererRef {
  recenter: () => void;
  triggerCreationAnimation: () => void;
  createNode: (node: GraphNode) => void;
  destroyNode: (nodeId: number) => void;
  updateLinks: (links: GraphLink[]) => void;
}

// ==================== Helper Functions ====================

function findPathBetweenNodes(
  startId: number,
  endId: number,
  nodes: GraphNode[],
  links: GraphLink[]
): number[] {
  const adjacency = new Map<number, number[]>();
  
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  
  for (const link of links) {
    adjacency.get(link.source)?.push(link.target);
    adjacency.get(link.target)?.push(link.source);
  }
  
  const visited = new Set<number>();
  const parent = new Map<number, number>();
  const queue: number[] = [startId];
  visited.add(startId);
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    
    if (current === endId) {
      const path: number[] = [];
      let node: number | undefined = endId;
      while (node !== undefined) {
        path.unshift(node);
        node = parent.get(node);
      }
      return path;
    }
    
    for (const neighbor of adjacency.get(current) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }
  
  return [];
}

// NOTE: classColors must be pre-sorted by order before passing in.
// Do NOT sort inside this hot-path function — it runs per-node per-frame.
function getNodeColor(node: GraphNode, classColors: ClassColor[], accentColor: string): string {
  if (node.color) return node.color;
  
  if (node.types && node.types.length > 0 && classColors.length > 0) {
    for (const classColor of classColors) {
      if (node.types.includes(classColor.typeId)) {
        return classColor.color;
      }
    }
  }
  
  return accentColor;
}

// Link type to numeric id for dedup key (moved out of render to avoid per-frame closure)
function linkTypeId(t: string): number {
  switch (t) { case 'parent': return 0; case 'class': return 1; case 'extends': return 2; case 'reference': return 3; default: return 4; }
}

// Glare radius helper — moved out of render loop to avoid per-frame closure creation
function getGlareRadius(node: GraphNode, nodeSizeMode: NodeSizeMode, maxConnections: number, maxMass: number): number {
  const nodeRadius = getNodeRadius(node, nodeSizeMode, maxConnections, maxMass);
  switch (node.glare) {
    case 'bright': return nodeRadius * GLARE_SCALE_BRIGHT;
    case 'current': return nodeRadius * GLARE_SCALE_CURRENT;
    default: return nodeRadius * GLARE_SCALE_NORMAL;
  }
}

// Cache for hexToRgba results — avoids repeated string creation in hot render loop
const hexToRgbaCache = new Map<string, string>();

function hexToRgba(hex: string, opacity: number): string {
  // Key: combine hex and opacity (opacity is typically a small set of fixed values)
  const key = hex + opacity;
  const cached = hexToRgbaCache.get(key);
  if (cached) return cached;
  
  let cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  const result = `rgba(${r}, ${g}, ${b}, ${opacity})`;
  hexToRgbaCache.set(key, result);
  return result;
}

function getNodeRadius(
  node: GraphNode, 
  nodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
): number {
  if (nodeSizeMode === 'uniform') {
    return NODE_RADIUS_BASE;
  }
  
  let value = 0;
  let max = 1;
  
  switch (nodeSizeMode) {
    case 'connections':
      value = node.connectionCount;
      max = maxConnections || 1;
      break;
    case 'mass':
      // mass is stored on the node by the simulation
      value = (node as GraphNode & { _mass?: number })._mass ?? 1;
      max = maxMass || 1;
      break;
  }
  
  const ratio = Math.sqrt(value / max);
  return NODE_RADIUS_MIN + ratio * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
}

// Unused - kept for future reference
// function buildFullPath(
//   node: GraphNode,
//   nodes: GraphNode[]
// ): string {
//   if (node.parentId === null) {
//     // Root page, just return name
//     return node.name;
//   }
//   
//   // Build path from root to current node
//   const path: string[] = [];
//   let currentId: number | null = node.id;
//   const visited = new Set<number>(); // Prevent infinite loops
//   const nodeMap = new Map(nodes.map(n => [n.id, n]));
//   
//   while (currentId !== null && !visited.has(currentId)) {
//     visited.add(currentId);
//     const currentNode = nodeMap.get(currentId);
//     if (!currentNode) break;
//     
//     path.unshift(currentNode.name);
//     currentId = currentNode.parentId;
//   }
//   
//   return path.join(' / ');
// }

// ==================== Topology Helpers (module-level, not re-created per render) ====================

// Link type priority: higher number wins when multiple links connect same pair
const LINK_TYPE_PRIORITY: Record<string, number> = {
  'reference': 0,
  'property-reference': 1,
  'extends': 2,
  'class': 3,
  'parent': 4,
};

// Numeric pair key — avoids string interpolation in hot loop
function pairKey(a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * 100000 + hi;
}

// ==================== Component ====================

const DEFAULT_VISIBILITY_FILTERS: VisibilityFilters = {
  showClassNodes: true,
  showClassLinks: true,
  showParentLinks: true,
  showReferenceLinks: true,
  showDayPages: true,
  showMonthPages: true,
  showYearPages: true,
  showSystemPages: true,
};

export const NodeGraphRenderer = forwardRef<NodeGraphRendererRef, NodeGraphRendererProps>(function NodeGraphRenderer({
  nodes: inputNodes,
  links: inputLinks,
  viewMode = 'normal',
  settings = { linkCountAttraction: false, nodeSizeMode: 'uniform', massAccumulation: true, constraintMode: 'physics' },
  classColors = [],
  visibilityFilters = DEFAULT_VISIBILITY_FILTERS,
  currentNodeId = null,
  selectedNodeIds = [],
  className = '',
  onNodeClick,
  onNodeDoubleClick,
  onNodeRightClick,
  onSelectionChange,
  onHoveredNodeChange,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const dragNodeRef = useRef<GraphNode | null>(null);
  const didDragMoveRef = useRef(false);
  const lastClickTimeRef = useRef<number>(0);
  const lastClickedNodeRef = useRef<number | null>(null);
  const renderRef = useRef<((ctx: CanvasRenderingContext2D) => void) | null>(null);
  const wasJustDraggingRef = useRef(false);
  const dragLiftProgressRef = useRef(0); // 0 to 1 for drag lift animation
  const dragStartTimeRef = useRef<number | null>(null);
  const initialFitDoneRef = useRef(false); // Track if initial fit-to-view was done
  const warmupFrameRef = useRef(0); // Warm-up frame counter for gentle simulation start
  const centerGravityActiveRef = useRef(true); // Only true on very first graph load
  
  // Refs for current values (to avoid stale closures)
  const settingsRef = useRef(settings);
  const classColorsRef = useRef(classColors);
  const visibilityFiltersRef = useRef(visibilityFilters);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const currentNodeIdRef = useRef(currentNodeId);
  const viewModeRef = useRef(viewMode);
  
  // Cached CSS variables (avoid per-frame getComputedStyle)
  const cssVarsRef = useRef({ textColor: '#333', accentColor: '#6366f1', dimColor: '#404040' });
  
  // Topology cache — rebuilt only when nodes/links change, not every frame
  const topologyDirtyRef = useRef(true);
  // connectedPairs: numeric key = min*100000+max → link type (with priority)
  const connectedPairsRef = useRef(new Map<number, GraphLink['type']>());
  const adjacencyRef = useRef(new Map<number, Set<number>>());
  const childrenOfRef = useRef(new Map<number, number[]>());
  const massCacheRef = useRef(new Map<number, number>());
  const connectionCountsRef = useRef(new Map<number, number>());
  
  // Shared data between simulate and render (written by simulate, read by render)
  const frameDataRef = useRef<{
    visibleNodes: GraphNode[];
    visibleLinks: GraphLink[];
    nodeMap: Map<number, GraphNode>;
    maxConnections: number;
    maxMass: number;
  }>({ visibleNodes: [], visibleLinks: [], nodeMap: new Map(), maxConnections: 0, maxMass: 0 });
  
  // Reusable per-frame collections (avoid GC pressure)
  const frameNodeMapRef = useRef(new Map<number, GraphNode>());
  const frameVisibleLinksRef = useRef<GraphLink[]>([]);
  const bhStackRef = useRef<(QuadNode | null)[]>(new Array(256).fill(null)); // Barnes-Hut traversal stack
  
  // Quadtree object pool — reuse across frames to avoid GC
  const quadPoolRef = useRef<QuadNode[]>([]);
  const quadPoolIdxRef = useRef(0);
  
  // Render-phase reusable collections
  const linkDirCacheRef = useRef(new Map<number, number>()); // pairKey → bitfield (1=fwd, 2=rev)
  const drawnLinksCacheRef = useRef(new Set<number>());
  
  // Convergence-based simulation sleep
  const simulationSleepingRef = useRef(false);
  const wakeSimulationRef = useRef<() => void>(() => {});
  const simulationGenerationRef = useRef(0); // Guard against ghost simulation loops
  
  // Pan and zoom state
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const transformRafRef = useRef<number>(0); // throttle React state updates
  
  // Canvas 2D context ref — stored once by startSimulation, reused for sleeping renders
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  
  // Write transform directly to ref (immediate) and schedule React state update (throttled).
  // The canvas reads from transformRef so it stays perfectly smooth;
  // React state is only needed for cursor style and handleWheel closure.
  // When simulation is sleeping, also trigger a canvas render for pan/zoom.
  const setTransformDirect = useCallback((t: { x: number; y: number; scale: number }) => {
    transformRef.current = t;
    if (!transformRafRef.current) {
      transformRafRef.current = requestAnimationFrame(() => {
        transformRafRef.current = 0;
        setTransform(transformRef.current);
        // If simulation is sleeping, re-render canvas so pan/zoom is visible
        if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
          renderRef.current(ctxRef.current);
        }
      });
    }
  }, []);
  
  // Trigger a single canvas re-render when simulation is sleeping (no-op if awake)
  const requestRender = useCallback(() => {
    if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
      renderRef.current(ctxRef.current);
    }
  }, []);

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const dimensionsRef = useRef(dimensions);
  useEffect(() => {
    dimensionsRef.current = dimensions;
    // Re-render canvas when dimensions change (simulation may be sleeping)
    if (simulationSleepingRef.current && ctxRef.current && renderRef.current) {
      renderRef.current(ctxRef.current);
    }
  }, [dimensions]);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const hoveredNodeRef = useRef<GraphNode | null>(null);

  // Calculate positions for view modes
  const calculatePositions = useCallback((
    nodes: GraphNode[],
    mode: GraphViewMode,
    w: number,
    h: number,
    constraintMode: ConstraintMode = 'physics'
  ) => {
    const centerX = w / 2;
    const centerY = h / 2;
    
    // Common spacing parameters for both circle and tree modes
    const nodeSpacing = 80; // Minimum spacing between node centers
    const levelGap = 100; // Gap between concentric circles (tree) or base radius factor (circle)
    
    if (mode === 'circle') {
      // Position all nodes in a circle
      const radius = Math.min(centerX, centerY) * 0.8;
      nodes.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
        node.targetX = centerX + radius * Math.cos(angle);
        node.targetY = centerY + radius * Math.sin(angle);
        // Store radius for physics constraint
        (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
        // Seed unpositioned nodes at target
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
      
      // Find root nodes - special handling for classes
      const classRoots = nodes.filter(n => n.isClassNode && n.parentId === null);
      const regularRoots = nodes.filter(n => !n.isClassNode && n.parentId === null);
      const hasVisibleClasses = classRoots.length > 0;
      
      // BFS: assign depths to class hierarchy first
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
      
      // Regular roots go one level below the deepest class node
      const regularRootLevel = hasVisibleClasses ? maxClassDepth + 1 : 0;
      for (const node of regularRoots) {
        nodeDepth.set(node.id, regularRootLevel);
      }
      
      // BFS to assign depths to all remaining nodes (regular hierarchy)
      const queue = [...regularRoots];
      // Also add class roots to process their non-class children
      for (const node of classRoots) queue.push(node);
      // And class children that were already depth-assigned
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
      
      // Find max depth
      let maxDepth = 0;
      for (const depth of nodeDepth.values()) {
        maxDepth = Math.max(maxDepth, depth);
      }
      
      // Group nodes by depth
      const nodesByDepth = new Map<number, GraphNode[]>();
      for (const node of nodes) {
        const depth = nodeDepth.get(node.id);
        if (depth !== undefined) {
          const nodesAtDepth = nodesByDepth.get(depth) || [];
          nodesAtDepth.push(node);
          nodesByDepth.set(depth, nodesAtDepth);
        }
      }
      
      // Simple uniform radius calculation
      const maxRadius = Math.min(centerX, centerY) * 0.9;
      
      const radiusByDepth = new Map<number, number>();
      for (let depth = 0; depth <= maxDepth; depth++) {
        radiusByDepth.set(depth, Math.min(levelGap * (depth + 1), maxRadius));
      }
      
      if (constraintMode === 'equidistant') {
        // ── Equidistant mode: evenly space nodes at each depth ring ──
        for (let depth = 0; depth <= maxDepth; depth++) {
          const nodesAtDepth = nodesByDepth.get(depth) || [];
          const radius = radiusByDepth.get(depth)!;
          const count = nodesAtDepth.length;
          if (count === 0) continue;
          
          nodesAtDepth.forEach((node, i) => {
            const angle = (2 * Math.PI * i) / count - Math.PI / 2;
            node.targetX = centerX + radius * Math.cos(angle);
            node.targetY = centerY + radius * Math.sin(angle);
            (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
          });
        }
      } else {
      // ── Bottom-up subtree angular width calculation ──
      // For each node, compute how much angular space its entire subtree
      // needs at the deepest level, then propagate upward so parents
      // reserve enough room for all descendants.
      const subtreeAngularWidth = new Map<number, number>();
      
      // Process depths bottom-up
      for (let depth = maxDepth; depth >= 0; depth--) {
        const nodesAtDepth = nodesByDepth.get(depth) || [];
        for (const node of nodesAtDepth) {
          const children = (childrenByParent.get(node.id) || [])
            .filter(c => nodeDepth.has(c.id)); // only children in the graph
          
          if (children.length === 0) {
            // Leaf node: needs space for itself at its own depth
            const radius = radiusByDepth.get(depth)!;
            subtreeAngularWidth.set(node.id, nodeSpacing / radius);
          } else {
            // Sum of all children's subtree widths, but evaluated at
            // each child's depth radius
            const childDepth = depth + 1;
            const childRadius = radiusByDepth.get(childDepth)!;
            
            let totalChildrenWidth = 0;
            for (const child of children) {
              const childWidth = subtreeAngularWidth.get(child.id) || (nodeSpacing / childRadius);
              totalChildrenWidth += childWidth;
            }
            
            // The node itself also needs minimum space at its own depth
            const ownRadius = radiusByDepth.get(depth)!;
            const ownMinWidth = nodeSpacing / ownRadius;
            
            // Take the max: either the node's own space or children's total
            subtreeAngularWidth.set(node.id, Math.max(ownMinWidth, totalChildrenWidth));
          }
        }
      }
      
      // ── Top-down positioning using computed widths ──
      const nodeAngleRange = new Map<number, { start: number; end: number }>();
      
      // Collect all level-0 nodes (class roots or regular roots if no classes)
      const level0Nodes = nodesByDepth.get(0) || [];
      const radius0 = radiusByDepth.get(0)!;
      
      // Total angular width needed for all level-0 subtrees
      let totalLevel0Width = 0;
      for (const node of level0Nodes) {
        totalLevel0Width += subtreeAngularWidth.get(node.id) || (nodeSpacing / radius0);
      }
      // Ensure at least 2π, but allow expansion beyond if needed
      const totalAngle0 = Math.max(2 * Math.PI, totalLevel0Width);
      // Scale factor if subtrees fit within 2π
      const scale0 = totalAngle0 / totalLevel0Width;
      
      let currentAngle0 = -Math.PI / 2;
      for (const node of level0Nodes) {
        const rawWidth = subtreeAngularWidth.get(node.id) || (nodeSpacing / radius0);
        const allocatedWidth = rawWidth * scale0;
        const angle = currentAngle0 + allocatedWidth / 2;
        
        node.targetX = centerX + radius0 * Math.cos(angle);
        node.targetY = centerY + radius0 * Math.sin(angle);
        (node as GraphNode & { _treeRadius?: number })._treeRadius = radius0;
        
        nodeAngleRange.set(node.id, {
          start: currentAngle0,
          end: currentAngle0 + allocatedWidth
        });
        
        currentAngle0 += allocatedWidth;
      }
      
      // Position nodes at each subsequent level
      for (let depth = 1; depth <= maxDepth; depth++) {
        const nodesAtDepth = nodesByDepth.get(depth) || [];
        const radius = radiusByDepth.get(depth)!;
        
        // Separate into nodes with parents in the graph and root nodes
        const nodesWithParent = nodesAtDepth.filter(n => n.parentId !== null && nodeAngleRange.has(n.parentId));
        const rootNodesAtThisLevel = nodesAtDepth.filter(n => n.parentId === null || !nodeAngleRange.has(n.parentId));
        
        // Position root nodes at this level evenly
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
            
            nodeAngleRange.set(node.id, {
              start: currentAngleRoot,
              end: currentAngleRoot + allocatedWidth
            });
            
            currentAngleRoot += allocatedWidth;
          }
        }
        
        // Position nodes with parents: allocate within parent's arc
        // Group by parent first to handle sibling sets together
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
          
          // Total subtree width needed by all siblings
          let totalSiblingWidth = 0;
          for (const sibling of siblings) {
            totalSiblingWidth += subtreeAngularWidth.get(sibling.id) || (nodeSpacing / radius);
          }
          
          // Use parent's span (already accounts for subtree), but ensure
          // minimum spacing if parent arc is somehow larger
          const actualSpan = Math.max(parentSpan, totalSiblingWidth);
          const startAngle = parentCenter - actualSpan / 2;
          
          // Distribute proportionally to each child's subtree width
          let currentAngle = startAngle;
          for (const sibling of siblings) {
            const childWidth = subtreeAngularWidth.get(sibling.id) || (nodeSpacing / radius);
            // Scale proportionally if we have more room than needed
            const allocatedWidth = (childWidth / totalSiblingWidth) * actualSpan;
            const angle = currentAngle + allocatedWidth / 2;
            
            sibling.targetX = centerX + radius * Math.cos(angle);
            sibling.targetY = centerY + radius * Math.sin(angle);
            (sibling as GraphNode & { _treeRadius?: number })._treeRadius = radius;
            
            nodeAngleRange.set(sibling.id, {
              start: currentAngle,
              end: currentAngle + allocatedWidth
            });
            
            currentAngle += allocatedWidth;
          }
        }
      }
      } // end physics (non-equidistant) branch
      
      // Handle orphans (nodes without valid parent)
      const orphans = nodes.filter(n => !nodeDepth.has(n.id));
      orphans.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / Math.max(orphans.length, 1) + Math.PI;
        const radius = maxRadius;
        node.targetX = centerX + radius * Math.cos(angle);
        node.targetY = centerY + radius * Math.sin(angle);
        (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
      });
    } else {
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

  // Keep refs in sync (fallback for setTransform calls not through setTransformDirect)
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => {
    const prevConstraintMode = settingsRef.current.constraintMode;
    settingsRef.current = settings;
    topologyDirtyRef.current = true;
    // Recalculate positions when constraint mode changes in tree/circle mode
    if (settings.constraintMode !== prevConstraintMode && (viewModeRef.current === 'circle' || viewModeRef.current === 'tree') && nodesRef.current.length > 0) {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settings.constraintMode);
    }
    wakeSimulationRef.current();
  }, [settings, calculatePositions]);
  useEffect(() => { classColorsRef.current = [...classColors].sort((a, b) => a.order - b.order); requestRender(); }, [classColors, requestRender]);
  useEffect(() => { selectedNodeIdsRef.current = selectedNodeIds; requestRender(); }, [selectedNodeIds, requestRender]);
  useEffect(() => { currentNodeIdRef.current = currentNodeId; requestRender(); }, [currentNodeId, requestRender]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { hoveredNodeRef.current = hoveredNode; }, [hoveredNode]);
  
  // Handle view mode changes separately — only update targets, don't reset warmup
  const prevViewModeRef = useRef(viewMode);
  useEffect(() => {
    if (prevViewModeRef.current === viewMode) return;
    prevViewModeRef.current = viewMode;
    // Recalculate target positions and radii for the new mode
    if (nodesRef.current.length > 0) {
      calculatePositions(nodesRef.current, viewMode, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode);
      topologyDirtyRef.current = true;
      wakeSimulationRef.current();
    }
  }, [viewMode, calculatePositions]);
  
  // Cache CSS variables on mount and observe theme changes
  useEffect(() => {
    const updateCssVars = () => {
      const style = getComputedStyle(document.documentElement);
      cssVarsRef.current = {
        textColor: style.getPropertyValue('--text-primary').trim() || '#333',
        accentColor: style.getPropertyValue('--color-secondary').trim() || '#6366f1',
        dimColor: style.getPropertyValue('--color-surface-variant').trim() || '#404040',
      };
    };
    updateCssVars();
    // Observe class/style changes on <html> for theme switches
    const observer = new MutationObserver(updateCssVars);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  
  // Store original input nodes for filter comparison
  const inputNodesMapRef = useRef<Map<number, GraphNode>>(new Map());
  const allLinksRef = useRef<GraphLink[]>([]);
  
  // Helper to check if a node should be visible based on filters
  const shouldNodeBeVisible = useCallback((node: GraphNode, filters: VisibilityFilters): boolean => {
    if (node.isClassNode && !filters.showClassNodes) return false;
    if (node.isDaily && !filters.showDayPages) return false;
    if (node.isMonthly && !filters.showMonthPages) return false;
    if (node.isYearly && !filters.showYearPages) return false;
    if (node.isSystemPage && !filters.showSystemPages) return false;
    return true;
  }, []);
  
  // Helper to check if a link should be active based on filters
  const shouldLinkBeActive = useCallback((link: GraphLink, filters: VisibilityFilters): boolean => {
    if (link.type === 'class' && !filters.showClassLinks) return false;
    if ((link.type === 'parent' || link.type === 'extends') && !filters.showParentLinks) return false;
    if ((link.type === 'reference' || link.type === 'property-reference') && !filters.showReferenceLinks) return false;
    return true;
  }, []);
  
  // Visibility filter changes - use destroyNode/createNode for proper physics updates
  useEffect(() => {
    const previousFilters = visibilityFiltersRef.current;
    visibilityFiltersRef.current = visibilityFilters;
    
    // Skip if no nodes yet or filters haven't actually changed
    if (nodesRef.current.length === 0 && inputNodesMapRef.current.size === 0) return;
    if (JSON.stringify(previousFilters) === JSON.stringify(visibilityFilters)) return;
    
    const currentNodeIds = new Set(nodesRef.current.map(n => n.id));
    const nodesToRemove: number[] = [];
    const nodesToAdd: GraphNode[] = [];
    
    // Check all input nodes to see what should be visible
    inputNodesMapRef.current.forEach((node, id) => {
      const shouldShow = shouldNodeBeVisible(node, visibilityFilters);
      const isCurrentlyShown = currentNodeIds.has(id);
      
      if (shouldShow && !isCurrentlyShown) {
        // Node should be shown but isn't - add it
        nodesToAdd.push({ ...node });
      } else if (!shouldShow && isCurrentlyShown) {
        // Node is shown but shouldn't be - remove it
        nodesToRemove.push(id);
      }
    });
    
    // Remove nodes that should be hidden
    nodesToRemove.forEach(nodeId => {
      const index = nodesRef.current.findIndex(n => n.id === nodeId);
      if (index !== -1) {
        nodesRef.current.splice(index, 1);
      }
    });
    
    // Update links to only include those between visible nodes and active links
    const visibleNodeIds = new Set(nodesRef.current.map(n => n.id));
    const currentFilters = visibilityFiltersRef.current;
    linksRef.current = allLinksRef.current.filter(
      link => visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target) && shouldLinkBeActive(link, currentFilters)
    );
    
    // Add nodes that should be visible
    nodesToAdd.forEach(node => {
      // Place near center with some randomness
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
    
    // Update links again after adding nodes
    const newVisibleNodeIds = new Set(nodesRef.current.map(n => n.id));
    linksRef.current = allLinksRef.current.filter(
      link => newVisibleNodeIds.has(link.source) && newVisibleNodeIds.has(link.target) && shouldLinkBeActive(link, currentFilters)
    );
    
    // Recalculate positions if in constrained mode
    if ((nodesToRemove.length > 0 || nodesToAdd.length > 0) && (viewModeRef.current === 'circle' || viewModeRef.current === 'tree')) {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode);
    }
    
    if (nodesToRemove.length > 0 || nodesToAdd.length > 0) {
      topologyDirtyRef.current = true;
      wakeSimulationRef.current();
    }
  }, [visibilityFilters, calculatePositions, shouldNodeBeVisible, shouldLinkBeActive]);

  // Recenter/fit graph
  const recenter = useCallback(() => {
    const nodes = nodesRef.current.filter(n => n.visible);
    if (nodes.length === 0) return;
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    }
    
    const padding = 60;
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

  // Dynamic node management
  const createNode = useCallback((node: GraphNode) => {
    // Check if node already exists
    const exists = nodesRef.current.find(n => n.id === node.id);
    if (exists) {
      // Update existing node to make it visible
      exists.visible = true;
      exists.x = node.x;
      exists.y = node.y;
      exists.vx = node.vx || 0;
      exists.vy = node.vy || 0;
      return;
    }
    
    // Add new node to the simulation
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
    
    // Recalculate positions if in constrained mode
    if (viewModeRef.current === 'circle' || viewModeRef.current === 'tree') {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode);
    }
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
  }, [calculatePositions]);
  
  const destroyNode = useCallback((nodeId: number) => {
    // Find and remove the node
    const index = nodesRef.current.findIndex(n => n.id === nodeId);
    if (index !== -1) {
      nodesRef.current.splice(index, 1);
    }
    
    // Remove associated links
    linksRef.current = linksRef.current.filter(
      link => link.source !== nodeId && link.target !== nodeId
    );
    
    // Recalculate positions if in constrained mode
    if (viewModeRef.current === 'circle' || viewModeRef.current === 'tree') {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode);
    }
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
  }, [calculatePositions]);
  
  const updateLinks = useCallback((links: GraphLink[]) => {
    linksRef.current = [...links];
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
  }, []);

  // Creation time animation
  const creationAnimationRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  
  const triggerCreationAnimation = useCallback(() => {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    
    // Clear any existing animation timers
    creationAnimationRef.current.forEach(timer => clearTimeout(timer));
    creationAnimationRef.current = [];
    
    const sortedNodes = [...nodes].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateA - dateB;
    });
    
    const centerX = dimensionsRef.current.width / 2;
    const centerY = dimensionsRef.current.height / 2;
    const spawnRadius = 50; // Nodes spawn within this radius of center
    
    // Remove all nodes from simulation
    nodesRef.current = [];
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
    
    const revealDelay = 80;
    sortedNodes.forEach((sortedNode, index) => {
      const timer = setTimeout(() => {
        // Dynamically create node at spawn position
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

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    recenter,
    triggerCreationAnimation,
    createNode,
    destroyNode,
    updateLinks,
  }), [recenter, triggerCreationAnimation, createNode, destroyNode, updateLinks]);

  // Initialize nodes from input
  useEffect(() => {
    if (inputNodes.length === 0) return;
    
    const { width: dimW, height: dimH } = dimensionsRef.current;
    const centerX = dimW / 2;
    const centerY = dimH / 2;
    const currentFilters = visibilityFiltersRef.current;
    
    // Store all input nodes for visibility filtering
    inputNodesMapRef.current = new Map(inputNodes.map(n => [n.id, n]));
    allLinksRef.current = [...inputLinks];
    
    // Build maps of existing and input nodes
    const existingMap = new Map(nodesRef.current.map(n => [n.id, n]));
    
    // Filter input nodes based on visibility settings
    const visibleInputNodes = inputNodes.filter(n => shouldNodeBeVisible(n, currentFilters));
    const inputMap = new Map(visibleInputNodes.map(n => [n.id, n]));
    
    // Remove nodes that are no longer in visible input
    const nodesToRemove = nodesRef.current.filter(n => !inputMap.has(n.id));
    nodesToRemove.forEach(n => destroyNode(n.id));
    
    // Add or update nodes
    visibleInputNodes.forEach(inputNode => {
      const existing = existingMap.get(inputNode.id);
      if (existing) {
        // Update existing node properties but preserve position/velocity
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
        // Create new node — spread proportional to node count to avoid overlap explosion
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
    
    // Update links to only include those between visible nodes and active links
    const visibleNodeIds = new Set(nodesRef.current.map(n => n.id));
    linksRef.current = inputLinks.filter(
      link => visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target) && shouldLinkBeActive(link, visibilityFilters)
    );
    
    calculatePositions(nodesRef.current, viewMode, dimW, dimH, settings.constraintMode);
    
    // Mark topology dirty and wake simulation
    topologyDirtyRef.current = true;
    wakeSimulationRef.current();
    
    // Reset warm-up so forces ramp up gradually with new data
    warmupFrameRef.current = 0;
    
    // Trigger initial fit-to-view after stabilization delay
    if (!initialFitDoneRef.current && nodesRef.current.length > 0) {
      const stabilizationTimer = setTimeout(() => {
        if (!initialFitDoneRef.current) {
          initialFitDoneRef.current = true;
          recenter();
        }
      }, 500); // Wait 500ms for physics to stabilize
      return () => clearTimeout(stabilizationTimer);
    }
    
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimensions accessed via dimensionsRef
  }, [inputNodes, inputLinks, viewMode, visibilityFilters, calculatePositions, createNode, destroyNode, shouldNodeBeVisible, shouldLinkBeActive, recenter]);

  // Update glare states
  useEffect(() => {
    const nodes = nodesRef.current;
    const selectedIds = selectedNodeIdsRef.current;
    const currentId = currentNodeIdRef.current;
    
    if (currentId !== null) {
      // Highlight current node mode
      nodes.forEach(n => {
        n.glare = n.id === currentId ? 'current' : 'normal';
      });
    } else if (selectedIds.length === 0) {
      nodes.forEach(n => n.glare = 'normal');
    } else if (selectedIds.length === 1) {
      // Single selection - highlight selected node, keep directly connected nodes normal, dim others
      const selectedId = selectedIds[0];
      
      // Find all nodes directly connected to the selected node
      const connectedNodeIds = new Set<number>();
      for (const link of linksRef.current) {
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
      // Multiple selection - dim all, highlight selected, show paths
      // Build node lookup map for O(1) access
      const nodeMap = new Map(nodes.map(n => [n.id, n]));
      
      nodes.forEach(n => n.glare = 'dim');
      
      for (const id of selectedIds) {
        const node = nodeMap.get(id);
        if (node) node.glare = 'bright';
      }
      
      // Path tracing between selected nodes
      for (let i = 0; i < selectedIds.length - 1; i++) {
        const path = findPathBetweenNodes(
          selectedIds[i],
          selectedIds[i + 1],
          nodes,
          linksRef.current
        );
        
        for (const nodeId of path) {
          const node = nodeMap.get(nodeId);
          if (node && node.glare !== 'bright') {
            node.glare = 'path';
          }
        }
      }
    }
  }, [selectedNodeIds, currentNodeId, viewMode]);

  // Handle container resize
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

  // ==================== Topology Cache ====================
  
  const rebuildTopologyCache = useCallback(() => {
    const nodes = nodesRef.current;
    const links = linksRef.current;
    
    // Connected pairs with priority-based link type
    const connectedPairs = new Map<number, GraphLink['type']>();
    const adjacency = new Map<number, Set<number>>();
    const childrenOf = new Map<number, number[]>();
    const connectionCounts = new Map<number, number>();
    
    // Initialize adjacency for all nodes
    for (const node of nodes) {
      adjacency.set(node.id, new Set());
    }
    
    for (const link of links) {
      // Adjacency
      adjacency.get(link.source)?.add(link.target);
      adjacency.get(link.target)?.add(link.source);
      
      // Connected pairs with priority
      const key = pairKey(link.source, link.target);
      const existing = connectedPairs.get(key);
      if (!existing || LINK_TYPE_PRIORITY[link.type] > LINK_TYPE_PRIORITY[existing]) {
        connectedPairs.set(key, link.type);
      }
      
      // Connection counts
      connectionCounts.set(link.source, (connectionCounts.get(link.source) || 0) + 1);
      connectionCounts.set(link.target, (connectionCounts.get(link.target) || 0) + 1);
      
      // Children map for mass computation
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
    
    // Compute mass cache (with cycle protection to prevent stack overflow)
    const massCache = new Map<number, number>();
    const computing = new Set<number>(); // cycle guard
    const computeMass = (nodeId: number): number => {
      if (massCache.has(nodeId)) return massCache.get(nodeId)!;
      if (computing.has(nodeId)) return 1; // cycle detected, break recursion
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
    for (const node of nodes) {
      computeMass(node.id);
    }
    
    // Update node properties from cache
    for (const node of nodes) {
      node.connectionCount = connectionCounts.get(node.id) || 0;
    }
    
    connectedPairsRef.current = connectedPairs;
    adjacencyRef.current = adjacency;
    childrenOfRef.current = childrenOf;
    massCacheRef.current = massCache;
    connectionCountsRef.current = connectionCounts;
    topologyDirtyRef.current = false;
  }, []);

  // ==================== Barnes-Hut Quadtree (pooled) ====================
  interface QuadNode {
    cx: number; cy: number; // center of mass
    mass: number;           // total mass in this cell
    x0: number; y0: number; // bounds
    x1: number; y1: number;
    c0: QuadNode | null; c1: QuadNode | null; // NW, NE (flat fields instead of array)
    c2: QuadNode | null; c3: QuadNode | null; // SW, SE
    nodeIdx: number;        // -1 if internal, otherwise index into visibleNodes
  }
  
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
    
    // Reset pool index (reuse objects from previous frame)
    quadPoolIdxRef.current = 0;
    
    // Trim pool if it grew too large (e.g., from pathological overlapping nodes)
    // A balanced quadtree for N nodes needs at most ~4N internal nodes
    const maxPoolSize = Math.max(nodes.length * 8, 1000);
    const pool = quadPoolRef.current;
    if (pool.length > maxPoolSize) {
      pool.length = maxPoolSize;
    }
    
    // Find bounds
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      if (n.x < x0) x0 = n.x;
      if (n.y < y0) y0 = n.y;
      if (n.x > x1) x1 = n.x;
      if (n.y > y1) y1 = n.y;
    }
    // Add padding to avoid degenerate quads
    const pad = Math.max(x1 - x0, y1 - y0, 100) * 0.01;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    
    const root = allocQuadNode(x0, y0, x1, y1);
    
    const insert = (tree: QuadNode, idx: number, nx: number, ny: number, nm: number) => {
      const size = tree.x1 - tree.x0;
      if (size < 0.01) return; // Prevent infinite recursion on coincident nodes
      
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

  // ==================== Simulation ====================
  const startSimulation = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctxRef.current = ctx;
    
    // Generation guard: each startSimulation increments a counter.
    // Old simulate closures detect they're stale and stop immediately.
    const thisGeneration = ++simulationGenerationRef.current;
    
    // Convergence tracking
    let sleepFrames = 0;
    let totalFrames = 0;
    const simulationStartTime = performance.now();
    const SLEEP_DELAY_FRAMES = 30; // Frames below threshold before sleeping
    
    const wake = () => {
      if (simulationGenerationRef.current !== thisGeneration) return; // stale generation
      if (simulationSleepingRef.current) {
        simulationSleepingRef.current = false;
        sleepFrames = 0;
        // Allow a burst of physics frames on wake (e.g., after drag/node change)
        const maxFrames = getMaxSimulationFrames(nodesRef.current.length);
        if (maxFrames > 0) {
          const burst = Math.min(300, Math.floor(maxFrames * 0.5));
          totalFrames = Math.min(totalFrames, maxFrames - burst);
        }
        animationRef.current = requestAnimationFrame(simulate);
      } else {
        sleepFrames = 0;
      }
    };
    wakeSimulationRef.current = wake;
    
    const simulate = () => {
      // Generation guard: if a newer simulation was started, this one dies
      if (simulationGenerationRef.current !== thisGeneration) return;
      
      totalFrames++;
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const currentSettings = settingsRef.current;
      const currentViewMode = viewModeRef.current;
      const isConstrainedMode = currentViewMode === 'circle' || currentViewMode === 'tree';
      
      // Rebuild topology cache if dirty
      if (topologyDirtyRef.current) {
        rebuildTopologyCache();
      }
      
      const connectedPairs = connectedPairsRef.current;
      const adjacency = adjacencyRef.current;
      const massCache = massCacheRef.current;
      const useMass = currentSettings.massAccumulation;
      
      // Update mass on nodes for rendering
      let maxConnections = 0, maxMass = 0;
      for (const node of nodes) {
        const mass = useMass ? (massCache.get(node.id) ?? 1) : 1;
        (node as GraphNode & { _mass?: number })._mass = mass;
        if (node.connectionCount > maxConnections) maxConnections = node.connectionCount;
        if (mass > maxMass) maxMass = mass;
      }
      
      // Build nodeMap for drag pull and shared frame data (reuse map to avoid GC)
      const nodeMap = frameNodeMapRef.current;
      nodeMap.clear();
      for (const node of nodes) {
        nodeMap.set(node.id, node);
      }
      
      // Determine if physics forces should be applied
      const usePhysics = !isConstrainedMode || currentSettings.constraintMode === 'physics';
      
      // Warm-up: ramp force strength from 0 to 1 over WARMUP_DURATION_FRAMES
      const warmupT = Math.min(1, warmupFrameRef.current / WARMUP_DURATION_FRAMES);
      const warmupMultiplier = warmupT * warmupT; // ease-in curve
      warmupFrameRef.current++;
      
      // Constrained modes: apply return-to-target force
      // In equidistant mode this is the primary positioning force
      // In physics mode only a very gentle hint — N-body forces handle clustering
      if (isConstrainedMode) {
        const returnStrength = currentSettings.constraintMode === 'equidistant' ? RETURN_FORCE : RETURN_FORCE * 0.05;
        for (const node of nodes) {
          if (dragNodeRef.current?.id === node.id || node.pinned) continue;
          
          const dx = node.targetX - node.x;
          const dy = node.targetY - node.y;
          
          // Unconnected nodes get stronger return force in physics mode
          // (they have no attraction links to pull them into place)
          const connCount = node.connectionCount;
          const multiplier = (currentSettings.constraintMode === 'physics' && connCount === 0) ? 10 : 1;
          
          node.vx += dx * returnStrength * multiplier;
          node.vy += dy * returnStrength * multiplier;
        }
      }
      
      // Centering gravity — only on initial graph load, never again
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
      
      // Node-to-node forces: attraction (linked) and repulsion (unlinked)
      if (usePhysics) {
        // === Barnes-Hut repulsion (O(n log n)) ===
        const THETA = 0.7; // Barnes-Hut opening angle threshold
        
        // Build normalized mass map: use log-normalized mass everywhere to keep
        // the quadtree, repulsion division, and linked-pair compensation consistent.
        // Using raw mass in the quadtree but normalized mass in division caused
        // over-compensation for class nodes (Barnes-Hut approximation error × raw mass).
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
            
            // Use pre-computed normalized mass for force division
            const nodeMass = useMass ? (normalizedMasses.get(node.id) ?? 1) : 1;
            
            // Walk quadtree for repulsion (reuse pre-allocated stack)
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
              
              // Skip self
              if (cell.nodeIdx === i) continue;
              
              const cellSize = cell.x1 - cell.x0;
              
              // If leaf or cell is far enough away, treat as single body
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
                // Open the cell — push children (grow stack if needed)
                if (stackTop + 4 > stack.length) stack.length = stack.length * 2;
                if (cell.c0) stack[stackTop++] = cell.c0;
                if (cell.c1) stack[stackTop++] = cell.c1;
                if (cell.c2) stack[stackTop++] = cell.c2;
                if (cell.c3) stack[stackTop++] = cell.c3;
              }
            }
          }
        }
        
        // === Link attraction (iterate links directly, not O(n²)) ===
        // Also counteract the quadtree repulsion between linked pairs
        for (const link of links) {
          const nodeA = nodeMap.get(link.source);
          const nodeB = nodeMap.get(link.target);
          if (!nodeA || !nodeB) continue;
          if (dragNodeRef.current?.id === nodeA.id || dragNodeRef.current?.id === nodeB.id) continue;
          if (nodeA.pinned && nodeB.pinned) continue;
          
          // Only process highest-priority link for each pair
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
          
          // Reference links have reduced force
          if (link.type === 'property-reference') {
            attractionStrength *= REFERENCE_LINK_FORCE_MULTIPLIER;
          } else if (link.type === 'reference') {
            attractionStrength *= REFERENCE_LINK_FORCE_MULTIPLIER * REFERENCE_LINK_FORCE_MULTIPLIER;
          }
          
          // Spring attraction + dashpot (symmetric, applied to both nodes)
          let netForce = (dist - LINKED_ATTRACTION_DISTANCE) * attractionStrength * warmupMultiplier;
          
          // Use pre-computed normalized mass (matches what the quadtree uses)
          const massA = useMass ? (normalizedMasses.get(nodeA.id) ?? 1) : 1;
          const massB = useMass ? (normalizedMasses.get(nodeB.id) ?? 1) : 1;
          
          // Dashpot: damp relative velocity along spring axis to prevent radial oscillation
          const rvx = nodeB.vx - nodeA.vx;
          const rvy = nodeB.vy - nodeA.vy;
          const relVelAlongSpring = (rvx * dx + rvy * dy) / dist;
          netForce += relVelAlongSpring * LINK_DAMPING;
          
          const sfx = (dx / dist) * netForce;
          const sfy = (dy / dist) * netForce;
          
          // Counteract quadtree repulsion for linked pairs (per-node, asymmetric).
          // Both the quadtree and force division use normalized mass, so compensation
          // uses the same normalized values — no mismatch that could cause over-compensation.
          let compAx = 0, compAy = 0, compBx = 0, compBy = 0;
          if (dist < UNLINKED_REPULSION_DISTANCE) {
            const clampedDist = Math.max(dist, MIN_REPULSION_DISTANCE);
            const clampedDistSq = clampedDist * clampedDist;
            const dirX = dx / dist;
            const dirY = dy / dist;
            // Compensation for A: quadtree pushed A away from B with force ∝ massB / massA
            const compA = (REPULSION_STRENGTH * massB / clampedDistSq) * warmupMultiplier;
            compAx = dirX * compA / massA;
            compAy = dirY * compA / massA;
            // Compensation for B: quadtree pushed B away from A with force ∝ massA / massB
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
      
      // Tangential overlap prevention for constrained modes (tree/circle).
      // In these modes, radial velocity is stripped so only tangential forces
      // can separate overlapping nodes on the same ring. This runs in both
      // physics and equidistant modes.
      if (isConstrainedMode) {
        const cx = dimensionsRef.current.width / 2;
        const cy = dimensionsRef.current.height / 2;
        const TANGENTIAL_REPULSION = 300; // Strength of tangential push
        const TANGENTIAL_RANGE = 60; // Distance within which nodes repel tangentially
        const TANGENTIAL_MIN_DIST = 5; // Floor to prevent singularity
        
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          if (dragNodeRef.current?.id === a.id || a.pinned) continue;
          const aRadius = (a as GraphNode & { _treeRadius?: number })._treeRadius;
          if (aRadius === undefined) continue;
          
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            if (dragNodeRef.current?.id === b.id || b.pinned) continue;
            const bRadius = (b as GraphNode & { _treeRadius?: number })._treeRadius;
            if (bRadius === undefined) continue;
            
            // Only repel nodes on the same or nearby rings
            if (Math.abs(aRadius - bRadius) > TANGENTIAL_RANGE) continue;
            
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            if (dist >= TANGENTIAL_RANGE) continue;
            
            // Compute tangential direction (perpendicular to radial from center)
            // For each node, the tangential direction relative to center
            const dax = a.x - cx;
            const day = a.y - cy;
            const daDist = Math.sqrt(dax * dax + day * day) || 1;
            
            // Use the displacement direction projected onto tangent
            const radialX = dax / daDist;
            const radialY = day / daDist;
            
            // Project the displacement onto tangential plane
            const radialComponent = dx * radialX + dy * radialY;
            let tangX = dx - radialComponent * radialX;
            let tangY = dy - radialComponent * radialY;
            const tangDist = Math.sqrt(tangX * tangX + tangY * tangY);
            
            if (tangDist < 0.01) {
              // Nodes are radially aligned — pick arbitrary tangential direction
              tangX = -radialY;
              tangY = radialX;
            } else {
              tangX /= tangDist;
              tangY /= tangDist;
            }
            
            const clampedDist = Math.max(dist, TANGENTIAL_MIN_DIST);
            const force = (TANGENTIAL_REPULSION / (clampedDist * clampedDist)) * warmupMultiplier;
            
            if (!a.pinned) {
              a.vx -= tangX * force;
              a.vy -= tangY * force;
            }
            if (!b.pinned) {
              b.vx += tangX * force;
              b.vy += tangY * force;
            }
          }
        }
      }
      
      // Dragged node pulls connected visible nodes
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
              const mass = rawM <= 1 ? 1 : 1 + Math.log(rawM);              const linkType = connectedPairs.get(pairKey(dragNode.id, connectedId)) ?? null;
              let dragMultiplier = 1;
              if (linkType === 'property-reference') {
                dragMultiplier = REFERENCE_LINK_FORCE_MULTIPLIER;
              } else if (linkType === 'reference') {
                dragMultiplier = REFERENCE_LINK_FORCE_MULTIPLIER * REFERENCE_LINK_FORCE_MULTIPLIER;
              }
              connectedNode.vx += (dx / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE) * dragMultiplier / mass;
              connectedNode.vy += (dy / dist) * DRAG_PULL_STRENGTH * (dist - LINKED_ATTRACTION_DISTANCE) * dragMultiplier / mass;
            }
          }
        }
        
        // Update drag lift animation progress
        if (dragStartTimeRef.current !== null) {
          const elapsed = Date.now() - dragStartTimeRef.current;
          dragLiftProgressRef.current = Math.min(1, elapsed / 150);
        }
      } else {
        if (dragLiftProgressRef.current > 0) {
          dragLiftProgressRef.current = Math.max(0, dragLiftProgressRef.current - 0.1);
        }
      }
      
      // === Collision force ===
      // Strong short-range repulsion when nodes overlap within their visual radii.
      // Applied as a velocity impulse (force) so it integrates naturally with
      // the existing damping/deadzone system and reaches smooth equilibrium.
      // Linear in overlap so force is zero at the collision boundary (no discontinuity).
      const COLLISION_PADDING = 1.8; // Multiplier on visual radius for collision zone
      const COLLISION_STRENGTH = 0.8; // Velocity impulse per pixel of overlap per frame
      const currentNodeSizeMode = currentSettings.nodeSizeMode;
      
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (!a.visible) continue;
        const aImmovable = dragNodeRef.current?.id === a.id || a.pinned;
        const radiusA = getNodeRadius(a, currentNodeSizeMode, maxConnections, maxMass) * COLLISION_PADDING;
        
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (!b.visible) continue;
          const bImmovable = dragNodeRef.current?.id === b.id || b.pinned;
          if (aImmovable && bImmovable) continue;
          
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distSq = dx * dx + dy * dy;
          const radiusB = getNodeRadius(b, currentNodeSizeMode, maxConnections, maxMass) * COLLISION_PADDING;
          const minDist = radiusA + radiusB;
          
          // Quick squared-distance check to skip most pairs
          if (distSq >= minDist * minDist) continue;
          
          const dist = Math.sqrt(distSq) || 0.1;
          const overlap = minDist - dist;
          
          // Direction from a to b
          const nx = dx / dist;
          const ny = dy / dist;
          
          // Linear impulse proportional to overlap (zero at boundary, max at center)
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
      
      // Update positions and track kinetic energy for convergence sleep
      let kineticEnergy = 0;
      for (const node of nodes) {
        if (dragNodeRef.current?.id !== node.id && !node.pinned) {
          const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
          if (speed > MAX_VELOCITY) {
            const scale = MAX_VELOCITY / speed;
            node.vx *= scale;
            node.vy *= scale;
          }
          node.x += node.vx;
          node.y += node.vy;
          node.vx *= VELOCITY_DAMPING;
          node.vy *= VELOCITY_DAMPING;
          
          // Kill tiny velocities to prevent jitter near equilibrium
          if (Math.abs(node.vx) < VELOCITY_DEADZONE) node.vx = 0;
          if (Math.abs(node.vy) < VELOCITY_DEADZONE) node.vy = 0;
          
          kineticEnergy += node.vx * node.vx + node.vy * node.vy;
          
          // Radial constraint: keep nodes on their assigned circle in constrained modes
          if (isConstrainedMode) {
            const treeRadius = (node as GraphNode & { _treeRadius?: number })._treeRadius;
            if (treeRadius !== undefined) {
              const cx = dimensionsRef.current.width / 2;
              const cy = dimensionsRef.current.height / 2;
              const dx = node.x - cx;
              const dy = node.y - cy;
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const radialX = dx / dist;
              const radialY = dy / dist;
              const radiusError = Math.abs(dist - treeRadius);
              
              // Strip radial velocity first — prevents radial drift
              const radialV = node.vx * radialX + node.vy * radialY;
              node.vx -= radialV * radialX;
              node.vy -= radialV * radialY;
              
              // Correct position: smooth lerp when far, hard snap when close
              const blendRate = radiusError > 50 ? 0.08 : radiusError > 10 ? 0.5 : 1.0;
              const newDist = dist + (treeRadius - dist) * blendRate;
              node.x = cx + radialX * newDist;
              node.y = cy + radialY * newDist;
            }
          }
        }
      }
      
      // Render skip: for large graphs, only draw every Nth frame to reduce GPU/memory pressure
      // Physics still runs every frame but canvas drawing AND its data prep are the expensive parts
      const renderSkip = getRenderSkip(nodes.length);
      const isDragging = !!dragNodeRef.current;
      // Always render when dragging or on the render-skip interval
      if (isDragging || totalFrames % renderSkip === 0) {
        // Share computed data with render via ref (reuse array to avoid GC)
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
        
        renderRef.current?.(ctx);
      }
      
      // Release stale quadtree references from bhStack to reduce GC pressure
      const bhStack = bhStackRef.current;
      for (let i = 0, len = bhStack.length; i < len; i++) {
        bhStack[i] = null;
      }
      
      // Null out unused quadtree pool child pointers (prevent stale cross-references)
      const pool = quadPoolRef.current;
      const usedPoolSize = quadPoolIdxRef.current;
      for (let i = usedPoolSize, len = pool.length; i < len; i++) {
        pool[i].c0 = pool[i].c1 = pool[i].c2 = pool[i].c3 = null;
      }
      
      // Convergence-based sleep: threshold scales with node count so large graphs can converge
      const sleepThreshold = Math.max(0.1, nodes.length * SLEEP_KE_PER_NODE);
      const shouldSleep = kineticEnergy < sleepThreshold && warmupT >= 1 && !dragNodeRef.current;
      
      // Hard cap: force sleep after adaptive frame limit OR wall-clock time limit.
      // A value of 0 means unlimited (rely on convergence-based sleep instead).
      const maxFrames = getMaxSimulationFrames(nodes.length);
      const forceStop = (maxFrames > 0 && totalFrames >= maxFrames) ||
        (MAX_SIMULATION_TIME_MS > 0 && (performance.now() - simulationStartTime) > MAX_SIMULATION_TIME_MS);
      
      if (shouldSleep || forceStop) {
        sleepFrames++;
        if (sleepFrames >= SLEEP_DELAY_FRAMES || forceStop) {
          if (forceStop) {
            const elapsed = (performance.now() - simulationStartTime).toFixed(0);
            console.log(`[Graph] Simulation force-stopped: ${totalFrames} frames, ${elapsed}ms, ${nodes.length} nodes`);
          }
          simulationSleepingRef.current = true;
          // Prep frame data for final render (may have been skipped by renderSkip)
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
          // Final render to show converged state
          renderRef.current?.(ctx);
          return; // Don't schedule next frame
        }
      } else {
        sleepFrames = 0;
      }
      
      animationRef.current = requestAnimationFrame(simulate);
    };
    
    simulate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dimensions accessed via dimensionsRef
  }, [rebuildTopologyCache, shouldLinkBeActive]);

  // Start simulation once on mount
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

  // Render function
  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: w, height: h } = dimensionsRef.current;
    const t = transformRef.current;
    const currentSettings = settingsRef.current;
    const currentClassColors = classColorsRef.current;
    const currentViewMode = viewModeRef.current;
    
    ctx.clearRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);
    
    // Use cached CSS variables (updated on mount and theme change)
    const { textColor, accentColor, dimColor } = cssVarsRef.current;
    
    // Use shared frame data from simulate (avoids re-filtering)
    const { visibleNodes, visibleLinks, nodeMap, maxConnections, maxMass } = frameDataRef.current;
    
    // Build link direction map using numeric keys (reuse map to avoid GC)
    // Bitfield: 1 = forward (source < target), 2 = reverse (source > target)
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
    
    // Draw links (deduped - draw each pair only once, using numeric Set)
    const drawnLinks = drawnLinksCacheRef.current;
    drawnLinks.clear();
    
    for (const link of visibleLinks) {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (!source || !target) continue;
      
      // Skip if we've already drawn this link pair (numeric key avoids string alloc)
      const linkKey = pairKey(link.source, link.target) * 10 + linkTypeId(link.type);
      if (drawnLinks.has(linkKey)) continue;
      drawnLinks.add(linkKey);
      
      const isParentLink = link.type === 'parent';
      const isClassLink = link.type === 'class';
      const isExtendsLink = link.type === 'extends';
      const dirBits = linkDirections.get(pairKey(link.source, link.target)) || 0;
      const hasFwd = !!(dirBits & 1);
      const hasRev = !!(dirBits & 2);
      
      // Treat parent and extends links the same for rendering (solid line, hollow dot)
      const renderAsParent = isParentLink || isExtendsLink;
      
      ctx.beginPath();
      // Use gray color for all link types
      ctx.strokeStyle = 'rgba(100, 100, 100, 0.4)';
      ctx.lineWidth = 1.5;
      
      // Set line style: solid for parent/extends, dotted for reference
      // Class links will be drawn as wavy lines manually
      if (renderAsParent || isClassLink) {
        ctx.setLineDash(LINE_DASH_NONE);
      } else {
        ctx.setLineDash(LINE_DASH_DOTTED); // Dotted for reference links
      }
      
      // Calculate glare radius to determine line endpoints
      // Dot is positioned at glareRadius + 2, so line should end at glareRadius + 2 + dotSize to avoid overlap
      const arrowGap = 2;
      
      const sourceLineGlare = getGlareRadius(source, currentSettings.nodeSizeMode, maxConnections, maxMass);
      const targetLineGlare = getGlareRadius(target, currentSettings.nodeSizeMode, maxConnections, maxMass);
      
      // Determine if there are dots at each end
      const dotSize = 4;
      const hasTargetDot = !renderAsParent && link.source === source.id;
      const hasSourceDot = renderAsParent || (!renderAsParent && hasFwd && hasRev);
      
      // Calculate line endpoints to stop where dots start (avoid transparency overlap)
      const lineAngle = Math.atan2(target.y - source.y, target.x - source.x);
      const targetOffset = hasTargetDot ? (arrowGap + dotSize) : arrowGap;
      const sourceOffset = hasSourceDot ? (arrowGap + dotSize) : arrowGap;
      const lineStartX = source.x + (sourceLineGlare + sourceOffset) * Math.cos(lineAngle);
      const lineStartY = source.y + (sourceLineGlare + sourceOffset) * Math.sin(lineAngle);
      const lineEndX = target.x - (targetLineGlare + targetOffset) * Math.cos(lineAngle);
      const lineEndY = target.y - (targetLineGlare + targetOffset) * Math.sin(lineAngle);
      
      // Draw line - wavy for class links, straight for others
      if (isClassLink) {
        // Draw wavy line for class links
        const dx = lineEndX - lineStartX;
        const dy = lineEndY - lineStartY;
        const lineLength = Math.sqrt(dx * dx + dy * dy);
        const waveFrequency = 0.3; // Waves per pixel
        const waveAmplitude = 3; // Height of wave
        const segments = Math.max(Math.floor(lineLength / 2), 10);
        
        ctx.beginPath();
        ctx.moveTo(lineStartX, lineStartY);
        
        for (let i = 1; i < segments; i++) {
          const t = i / segments;
          const baseX = lineStartX + dx * t;
          const baseY = lineStartY + dy * t;
          
          // Calculate perpendicular offset for wave
          const waveOffset = Math.sin(t * lineLength * waveFrequency) * waveAmplitude;
          const perpAngle = lineAngle + Math.PI / 2;
          const x = baseX + waveOffset * Math.cos(perpAngle);
          const y = baseY + waveOffset * Math.sin(perpAngle);
          
          ctx.lineTo(x, y);
        }
        // End exactly at the calculated endpoint (where the dot will be)
        ctx.lineTo(lineEndX, lineEndY);
        ctx.stroke();
      } else {
        // Draw straight line for parent, extends, and reference links
        ctx.moveTo(lineStartX, lineStartY);
        ctx.lineTo(lineEndX, lineEndY);
        ctx.stroke();
      }
      
      // Draw arrows — reuse glare radii computed above (sourceLineGlare / targetLineGlare)
      
      // Draw arrow dots inline (avoid per-link closure allocations)
      // System type UUIDs that should skip dots
      const skipTargetDot = target.uuid === '00000000-0000-0000-0001-000000000001' || target.uuid === '00000000-0000-0000-0001-000000000002';
      const skipSourceDot = source.uuid === '00000000-0000-0000-0001-000000000001' || source.uuid === '00000000-0000-0000-0001-000000000002';
      
      if (renderAsParent) {
        // Parent/extends links: hollow circle at source (parent)
        if (!skipSourceDot) {
          const revAngle = lineAngle + Math.PI;
          const cx = source.x - (sourceLineGlare + 2 + dotSize / 2) * Math.cos(revAngle);
          const cy = source.y - (sourceLineGlare + 2 + dotSize / 2) * Math.sin(revAngle);
          ctx.beginPath();
          ctx.arc(cx, cy, dotSize / 2, 0, 2 * Math.PI);
          ctx.strokeStyle = 'rgba(100, 100, 100, 0.8)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash(LINE_DASH_NONE);
          ctx.stroke();
        }
      } else {
        // Reference links: solid circle at target
        if (link.source === source.id && !skipTargetDot) {
          const cx = target.x - (targetLineGlare + 2 + dotSize / 2) * Math.cos(lineAngle);
          const cy = target.y - (targetLineGlare + 2 + dotSize / 2) * Math.sin(lineAngle);
          ctx.beginPath();
          ctx.arc(cx, cy, dotSize / 2, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(100, 100, 100, 0.8)';
          ctx.fill();
        }
        
        // Bidirectional: solid circle at source (angle is reversed: target→source)
        if (hasFwd && hasRev && !skipSourceDot) {
          const revAngle = lineAngle + Math.PI;
          const cx = source.x - (sourceLineGlare + 2 + dotSize / 2) * Math.cos(revAngle);
          const cy = source.y - (sourceLineGlare + 2 + dotSize / 2) * Math.sin(revAngle);
          ctx.beginPath();
          ctx.arc(cx, cy, dotSize / 2, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(100, 100, 100, 0.8)';
          ctx.fill();
        }
      }
    }
    
    ctx.setLineDash(LINE_DASH_NONE);
    
    // Draw level circle guides in constrained modes (tree and circle)
    if (currentViewMode === 'tree' || currentViewMode === 'circle') {
      const centerX = dimensionsRef.current.width / 2;
      const centerY = dimensionsRef.current.height / 2;
      
      // Collect unique radii from nodes' assigned tree radii
      const radiiWithNodes = new Set<number>();
      for (const node of visibleNodes) {
        const treeRadius = (node as GraphNode & { _treeRadius?: number })._treeRadius;
        if (treeRadius !== undefined && treeRadius > 0) {
          radiiWithNodes.add(treeRadius);
        }
      }
      
      ctx.strokeStyle = 'rgba(100, 100, 100, 0.1)';
      ctx.lineWidth = 1;
      ctx.setLineDash(LINE_DASH_NONE);
      
      for (const radius of radiiWithNodes) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
    
    // Get dragged node info for shadow rendering
    const draggedNodeId = dragNodeRef.current?.id ?? null;
    const liftProgress = dragLiftProgressRef.current;
    const currentHoveredNode = hoveredNodeRef.current;
    
    // Draw nodes — two passes: non-dragged first, then dragged node on top (avoids array copy+sort)
    let draggedNode: GraphNode | null = null;
    for (const node of visibleNodes) {
      if (node.id === draggedNodeId) { draggedNode = node; continue; }
      const isHovered = currentHoveredNode?.id === node.id;
      const isDragging = node.id === draggedNodeId;
      const baseRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass);
      const circleRadius = isHovered ? baseRadius + NODE_HOVER_RADIUS_EXTRA : baseRadius;
      const nodeColor = getNodeColor(node, currentClassColors, accentColor);
      
      // Draw shadow for dragged node
      if (isDragging && liftProgress > 0) {
        const shadowOffset = 4 * liftProgress;
        const shadowBlur = 12 * liftProgress;
        const shadowOpacity = 0.3 * liftProgress;
        
        ctx.save();
        ctx.shadowColor = `rgba(0, 0, 0, ${shadowOpacity})`;
        ctx.shadowBlur = shadowBlur;
        ctx.shadowOffsetX = shadowOffset;
        ctx.shadowOffsetY = shadowOffset;
        
        // Draw shadow circle
        ctx.beginPath();
        ctx.fillStyle = nodeColor;
        ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.restore();
      }
      
      // Glare properties - scaled relative to node radius
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
      
      // Draw glare
      ctx.beginPath();
      const glareColor = node.glare === 'current' 
        ? `rgba(255, 215, 0, ${glareOpacity})`
        : hexToRgba(nodeColor, glareOpacity);
      ctx.fillStyle = glareColor;
      ctx.arc(node.x, node.y, glareRadius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Draw node circle
      let displayColor = nodeColor;
      if (node.glare === 'dim') {
        displayColor = dimColor;
      }
      
      ctx.beginPath();
      ctx.fillStyle = displayColor;
      ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Draw pin indicator (inner circle with shadow)
      if (node.pinned) {
        const pinRadius = circleRadius * 0.3; // 30% of node radius
        const pinColor = textColor; // Use theme text color (adapts to light/dark)
        
        // Draw shadow for the pin
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 3;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        
        ctx.beginPath();
        ctx.fillStyle = pinColor;
        ctx.arc(node.x, node.y, pinRadius, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.restore();
      }
      
      // Draw label
      const currentScale = transformRef.current.scale;
      const zoomOpacity = currentScale <= LABEL_FADE_ZOOM_MIN 
        ? 0 
        : currentScale >= LABEL_FADE_ZOOM_MAX 
          ? 1 
          : (currentScale - LABEL_FADE_ZOOM_MIN) / (LABEL_FADE_ZOOM_MAX - LABEL_FADE_ZOOM_MIN);
      const dimOpacity = node.glare === 'dim' ? 0.4 : 1;
      const labelOpacity = zoomOpacity * dimOpacity;
      
      ctx.fillStyle = textColor;
      ctx.globalAlpha = labelOpacity;
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      
      // Display just the node name
      const displayName = node.name.length > 35 
        ? node.name.slice(0, 35) + '...' 
        : node.name;
      ctx.fillText(displayName, node.x, node.y + baseRadius + 10);
      ctx.globalAlpha = 1;
    }
    
    // Second pass: draw dragged node on top
    if (draggedNode) {
      const node = draggedNode;
      const isHovered = currentHoveredNode?.id === node.id;
      const baseRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass);
      const circleRadius = isHovered ? baseRadius + NODE_HOVER_RADIUS_EXTRA : baseRadius;
      const nodeColor = getNodeColor(node, currentClassColors, accentColor);
      
      if (liftProgress > 0) {
        const shadowOffset = 4 * liftProgress;
        const shadowBlur = 12 * liftProgress;
        const shadowOpacity = 0.3 * liftProgress;
        ctx.save();
        ctx.shadowColor = `rgba(0, 0, 0, ${shadowOpacity})`;
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
        ? `rgba(255, 215, 0, ${glareOpacity})`
        : hexToRgba(nodeColor, glareOpacity);
      ctx.arc(node.x, node.y, glareRadius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = node.glare === 'dim' ? dimColor : nodeColor;
      ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
      ctx.fill();
      if (node.pinned) {
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'; ctx.shadowBlur = 3; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1;
        ctx.beginPath(); ctx.fillStyle = textColor;
        ctx.arc(node.x, node.y, circleRadius * 0.3, 0, 2 * Math.PI); ctx.fill();
        ctx.restore();
      }
      const currentScale = transformRef.current.scale;
      const zoomOpacity = currentScale <= LABEL_FADE_ZOOM_MIN ? 0 : currentScale >= LABEL_FADE_ZOOM_MAX ? 1 : (currentScale - LABEL_FADE_ZOOM_MIN) / (LABEL_FADE_ZOOM_MAX - LABEL_FADE_ZOOM_MIN);
      const dimOp = node.glare === 'dim' ? 0.4 : 1;
      ctx.fillStyle = textColor; ctx.globalAlpha = zoomOpacity * dimOp;
      ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const displayName = node.name.length > 35 ? node.name.slice(0, 35) + '...' : node.name;
      ctx.fillText(displayName, node.x, node.y + baseRadius + 10);
      ctx.globalAlpha = 1;
    }
    
    ctx.restore();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dimensions accessed via dimensionsRef
  }, []);

  // Keep renderRef in sync
  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  // Coordinate conversion
  const screenToWorld = useCallback((screenX: number, screenY: number) => {
    const t = transformRef.current;
    return {
      x: (screenX - t.x) / t.scale,
      y: (screenY - t.y) / t.scale
    };
  }, []);

  // Get node at position
  const getNodeAtPosition = useCallback((screenX: number, screenY: number): GraphNode | null => {
    const { x, y } = screenToWorld(screenX, screenY);
    const t = transformRef.current;
    const currentSettings = settingsRef.current;
    
    let maxConnections = 0, maxMass = 0;
    for (const node of nodesRef.current) {
      maxConnections = Math.max(maxConnections, node.connectionCount);
      maxMass = Math.max(maxMass, (node as GraphNode & { _mass?: number })._mass ?? 1);
    }
    
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      if (!node.visible) continue;
      
      const nodeRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass);
      const hitRadius = (nodeRadius + NODE_HOVER_RADIUS_EXTRA + 4) / t.scale;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        return node;
      }
    }
    return null;
  }, [screenToWorld]);

  // Get canvas coordinates
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

  // Mouse handlers
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    
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
    } else if (dragNodeRef.current) {
      const { x, y } = screenToWorld(screenX, screenY);
      const dx = x - dragNodeRef.current.x;
      const dy = y - dragNodeRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        didDragMoveRef.current = true;
      }
      dragNodeRef.current.x = x;
      dragNodeRef.current.y = y;
      // In constrained modes, constrain dragged node to its circle
      if (viewModeRef.current === 'tree' || viewModeRef.current === 'circle') {
        const treeRadius = (dragNodeRef.current as GraphNode & { _treeRadius?: number })._treeRadius;
        if (treeRadius !== undefined) {
          const cx = dimensionsRef.current.width / 2;
          const cy = dimensionsRef.current.height / 2;
          const ddx = dragNodeRef.current.x - cx;
          const ddy = dragNodeRef.current.y - cy;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
          dragNodeRef.current.x = cx + (ddx / dist) * treeRadius;
          dragNodeRef.current.y = cy + (ddy / dist) * treeRadius;
        }
      }
      dragNodeRef.current.vx = 0;
      dragNodeRef.current.vy = 0;
      wakeSimulationRef.current();
    } else {
      const node = getNodeAtPosition(screenX, screenY);
      // Only update state if hovered node actually changed (avoid unnecessary re-renders)
      if (node !== hoveredNodeRef.current) {
        hoveredNodeRef.current = node;
        setHoveredNode(node);
        onHoveredNodeChange?.(node);
      }
    }
  }, [getCanvasCoordinates, getNodeAtPosition, screenToWorld, onHoveredNodeChange, setTransformDirect]);

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
  }, [getCanvasCoordinates, getNodeAtPosition]);

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
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (wasJustDraggingRef.current) return;
    
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    const node = getNodeAtPosition(screenX, screenY);
    const now = Date.now();
    
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

  // Wheel handler — must use native listener with {passive:false} to allow preventDefault.
  // React registers wheel as passive by default, which blocks preventDefault.
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
  
  // Attach native wheel listener with {passive: false}
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => handleWheelRef.current(e);
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, []);

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

export default NodeGraphRenderer;
