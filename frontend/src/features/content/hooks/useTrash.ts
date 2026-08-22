/**
 * React Query hooks for the trash feature.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { trashKeys, nodeKeys } from '@/hooks/queryKeys';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { getLogger } from '@/utils/logger';
import type { Node } from '@/types/api';

const log = getLogger('useTrash');

function invalidateTrash(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: trashKeys.all });
  queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
}

async function cleanupNode(workspaceUuid: string | null, nodeUuid: string) {
  if (!nodeUuid) return;
  const workspaceId = workspaceUuid ?? undefined;
  if (isFavorite(workspaceId, nodeUuid)) {
    removeFavorite(workspaceId, nodeUuid).catch((err) => {
      log.warn('Failed to remove favorite during cleanup', err);
    });
  }
  removeRecent(nodeUuid);
}

export function useTrash() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<Node[], Error>({
    queryKey: trashKeys.all,
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      return client.query<Node[]>('getTrashedNodes', []);
    },
    enabled: !!client,
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
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const restore = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('restoreNode', [nodeUuid]);
    },
    onSuccess: () => invalidateTrash(queryClient),
  });

  const permanentDelete = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('permanentDeleteNode', [nodeUuid]);
    },
    onSuccess: async (_data, nodeUuid) => {
      await cleanupNode(workspaceUuid, nodeUuid);
      invalidateTrash(queryClient);
    },
  });

  const emptyTrash = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      const nodes = await client.query<Node[]>('getTrashedNodes', []);
      for (const node of nodes) {
        await client.mutate<void>('permanentDeleteNode', [node.uuid]);
      }
    },
    onSuccess: async () => {
      invalidateTrash(queryClient);
    },
  });

  const batchDelete = useMutation({
    mutationFn: async (uuids: string[]) => {
      if (!client) throw new Error('Workspace store is not ready');
      for (const nodeUuid of uuids) {
        await client.mutate<void>('permanentDeleteNode', [nodeUuid]);
      }
    },
    onSuccess: async (_data, uuids) => {
      invalidateTrash(queryClient);
      for (const nodeUuid of uuids) {
        await cleanupNode(workspaceUuid, nodeUuid);
      }
    },
  });

  return { restore, permanentDelete, emptyTrash, batchDelete };
}
