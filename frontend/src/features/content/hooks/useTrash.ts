/**
 * React Query hooks for the trash feature.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { trashKeys, nodeKeys, favoriteKeys, recentKeys } from '@/hooks/queryKeys';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import type { Node, PaginatedResponse } from '@/types/api';

function invalidateTrash(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: trashKeys.all });
  queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
}

function cleanupNode(nodeId: number) {
  if (isFavorite(nodeId)) {
    removeFavorite(nodeId).catch(() => {});
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
    mutationFn: nodesApi.restoreNode,
    onSuccess: () => invalidateTrash(queryClient),
  });

  const permanentDelete = useMutation({
    mutationFn: nodesApi.permanentlyDeleteNode,
    onSuccess: (_data, nodeId) => {
      invalidateTrash(queryClient);
      cleanupNode(nodeId);
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
        cleanupNode(nodeId);
      }
    },
  });

  return { restore, permanentDelete, emptyTrash, batchDelete };
}
