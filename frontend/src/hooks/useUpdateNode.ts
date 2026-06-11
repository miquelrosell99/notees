/**
 * useUpdateNode
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { NodeUpdate, Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { updateNodeInTreeImmutable } from '@/utils/nodeTree';
import { scheduleAutoExport } from '@/utils/autoExport';
import { invalidateNodeCaches, findNodeInCache } from './useNodeMutations.utils';

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
      
      // Helper to update node in tree
      // IMPORTANT: Only returns new object reference if something was actually updated
      const applyUpdate = (oldNode: Node | undefined): Node | undefined => {
        if (!oldNode) return oldNode;
        if (oldNode.id === id) {
          return { ...oldNode, ...buildUpdate() };
        }
        if (oldNode.children && oldNode.children.length > 0) {
          const newChildren = updateNodeInTreeImmutable(oldNode.children, id, data as Partial<Node>);
          // Only create new object if children actually changed
          if (newChildren !== oldNode.children) {
            return {
              ...oldNode,
              children: newChildren,
            };
          }
        }
        return oldNode;
      };
      
      // IMPORTANT: We use explicit cache iteration instead of setQueriesData.
      // See useCreateNode onMutate for detailed explanation.
      // DO NOT REFACTOR to setQueriesData - it breaks optimistic updates at deep nesting levels.
      const queryCache = queryClient.getQueryCache();
      const detailQueries = queryCache.findAll({ queryKey: nodeKeys.details() });
      for (const query of detailQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = applyUpdate(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }
      
      // Update page-content queries
      const pageContentQueries = queryCache.findAll({ queryKey: nodeKeys.pageContents() });
      for (const query of pageContentQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = applyUpdate(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }

      // Update byUuid queries (e.g. Scratchpad uses useNodeByUuid with include_children)
      const byUuidUpdateQueries = queryCache.findAll({ queryKey: nodeKeys.uuids() });
      for (const query of byUuidUpdateQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = applyUpdate(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }

      // Update nodeViews queryResults (flat Node[] arrays used by QueryNodeCollection table/list view)
      const viewQueryQueries = queryCache.findAll({ queryKey: nodeViewKeys.queryResults() });
      for (const query of viewQueryQueries) {
        const oldData = query.state.data as Node[] | undefined;
        if (oldData && Array.isArray(oldData)) {
          let changed = false;
          const newData = oldData.map(n => {
            if (n.id === id) {
              changed = true;
              return { ...n, ...buildUpdate() };
            }
            return n;
          });
          if (changed) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }
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

      // Also update nodeViews queryResults caches (flat Node[] arrays used by QueryNodeCollection)
      // This ensures table cells reflect the new name immediately after inline editing closes.
      queryClient.setQueriesData<Node[]>(
        { queryKey: nodeViewKeys.queryResults() },
        (oldData) => {
          if (!oldData || !Array.isArray(oldData)) return oldData;
          return oldData.map(n => n.id === updatedNode.id ? mergeUpdate(n) : n);
        }
      );

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
      // (icon, color, is_page, etc.) - not for simple content/sequence updates
      const displayFieldsChanged = 
        variables.data.icon !== undefined ||
        variables.data.color !== undefined ||
        variables.data.is_page !== undefined ||
        variables.data.is_favorite !== undefined;
      
      if (displayFieldsChanged) {
        // SOFT invalidation - no active refetch
        invalidateNodeCaches(queryClient, {
          nodeId: updatedNode.id,
          lists: true,
          pages: true,
          search: true, // icon/name changes must be visible in search results
          refetch: false, // Let queries refetch on next mount
        });
        // BUGFIX: Also invalidate graphNodes since display fields (icon, color, name) changed
        queryClient.invalidateQueries({ 
          queryKey: nodeKeys.graphNodes(),
          refetchType: 'none',
        });
        // If this node is a class, synchronously update the classes cache so
        // components using getEffectiveColor/getEffectiveIcon (e.g. MainContent
        // color ribbon, class pills) see the change immediately, then invalidate
        // for a full refetch to ensure consistency.
        if (updatedNode.is_class) {
          queryClient.setQueryData<Node[]>(
            nodeKeys.classes(),
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
      // to update child_pages sections (soft invalidation - no forced refetch)
      if (variables.data.parent_id !== undefined) {
        const newParentId = variables.data.parent_id;
        
        // Invalidate new parent's views (to show new child)
        // Use soft invalidation - let queries refetch on next render
        if (newParentId) {
          queryClient.invalidateQueries({ 
            queryKey: nodeViewKeys.queryResults(),
            refetchType: 'none', // Soft invalidation
          });
        }
        
        // Also get old parent from cache to invalidate its views
        const cachedNode = queryClient.getQueryData<Node>(nodeKeys.detail(updatedNode.id));
        const oldParentId = cachedNode?.parent_id;
        if (oldParentId && oldParentId !== newParentId) {
          queryClient.invalidateQueries({ 
            queryKey: nodeViewKeys.queryResults(),
            refetchType: 'none', // Soft invalidation
          });
        }

        // Invalidate breadcrumbs for this node so the breadcrumb bar updates immediately
        queryClient.invalidateQueries({
          queryKey: nodeKeys.breadcrumbs(updatedNode.id),
        });

        // Invalidate pages and search so command palette breadcrumbs update
        queryClient.invalidateQueries({
          queryKey: nodeKeys.pages(),
          refetchType: 'none',
        });
        queryClient.invalidateQueries({
          queryKey: [...nodeKeys.all, 'search'],
          refetchType: 'none',
        });
      }
      
      // If name/content was updated, invalidate link-related caches
      // This ensures backlink badges and linked references update in real-time
      // when block references are added/removed (e.g., [[linkId]] or ((uuid)))
      if (variables.data.name !== undefined) {
        // SOFT invalidation - don't force refetch, let queries update on next mount
        // This prevents excessive API calls when typing
        invalidateNodeCaches(queryClient, {
          linkedRefs: true,
          backlinks: true,
          propertyBacklinks: true,
          graph: true,
          breadcrumbs: true,
          refetch: false, // No active refetch - too expensive
        });

        // If this node is a class, synchronously update + invalidate the classes
        // cache so class pills update immediately with the new name
        if (updatedNode.is_class) {
          queryClient.setQueryData<Node[]>(
            nodeKeys.classes(),
            (oldData) => {
              if (!oldData || !Array.isArray(oldData)) return oldData;
              return oldData.map(n => n.id === updatedNode.id ? mergeUpdate(n) : n);
            }
          );
          queryClient.invalidateQueries({
            queryKey: nodeKeys.classes(),
          });
        }
        
        // SOFT invalidate the parent page's detail query to refresh children's backlink_count
        // Use refetchType: 'none' to avoid race conditions with optimistic updates
        if (updatedNode.page_id) {
          invalidateNodeCaches(queryClient, {
            nodeId: updatedNode.page_id,
          });
        } else if (updatedNode.parent_id) {
          invalidateNodeCaches(queryClient, {
            nodeId: updatedNode.parent_id,
          });
        }

        // Trigger auto-export to markdown for the containing page
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
      // Handle optimistic locking conflicts
      if (error.response?.status === 409) {
        console.warn('[useUpdateNode] Conflict detected - node was modified by another user/session');
        // Refetch the node to get the latest version
        queryClient.invalidateQueries({ 
          queryKey: nodeKeys.detailBase(variables.id),
        });
        // Show a toast notification (optional - could use a toast library here)
        console.error('Conflict: The node was modified by another user. Please refresh and try again.');
      }
    },
  });
}
