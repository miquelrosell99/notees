import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import {
  findNodeInCache,
  ensureNodeInRuntime,
  applyNodeIntent,
} from './useNodeMutations.utils';
import { waitForOperationAck } from '@/sync/waitForOperation';

/**
 * Hook to remove a class from a node.
 *
 * The optimistic update is handled by OperationRuntime. SyncManager dispatches
 * the API call and writes the result back to the cache.
 */
export function useRemoveClass() {
  const queryClient = useQueryClient();

  return useMutation<Node | null, Error, { nodeUuid: string; classId: string }>({
    mutationFn: async ({ nodeUuid, classId }) => {
      await awaitAllContentSaves();
      if (!nodeUuid) throw new Error('Node UUID not found');
      const classUuid = classId;
      if (!classUuid) throw new Error('Class UUID not found');
      const blockId = ensureNodeInRuntime(nodeUuid);
      if (!blockId) {
        throw new Error(`Node ${nodeUuid} is not available in the runtime`);
      }

      const operationId = await applyNodeIntent({
        type: 'remove_class',
        blockId,
        classId: classUuid,
      });
      await waitForOperationAck(operationId);
      return findNodeInCache(queryClient, nodeUuid);
    },
    onSuccess: (updatedNode, { nodeUuid, classId }) => {
      if (!updatedNode) return;

      const oldNode = findNodeInCache(queryClient, nodeUuid);

      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });

      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
      }

      if (oldNode && oldNode.is_class !== updatedNode.is_class) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      }

      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });

      if (updatedNode.page_uuid !== null && updatedNode.page_uuid !== nodeUuid) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_uuid) });
      }
      if (updatedNode.parent_uuid !== null && updatedNode.parent_uuid !== nodeUuid) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_uuid) });
      }

      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
