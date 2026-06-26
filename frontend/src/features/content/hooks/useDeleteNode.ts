/**
 * useDeleteNode
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { removeFavorite, isFavorite } from './useFavorites';
import { removeRecent } from './useRecents';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  invalidateNodeCaches,
  findNodeInCache,
  hasTableClass,
  getRuntimeBlockIdForServerId,
  applyNodeIntent,
} from './useNodeMutations.utils';
import { waitForOperationAck } from '@/sync/waitForOperation';

import {
  removeNodeFromAllCaches,
  removeNodeFromLinkedRefCaches,
  removeNodeFromPropertyBacklinkCaches,
} from '@/hooks/cacheUtils';

export function useDeleteNode() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  return useMutation<
    { deletedNode: Node | undefined; tableCellInfo: { parentUuid: string; sequence: number } | null },
    Error,
    string
  >({
    mutationFn: async (nodeUuid) => {
      let nodeData = queryClient.getQueryData<Node>(nodeKeys.detail(nodeUuid, {}));
      if (!nodeData) {
        nodeData = findNodeInCache(queryClient, nodeUuid) ?? undefined;
      }

      let tableCellInfo: { parentUuid: string; sequence: number } | null = null;

      if (nodeData && nodeData.parent_uuid) {
        const parentNode = findNodeInCache(queryClient, nodeData.parent_uuid);
        if (parentNode && parentNode.parent_uuid) {
          const grandparentNode = findNodeInCache(queryClient, parentNode.parent_uuid);
          const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());
          if (grandparentNode && hasTableClass(grandparentNode, allClasses)) {
            tableCellInfo = {
              parentUuid: nodeData.parent_uuid,
              sequence: nodeData.sequence ?? 0,
            };
          }
        }
      }

      const blockId = getRuntimeBlockIdForServerId(nodeUuid);
      if (blockId) {
        const operationId = applyNodeIntent({ type: 'delete_block', blockId });
        await waitForOperationAck(operationId);
      } else {
        await nodesApi.deleteNode(nodeUuid);
      }

      if (tableCellInfo) {
        await nodesApi.createNode({
          name: '',
          parent_uuid: tableCellInfo.parentUuid,
          sequence: tableCellInfo.sequence,
        });
      }

      return { deletedNode: nodeData, tableCellInfo };
    },
    onMutate: async (nodeUuid) => {
      // Immediately remove from favorites and recents
      if (nodeUuid && isFavorite(nodeUuid)) {
        removeFavorite(nodeUuid).catch(() => {});
      }
      removeRecent(nodeUuid);

      // Navigate away if viewing the deleted node
      const currentNodeUuid = useNavigationStore.getState().currentNodeUuid;
      if (currentNodeUuid && currentNodeUuid === nodeUuid) {
        useNavigationStore.setState({
          currentNodeUuid: null,
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
      removeNodeFromAllCaches(queryClient, nodeUuid);
      removeNodeFromLinkedRefCaches(queryClient, nodeUuid);
      removeNodeFromPropertyBacklinkCaches(queryClient, nodeUuid);
    },
    onSuccess: async ({ deletedNode, tableCellInfo }, nodeUuid) => {
      const currentNodeUuid = useNavigationStore.getState().currentNodeUuid;

      if (currentNodeUuid && currentNodeUuid === nodeUuid) {
        useNavigationStore.setState({
          currentNodeUuid: null,
          mainViewType: 'node',
        });
        navigate(workspaceId ? `/${workspaceId}` : '/', { replace: true });
      }

      // Remove the deleted node's queries (all variations)
      queryClient.removeQueries({ queryKey: nodeKeys.detailBase(nodeUuid) });

      if (tableCellInfo) {
        queryClient.invalidateQueries({
          queryKey: nodeKeys.detailBase(tableCellInfo.parentUuid),
          refetchType: 'active',
        });
      }

      if (deletedNode?.parent_uuid) {
        invalidateNodeCaches(queryClient, {
          nodeUuid: deletedNode.parent_uuid,
          refetch: true,
        });
      }

      queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
        refetchType: 'none',
      });

      if (nodeUuid && isFavorite(nodeUuid)) {
        removeFavorite(nodeUuid).catch(() => {});
      }
      removeRecent(nodeUuid);

      queryClient.invalidateQueries({ queryKey: nodeKeys.lists(), refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.breadcrumbsAll(), refetchType: 'active' });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allPropertyBacklinks(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pseudoNodeQuery(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.inlineQuery(), refetchType: 'active' });
    },
  });
}
