import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';

/**
 * Hook to archive a node
 */
export function useArchiveNode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.archiveNode(nodeUuid);
    },
    onMutate: (nodeUuid) => {
      // Remove from favorites and recents immediately so the sidebar updates
      // even if the triggering component unmounts before onSuccess fires.
      if (nodeUuid && isFavorite(nodeUuid)) {
        removeFavorite(nodeUuid).catch(() => {});
      }
      removeRecent(nodeUuid);
    },
    onSuccess: (node) => {
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(node.uuid) },
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
        queryKey: nodeKeys.searchAll(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allBacklinks(),
        refetchType: 'active',
      });
    },
  });
}
