import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import {
  findNodeInCache,
  getRuntimeBlockIdForServerId,
  applyNodeIntent,
  getNodeUuidByServerId,
  getTagUuidByServerId,
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

  return useMutation<Node | null, Error, { nodeId: string | number; tagId: string | number }>({
    mutationFn: async ({ nodeId, tagId }) => {
      await awaitAllContentSaves();

      const nodeUuid = typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
      if (!nodeUuid) throw new Error('Node UUID not found');
      const tagUuid = typeof tagId === 'string' ? tagId : getTagUuidByServerId(queryClient, tagId);
      if (!tagUuid) throw new Error('Tag UUID not found');
      const blockId = typeof nodeId === 'string' ? null : getRuntimeBlockIdForServerId(nodeId);
      if (!blockId) {
        await nodesApi.removeTagLink(nodeUuid, tagUuid);
        return typeof nodeId === 'string' ? null : findNodeInCache(queryClient, nodeId);
      }

      const operationId = applyNodeIntent({
        type: 'remove_tag',
        blockId,
        tagId: tagUuid,
      });
      await waitForOperationAck(operationId);
      return typeof nodeId === 'string' ? null : findNodeInCache(queryClient, nodeId);
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
