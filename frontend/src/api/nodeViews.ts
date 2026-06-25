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
import { resolveNodeUuid, resolveNodeViewUuid } from '@/utils/resolveNodeUuid';

const BASE = '/nodes/views';

function requireViewUuid(viewId: string | number): string {
  const uuid = resolveNodeViewUuid(viewId);
  if (!uuid) {
    throw new Error(`Unable to resolve UUID for view id ${viewId}`);
  }
  return uuid;
}

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
  nodeId: string | number,
  options?: {
    view_type?: string;
    include_query_ast?: boolean;
  }
): Promise<NodeView[]> {
  const response = await api.get<NodeViewsResponse>(BASE, {
    params: {
      node_uuid: resolveNodeUuid(nodeId),
      ...options,
    },
  });
  return response.data.views;
}

/**
 * Get a NodeView by ID
 */
export async function getNodeView(viewId: string | number): Promise<NodeView> {
  const response = await api.get<NodeView>(`${BASE}/${requireViewUuid(viewId)}`);
  return response.data;
}

/**
 * Get the default NodeView for a view_type
 */
export async function getDefaultNodeView(
  nodeId: string | number,
  viewType: string
): Promise<NodeView | null> {
  const response = await api.get<NodeView | null>(
    `${BASE}/default/${resolveNodeUuid(nodeId)}/${viewType}`
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
  viewId: string | number,
  data: NodeViewUpdate
): Promise<NodeView> {
  const response = await api.put<NodeView>(
    `${BASE}/${requireViewUuid(viewId)}`,
    data
  );
  return response.data;
}

/**
 * Update the query AST for a NodeView
 */
export async function updateQueryAST(
  viewId: string | number,
  queryAST: Record<string, any>
): Promise<NodeView> {
  const response = await api.put<NodeView>(
    `${BASE}/${requireViewUuid(viewId)}/query-ast`,
    { query_ast: queryAST }
  );
  return response.data;
}

/**
 * Delete a NodeView
 */
export async function deleteNodeView(viewId: string | number): Promise<void> {
  await api.delete(`${BASE}/${requireViewUuid(viewId)}`);
}

/**
 * Reorder NodeViews within a view_type
 */
export async function reorderNodeViews(
  nodeId: string | number,
  viewType: string,
  viewIds: (string | number)[]
): Promise<NodeView[]> {
  const response = await api.post<NodeViewsResponse>(
    `${BASE}/reorder/${resolveNodeUuid(nodeId)}/${viewType}`,
    { view_uuids: viewIds.map(requireViewUuid) }
  );
  return response.data.views;
}

// ==================== Query Execution ====================

/**
 * Execute a NodeView's query
 * Returns full response with nodes, optional total_count, and metrics.
 */
export async function executeNodeViewQuery(
  viewId: string | number,
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
    `/api/nodes/views/${requireViewUuid(viewId)}/execute`,
    options,
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
    request,
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
export async function countQueryResults(
  request: QueryExecuteRequest
): Promise<number> {
  const response = await api.post<QueryCountResponse>(`${BASE}/count`, request);
  return response.data.count;
}

// ==================== Utility Functions ====================

/**
 * Ensure a node has default views, creating them if needed via the backend
 */
export async function ensureDefaultViews(
  nodeId: string | number,
  viewTypes?: string[]
): Promise<NodeView[]> {
  const response = await api.post<{ views: NodeView[] }>(
    `${BASE}/ensure-defaults/${resolveNodeUuid(nodeId)}`,
    viewTypes ?? null
  );
  return response.data.views;
}

/**
 * Reset all views for a node to defaults
 * Deletes all existing views and creates new default views
 */
export async function resetNodeViews(nodeId: string | number): Promise<NodeView[]> {
  const response = await api.post<{ views: NodeView[] }>(
    `${BASE}/reset/${resolveNodeUuid(nodeId)}`
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
