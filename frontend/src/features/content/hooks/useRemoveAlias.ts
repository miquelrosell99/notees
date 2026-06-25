import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { getNodeUuidByServerId } from './useNodeMutations.utils';

/**
 * Hook to remove an alias from a node
 */
export function useRemoveAlias() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, aliasId }: { nodeId: number; aliasId: number }) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      const aliasNodeUuid = getNodeUuidByServerId(queryClient, aliasId);
      if (!nodeUuid || !aliasNodeUuid) throw new Error('Node UUID not found');
      return nodesApi.removeAlias(nodeUuid, aliasNodeUuid);
    },
    onSuccess: (_, { nodeId, aliasId }) => {
      // Invalidate with active refetch to ensure changes show immediately
      queryClient.invalidateQueries({
        queryKey: nodeKeys.detailBase(nodeId),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pageContent(nodeId),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.detailBase(aliasId),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.linkedRefs(nodeId),
        refetchType: 'active'
      });
      // Invalidate pages list (aliased_id cleared on the alias node)
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pages(),
        refetchType: 'active'
      });
      // Invalidate aliases query so the UI list updates
      queryClient.invalidateQueries({
        queryKey: nodeKeys.aliases(nodeId),
        refetchType: 'active'
      });
    },
  });
}
