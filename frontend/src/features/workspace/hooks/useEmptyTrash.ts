/**
 * React Query mutation for emptying the trash.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useWorkspaceStore } from '@/core/hooks';
import { queryNodes } from '@/core/query/queryNodes';
import { trashKeys, nodeKeys } from '@/hooks/queryKeys';

export function useEmptyTrash() {
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');

  return useMutation({
    mutationFn: async () => {
      if (!store) throw new Error('Workspace store is not ready');
      const archived = queryNodes(store, { includeArchived: true });
      for (const node of archived) {
        store.permanentDeleteNode(node.uuid);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trashKeys.all });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
    },
  });
}
