import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';

/**
 * Hook to unarchive a node
 */
export function useUnarchiveNode() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  return useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('restoreNode', [nodeUuid]);
    },
    onMutate: (nodeUuid) => {
      if (nodeUuid && isFavorite(workspaceUuid ?? undefined, nodeUuid)) {
        removeFavorite(workspaceUuid ?? undefined, nodeUuid).catch(() => {});
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
