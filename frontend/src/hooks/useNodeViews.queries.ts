/**
 * NodeView Query Hooks
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  listNodeViews,
  getNodeView,
  getDefaultNodeView,
  executeNodeViewQuery,
  executeQuery,
  countQueryResults,
} from '@/api/nodeViews';
import type {
  NodeView,
  QueryExecuteRequest,
} from '@/types/nodeView';

export const nodeViewKeys = {
  all: ['nodeViews'] as const,
  lists: () => [...nodeViewKeys.all, 'list'] as const,
  list: (nodeId: number, viewType?: string) =>
    [...nodeViewKeys.lists(), nodeId, viewType] as const,
  byType: (nodeId: number) => [...nodeViewKeys.all, 'byType', nodeId] as const,
  details: () => [...nodeViewKeys.all, 'detail'] as const,
  detail: (viewId: number) => [...nodeViewKeys.details(), viewId] as const,
  default: (nodeId: number, viewType: string) =>
    [...nodeViewKeys.all, 'default', nodeId, viewType] as const,
  queryResults: () => [...nodeViewKeys.all, 'queryResults'] as const,
  queryResult: (viewId: number, params?: Record<string, unknown>) =>
    [...nodeViewKeys.queryResults(), viewId, params] as const,
};

// ==================== Query Hooks ====================

/**
 * Fetch NodeViews for a node
 */

export function useNodeViews(
  nodeId: number,
  options?: {
    viewType?: string;
    enabled?: boolean;
    includeQueryAST?: boolean;
  }
) {
  const { viewType, enabled = true, includeQueryAST = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.list(nodeId, viewType),
    queryFn: () =>
      listNodeViews(nodeId, {
        view_type: viewType,
        include_query_ast: includeQueryAST,
      }),
    enabled: enabled && nodeId > 0,
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch NodeViews grouped by view_type
 */
export function useNodeViewsByType(
  nodeId: number,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.byType(nodeId),
    queryFn: async () => {
      const views = await listNodeViews(nodeId, { include_query_ast: true });

      const grouped: Record<string, NodeView[]> = {};
      for (const view of views) {
        if (!grouped[view.view_type]) {
          grouped[view.view_type] = [];
        }
        grouped[view.view_type].push(view);
      }

      for (const viewType of Object.keys(grouped)) {
        grouped[viewType].sort((a, b) => a.order_index - b.order_index);
      }

      return grouped;
    },
    enabled: enabled && nodeId > 0,
  });
}

/**
 * Fetch a single NodeView by ID
 */
export function useNodeView(
  viewId: number,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.detail(viewId),
    queryFn: () => getNodeView(viewId),
    enabled: enabled && viewId > 0,
  });
}

/**
 * Fetch the default NodeView for a view_type
 */
export function useDefaultNodeView(
  nodeId: number,
  viewType: string,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.default(nodeId, viewType),
    queryFn: () => getDefaultNodeView(nodeId, viewType),
    enabled: enabled && nodeId > 0 && viewType.length > 0,
  });
}

/**
 * Execute a NodeView's query and return results
 */
export function useNodeViewQuery(
  viewId: number,
  options?: {
    runtimeParams?: Record<string, unknown>;
    limit?: number;
    offset?: number;
    orderBy?: string;
    includeChildren?: boolean;
    includeAllChildren?: boolean;
    pagesOnly?: boolean;
    includeProperties?: boolean;
    enrich?: { children?: boolean; classes?: boolean; properties?: boolean };
    enabled?: boolean;
  }
) {
  const { runtimeParams, limit, offset, orderBy, includeChildren, includeAllChildren, pagesOnly, includeProperties, enrich, enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.queryResult(viewId, { runtimeParams, limit, offset, orderBy, includeChildren, includeAllChildren, pagesOnly, includeProperties, enrich }),
    queryFn: async () => {
      const response = await executeNodeViewQuery(viewId, {
        runtime_params: runtimeParams,
        limit,
        offset,
        order_by: orderBy,
        include_children: includeChildren,
        include_all_children: includeAllChildren,
        pages_only: pagesOnly,
        include_properties: includeProperties,
        enrich,
      });
      // Return nodes for backward compatibility, but store full response
      return response.nodes;
    },
    enabled: enabled && viewId > 0,
    staleTime: 30_000,  // 30s stale time for view queries
    placeholderData: keepPreviousData,
  });
}

/**
 * Execute an ad-hoc query (not tied to a NodeView)
 */
export function useQuery_(
  request: QueryExecuteRequest,
  options?: {
    enabled?: boolean;
    queryKey?: unknown[];
  }
) {
  const { enabled = true, queryKey } = options ?? {};

  return useQuery({
    queryKey: queryKey ?? [...nodeViewKeys.queryResults(), 'adhoc', request],
    queryFn: async () => {
      const response = await executeQuery(request);
      return response.nodes;
    },
    enabled,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

/**
 * Count query results without fetching data
 */
export function useQueryCount(
  request: QueryExecuteRequest,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};

  return useQuery({
    queryKey: [...nodeViewKeys.queryResults(), 'count', request],
    queryFn: () => countQueryResults(request),
    enabled,
  });
}

