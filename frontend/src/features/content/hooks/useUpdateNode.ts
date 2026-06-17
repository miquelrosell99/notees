/**
 * useUpdateNode
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { NodeUpdate, Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { scheduleAutoExport } from '@/utils/autoExport';
import { invalidateNodeCaches, findNodeInCache } from './useNodeMutations.utils';
import { updateNodeInTreeCaches, updateNodeInFlatCaches } from '@/hooks/cacheUtils';

export function useUpdateNode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: NodeUpdate }) =>
      nodesApi.updateNode(id, data),
    onMutate: async ({ id, data }) => {
      // Cancel any outgoing refetches to not overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContents() });

      // Build update object
      const buildUpdate = (): Partial<Node> => {
        const update: Partial<Node> = {};
        if (data.name !== undefined && data.name !== null) update.name = data.name;
        if (data.icon !== undefined) update.icon = data.icon;
        if (data.color !== undefined) update.color = data.color;
        if (data.parent_id !== undefined) update.parent_id = data.parent_id;
        if (data.sequence !== undefined && data.sequence !== null) update.sequence = data.sequence;
        if (data.collapsed !== undefined && data.collapsed !== null) update.collapsed = data.collapsed;
        if (data.is_private !== undefined && data.is_private !== null) update.is_private = data.is_private;
        return update;
      };

      const updates = buildUpdate();

      // Update tree caches (detail, page-content, uuid)
      updateNodeInTreeCaches(queryClient, id, (node) => ({ ...node, ...updates }));

      // Update flat caches (queryResults, pseudoNodeQuery, inlineQuery)
      updateNodeInFlatCaches(queryClient, id, (node) => ({ ...node, ...updates }));
    },
    onSuccess: (updatedNode, variables) => {
      // Merge the updated node with existing cached data to preserve children and other fields
      // that aren't returned by the update endpoint.
      // IMPORTANT: The PUT endpoint returns classes/tags as [] (it doesn't fetch them),
      // so we must exclude them from the spread to avoid wiping out cached values
      // that were set by addClass/addTag mutations.
      const mergeUpdate = (oldNode: Node | undefined): Node => {
        if (!oldNode) return updatedNode;
        const { children, backlinks, linked_references, properties, classes: _classes, tags: _tags, ...rest } = updatedNode;
        return {
          ...oldNode,
          ...rest,
          ...(children !== null && children !== undefined ? { children } : {}),
          ...(backlinks !== null && backlinks !== undefined ? { backlinks } : {}),
          ...(linked_references !== null && linked_references !== undefined ? { linked_references } : {}),
          ...(properties !== null && properties !== undefined && Object.keys(properties).length > 0 ? { properties } : {}),
        };
      };

      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(updatedNode.id) },
        mergeUpdate
      );

      // Update flat caches
      updateNodeInFlatCaches(queryClient, updatedNode.id, (node) => mergeUpdate(node));

      // Also update node list caches so alias/tag pills derived from allNodes update immediately
      const updateNodeList = (oldData: Node[] | undefined) => {
        if (!oldData || !Array.isArray(oldData)) return oldData;
        return oldData.map(n => n.id === updatedNode.id ? mergeUpdate(n) : n);
      };
      queryClient.setQueriesData<Node[]>(
        { queryKey: nodeKeys.lists() },
        updateNodeList
      );

      // Also update byUuid cache so editor InlineLink components reflect changes (e.g. color)
      if (updatedNode.uuid) {
        queryClient.setQueryData<Node>(
          nodeKeys.byUuid(updatedNode.uuid),
          (oldNode) => oldNode ? mergeUpdate(oldNode) : undefined
        );
      }

      // Only invalidate lists/pages if fields that affect display changed
      const displayFieldsChanged =
        variables.data.icon !== undefined ||
        variables.data.color !== undefined ||
        variables.data.is_page !== undefined ||
        variables.data.is_favorite !== undefined;

      if (displayFieldsChanged) {
        invalidateNodeCaches(queryClient, {
          nodeId: updatedNode.id,
          lists: true,
          pages: true,
          search: true,
          refetch: false,
        });
        queryClient.invalidateQueries({
          queryKey: nodeKeys.graphNodes(),
          refetchType: 'none',
        });
        if (updatedNode.is_class) {
          queryClient.setQueriesData<Node[]>(
            { queryKey: nodeKeys.classes() },
            (oldData) => {
              if (!oldData || !Array.isArray(oldData)) return oldData;
              return oldData.map(n => n.id === updatedNode.id ? mergeUpdate(n) : n);
            }
          );
          queryClient.invalidateQueries({
            queryKey: nodeKeys.classes(),
          });
        }
      }

      // Invalidate inline classes query to update pill display (only if color changed)
      if (variables.data.color !== undefined) {
        queryClient.invalidateQueries({
          queryKey: nodeKeys.inlineClasses(updatedNode.id),
          refetchType: 'none',
        });
      }

      // If parent_id was updated, invalidate parent's view queries
      if (variables.data.parent_id !== undefined) {
        const newParentId = variables.data.parent_id;

        if (newParentId) {
          queryClient.invalidateQueries({
            queryKey: nodeViewKeys.queryResults(),
            refetchType: 'none',
          });
        }

        const cachedNode = queryClient.getQueryData<Node>(nodeKeys.detail(updatedNode.id));
        const oldParentId = cachedNode?.parent_id;
        if (oldParentId && oldParentId !== newParentId) {
          queryClient.invalidateQueries({
            queryKey: nodeViewKeys.queryResults(),
            refetchType: 'none',
          });
        }

        queryClient.invalidateQueries({
          queryKey: nodeKeys.breadcrumbs(updatedNode.id),
        });
        queryClient.invalidateQueries({
          queryKey: nodeKeys.pages(),
          refetchType: 'none',
        });
        queryClient.invalidateQueries({
          queryKey: nodeKeys.searchAll(),
          refetchType: 'none',
        });
      }

      // If name/content was updated, invalidate link-related caches
      if (variables.data.name !== undefined) {
        invalidateNodeCaches(queryClient, {
          linkedRefs: true,
          backlinks: true,
          propertyBacklinks: true,
          graph: true,
          breadcrumbs: true,
          refetch: false,
        });

        if (updatedNode.is_class) {
          queryClient.setQueriesData<Node[]>(
            { queryKey: nodeKeys.classes() },
            (oldData) => {
              if (!oldData || !Array.isArray(oldData)) return oldData;
              return oldData.map(n => n.id === updatedNode.id ? mergeUpdate(n) : n);
            }
          );
          queryClient.invalidateQueries({
            queryKey: nodeKeys.classes(),
          });
        }

        if (updatedNode.page_id) {
          invalidateNodeCaches(queryClient, {
            nodeId: updatedNode.page_id,
          });
        } else if (updatedNode.parent_id) {
          invalidateNodeCaches(queryClient, {
            nodeId: updatedNode.parent_id,
          });
        }

        if (updatedNode.is_page && updatedNode.uuid) {
          scheduleAutoExport(updatedNode.uuid);
        } else if (updatedNode.page_id) {
          const pageNode = findNodeInCache(queryClient, updatedNode.page_id);
          if (pageNode?.uuid) {
            scheduleAutoExport(pageNode.uuid);
          }
        }
      }
    },
    onError: (error: Error & { response?: { status: number } }, variables) => {
      if (error.response?.status === 409) {
        console.warn('[useUpdateNode] Conflict detected - node was modified by another user/session');
        queryClient.invalidateQueries({
          queryKey: nodeKeys.detailBase(variables.id),
        });
        console.error('Conflict: The node was modified by another user. Please refresh and try again.');
      }
    },
  });
}
