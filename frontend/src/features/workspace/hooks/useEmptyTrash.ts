/**
 * React Query mutation for emptying the trash.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { trashKeys, nodeKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types/api';

export function useEmptyTrash() {
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  return useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      const archived = await client.query<Node[]>('getTrashedNodes', []);
      for (const node of archived) {
        await client.mutate<void>('permanentDeleteNode', [node.uuid]);
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
