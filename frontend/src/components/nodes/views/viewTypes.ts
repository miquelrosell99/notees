/**
 * View Types Module
 * 
 * Shared type definitions for graph and terrain view components.
 * These types are used by:
 * - NodeGraphRenderer (graph visualization)
 * - GraphView (graph settings wrapper)
 * - TerrainView (terrain visualization wrapper)
 */

// ==================== Core Types ====================

export type GlareState = 'normal' | 'bright' | 'dim' | 'path' | 'current';
export type NodeSizeMode = 'uniform' | 'connections' | 'mass';
export type ConstraintMode = 'physics' | 'equidistant';
export type LinkDirection = 'in' | 'out' | 'all';

/**
 * Graph layout mode (for NodeGraphRenderer only)
 * Terrain has its own separate view mode now
 */
export type GraphLayoutMode = 'normal' | 'circle' | 'tree';

/**
 * All view modes including terrain (used by facade)
 */
export type GraphViewMode = 'normal' | 'circle' | 'tree' | 'terrain';

/**
 * Available graph view modes for UI selection
 */
export const GRAPH_VIEW_MODES: GraphViewMode[] = ['normal', 'circle', 'tree', 'terrain'];

/**
 * Graph node representation for physics simulation
 */
export interface GraphNode {
  id: number;
  uuid: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  name: string; // Raw AST/JSON name from API
  displayName: string; // Cached plain text name for canvas rendering
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
  inLinkCount: number;
  outLinkCount: number;
  createdAt?: string;
  visible: boolean;
  isClassNode: boolean;
}

/**
 * Link between two graph nodes
 */
export interface GraphLink {
  source: number;
  target: number;
  type: 'parent' | 'reference' | 'property-reference' | 'class' | 'extends';
}

/**
 * Class color configuration
 */
export interface ClassColor {
  typeId: number;
  className: string;
  color: string;
  order: number;
}

/**
 * Graph settings (shared between graph and terrain)
 */
export interface GraphSettings {
  linkCountAttraction: boolean;
  nodeSizeMode: NodeSizeMode;
  massAccumulation: boolean;
  constraintMode: ConstraintMode;
  linkDirection: LinkDirection;
}

/**
 * Node visibility filters
 */
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

// ==================== Physics Types ====================

/**
 * Barnes-Hut quadtree node for O(n log n) force calculation
 */
export interface QuadNode {
  cx: number; cy: number; // center of mass
  mass: number;           // total mass in this cell
  x0: number; y0: number; // bounds
  x1: number; y1: number;
  c0: QuadNode | null; c1: QuadNode | null; // NW, NE (flat fields instead of array)
  c2: QuadNode | null; c3: QuadNode | null; // SW, SE
  nodeIdx: number;        // -1 if internal, otherwise index into visibleNodes
}

/**
 * Transform state for pan/zoom
 */
export interface Transform {
  x: number;
  y: number;
  scale: number;
}

/**
 * Canvas dimensions
 */
export interface Dimensions {
  width: number;
  height: number;
}

// ==================== Frame Data ====================

/**
 * Data shared between physics simulation and render phase
 */
export interface FrameData {
  visibleNodes: GraphNode[];
  visibleLinks: GraphLink[];
  nodeMap: Map<number, GraphNode>;
  maxConnections: number;
  maxMass: number;
  terrainHeights: Map<number, number>; // nodeId → normalized height [0,1]
  terrainPeakRadii: Map<number, number>; // nodeId → normalized peak radius [0,1]
}

// ==================== Defaults ====================

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  linkCountAttraction: false,
  nodeSizeMode: 'uniform',
  massAccumulation: true,
  constraintMode: 'physics',
  linkDirection: 'all',
};

export const DEFAULT_VISIBILITY_FILTERS: VisibilityFilters = {
  showClassNodes: true,
  showClassLinks: true,
  showParentLinks: true,
  showReferenceLinks: true,
  showDayPages: true,
  showMonthPages: true,
  showYearPages: true,
  showSystemPages: true,
};

// ==================== Physics Constants ====================

// Linked pair attraction
export const LINKED_ATTRACTION_DISTANCE = 120;
export const ATTRACTION_STRENGTH = 0.015;
export const ATTRACTION_STRENGTH_LINK_COUNT = 0.005;
export const LINK_DAMPING = 0.08;

// Unlinked repulsion
export const REPULSION_STRENGTH = 4000;
export const UNLINKED_REPULSION_DISTANCE = 500;
export const MIN_REPULSION_DISTANCE = 20;

// Return-to-target force (constrained modes)
export const RETURN_FORCE = 0.05;

// Centering gravity (initial warmup)
export const CENTER_GRAVITY = 0.001;

// Velocity constraints
export const MAX_VELOCITY = 15;
export const VELOCITY_DAMPING = 0.92;
export const VELOCITY_DEADZONE = 0.01;
export const TERRAIN_VELOCITY_DAMPING = 0.85;
export const TERRAIN_VELOCITY_DEADZONE = 0.05;

// Drag pull
export const DRAG_PULL_STRENGTH = 0.03;

// Mass accumulation
export const PARENT_MASS_PER_CHILD = 1.0;

// Reference link force multiplier (weaker than parent/class)
export const REFERENCE_LINK_FORCE_MULTIPLIER = 0.3;

// Simulation warmup & limits
export const WARMUP_DURATION_FRAMES = 45;
export const MAX_SIMULATION_TIME_MS = 0; // 0 = unlimited

// ==================== Terrain Physics Constants ====================

export const TERRAIN_BASE_FOOTPRINT = 60;
export const TERRAIN_PEAK_FOOTPRINT = 120;
export const TERRAIN_SEPARATION_STRENGTH = 0.15;
export const TERRAIN_MIN_SEPARATION = 5;

// ==================== Rendering Constants ====================

// Node radii
export const NODE_RADIUS_BASE = 6;
export const NODE_RADIUS_MIN = 4;
export const NODE_RADIUS_MAX = 18;
export const NODE_RADIUS_MASS_SCALE = 0.8;
export const NODE_RADIUS_CONN_SCALE = 0.7;
export const NODE_HOVER_RADIUS_EXTRA = 2;

// Glare
export const GLARE_SCALE_NORMAL = 2.5;
export const GLARE_SCALE_BRIGHT = 3.0;
export const GLARE_SCALE_CURRENT = 3.5;
export const GLARE_OPACITY_NORMAL = 0.15;
export const GLARE_OPACITY_BRIGHT = 0.25;
export const GLARE_OPACITY_DIM = 0.05;

// Label fade based on zoom
export const LABEL_FADE_ZOOM_MIN = 0.3;
export const LABEL_FADE_ZOOM_MAX = 0.6;

// Link type priority
export const LINK_TYPE_PRIORITY: Record<GraphLink['type'], number> = {
  parent: 3,
  extends: 3,
  class: 2,
  'property-reference': 1,
  reference: 0,
};

// Terrain height map parameters
export const TERRAIN_MIN_HEIGHT = 0.15;

// Terrain contour levels (evenly spaced between MIN_HEIGHT and 1.0)
export const TERRAIN_CONTOUR_COUNT = 10;
export const CONTOUR_LEVELS: number[] = Array.from(
  { length: TERRAIN_CONTOUR_COUNT },
  (_, i) => TERRAIN_MIN_HEIGHT + (1 - TERRAIN_MIN_HEIGHT) * (i + 1) / (TERRAIN_CONTOUR_COUNT + 1)
);

// Terrain height map parameters
export const TERRAIN_GRID_RES = 4;
export const TERRAIN_BASE_PLATEAU_RADIUS = 20;
export const TERRAIN_PEAK_PLATEAU_BONUS = 25;
export const TERRAIN_BASE_SLOPE_RADIUS = 160;
export const TERRAIN_PEAK_SLOPE_BONUS = 200;
export const TERRAIN_ANISOTROPY = 0.25; // 0 = perfect circle, 1 = fully stretched toward parent links
export const TERRAIN_NOISE_STRENGTH = 0.12; // 0 = smooth circles, higher = more irregular contour shapes

// Terrain ridge parameters (parent-child connections)
export const TERRAIN_RIDGE_PLATEAU_RADIUS = 5;
export const TERRAIN_RIDGE_PLATEAU_BONUS = 8;
export const TERRAIN_RIDGE_SLOPE_RADIUS = 20;
export const TERRAIN_RIDGE_SLOPE_BONUS = 40;
export const TERRAIN_RIDGE_SAG = 0.15; // Height dip at ridge midpoint (0-1)

// Line dash patterns (allocated once)
export const LINE_DASH_NONE: number[] = [];
export const LINE_DASH_DOTTED = [3, 3];

// ==================== Helper Functions ====================

/**
 * Get max simulation frames based on node count to prevent runaway
 */
export const getMaxSimulationFrames = (nodeCount: number): number => {
  if (nodeCount < 50) return 0; // No limit for small graphs
  if (nodeCount < 200) return 3000;
  if (nodeCount < 500) return 2000;
  return 1500;
};

/**
 * Get render skip interval based on node count
 */
export const getRenderSkip = (nodeCount: number): number => {
  if (nodeCount < 200) return 1;
  if (nodeCount < 500) return 2;
  if (nodeCount < 1000) return 3;
  return 4;
};

/**
 * Generate numeric pair key (order-independent) for link deduplication
 */
export const pairKey = (a: number, b: number): number => {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * 1000000 + hi;
};

/**
 * Convert link type to numeric id for cache keys
 */
export const linkTypeId = (type: GraphLink['type']): number => {
  switch (type) {
    case 'parent': return 0;
    case 'reference': return 1;
    case 'class': return 2;
    case 'property-reference': return 3;
    case 'extends': return 4;
    default: return 9;
  }
};

/**
 * Get node radius based on size mode
 */
export const getNodeRadius = (
  node: GraphNode,
  nodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
  linkDirection: LinkDirection = 'all'
): number => {
  if (nodeSizeMode === 'uniform') return NODE_RADIUS_BASE;
  
  if (nodeSizeMode === 'connections') {
    const mass = (node as GraphNode & { _mass?: number })._mass ?? 1;
    const count = linkDirection === 'in' ? node.inLinkCount 
      : linkDirection === 'out' ? node.outLinkCount 
      : node.connectionCount;
    const ratio = maxConnections > 0 ? count / maxConnections : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
  }
  
  if (nodeSizeMode === 'mass') {
    const mass = (node as GraphNode & { _mass?: number })._mass ?? 1;
    const ratio = maxMass > 1 ? (mass - 1) / (maxMass - 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_MASS_SCALE);
  }
  
  return NODE_RADIUS_BASE;
};

/**
 * Get glare radius for a node
 */
export const getGlareRadius = (
  node: GraphNode,
  nodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
  linkDirection: LinkDirection = 'all'
): number => {
  const baseRadius = getNodeRadius(node, nodeSizeMode, maxConnections, maxMass, linkDirection);
  return baseRadius * GLARE_SCALE_NORMAL;
};

/**
 * Get node color based on class or default
 */
export const getNodeColor = (
  node: GraphNode,
  classColors: ClassColor[],
  defaultColor: string
): string => {
  // Check if node has a color override
  if (node.color) return node.color;
  
  // Check class colors by type ID (node.types array)
  for (const typeId of node.types || []) {
    const classColor = classColors.find(cc => cc.typeId === typeId);
    if (classColor) return classColor.color;
  }
  
  return defaultColor;
};

/**
 * Convert hex color to rgba
 */
export const hexToRgba = (hex: string, alpha: number): string => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * Find path between two nodes using BFS
 */
export const findPathBetweenNodes = (
  startId: number,
  endId: number,
  nodes: GraphNode[],
  links: GraphLink[]
): number[] => {
  if (startId === endId) return [startId];
  
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
      let nodeId = endId;
      while (nodeId !== startId) {
        path.unshift(nodeId);
        nodeId = parent.get(nodeId)!;
      }
      path.unshift(startId);
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
};
