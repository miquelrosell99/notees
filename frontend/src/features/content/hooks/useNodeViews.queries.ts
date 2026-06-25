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
import { resolveNodeUuid, resolveNodeViewUuid } from '@/utils/resolveNodeUuid';
import { nodeViewKeys } from '@/hooks/queryKeys';
export { nodeViewKeys } from '@/hooks/queryKeys';

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
      listNodeViews(resolveNodeUuid(nodeId), {
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
      const views = await listNodeViews(resolveNodeUuid(nodeId), { include_query_ast: true });

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
  viewId: string | number,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};
  const viewUuid = typeof viewId === 'string' ? viewId : resolveNodeViewUuid(viewId);

  return useQuery({
    queryKey: nodeViewKeys.detail(viewId),
    queryFn: () => {
      if (!viewUuid) throw new Error(`Unable to resolve UUID for view ${viewId}`);
      return getNodeView(viewUuid);
    },
    enabled: enabled && !!viewUuid,
  });
}

/**
 * Fetch the default NodeView for a view_type
 */
export function useDefaultNodeView(
  nodeId: string | number,
  viewType: string,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.default(nodeId, viewType),
    queryFn: () => getDefaultNodeView(resolveNodeUuid(nodeId), viewType),
    enabled: enabled && !!nodeId && viewType.length > 0,
  });
}

/**
 * Execute a NodeView's query and return results
 */
export function useNodeViewQuery(
  viewId: string | number,
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

  const viewUuid = typeof viewId === 'string' ? viewId : resolveNodeViewUuid(viewId);

  return useQuery({
    queryKey: nodeViewKeys.queryResult(viewId, { runtimeParams, limit, offset, orderBy, includeChildren, includeAllChildren, pagesOnly, includeProperties, enrich }),
    queryFn: async () => {
      if (!viewUuid) throw new Error(`Unable to resolve UUID for view ${viewId}`);
      const response = await executeNodeViewQuery(viewUuid, {
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
    enabled: enabled && !!viewUuid,
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
    queryKey?: readonly unknown[];
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
    queryKey: nodeViewKeys.count(null, request),
    queryFn: () => countQueryResults(request),
    enabled,
  });
}
