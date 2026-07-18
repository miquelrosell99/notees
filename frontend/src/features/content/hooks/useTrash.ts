/**
 * React Query hooks for the trash feature.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { trashKeys, nodeKeys } from '@/hooks/queryKeys';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { projectNode } from '@/core/adapters/nodeProjection';
import { queryAll } from '@/core/db/sqlite';
import type { Node, PaginatedResponse } from '@/types/api';

function invalidateTrash(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: trashKeys.all });
  queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
}

function cleanupNode(nodeUuid: string) {
  if (!nodeUuid) return;
  if (isFavorite(nodeUuid)) {
    removeFavorite(nodeUuid).catch(() => {});
  }
  removeRecent(nodeUuid);
}

export function useTrash() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: trashKeys.all,
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      const rows = queryAll<{ id: string }>(store.getDb(), 'SELECT id FROM node WHERE active = 0 ORDER BY updated_at DESC');
      const items = rows
        .map((row) => projectNode(store, row.id))
        .filter((n): n is Node => n !== undefined);
      return {
        items,
        total: items.length,
        page: 1,
        page_size: items.length,
        has_next: false,
        has_prev: false,
      };
    },
    select: (data) => data.items,
    enabled: !!store,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

export function useTrashMutations() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store } = useWorkspaceStore(workspaceUuid ?? '');

  const restore = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!store) throw new Error('Workspace store is not ready');
      store.restoreNode(nodeUuid);
    },
    onSuccess: () => invalidateTrash(queryClient),
  });

  const permanentDelete = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!store) throw new Error('Workspace store is not ready');
      store.permanentDeleteNode(nodeUuid);
    },
    onSuccess: (_data, nodeUuid) => {
      invalidateTrash(queryClient);
      cleanupNode(nodeUuid);
    },
  });

  const emptyTrash = useMutation({
    mutationFn: async () => {
      if (!store) throw new Error('Workspace store is not ready');
      const rows = queryAll<{ id: string }>(store.getDb(), 'SELECT id FROM node WHERE active = 0');
      for (const row of rows) {
        store.permanentDeleteNode(row.id);
      }
    },
    onSuccess: () => {
      invalidateTrash(queryClient);
    },
  });

  const batchDelete = useMutation({
    mutationFn: async (uuids: string[]) => {
      if (!store) throw new Error('Workspace store is not ready');
      for (const nodeUuid of uuids) {
        store.permanentDeleteNode(nodeUuid);
      }
    },
    onSuccess: (_data, uuids) => {
      invalidateTrash(queryClient);
      for (const nodeUuid of uuids) {
        cleanupNode(nodeUuid);
      }
    },
  });

  return { restore, permanentDelete, emptyTrash, batchDelete };
}
