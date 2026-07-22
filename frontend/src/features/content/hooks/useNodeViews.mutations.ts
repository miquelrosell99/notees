/**
 * NodeView Mutation Hooks
 *
 * Writes view definitions through the local-first core workspace store via the
 * async worker-backed client.
 */

import { useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeView, NodeViewCreate, NodeViewUpdate } from '@/types/nodeView';
import type { QueryAST } from '@/types';
import { resolveNodeUuid, resolveNodeViewUuid } from '@/utils/resolveNodeUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { getActiveWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import { uuidv7 } from '@/core/uuid';
import type { NodeRow } from '@/core/store';
import { nodeViewKeys } from './useNodeViews.queries';

function requireViewUuid(viewId: string | number): string {
  const uuid = typeof viewId === 'string' ? viewId : resolveNodeViewUuid(viewId);
  if (!uuid) {
    throw new Error(`Unable to resolve UUID for view id ${viewId}`);
  }
  return uuid;
}

function useClient() {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  return useWorkspaceStoreClient(workspaceId ?? '');
}

async function readNodeView(client: NonNullable<ReturnType<typeof useClient>['client']>, viewId: string): Promise<NodeView> {
  const view = await client.query<NodeView | undefined>('getNodeView', [viewId]);
  if (!view) throw new Error(`View ${viewId} not found`);
  return view;
}

export function useCreateNodeView() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation({
    mutationFn: async (data: NodeViewCreate) => {
      if (!client) throw new Error('Workspace store is not ready');
      const viewId = uuidv7();
      await client.mutate<void>('createNodeView', [
        {
          viewId,
          nodeId: data.node_uuid,
          name: data.name,
          viewType: data.view_type,
          orderIndex: data.order_index,
          isDefault: data.is_default,
          queryAst: data.query_ast,
        },
      ]);
      return readNodeView(client, viewId);
    },
    onSuccess: (newView) => {
      queryClient.setQueryData(nodeViewKeys.detail(newView.uuid), newView);
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(newView.node_uuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(newView.node_uuid) });
    },
  });
}

/**
 * Update a NodeView
 */
export function useUpdateNodeView() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation({
    mutationFn: async ({ viewId, data }: { viewId: string | number; data: NodeViewUpdate }) => {
      if (!client) throw new Error('Workspace store is not ready');
      const uuid = requireViewUuid(viewId);
      const payload: {
        viewId: string;
        name?: string | null;
        orderIndex?: number | null;
        isDefault?: boolean | null;
        shownProperties?: Array<{ uuid: string; sequence: number }> | null;
        groupBy?: NodeView['group_by'] | null;
        viewMode?: NodeView['view_mode'] | null;
        sortEntries?: NodeView['sort_entries'] | null;
        settings?: Record<string, unknown> | null;
        queryAst?: QueryAST | null;
      } = { viewId: uuid };
      if ('name' in data) payload.name = data.name ?? null;
      if ('order_index' in data) payload.orderIndex = data.order_index ?? null;
      if ('is_default' in data) payload.isDefault = data.is_default ?? null;
      if ('shown_properties' in data) payload.shownProperties = data.shown_properties ?? null;
      if ('group_by' in data) payload.groupBy = data.group_by ?? null;
      if ('view_mode' in data) payload.viewMode = data.view_mode ?? null;
      if ('sort_entries' in data) payload.sortEntries = data.sort_entries ?? null;
      if ('settings' in data) payload.settings = (data.settings as Record<string, unknown> | null) ?? null;
      if ('query_ast' in data) payload.queryAst = (data.query_ast as QueryAST | undefined) ?? null;
      await client.mutate<void>('updateNodeView', [payload]);
      return readNodeView(client, uuid);
    },
    onSuccess: (updatedView) => {
      queryClient.setQueryData(nodeViewKeys.detail(updatedView.uuid), updatedView);
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
    },
  });
}

/**
 * Duplicate a NodeView (copies query AST + full presentation config)
 */
export function useDuplicateNodeView() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation({
    mutationFn: async (viewId: string) => {
      if (!client) throw new Error('Workspace store is not ready');
      const uuid = requireViewUuid(viewId);
      const row = await client.query<NodeView | undefined>('getNodeView', [uuid]);
      if (!row) throw new Error(`View ${uuid} not found`);

      const newViewId = uuidv7();
      await client.mutate<void>('createNodeView', [
        {
          viewId: newViewId,
          nodeId: row.node_uuid,
          name: `${row.name} (Copy)`,
          viewType: row.view_type,
          orderIndex: row.order_index + 1,
          isDefault: false,
          shownProperties: row.shown_properties,
          groupBy: row.group_by,
          viewMode: row.view_mode,
          sortEntries: row.sort_entries,
          settings: row.settings,
          queryAst: row.query_ast,
        },
      ]);
      return readNodeView(client, newViewId);
    },
    onSuccess: (newView, _viewId) => {
      queryClient.setQueryData(nodeViewKeys.detail(newView.uuid), newView);
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.lists() });
    },
  });
}

/**
 * Update query AST for a NodeView
 */
export function useUpdateQueryAST() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation({
    mutationFn: async ({ viewId, queryAST }: { viewId: string; queryAST: QueryAST }) => {
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('updateNodeView', [{ viewId, queryAst: queryAST }]);
      return readNodeView(client, viewId);
    },
    onSuccess: (updatedView) => {
      queryClient.setQueryData(nodeViewKeys.detail(updatedView.uuid), updatedView);
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.lists() });
    },
  });
}

/**
 * Delete a NodeView
 */
export function useDeleteNodeView() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation({
    mutationFn: async (viewId: string) => {
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('deleteNodeView', [requireViewUuid(viewId)]);
    },
    onSuccess: (_data, viewId) => {
      queryClient.removeQueries({ queryKey: nodeViewKeys.detail(viewId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
    },
  });
}

/**
 * Reset all views for a node to defaults
 */
export function useResetNodeViews() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!client) throw new Error('Workspace store is not ready');
      const nodeId = resolveNodeUuid(nodeUuid);
      const node = await client.query<NodeRow | undefined>('getNode', [nodeId]);
      const isClass = node?.kind === 'class';

      const activeViews = await client.query<NodeView[]>('getNodeViews', [nodeId, { includeQueryAST: false }]);
      for (const view of activeViews) {
        await client.mutate<void>('deleteNodeView', [view.uuid]);
      }

      const viewTypes = isClass
        ? ['child_pages', 'linked_references', 'unlinked_references', 'classed_nodes', 'extended_by']
        : ['child_pages', 'linked_references', 'unlinked_references'];
      const created = await client.mutate<string[]>('ensureDefaultNodeViews', [nodeId, viewTypes]);
      return created;
    },
    onSuccess: (newViewIds, nodeUuid) => {
      queryClient.removeQueries({ queryKey: nodeViewKeys.details() });
      queryClient.removeQueries({ queryKey: nodeViewKeys.queryResults() });
      for (const viewId of newViewIds) {
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.detail(viewId) });
      }
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeUuid) });
    },
  });
}

/**
 * Reorder NodeViews within a view_type
 */
export function useReorderNodeViews() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation({
    mutationFn: async ({
      nodeUuid,
      viewType,
      viewIds,
    }: {
      nodeUuid: string;
      viewType: string;
      viewIds: string[];
    }) => {
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('reorderNodeViews', [
        {
          nodeId: resolveNodeUuid(nodeUuid),
          viewType,
          orderedViewIds: viewIds.map(requireViewUuid),
        },
      ]);
    },
    onSuccess: (_data, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeUuid) });
    },
  });
}

// ---- Batched ensure-defaults ----

/** Nodes already ensured this browser session (cleared on full-page reload). */
const _ensuredNodes = new Set<string>();

/** Pending batch: nodeUuid → { viewTypes to include, resolvers to notify }. */
const _pendingBatch = new Map<
  string,
  { viewTypes: Set<string>; resolvers: Array<() => void> }
>();
let _flushScheduled = false;

async function flushBatch() {
  _flushScheduled = false;
  const batch = new Map(_pendingBatch);
  _pendingBatch.clear();

  const client = getActiveWorkspaceStoreClient();

  for (const [nodeUuid, { viewTypes, resolvers }] of batch) {
    const nodeId = resolveNodeUuid(nodeUuid);
    if (_ensuredNodes.has(nodeId)) {
      resolvers.forEach((r) => r());
      continue;
    }

    if (!client) {
      // Store is not open yet; defer to the next ensure call.
      resolvers.forEach((r) => r());
      continue;
    }

    try {
      await client.mutate<void>('ensureDefaultNodeViews', [nodeId, [...viewTypes]]);
      _ensuredNodes.add(nodeId);
    } catch (err) {
      console.error(`ensureDefaultNodeViews failed for node ${nodeId}:`, err);
    } finally {
      resolvers.forEach((r) => r());
    }
  }
}

/**
 * Queue an ensure-defaults request. All requests that arrive in the same
 * micro-task are batched into a single store write per node.
 */
export function batchEnsureDefaults(nodeUuid: string, viewType: string): Promise<void> {
  const nodeId = resolveNodeUuid(nodeUuid);
  if (_ensuredNodes.has(nodeId)) return Promise.resolve();

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
      queueMicrotask(flushBatch);
    }
  });
}

/**
 * Ensure default views exist for a node (lazy initialization).
 */
export function useEnsureDefaultViews() {
  const queryClient = useQueryClient();
  const { client } = useClient();

  return useMutation({
    mutationFn: async ({ nodeUuid, viewTypes }: { nodeUuid: string; viewTypes?: string[] }) => {
      if (!client) throw new Error('Workspace store is not ready');
      const nodeId = resolveNodeUuid(nodeUuid);
      if (_ensuredNodes.has(nodeId)) return [];
      const types = viewTypes ?? ['child_pages', 'linked_references', 'unlinked_references'];
      const created = await client.mutate<string[]>('ensureDefaultNodeViews', [nodeId, types]);
      _ensuredNodes.add(nodeId);
      return created;
    },
    onSuccess: (created, { nodeUuid }) => {
      if (created.length > 0) {
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeUuid) });
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeUuid) });
      }
    },
  });
}
