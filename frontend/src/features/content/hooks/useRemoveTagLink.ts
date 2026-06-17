import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';


/**
 * Hook to remove a tag link
 */
export function useRemoveTagLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, targetId }: { nodeId: number; targetId: number }) =>
      nodesApi.removeTagLink(nodeId, targetId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.textLinks(nodeId) });
    },
  });
}
