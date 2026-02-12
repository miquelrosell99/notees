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
import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { NodeInline } from '@/components/blocks/NodeInline';
import type { 
  GraphNode, 
  GraphLink, 
  ClassColor, 
  GraphSettings, 
  VisibilityFilters,
  GlareState,
  NodeSizeMode,
  ConstraintMode,
  LinkDirection,
  QuadNode,
  FrameData,
} from './viewTypes';
import { DEFAULT_VISIBILITY_FILTERS } from './viewTypes';
import { 
  hexToRgba,
  getNodeRadius,
  getNodeColor,
  getGlareRadius,
  linkTypeId,
  pairKey,
  findPathBetweenNodes,
  NODE_RADIUS_BASE,
  NODE_RADIUS_MIN,
  NODE_RADIUS_MAX,
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
  LINK_TYPE_PRIORITY,
} from './viewHelpers';
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
const VELOCITY_DEADZONE = 0.01; // Zero out velocity below this to prevent jitter near equilibrium
const LINK_DAMPING = 0.4; // Dashpot: damp relative velocity along spring axis to prevent oscillation

// Terrain mode: aggressive damping so nodes freeze sooner
const TERRAIN_VELOCITY_DAMPING = 0.4; // Much more aggressive than normal 0.7
const TERRAIN_VELOCITY_DEADZONE = 0.05; // Larger deadzone to freeze sooner

// Terrain footprint collision avoidance (prevents nodes inside other nodes' cones)
const TERRAIN_BASE_FOOTPRINT = 50;    // Base terrain radius for collision
const TERRAIN_PEAK_FOOTPRINT = 100;   // Additional radius per unit peak size
const TERRAIN_SEPARATION_STRENGTH = 0.12; // How strongly to push nodes apart
const TERRAIN_MIN_SEPARATION = 30;    // Minimum distance between node centers

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

// ==================== Types ====================

export type GraphViewMode = 'normal' | 'circle' | 'tree' | 'terrain';

// Re-export shared types for consumers
export type { GraphNode, GraphLink, ClassColor, GraphSettings, VisibilityFilters, GlareState, NodeSizeMode, ConstraintMode, LinkDirection };

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

// ==================== Component ====================

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
  const lastClickedLinkRef = useRef<{ source: number; target: number } | null>(null);
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
  const inLinkCountsRef = useRef(new Map<number, number>());
  const outLinkCountsRef = useRef(new Map<number, number>());
  
  // Shared data between simulate and render (written by simulate, read by render)
  const frameDataRef = useRef<{
    visibleNodes: GraphNode[];
    visibleLinks: GraphLink[];
    nodeMap: Map<number, GraphNode>;
    maxConnections: number;
    maxMass: number;
    terrainHeights: Map<number, number>; // nodeId → normalized height [0,1]
    terrainPeakRadii: Map<number, number>; // nodeId → normalized peak radius [0,1]
  }>({ visibleNodes: [], visibleLinks: [], nodeMap: new Map(), maxConnections: 0, maxMass: 0, terrainHeights: new Map(), terrainPeakRadii: new Map() });
  
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
  
  // Terrain mode: node positions for DOM overlay (updated each frame)
  const [terrainNodePositions, setTerrainNodePositions] = useState<Map<number, { x: number; y: number; height: number }>>(new Map());
  const terrainUpdateRafRef = useRef<number>(0);
  
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
    constraintMode: ConstraintMode = 'physics',
    nodeSizeMode: NodeSizeMode = 'uniform'
  ) => {
    const centerX = w / 2;
    const centerY = h / 2;
    
    // Compute max connections and max mass for radius calculations
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
    // Fallback to base glare if no nodes
    if (maxGlareRadius === 0) maxGlareRadius = NODE_RADIUS_BASE * GLARE_SCALE_NORMAL;
    
    // Dynamic spacing based on actual node sizes
    const nodeSpacing = maxGlareRadius * 2 + 8; // Diameter of largest glare + padding
    const levelGap = maxGlareRadius * 2 + 40; // Ring gap: largest glare diameter + comfortable gap
    
    if (mode === 'circle') {
      // Position all nodes in a circle
      // Scale radius up if needed to prevent node overlap
      const preferredRadius = Math.min(centerX, centerY) * 0.8;
      const minNodeSpacing = nodeSpacing; // Uses glare-aware spacing computed above
      const minRadiusForCount = (nodes.length * minNodeSpacing) / (2 * Math.PI);
      const radius = Math.max(preferredRadius, minRadiusForCount);
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
      
      // Build set of visible node IDs for parent lookup
      const visibleNodeIds = new Set(nodes.map(n => n.id));
      
      // Find root nodes - special handling for classes
      // A node is a root if it has no parent OR its parent isn't in the visible set
      const classRoots = nodes.filter(n => n.isClassNode && (n.parentId === null || !visibleNodeIds.has(n.parentId)));
      const regularRoots = nodes.filter(n => !n.isClassNode && (n.parentId === null || !visibleNodeIds.has(n.parentId)));
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
      
      // Uniform radius calculation — no cap so each depth gets its own ring
      // (the user can pan/zoom to see deeper rings that extend beyond the viewport)
      const radiusByDepth = new Map<number, number>();
      for (let depth = 0; depth <= maxDepth; depth++) {
        radiusByDepth.set(depth, levelGap * (depth + 1));
      }
      
      if (constraintMode === 'equidistant') {
        // ── Equidistant mode: evenly space nodes at each depth ring ──
        // Multiple depths can share the same radius when capped at maxRadius.
        // Merge them into a single ring so all nodes are spaced correctly.
        const ringNodes = new Map<number, GraphNode[]>(); // radius → nodes
        for (let depth = 0; depth <= maxDepth; depth++) {
          const nodesAtDepth = nodesByDepth.get(depth) || [];
          if (nodesAtDepth.length === 0) continue;
          const radius = radiusByDepth.get(depth)!;
          const existing = ringNodes.get(radius) || [];
          existing.push(...nodesAtDepth);
          ringNodes.set(radius, existing);
        }
        
        // Scale up ring radius if too many nodes would overlap at that ring
        const minNodeSpacing = nodeSpacing; // Uses glare-aware spacing computed above
        for (const [baseRadius, nodesOnRing] of ringNodes) {
          const count = nodesOnRing.length;
          const minRadiusForCount = (count * minNodeSpacing) / (2 * Math.PI);
          const radius = Math.max(baseRadius, minRadiusForCount);
          
          nodesOnRing.forEach((node, i) => {
            const angle = (2 * Math.PI * i) / count - Math.PI / 2;
            node.targetX = centerX + radius * Math.cos(angle);
            node.targetY = centerY + radius * Math.sin(angle);
            (node as GraphNode & { _treeRadius?: number })._treeRadius = radius;
            // Seed unpositioned nodes near target so they animate in smoothly
            if (node.x === 0 && node.y === 0) {
              node.x = node.targetX;
              node.y = node.targetY;
            }
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
      if (orphans.length > 0) {
        const orphanRadius = levelGap * (maxDepth + 2); // one ring beyond the deepest
        orphans.forEach((node, i) => {
          const angle = (2 * Math.PI * i) / Math.max(orphans.length, 1) + Math.PI;
          node.targetX = centerX + orphanRadius * Math.cos(angle);
          node.targetY = centerY + orphanRadius * Math.sin(angle);
          (node as GraphNode & { _treeRadius?: number })._treeRadius = orphanRadius;
        });
      }
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
    const prevNodeSizeMode = settingsRef.current.nodeSizeMode;
    settingsRef.current = settings;
    topologyDirtyRef.current = true;
    // Recalculate positions when constraint mode or node size mode changes in tree/circle mode
    const modeChanged = settings.constraintMode !== prevConstraintMode || settings.nodeSizeMode !== prevNodeSizeMode;
    if (modeChanged && (viewModeRef.current === 'circle' || viewModeRef.current === 'tree') && nodesRef.current.length > 0) {
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settings.constraintMode, settings.nodeSizeMode);
    }
    wakeSimulationRef.current();
  }, [settings, calculatePositions]);
  useEffect(() => { classColorsRef.current = [...classColors].sort((a, b) => a.order - b.order); requestRender(); }, [classColors, requestRender]);
  useEffect(() => { selectedNodeIdsRef.current = selectedNodeIds; requestRender(); }, [selectedNodeIds, requestRender]);
  useEffect(() => { currentNodeIdRef.current = currentNodeId; requestRender(); }, [currentNodeId, requestRender]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { hoveredNodeRef.current = hoveredNode; }, [hoveredNode]);
  
  // Store original input nodes for filter comparison
  const inputNodesMapRef = useRef<Map<number, GraphNode>>(new Map());
  const allLinksRef = useRef<GraphLink[]>([]);
  
  // Helper to check if a node should be visible based on filters
  const shouldNodeBeVisible = useCallback((node: GraphNode, filters: VisibilityFilters): boolean => {
    // Terrain mode: always hide class nodes (they are destroyed from the simulation)
    if (viewModeRef.current === 'terrain' && node.isClassNode) return false;
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
  
  // Handle view mode changes separately — only update targets, don't reset warmup
  const prevViewModeRef = useRef(viewMode);
  useEffect(() => {
    if (prevViewModeRef.current === viewMode) return;
    const prevMode = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;
    
    // Terrain mode transitions: destroy/create class nodes
    const enteringTerrain = viewMode === 'terrain' && prevMode !== 'terrain';
    const leavingTerrain = viewMode !== 'terrain' && prevMode === 'terrain';
    
    if (enteringTerrain) {
      // Destroy class nodes from simulation
      const classNodeIds = nodesRef.current.filter(n => n.isClassNode).map(n => n.id);
      for (const id of classNodeIds) {
        const index = nodesRef.current.findIndex(n => n.id === id);
        if (index !== -1) nodesRef.current.splice(index, 1);
      }
      // Remove links involving class nodes
      const classIdSet = new Set(classNodeIds);
      linksRef.current = linksRef.current.filter(
        l => !classIdSet.has(l.source) && !classIdSet.has(l.target)
      );
      topologyDirtyRef.current = true;
    }
    
    if (leavingTerrain) {
      // Re-create class nodes that should be visible
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
      // Rebuild links
      const visibleIds = new Set(nodesRef.current.map(n => n.id));
      linksRef.current = allLinksRef.current.filter(
        l => visibleIds.has(l.source) && visibleIds.has(l.target) && shouldLinkBeActive(l, currentFilters)
      );
      topologyDirtyRef.current = true;
    }
    
    // Recalculate target positions and radii for the new mode
    if (nodesRef.current.length > 0) {
      calculatePositions(nodesRef.current, viewMode, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode, settingsRef.current.nodeSizeMode);
      topologyDirtyRef.current = true;
      wakeSimulationRef.current();
    }
  }, [viewMode, calculatePositions, shouldNodeBeVisible, shouldLinkBeActive]);
  
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
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode, settingsRef.current.nodeSizeMode);
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
      calculatePositions(nodesRef.current, viewModeRef.current, dimensionsRef.current.width, dimensionsRef.current.height, settingsRef.current.constraintMode, settingsRef.current.nodeSizeMode);
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
    
    calculatePositions(nodesRef.current, viewMode, dimW, dimH, settings.constraintMode, settings.nodeSizeMode);
    
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
    const inLinkCounts = new Map<number, number>();
    const outLinkCounts = new Map<number, number>();
    
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
      
      // Connection counts (total, in, out)
      connectionCounts.set(link.source, (connectionCounts.get(link.source) || 0) + 1);
      connectionCounts.set(link.target, (connectionCounts.get(link.target) || 0) + 1);
      outLinkCounts.set(link.source, (outLinkCounts.get(link.source) || 0) + 1);
      inLinkCounts.set(link.target, (inLinkCounts.get(link.target) || 0) + 1);
      
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
      node.inLinkCount = inLinkCounts.get(node.id) || 0;
      node.outLinkCount = outLinkCounts.get(node.id) || 0;
    }
    
    connectedPairsRef.current = connectedPairs;
    adjacencyRef.current = adjacency;
    childrenOfRef.current = childrenOf;
    massCacheRef.current = massCache;
    connectionCountsRef.current = connectionCounts;
    inLinkCountsRef.current = inLinkCounts;
    outLinkCountsRef.current = outLinkCounts;
    topologyDirtyRef.current = false;
  }, []);

  // ==================== Barnes-Hut Quadtree (pooled) ====================
  
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
    
    // Frame tracking
    let totalFrames = 0;
    const simulationStartTime = performance.now();
    
    const wake = () => {
      if (simulationGenerationRef.current !== thisGeneration) return; // stale generation
      if (simulationSleepingRef.current) {
        simulationSleepingRef.current = false;
        // Allow a burst of physics frames on wake (e.g., after drag/node change)
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
      // Generation guard: if a newer simulation was started, this one dies
      if (simulationGenerationRef.current !== thisGeneration) return;
      
      totalFrames++;
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const currentSettings = settingsRef.current;
      const currentViewMode = viewModeRef.current;
      const isConstrainedMode = currentViewMode === 'circle' || currentViewMode === 'tree';
      const isTerrainMode = currentViewMode === 'terrain';
      
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
      const linkDir = currentSettings.linkDirection ?? 'all';
      for (const node of nodes) {
        const mass = useMass ? (massCache.get(node.id) ?? 1) : 1;
        (node as GraphNode & { _mass?: number })._mass = mass;
        const dirCount = linkDir === 'in' ? node.inLinkCount : linkDir === 'out' ? node.outLinkCount : node.connectionCount;
        if (dirCount > maxConnections) maxConnections = dirCount;
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
      // In equidistant mode this is the primary positioning force — strong enough
      // to overcome tangential repulsion and hold nodes at their predefined spots.
      // In physics mode only a very gentle hint — N-body forces handle clustering.
      if (isConstrainedMode) {
        const returnStrength = currentSettings.constraintMode === 'equidistant' ? 0.5 : RETURN_FORCE * 0.05;
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
      
      // Terrain mode: footprint-based collision avoidance
      // Prevents smaller nodes from being hidden inside larger nodes' terrain cones
      // Takes height into account: a tall node can be closer because it "pokes through"
      if (isTerrainMode && usePhysics) {
        const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
        const terrainHeights = frameDataRef.current.terrainHeights;
        
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          if (dragNodeRef.current?.id === a.id || a.pinned) continue;
          
          const aPeak = terrainPeakRadii.get(a.id) ?? 0;
          const aHeight = terrainHeights.get(a.id) ?? 0;
          const aFootprint = TERRAIN_BASE_FOOTPRINT + TERRAIN_PEAK_FOOTPRINT * aPeak;
          
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            if (dragNodeRef.current?.id === b.id || b.pinned) continue;
            
            const bPeak = terrainPeakRadii.get(b.id) ?? 0;
            const bHeight = terrainHeights.get(b.id) ?? 0;
            const bFootprint = TERRAIN_BASE_FOOTPRINT + TERRAIN_PEAK_FOOTPRINT * bPeak;
            
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            // Calculate how much the smaller node "pokes through" the larger's terrain
            // If smaller node's height > terrain height at that distance, it's visible
            // Terrain height decreases linearly from H at center to 0 at footprint edge
            const [larger, smaller] = aHeight >= bHeight 
              ? [{ h: aHeight, fp: aFootprint }, { h: bHeight }]
              : [{ h: bHeight, fp: bFootprint }, { h: aHeight }];
            
            // At distance d, the larger cone's terrain height ≈ H * (1 - d/footprint)
            // If smaller.h > that, the smaller node is visible above the terrain
            const terrainAtDist = larger.h * Math.max(0, 1 - dist / larger.fp);
            const heightAboveTerrain = smaller.h - terrainAtDist;
            
            // If smaller node is above terrain, reduce required separation
            // Full visibility (heightAboveTerrain >= 0.3) → no separation needed
            // Partial visibility → proportionally reduced separation
            const visibilityFactor = Math.min(1, Math.max(0, 1 - heightAboveTerrain / 0.3));
            
            // Minimum separation scales with visibility factor
            const baseMinSep = Math.max(TERRAIN_MIN_SEPARATION, (aFootprint + bFootprint) * 0.4);
            const minSeparation = baseMinSep * visibilityFactor;
            
            if (dist >= minSeparation || minSeparation < 1) continue;
            
            // Push nodes apart along the line connecting them
            const overlap = minSeparation - dist;
            const correction = overlap * TERRAIN_SEPARATION_STRENGTH * warmupMultiplier;
            const nx = dx / dist;
            const ny = dy / dist;
            
            // Asymmetric push: larger nodes push harder than smaller ones
            const totalFootprint = aFootprint + bFootprint;
            const aRatio = bFootprint / totalFootprint; // a moves more if b is bigger
            const bRatio = aFootprint / totalFootprint; // b moves more if a is bigger
            
            if (!a.pinned) {
              a.x -= nx * correction * aRatio;
              a.y -= ny * correction * aRatio;
            }
            if (!b.pinned) {
              b.x += nx * correction * bRatio;
              b.y += ny * correction * bRatio;
            }
          }
        }
      }
      
      // Shared across tangential and collision phases
      const currentNodeSizeMode = currentSettings.nodeSizeMode;
      const currentLinkDirection = currentSettings.linkDirection ?? 'all';
      
      // Tangential overlap prevention for constrained modes (tree/circle).
      // Uses direct position correction (not velocity) for stability.
      // In equidistant mode, skip entirely — the return force handles spacing.
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
            
            // Only check nodes on the same or nearby rings
            const minGlareDist = (aGlare + bGlare) * 1.05;
            if (Math.abs(aRadius - bRadius) > minGlareDist) continue;
            
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            if (dist >= minGlareDist) continue;
            
            // Compute tangential direction (perpendicular to radial from center)
            const dax = a.x - cx;
            const day = a.y - cy;
            const daDist = Math.sqrt(dax * dax + day * day) || 1;
            
            const radialX = dax / daDist;
            const radialY = day / daDist;
            
            // Get the tangential direction (perpendicular to radial)
            // Use sign of cross product to determine which way to push
            const cross = dx * radialY - dy * radialX;
            const sign = cross >= 0 ? 1 : -1;
            const tangX = -radialY * sign;
            const tangY = radialX * sign;
            
            // Direct position correction — move nodes apart along tangent
            const overlap = minGlareDist - dist;
            const correction = overlap * 0.15; // Gentle correction per frame
            
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
      // Skipped in equidistant mode: spacing is pre-computed to prevent overlap,
      // and the collision force fights the return force causing node pairing.
      const COLLISION_PADDING = 1.05; // Multiplier on glare radius for collision zone (small gap)
      const COLLISION_STRENGTH = 1.0; // Velocity impulse per pixel of overlap per frame
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
      }
      
      // Update positions and track kinetic energy for convergence sleep
      const velDamping = isTerrainMode ? TERRAIN_VELOCITY_DAMPING : VELOCITY_DAMPING;
      const velDeadzone = isTerrainMode ? TERRAIN_VELOCITY_DEADZONE : VELOCITY_DEADZONE;
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
          node.vx *= velDamping;
          node.vy *= velDamping;
          
          // Measure KE before deadzone so active forces aren't masked
          kineticEnergy += node.vx * node.vx + node.vy * node.vy;
          
          // Kill tiny velocities to prevent jitter near equilibrium
          if (Math.abs(node.vx) < velDeadzone) node.vx = 0;
          if (Math.abs(node.vy) < velDeadzone) node.vy = 0;
          
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
        
        // Terrain mode: compute normalized heights (mass) and peak radii (link count)
        if (isTerrainMode) {
          const terrainHeights = frameDataRef.current.terrainHeights;
          const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
          terrainHeights.clear();
          terrainPeakRadii.clear();
          
          // Height = mass (always), normalized to [0,1]
          let maxHeightRaw = 0;
          const rawHeights = new Map<number, number>();
          for (const node of nodes) {
            const h = useMass ? (massCache.get(node.id) ?? 1) : 1;
            rawHeights.set(node.id, h);
            if (h > maxHeightRaw) maxHeightRaw = h;
          }
          for (const [id, h] of rawHeights) {
            terrainHeights.set(id, maxHeightRaw > 0 ? h / maxHeightRaw : 0);
          }
          
          // Peak radius = link count (in/out/all based on linkDirection setting), normalized to [0,1]
          const linkDir = currentSettings.linkDirection ?? 'all';
          const inCounts = inLinkCountsRef.current;
          const outCounts = outLinkCountsRef.current;
          const allCounts = connectionCountsRef.current;
          let maxLinkCount = 0;
          const rawRadii = new Map<number, number>();
          for (const node of nodes) {
            let count: number;
            if (linkDir === 'in') {
              count = inCounts.get(node.id) || 0;
            } else if (linkDir === 'out') {
              count = outCounts.get(node.id) || 0;
            } else {
              count = allCounts.get(node.id) || 0;
            }
            rawRadii.set(node.id, count);
            if (count > maxLinkCount) maxLinkCount = count;
          }
          for (const [id, c] of rawRadii) {
            terrainPeakRadii.set(id, maxLinkCount > 0 ? c / maxLinkCount : 0);
          }
          
          // Throttle DOM state updates to avoid React overhead every physics frame
          if (!terrainUpdateRafRef.current) {
            terrainUpdateRafRef.current = requestAnimationFrame(() => {
              terrainUpdateRafRef.current = 0;
              const positions = new Map<number, { x: number; y: number; height: number }>();
              const fd = frameDataRef.current;
              for (const node of fd.visibleNodes) {
                const ht = fd.terrainHeights.get(node.id) ?? 0;
                positions.set(node.id, { x: node.x, y: node.y, height: ht });
              }
              setTerrainNodePositions(positions);
            });
          }
        }
        
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
      
      // Simulation runs continuously via requestAnimationFrame.
      // rAF automatically pauses when the tab is hidden, so no sleep logic needed.
      // Force-stop is kept only as a safety net for truly massive graphs.
      const maxFrames = getMaxSimulationFrames(nodes.length);
      const forceStop = (maxFrames > 0 && totalFrames >= maxFrames) ||
        (MAX_SIMULATION_TIME_MS > 0 && (performance.now() - simulationStartTime) > MAX_SIMULATION_TIME_MS);
      
      if (forceStop) {
        const elapsed = (performance.now() - simulationStartTime).toFixed(0);
        console.log(`[Graph] Simulation force-stopped: frames=${totalFrames}, ${elapsed}ms, ${nodes.length} nodes`);
        simulationSleepingRef.current = true;
        // Prep frame data for final render
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
        return; // Don't schedule next frame
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
    
    // In terrain mode, skip link and node rendering — only draw contour lines
    if (currentViewMode !== 'terrain') {
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
      
      const sourceLineGlare = getGlareRadius(source, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
      const targetLineGlare = getGlareRadius(target, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
      
      // Determine if there are dots at each end
      const dotSize = 4;
      const hasTargetDot = !renderAsParent && link.source === source.id;
      const hasSourceDot = renderAsParent || (!renderAsParent && hasFwd && hasRev);
      
      // Calculate line endpoints to stop where dots start (avoid transparency overlap)
      // Simple approach: join node centers with a line, then trim both ends
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Skip if nodes are at the same position
      if (dist < 0.001) continue;
      
      // Unit vector from source to target
      const ux = dx / dist;
      const uy = dy / dist;
      
      // How much to trim from each end
      const targetOffset = hasTargetDot ? (arrowGap + dotSize) : arrowGap;
      const sourceOffset = hasSourceDot ? (arrowGap + dotSize) : arrowGap;
      const trimStart = sourceLineGlare + sourceOffset;
      const trimEnd = targetLineGlare + targetOffset;
      
      // Skip if trimming would exceed the line length (nodes too close)
      if (trimStart + trimEnd >= dist) continue;
      
      // Trim the line: start from source center + trimStart along the vector,
      // end at target center - trimEnd along the vector
      const lineStartX = source.x + ux * trimStart;
      const lineStartY = source.y + uy * trimStart;
      const lineEndX = target.x - ux * trimEnd;
      const lineEndY = target.y - uy * trimEnd;
      
      // Angle for dot positioning
      const lineAngle = Math.atan2(dy, dx);
      
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
    } // end: if (currentViewMode !== 'terrain') — links, level guides
    
    // ==================== Terrain Contour Lines ====================
    if (currentViewMode === 'terrain' && visibleNodes.length > 1) {
      const terrainHeights = frameDataRef.current.terrainHeights;
      const terrainPeakRadii = frameDataRef.current.terrainPeakRadii;
      
      // Generate height field using overlapping terrain with preserved plateaus
      // Each node has: H (height from mass), Rp (plateau radius), Rs (slope radius)
      // Height at cell = MAX of all node contributions — preserves peaks and plateaus
      const GRID_RES = 3; // pixels per grid cell (lower = higher quality)
      const gridW = Math.ceil(w / GRID_RES);
      const gridH = Math.ceil(h / GRID_RES);
      
      // Allocate height map (reuse if same size)
      const heightMap = new Float32Array(gridW * gridH);
      
      // Terrain parameters - ensure even small nodes create visible terrain
      const BASE_PLATEAU_RADIUS = 25;  // base plateau radius in world coords
      const PEAK_PLATEAU_BONUS = 35;   // additional plateau per unit peak size
      const BASE_SLOPE_RADIUS = 100;   // base slope radius in world coords  
      const PEAK_SLOPE_BONUS = 140;    // additional slope per unit peak size
      const MIN_HEIGHT = 0.15;         // minimum height for any node
      
      // Build height map with MAX merge
      for (const node of visibleNodes) {
        let H = terrainHeights.get(node.id) ?? 0;
        const peakSize = terrainPeakRadii.get(node.id) ?? 0;
        
        // Ensure minimum height so all nodes create visible terrain
        if (H > 0) H = Math.max(H, MIN_HEIGHT);
        if (H <= 0) continue;
        
        // Calculate plateau and slope radii based on peak size (link count)
        const Rp = (BASE_PLATEAU_RADIUS + PEAK_PLATEAU_BONUS * peakSize) * t.scale / GRID_RES;
        const Rs = (BASE_SLOPE_RADIUS + PEAK_SLOPE_BONUS * peakSize) * t.scale / GRID_RES;
        
        // Convert world coords to grid coords
        const centerX = (node.x * t.scale + t.x) / GRID_RES;
        const centerY = (node.y * t.scale + t.y) / GRID_RES;
        
        // Only iterate over cells within Rs radius
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
            
            let h: number;
            if (d <= Rp) {
              // Flat plateau
              h = H;
            } else {
              // Linear falloff from plateau edge to zero
              h = H * (1 - (d - Rp) / (Rs - Rp));
            }
            
            // MAX merge preserves higher terrain and plateau integrity
            const idx = gy * gridW + gx;
            if (h > heightMap[idx]) {
              heightMap[idx] = h;
            }
          }
        }
      }
      
      // Apply gaussian blur for smoother contours
      // Simple 3x3 blur kernel, applied twice for stronger smoothing
      const blurKernel = (src: Float32Array, dst: Float32Array, w: number, h: number) => {
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            dst[i] = (
              src[i - w - 1] + src[i - w] * 2 + src[i - w + 1] +
              src[i - 1] * 2 + src[i] * 4 + src[i + 1] * 2 +
              src[i + w - 1] + src[i + w] * 2 + src[i + w + 1]
            ) / 16;
          }
        }
        // Copy edges
        for (let x = 0; x < w; x++) { dst[x] = src[x]; dst[(h - 1) * w + x] = src[(h - 1) * w + x]; }
        for (let y = 0; y < h; y++) { dst[y * w] = src[y * w]; dst[y * w + w - 1] = src[y * w + w - 1]; }
      };
      
      const tempMap = new Float32Array(gridW * gridH);
      blurKernel(heightMap, tempMap, gridW, gridH);
      blurKernel(tempMap, heightMap, gridW, gridH);
      blurKernel(heightMap, tempMap, gridW, gridH);
      blurKernel(tempMap, heightMap, gridW, gridH);
      
      // Height getter
      const getHeight = (gx: number, gy: number): number => {
        if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) return 0;
        return heightMap[gy * gridW + gx];
      };
      
      // Read CSS variables for contour color gradient (low → high elevation)
      const style = getComputedStyle(document.documentElement);
      const colorLow = style.getPropertyValue('--color-outline').trim() || '#a3a3a3';
      const colorHigh = style.getPropertyValue('--color-accent').trim() || '#404040';
      
      // Parse colors for interpolation
      const parseHex = (hex: string): [number, number, number] => {
        let h = hex.replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        return [
          parseInt(h.substring(0, 2), 16),
          parseInt(h.substring(2, 4), 16),
          parseInt(h.substring(4, 6), 16),
        ];
      };
      const [lowR, lowG, lowB] = parseHex(colorLow);
      const [highR, highG, highB] = parseHex(colorHigh);
      
      // Interpolate color based on level
      const getContourColor = (level: number, opacity: number): string => {
        const t = level; // level is already 0-1
        const r = Math.round(lowR + (highR - lowR) * t);
        const g = Math.round(lowG + (highG - lowG) * t);
        const b = Math.round(lowB + (highB - lowB) * t);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
      };
      
      // Draw contour lines at multiple height levels using marching squares
      const CONTOUR_LEVELS = [0.08, 0.18, 0.32, 0.48, 0.65, 0.82];
      
      ctx.save();
      ctx.resetTransform(); // Draw contours in screen space
      
      for (const level of CONTOUR_LEVELS) {
        const opacity = 0.25 + level * 0.5;
        ctx.strokeStyle = getContourColor(level, opacity);
        ctx.lineWidth = 0.6 + level * 0.8;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash(LINE_DASH_NONE);
        
        // Marching squares: find contour segments
        const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
        
        for (let gy = 0; gy < gridH - 1; gy++) {
          for (let gx = 0; gx < gridW - 1; gx++) {
            const v00 = getHeight(gx, gy);
            const v10 = getHeight(gx + 1, gy);
            const v01 = getHeight(gx, gy + 1);
            const v11 = getHeight(gx + 1, gy + 1);
            
            // Classify corners
            const code = (v00 >= level ? 8 : 0) | (v10 >= level ? 4 : 0) |
                         (v11 >= level ? 2 : 0) | (v01 >= level ? 1 : 0);
            
            if (code === 0 || code === 15) continue;
            
            // Interpolate edge crossings
            const lerp = (va: number, vb: number): number => {
              const d = vb - va;
              return d === 0 ? 0.5 : (level - va) / d;
            };
            
            const top = lerp(v00, v10);
            const right = lerp(v10, v11);
            const bottom = lerp(v01, v11);
            const left = lerp(v00, v01);
            
            const px = gx * GRID_RES;
            const py = gy * GRID_RES;
            const gs = GRID_RES;
            
            const edgePoints: Record<string, [number, number]> = {
              top: [px + top * gs, py],
              right: [px + gs, py + right * gs],
              bottom: [px + bottom * gs, py + gs],
              left: [px, py + left * gs],
            };
            
            // Marching squares lookup — add segments for each case
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
        
        // Chain segments into polylines and draw as smooth splines
        if (segments.length > 0) {
          const EPS = 0.5;
          const ptKey = (x: number, y: number) => `${Math.round(x / EPS)},${Math.round(y / EPS)}`;
          const chains: Array<Array<[number, number]>> = [];
          const used = new Uint8Array(segments.length);
          
          // Index segments by endpoints
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
          
          // Chain segments together
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
          
          // Smooth chain points with a simple moving average filter
          const smoothChain = (pts: Array<[number, number]>): Array<[number, number]> => {
            if (pts.length < 5) return pts;
            const smoothed: Array<[number, number]> = [[pts[0][0], pts[0][1]]];
            // Apply 3-point weighted average (1-2-1 kernel)
            for (let i = 1; i < pts.length - 1; i++) {
              const x = (pts[i - 1][0] + pts[i][0] * 2 + pts[i + 1][0]) / 4;
              const y = (pts[i - 1][1] + pts[i][1] * 2 + pts[i + 1][1]) / 4;
              smoothed.push([x, y]);
            }
            smoothed.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
            return smoothed;
          };
          
          // Draw chains as Catmull-Rom splines for smoothness
          for (let chain of chains) {
            if (chain.length < 2) continue;
            
            // Apply smoothing passes to longer chains
            if (chain.length >= 5) {
              chain = smoothChain(chain);
              chain = smoothChain(chain);
            }
            
            ctx.beginPath();
            
            if (chain.length === 2) {
              ctx.moveTo(chain[0][0], chain[0][1]);
              ctx.lineTo(chain[1][0], chain[1][1]);
            } else if (chain.length === 3) {
              // Quadratic bezier for 3 points
              ctx.moveTo(chain[0][0], chain[0][1]);
              ctx.quadraticCurveTo(chain[1][0], chain[1][1], chain[2][0], chain[2][1]);
            } else {
              // Catmull-Rom spline with tension parameter for smoothness
              // Lower tension = smoother curves
              const tension = 4; // Lower = smoother (was 6)
              
              ctx.moveTo(chain[0][0], chain[0][1]);
              
              for (let j = 0; j < chain.length - 1; j++) {
                const p0 = chain[Math.max(0, j - 1)];
                const p1 = chain[j];
                const p2 = chain[j + 1];
                const p3 = chain[Math.min(chain.length - 1, j + 2)];
                
                // Catmull-Rom to cubic bezier conversion
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
      
      ctx.restore(); // Restore from resetTransform
    }
    
    // ==================== Node Rendering ====================
    // In terrain mode, skip canvas node rendering — DOM overlay handles it
    if (currentViewMode !== 'terrain') {
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
      const baseRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
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
      
      // Display just the node name (use cached displayName to avoid re-parsing AST each frame)
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
    
    } // end: if (currentViewMode !== 'terrain')
    
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
    const hitLinkDir = currentSettings.linkDirection ?? 'all';
    for (const node of nodesRef.current) {
      const dirCount = hitLinkDir === 'in' ? node.inLinkCount : hitLinkDir === 'out' ? node.outLinkCount : node.connectionCount;
      maxConnections = Math.max(maxConnections, dirCount);
      maxMass = Math.max(maxMass, (node as GraphNode & { _mass?: number })._mass ?? 1);
    }
    
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      if (!node.visible) continue;
      
      const nodeRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
      const hitRadius = (nodeRadius + NODE_HOVER_RADIUS_EXTRA + 4) / t.scale;
      const dx = x - node.x;
      const dy = y - node.y;
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        return node;
      }
    }
    return null;
  }, [screenToWorld]);

  // Get link at position - checks if click is near a link line
  const getLinkAtPosition = useCallback((screenX: number, screenY: number): GraphLink | null => {
    const { x, y } = screenToWorld(screenX, screenY);
    const t = transformRef.current;
    const currentSettings = settingsRef.current;
    
    // Hit threshold in world coordinates (adjusted for zoom)
    const hitThreshold = 8 / t.scale;
    
    // Build node map for quick lookup
    const nodeMap = new Map<number, GraphNode>();
    let maxConnections = 0, maxMass = 0;
    const linkHitDir = currentSettings.linkDirection ?? 'all';
    for (const node of nodesRef.current) {
      if (node.visible) {
        nodeMap.set(node.id, node);
        const dirCount = linkHitDir === 'in' ? node.inLinkCount : linkHitDir === 'out' ? node.outLinkCount : node.connectionCount;
        maxConnections = Math.max(maxConnections, dirCount);
        maxMass = Math.max(maxMass, (node as GraphNode & { _mass?: number })._mass ?? 1);
      }
    }
    
    // Check each link
    for (const link of linksRef.current) {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (!source || !target) continue;
      
      // Calculate distance from point to line segment
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const lengthSquared = dx * dx + dy * dy;
      
      // Skip zero-length links
      if (lengthSquared < 0.001) continue;
      
      // Project point onto line segment
      const t_param = Math.max(0, Math.min(1, 
        ((x - source.x) * dx + (y - source.y) * dy) / lengthSquared
      ));
      
      // Find closest point on segment
      const closestX = source.x + t_param * dx;
      const closestY = source.y + t_param * dy;
      
      // Check distance to closest point
      const distX = x - closestX;
      const distY = y - closestY;
      const distance = Math.sqrt(distX * distX + distY * distY);
      
      if (distance < hitThreshold) {
        // Make sure we're not too close to the nodes themselves
        // (to avoid selecting link when user intended to click node)
        const sourceRadius = getNodeRadius(source, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
        const targetRadius = getNodeRadius(target, currentSettings.nodeSizeMode, maxConnections, maxMass, currentSettings.linkDirection);
        
        const distToSource = Math.sqrt((x - source.x) ** 2 + (y - source.y) ** 2);
        const distToTarget = Math.sqrt((x - target.x) ** 2 + (y - target.y) ** 2);
        
        // Only return link if we're not within node hit radius
        const sourceHitRadius = (sourceRadius + NODE_HOVER_RADIUS_EXTRA + 4) / t.scale;
        const targetHitRadius = (targetRadius + NODE_HOVER_RADIUS_EXTRA + 4) / t.scale;
        
        if (distToSource > sourceHitRadius && distToTarget > targetHitRadius) {
          return link;
        }
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
      if (canvas) canvas.style.cursor = 'grabbing';
    } else {
      const node = getNodeAtPosition(screenX, screenY);
      const link = node ? null : getLinkAtPosition(screenX, screenY);
      
      // Update cursor based on what's under the mouse
      if (canvas) {
        if (node) {
          canvas.style.cursor = 'pointer';
        } else if (link) {
          canvas.style.cursor = 'pointer';
        } else {
          canvas.style.cursor = 'grab';
        }
      }
      
      // Only update state if hovered node actually changed (avoid unnecessary re-renders)
      if (node !== hoveredNodeRef.current) {
        hoveredNodeRef.current = node;
        setHoveredNode(node);
        onHoveredNodeChange?.(node);
        // Re-render canvas so hover visual (larger circle) appears even when simulation is sleeping
        requestRender();
      }
    }
  }, [getCanvasCoordinates, getNodeAtPosition, getLinkAtPosition, screenToWorld, onHoveredNodeChange, setTransformDirect, requestRender]);

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
    const now = Date.now();
    
    // Check for link click first (before node, since nodes have larger hit areas)
    const link = getLinkAtPosition(screenX, screenY);
    if (link) {
      const lastLink = lastClickedLinkRef.current;
      const isSameLink = lastLink && 
        ((lastLink.source === link.source && lastLink.target === link.target) ||
         (lastLink.source === link.target && lastLink.target === link.source));
      
      const currentSelection = selectedNodeIdsRef.current;
      const bothSelected = currentSelection.includes(link.source) && currentSelection.includes(link.target);
      
      // Toggle: if same link clicked and both nodes are selected, deselect them
      if (isSameLink && bothSelected) {
        onSelectionChange?.([]);
        lastClickedLinkRef.current = null;
      } else {
        // Select both endpoint nodes
        onSelectionChange?.([link.source, link.target]);
        lastClickedLinkRef.current = { source: link.source, target: link.target };
      }
      return;
    }
    
    // Clear last clicked link when clicking elsewhere
    lastClickedLinkRef.current = null;
    
    // Check for node click
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
  }, [getCanvasCoordinates, getNodeAtPosition, getLinkAtPosition, onNodeClick, onNodeDoubleClick, onSelectionChange]);

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

  // Terrain overlay: memoize the node list to avoid creating new arrays each render
  const terrainNodes = useMemo(() => {
    if (viewMode !== 'terrain') return [];
    return Array.from(terrainNodePositions.entries()).map(([id, pos]) => {
      const node = frameDataRef.current.nodeMap.get(id);
      return node ? { id, node, ...pos } : null;
    }).filter(Boolean) as Array<{ id: number; node: GraphNode; x: number; y: number; height: number }>;
  }, [viewMode, terrainNodePositions]);

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
      {viewMode === 'terrain' && (
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
                  transform: 'translate(-6px, -6px)', // align bullet dot to node position
                  pointerEvents: 'auto',
                  opacity: node.glare === 'dim' ? 0.3 : 1,
                }}
                data-height={height.toFixed(2)}
                onClick={(e) => {
                  e.stopPropagation();
                  onNodeClick?.(node, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onNodeDoubleClick?.(node);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onNodeRightClick?.(node);
                }}
              >
                <div className="terrain-node__card">
                  <NodeInline
                    name={node.name}
                    nodeId={node.id}
                    showBullet={true}
                    className="terrain-node__inline"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default NodeGraphRenderer;
