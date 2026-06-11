import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { useFavoritesStore } from '@/stores/favoritesStore';

/**
 * Hook to unarchive a node
 */
export function useUnarchiveNode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => nodesApi.unarchiveNode(id),
    onMutate: (nodeId) => {
      // Remove from favorites and recents immediately so the sidebar updates
      // even if the triggering component unmounts before onSuccess fires.
      const favoritesStore = useFavoritesStore.getState();
      if (favoritesStore.isFavorite(nodeId)) {
        favoritesStore.removeFavorite(nodeId);
      }
      favoritesStore.removeRecent(nodeId);
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
      // Invalidate backlinks and linked references since the unarchived node may now be referenced
      queryClient.invalidateQueries({
        queryKey: ['nodes', 'linked-refs'],
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: ['nodes', 'property-backlinks'],
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: ['nodes', 'backlinks'],
        refetchType: 'active',
      });
    },
  });
}
