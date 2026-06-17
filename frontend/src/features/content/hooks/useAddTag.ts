import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import { findNodeInCache } from './useNodeMutations.utils';
import { updateNodeInTreeCaches, updateNodeInFlatCaches } from '@/hooks/cacheUtils';


/**
 * Hook to add a tag to a node (tags are stored in node.tag_ids)
 */
export function useAddTag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeId, tagId }: { nodeId: number; tagId: number }) => {
      await awaitAllContentSaves();
      return nodesApi.addTagLink(nodeId, tagId);
    },
    onMutate: async ({ nodeId, tagId }) => {
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(nodeId) });

      let oldNode = queryClient.getQueryData<Node>(nodeKeys.detailBase(nodeId));
      if (!oldNode) {
        oldNode = findNodeInCache(queryClient, nodeId) ?? undefined;
      }

      const newTags = [...(oldNode?.tags ?? []), tagId];
      const updates = { tags: newTags };

      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? { ...old, ...updates } : old
      );

      updateNodeInTreeCaches(queryClient, nodeId, (node) => ({ ...node, ...updates }));
      updateNodeInFlatCaches(queryClient, nodeId, (node) => ({ ...node, ...updates }));

      return { oldNode };
    },
    onError: (_err, { nodeId }, context) => {
      if (context?.oldNode) {
        const rollback = { tags: context.oldNode.tags };
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(nodeId), exact: false },
          (old) => old ? { ...old, ...rollback } : old
        );
        updateNodeInTreeCaches(queryClient, nodeId, (node) => ({ ...node, ...rollback }));
        updateNodeInFlatCaches(queryClient, nodeId, (node) => ({ ...node, ...rollback }));
      }
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
