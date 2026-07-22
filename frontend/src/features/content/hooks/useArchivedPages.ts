/**
 * React Query hooks for archived pages.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { archivedPagesKeys, nodeKeys } from '@/hooks/queryKeys';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import type { Node } from '@/types/api';

function invalidateArchived(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: archivedPagesKeys.all });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
}

async function cleanupNode(workspaceUuid: string | null, nodeUuid: string) {
  const workspaceId = workspaceUuid ?? undefined;
  if (nodeUuid && (await isFavorite(workspaceId, nodeUuid))) {
    removeFavorite(workspaceId, nodeUuid).catch(() => {});
  }
  removeRecent(nodeUuid);
}

export function useArchivedPages() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<Node[], Error>({
    queryKey: archivedPagesKeys.all,
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      return client.query<Node[]>('getArchivedPages', []);
    },
    enabled: !!client,
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
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const unarchive = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('restoreNode', [nodeUuid]);
    },
    onSuccess: () => invalidateArchived(queryClient),
  });

  const deleteNode = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('permanentDeleteNode', [nodeUuid]);
    },
    onSuccess: async (_data, nodeUuid) => {
      await cleanupNode(workspaceUuid, nodeUuid);
      invalidateArchived(queryClient);
    },
  });

  const deleteAll = useMutation({
    mutationFn: async (uuids: string[]) => {
      if (!client) throw new Error('Workspace store is not ready');
      for (const nodeUuid of uuids) {
        await client.mutate<void>('permanentDeleteNode', [nodeUuid]);
      }
    },
    onSuccess: async () => {
      invalidateArchived(queryClient);
    },
  });

  return { unarchive, deleteNode, deleteAll };
}
