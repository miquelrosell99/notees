import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { getNodeUuidByServerId } from './useNodeMutations.utils';


/**
 * Hook to archive a node
 */
export function useArchiveNode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, id);
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.archiveNode(nodeUuid);
    },
    onMutate: (nodeId) => {
      // Remove from favorites and recents immediately so the sidebar updates
      // even if the triggering component unmounts before onSuccess fires.
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      if (nodeUuid && isFavorite(nodeUuid)) {
        removeFavorite(nodeUuid).catch(() => {});
      }
      removeRecent(nodeId);
    },
    onSuccess: (node) => {
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(node.id) },
        () => node
      );
      queryClient.invalidateQueries({
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pages(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.queryResults(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pseudoNodeQuery(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.archived(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.graph(),
        refetchType: 'none',
      });
      // Invalidate backlinks and linked references since the archived node may be referenced
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allLinkedRefs(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allPropertyBacklinks(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allBacklinks(),
        refetchType: 'active',
      });
    },
  });
}
