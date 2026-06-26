import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';


/**
 * Hook to add an alias to a node
 */
export function useAddAlias() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeUuid, aliasNodeUuid }: { nodeUuid: string; aliasNodeUuid: string }) => {
      if (!nodeUuid || !aliasNodeUuid) throw new Error('Node UUID not found');
      return nodesApi.addAlias(nodeUuid, aliasNodeUuid);
    },
    onSuccess: (updatedNode, { nodeUuid, aliasNodeUuid }) => {
      // Update cache directly with the returned node (includes updated aliases array)
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeUuid), exact: false },
        (old) => old ? { ...old, aliases_uuid: updatedNode.aliases_uuid, write_date: updatedNode.write_date } : updatedNode
      );

      // Also update nested caches that may contain this node
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details(), exact: false },
        (old) => {
          if (!old || old.uuid !== nodeUuid) return old;
          return { ...old, aliases_uuid: updatedNode.aliases_uuid, write_date: updatedNode.write_date };
        }
      );

      // Invalidate both the main node and the alias node caches with active refetch
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
      // Also invalidate linked references since aliases affect backlinks
      queryClient.invalidateQueries({
        queryKey: nodeKeys.linkedRefs(nodeUuid),
        refetchType: 'active'
      });
      // Invalidate pages list (aliased_id changed on the alias node)
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
