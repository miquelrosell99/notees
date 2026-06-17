import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { moveNodeInTreeCaches } from '@/hooks/cacheUtils';


/**
 * Hook to move a node
 */
export function useMoveNode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, parentId, position }: { id: number; parentId: number | null; position?: number }) =>
      nodesApi.moveNode(id, parentId, position),
    onMutate: async ({ id, parentId, position }) => {
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContents() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.uuids() });

      // Find the node being moved from any cache
      let movedNode: Node | null = null;

      const findInChildren = (node: Node): Node | null => {
        if (node.children) {
          for (const child of node.children) {
            if (child.id === id) return child;
            const found = findInChildren(child);
            if (found) return found;
          }
        }
        return null;
      };

      const detailQueries = queryClient.getQueriesData<Node>({ queryKey: nodeKeys.details() });
      for (const [, data] of detailQueries) {
        if (!data) continue;
        if (data.id === id) { movedNode = data; break; }
        const found = findInChildren(data);
        if (found) { movedNode = found; break; }
      }

      if (!movedNode) {
        const byUuidQueries = queryClient.getQueriesData<Node>({ queryKey: nodeKeys.uuids() });
        for (const [, data] of byUuidQueries) {
          if (!data) continue;
          if (data.id === id) { movedNode = data; break; }
          const found = findInChildren(data);
          if (found) { movedNode = found; break; }
        }
      }

      if (!movedNode) return;

      moveNodeInTreeCaches(queryClient, id, parentId, position ?? 0, movedNode);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: nodeKeys.details(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pageContents(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.uuids(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allLinkedRefs(),
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allPropertyBacklinks(),
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pages(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.searchAll(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.breadcrumbsAll(),
        refetchType: 'none',
      });
    },
  });
}
