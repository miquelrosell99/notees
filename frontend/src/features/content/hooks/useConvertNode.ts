import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';

function invalidateAfterConversion(
  queryClient: ReturnType<typeof useQueryClient>,
  nodeUuid: string,
  oldParentId: string | null | undefined,
  newParentId: string | null | undefined,
) {
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.graphNodes() });
  queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });

  queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
  queryClient.invalidateQueries({ queryKey: nodeKeys.breadcrumbs(nodeUuid) });

  if (oldParentId) {
    queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(oldParentId) });
    queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(oldParentId) });
    queryClient.invalidateQueries({ queryKey: nodeKeys.childrenOnly(oldParentId) });
  }

  if (newParentId) {
    queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(newParentId) });
    queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(newParentId) });
    queryClient.invalidateQueries({ queryKey: nodeKeys.childrenOnly(newParentId) });
  }
}

/**
 * Convert a block into a root page.
 */
export function useConvertToPage() {
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  return useMutation<void, Error, { nodeUuid: string; name?: string; oldParentId?: string | null }>({
    mutationFn: async ({ nodeUuid, name }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('convertNode', [
        { nodeId: nodeUuid, kind: 'page', parentId: null },
      ]);
      if (name !== undefined && name !== '') {
        await client.mutate<void>('setNodeText', [nodeUuid, name]);
      }
    },
    onSuccess: (_, variables) => {
      invalidateAfterConversion(queryClient, variables.nodeUuid, variables.oldParentId, null);
    },
  });
}

/**
 * Convert a page into a block under a destination page.
 */
export function useConvertToBlock() {
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  return useMutation<
    void,
    Error,
    { nodeUuid: string; parentId: string; position?: number; oldParentId?: string | null }
  >({
    mutationFn: async ({ nodeUuid, parentId }) => {
      if (!nodeUuid || !parentId) throw new Error('Node UUID not found');
      if (!client) throw new Error('Workspace store is not ready');
      await client.mutate<void>('convertNode', [
        { nodeId: nodeUuid, kind: 'block', parentId },
      ]);
    },
    onSuccess: (_, variables) => {
      invalidateAfterConversion(queryClient, variables.nodeUuid, variables.oldParentId, variables.parentId);
    },
  });
}
