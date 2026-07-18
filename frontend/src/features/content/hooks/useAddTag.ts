import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { Node } from '@/types/api';
import { useWorkspaceStore, useUndoManager } from '@/core/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { findNodeInCache } from './useNodeMutations.utils';

/**
 * Hook to add a tag to a node (tags are stored in node.tag_ids).
 *
 * The optimistic update is handled by the local-first core store. Tags are
 * represented as class assignments in the core model.
 */
export function useAddTag() {
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');
  const manager = useUndoManager(workspaceId ?? '');

  return useMutation<Node | null, Error, { nodeUuid: string; tagId: string }>({
    mutationFn: async ({ nodeUuid, tagId }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      const tagUuid = tagId;
      if (!tagUuid) throw new Error('Tag UUID not found');
      if (!store || !manager) {
        throw new Error(`Node ${nodeUuid} is not available in the workspace store`);
      }

      manager.assignClass(nodeUuid, tagUuid);
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
