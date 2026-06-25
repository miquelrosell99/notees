import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import {
  findNodeInCache,
  getRuntimeBlockIdForServerId,
  applyNodeIntent,
  getClassUuidByServerId,
  getNodeUuidByServerId,
} from './useNodeMutations.utils';
import { waitForOperationAck } from '@/sync/waitForOperation';
import * as nodesApi from '@/api/nodes';

/**
 * Hook to add a class to a node.
 *
 * The optimistic update is handled by OperationRuntime. SyncManager dispatches
 * the API call and writes the result back to the cache.
 */
export function useAddClass() {
  const queryClient = useQueryClient();

  return useMutation<Node | null, Error, { nodeId: string | number; classId: string | number }>({
    mutationFn: async ({ nodeId, classId }) => {
      await awaitAllContentSaves();

      const nodeUuid = typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      const classUuid = typeof classId === 'string' ? classId : getClassUuidByServerId(queryClient, classId);
      if (!classUuid) throw new Error('Class UUID not found');
      const blockId = typeof nodeId === 'string' ? null : getRuntimeBlockIdForServerId(nodeId);
      if (!blockId) {
        // Runtime fallback for nodes that are not loaded in the client graph.
        return nodesApi.addClass(nodeUuid, classUuid);
      }

      const operationId = applyNodeIntent({
        type: 'add_class',
        blockId,
        classId: classUuid,
      });
      await waitForOperationAck(operationId);
      return typeof nodeId === 'string' ? null : findNodeInCache(queryClient, nodeId);
    },
    onSuccess: (updatedNode, { nodeId, classId }) => {
      if (!updatedNode) return;

      const oldNode = typeof nodeId === 'string' ? null : findNodeInCache(queryClient, nodeId);

      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
      }

      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });

      if (updatedNode.parent_id !== null) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.parent_id) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_id) });
      }

      if (updatedNode.page_id !== null && updatedNode.page_id !== updatedNode.parent_id) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.page_id) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_id) });
      }

      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
