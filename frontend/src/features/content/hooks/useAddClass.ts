import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from '@/hooks/contentSaveTracker';
import { findNodeInCache } from './useNodeMutations.utils';
import { updateNodeInTreeCaches, updateNodeInFlatCaches } from '@/hooks/cacheUtils';


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
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(nodeId) });

      let oldNode = queryClient.getQueryData<Node>(nodeKeys.detailBase(nodeId));
      if (!oldNode) {
        oldNode = findNodeInCache(queryClient, nodeId) ?? undefined;
      }

      const newClasses = [...(oldNode?.classes ?? []), classId];
      const updates = { classes: newClasses };

      // Update direct cache entries
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? { ...old, ...updates } : old
      );

      // Update tree caches where this node appears as a child
      updateNodeInTreeCaches(queryClient, nodeId, (node) => ({ ...node, ...updates }));

      // Update flat caches
      updateNodeInFlatCaches(queryClient, nodeId, (node) => ({ ...node, ...updates }));

      return { oldNode };
    },
    onError: (_err, { nodeId }, context) => {
      if (context?.oldNode) {
        const rollback = { classes: context.oldNode.classes };
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(nodeId), exact: false },
          (old) => old ? { ...old, ...rollback } : old
        );
        updateNodeInTreeCaches(queryClient, nodeId, (node) => ({ ...node, ...rollback }));
        updateNodeInFlatCaches(queryClient, nodeId, (node) => ({ ...node, ...rollback }));
      }
    },
    onSuccess: (updatedNode, { nodeId, classId }, context) => {
      const oldNode = context?.oldNode;

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

      updateNodeInTreeCaches(queryClient, nodeId, (node) => ({ ...node, ...classUpdates }));
      updateNodeInFlatCaches(queryClient, nodeId, (node) => ({ ...node, ...classUpdates }));

      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });

      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
      }

      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });

      if (updatedNode.parent_id !== null) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.parent_id) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_id) });
      }

      if (updatedNode.page_id !== null && updatedNode.page_id !== updatedNode.parent_id) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.page_id) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_id) });
      }

      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
