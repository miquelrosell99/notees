/**
 * useCreateNode
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { NodeCreate, Node } from '@/types/api';
import { nodeKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { invalidateNodeCaches } from './useNodeMutations.utils';

// Counter for optimistic IDs - negative to avoid collision with real IDs
// Module-level to ensure uniqueness across all hook instances
let optimisticIdCounter = -1;

export function useCreateNode() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: NodeCreate) => nodesApi.createNode(data),
    onMutate: async (variables) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      if (variables.parent_id) {
        await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(variables.parent_id) });
        await queryClient.cancelQueries({ queryKey: nodeKeys.pageContent(variables.parent_id) });
        await queryClient.cancelQueries({ queryKey: nodeKeys.pageContents() });
      }
      // NodeCreate doesn't have is_page - pages are created by classes
      // Skip page query cancellation for create operations
      
      // Only do optimistic update for blocks (not pages, since pages have more complex state)
      if (!variables.parent_id) {
        return { optimisticNode: null };
      }
      
      const parentId = variables.parent_id;
      
      // Create an optimistic node
      // Use a negative ID that will be replaced on success
      const optimisticId = optimisticIdCounter--;
      const optimisticNode: Node = {
        id: optimisticId,
        uuid: `optimistic-${optimisticId}`,
        name: variables.name || '',
        icon: null,
        color: null,
        parent_id: parentId,
        page_id: null, // Will be set by server
        sequence: variables.sequence ?? 0,
        collapsed: false,
        active: true,
        is_page: false,
        create_date: new Date().toISOString(),
        write_date: new Date().toISOString(),
        children: [],
      };
      
      // Helper to insert node at the correct position in children
      const insertAtPosition = (children: Node[], pos: number): Node[] => {
        const newChildren = [...children];
        newChildren.splice(pos, 0, optimisticNode);
        // Re-sequence
        return newChildren.map((child, idx) => ({ ...child, sequence: idx }));
      };
      
      // Helper to update parent's children recursively
      // IMPORTANT: Only returns new object reference if the parent was actually found and updated
      const addChildToParent = (node: Node): Node => {
        if (node.id === parentId) {
          const currentChildren = node.children || [];
          const pos = variables.sequence ?? currentChildren.length;
          return {
            ...node,
            children: insertAtPosition(currentChildren, pos),
          };
        }
        if (node.children && node.children.length > 0) {
          const newChildren = node.children.map(c => addChildToParent(c));
          // Check if any child was actually updated
          const changed = newChildren.some((c, i) => c !== node.children![i]);
          if (changed) {
            return {
              ...node,
              children: newChildren,
            };
          }
        }
        return node;
      };
      
      // IMPORTANT: We use explicit cache iteration instead of setQueriesData({ queryKey: nodeKeys.details() }).
      // 
      // Why not setQueriesData with partial keys?
      // - setQueriesData uses partial key matching which SHOULD work, but in practice it was unreliable
      //   for deeply nested block structures (page -> block -> child-block -> grandchild-block).
      // - When creating a block at level 3+, the UI wouldn't update until page reload.
      // 
      // Why explicit iteration works:
      // - We find ALL matching queries with getQueryCache().findAll()
      // - We explicitly call setQueryData on each query with the exact query key
      // - This guarantees React Query notifies all subscribers of the change
      // - The "if (newData !== oldData)" check ensures we only update if the tree actually changed
      //
      // DO NOT REFACTOR this back to setQueriesData - it will break optimistic updates at deep nesting levels.
      const queryCache = queryClient.getQueryCache();
      const detailQueries = queryCache.findAll({ queryKey: nodeKeys.details() });
      for (const query of detailQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = addChildToParent(oldData);
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
          const newData = addChildToParent(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }

      // Update byUuid queries (e.g. Scratchpad uses useNodeByUuid with include_children)
      const byUuidQueries = queryCache.findAll({ queryKey: nodeKeys.uuids() });
      for (const query of byUuidQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = addChildToParent(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }
      
      return { optimisticNode, optimisticId };
    },
    onSuccess: (newNode, variables, context) => {
      const { optimisticId } = context || {};
      
      // Add the new node to its own detail cache
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(newNode.id) },
        () => newNode
      );
      
      // If we had an optimistic node, replace it with the real one
      if (variables.parent_id && optimisticId) {
        // Remap the runtime block from optimistic blockId to real UUID
        // so the next useLayoutEffect sync recognises it as an update
        // instead of a remove+add (which causes a visual flash).
        const oldBlockId = `optimistic-${optimisticId}`;
        const runtime = getNodeGraphRuntime();
        runtime.remapBlockId(oldBlockId, newNode.uuid);
        runtime.setServerId(newNode.uuid, newNode.id);

        // Helper to replace optimistic node with real node
        const replaceOptimistic = (node: Node): Node => {
          if (node.children && node.children.length > 0) {
            return {
              ...node,
              children: node.children.map(child => {
                if (child.id === optimisticId) {
                  // Replace optimistic with real node, preserving children if any
                  return { ...newNode, children: child.children || newNode.children };
                }
                return replaceOptimistic(child);
              }),
            };
          }
          return node;
        };
        
        // Update all caches to replace optimistic node
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.details() },
          (oldNode) => oldNode ? replaceOptimistic(oldNode) : oldNode
        );
        
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.pageContents() },
          (oldNode) => oldNode ? replaceOptimistic(oldNode) : oldNode
        );

        // Also update byUuid queries (e.g. Scratchpad)
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.uuids() },
          (oldNode) => oldNode ? replaceOptimistic(oldNode) : oldNode
        );
      } else if (variables.parent_id) {
        // No optimistic update was made, add node to parent now
        const updateChildrenOptional = (oldNode: Node | undefined): Node | undefined => {
          if (!oldNode) return oldNode;
          const alreadyExists = oldNode.children?.some(c => c.id === newNode.id);
          if (alreadyExists) return oldNode;
          
          const existingChildren = oldNode.children || [];
          const insertIndex = existingChildren.findIndex(c => c.sequence >= newNode.sequence);
          const newChildren = insertIndex === -1
            ? [...existingChildren, newNode]
            : [
                ...existingChildren.slice(0, insertIndex),
                newNode,
                ...existingChildren.slice(insertIndex),
              ];
          
          return { ...oldNode, children: newChildren };
        };
        
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(variables.parent_id) },
          updateChildrenOptional
        );
        
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.pageContents() },
          (oldNode) => {
            if (!oldNode || oldNode.id !== variables.parent_id) return oldNode;
            return updateChildrenOptional(oldNode);
          }
        );

        // Also update byUuid queries (e.g. Scratchpad)
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.uuids() },
          (oldNode) => {
            if (!oldNode) return oldNode;
            return updateChildrenOptional(oldNode) ?? oldNode;
          }
        );
      }
      
      // Invalidate common caches
      invalidateNodeCaches(queryClient, {
        lists: true,
        pages: newNode.is_page,
        classes: newNode.is_class,
        search: newNode.is_page,
        graph: newNode.is_page,
      });
      
      if (newNode.is_page) {
        // Also invalidate graphNodes query (separate from graph query)
        queryClient.invalidateQueries({ 
          queryKey: nodeKeys.graphNodes(),
          refetchType: 'active',
        });
        // Actively refetch all node view query results (child_pages, classed_nodes, etc.)
        queryClient.invalidateQueries({
          queryKey: nodeViewKeys.queryResults(),
          refetchType: 'active',
        });
        // Actively refetch pseudo-node queries (e.g. All Pages view)
        queryClient.invalidateQueries({
          queryKey: nodeKeys.pseudoNodeQuery(),
          refetchType: 'active',
        });
      }
      
      // GLOBAL: If the new node is a page with a parent, also invalidate the parent's detail cache
      if (newNode.is_page && newNode.parent_id) {
        invalidateNodeCaches(queryClient, {
          nodeId: newNode.parent_id,
          refetch: true,
        });
      }
    },
    onError: (_error, variables, context) => {
      // Rollback optimistic update on error
      const { optimisticId } = context || {};
      
      if (variables.parent_id && optimisticId) {
        // Remove the optimistic node from caches
        const removeOptimistic = (node: Node): Node => {
          if (node.children && node.children.length > 0) {
            return {
              ...node,
              children: node.children
                .filter(child => child.id !== optimisticId)
                .map(removeOptimistic),
            };
          }
          return node;
        };
        
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.details() },
          (oldNode) => oldNode ? removeOptimistic(oldNode) : oldNode
        );
        
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.pageContents() },
          (oldNode) => oldNode ? removeOptimistic(oldNode) : oldNode
        );

        // Also rollback byUuid queries (e.g. Scratchpad)
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.uuids() },
          (oldNode) => oldNode ? removeOptimistic(oldNode) : oldNode
        );
      }
    },
  });
}
