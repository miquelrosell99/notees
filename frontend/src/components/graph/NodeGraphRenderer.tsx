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
const VELOCITY_DAMPING = 0.82;
const RETURN_FORCE = 0.08;
const DRAG_PULL_STRENGTH = 0.15;
const PARENT_MASS_PER_CHILD = 2;
const MIN_REPULSION_DISTANCE = 20; // Prevent infinite force when nodes overlap
const MAX_VELOCITY = 10; // Clamp velocity to prevent explosive movement
const WARMUP_DURATION_FRAMES = 120; // Frames over which simulation ramps to full strength
const CENTER_GRAVITY = 0.003; // Gentle pull toward center to prevent drift

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

function getNodeColor(node: GraphNode, classColors: ClassColor[], accentColor: string): string {
  if (node.color) return node.color;
  
  if (node.types && node.types.length > 0 && classColors.length > 0) {
    const sortedClassColors = [...classColors].sort((a, b) => a.order - b.order);
    for (const classColor of sortedClassColors) {
      if (node.types.includes(classColor.typeId)) {
        return classColor.color;
      }
    }
  }
  
  return accentColor;
}

function hexToRgba(hex: string, opacity: number): string {
  let cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
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
  settings = { linkCountAttraction: false, nodeSizeMode: 'uniform', massAccumulation: true },
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
  
  // Refs for current values (to avoid stale closures)
  const settingsRef = useRef(settings);
  const classColorsRef = useRef(classColors);
  const visibilityFiltersRef = useRef(visibilityFilters);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const currentNodeIdRef = useRef(currentNodeId);
  
  // Pan and zoom state
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  
  // Build adjacency for connected nodes
  const getConnectedNodes = useCallback((nodeId: number): Set<number> => {
    const connected = new Set<number>();
    for (const link of linksRef.current) {
      if (link.source === nodeId) connected.add(link.target);
      if (link.target === nodeId) connected.add(link.source);
    }
    return connected;
  }, []);

  // Calculate positions for view modes
  const calculatePositions = useCallback((
    nodes: GraphNode[],
    mode: GraphViewMode,
    w: number,
    h: number
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
      
      // ── Bottom-up subtree pixel width calculation ──
      // Compute the physical (pixel) spacing each subtree needs at its
      // deepest level, then propagate upward. Using pixel widths instead
      // of angular widths avoids scale mismatch across radii.
      const subtreePixelWidth = new Map<number, number>();
      
      // Process depths bottom-up
      for (let depth = maxDepth; depth >= 0; depth--) {
        const nodesAtDepth = nodesByDepth.get(depth) || [];
        for (const node of nodesAtDepth) {
          const children = (childrenByParent.get(node.id) || [])
            .filter(c => nodeDepth.has(c.id)); // only children in the graph
          
          if (children.length === 0) {
            // Leaf node: needs nodeSpacing pixels of arc length
            subtreePixelWidth.set(node.id, nodeSpacing);
          } else {
            // Sum of all children's subtree widths
            let totalChildrenWidth = 0;
            for (const child of children) {
              totalChildrenWidth += subtreePixelWidth.get(child.id) || nodeSpacing;
            }
            
            // Take the max: either the node's own spacing or children's total
            subtreePixelWidth.set(node.id, Math.max(nodeSpacing, totalChildrenWidth));
          }
        }
      }
      
      // ── Top-down positioning using computed widths ──
      const nodeAngleRange = new Map<number, { start: number; end: number }>();
      
      // Helper: convert pixel width to angular width at a given radius
      const pixelsToAngle = (pixels: number, radius: number) => pixels / radius;
      
      // Collect all level-0 nodes
      const level0Nodes = nodesByDepth.get(0) || [];
      const radius0 = radiusByDepth.get(0)!;
      
      // Total angular width needed for all level-0 subtrees
      // Each subtree's pixel width is evaluated at level-0 radius
      let totalLevel0Angle = 0;
      for (const node of level0Nodes) {
        const pw = subtreePixelWidth.get(node.id) || nodeSpacing;
        totalLevel0Angle += pixelsToAngle(pw, radius0);
      }
      // Ensure at least 2π, but allow expansion beyond if needed
      const totalAngle0 = Math.max(2 * Math.PI, totalLevel0Angle);
      const scale0 = totalLevel0Angle > 0 ? totalAngle0 / totalLevel0Angle : 1;
      
      let currentAngle0 = -Math.PI / 2;
      for (const node of level0Nodes) {
        const pw = subtreePixelWidth.get(node.id) || nodeSpacing;
        const allocatedWidth = pixelsToAngle(pw, radius0) * scale0;
        const angle = currentAngle0 + allocatedWidth / 2;
        
        node.targetX = centerX + radius0 * Math.cos(angle);
        node.targetY = centerY + radius0 * Math.sin(angle);
        
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
          let totalRootAngle = 0;
          for (const node of rootNodesAtThisLevel) {
            const pw = subtreePixelWidth.get(node.id) || nodeSpacing;
            totalRootAngle += pixelsToAngle(pw, radius);
          }
          const totalAngleRoot = Math.max(2 * Math.PI, totalRootAngle);
          const scaleRoot = totalRootAngle > 0 ? totalAngleRoot / totalRootAngle : 1;
          
          let currentAngleRoot = -Math.PI / 2;
          for (const node of rootNodesAtThisLevel) {
            const pw = subtreePixelWidth.get(node.id) || nodeSpacing;
            const allocatedWidth = pixelsToAngle(pw, radius) * scaleRoot;
            const angle = currentAngleRoot + allocatedWidth / 2;
            
            node.targetX = centerX + radius * Math.cos(angle);
            node.targetY = centerY + radius * Math.sin(angle);
            
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
          
          // Total pixel width needed by all siblings
          let totalSiblingPixels = 0;
          for (const sibling of siblings) {
            totalSiblingPixels += subtreePixelWidth.get(sibling.id) || nodeSpacing;
          }
          
          // Convert sibling total to angular width at this radius
          const totalSiblingAngle = pixelsToAngle(totalSiblingPixels, radius);
          
          // Use parent's span or sibling requirement, whichever is larger
          const actualSpan = Math.max(parentSpan, totalSiblingAngle);
          const startAngle = parentCenter - actualSpan / 2;
          
          // Distribute proportionally to each child's pixel width
          let currentAngle = startAngle;
          for (const sibling of siblings) {
            const childPixels = subtreePixelWidth.get(sibling.id) || nodeSpacing;
            const allocatedWidth = (childPixels / totalSiblingPixels) * actualSpan;
            const angle = currentAngle + allocatedWidth / 2;
            
            sibling.targetX = centerX + radius * Math.cos(angle);
            sibling.targetY = centerY + radius * Math.sin(angle);
            
            nodeAngleRange.set(sibling.id, {
              start: currentAngle,
              end: currentAngle + allocatedWidth
            });
            
            currentAngle += allocatedWidth;
          }
        }
      }
      
      // Handle orphans (nodes without valid parent)
      const orphans = nodes.filter(n => !nodeDepth.has(n.id));
      orphans.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / Math.max(orphans.length, 1) + Math.PI;
        const radius = maxRadius;
        node.targetX = centerX + radius * Math.cos(angle);
        node.targetY = centerY + radius * Math.sin(angle);
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

  // Keep refs in sync
  useEffect(() => { transformRef.current = transform; }, [transform]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { classColorsRef.current = classColors; }, [classColors]);
  useEffect(() => { selectedNodeIdsRef.current = selectedNodeIds; }, [selectedNodeIds]);
  useEffect(() => { currentNodeIdRef.current = currentNodeId; }, [currentNodeId]);
  
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
        x: dimensions.width / 2 + (Math.random() - 0.5) * 100,
        y: dimensions.height / 2 + (Math.random() - 0.5) * 100,
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
    if ((nodesToRemove.length > 0 || nodesToAdd.length > 0) && (viewMode === 'circle' || viewMode === 'tree')) {
      calculatePositions(nodesRef.current, viewMode, dimensions.width, dimensions.height);
    }
  }, [visibilityFilters, viewMode, dimensions, calculatePositions, shouldNodeBeVisible, shouldLinkBeActive]);

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
    
    const scaleX = dimensions.width / graphWidth;
    const scaleY = dimensions.height / graphHeight;
    const newScale = Math.min(scaleX, scaleY, 1.5);
    
    const newX = dimensions.width / 2 - graphCenterX * newScale;
    const newY = dimensions.height / 2 - graphCenterY * newScale;
    
    setTransform({
      x: newX,
      y: newY,
      scale: Math.max(0.2, newScale),
    });
  }, [dimensions]);

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
      x: node.x || dimensions.width / 2,
      y: node.y || dimensions.height / 2,
      vx: node.vx || 0,
      vy: node.vy || 0,
      targetX: node.targetX || node.x || dimensions.width / 2,
      targetY: node.targetY || node.y || dimensions.height / 2,
      visible: node.visible !== undefined ? node.visible : true,
    };
    
    nodesRef.current.push(newNode);
    
    // Recalculate positions if in constrained mode
    if (viewMode === 'circle' || viewMode === 'tree') {
      calculatePositions(nodesRef.current, viewMode, dimensions.width, dimensions.height);
    }
  }, [viewMode, dimensions, calculatePositions]);
  
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
    if (viewMode === 'circle' || viewMode === 'tree') {
      calculatePositions(nodesRef.current, viewMode, dimensions.width, dimensions.height);
    }
  }, [viewMode, dimensions, calculatePositions]);
  
  const updateLinks = useCallback((links: GraphLink[]) => {
    linksRef.current = [...links];
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
    
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    const spawnRadius = 50; // Nodes spawn within this radius of center
    
    // Remove all nodes from simulation
    nodesRef.current = [];
    
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
  }, [dimensions.width, dimensions.height, createNode]);

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
    
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
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
    
    calculatePositions(nodesRef.current, viewMode, dimensions.width, dimensions.height);
    
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
    
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startSimulation intentionally excluded to prevent re-simulation on every render
  }, [inputNodes, inputLinks, dimensions, viewMode, visibilityFilters, calculatePositions, createNode, destroyNode, shouldNodeBeVisible, shouldLinkBeActive, recenter]);

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

  // Start physics simulation
  const startSimulation = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const simulate = () => {
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const currentSettings = settingsRef.current;
      const isConstrainedMode = viewMode === 'circle' || viewMode === 'tree';
      
      // All nodes in nodesRef are visible (filtering handled by visibility effect)
      const visibleNodes = nodes.filter(n => n.visible);
      const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
      
      // Map from "nodeA-nodeB" to link type (for force calculation)
      const connectedPairs = new Map<string, GraphLink['type']>();
      for (const link of links) {
        // Only consider links between visible nodes
        if (visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)) {
          const key1 = `${link.source}-${link.target}`;
          const key2 = `${link.target}-${link.source}`;
          // If already connected by a stronger link type, don't overwrite with reference
          if (!connectedPairs.has(key1) || (link.type !== 'reference' && connectedPairs.get(key1) === 'reference')) {
            connectedPairs.set(key1, link.type);
            connectedPairs.set(key2, link.type);
          }
        }
      }
      
      const getConnectionType = (a: number, b: number): GraphLink['type'] | null => 
        connectedPairs.get(`${a}-${b}`) ?? null;
      
      // Warm-up: ramp force strength from 0 to 1 over WARMUP_DURATION_FRAMES
      const warmupT = Math.min(1, warmupFrameRef.current / WARMUP_DURATION_FRAMES);
      // Ease-in curve for smoother start
      const warmupMultiplier = warmupT * warmupT;
      warmupFrameRef.current++;
      
      // Compute node mass recursively: a parent inherits the mass of all its descendants
      // Includes parent→child, class→instance, and extends (inheritance) relationships
      const childrenOf = new Map<number, number[]>();
      for (const link of links) {
        if (link.type === 'parent' && visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)) {
          // parent links: source=parent, target=child
          const children = childrenOf.get(link.source) || [];
          children.push(link.target);
          childrenOf.set(link.source, children);
        } else if (link.type === 'class' && visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)) {
          // class links: source=instance, target=class
          const children = childrenOf.get(link.target) || [];
          children.push(link.source);
          childrenOf.set(link.target, children);
        } else if (link.type === 'extends' && visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)) {
          // extends links: source=child class, target=parent class
          const children = childrenOf.get(link.target) || [];
          children.push(link.source);
          childrenOf.set(link.target, children);
        }
      }
      const massCache = new Map<number, number>();
      const computeMass = (nodeId: number): number => {
        if (massCache.has(nodeId)) return massCache.get(nodeId)!;
        let mass = 1;
        const children = childrenOf.get(nodeId);
        if (children) {
          for (const childId of children) {
            mass += computeMass(childId) * PARENT_MASS_PER_CHILD;
          }
        }
        massCache.set(nodeId, mass);
        return mass;
      };
      const getNodeMass = (nodeId: number): number => 
        currentSettings.massAccumulation ? computeMass(nodeId) : 1;
      
      // Compute connection counts from visible links and store mass on nodes
      const connectionCounts = new Map<number, number>();
      for (const link of links) {
        if (visibleNodeIds.has(link.source) && visibleNodeIds.has(link.target)) {
          connectionCounts.set(link.source, (connectionCounts.get(link.source) || 0) + 1);
          connectionCounts.set(link.target, (connectionCounts.get(link.target) || 0) + 1);
        }
      }
      for (const node of visibleNodes) {
        node.connectionCount = connectionCounts.get(node.id) || 0;
        (node as GraphNode & { _mass?: number })._mass = getNodeMass(node.id);
      }
      
      // Constrained mode return force
      if (isConstrainedMode) {
        for (const node of visibleNodes) {
          if (dragNodeRef.current?.id === node.id) continue;
          if (node.pinned) continue;
          
          const dx = node.targetX - node.x;
          const dy = node.targetY - node.y;
          node.vx += dx * RETURN_FORCE;
          node.vy += dy * RETURN_FORCE;
        }
      }
      
      // Centering gravity — gentle pull toward center to prevent drift and contain explosion
      if (!isConstrainedMode) {
        const cx = dimensions.width / 2;
        const cy = dimensions.height / 2;
        for (const node of visibleNodes) {
          if (dragNodeRef.current?.id === node.id || node.pinned) continue;
          const dx = cx - node.x;
          const dy = cy - node.y;
          node.vx += dx * CENTER_GRAVITY * warmupMultiplier;
          node.vy += dy * CENTER_GRAVITY * warmupMultiplier;
        }
      }
      
      // Node-to-node forces (only between visible nodes)
      if (!isConstrainedMode) {
        for (let i = 0; i < visibleNodes.length; i++) {
          for (let j = i + 1; j < visibleNodes.length; j++) {
            const nodeA = visibleNodes[i];
            const nodeB = visibleNodes[j];
            
            if (dragNodeRef.current?.id === nodeA.id || 
                dragNodeRef.current?.id === nodeB.id) continue;
            if (nodeA.pinned && nodeB.pinned) continue;
            
            const dx = nodeB.x - nodeA.x;
            const dy = nodeB.y - nodeA.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            const connectionType = getConnectionType(nodeA.id, nodeB.id);
            if (connectionType) {
              let attractionStrength = ATTRACTION_STRENGTH;
              if (currentSettings.linkCountAttraction) {
                const totalConnections = nodeA.connectionCount + nodeB.connectionCount;
                const linkFactor = Math.log2(2 + totalConnections);
                attractionStrength = ATTRACTION_STRENGTH_LINK_COUNT * linkFactor;
              }
              
              // Reference links have reduced force (property-reference = 80%, content reference = 64%)
              if (connectionType === 'property-reference') {
                attractionStrength *= REFERENCE_LINK_FORCE_MULTIPLIER;
              } else if (connectionType === 'reference') {
                attractionStrength *= REFERENCE_LINK_FORCE_MULTIPLIER * REFERENCE_LINK_FORCE_MULTIPLIER;
              }
              
              const force = (dist - LINKED_ATTRACTION_DISTANCE) * attractionStrength * warmupMultiplier;
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              
              const massA = getNodeMass(nodeA.id);
              const massB = getNodeMass(nodeB.id);
              
              if (!nodeA.pinned) {
                nodeA.vx += fx / massA;
                nodeA.vy += fy / massA;
              }
              if (!nodeB.pinned) {
                nodeB.vx -= fx / massB;
                nodeB.vy -= fy / massB;
              }
            } else {
              if (dist < UNLINKED_REPULSION_DISTANCE) {
                const clampedDist = Math.max(dist, MIN_REPULSION_DISTANCE);
                const force = (REPULSION_STRENGTH / (clampedDist * clampedDist)) * warmupMultiplier;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                
                const massA = getNodeMass(nodeA.id);
                const massB = getNodeMass(nodeB.id);
                
                if (!nodeA.pinned) {
                  nodeA.vx -= fx / massA;
                  nodeA.vy -= fy / massA;
                }
                if (!nodeB.pinned) {
                  nodeB.vx += fx / massB;
                  nodeB.vy += fy / massB;
                }
              }
            }
          }
        }
      }
      
      // Dragged node pulls connected visible nodes
      if (dragNodeRef.current && dragNodeRef.current.visible) {
        const dragNode = dragNodeRef.current;
        const connected = getConnectedNodes(dragNode.id);
        
        // Build lookup map for O(1) access
        const nodeMap = new Map(nodes.map(n => [n.id, n]));
        
        for (const connectedId of connected) {
          const connectedNode = nodeMap.get(connectedId);
          if (!connectedNode || connectedNode.pinned || !connectedNode.visible) continue;
          
          const dx = dragNode.x - connectedNode.x;
          const dy = dragNode.y - connectedNode.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          if (dist > LINKED_ATTRACTION_DISTANCE) {
            const mass = getNodeMass(connectedNode.id);
            // Scale drag pull by link type (reference links pull much less)
            const linkType = getConnectionType(dragNode.id, connectedId);
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
        
        // Update drag lift animation progress
        if (dragStartTimeRef.current !== null) {
          const elapsed = Date.now() - dragStartTimeRef.current;
          dragLiftProgressRef.current = Math.min(1, elapsed / 150); // 150ms to fully lift
        }
      } else {
        // Animate lift down when not dragging
        if (dragLiftProgressRef.current > 0) {
          dragLiftProgressRef.current = Math.max(0, dragLiftProgressRef.current - 0.1);
        }
      }
      
      // Update positions (for all nodes including hidden ones, but they won't be rendered)
      for (const node of visibleNodes) {
        if (dragNodeRef.current?.id !== node.id && !node.pinned) {
          // Clamp velocity to prevent explosive movement
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
        }
      }
      
      renderRef.current?.(ctx);
      animationRef.current = requestAnimationFrame(simulate);
    };
    
    simulate();
  }, [viewMode, getConnectedNodes]);

  // Start simulation once on mount
  useEffect(() => {
    startSimulation();
    
    return () => {
      if (animationRef.current !== 0) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = 0;
      }
    };
  }, [startSimulation]);

  // Render function
  const render = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: w, height: h } = dimensions;
    const t = transformRef.current;
    const currentSettings = settingsRef.current;
    const currentClassColors = classColorsRef.current;
    const nodes = nodesRef.current;
    const links = linksRef.current;
    
    ctx.clearRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.scale, t.scale);
    
    const style = getComputedStyle(document.documentElement);
    const textColor = style.getPropertyValue('--text-primary').trim() || '#333';
    const accentColor = style.getPropertyValue('--color-secondary').trim() || '#6366f1';
    const dimColor = style.getPropertyValue('--color-surface-variant').trim() || '#404040';
    
    // All nodes in nodesRef are visible (filtering handled by visibility effect)
    const visibleNodes = nodes.filter(n => n.visible);
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));
    const currentFilters = visibilityFiltersRef.current;
    const visibleLinks = links.filter(l => {
      // Link must connect two visible nodes
      if (!visibleNodeIds.has(l.source) || !visibleNodeIds.has(l.target)) return false;
      // Apply link visibility filters
      if (!shouldLinkBeActive(l, currentFilters)) return false;
      return true;
    });
    
    // Calculate max connection counts and mass for node sizing
    let maxConnections = 0, maxMass = 0;
    for (const node of visibleNodes) {
      maxConnections = Math.max(maxConnections, node.connectionCount);
      maxMass = Math.max(maxMass, (node as GraphNode & { _mass?: number })._mass ?? 1);
    }
    
    // Build link direction map - check if reverse link exists for bidirectional arrows
    const linkDirections = new Map<string, { forward: boolean; reverse: boolean }>();
    for (const link of visibleLinks) {
      const key = `${Math.min(link.source, link.target)}-${Math.max(link.source, link.target)}`;
      if (!linkDirections.has(key)) {
        linkDirections.set(key, { forward: false, reverse: false });
      }
      const dir = linkDirections.get(key)!;
      if (link.source < link.target) {
        dir.forward = true;
      } else {
        dir.reverse = true;
      }
    }
    
    // Draw links (deduped - draw each pair only once)
    const drawnLinks = new Set<string>();
    const nodeMap = new Map(visibleNodes.map(n => [n.id, n]));
    
    for (const link of visibleLinks) {
      const source = nodeMap.get(link.source);
      const target = nodeMap.get(link.target);
      if (!source || !target) continue;
      
      // Skip if we've already drawn this link pair
      const linkKey = `${Math.min(link.source, link.target)}-${Math.max(link.source, link.target)}-${link.type}`;
      if (drawnLinks.has(linkKey)) continue;
      drawnLinks.add(linkKey);
      
      const isParentLink = link.type === 'parent';
      const isClassLink = link.type === 'class';
      const isExtendsLink = link.type === 'extends';
      const dirKey = `${Math.min(link.source, link.target)}-${Math.max(link.source, link.target)}`;
      const directions = linkDirections.get(dirKey);
      
      // Treat parent and extends links the same for rendering (solid line, hollow dot)
      const renderAsParent = isParentLink || isExtendsLink;
      
      ctx.beginPath();
      // Use gray color for all link types
      ctx.strokeStyle = 'rgba(100, 100, 100, 0.4)';
      ctx.lineWidth = 1.5;
      
      // Set line style: solid for parent/extends, dotted for reference
      // Class links will be drawn as wavy lines manually
      if (renderAsParent || isClassLink) {
        ctx.setLineDash([]);
      } else {
        ctx.setLineDash([2, 3]); // Dotted for reference links
      }
      
      // Calculate glare radius to determine line endpoints
      // Dot is positioned at glareRadius + 2, so line should end at glareRadius + 2 + dotSize to avoid overlap
      const arrowGap = 2;
      
      const getLineGlareRadius = (node: GraphNode) => {
        const nodeRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass);
        switch (node.glare) {
          case 'bright':
            return nodeRadius * GLARE_SCALE_BRIGHT;
          case 'current':
            return nodeRadius * GLARE_SCALE_CURRENT;
          default:
            return nodeRadius * GLARE_SCALE_NORMAL;
        }
      };
      
      const sourceLineGlare = getLineGlareRadius(source);
      const targetLineGlare = getLineGlareRadius(target);
      
      // Determine if there are dots at each end
      const dotSize = 4;
      const hasTargetDot = renderAsParent || link.source === source.id;
      const hasSourceDot = !renderAsParent && directions?.forward && directions?.reverse;
      
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
      
      // Draw arrows
      
      // Calculate glare radius for proper positioning
      const getGlareRadius = (node: GraphNode) => {
        const nodeRadius = getNodeRadius(node, currentSettings.nodeSizeMode, maxConnections, maxMass);
        switch (node.glare) {
          case 'bright':
            return nodeRadius * GLARE_SCALE_BRIGHT;
          case 'current':
            return nodeRadius * GLARE_SCALE_CURRENT;
          default:
            return nodeRadius * GLARE_SCALE_NORMAL;
        }
      };
      
      const sourceGlareRadius = getGlareRadius(source);
      const targetGlareRadius = getGlareRadius(target);
      
      // Helper function to draw a solid circle (for reference and class links)
      const drawSolidCircle = (fromX: number, fromY: number, toX: number, toY: number, glareRadius: number) => {
        const angle = Math.atan2(toY - fromY, toX - fromX);
        const circleX = toX - (glareRadius + 2 + dotSize / 2) * Math.cos(angle);
        const circleY = toY - (glareRadius + 2 + dotSize / 2) * Math.sin(angle);
        
        ctx.beginPath();
        ctx.arc(circleX, circleY, dotSize / 2, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(100, 100, 100, 0.8)';
        ctx.fill();
      };
      
      // Helper function to draw a hollow circle (for parent links)
      const drawHollowCircle = (fromX: number, fromY: number, toX: number, toY: number, glareRadius: number) => {
        const angle = Math.atan2(toY - fromY, toX - fromX);
        const circleX = toX - (glareRadius + 2 + dotSize / 2) * Math.cos(angle);
        const circleY = toY - (glareRadius + 2 + dotSize / 2) * Math.sin(angle);
        
        ctx.beginPath();
        ctx.arc(circleX, circleY, dotSize / 2, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(100, 100, 100, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.stroke();
      };
      
      // Helper function to check if we should skip dots for system types
      const shouldSkipDot = (targetNode: GraphNode) => {
        // Skip dots for "page" and "class" system types using their UUIDs
        return targetNode.uuid === '00000000-0000-0000-0001-000000000001' || // class
               targetNode.uuid === '00000000-0000-0000-0001-000000000002';   // page
      };
      
      if (renderAsParent) {
        // Parent and extends links have a hollow circle pointing to child/derived (target)
        if (!shouldSkipDot(target)) {
          drawHollowCircle(source.x, source.y, target.x, target.y, targetGlareRadius);
        }
      } else {
        // Reference links - draw solid circles
        // Solid circle pointing from source to target (at target end)
        if (link.source === source.id && !shouldSkipDot(target)) {
          drawSolidCircle(source.x, source.y, target.x, target.y, targetGlareRadius);
        }
        
        // If bidirectional, draw solid circle pointing back (at source end)
        if (directions?.forward && directions?.reverse && !shouldSkipDot(source)) {
          drawSolidCircle(target.x, target.y, source.x, source.y, sourceGlareRadius);
        }
      }
    }
    
    ctx.setLineDash([]);
    
    // Draw level circle guides in tree mode
    if (viewMode === 'tree') {
      const centerX = dimensions.width / 2;
      const centerY = dimensions.height / 2;
      const levelGap = 100;
      const maxRadius = Math.min(centerX, centerY) * 0.9;
      
      // Find which levels have visible nodes (based on distance from center)
      const levelsWithNodes = new Set<number>();
      for (const node of visibleNodes) {
        const dist = Math.sqrt((node.targetX - centerX) ** 2 + (node.targetY - centerY) ** 2);
        const depth = Math.round(dist / levelGap);
        if (depth > 0) { // Skip nodes at center (depth 0 means distance < levelGap/2)
          levelsWithNodes.add(depth);
        }
      }
      
      ctx.strokeStyle = 'rgba(100, 100, 100, 0.1)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      
      // Only draw circles for levels that actually have nodes
      for (const depth of levelsWithNodes) {
        const radius = Math.min(levelGap * depth, maxRadius);
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
    
    // Get dragged node info for shadow rendering
    const draggedNodeId = dragNodeRef.current?.id ?? null;
    const liftProgress = dragLiftProgressRef.current;
    
    // Draw nodes (dragged node last to be on top)
    const sortedNodes = [...visibleNodes].sort((a, b) => {
      if (a.id === draggedNodeId) return 1;
      if (b.id === draggedNodeId) return -1;
      return 0;
    });
    
    for (const node of sortedNodes) {
      if (!node.visible) continue;
      
      const isHovered = hoveredNode?.id === node.id;
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
      
      // Draw pin indicator
      if (node.pinned) {
        ctx.beginPath();
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.arc(node.x, node.y, circleRadius + 6, 0, 2 * Math.PI);
        ctx.stroke();
      }
      
      // Draw node circle
      let displayColor = nodeColor;
      if (node.glare === 'dim') {
        displayColor = dimColor;
      }
      
      ctx.beginPath();
      ctx.fillStyle = displayColor;
      ctx.arc(node.x, node.y, circleRadius, 0, 2 * Math.PI);
      ctx.fill();
      
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
    
    ctx.restore();
  }, [dimensions, hoveredNode, viewMode]);

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
      setTransform(prev => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy
      }));
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
      dragNodeRef.current.vx = 0;
      dragNodeRef.current.vy = 0;
    } else {
      const node = getNodeAtPosition(screenX, screenY);
      setHoveredNode(node);
      onHoveredNodeChange?.(node);
    }
  }, [getCanvasCoordinates, getNodeAtPosition, screenToWorld, onHoveredNodeChange]);

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

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const { x: screenX, y: screenY } = getCanvasCoordinates(e);
    
    const delta = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.001;
    const zoomFactor = Math.exp(delta);
    const newScale = Math.min(Math.max(transform.scale * zoomFactor, 0.1), 5);
    
    const scaleChange = newScale / transform.scale;
    const newX = screenX - (screenX - transform.x) * scaleChange;
    const newY = screenY - (screenY - transform.y) * scaleChange;
    
    setTransform({
      x: newX,
      y: newY,
      scale: newScale
    });
  }, [getCanvasCoordinates, transform]);

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
        onWheel={handleWheel}
        style={{ cursor: hoveredNode ? 'pointer' : isPanningRef.current ? 'grabbing' : 'grab' }}
      />
    </div>
  );
});

export default NodeGraphRenderer;
