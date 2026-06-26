import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { getOperationRuntime } from '@/runtime';
import {
  findNodeInCache,
  getRuntimeBlockIdForServerId,
  applyNodeIntent,
} from './useNodeMutations.utils';
import { waitForOperationAck } from '@/sync/waitForOperation';
import * as nodesApi from '@/api/nodes';

/**
 * Hook to move a node.
 *
 * The optimistic update is handled by OperationRuntime. SyncManager dispatches
 * the API call and writes the result back to the cache.
 */
export function useMoveNode() {
  const queryClient = useQueryClient();

  return useMutation<Node | null, Error, { nodeUuid: string; parentId: string | null; position?: number }>({
    mutationFn: async ({ nodeUuid, parentId, position }) => {
      const blockId = getRuntimeBlockIdForServerId(nodeUuid);
      if (!blockId) {
        return nodesApi.moveNode(nodeUuid, parentId ?? null, position);
      }

      // Resolve the runtime parent block id and the sibling to insert after.
      const runtime = getOperationRuntime();
      const parentBlockId = parentId ? getRuntimeBlockIdForServerId(parentId) : null;
      const siblings = parentBlockId ? runtime.getChildren(parentBlockId) : [];
      const afterIndex = position != null ? position - 1 : -1;
      const afterBlockId =
        afterIndex >= 0 && afterIndex < siblings.length ? siblings[afterIndex].blockId : null;

      const operationId = applyNodeIntent({
        type: 'move_node',
        blockId,
        parentId: parentBlockId,
        afterBlockId,
      });
      await waitForOperationAck(operationId);
      return findNodeInCache(queryClient, nodeUuid);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.details(), refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents(), refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.uuids(), refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists(), refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages(), refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll(), refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.breadcrumbsAll(), refetchType: 'none' });
    },
  });
}
