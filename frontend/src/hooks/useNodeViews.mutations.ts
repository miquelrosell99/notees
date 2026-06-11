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
  reorderNodeViews,
  resetNodeViews,
  ensureDefaultViews,
} from '@/api/nodeViews';
import type {
  NodeViewCreate,
  NodeViewUpdate,
} from '@/types/nodeView';
import { nodeViewKeys } from './useNodeViews.queries';

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
          return key[0] === 'nodeViews' && key[1] === 'list' && key[2] === newView.node_id;
        },
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
 * Update query AST for a NodeView
 */
export function useUpdateQueryAST() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ viewId, queryAST }: { viewId: number; queryAST: Record<string, any> }) =>
      updateQueryAST(viewId, queryAST),
    onSuccess: (updatedView) => {
      // Update the cache for this view
      queryClient.setQueryData(nodeViewKeys.detail(updatedView.id), updatedView);
      // Invalidate ALL query results for this view (regardless of parameters)
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.queryResults(),
        predicate: (query) => {
          const key = query.queryKey;
          // Match ['nodeViews', 'queryResults', viewId, ...]
          return key[0] === 'nodeViews' && key[1] === 'queryResults' && key[2] === updatedView.id;
        },
      });
      // Also invalidate the list queries since the view was updated
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.list(updatedView.node_id),
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
 * Reset all views for a node to defaults
 */
export function useResetNodeViews() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (nodeId: number) => resetNodeViews(nodeId),
    onSuccess: async (newViews, nodeId) => {
      // First, remove all old view details and query results to prevent stale queries
      queryClient.removeQueries({
        queryKey: nodeViewKeys.details(),
      });
      queryClient.removeQueries({
        queryKey: nodeViewKeys.queryResults(),
      });
      
      // Set the new views in cache for individual view queries
      newViews.forEach((view) => {
        queryClient.setQueryData(nodeViewKeys.detail(view.id), view);
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
          nodeViewKeys.list(nodeId, viewType),
          views
        );
      });
      
      // Also set the full list (all view types)
      queryClient.setQueryData(
        nodeViewKeys.list(nodeId),
        newViews
      );
      
      // Invalidate byType queries
      await queryClient.invalidateQueries({
        queryKey: nodeViewKeys.byType(nodeId),
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

// ---- Batched ensure-defaults ----
// Collects all ensure-defaults requests that arrive in the same tick and
// fires ONE API call per unique nodeId.  This reduces the ~40 POSTs that
// fire on the journal view (4 view-types × 10 day-nodes) down to ~10.

/** Nodes already ensured this browser session (cleared on full-page reload). */
const _ensuredNodes = new Set<number>();

/** Pending batch: nodeId → { viewTypes to include, resolvers to notify }. */
const _pendingBatch = new Map<
  number,
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
    ensureDefaultViews(nodeId, viewTypesArr)
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
  nodeId: number,
  viewType: string
): Promise<void> {
  // Fast path: already ensured this session
  if (_ensuredNodes.has(nodeId)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let entry = _pendingBatch.get(nodeId);
    if (!entry) {
      entry = { viewTypes: new Set(), resolvers: [] };
      _pendingBatch.set(nodeId, entry);
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
    mutationFn: async ({ nodeId, viewTypes }: { nodeId: number; viewTypes?: string[] }) => {
      if (_ensuredNodes.has(nodeId)) return [];
      const views = await ensureDefaultViews(nodeId, viewTypes);
      _ensuredNodes.add(nodeId);
      return views;
    },
    onSuccess: (views) => {
      if (views.length > 0) {
        const nodeId = views[0].node_id;
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
