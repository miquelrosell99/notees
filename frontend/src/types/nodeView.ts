/**
 * Query Types
 * 
 * TypeScript types for the query system.
 * Uses QueryAST from '@/types/queryAST' as the canonical format.
 */

import type { AggregationNode, QueryAST } from './queryAST';
import type { Node } from '@/types/api';
import type {
  NodeCollectionGroupBy,
  NodeCollectionViewMode,
  SortEntry,
} from './nodeCollection';

// Re-export commonly used types from queryAST
export type { AggregationNode, QueryAST } from './queryAST';

// ==================== NodeView Types ====================

/**
 * View types for NodeViews
 */
export type NodeViewType =
  | 'child_pages'
  | 'classed_nodes'
  | 'extended_by'
  | 'linked_references'
  | 'unlinked_references'
  | 'main_content'
  | 'all_pages';

/**
 * Per-view layout configuration bag (persisted server-side as JSONB).
 * Keys are optional; absent keys fall back to appStore "last used" globals
 * or built-in defaults.
 */
export interface NodeViewSettings {
  /** Kanban card layout (mirrors CardLayoutMode in appStore) */
  cardLayout?: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
  /** Gantt/calendar start date property UUID */
  ganttStartDatePropertyUuid?: string;
  /** Gantt/calendar end date property UUID */
  ganttEndDatePropertyUuid?: string;
  /** Gantt time scale */
  ganttTimeScale?: 'day' | 'week' | 'month';
  /** Chart view: chart type */
  chartType?: 'bar' | 'line' | 'pie';
  /** Chart view: group-by field (property UUID or builtin dimension) */
  chartGroupByField?: string;
  /** Chart view: measure configuration */
  chartMeasure?: { function: string; field?: string; label?: string };
}

/**
 * NodeView entity - defines a dynamic query tab for a node
 * Note: query_ast contains the QueryAST from the backend
 */
export interface NodeView {
  uuid: string;
  node_uuid: string;
  name: string;
  view_type: NodeViewType | string;
  order_index: number;
  is_default: boolean;
  active: boolean;
  shown_properties: Array<{ uuid: string; sequence: number }>;
  group_by: NodeCollectionGroupBy | null;
  /** Presentation mode; null falls back to the section default */
  view_mode: NodeCollectionViewMode | null;
  /** Persisted sort configuration */
  sort_entries: SortEntry[];
  /** Per-mode layout config bag */
  settings: NodeViewSettings;
  create_date: string;
  write_date: string;
  // Query AST is stored directly on the view (backend returns this as query_ast)
  query_ast?: QueryAST;
}

/**
 * Request to create a NodeView
 */
export interface NodeViewCreate {
  node_uuid: string;
  name: string;
  view_type: string;
  order_index?: number;
  is_default?: boolean;
  query_ast?: QueryAST;
}

/**
 * Request to update a NodeView
 */
export interface NodeViewUpdate {
  name?: string;
  order_index?: number;
  is_default?: boolean;
  shown_properties?: Array<{ uuid: string; sequence: number }>;
  group_by?: NodeCollectionGroupBy | null;
  view_mode?: NodeCollectionViewMode;
  sort_entries?: SortEntry[];
  settings?: NodeViewSettings;
}

/**
 * Request to execute a query
 */
export interface QueryExecuteRequest {
  query_ast?: QueryAST;
  runtime_params?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  order_by?: string;
  include_children?: boolean;
  include_all_children?: boolean;
  pages_only?: boolean;
  include_properties?: boolean;
  /** Fine-grained enrichment control */
  enrich?: {
    children?: boolean;
    classes?: boolean;
    properties?: boolean;
  };
  /** Backend aggregation (count + group_by) */
  aggregation?: AggregationNode;
  /** Compact text query language alternative to query_ast */
  query_language?: string;
}

/**
 * Single group returned by a backend aggregation query
 */
export interface QueryGroupResult {
  value: number;
  [key: string]: string | number | null | undefined;
}

/**
 * Response from query execution (extended with pagination + metrics)
 */
export interface QueryExecuteResponse {
  nodes: Node[];
  /** Aggregation groups (present when aggregation is requested) */
  groups?: QueryGroupResult[];
  /** Total matching rows (present when limit/offset used) */
  total_count?: number;
  /** Execution metrics from backend */
  metrics?: QueryExecutionMetrics;
}

/**
 * Backend query execution metrics
 */
export interface QueryExecutionMetrics {
  ast_nodes_before: number;
  ast_nodes_after: number;
  conditions_before: number;
  conditions_after: number;
  max_depth: number;
  has_recursive_cte: boolean;
  has_path_queries: boolean;
  has_property_joins: boolean;
  has_content_search: boolean;
  sql_cache_hit: boolean;
  rows_returned: number;
  total_count: number | null;
  sql_time_ms: number;
  total_time_ms: number;
}

// ==================== Runtime Parameters ====================

/**
 * Known runtime parameter placeholders
 */
export const QUERY_PLACEHOLDERS = {
  '{current_node_uuid}': 'The UUID of the current node being viewed',
  '{current_node_id}': 'The ID of the current node being viewed',
  '{current_node_name}': 'The display name (plain text) of the current node being viewed',
  '{current_user_id}': 'The ID of the current user',
  '{today}': "Today's date",
  '{this_week}': 'Start of current week',
  '{this_month}': 'Start of current month',
  '{this_year}': 'Start of current year',
} as const;

export type QueryPlaceholder = keyof typeof QUERY_PLACEHOLDERS;
