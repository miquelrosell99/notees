import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';

/**
 * Hook to add a tag link
 */
export function useAddTagLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, targetNodeId }: { nodeId: number; targetNodeId: number }) =>
      nodesApi.addTagLink(nodeId, targetNodeId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: ['textLinks', nodeId] });
    },
  });
}
