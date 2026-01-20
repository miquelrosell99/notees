/**
 * View Types for Notees
 * 
 * Defines the various view configurations for displaying nodes.
 */
import type { Node } from './api';

// ==================== Common View Types ====================

/**
 * Base view mode options available across different contexts
 */
export type ViewMode = 'list' | 'cards' | 'kanban' | 'calendar' | 'chart' | 'gantt' | 'graph' | 'table';

/**
 * View configuration base
 */
export interface ViewConfig {
  mode: ViewMode;
  title?: string;
}

// ==================== Chart View ====================

/**
 * Chart types supported
 */
export type ChartType = 'bar' | 'line' | 'pie' | 'donut' | 'area' | 'scatter';

/**
 * Number source for chart - either count nodes or use a number property
 */
export type ChartNumberSource = 
  | { type: 'count' }
  | { type: 'property'; propertyId: number };

/**
 * Aggregation method for number values
 */
export type ChartAggregation = 'sum' | 'avg' | 'min' | 'max' | 'count';

/**
 * Chart view configuration
 */
export interface ChartViewConfig extends ViewConfig {
  mode: 'chart';
  /** Type of chart to display */
  chartType: ChartType;
  /** Property to group by (X-axis for bar/line, segments for pie) */
  groupByPropertyId: number | null;
  /** Source of the number values (Y-axis) */
  numberSource: ChartNumberSource;
  /** Aggregation method when using property values */
  aggregation: ChartAggregation;
  /** Show labels on chart */
  showLabels: boolean;
  /** Show legend */
  showLegend: boolean;
  /** Color palette */
  colorPalette?: string[];
}

/**
 * Data point for chart
 */
export interface ChartDataPoint {
  label: string;
  value: number;
  nodes: Node[];
  color?: string;
}

// ==================== Gantt View ====================

/**
 * Gantt view configuration
 */
export interface GanttViewConfig extends ViewConfig {
  mode: 'gantt';
  /** Property for start date */
  startDatePropertyId: number | null;
  /** Property for end date */
  endDatePropertyId: number | null;
  /** Optional property for grouping rows */
  groupByPropertyId?: number | null;
  /** Time scale */
  timeScale: 'day' | 'week' | 'month';
  /** Show today marker */
  showTodayMarker: boolean;
  /** Show dependencies (if available) */
  showDependencies: boolean;
}

/**
 * Gantt item (a bar on the timeline)
 */
export interface GanttItem {
  id: number;
  node: Node;
  label: string;
  startDate: Date;
  endDate: Date;
  group?: string;
  progress?: number;
  color?: string;
}

// ==================== Query System ====================

/**
 * Simple query operators
 */
export type QueryOperator = 
  | 'equals' | 'not-equals'
  | 'contains' | 'not-contains'
  | 'starts-with' | 'ends-with'
  | 'greater-than' | 'less-than'
  | 'greater-or-equal' | 'less-or-equal'
  | 'is-empty' | 'is-not-empty'
  | 'is-true' | 'is-false'
  | 'before' | 'after' | 'between'
  | 'has-tag' | 'not-has-tag'
  | 'has-property' | 'not-has-property';

/**
 * Simple query condition
 */
export interface QueryCondition {
  type: 'tag' | 'property' | 'name' | 'date' | 'backlinks';
  /** For property conditions */
  propertyId?: number;
  /** For tag conditions */
  tagId?: number;
  /** Operator */
  operator: QueryOperator;
  /** Value to compare against */
  value?: unknown;
  /** Second value for 'between' operator */
  value2?: unknown;
}

/**
 * Simple query definition (like Logseq/Roam)
 */
export interface SimpleQuery {
  type: 'simple';
  /** Logical operator to combine conditions */
  logic: 'and' | 'or';
  /** Query conditions */
  conditions: QueryCondition[];
  /** Sort by */
  sortBy?: 'name' | 'create_date' | 'write_date' | { propertyId: number };
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
  /** Limit results */
  limit?: number;
  /** Only include pages */
  pagesOnly?: boolean;
}

// ==================== Advanced Query (Datalog) ====================

/**
 * Datalog variable (starts with ?)
 */
export type DatalogVar = `?${string}`;

/**
 * Datalog pattern types
 */
export type DatalogPattern = 
  | DatalogNodePattern
  | DatalogPropertyPattern
  | DatalogTagPattern
  | DatalogLinkPattern
  | DatalogPredicatePattern;

/**
 * Node pattern: [?node :node/name "value"]
 */
export interface DatalogNodePattern {
  type: 'node';
  variable: DatalogVar;
  attribute: 'name' | 'uuid' | 'parent' | 'page' | 'create-date' | 'write-date';
  value: DatalogVar | string | number | Date;
}

/**
 * Property pattern: [?node :prop/property-name ?value]
 */
export interface DatalogPropertyPattern {
  type: 'property';
  nodeVar: DatalogVar;
  propertyName: string;
  valueVar: DatalogVar | string | number | boolean | Date;
}

/**
 * Tag pattern: [?node :node/tag ?tag]
 */
export interface DatalogTagPattern {
  type: 'tag';
  nodeVar: DatalogVar;
  tagVar: DatalogVar | string | number;
}

/**
 * Link pattern: [?source :link/to ?target]
 */
export interface DatalogLinkPattern {
  type: 'link';
  sourceVar: DatalogVar;
  targetVar: DatalogVar;
  linkType?: 'page' | 'block';
}

/**
 * Predicate pattern: [(> ?value 10)]
 */
export interface DatalogPredicatePattern {
  type: 'predicate';
  fn: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'contains' | 'starts-with' | 'ends-with' | 'matches';
  args: (DatalogVar | string | number | boolean | Date | RegExp)[];
}

/**
 * Datalog query (advanced query)
 */
export interface DatalogQuery {
  type: 'datalog';
  /** Find clause - variables to return */
  find: DatalogVar[];
  /** Optional in clause for external inputs */
  in?: { name: string; value: unknown }[];
  /** Where clause - patterns to match */
  where: DatalogPattern[];
  /** Optional rules */
  rules?: DatalogRule[];
}

/**
 * Datalog rule for reusable query logic
 */
export interface DatalogRule {
  name: string;
  /** Head variables */
  head: DatalogVar[];
  /** Body patterns */
  body: DatalogPattern[];
}

/**
 * Combined query type
 */
export type Query = SimpleQuery | DatalogQuery;

/**
 * Saved query with metadata
 */
export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  query: Query;
  /** View configuration for results */
  viewConfig?: ViewConfig;
  /** Created timestamp */
  createdAt: string;
  /** Updated timestamp */
  updatedAt: string;
}

// ==================== Query View ====================

/**
 * Query view configuration
 */
export interface QueryViewConfig extends ViewConfig {
  mode: ViewMode;
  /** The query to execute */
  query: Query;
  /** Whether to show only pages in results */
  pagesOnly: boolean;
  /** Collapse query by default */
  collapsed?: boolean;
}

// ==================== Graph View (for filtered nodes) ====================

/**
 * Graph view configuration for displaying node relationships
 */
export interface GraphViewConfig extends ViewConfig {
  mode: 'graph';
  /** Only show page nodes */
  pagesOnly: boolean;
  /** Show orphan nodes */
  showOrphans: boolean;
  /** Depth of connections to show */
  depth: number;
  /** Node size based on */
  nodeSizeBy: 'equal' | 'connections' | 'backlinks';
}

// ==================== View Mode Helpers ====================

/**
 * Available view modes for different contexts
 */
export const VIEW_MODES_FOR_CONTEXT = {
  /** Tagged nodes / linked references */
  references: ['list', 'table', 'cards', 'graph'] as ViewMode[],
  /** Query results */
  query: ['list', 'table', 'cards', 'kanban', 'calendar', 'chart', 'gantt', 'graph'] as ViewMode[],
  /** All pages */
  pages: ['list', 'table', 'cards', 'calendar', 'chart', 'graph'] as ViewMode[],
} as const;

/**
 * Default chart colors
 */
export const DEFAULT_CHART_COLORS = [
  '#525252', // gray-600
  '#737373', // gray-500
  '#a3a3a3', // gray-400
  '#d4d4d4', // gray-300
  '#404040', // gray-700
  '#262626', // gray-800
];

/**
 * Create default chart view config
 */
export function createDefaultChartConfig(): ChartViewConfig {
  return {
    mode: 'chart',
    chartType: 'bar',
    groupByPropertyId: null,
    numberSource: { type: 'count' },
    aggregation: 'count',
    showLabels: true,
    showLegend: true,
    colorPalette: DEFAULT_CHART_COLORS,
  };
}

/**
 * Create default gantt view config
 */
export function createDefaultGanttConfig(): GanttViewConfig {
  return {
    mode: 'gantt',
    startDatePropertyId: null,
    endDatePropertyId: null,
    groupByPropertyId: null,
    timeScale: 'week',
    showTodayMarker: true,
    showDependencies: false,
  };
}

/**
 * Create default simple query
 */
export function createDefaultSimpleQuery(): SimpleQuery {
  return {
    type: 'simple',
    logic: 'and',
    conditions: [],
    sortBy: 'name',
    sortOrder: 'asc',
    pagesOnly: true,
  };
}

/**
 * Create default datalog query
 */
export function createDefaultDatalogQuery(): DatalogQuery {
  return {
    type: 'datalog',
    find: ['?node'],
    where: [],
  };
}
