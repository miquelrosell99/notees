import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { awaitAllContentSaves } from './contentSaveTracker';
import { findNodeInCache } from './useNodeMutations.utils';
import { updateNodeInTreeCaches, updateNodeInFlatCaches } from './cacheUtils';

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
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(nodeId) });

      let oldNode = queryClient.getQueryData<Node>(nodeKeys.detailBase(nodeId));
      if (!oldNode) {
        oldNode = findNodeInCache(queryClient, nodeId) ?? undefined;
      }

      const newClasses = oldNode?.classes?.filter((id: number) => id !== classId) ?? [];
      const updates = { classes: newClasses };

      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? { ...old, ...updates } : old
      );

      updateNodeInTreeCaches(queryClient, nodeId, (node) => ({ ...node, ...updates }));
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
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });

      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
      }

      if (oldNode && oldNode.is_class !== updatedNode.is_class) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      }

      queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'search'] });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'by-class', classId] });

      if (updatedNode.page_id !== null && updatedNode.page_id !== nodeId) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_id) });
      }
      if (updatedNode.parent_id !== null && updatedNode.parent_id !== nodeId) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_id) });
      }

      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
