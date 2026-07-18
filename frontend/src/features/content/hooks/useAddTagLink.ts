import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';

/**
 * Hook to add a tag link.
 *
 * Tags are not modeled in the local-first core store yet, so this mutation is a
 * no-op that invalidates the relevant query keys to keep the UI consistent.
 */
export function useAddTagLink() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { nodeUuid: string; targetNodeUuid: string }>({
    mutationFn: async ({ nodeUuid, targetNodeUuid }) => {
      if (!nodeUuid || !targetNodeUuid) throw new Error('Node UUID not found');
      // No-op: tag links are pending core-store modeling.
    },
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.textLinks(nodeUuid) });
    },
  });
}
