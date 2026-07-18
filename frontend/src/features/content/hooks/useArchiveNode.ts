import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';

/**
 * Hook to archive a node
 */
export function useArchiveNode() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store } = useWorkspaceStore(workspaceUuid ?? '');

  return useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!store) throw new Error('Workspace store is not ready');
      store.archiveNode(nodeUuid);
    },
    onMutate: (nodeUuid) => {
      if (nodeUuid && isFavorite(nodeUuid)) {
        removeFavorite(nodeUuid).catch(() => {});
      }
      removeRecent(nodeUuid);
    },
    onSuccess: (_data, nodeUuid) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists(), refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pseudoNodeQuery(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
    },
  });
}
