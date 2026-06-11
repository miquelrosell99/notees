import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import { awaitAllContentSaves } from './contentSaveTracker';

/**
 * Hook to remove a tag from a node (tags are stored as links with is_tag=true)
 */
export function useRemoveTag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeId, tagId }: { nodeId: number; tagId: number }) => {
      await awaitAllContentSaves();
      return nodesApi.removeTagLink(nodeId, tagId);
    },
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
    },
  });
}
