/**
 * React Query hooks for the trash feature.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { trashKeys, nodeKeys, favoriteKeys, recentKeys } from '@/hooks/queryKeys';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { getNodeUuidByServerId } from './useNodeMutations.utils';
import type { Node, PaginatedResponse } from '@/types/api';

function invalidateTrash(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: trashKeys.all });
  queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
}

function cleanupNode(queryClient: ReturnType<typeof useQueryClient>, nodeId: number) {
  const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
  if (nodeUuid && isFavorite(nodeUuid)) {
    removeFavorite(nodeUuid).catch(() => {});
  }
  removeRecent(nodeId);
}

export function useTrash() {
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: trashKeys.all,
    queryFn: () => nodesApi.getTrash(),
    select: (data) => data.items,
  });
}

export function useTrashMutations() {
  const queryClient = useQueryClient();

  const restore = useMutation({
    mutationFn: async (nodeId: number) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.restoreNode(nodeUuid);
    },
    onSuccess: () => invalidateTrash(queryClient),
  });

  const permanentDelete = useMutation({
    mutationFn: async (nodeId: number) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.permanentlyDeleteNode(nodeUuid);
    },
    onSuccess: (_data, nodeId) => {
      invalidateTrash(queryClient);
      cleanupNode(queryClient, nodeId);
    },
  });

  const emptyTrash = useMutation({
    mutationFn: nodesApi.emptyTrash,
    onSuccess: () => {
      invalidateTrash(queryClient);
      queryClient.invalidateQueries({ queryKey: favoriteKeys.all });
      queryClient.invalidateQueries({ queryKey: recentKeys.all });
    },
  });

  const batchDelete = useMutation({
    mutationFn: (ids: number[]) => nodesApi.batchPermanentlyDeleteNodes({ ids }),
    onSuccess: (_data, ids) => {
      invalidateTrash(queryClient);
      for (const nodeId of ids) {
        cleanupNode(queryClient, nodeId);
      }
    },
  });

  return { restore, permanentDelete, emptyTrash, batchDelete };
}
