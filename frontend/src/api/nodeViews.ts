/**
 * NodeViews API functions
 * 
 * API client for managing NodeViews - dynamic query tabs for nodes.
 */
import api from '@/api/client';
import { nodeQueryWorkerClient } from '@/lib/nodeQueryWorkerClient';
import type { Node } from '@/types/api';
import type {
  NodeView,
  NodeViewCreate,
  NodeViewUpdate,
  QueryAST,
  QueryExecuteRequest,
  QueryExecuteResponse,
} from '@/types/nodeView';

const BASE = '/nodes/views';

// ==================== Response Types ====================

interface NodeViewsResponse {
  views: NodeView[];
}

interface QueryExecuteAPIResponse {
  nodes: Node[];
  groups?: QueryExecuteResponse['groups'];
  total_count?: number;
  metrics?: QueryExecuteResponse['metrics'];
}

interface QueryCountResponse {
  count: number;
}

// ==================== NodeView CRUD ====================

/**
 * List NodeViews for a node
 */
export async function listNodeViews(
  nodeUuid: string,
  options?: {
    view_type?: string;
    include_query_ast?: boolean;
  }
): Promise<NodeView[]> {
  const response = await api.get<NodeViewsResponse>(BASE, {
    params: {
      node_uuid: nodeUuid,
      ...options,
    },
  });
  return response.data.views;
}

/**
 * Get a NodeView by UUID
 */
export async function getNodeView(viewUuid: string): Promise<NodeView> {
  const response = await api.get<NodeView>(`${BASE}/${viewUuid}`);
  return response.data;
}

/**
 * Get the default NodeView for a view_type
 */
export async function getDefaultNodeView(
  nodeUuid: string,
  viewType: string
): Promise<NodeView | null> {
  const response = await api.get<NodeView | null>(
    `${BASE}/default/${nodeUuid}/${viewType}`
  );
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
  viewUuid: string,
  data: NodeViewUpdate
): Promise<NodeView> {
  const response = await api.put<NodeView>(`${BASE}/${viewUuid}`, data);
  return response.data;
}

/**
 * Update the query AST for a NodeView
 */
export async function updateQueryAST(
  viewUuid: string,
  queryAST: Record<string, any>
): Promise<NodeView> {
  const response = await api.put<NodeView>(`${BASE}/${viewUuid}/query-ast`, {
    query_ast: queryAST,
  });
  return response.data;
}

/**
 * Delete a NodeView
 */
export async function deleteNodeView(viewUuid: string): Promise<void> {
  await api.delete(`${BASE}/${viewUuid}`);
}

/**
 * Reorder NodeViews within a view_type
 */
export async function reorderNodeViews(
  nodeUuid: string,
  viewType: string,
  viewUuids: string[]
): Promise<NodeView[]> {
  const response = await api.post<NodeViewsResponse>(
    `${BASE}/reorder/${nodeUuid}/${viewType}`,
    { view_uuids: viewUuids }
  );
  return response.data.views;
}

// ==================== Query Execution ====================

/**
 * Execute a NodeView's query
 * Returns full response with nodes, optional total_count, and metrics.
 */
export async function executeNodeViewQuery(
  viewUuid: string,
  options?: {
    runtime_params?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    order_by?: string;
    include_children?: boolean;
    include_all_children?: boolean;
    pages_only?: boolean;
    include_properties?: boolean;
    enrich?: { children?: boolean; classes?: boolean; properties?: boolean };
    aggregation?: QueryExecuteRequest['aggregation'];
  }
): Promise<QueryExecuteResponse> {
  const data = await nodeQueryWorkerClient.post<QueryExecuteAPIResponse>(
    `/api/nodes/views/${viewUuid}/execute`,
    options
  );
  return {
    nodes: data.nodes,
    groups: data.groups,
    total_count: data.total_count,
    metrics: data.metrics,
  };
}

/**
 * Execute a query directly (without saving)
 * Returns full response with nodes, optional total_count, and metrics.
 */
export async function executeQuery(request: QueryExecuteRequest): Promise<QueryExecuteResponse> {
  const data = await nodeQueryWorkerClient.post<QueryExecuteAPIResponse>(
    `/api/nodes/views/execute`,
    request
  );
  return {
    nodes: data.nodes,
    groups: data.groups,
    total_count: data.total_count,
    metrics: data.metrics,
  };
}

/**
 * Count results for a query without fetching all data
 */
export async function countQueryResults(request: QueryExecuteRequest): Promise<number> {
  const response = await api.post<QueryCountResponse>(`${BASE}/count`, request);
  return response.data.count;
}

// ==================== Utility Functions ====================

/**
 * Ensure a node has default views, creating them if needed via the backend
 */
export async function ensureDefaultViews(
  nodeUuid: string,
  viewTypes?: string[]
): Promise<NodeView[]> {
  const response = await api.post<{ views: NodeView[] }>(
    `${BASE}/ensure-defaults/${nodeUuid}`,
    viewTypes ?? null
  );
  return response.data.views;
}

/**
 * Reset all views for a node to defaults
 * Deletes all existing views and creates new default views
 */
export async function resetNodeViews(nodeUuid: string): Promise<NodeView[]> {
  const response = await api.post<{ views: NodeView[] }>(
    `${BASE}/reset/${nodeUuid}`
  );
  return response.data.views;
}

/**
 * Parse a compact text query into a QueryAST without executing it.
 */
export async function parseQueryLanguage(queryLanguage: string): Promise<QueryAST> {
  const response = await api.post<{ query_ast: QueryAST }>(`${BASE}/parse`, {
    query_language: queryLanguage,
  });
  return response.data.query_ast;
}
