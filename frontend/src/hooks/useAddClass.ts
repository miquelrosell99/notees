import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys, propertyKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { updateNodeInTreeImmutable } from '@/utils/nodeTree';
import { awaitAllContentSaves } from './contentSaveTracker';
import { findNodeInCache } from './useNodeMutations.utils';

/**
 * Hook to add a class to a node
 */
export function useAddClass() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ nodeId, classId }: { nodeId: number; classId: number }) => {
      await awaitAllContentSaves();
      return nodesApi.addClass(nodeId, classId);
    },
    onMutate: async ({ nodeId, classId }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(nodeId) });

      // Get the old node - try direct cache first, then search in nested children
      let oldNode = queryClient.getQueryData<Node>(nodeKeys.detailBase(nodeId));
      if (!oldNode) {
        oldNode = findNodeInCache(queryClient, nodeId) ?? undefined;
      }

      // Helper to add class to a node
      const addClassToNode = (node: Node): Node => {
        const currentClasses = node.classes ?? [];
        if (currentClasses.includes(classId)) return node;
        return { ...node, classes: [...currentClasses, classId] };
      };

      // Optimistically update the cache to add the class immediately
      // First, update any direct cache entries for this node
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? addClassToNode(old) : old
      );

      // Also update ALL detail caches that may contain this node as a nested child
      // This handles the focused block view case where children are nested
      const newClasses = [...(oldNode?.classes ?? []), classId];
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

      // Update cache with the returned node data for immediate UI update.
      // Include color/icon so the block visually reflects the new class immediately.
      const classUpdates = {
        classes: updatedNode.classes,
        color: updatedNode.color,
        icon: updatedNode.icon,
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

      // Invalidate the node query to refetch with all fields (including properties)
      // This ensures the cover section and other property-dependent UI doesn't break
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });

      // GLOBAL: If is_page flag changed, invalidate pages cache
      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
      }

      // Always invalidate classes cache so newly created classes are picked up
      // by useResolvedClassDetails (which needs allClasses to resolve class IDs to Node objects).
      // Previously this was conditional on is_class changing, which missed the case where
      // a new class was just created and then added to a node in the same flow.
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });

      // Invalidate search so node.classes arrays in search results stay fresh
      queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'search'] });

      // Invalidate class properties queries to ensure they're refetched
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });

      // Invalidate the classed nodes list so the new node appears immediately
      queryClient.invalidateQueries({ queryKey: ['nodes', 'by-class', classId] });

      // Also invalidate lists and page content
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });

      // If this is a block (has parent_id), invalidate the parent's detail and page content
      // so the block's classes array is refreshed in the parent's children list
      if (updatedNode.parent_id !== null) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.parent_id) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_id) });
      }

      // Also invalidate the page's detail if different from parent
      if (updatedNode.page_id !== null && updatedNode.page_id !== updatedNode.parent_id) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.page_id) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_id) });
      }

      // Invalidate NodeView queries - the backend may create views when certain classes are added
      // (e.g., query class creates a main_content view)
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });

      // Invalidate query results so table views and query views update immediately
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });

      // Invalidate graph data since class links changed
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
