import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import * as nodesApi from '@/api/nodes';


function invalidateAfterConversion(
  queryClient: ReturnType<typeof useQueryClient>,
  node: Node,
  oldParentId: string | null | undefined,
  newParentId: string | null | undefined,
) {
  // The page list changes whenever is_page flips
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.graphNodes() });
  queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });

  // The node itself
  queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.uuid) });
  queryClient.invalidateQueries({ queryKey: nodeKeys.breadcrumbs(node.uuid) });

  // Old location
  if (oldParentId) {
    queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(oldParentId) });
    queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(oldParentId) });
    queryClient.invalidateQueries({ queryKey: nodeKeys.childrenOnly(oldParentId) });
  }

  // New location
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

  return useMutation<Node, Error, { nodeUuid: string; name?: string; oldParentId?: string | null }>({
    mutationFn: async ({ nodeUuid, name }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      return nodesApi.convertToPage(nodeUuid, name);
    },
    onSuccess: (node, variables) => {
      invalidateAfterConversion(queryClient, node, variables.oldParentId, null);
    },
  });
}

/**
 * Convert a page into a block under a destination page.
 */
export function useConvertToBlock() {
  const queryClient = useQueryClient();

  return useMutation<
    Node,
    Error,
    { nodeUuid: string; parentId: string; position?: number; oldParentId?: string | null }
  >({
    mutationFn: async ({ nodeUuid, parentId, position }) => {
      if (!nodeUuid || !parentId) throw new Error('Node UUID not found');
      return nodesApi.convertToBlock(nodeUuid, parentId, position);
    },
    onSuccess: (node, variables) => {
      invalidateAfterConversion(queryClient, node, variables.oldParentId, node.parent_uuid);
    },
  });
}
