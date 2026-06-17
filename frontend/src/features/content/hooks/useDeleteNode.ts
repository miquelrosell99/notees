/**
 * useDeleteNode
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { getOperationRuntime } from '@/runtime';
import { getNodeByServerId, getDescendants } from '@/runtime/graphHelpers';
import { removeNodes } from '@/runtime/eventBus';
import { removeFavorite, isFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useNavigationStore } from '@/stores/navigationStore';
import { invalidateNodeCaches, findNodeInCache, hasTableClass } from './useNodeMutations.utils';

import {
  removeNodeFromAllCaches,
  removeNodeFromLinkedRefCaches,
  removeNodeFromPropertyBacklinkCaches,
} from '@/hooks/cacheUtils';

export function useDeleteNode() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  return useMutation({
    mutationFn: async (id: number): Promise<{ deletedNode: Node | undefined; tableCellInfo: { parentId: number; sequence: number } | null }> => {
      let nodeData = queryClient.getQueryData<Node>(nodeKeys.detail(id, {}));
      if (!nodeData) {
        nodeData = findNodeInCache(queryClient, id) ?? undefined;
      }

      let tableCellInfo: { parentId: number; sequence: number } | null = null;

      if (nodeData && nodeData.parent_id) {
        const parentNode = findNodeInCache(queryClient, nodeData.parent_id);
        if (parentNode && parentNode.parent_id) {
          const grandparentNode = findNodeInCache(queryClient, parentNode.parent_id);
          const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());
          if (grandparentNode && hasTableClass(grandparentNode, allClasses)) {
            tableCellInfo = {
              parentId: nodeData.parent_id,
              sequence: nodeData.sequence ?? 0,
            };
          }
        }
      }

      await nodesApi.deleteNode(id);

      if (tableCellInfo) {
        await nodesApi.createNode({
          name: '',
          parent_id: tableCellInfo.parentId,
          sequence: tableCellInfo.sequence,
        });
      }

      return { deletedNode: nodeData, tableCellInfo };
    },
    onMutate: async (deletedId) => {
      // Immediately remove from favorites and recents
      if (isFavorite(deletedId)) {
        removeFavorite(deletedId).catch(() => {});
      }
      removeRecent(deletedId);

      // Navigate away if viewing the deleted node
      const currentNodeId = useNavigationStore.getState().currentNodeId;
      if (currentNodeId === deletedId) {
        useNavigationStore.setState({
          currentNodeId: null,
          mainViewType: 'node',
        });
        navigate(workspaceId ? `/${workspaceId}` : '/', { replace: true });
      }

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContents() });
      await queryClient.cancelQueries({ queryKey: nodeViewKeys.queryResults() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pseudoNodeQuery() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.inlineQuery() });

      // Remove from all caches using unified helper
      removeNodeFromAllCaches(queryClient, deletedId);
      removeNodeFromLinkedRefCaches(queryClient, deletedId);
      removeNodeFromPropertyBacklinkCaches(queryClient, deletedId);

      // Immediately remove from runtime
      const runtime = getOperationRuntime();
      const graphNode = getNodeByServerId(runtime, deletedId);
      if (graphNode) {
        const descendants = getDescendants(runtime, graphNode.blockId);
        removeNodes([
          graphNode.blockId,
          ...descendants.map(d => d.blockId),
        ]);
      }
    },
    onSuccess: async ({ deletedNode, tableCellInfo }, deletedId) => {
      const { useNavigationStore } = await import('@/stores');
      const currentNodeId = useNavigationStore.getState().currentNodeId;

      if (currentNodeId === deletedId) {
        useNavigationStore.setState({
          currentNodeId: null,
          mainViewType: 'node',
        });
        navigate(workspaceId ? `/${workspaceId}` : '/', { replace: true });
      }

      // Remove the deleted node's queries (all variations)
      queryClient.removeQueries({ queryKey: nodeKeys.detailBase(deletedId) });

      if (tableCellInfo) {
        queryClient.invalidateQueries({
          queryKey: nodeKeys.detailBase(tableCellInfo.parentId),
          refetchType: 'active',
        });
      }

      if (deletedNode?.parent_id) {
        invalidateNodeCaches(queryClient, {
          nodeId: deletedNode.parent_id,
          refetch: true,
        });
      }

      queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
        refetchType: 'none',
      });

      if (isFavorite(deletedId)) {
        removeFavorite(deletedId).catch(() => {});
      }
      removeRecent(deletedId);

      queryClient.invalidateQueries({
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pages(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allBacklinks(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allLinkedRefs(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pageContents(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.queryResults(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pseudoNodeQuery(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.inlineQuery(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.graph(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.graphNodes(),
        refetchType: 'none',
      });
    },
  });
}
