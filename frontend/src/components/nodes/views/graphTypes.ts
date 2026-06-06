/**
 * Graph Type Definitions
 *
 * Shared type definitions for graph view components.
 * These types are used by:
 * - NodeGraphRenderer (graph visualization)
 * - GraphView (graph settings wrapper)
 */

import type { QueryAST } from '@/types/queryAST';

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
  aliased_id?: number | null;
}

/**
 * Link between two graph nodes
 */
export interface GraphLink {
  source: number;
  target: number;
  type: 'parent' | 'reference' | 'property-reference' | 'class' | 'extends' | 'cooccurrence' | 'temporal' | 'alias';
  /** Co-occurrence strength (number of shared blocks/contexts). Higher = stronger relation. */
  weight?: number;
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
 * Graph color group — QueryAST + color for unified graph coloring
 */
export interface GraphColorGroup {
  id: string;
  name: string;
  query: QueryAST;
  color: string;
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
  /** Minimum co-occurrence weight to show a link (0 = all). Only affects co-occurrence mode. */
  minLinkWeight: number;
  /** Physics density preset: sparse (large graphs), balanced (medium), compact (small), clustered (tight communities). */
  physicsPreset: 'sparse' | 'balanced' | 'compact' | 'clustered';
  /** Enable tapered edges (wider at source, narrower at target). */
  taperedEdges: boolean;
  /** Enable edge color gradients from source to target node color. */
  coloredEdges: boolean;
  /** Enable curved edges with per-link-type curvature. */
  curvedEdges: boolean;
  /** Hide weaker link types when zoomed out. */
  enableLinkLOD: boolean;
  /** Dim links between different communities. */
  dimCrossCommunityLinks: boolean;
  /** Bundle parallel edges into thicker single edges. */
  aggregateParallelEdges: boolean;
  /** Show synthetic temporal links between consecutive daily/monthly/yearly pages. */
  showTemporalLinks: boolean;
  /** Increase clustering strength and repulsion for clearer community separation. */
  strongClustering: boolean;
  /** Highlight shortest paths between selected nodes. */
  highlightPaths: boolean;
}

/**
 * Node visibility filters
 */
/**
 * Graph data mode: standard explicit links vs co-occurrence inference
 */
export type GraphDataMode = 'standard' | 'cooccurrence';

export interface VisibilityFilters {
  showClassNodes: boolean;
  showClassLinks: boolean;
  showParentLinks: boolean;
  showReferenceLinks: boolean;
  showDayPages: boolean;
  showMonthPages: boolean;
  showYearPages: boolean;
  showSystemPages: boolean;
  /** When true (local graph only), the center/ego node is hidden to reveal neighbor relations */
  hideSelfNode?: boolean;
  /** Hide nodes with no visible connections (orphans) */
  hideOrphans: boolean;
  /** Show alias nodes; when false aliases are hidden and their links are redirected to the main node */
  showAliases?: boolean;
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
  minLinkWeight: 0,
  physicsPreset: 'balanced',
  taperedEdges: true,
  coloredEdges: true,
  curvedEdges: true,
  enableLinkLOD: true,
  dimCrossCommunityLinks: true,
  aggregateParallelEdges: true,
  showTemporalLinks: false,
  strongClustering: false,
  highlightPaths: true,
};

export const DEFAULT_VISIBILITY_FILTERS: VisibilityFilters = {
  showClassNodes: true,
  showClassLinks: true,
  showParentLinks: true,
  showReferenceLinks: true,
  showDayPages: false,
  showMonthPages: false,
  showYearPages: false,
  showSystemPages: false,
  hideSelfNode: false,
  hideOrphans: false,
  showAliases: false,
};
