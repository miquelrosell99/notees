/**
 * React Query hooks for the trash feature.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { trashKeys, nodeKeys } from '@/hooks/queryKeys';
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

function cleanupNode(nodeUuid: string) {
  if (!nodeUuid) return;
  if (isFavorite(nodeUuid)) {
    removeFavorite(nodeUuid).catch(() => {});
  }
  removeRecent(nodeUuid);
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
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.restoreNode(nodeUuid);
    },
    onSuccess: () => invalidateTrash(queryClient),
  });

  const permanentDelete = useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.permanentlyDeleteNode(nodeUuid);
    },
    onSuccess: (_data, nodeUuid) => {
      invalidateTrash(queryClient);
      cleanupNode(nodeUuid);
    },
  });

  const emptyTrash = useMutation({
    mutationFn: nodesApi.emptyTrash,
    onSuccess: () => {
      invalidateTrash(queryClient);
    },
  });

  const batchDelete = useMutation({
    mutationFn: (uuids: string[]) => nodesApi.batchPermanentlyDeleteNodes({ uuids }),
    onSuccess: (_data, uuids) => {
      invalidateTrash(queryClient);
      for (const nodeUuid of uuids) {
        cleanupNode(nodeUuid);
      }
    },
  });

  return { restore, permanentDelete, emptyTrash, batchDelete };
}
