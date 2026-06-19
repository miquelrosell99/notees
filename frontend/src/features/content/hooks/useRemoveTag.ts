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
 * Hook to remove a tag from a node (tags are stored in node.tag_ids).
 *
 * The optimistic update is handled by OperationRuntime. SyncManager dispatches
 * the API call and writes the result back to the cache.
 */
export function useRemoveTag() {
  const queryClient = useQueryClient();

  return useMutation<Node | null, Error, { nodeId: number; tagId: number }>({
    mutationFn: async ({ nodeId, tagId }) => {
      await awaitAllContentSaves();

      const blockId = getRuntimeBlockIdForServerId(nodeId);
      if (!blockId) {
        await nodesApi.removeTagLink(nodeId, tagId);
        return findNodeInCache(queryClient, nodeId);
      }

      const operationId = applyNodeIntent({
        type: 'remove_tag',
        blockId,
        tagId: String(tagId),
      });
      await waitForOperationAck(operationId);
      return findNodeInCache(queryClient, nodeId);
    },
    onSuccess: (_data, { nodeId, tagId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byTag(tagId) });
    },
  });
}
