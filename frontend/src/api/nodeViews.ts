/**
 * NodeViews API functions
 * 
 * API client for managing NodeViews - dynamic query tabs for nodes.
 */
import api from './client';
import type { Node } from '@/types/api';
import type { 
  NodeView, 
  NodeViewCreate, 
  NodeViewUpdate, 
  QueryExecuteRequest,
} from '@/types/query';

const BASE = '/nodes/views';

// ==================== Response Types ====================

interface NodeViewsResponse {
  views: NodeView[];
}

interface QueryExecuteResponse {
  nodes: Node[];
}

interface QueryCountResponse {
  count: number;
}

// ==================== NodeView CRUD ====================

/**
 * List NodeViews for a node
 */
export async function listNodeViews(
  nodeId: number,
  options?: {
    view_type?: string;
    include_query_ast?: boolean;
  }
): Promise<NodeView[]> {
  const response = await api.get<NodeViewsResponse>(BASE, {
    params: {
      node_id: nodeId,
      ...options,
    },
  });
  return response.data.views;
}

/**
 * Get a NodeView by ID
 */
export async function getNodeView(viewId: number): Promise<NodeView> {
  const response = await api.get<NodeView>(`${BASE}/${viewId}`);
  return response.data;
}

/**
 * Get the default NodeView for a view_type
 */
export async function getDefaultNodeView(
  nodeId: number,
  viewType: string
): Promise<NodeView | null> {
  const response = await api.get<NodeView | null>(`${BASE}/default/${nodeId}/${viewType}`);
  return response.data;
}

/**
 * Create a new NodeView
 */
export async function createNodeView(data: NodeViewCreate): Promise<NodeView> {
  const response = await api.post<NodeView>(BASE, data);
  return response.data;
}

/**
 * Update a NodeView
 */
export async function updateNodeView(
  viewId: number,
  data: NodeViewUpdate
): Promise<NodeView> {
  const response = await api.put<NodeView>(`${BASE}/${viewId}`, data);
  return response.data;
}

/**
 * Update the query AST for a NodeView
 */
export async function updateQueryAST(
  viewId: number,
  queryAST: Record<string, any>
): Promise<NodeView> {
  const response = await api.put<NodeView>(`${BASE}/${viewId}/query-ast`, { query_ast: queryAST });
  return response.data;
}

/**
 * Delete a NodeView
 */
export async function deleteNodeView(viewId: number): Promise<void> {
  await api.delete(`${BASE}/${viewId}`);
}

/**
 * Reorder NodeViews within a view_type
 */
export async function reorderNodeViews(
  nodeId: number,
  viewType: string,
  viewIds: number[]
): Promise<NodeView[]> {
  const response = await api.post<NodeViewsResponse>(
    `${BASE}/reorder/${nodeId}/${viewType}`,
    { view_ids: viewIds }
  );
  return response.data.views;
}

// ==================== Query Execution ====================

/**
 * Execute a NodeView's query
 */
export async function executeNodeViewQuery(
  viewId: number,
  options?: {
    runtime_params?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    order_by?: string;
    include_children?: boolean;
    include_properties?: boolean;
  }
): Promise<Node[]> {
  const response = await api.post<QueryExecuteResponse>(
    `${BASE}/${viewId}/execute`,
    options
  );
  return response.data.nodes;
}

/**
 * Execute a query block tree directly (without saving)
 */
export async function executeQuery(request: QueryExecuteRequest): Promise<Node[]> {
  const response = await api.post<QueryExecuteResponse>(`${BASE}/execute`, request);
  return response.data.nodes;
}

/**
 * Count results for a query without fetching all data
 */
export async function countQueryResults(
  request: QueryExecuteRequest
): Promise<number> {
  const response = await api.post<QueryCountResponse>(`${BASE}/count`, request);
  return response.data.count;
}

// ==================== Utility Functions ====================

/**
 * Get all NodeViews for a node grouped by view_type
 */
export async function getNodeViewsByType(
  nodeId: number
): Promise<Record<string, NodeView[]>> {
  const views = await listNodeViews(nodeId, { include_query_ast: true });
  
  const grouped: Record<string, NodeView[]> = {};
  for (const view of views) {
    if (!grouped[view.view_type]) {
      grouped[view.view_type] = [];
    }
    grouped[view.view_type].push(view);
  }
  
  // Sort each group by order_index
  for (const viewType of Object.keys(grouped)) {
    grouped[viewType].sort((a, b) => a.order_index - b.order_index);
  }
  
  return grouped;
}

/**
 * Ensure a node has default views, creating them if needed via the backend
 */
export async function ensureDefaultViews(
  nodeId: number,
  viewTypes?: string[]
): Promise<NodeView[]> {
  const response = await api.post<{ views: NodeView[] }>(
    `${BASE}/ensure-defaults/${nodeId}`,
    viewTypes ?? null
  );
  return response.data.views;
}

/**
 * Reset all views for a node to defaults
 * Deletes all existing views and creates new default views
 */
export async function resetNodeViews(nodeId: number): Promise<NodeView[]> {
  const response = await api.post<{ views: NodeView[] }>(
    `${BASE}/reset/${nodeId}`
  );
  return response.data.views;
}
