/**
 * Query Types
 * 
 * TypeScript types for the query system.
 * Uses QueryAST from '@/types/queryAST' as the canonical format.
 */

import type { QueryAST } from './queryAST';

// Re-export commonly used types from queryAST
export type { QueryAST } from './queryAST';

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
 * NodeView entity - defines a dynamic query tab for a node
 * Note: query_ast contains the QueryAST from the backend
 */
export interface NodeView {
  id: number;
  uuid: string;
  node_id: number;
  name: string;
  view_type: NodeViewType | string;
  order_index: number;
  is_default: boolean;
  active: boolean;
  shown_properties: Array<{ uuid: string; sequence: number }>;
  group_by: string | null;
  create_date: string;
  write_date: string;
  // Query AST is stored directly on the view (backend returns this as query_ast)
  query_ast?: QueryAST;
}

/**
 * Request to create a NodeView
 */
export interface NodeViewCreate {
  node_id: number;
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
  group_by?: string | null;
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
  include_properties?: boolean;
  /** Fine-grained enrichment control */
  enrich?: {
    children?: boolean;
    classes?: boolean;
    properties?: boolean;
  };
}

/**
 * Response from query execution (extended with pagination + metrics)
 */
export interface QueryExecuteResponse {
  nodes: import('@/types/api').Node[];
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
