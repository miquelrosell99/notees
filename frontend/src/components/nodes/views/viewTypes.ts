/**
 * View Types Module
 * 
 * Shared type definitions for graph view components.
 * These types are used by:
 * - NodeGraphRenderer (graph visualization)
 * - GraphView (graph settings wrapper)
 */

// ==================== Core Types ====================

export type GlareState = 'normal' | 'bright' | 'dim' | 'path' | 'current';
export type NodeSizeMode = 'uniform' | 'connections' | 'mass' | 'content';
export type ConstraintMode = 'physics' | 'equidistant';
export type LinkDirection = 'in' | 'out' | 'all';
export type HeightMode = 'hierarchy' | 'references';
export type PeakSizeMode = 'links' | 'pageSize';

/**
 * Graph layout mode (for NodeGraphRenderer only)
 */
export type GraphLayoutMode = 'normal' | 'circle' | 'tree';

/**
 * All view modes (used by facade)
 */
export type GraphViewMode = 'normal' | 'circle' | 'tree';

/**
 * Available graph view modes for UI selection
 */
export const GRAPH_VIEW_MODES: GraphViewMode[] = ['normal', 'circle', 'tree'];

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
  contentSize: number;
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
  type: 'parent' | 'reference' | 'property-reference' | 'class' | 'extends' | 'semantic';
}

/**
 * Class color configuration
 */
export interface ClassColor {
  classId: number;
  className: string;
  color: string;
  order: number;
}

/**
 * Graph settings
 */
export interface GraphSettings {
  linkCountAttraction: boolean;
  centralGravity: boolean;
  nodeSizeMode: NodeSizeMode;
  heightMode: HeightMode;
  peakSizeMode: PeakSizeMode;
  constraintMode: ConstraintMode;
  linkDirection: LinkDirection;
  showDebugGrid?: boolean;
}

/**
 * Node visibility filters
 */
/**
 * Graph data mode: standard explicit links vs semantic co-occurrence links
 */
export type GraphDataMode = 'standard' | 'semantic';

export interface VisibilityFilters {
  showClassNodes: boolean;
  showClassLinks: boolean;
  showParentLinks: boolean;
  showReferenceLinks: boolean;
  showDayPages: boolean;
  showMonthPages: boolean;
  showYearPages: boolean;
  showSystemPages: boolean;
  /** Show inferred semantic co-occurrence links (only relevant in semantic mode) */
  showSemanticLinks: boolean;
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
  maxContentSize: number;
}

// ==================== Defaults ====================

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  linkCountAttraction: false,
  centralGravity: true,
  nodeSizeMode: 'uniform',
  heightMode: 'hierarchy',
  peakSizeMode: 'links',
  constraintMode: 'physics',
  linkDirection: 'all',
  showDebugGrid: false,
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
  showSemanticLinks: true,
};

// ==================== Physics Constants ====================

// Linked pair attraction (Logseq: distance 70, strength 0.1)
// LINKED_ATTRACTION_DISTANCE is the BASE rest distance for leaf→hub links (degree 1).
// For hub→hub links, rest distance scales up with min(degreeA, degreeB).
export const LINKED_ATTRACTION_DISTANCE = 70;
export const LINK_DISTANCE_DEGREE_SCALE = 15;  // extra distance per log2(minDegree)
export const ATTRACTION_STRENGTH = 0.1;
export const ATTRACTION_STRENGTH_LINK_COUNT = 0.025;
export const LINK_DAMPING = 0.45;

// Unlinked repulsion
export const REPULSION_STRENGTH = 3000;
export const UNLINKED_REPULSION_DISTANCE = 500;
export const MIN_REPULSION_DISTANCE = 1;

// Return-to-target force (constrained modes)
export const RETURN_FORCE = 0.05;

// Center gravity: weak force pulling all nodes toward canvas center.
// Connected nodes resist via springs; orphans settle at the radius where
// gravity = repulsion, forming a natural ring at the periphery.
// This is equivalent to d3.forceX(cx) + d3.forceY(cy) with the given strength.
export const CENTER_GRAVITY_STRENGTH = 0.01;

// Velocity constraints (d3-force: velocityDecay=0.4 → multiply by 0.6)
// Logseq uses velocityDecay=0.6 → multiply by 0.4
export const VELOCITY_DAMPING = 0.6;   // Logseq: 0.4, d3 default: 0.6

// Alpha decay (d3-force style): forces scale by alpha which decays exponentially.
// Logseq: alphaDecay=0.02, d3 default: 0.0228
export const ALPHA_INITIAL = 1;
export const ALPHA_MIN = 0.001;
export const ALPHA_DECAY = 0.006;     // slower decay: ~600 ticks (~10s) to settle
export const ALPHA_TARGET = 0;
export const ALPHA_REHEAT = 0.3;

// Sleep tuning (uses average KE per node, not total)
export const GRAPH_SLEEP_THRESHOLD = 0.00005;
export const GRAPH_SLEEP_FRAMES = 30;

// Drag pull
export const DRAG_PULL_STRENGTH = 0.03;

// Mass accumulation
export const PARENT_MASS_PER_CHILD = 1.0;

// Reference link force multiplier (weaker than parent/class)
export const REFERENCE_LINK_FORCE_MULTIPLIER = 1.0;

// Barnes-Hut
export const BH_THETA = 0.7;
export const BH_THETA_SQ = BH_THETA * BH_THETA;

// Pre-computed squared distances (avoid sqrt in hot loops)
export const UNLINKED_REPULSION_DIST_SQ = UNLINKED_REPULSION_DISTANCE * UNLINKED_REPULSION_DISTANCE;

// Collision resolution (position-based)
export const TANGENTIAL_OVERLAP_RESOLVE = 0.15; // constrained-mode tangential correction

// ==================== Rendering Constants ====================

// LOD (Level of Detail) system for large graph performance
export type LODLevel = 0 | 1;

/** 
 * Compute LOD level based on node count and current zoom. 
 * - LOD 0: Full detail (glare, labels, styled links, arrow dots)
 * - LOD 1: Minimal (pixel dots, hairline links, batched by color)
 */
export const getLODLevel = (nodeCount: number, scale: number): LODLevel => {
  // "density" approximates how many nodes compete for screen space.
  const density = nodeCount / (scale * scale);
  if (density < 4000) return 0;
  return 1;
};

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
export const GLARE_OPACITY_DIM = 0.02;

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
  semantic: 0,
};

// Line dash patterns (allocated once)
export const LINE_DASH_NONE: number[] = [];
export const LINE_DASH_DOTTED = [3, 3];

// ==================== Helper Functions ====================

/**
 * Get render skip interval based on node count
 */
export const getRenderSkip = (nodeCount: number): number => {
  if (nodeCount < 200) return 1;
  if (nodeCount < 500) return 2;
  if (nodeCount < 1000) return 3;
  if (nodeCount < 2000) return 4;
  if (nodeCount < 4000) return 6;
  if (nodeCount < 8000) return 8;
  return 10;
};

/**
 * Generate numeric pair key
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
export const linkclassId = (type: GraphLink['type']): number => {
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
  maxContentSize: number = 0,
  linkDirection: LinkDirection = 'all'
): number => {
  if (nodeSizeMode === 'uniform') return NODE_RADIUS_BASE;
  
  if (nodeSizeMode === 'connections') {
    const count = linkDirection === 'in' ? node.inLinkCount 
      : linkDirection === 'out' ? node.outLinkCount 
      : node.connectionCount;
    const ratio = maxConnections > 0 ? Math.min(count / maxConnections, 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
  }
  
  if (nodeSizeMode === 'mass') {
    const mass = (node as GraphNode & { _mass?: number })._mass ?? 1;
    const ratio = maxMass > 1 ? Math.min((mass - 1) / (maxMass - 1), 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_MASS_SCALE);
  }

  if (nodeSizeMode === 'content') {
    const count = node.contentSize;
    const ratio = maxContentSize > 0 ? Math.min(count / maxContentSize, 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
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
  maxContentSize: number = 0,
  linkDirection: LinkDirection = 'all'
): number => {
  const baseRadius = getNodeRadius(node, nodeSizeMode, maxConnections, maxMass, maxContentSize, linkDirection);
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
  for (const classId of node.types || []) {
    const classColor = classColors.find(cc => cc.classId === classId);
    if (classColor) return classColor.color;
  }
  
  return defaultColor;
};

/**
 * Convert hex color to rgba (cached for hot-path rendering)
 */
const _hexToRgbaCache = new Map<string, string>();
export const hexToRgba = (hex: string, alpha: number): string => {
  // Quantize alpha to 2 decimal places to improve cache hit rate
  const a = Math.round(alpha * 100) / 100;
  const key = hex + a;
  let result = _hexToRgbaCache.get(key);
  if (result !== undefined) return result;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  result = `rgba(${r}, ${g}, ${b}, ${a})`;
  // Cap cache size to prevent unbounded growth
  if (_hexToRgbaCache.size > 2000) _hexToRgbaCache.clear();
  _hexToRgbaCache.set(key, result);
  return result;
};

/**
 * Find all shortest paths between two nodes using BFS
 * Returns all nodes that appear in any shortest path
 */
export const findAllShortestPaths = (
  startId: number,
  endId: number,
  nodes: GraphNode[],
  links: GraphLink[]
): Set<number> => {
  if (startId === endId) return new Set([startId]);
  
  // Build adjacency list
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const link of links) {
    adjacency.get(link.source)?.push(link.target);
    adjacency.get(link.target)?.push(link.source);
  }
  
  // BFS to find shortest distance and track all parents
  const distance = new Map<number, number>();
  const parents = new Map<number, number[]>();
  const queue: number[] = [startId];
  distance.set(startId, 0);
  parents.set(startId, []);
  
  let found = false;
  
  while (queue.length > 0 && !found) {
    const current = queue.shift()!;
    const currentDist = distance.get(current)!;
    
    if (current === endId) {
      found = true;
      break;
    }
    
    for (const neighbor of adjacency.get(current) || []) {
      const neighborDist = distance.get(neighbor);
      
      if (neighborDist === undefined) {
        // First time visiting this node
        distance.set(neighbor, currentDist + 1);
        parents.set(neighbor, [current]);
        queue.push(neighbor);
      } else if (neighborDist === currentDist + 1) {
        // Found another shortest path to this node
        parents.get(neighbor)?.push(current);
      }
    }
  }
  
  if (!found) return new Set();
  
  // Reconstruct all nodes in all shortest paths using DFS
  const nodesInPaths = new Set<number>();
  
  const dfs = (nodeId: number) => {
    if (nodesInPaths.has(nodeId)) return;
    nodesInPaths.add(nodeId);
    
    const nodeParents = parents.get(nodeId) || [];
    for (const parent of nodeParents) {
      dfs(parent);
    }
  };
  
  dfs(endId);
  
  return nodesInPaths;
};

// ==================== Shared Color Palettes ====================

/** Resolve a CSS variable to its computed value */
const resolveCssColor = (varName: string, fallback: string): string => {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return val || fallback;
};

/** Preset color CSS variable names in order */
const PRESET_COLOR_VARS = [
  '--color-preset-red',
  '--color-preset-orange',
  '--color-preset-yellow',
  '--color-preset-green',
  '--color-preset-teal',
  '--color-preset-blue',
  '--color-preset-purple',
  '--color-preset-pink',
] as const;

/** Resolve class color palette from --color-preset-* CSS variables */
export const getClassColorPalette = (): string[] =>
  PRESET_COLOR_VARS.map(v => resolveCssColor(v, '#808080'));

/** Resolve node picker palette from --color-preset-* CSS variables (with null = no color) */
export const getNodePickerPalette = (): (string | null)[] => [
  null,
  ...getClassColorPalette(),
];

/** Resolve date lane palette (subset of preset colors) */
export const getDateLanePalette = (): string[] => {
  const vars = [
    '--color-preset-red',
    '--color-preset-purple',
    '--color-preset-pink',
    '--color-preset-yellow',
    '--color-preset-orange',
    '--color-preset-teal',
  ];
  return vars.map(v => resolveCssColor(v, '#808080'));
};
