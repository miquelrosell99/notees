/**
 * useUpdateNode
 *
 * The optimistic update is handled by OperationRuntime. SyncManager dispatches
 * the API call and writes the result back to the cache.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { NodeUpdate, Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { scheduleAutoExport } from '@/utils/autoExport';
import { invalidateNodeCaches, findNodeInCache, getRuntimeBlockIdForServerId, applyNodeIntent } from './useNodeMutations.utils';
import { waitForOperationAck } from '@/sync/waitForOperation';
import type { GraphNode } from '@/runtime/types';

export function useUpdateNode() {
  const queryClient = useQueryClient();

  return useMutation<Node | null, Error, { nodeUuid: string; data: NodeUpdate }>({
    mutationFn: async ({ nodeUuid, data }) => {
      const blockId = getRuntimeBlockIdForServerId(nodeUuid);
      if (!blockId) {
        return nodesApi.updateNode(nodeUuid, data);
      }

      const updates: Partial<GraphNode> = {};
      if (data.name !== undefined && data.name !== null) updates.name = data.name;
      if (data.icon !== undefined) updates.icon = data.icon;
      if (data.color !== undefined) updates.color = data.color;
      if (data.is_page !== undefined && data.is_page !== null) updates.isPage = data.is_page;
      const collapsed = data.collapsed;
      if (collapsed != null) updates.collapsed = collapsed;
      if (data.is_private !== undefined && data.is_private !== null) updates.isPrivate = data.is_private;

      const operationId = applyNodeIntent({ type: 'update_node', blockId, updates });
      await waitForOperationAck(operationId);
      return findNodeInCache(queryClient, nodeUuid);
    },
    onSuccess: (updatedNode, variables) => {
      const { nodeUuid, data } = variables;
      const cachedNode = updatedNode ?? findNodeInCache(queryClient, nodeUuid);

      // Only invalidate lists/pages if fields that affect display changed
      const displayFieldsChanged =
        data.icon !== undefined ||
        data.color !== undefined ||
        data.is_page !== undefined ||
        data.is_favorite !== undefined;

      if (displayFieldsChanged && cachedNode) {
        invalidateNodeCaches(queryClient, {
          nodeUuid: nodeUuid,
          lists: true,
          pages: true,
          search: true,
          refetch: false,
        });
        queryClient.invalidateQueries({
          queryKey: nodeKeys.graphNodes(),
          refetchType: 'none',
        });
        if (cachedNode.is_class) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
        }
      }

      // Invalidate inline classes query to update pill display (only if color changed)
      if (data.color !== undefined) {
        queryClient.invalidateQueries({
          queryKey: nodeKeys.inlineClasses(nodeUuid),
          refetchType: 'none',
        });
      }

      // If parent_uuid was updated, invalidate parent's view queries
      if (data.parent_uuid !== undefined) {
        const newParentUuid = data.parent_uuid;

        if (newParentUuid) {
          queryClient.invalidateQueries({
            queryKey: nodeViewKeys.queryResults(),
            refetchType: 'none',
          });
        }

        const oldParentUuid = cachedNode?.parent_uuid;
        if (oldParentUuid && oldParentUuid !== newParentUuid) {
          queryClient.invalidateQueries({
            queryKey: nodeViewKeys.queryResults(),
            refetchType: 'none',
          });
        }

        queryClient.invalidateQueries({ queryKey: nodeKeys.breadcrumbs(nodeUuid) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pages(), refetchType: 'none' });
        queryClient.invalidateQueries({ queryKey: nodeKeys.searchAll(), refetchType: 'none' });
      }

      // If name/content was updated, invalidate link-related caches and schedule auto-export
      if (data.name !== undefined && cachedNode) {
        invalidateNodeCaches(queryClient, {
          linkedRefs: true,
          backlinks: true,
          propertyBacklinks: true,
          graph: true,
          breadcrumbs: true,
          refetch: false,
        });

        if (cachedNode.is_class) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
        }

        if (cachedNode.page_uuid) {
          invalidateNodeCaches(queryClient, { nodeUuid: cachedNode.page_uuid });
        } else if (cachedNode.parent_uuid) {
          invalidateNodeCaches(queryClient, { nodeUuid: cachedNode.parent_uuid });
        }

        if (cachedNode.is_page && cachedNode.uuid) {
          scheduleAutoExport(cachedNode.uuid);
        } else if (cachedNode.page_uuid) {
          const pageNode = findNodeInCache(queryClient, cachedNode.page_uuid);
          if (pageNode?.uuid) {
            scheduleAutoExport(pageNode.uuid);
          }
        }
      }
    },
    onError: (error: Error & { response?: { status: number } }, variables) => {
      if (error.response?.status === 409) {
        console.warn('[useUpdateNode] Conflict detected - node was modified by another user/session');
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(variables.nodeUuid) });
        console.error('Conflict: The node was modified by another user. Please refresh and try again.');
      }
    },
  });
}
