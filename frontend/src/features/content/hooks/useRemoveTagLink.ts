import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';

/**
 * Hook to remove a tag link.
 *
 * Tags are not modeled in the local-first core store yet, so this mutation is a
 * no-op that invalidates the relevant query keys to keep the UI consistent.
 */
export function useRemoveTagLink() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { nodeUuid: string; targetId: string }>({
    mutationFn: async ({ nodeUuid, targetId }) => {
      if (!nodeUuid || !targetId) throw new Error('Node UUID not found');
      // No-op: tag links are pending core-store modeling.
    },
    onSuccess: (_, { nodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.textLinks(nodeUuid) });
    },
  });
}
