/**
 * NodeView Mutation Hooks
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryClient as sharedQueryClient } from '@/lib/queryClient';
import {
  createNodeView,
  updateNodeView,
  updateQueryAST,
  deleteNodeView,
  duplicateNodeView,
  reorderNodeViews,
  resetNodeViews,
  ensureDefaultViews,
} from '@/api/nodeViews';
import type {
  NodeView,
  NodeViewCreate,
  NodeViewUpdate,
} from '@/types/nodeView';
import { resolveNodeUuid, resolveNodeViewUuid } from '@/utils/resolveNodeUuid';
import { nodeViewKeys } from './useNodeViews.queries';

function requireViewUuid(viewId: string | number): string {
  const uuid = resolveNodeViewUuid(viewId);
  if (!uuid) {
    throw new Error(`Unable to resolve UUID for view id ${viewId}`);
  }
  return uuid;
}

export function useCreateNodeView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: NodeViewCreate) => createNodeView(data),
    onSuccess: (newView) => {
      // Invalidate ALL list queries for this node (any viewType)
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.lists(),
        predicate: (query) => {
          const key = query.queryKey;
          // Match ['nodeViews', 'list', nodeId, ...]
          return key[0] === 'nodeViews' && key[1] === 'list' && key[2] === newView.node_uuid;
        },
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(newView.node_uuid),
      });
    },
  });
}

/**
 * Update a NodeView
 *
 * Applies an optimistic patch to the list caches so presentation switches
 * (view mode, sort, group-by, settings) feel instant; rolls back on error.
 */
export function useUpdateNodeView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ viewId, data }: { viewId: string | number; data: NodeViewUpdate }) =>
      updateNodeView(requireViewUuid(viewId), data),
    onMutate: async ({ viewId, data }) => {
      const uuid = requireViewUuid(viewId);
      await queryClient.cancelQueries({ queryKey: nodeViewKeys.lists() });
      await queryClient.cancelQueries({ queryKey: nodeViewKeys.detail(uuid) });

      const previousLists = queryClient.getQueriesData<NodeView[]>({
        queryKey: nodeViewKeys.lists(),
      });
      const previousDetail = queryClient.getQueryData<NodeView>(nodeViewKeys.detail(uuid));

      const patchList = (old: NodeView[] | undefined): NodeView[] | undefined => {
        if (!old) return old;
        const targetType = old.find((v) => v.uuid === uuid)?.view_type;
        return old.map((view) => {
          if (view.uuid === uuid) return { ...view, ...data };
          // Setting a new default unsets the previous one in the same section
          if (data.is_default === true && view.is_default && view.view_type === targetType) {
            return { ...view, is_default: false };
          }
          return view;
        });
      };

      queryClient.setQueriesData<NodeView[]>({ queryKey: nodeViewKeys.lists() }, patchList);
      if (previousDetail) {
        queryClient.setQueryData(nodeViewKeys.detail(uuid), { ...previousDetail, ...data });
      }

      return { previousLists, previousDetail, uuid };
    },
    onError: (_err, _vars, context) => {
      if (!context) return;
      for (const [key, value] of context.previousLists) {
        queryClient.setQueryData(key, value);
      }
      if (context.previousDetail) {
        queryClient.setQueryData(nodeViewKeys.detail(context.uuid), context.previousDetail);
      }
    },
    onSuccess: (updatedView) => {
      // Update the cache for this view
      queryClient.setQueryData(nodeViewKeys.detail(updatedView.uuid), updatedView);
      // Invalidate list queries
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.list(updatedView.node_uuid),
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(updatedView.node_uuid),
      });
    },
  });
}

/**
 * Duplicate a NodeView (copies query AST + full presentation config)
 */
export function useDuplicateNodeView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (viewId: string) => duplicateNodeView(requireViewUuid(viewId)),
    onSuccess: (newView) => {
      queryClient.setQueryData(nodeViewKeys.detail(newView.uuid), newView);
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.lists(),
        predicate: (query) => {
          const key = query.queryKey;
          return key[0] === 'nodeViews' && key[1] === 'list' && key[2] === newView.node_uuid;
        },
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(newView.node_uuid),
      });
    },
  });
}

/**
 * Update query AST for a NodeView
 */
export function useUpdateQueryAST() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ viewId, queryAST }: { viewId: string; queryAST: Record<string, any> }) =>
      updateQueryAST(requireViewUuid(viewId), queryAST),
    onSuccess: (updatedView) => {
      // Update the cache for this view
      queryClient.setQueryData(nodeViewKeys.detail(updatedView.uuid), updatedView);
      // Invalidate ALL query results for this view (regardless of parameters)
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.queryResults(),
        predicate: (query) => {
          const key = query.queryKey;
          // Match ['nodeViews', 'queryResults', viewId, ...]
          return key[0] === 'nodeViews' && key[1] === 'queryResults' && key[2] === updatedView.uuid;
        },
      });
      // Also invalidate the list queries since the view was updated
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.list(updatedView.node_uuid),
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
    mutationFn: (viewId: string) => deleteNodeView(requireViewUuid(viewId)),
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
 * Reset all views for a node to defaults
 */
export function useResetNodeViews() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (nodeUuid: string) => resetNodeViews(resolveNodeUuid(nodeUuid)),
    onSuccess: async (newViews, nodeUuid) => {
      // First, remove all old view details and query results to prevent stale queries
      queryClient.removeQueries({
        queryKey: nodeViewKeys.details(),
      });
      queryClient.removeQueries({
        queryKey: nodeViewKeys.queryResults(),
      });
      
      // Set the new views in cache for individual view queries
      newViews.forEach((view) => {
        queryClient.setQueryData(nodeViewKeys.detail(view.uuid), view);
      });
      
      // Group views by view_type and set list queries to prevent duplicate creation
      const viewsByType = new Map<string, typeof newViews>();
      newViews.forEach((view) => {
        if (!viewsByType.has(view.view_type)) {
          viewsByType.set(view.view_type, []);
        }
        viewsByType.get(view.view_type)!.push(view);
      });
      
      // Set list query cache for each view type
      viewsByType.forEach((views, viewType) => {
        queryClient.setQueryData(
          nodeViewKeys.list(nodeUuid, viewType),
          views
        );
      });
      
      // Also set the full list (all view types)
      queryClient.setQueryData(
        nodeViewKeys.list(nodeUuid),
        newViews
      );
      
      // Invalidate byType queries
      await queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(nodeUuid),
        refetchType: 'none', // Don't refetch, we just set the data
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
              nodeUuid,
              viewType,
              viewIds }: {
      nodeUuid: string;
      viewType: string;
      viewIds: string[];
    }) => reorderNodeViews(
      resolveNodeUuid(nodeUuid),
      viewType,
      viewIds.map(requireViewUuid)
    ),
    onSuccess: (updatedViews, { nodeUuid }) => {
      // Update list cache
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.list(nodeUuid),
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(nodeUuid),
      });
      // Update individual view caches
      for (const view of updatedViews) {
        queryClient.setQueryData(nodeViewKeys.detail(view.uuid), view);
      }
    },
  });
}

// ---- Batched ensure-defaults ----
// Collects all ensure-defaults requests that arrive in the same tick and
// fires ONE API call per unique nodeId.  This reduces the ~40 POSTs that
// fire on the journal view (4 view-types × 10 day-nodes) down to ~10.

/** Nodes already ensured this browser session (cleared on full-page reload). */
const _ensuredNodes = new Set<string>();

/** Pending batch: nodeUuid → { viewTypes to include, resolvers to notify }. */
const _pendingBatch = new Map<
  string,
  { viewTypes: Set<string>; resolvers: Array<() => void> }
>();
let _flushScheduled = false;

function _flushBatch() {
  _flushScheduled = false;
  const batch = new Map(_pendingBatch);
  _pendingBatch.clear();

  batch.forEach(({ viewTypes, resolvers }, nodeId) => {
    if (_ensuredNodes.has(nodeId)) {
      // Already ensured — resolve immediately, no network call
      resolvers.forEach((r) => r());
      return;
    }

    const viewTypesArr = [...viewTypes];
    ensureDefaultViews(resolveNodeUuid(nodeId), viewTypesArr)
      .then((views) => {
        _ensuredNodes.add(nodeId);
        // Only invalidate if new views were actually created
        if (views.length > 0) {
          sharedQueryClient.invalidateQueries({
            queryKey: nodeViewKeys.list(nodeId),
          });
          sharedQueryClient.invalidateQueries({
            queryKey: nodeViewKeys.byType(nodeId),
          });
        }
      })
      .catch((err) => {
        console.error(`ensureDefaultViews failed for node ${nodeId}:`, err);
      })
      .finally(() => {
        resolvers.forEach((r) => r());
      });
  });
}

/**
 * Queue an ensure-defaults request.  All requests that arrive in the same
 * micro-task are batched into a single API call per nodeId.
 *
 * Returns a Promise that resolves once the API call completes (or is skipped).
 */
export function batchEnsureDefaults(
  nodeUuid: string,
  viewType: string
): Promise<void> {
  // Fast path: already ensured this session
  if (_ensuredNodes.has(nodeUuid)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let entry = _pendingBatch.get(nodeUuid);
    if (!entry) {
      entry = { viewTypes: new Set(), resolvers: [] };
      _pendingBatch.set(nodeUuid, entry);
    }
    entry.viewTypes.add(viewType);
    entry.resolvers.push(resolve);

    if (!_flushScheduled) {
      _flushScheduled = true;
      // Use queueMicrotask so all synchronous mounts in the same render
      // are collected before firing.
      queueMicrotask(_flushBatch);
    }
  });
}

/**
 * Ensure default views exist for a node (lazy initialization).
 *
 * Uses the batching system above.  Each QuerySection calls this with its
 * own viewType; the batcher merges them into one API call per nodeId.
 */
export function useEnsureDefaultViews() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeUuid, viewTypes }: { nodeUuid: string; viewTypes?: string[] }) => {
      if (_ensuredNodes.has(nodeUuid)) return [];
      const views = await ensureDefaultViews(resolveNodeUuid(nodeUuid), viewTypes);
      _ensuredNodes.add(nodeUuid);
      return views;
    },
    onSuccess: (views) => {
      if (views.length > 0) {
        const nodeUuid = views[0].node_uuid;
        queryClient.invalidateQueries({
          queryKey: nodeViewKeys.list(nodeUuid),
        });
        queryClient.invalidateQueries({
          queryKey: nodeViewKeys.byType(nodeUuid),
        });
      }
    },
  });
}
