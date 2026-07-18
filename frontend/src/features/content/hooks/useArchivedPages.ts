/**
 * React Query hooks for archived pages.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { archivedPagesKeys, nodeKeys } from '@/hooks/queryKeys';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { projectNode } from '@/core/adapters/nodeProjection';
import { queryAll } from '@/core/db/sqlite';
import type { Node } from '@/types/api';

function invalidateArchived(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: archivedPagesKeys.all });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
}

function cleanupNode(nodeUuid: string) {
  if (nodeUuid && isFavorite(nodeUuid)) {
    removeFavorite(nodeUuid).catch(() => {});
  }
  removeRecent(nodeUuid);
}

export function useArchivedPages() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<Node[], Error>({
    queryKey: archivedPagesKeys.all,
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      const rows = queryAll<{ id: string }>(
        store.getDb(),
        "SELECT id FROM node WHERE kind = 'page' AND active = 0 ORDER BY updated_at DESC"
      );
      return rows
        .map((row) => projectNode(store, row.id))
        .filter((n): n is Node => n !== undefined);
    },
    enabled: !!store,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

export function useArchivedPagesMutations() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store } = useWorkspaceStore(workspaceUuid ?? '');

  const unarchive = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!store) throw new Error('Workspace store is not ready');
      store.restoreNode(nodeUuid);
    },
    onSuccess: () => invalidateArchived(queryClient),
  });

  const deleteNode = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!store) throw new Error('Workspace store is not ready');
      store.permanentDeleteNode(nodeUuid);
    },
    onSuccess: (_data, nodeUuid) => {
      cleanupNode(nodeUuid);
      invalidateArchived(queryClient);
    },
  });

  const deleteAll = useMutation({
    mutationFn: async (uuids: string[]) => {
      if (!store) throw new Error('Workspace store is not ready');
      for (const nodeUuid of uuids) {
        store.permanentDeleteNode(nodeUuid);
      }
    },
    onSuccess: () => invalidateArchived(queryClient),
  });

  return { unarchive, deleteNode, deleteAll };
}
