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
