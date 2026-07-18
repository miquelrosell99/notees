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
import type { QueryAST } from '@/types';
import { resolveNodeUuid, resolveNodeViewUuid } from '@/utils/resolveNodeUuid';
import { nodeViewKeys } from '@/hooks/queryKeys';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useConnectionStore } from '@/stores/connectionStore';
import { useWorkspaceRole } from '@/features/workspace';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { queryNodes } from '@/core/query/queryNodes';
import {
  useExecuteQueryAdapter,
  useQueryResultsAdapter,
} from '@/core/adapters/useQueryAstAdapter';
export { nodeViewKeys } from '@/hooks/queryKeys';

// ==================== Query Hooks ====================

/**
 * Fetch NodeViews for a node
 */

export function useNodeViews(
  nodeUuid: string,
  options?: {
    viewType?: string;
    enabled?: boolean;
    includeQueryAST?: boolean;
  }
) {
  const { viewType, enabled = true, includeQueryAST = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.list(nodeUuid, viewType),
    queryFn: () =>
      listNodeViews(resolveNodeUuid(nodeUuid), {
        view_type: viewType,
        include_query_ast: includeQueryAST,
      }),
    enabled: enabled && !!nodeUuid,
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch NodeViews grouped by view_type
 */
export function useNodeViewsByType(
  nodeUuid: string,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.byType(nodeUuid),
    queryFn: async () => {
      const views = await listNodeViews(resolveNodeUuid(nodeUuid), { include_query_ast: true });

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
    enabled: enabled && !!nodeUuid,
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
    queryKey: nodeViewKeys.detail(viewUuid ?? ''),
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
  nodeUuid: string,
  viewType: string,
  options?: {
    enabled?: boolean;
  }
) {
  const { enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.default(nodeUuid, viewType),
    queryFn: () => getDefaultNodeView(resolveNodeUuid(nodeUuid), viewType),
    enabled: enabled && !!nodeUuid && viewType.length > 0,
  });
}

/**
 * Legacy NodeView query execution. Imported by the SQLite adapter so it can
 * delegate when ENABLE_SQLITE_STORE is off without creating a circular call.
 */
export function useNodeViewQueryLegacy(
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
    /** QueryAST for offline evaluation. When provided and the device is offline, the hook evaluates the AST locally instead of calling the server. */
    ast?: QueryAST;
  }
) {
  const { runtimeParams, limit, offset, orderBy, includeChildren, includeAllChildren, pagesOnly, includeProperties, enrich, enabled = true, ast } = options ?? {};

  const isOnline = useOnlineStatus();
  const backendHealthy = useConnectionStore((s) => s.healthy);
  const isOffline = !isOnline || backendHealthy === false;
  const { activeWorkspace } = useWorkspaceRole();
  const workspaceUuid = activeWorkspace?.uuid ?? null;

  const viewUuid = typeof viewId === 'string' ? viewId : resolveNodeViewUuid(viewId);
  const offlineReady = isOffline && !!workspaceUuid && !!ast;

  return useQuery({
    queryKey: nodeViewKeys.queryResult(viewUuid ?? '', { runtimeParams, limit, offset, orderBy, includeChildren, includeAllChildren, pagesOnly, includeProperties, enrich }),
    queryFn: async () => {
      if (!viewUuid) throw new Error(`Unable to resolve UUID for view ${viewId}`);
      if (offlineReady) {
        const store = getWorkspaceStore(workspaceUuid);
        if (!store) throw new Error('Workspace store is not ready');
        return queryNodes(store, { ast, runtimeParams });
      }
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
    enabled: enabled && !!viewUuid && (!isOffline || offlineReady),
    staleTime: isOffline ? 0 : 30_000,  // 30s stale time for view queries
    placeholderData: keepPreviousData,
  });
}

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
    ast?: QueryAST;
  }
) {
  return useQueryResultsAdapter(viewId, options);
}

/**
 * Legacy ad-hoc query execution. Imported by the SQLite adapter.
 */
export function useQuery_Legacy(
  request: QueryExecuteRequest,
  options?: {
    enabled?: boolean;
    queryKey?: readonly unknown[];
  }
) {
  const { enabled = true, queryKey } = options ?? {};

  const isOnline = useOnlineStatus();
  const backendHealthy = useConnectionStore((s) => s.healthy);
  const isOffline = !isOnline || backendHealthy === false;
  const { activeWorkspace } = useWorkspaceRole();
  const workspaceUuid = activeWorkspace?.uuid ?? null;
  const ast = request.query_ast;
  const offlineReady = isOffline && !!workspaceUuid && !!ast;

  return useQuery({
    queryKey: queryKey ?? [...nodeViewKeys.queryResults(), 'adhoc', request],
    queryFn: async () => {
      if (offlineReady) {
        const store = getWorkspaceStore(workspaceUuid);
        if (!store) throw new Error('Workspace store is not ready');
        return queryNodes(store, { ast, runtimeParams: request.runtime_params });
      }
      const response = await executeQuery(request);
      return response.nodes;
    },
    enabled: enabled && (!isOffline || offlineReady),
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

export function useQuery_(
  request: QueryExecuteRequest,
  options?: {
    enabled?: boolean;
    queryKey?: readonly unknown[];
  }
) {
  return useExecuteQueryAdapter(request, options);
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
