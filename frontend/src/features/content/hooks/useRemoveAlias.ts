import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
/**
 * Hook to remove an alias from a node
 */
export function useRemoveAlias() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeUuid, aliasNodeUuid }: { nodeUuid: string; aliasNodeUuid: string }) => {
      if (!nodeUuid || !aliasNodeUuid) throw new Error('Node UUID not found');
      return nodesApi.removeAlias(nodeUuid, aliasNodeUuid);
    },
    onSuccess: (_, { nodeUuid, aliasNodeUuid }) => {
      // Invalidate with active refetch to ensure changes show immediately
      queryClient.invalidateQueries({
        queryKey: nodeKeys.detailBase(nodeUuid),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pageContent(nodeUuid),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.detailBase(aliasNodeUuid),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.linkedRefs(nodeUuid),
        refetchType: 'active'
      });
      // Invalidate pages list (aliased_id cleared on the alias node)
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pages(),
        refetchType: 'active'
      });
      // Invalidate aliases query so the UI list updates
      queryClient.invalidateQueries({
        queryKey: nodeKeys.aliases(nodeUuid),
        refetchType: 'active'
      });
    },
  });
}
