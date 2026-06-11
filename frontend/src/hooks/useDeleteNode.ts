/**
 * useDeleteNode
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { Node, LinkedReference, PropertyBacklink } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { removeNodeFromTreeImmutable } from '@/utils/nodeTree';
import { useFavoritesStore } from '@/stores/favoritesStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { invalidateNodeCaches, findNodeInCache, hasTableClass } from './useNodeMutations.utils';

export function useDeleteNode() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: number): Promise<{ deletedNode: Node | undefined; tableCellInfo: { parentId: number; sequence: number } | null }> => {
      // Fetch the node info before deleting
      let nodeData = queryClient.getQueryData<Node>(nodeKeys.detail(id, {}));
      
      // If not found in direct cache, search in tree structures
      if (!nodeData) {
        nodeData = findNodeInCache(queryClient, id) ?? undefined;
      }
      
      // Check if this is a table cell (grandparent has table class)
      let tableCellInfo: { parentId: number; sequence: number } | null = null;
      
      if (nodeData && nodeData.parent_id) {
        // Get the parent (column) from cache
        const parentNode = findNodeInCache(queryClient, nodeData.parent_id);
        
        if (parentNode && parentNode.parent_id) {
          // Get the grandparent (table) from cache
          const grandparentNode = findNodeInCache(queryClient, parentNode.parent_id);
          
          // Check if grandparent has table class
          const allClasses = queryClient.getQueryData<Node[]>(nodeKeys.classes());
          
          if (grandparentNode && hasTableClass(grandparentNode, allClasses)) {
            // This is a table cell! Save the info for replacement
            tableCellInfo = {
              parentId: nodeData.parent_id,
              sequence: nodeData.sequence ?? 0,
            };
          }
        }
      }
      
      // Perform the deletion
      await nodesApi.deleteNode(id);
      
      // If this was a table cell, create a replacement empty cell
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
      // Immediately remove from favorites and recents so the sidebar updates
      // even if the component that triggered the mutation unmounts before
      // onSuccess fires (TanStack Query v5 only calls onSuccess while mounted).
      const favoritesStore = useFavoritesStore.getState();
      if (favoritesStore.isFavorite(deletedId)) {
        favoritesStore.removeFavorite(deletedId);
      }
      favoritesStore.removeRecent(deletedId);

      // If we're currently viewing the deleted node, navigate away immediately
      // so the user doesn't stay on a page that is about to be deleted.
      const currentNodeId = useNavigationStore.getState().currentNodeId;
      if (currentNodeId === deletedId) {
        useNavigationStore.setState({
          currentNodeId: null,
          mainViewType: 'node',
        });
        const wsMatch = window.location.pathname.match(/^\/([0-9a-f-]{36})/);
        window.history.replaceState(null, '', wsMatch ? `/${wsMatch[1]}` : '/');
      }

      // Cancel any outgoing refetches to not overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pageContents() });
      await queryClient.cancelQueries({ queryKey: nodeViewKeys.queryResults() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.pseudoNodeQuery() });
      await queryClient.cancelQueries({ queryKey: nodeKeys.inlineQuery() });
      
      // Helper to remove node from tree
      // IMPORTANT: Only returns new object reference if something was actually removed
      const removeNode = (oldNode: Node | undefined): Node | undefined => {
        if (!oldNode) return oldNode;
        // If this is the deleted node itself, leave it (will be removed on success)
        if (oldNode.id === deletedId) return oldNode;
        // If this node has children, recursively remove the deleted node
        if (oldNode.children && oldNode.children.length > 0) {
          const newChildren = removeNodeFromTreeImmutable(oldNode.children, deletedId);
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
          const newData = removeNode(oldData);
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
          const newData = removeNode(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }

      // Update byUuid queries (e.g. Scratchpad uses useNodeByUuid with include_children)
      const byUuidDeleteQueries = queryCache.findAll({ queryKey: nodeKeys.uuids() });
      for (const query of byUuidDeleteQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = removeNode(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }

      // Optimistically remove from flat Node[] caches (queryResults, pseudo-node-query, inline-query)
      const flatCacheKeys = [
        nodeViewKeys.queryResults(),
        nodeKeys.pseudoNodeQuery(),
        nodeKeys.inlineQuery(),
      ];
      for (const keyPrefix of flatCacheKeys) {
        for (const query of queryCache.findAll({ queryKey: keyPrefix })) {
          const oldData = query.state.data as Node[] | undefined;
          if (oldData && Array.isArray(oldData)) {
            const newData = oldData.filter(n => n.id !== deletedId);
            if (newData.length !== oldData.length) {
              queryClient.setQueryData(query.queryKey, newData);
            }
          }
        }
      }

      // Optimistically remove from linked-refs caches (different shape: { linked_references, total_count })
      const linkedRefQueries = queryCache.findAll({ queryKey: nodeKeys.allLinkedRefs() });
      for (const query of linkedRefQueries) {
        const oldData = query.state.data as { linked_references: LinkedReference[]; total_count: number } | undefined;
        if (oldData && oldData.linked_references) {
          const newRefs = oldData.linked_references.filter(ref => ref.source_node.id !== deletedId);
          if (newRefs.length !== oldData.linked_references.length) {
            queryClient.setQueryData(query.queryKey, {
              ...oldData,
              linked_references: newRefs,
              total_count: Math.max(0, oldData.total_count - 1),
            });
          }
        }
      }

      // Optimistically remove from property-backlinks caches (different shape: PropertyBacklink[])
      const propertyBacklinkQueries = queryCache.findAll({ queryKey: ['nodes', 'property-backlinks'] });
      for (const query of propertyBacklinkQueries) {
        const oldData = query.state.data as PropertyBacklink[] | undefined;
        if (oldData && Array.isArray(oldData)) {
          const newData = oldData.filter(ref => ref.source_page.id !== deletedId);
          if (newData.length !== oldData.length) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }

      // Immediately remove the block (and its descendants) from the NodeGraphRuntime so
      // the Lexical editor reflects the deletion without waiting for a query refetch.
      // We use removeNodes() rather than applyIntent('delete_block') to avoid emitting
      // a block_deleted event that would cause useBlockPersist to issue a duplicate
      // server-side delete call.
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
      // Check if we're currently viewing the deleted node (page or block)
      // Use dynamic import to avoid circular dependency issues
      const { useNavigationStore } = await import('@/stores');
      const currentNodeId = useNavigationStore.getState().currentNodeId;
      
      // If we deleted the node we're currently viewing, navigate to home
      if (currentNodeId === deletedId) {
        // Navigate to home and clear the current node
        useNavigationStore.setState({ 
          currentNodeId: null,
          mainViewType: 'node'
        });
        // Navigate to workspace home (extract workspace UUID from current path)
        const wsMatch = window.location.pathname.match(/^\/([0-9a-f-]{36})/);
        window.history.replaceState(null, '', wsMatch ? `/${wsMatch[1]}` : '/');
      }
      
      // Remove the deleted node's queries (all variations)
      queryClient.removeQueries({ queryKey: nodeKeys.detailBase(deletedId) });
      
      // If a table cell was replaced, invalidate the parent (column) to refresh
      if (tableCellInfo) {
        queryClient.invalidateQueries({ 
          queryKey: nodeKeys.detailBase(tableCellInfo.parentId),
          refetchType: 'active',
        });
      }

      // Invalidate the parent node's detail cache so property values refresh
      // (e.g. text properties that reference the deleted block as their value)
      if (deletedNode?.parent_id) {
        invalidateNodeCaches(queryClient, {
          nodeId: deletedNode.parent_id,
          refetch: true,
        });
      }

      // Invalidate batch-properties caches so table/list views don't show stale values
      queryClient.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) && q.queryKey.includes('batch-properties'),
        refetchType: 'none',
      });
      
      // Remove from favorites and recents
      const { useFavoritesStore } = await import('@/stores');
      const favoritesStore = useFavoritesStore.getState();
      if (favoritesStore.isFavorite(deletedId)) {
        favoritesStore.removeFavorite(deletedId);
      }
      favoritesStore.removeRecent(deletedId);
      
      // SOFT invalidate queries to prevent race conditions with concurrent mutations
      // Use refetchType: 'none' to mark as stale without immediate refetch
      // This prevents overwriting optimistic updates from other mutations
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      // Refetch pages list actively so live subscribers (e.g. command palette) update immediately
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pages(),
        refetchType: 'active',
      });
      // Invalidate all backlinks since they may reference the deleted node
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'backlinks'],
        refetchType: 'none',
      });
      // Invalidate linked references
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'linked-refs'],
        refetchType: 'none',
      });
      // Invalidate page content as blocks may have been updated
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pageContents(),
        refetchType: 'none',
      });
      // Actively refetch all node view query results so views update immediately
      queryClient.invalidateQueries({ 
        queryKey: nodeViewKeys.queryResults(),
        refetchType: 'active',
      });
      // Invalidate pseudo-node queries (e.g., All Pages view)
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pseudoNodeQuery(),
        refetchType: 'active',
      });
      // Invalidate inline query sections (embedded QuerySection within node pages)
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.inlineQuery(),
        refetchType: 'active',
      });
      // Invalidate graph data since nodes/links changed
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.graph(),
        refetchType: 'none',
      });
      // BUGFIX: Also invalidate graphNodes query (separate from graph query)
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.graphNodes(),
        refetchType: 'none',
      });
    },
  });
}
