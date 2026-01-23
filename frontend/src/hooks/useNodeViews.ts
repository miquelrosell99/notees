/**
 * useNodeViews hook
 * 
 * TanStack Query hooks for NodeView data fetching and mutations.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listNodeViews,
  getNodeView,
  getDefaultNodeView,
  createNodeView,
  updateNodeView,
  updateQueryBlockTree,
  deleteNodeView,
  reorderNodeViews,
  executeNodeViewQuery,
  executeQuery,
  countQueryResults,
  getNodeViewsByType,
  ensureDefaultViews,
} from '@/api/nodeViews';
import type {
  NodeViewCreate,
  NodeViewUpdate,
  QueryBlockTree,
  QueryExecuteRequest,
} from '@/types/query';

// ==================== Query Keys ====================

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
    includeQueryBlockTree?: boolean;
    enabled?: boolean;
  }
) {
  const { viewType, includeQueryBlockTree = false, enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.list(nodeId, viewType),
    queryFn: () =>
      listNodeViews(nodeId, {
        view_type: viewType,
        include_query_block_tree: includeQueryBlockTree,
      }),
    enabled: enabled && nodeId > 0,
  });
}

/**
 * Fetch NodeViews grouped by view_type
 */
export function useNodeViewsByType(
  nodeId: number,
  options?: {
    includeQueryBlockTree?: boolean;
    enabled?: boolean;
  }
) {
  const { includeQueryBlockTree = false, enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.byType(nodeId),
    queryFn: () => getNodeViewsByType(nodeId, includeQueryBlockTree),
    enabled: enabled && nodeId > 0,
  });
}

/**
 * Fetch a single NodeView by ID
 */
export function useNodeView(
  viewId: number,
  options?: {
    includeQueryBlockTree?: boolean;
    enabled?: boolean;
  }
) {
  const { includeQueryBlockTree = true, enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.detail(viewId),
    queryFn: () => getNodeView(viewId, includeQueryBlockTree),
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
    includeQueryBlockTree?: boolean;
    enabled?: boolean;
  }
) {
  const { includeQueryBlockTree = true, enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.default(nodeId, viewType),
    queryFn: () => getDefaultNodeView(nodeId, viewType, includeQueryBlockTree),
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
    enabled?: boolean;
  }
) {
  const { runtimeParams, limit, offset, orderBy, enabled = true } = options ?? {};

  return useQuery({
    queryKey: nodeViewKeys.queryResult(viewId, { runtimeParams, limit, offset, orderBy }),
    queryFn: () =>
      executeNodeViewQuery(viewId, {
        runtime_params: runtimeParams,
        limit,
        offset,
        order_by: orderBy,
      }),
    enabled: enabled && viewId > 0,
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
    queryFn: () => executeQuery(request),
    enabled,
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

// ==================== Mutation Hooks ====================

/**
 * Create a new NodeView
 */
export function useCreateNodeView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: NodeViewCreate) => createNodeView(data),
    onSuccess: (newView) => {
      // Invalidate list queries for the node
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.list(newView.node_id),
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(newView.node_id),
      });
    },
  });
}

/**
 * Update a NodeView
 */
export function useUpdateNodeView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ viewId, data }: { viewId: number; data: NodeViewUpdate }) =>
      updateNodeView(viewId, data),
    onSuccess: (updatedView) => {
      // Update the cache for this view
      queryClient.setQueryData(nodeViewKeys.detail(updatedView.id), updatedView);
      // Invalidate list queries
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.list(updatedView.node_id),
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(updatedView.node_id),
      });
    },
  });
}

/**
 * Update a NodeView's query block tree
 */
export function useUpdateQueryBlockTree() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ viewId, blockTree }: { viewId: number; blockTree: QueryBlockTree }) =>
      updateQueryBlockTree(viewId, blockTree),
    onSuccess: (updatedView) => {
      // Update the cache for this view
      queryClient.setQueryData(nodeViewKeys.detail(updatedView.id), updatedView);
      // Invalidate query results since the query changed
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.queryResult(updatedView.id),
      });
    },
  });
}

/**
 * Delete a NodeView
 */
export function useDeleteNodeView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (viewId: number) => deleteNodeView(viewId),
    onSuccess: (_, viewId) => {
      // Remove from cache
      queryClient.removeQueries({
        queryKey: nodeViewKeys.detail(viewId),
      });
      // Invalidate all list queries (we don't know the nodeId here)
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.lists(),
      });
    },
  });
}

/**
 * Reorder NodeViews within a view_type
 */
export function useReorderNodeViews() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      nodeId,
      viewType,
      viewIds,
    }: {
      nodeId: number;
      viewType: string;
      viewIds: number[];
    }) => reorderNodeViews(nodeId, viewType, viewIds),
    onSuccess: (updatedViews, { nodeId }) => {
      // Update list cache
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.list(nodeId),
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(nodeId),
      });
      // Update individual view caches
      for (const view of updatedViews) {
        queryClient.setQueryData(nodeViewKeys.detail(view.id), view);
      }
    },
  });
}

/**
 * Ensure default views exist for a node (lazy initialization)
 */
export function useEnsureDefaultViews() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, viewTypes }: { nodeId: number; viewTypes?: string[] }) =>
      ensureDefaultViews(nodeId, viewTypes),
    onSuccess: (views) => {
      if (views.length > 0) {
        const nodeId = views[0].node_id;
        // Invalidate list queries
        queryClient.invalidateQueries({
          queryKey: nodeViewKeys.list(nodeId),
        });
        queryClient.invalidateQueries({
          queryKey: nodeViewKeys.byType(nodeId),
        });
      }
    },
  });
}

// ==================== Utility Hooks ====================

/**
 * Get the current active NodeView for a section
 * Returns the first view (default) if no active view is set
 */
export function useActiveNodeView(
  nodeId: number,
  viewType: string,
  activeViewId?: number
) {
  const { data: views = [], isLoading } = useNodeViews(nodeId, {
    viewType,
    includeQueryBlockTree: true,
  });

  const activeView = activeViewId
    ? views.find((v) => v.id === activeViewId)
    : views[0]; // First view (lowest order_index) is default

  return {
    views,
    activeView,
    isLoading,
    hasMultipleViews: views.length > 1,
  };
}

/**
 * Hook to manage NodeView tab state
 */
export function useNodeViewTabs(nodeId: number, viewType: string) {
  const { data: views = [], isLoading, isError } = useNodeViews(nodeId, {
    viewType,
    includeQueryBlockTree: true,
  });

  const defaultView = views.length > 0 ? views[0] : null;
  
  return {
    views,
    defaultView,
    isLoading,
    isError,
    isEmpty: views.length === 0,
  };
}
