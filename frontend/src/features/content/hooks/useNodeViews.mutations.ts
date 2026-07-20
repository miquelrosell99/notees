/**
 * NodeView Mutation Hooks
 *
 * Writes view definitions through the local-first core workspace store.
 */

import { useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeView, NodeViewCreate, NodeViewUpdate } from '@/types/nodeView';
import type { QueryAST } from '@/types';
import { resolveNodeUuid, resolveNodeViewUuid } from '@/utils/resolveNodeUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { getActiveWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { queryAll, queryOne } from '@/core/db/sqlite';
import { uuidv7 } from '@/core/uuid';
import { nodeViewKeys } from './useNodeViews.queries';

function requireViewUuid(viewId: string | number): string {
  const uuid = typeof viewId === 'string' ? viewId : resolveNodeViewUuid(viewId);
  if (!uuid) {
    throw new Error(`Unable to resolve UUID for view id ${viewId}`);
  }
  return uuid;
}

function useStore() {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  return useWorkspaceStore(workspaceId ?? '');
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readNodeView(store: NonNullable<ReturnType<typeof useStore>['store']>, viewId: string): NodeView | undefined {
  const row = queryOne<{
    id: string;
    node_id: string;
    name: string;
    view_type: string;
    order_index: number;
    is_default: number;
    active: number;
    shown_properties: string;
    group_by: string | null;
    view_mode: string | null;
    sort_entries: string;
    settings: string;
    query_ast: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>(store.getDb(), 'SELECT * FROM node_view WHERE id = ?', [viewId]);
  if (!row) return undefined;

  return {
    uuid: row.id,
    node_uuid: row.node_id,
    name: row.name,
    view_type: row.view_type,
    order_index: row.order_index,
    is_default: row.is_default !== 0,
    active: row.active !== 0,
    shown_properties: parseJson<Array<{ uuid: string; sequence: number }>>(row.shown_properties, []),
    group_by: parseJson<NodeView['group_by']>(row.group_by, null),
    view_mode: row.view_mode as NodeView['view_mode'],
    sort_entries: parseJson<NodeView['sort_entries']>(row.sort_entries, []),
    settings: parseJson<NodeView['settings']>(row.settings, {}),
    query_ast: parseJson<QueryAST | undefined>(row.query_ast, undefined),
    create_date: row.created_at ?? new Date().toISOString(),
    write_date: row.updated_at ?? new Date().toISOString(),
  };
}

export function useCreateNodeView() {
  const queryClient = useQueryClient();
  const { store } = useStore();

  return useMutation({
    mutationFn: (data: NodeViewCreate) => {
      if (!store) throw new Error('Workspace store is not ready');
      const viewId = store.createNodeView({
        viewId: uuidv7(),
        nodeId: data.node_uuid,
        name: data.name,
        viewType: data.view_type,
        orderIndex: data.order_index,
        isDefault: data.is_default,
        queryAst: data.query_ast,
      });
      const view = readNodeView(store, viewId);
      if (!view) throw new Error(`Created view ${viewId} not found`);
      return Promise.resolve(view);
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
  const { store } = useStore();

  return useMutation({
    mutationFn: ({ viewId, data }: { viewId: string | number; data: NodeViewUpdate }) => {
      if (!store) throw new Error('Workspace store is not ready');
      const uuid = requireViewUuid(viewId);
      const payload: Parameters<typeof store.updateNodeView>[0] = { viewId: uuid };
      if ('name' in data) payload.name = data.name ?? null;
      if ('order_index' in data) payload.orderIndex = data.order_index ?? null;
      if ('is_default' in data) payload.isDefault = data.is_default ?? null;
      if ('shown_properties' in data) payload.shownProperties = data.shown_properties ?? null;
      if ('group_by' in data) payload.groupBy = data.group_by ?? null;
      if ('view_mode' in data) payload.viewMode = data.view_mode ?? null;
      if ('sort_entries' in data) payload.sortEntries = data.sort_entries ?? null;
      if ('settings' in data) payload.settings = (data.settings as Record<string, unknown> | null) ?? null;
      if ('query_ast' in data) payload.queryAst = data.query_ast ?? null;
      store.updateNodeView(payload);
      const view = readNodeView(store, uuid);
      if (!view) throw new Error(`Updated view ${uuid} not found`);
      return Promise.resolve(view);
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
  const { store } = useStore();

  return useMutation({
    mutationFn: (viewId: string) => {
      if (!store) throw new Error('Workspace store is not ready');
      const uuid = requireViewUuid(viewId);
      const row = queryOne<{
        node_id: string;
        name: string;
        view_type: string;
        order_index: number;
        shown_properties: string;
        group_by: string | null;
        view_mode: string | null;
        sort_entries: string;
        settings: string;
        query_ast: string | null;
      }>(store.getDb(), 'SELECT * FROM node_view WHERE id = ?', [uuid]);
      if (!row) throw new Error(`View ${uuid} not found`);

      const newViewId = uuidv7();
      store.createNodeView({
        viewId: newViewId,
        nodeId: row.node_id,
        name: `${row.name} (Copy)`,
        viewType: row.view_type,
        orderIndex: row.order_index + 1,
        isDefault: false,
        shownProperties: parseJson<Array<{ uuid: string; sequence: number }>>(row.shown_properties, []),
        groupBy: parseJson<unknown | null>(row.group_by, null),
        viewMode: row.view_mode,
        sortEntries: parseJson<unknown[]>(row.sort_entries, []),
        settings: parseJson<Record<string, unknown>>(row.settings, {}),
        queryAst: parseJson<unknown>(row.query_ast, undefined),
      });
      const view = readNodeView(store, newViewId);
      if (!view) throw new Error(`Duplicated view ${newViewId} not found`);
      return Promise.resolve(view);
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
  const { store } = useStore();

  return useMutation({
    mutationFn: ({ viewId, queryAST }: { viewId: string; queryAST: QueryAST }) => {
      if (!store) throw new Error('Workspace store is not ready');
      store.updateNodeView({ viewId, queryAst: queryAST });
      const view = readNodeView(store, viewId);
      if (!view) throw new Error(`Updated view ${viewId} not found`);
      return Promise.resolve(view);
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
  const { store } = useStore();

  return useMutation({
    mutationFn: (viewId: string) => {
      if (!store) throw new Error('Workspace store is not ready');
      store.deleteNodeView(requireViewUuid(viewId));
      return Promise.resolve();
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
  const { store } = useStore();

  return useMutation({
    mutationFn: (nodeUuid: string) => {
      if (!store) throw new Error('Workspace store is not ready');
      const nodeId = resolveNodeUuid(nodeUuid);
      const node = store.getNode(nodeId);
      const isClass = node?.kind === 'class';

      const activeViews = queryAll<{ id: string }>(
        store.getDb(),
        'SELECT id FROM node_view WHERE node_id = ? AND active = 1',
        [nodeId]
      );
      for (const { id: viewId } of activeViews) {
        store.deleteNodeView(viewId);
      }

      const viewTypes = isClass
        ? ['child_pages', 'linked_references', 'unlinked_references', 'classed_nodes', 'extended_by']
        : ['child_pages', 'linked_references', 'unlinked_references'];
      const created = store.ensureDefaultNodeViews(nodeId, viewTypes);
      return Promise.resolve(created);
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
  const { store } = useStore();

  return useMutation({
    mutationFn: ({
      nodeUuid,
      viewType,
      viewIds,
    }: {
      nodeUuid: string;
      viewType: string;
      viewIds: string[];
    }) => {
      if (!store) throw new Error('Workspace store is not ready');
      store.reorderNodeViews({
        nodeId: resolveNodeUuid(nodeUuid),
        viewType,
        orderedViewIds: viewIds.map(requireViewUuid),
      });
      return Promise.resolve();
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

function flushBatch() {
  _flushScheduled = false;
  const batch = new Map(_pendingBatch);
  _pendingBatch.clear();

  const store = getActiveWorkspaceStore();

  batch.forEach(({ viewTypes, resolvers }, nodeUuid) => {
    const nodeId = resolveNodeUuid(nodeUuid);
    if (_ensuredNodes.has(nodeId)) {
      resolvers.forEach((r) => r());
      return;
    }

    if (!store) {
      // Store is not open yet; defer to the next ensure call.
      resolvers.forEach((r) => r());
      return;
    }

    try {
      store.ensureDefaultNodeViews(nodeId, [...viewTypes]);
      _ensuredNodes.add(nodeId);
    } catch (err) {
      console.error(`ensureDefaultNodeViews failed for node ${nodeId}:`, err);
    } finally {
      resolvers.forEach((r) => r());
    }
  });
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
  const { store } = useStore();

  return useMutation({
    mutationFn: async ({ nodeUuid, viewTypes }: { nodeUuid: string; viewTypes?: string[] }) => {
      if (!store) throw new Error('Workspace store is not ready');
      const nodeId = resolveNodeUuid(nodeUuid);
      if (_ensuredNodes.has(nodeId)) return [];
      const types = viewTypes ?? ['child_pages', 'linked_references', 'unlinked_references'];
      const created = store.ensureDefaultNodeViews(nodeId, types);
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
