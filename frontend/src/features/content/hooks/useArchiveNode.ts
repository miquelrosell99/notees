import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { isFavorite, removeFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { getLogger } from '@/utils/logger';

const log = getLogger('useArchiveNode');

/**
 * Hook to archive a node
 */
export function useArchiveNode() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  return useMutation({
    mutationFn: async (nodeUuid: string) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('archiveNode', [nodeUuid]);
    },
    onMutate: (nodeUuid) => {
      if (nodeUuid && isFavorite(workspaceUuid ?? undefined, nodeUuid)) {
        removeFavorite(workspaceUuid ?? undefined, nodeUuid).catch((err) => {
          log.warn('Failed to remove favorite for archived node', err);
        });
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
