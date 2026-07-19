/**
 * Hook to remove an alias from a node.
 *
 * Removes the directed alias link in the local-first core store via the
 * `node.removeAlias` operation.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';

export function useRemoveAlias() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store } = useWorkspaceStore(workspaceUuid ?? '');

  return useMutation<void, Error, { nodeUuid: string; aliasNodeUuid: string }>({
    mutationFn: async ({ nodeUuid, aliasNodeUuid }) => {
      if (!nodeUuid || !aliasNodeUuid) throw new Error('Node UUID not found');
      if (!store) throw new Error('Workspace store is not ready');
      store.removeAlias(nodeUuid, aliasNodeUuid);
    },
    onSuccess: (_, { nodeUuid, aliasNodeUuid }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(aliasNodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.linkedRefs(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.aliases(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.aliases(aliasNodeUuid) });
    },
  });
}
