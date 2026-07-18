import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { Node } from '@/types/api';
import * as nodesApi from '@/api/nodes';
import { useWorkspaceStore, useUndoManager } from '@/core/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { findNodeInCache } from './useNodeMutations.utils';

/**
 * Hook to remove a class from a node.
 *
 * The optimistic update is handled by the local-first core store. When the store
 * is available, the class unassignment is applied (and undo-recorded) immediately;
 * otherwise the direct API fallback is used.
 */
export function useRemoveClass() {
  const queryClient = useQueryClient();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');
  const manager = useUndoManager(workspaceId ?? '');

  return useMutation<Node | null, Error, { nodeUuid: string; classId: string }>({
    mutationFn: async ({ nodeUuid, classId }) => {
      if (!nodeUuid) throw new Error('Node UUID not found');
      const classUuid = classId;
      if (!classUuid) throw new Error('Class UUID not found');

      if (store && manager) {
        manager.unassignClass(nodeUuid, classUuid);
        return findNodeInCache(queryClient, nodeUuid);
      }

      // Fallback: core store is not available, use direct API
      return nodesApi.removeClass(nodeUuid, classUuid);
    },
    onSuccess: (updatedNode, { nodeUuid, classId }) => {
      if (!updatedNode) return;

      const oldNode = findNodeInCache(queryClient, nodeUuid);

      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeUuid) });

      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
      }

      if (oldNode && oldNode.is_class !== updatedNode.is_class) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      }

      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(classId) });

      if (updatedNode.page_uuid !== null && updatedNode.page_uuid !== nodeUuid) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_uuid) });
      }
      if (updatedNode.parent_uuid !== null && updatedNode.parent_uuid !== nodeUuid) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_uuid) });
      }

      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeUuid) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
    },
  });
}
