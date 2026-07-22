import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useWorkspaceStore, useUndoManager } from '@/core/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';

/**
 * Hook to remove a class from a node.
 *
 * The unassignment is applied (and undo-recorded) through the local-first core
 * store. No API fallback is kept during the migration.
 */
export function useRemoveClass() {
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');
  const manager = useUndoManager(workspaceId ?? '');

  return useMutation<void, Error, { nodeUuid: string; classId: string }>({
    mutationFn: async ({ nodeUuid, classId }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      const classUuid = classId;
      if (!classUuid) throw new Error('Class UUID not found');
      if (!store) throw new Error('Workspace store is not ready');

      if (manager) {
        await manager.unassignClass(nodeUuid, classUuid);
      } else {
        store.unassignClass(nodeUuid, classUuid);
      }
    },
    onSuccess: (_, { nodeUuid, classId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
