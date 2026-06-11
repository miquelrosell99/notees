/**
 * useDeleteNode
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { useFavoritesStore } from '@/stores/favoritesStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { invalidateNodeCaches, findNodeInCache, hasTableClass } from './useNodeMutations.utils';
import {
  removeNodeFromAllCaches,
  removeNodeFromLinkedRefCaches,
  removeNodeFromPropertyBacklinkCaches,
} from './cacheUtils';

export function useDeleteNode() {
  const queryClient = useQueryClient();

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
      const favoritesStore = useFavoritesStore.getState();
      if (favoritesStore.isFavorite(deletedId)) {
        favoritesStore.removeFavorite(deletedId);
      }
      favoritesStore.removeRecent(deletedId);

      // Navigate away if viewing the deleted node
      const currentNodeId = useNavigationStore.getState().currentNodeId;
      if (currentNodeId === deletedId) {
        useNavigationStore.setState({
          currentNodeId: null,
          mainViewType: 'node',
        });
        const wsMatch = window.location.pathname.match(/^\/[0-9a-f-]{36}/);
        window.history.replaceState(null, '', wsMatch ? wsMatch[0] : '/');
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
      const runtime = getNodeGraphRuntime();
      const graphNode = runtime.getNodeByServerId(deletedId);
      if (graphNode) {
        const descendants = runtime.getDescendants(graphNode.blockId);
        runtime.removeNodes([
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
        const wsMatch = window.location.pathname.match(/^\/[0-9a-f-]{36}/);
        window.history.replaceState(null, '', wsMatch ? wsMatch[0] : '/');
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

      const { useFavoritesStore } = await import('@/stores');
      const favoritesStore = useFavoritesStore.getState();
      if (favoritesStore.isFavorite(deletedId)) {
        favoritesStore.removeFavorite(deletedId);
      }
      favoritesStore.removeRecent(deletedId);

      queryClient.invalidateQueries({
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.pages(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: ['nodes', 'backlinks'],
        refetchType: 'none',
      });
      queryClient.invalidateQueries({
        queryKey: ['nodes', 'linked-refs'],
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
