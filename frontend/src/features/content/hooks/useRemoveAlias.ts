import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';

/**
 * Hook to remove an alias from a node.
 *
 * Aliases are not modeled in the local-first core store yet, so this mutation
 * is a no-op that invalidates the relevant query keys to keep the UI consistent.
 */
export function useRemoveAlias() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { nodeUuid: string; aliasNodeUuid: string }>({
    mutationFn: async ({ nodeUuid, aliasNodeUuid }) => {
      if (!nodeUuid || !aliasNodeUuid) throw new Error('Node UUID not found');
      // No-op: aliases are pending core-store modeling.
    },
    onSuccess: (_, { nodeUuid, aliasNodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(aliasNodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.linkedRefs(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.aliases(nodeUuid) });
    },
  });
}
