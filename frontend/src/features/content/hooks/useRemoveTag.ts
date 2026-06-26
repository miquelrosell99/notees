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

  return useMutation<Node | null, Error, { nodeUuid: string; tagId: string }>({
    mutationFn: async ({ nodeUuid, tagId }) => {
      await awaitAllContentSaves();
      if (!nodeUuid) throw new Error('Node UUID not found');
      const tagUuid = tagId;
      if (!tagUuid) throw new Error('Tag UUID not found');
      const blockId = getRuntimeBlockIdForServerId(nodeUuid);
      if (!blockId) {
        await nodesApi.removeTagLink(nodeUuid, tagUuid);
        return findNodeInCache(queryClient, nodeUuid);
      }

      const operationId = applyNodeIntent({
        type: 'remove_tag',
        blockId,
        tagId: tagUuid,
      });
      await waitForOperationAck(operationId);
      return findNodeInCache(queryClient, nodeUuid);
    },
    onSuccess: (_data, { nodeUuid, tagId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byTag(tagId) });
    },
  });
}
