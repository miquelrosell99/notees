import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import * as nodesApi from '@/api/nodes';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import {
  findNodeInCache,
  ensureNodeInRuntime,
  applyNodeIntent,
} from './useNodeMutations.utils';
import { waitForOperationAck } from '@/sync/waitForOperation';

/**
 * Hook to add a class to a node.
 *
 * The optimistic update is handled by OperationRuntime. SyncManager dispatches
 * the API call and writes the result back to the cache.
 */
export function useAddClass() {
  const queryClient = useQueryClient();

  return useMutation<Node | null, Error, { nodeUuid: string; classId: string }>({
    mutationFn: async ({ nodeUuid, classId }) => {
      await awaitAllContentSaves();
      if (!nodeUuid) throw new Error('Node UUID not found');
      const classUuid = classId;
      if (!classUuid) throw new Error('Class UUID not found');
      const blockId = ensureNodeInRuntime(nodeUuid);

      if (blockId) {
        // Optimistic runtime path
        const operationId = await applyNodeIntent({
          type: 'add_class',
          blockId,
          classId: classUuid,
        });
        await waitForOperationAck(operationId);
        return findNodeInCache(queryClient, nodeUuid);
      }

      // Fallback: node is not in the runtime or any cache, use direct API
      return nodesApi.addClass(nodeUuid, classUuid);
    },
    onSuccess: (updatedNode, { nodeUuid, classId }) => {
      if (!updatedNode) return;

      const oldNode = findNodeInCache(queryClient, nodeUuid);

      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
      }

      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });

      if (updatedNode.parent_uuid !== null) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.parent_uuid) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_uuid) });
      }

      if (updatedNode.page_uuid !== null && updatedNode.page_uuid !== updatedNode.parent_uuid) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.page_uuid) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_uuid) });
      }

      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
