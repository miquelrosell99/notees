import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { getNodeUuidByServerId } from './useNodeMutations.utils';


/**
 * Hook to remove a tag link
 */
export function useRemoveTagLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, targetId }: { nodeId: number; targetId: number }) => {
      const nodeUuid = getNodeUuidByServerId(queryClient, nodeId);
      const targetNodeUuid = getNodeUuidByServerId(queryClient, targetId);
      if (!nodeUuid || !targetNodeUuid) throw new Error('Node UUID not found');
      return nodesApi.removeTagLink(nodeUuid, targetNodeUuid);
    },
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.textLinks(nodeId) });
    },
  });
}
