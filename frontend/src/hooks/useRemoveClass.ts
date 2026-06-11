import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { updateNodeInTreeImmutable } from '@/utils/nodeTree';
import { awaitAllContentSaves } from './contentSaveTracker';
import { findNodeInCache } from './useNodeMutations.utils';

/**
 * Hook to remove a class from a node
 */
export function useRemoveClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeId, classId }: { nodeId: number; classId: number }) => {
      await awaitAllContentSaves();
      return nodesApi.removeClass(nodeId, classId);
    },
    onMutate: async ({ nodeId, classId }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(nodeId) });

      // Get the old node - try direct cache first, then search in nested children
      let oldNode = queryClient.getQueryData<Node>(nodeKeys.detailBase(nodeId));
      if (!oldNode) {
        oldNode = findNodeInCache(queryClient, nodeId) ?? undefined;
      }

      // Helper to update classes on a node
      const updateClasses = (node: Node): Node => ({
        ...node,
        classes: node.classes?.filter((id: number) => id !== classId) ?? [],
      });

      // Optimistically update the cache to remove the class immediately
      queryClient.setQueriesData<Node>(
        {
          queryKey: nodeKeys.detailBase(nodeId),
          exact: false  // Match all queries starting with this key
        },
        (old) => old ? updateClasses(old) : old
      );

      // Also update ALL detail caches that may contain this node as a nested child
      const newClasses = oldNode?.classes?.filter((id: number) => id !== classId) ?? [];
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details(), exact: false },
        (old) => {
          if (!old?.children) return old;
          const newChildren = updateNodeInTreeImmutable(old.children, nodeId, { classes: newClasses });
          return newChildren !== old.children ? { ...old, children: newChildren } : old;
        }
      );

      // Also optimistically update query results so query section list views update immediately
      queryClient.setQueriesData<Node[]>(
        { queryKey: nodeViewKeys.queryResults(), exact: false },
        (old) => {
          if (!old || !Array.isArray(old)) return old;
          return updateNodeInTreeImmutable(old, nodeId, { classes: newClasses });
        }
      );

      return { oldNode };
    },
    onError: (_err, { nodeId }, context) => {
      // Rollback on error - restore original classes in all caches
      if (context?.oldNode) {
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(nodeId), exact: false },
          () => context.oldNode
        );
        // Also rollback in all detail caches that may contain this node as a child
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.details(), exact: false },
          (old) => {
            if (!old?.children) return old;
            const newChildren = updateNodeInTreeImmutable(old.children, nodeId, { classes: context.oldNode!.classes });
            return newChildren !== old.children ? { ...old, children: newChildren } : old;
          }
        );
        // Also rollback query results
        queryClient.setQueriesData<Node[]>(
          { queryKey: nodeViewKeys.queryResults(), exact: false },
          (old) => {
            if (!old || !Array.isArray(old)) return old;
            return updateNodeInTreeImmutable(old, nodeId, { classes: context.oldNode!.classes });
          }
        );
      }
    },
    onSuccess: (updatedNode, { nodeId, classId }, context) => {
      const oldNode = context?.oldNode;

      // Update cache with the returned node data for immediate UI update
      // Only update fields that are in the response to avoid overwriting children/properties
      const classUpdates = {
        classes: updatedNode.classes,
        is_page: updatedNode.is_page,
        is_class: updatedNode.is_class,
        is_daily: updatedNode.is_daily,
        is_monthly: updatedNode.is_monthly,
        is_yearly: updatedNode.is_yearly,
        write_date: updatedNode.write_date,
      };

      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? { ...old, ...classUpdates } : updatedNode
      );

      // Also update ALL detail caches that may contain this node as a nested child
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details(), exact: false },
        (old) => {
          if (!old?.children) return old;
          const newChildren = updateNodeInTreeImmutable(old.children, nodeId, classUpdates);
          return newChildren !== old.children ? { ...old, children: newChildren } : old;
        }
      );

      // Also update query results with the server-confirmed class data
      queryClient.setQueriesData<Node[]>(
        { queryKey: nodeViewKeys.queryResults(), exact: false },
        (old) => {
          if (!old || !Array.isArray(old)) return old;
          return updateNodeInTreeImmutable(old, nodeId, classUpdates);
        }
      );

      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });

      // GLOBAL: If is_page flag changed, invalidate pages cache
      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
      }

      // GLOBAL: If is_class flag changed, invalidate classes cache
      if (oldNode && oldNode.is_class !== updatedNode.is_class) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      }

      // Invalidate search so node.classes arrays in search results stay fresh
      queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'search'] });

      // Invalidate the classed nodes list so the removed node disappears immediately
      queryClient.invalidateQueries({ queryKey: ['nodes', 'by-class', classId] });

      // Also invalidate the page content if the node is a block within a page
      if (updatedNode.page_id !== null && updatedNode.page_id !== nodeId) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_id) });
      }
      // Invalidate parent's page content if different
      if (updatedNode.parent_id !== null && updatedNode.parent_id !== nodeId) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_id) });
      }

      // Invalidate NodeView queries - the backend may delete views when certain classes are removed
      // (e.g., query class removal deletes the main_content view)
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });

      // Invalidate query results so table views and query views update immediately
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });

      // Invalidate graph data since class links changed
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
