import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { getNodeUuidByServerId } from './useNodeMutations.utils';


/**
 * Hook to add a tag link
 */
export function useAddTagLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, targetNodeId }: { nodeId: string | number; targetNodeId: string | number }) => {
      const nodeUuid = typeof nodeId === 'string' ? nodeId : getNodeUuidByServerId(queryClient, nodeId);
      const targetNodeUuid = typeof targetNodeId === 'string' ? targetNodeId : getNodeUuidByServerId(queryClient, targetNodeId);
      if (!nodeUuid || !targetNodeUuid) throw new Error('Node UUID not found');
      return nodesApi.addTagLink(nodeUuid, targetNodeUuid);
    },
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.textLinks(nodeId) });
    },
  });
}
