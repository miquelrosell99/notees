/**
 * React Query hooks for archived pages.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/api/client';
import * as nodesApi from '@/api/nodes';
import { archivedPagesKeys, nodeKeys } from '@/hooks/queryKeys';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { getNodeUuidByServerId } from './useNodeMutations.utils';
import type { Node } from '@/types/api';

function invalidateArchived(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: archivedPagesKeys.all });
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

export function useArchivedPages() {
  return useQuery<Node[], Error>({
    queryKey: archivedPagesKeys.all,
    queryFn: async () => {
      const response = await api.get<{ pages: Node[] }>('/nodes/archived');
      return response.data.pages;
    },
  });
}

export function useArchivedPagesMutations() {
  const queryClient = useQueryClient();

  const unarchive = useMutation({
    mutationFn: async (nodeId: number) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.unarchiveNode(nodeUuid);
    },
    onSuccess: () => invalidateArchived(queryClient),
  });

  const deleteNode = useMutation({
    mutationFn: async (nodeId: number) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.deleteNode(nodeUuid);
    },
    onSuccess: (_data, nodeId) => {
      cleanupNode(queryClient, nodeId);
      invalidateArchived(queryClient);
    },
  });

  const deleteAll = useMutation({
    mutationFn: (uuids: string[]) => nodesApi.batchDeleteNodes({ uuids }),
    onSuccess: () => invalidateArchived(queryClient),
  });

  return { unarchive, deleteNode, deleteAll };
}
