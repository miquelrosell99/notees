import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';

/**
 * Hook to add a tag link
 */
export function useAddTagLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeUuid, targetNodeUuid }: { nodeUuid: string; targetNodeUuid: string }) => {
      if (!nodeUuid || !targetNodeUuid) throw new Error('Node UUID not found');
      return nodesApi.addTagLink(nodeUuid, targetNodeUuid);
    },
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.textLinks(nodeUuid) });
    },
  });
}
