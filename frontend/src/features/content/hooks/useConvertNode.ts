import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import * as nodesApi from '@/api/nodes';

function invalidateAfterConversion(
  queryClient: ReturnType<typeof useQueryClient>,
  node: Node,
  oldParentId: number | null | undefined,
  newParentId: number | null | undefined,
) {
  // The page list changes whenever is_page flips
  queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
  queryClient.invalidateQueries({ queryKey: nodeKeys.graphNodes() });
  queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });

  // The node itself
  queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.id) });
  queryClient.invalidateQueries({ queryKey: nodeKeys.breadcrumbs(node.id) });

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

  return useMutation<Node, Error, { nodeId: number; name?: string; oldParentId?: number | null }>({
    mutationFn: async ({ nodeId, name }) => {
      await awaitAllContentSaves();
      return nodesApi.convertToPage(nodeId, name);
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
    { nodeId: number; parentId: number; position?: number; oldParentId?: number | null }
  >({
    mutationFn: async ({ nodeId, parentId, position }) => {
      await awaitAllContentSaves();
      return nodesApi.convertToBlock(nodeId, parentId, position);
    },
    onSuccess: (node, variables) => {
      invalidateAfterConversion(queryClient, node, variables.oldParentId, node.parent_id);
    },
  });
}
