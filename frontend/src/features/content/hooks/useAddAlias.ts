/**
 * Hook to add an alias to a node.
 *
 * In the local-first core, an alias is a directed link from an alias page to
 * its canonical page, stored in the derived `node_alias` table via the
 * `node.addAlias` operation.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';

export function useAddAlias() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store } = useWorkspaceStore(workspaceUuid ?? '');

  return useMutation<void, Error, { nodeUuid: string; aliasNodeUuid: string }>({
    mutationFn: async ({ nodeUuid, aliasNodeUuid }) => {
      if (!nodeUuid || !aliasNodeUuid) throw new Error('Node UUID not found');
      if (!store) throw new Error('Workspace store is not ready');
      if (nodeUuid === aliasNodeUuid) throw new Error('A node cannot be an alias of itself');
      store.addAlias(nodeUuid, aliasNodeUuid);
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
