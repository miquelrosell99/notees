import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import {
  findNodeInCache,
  getRuntimeBlockIdForServerId,
  applyNodeIntent,
} from './useNodeMutations.utils';
import { waitForOperationAck } from '@/sync/waitForOperation';
import * as nodesApi from '@/api/nodes';

/**
 * Hook to remove a class from a node.
 *
 * The optimistic update is handled by OperationRuntime. SyncManager dispatches
 * the API call and writes the result back to the cache.
 */
export function useRemoveClass() {
  const queryClient = useQueryClient();

  return useMutation<Node | null, Error, { nodeId: number; classId: number }>({
    mutationFn: async ({ nodeId, classId }) => {
      await awaitAllContentSaves();

      const blockId = getRuntimeBlockIdForServerId(nodeId);
      if (!blockId) {
        return nodesApi.removeClass(nodeId, classId);
      }

      const operationId = applyNodeIntent({
        type: 'remove_class',
        blockId,
        classId: String(classId),
      });
      await waitForOperationAck(operationId);
      return findNodeInCache(queryClient, nodeId);
    },
    onSuccess: (updatedNode, { nodeId, classId }) => {
      if (!updatedNode) return;

      const oldNode = findNodeInCache(queryClient, nodeId);

      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });

      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
      }

      if (oldNode && oldNode.is_class !== updatedNode.is_class) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      }

      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });

      if (updatedNode.page_id !== null && updatedNode.page_id !== nodeId) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_id) });
      }
      if (updatedNode.parent_id !== null && updatedNode.parent_id !== nodeId) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_id) });
      }

      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
