/**
 * Node Mutation Hooks
 * 
 * React Query mutation hooks for creating, updating, deleting, and moving nodes.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { NodeCreate, NodeUpdate, Node } from '@/types/api';
import { nodeKeys, propertyKeys } from './queryKeys';

// ==================== Helper Functions ====================

/**
 * Helper to update daily cache entries.
 * Daily pages are just nodes, but they have a separate cache for the useDailyNote hook.
 * This helper ensures both caches stay in sync during optimistic updates.
 */
function updateDailyCache(
  queryClient: ReturnType<typeof useQueryClient>,
  updater: (node: Node) => Node
) {
  const dailyQueryKey = [...nodeKeys.all, 'daily'];
  queryClient.setQueriesData<Node>(
    { queryKey: dailyQueryKey, exact: false },
    (oldNode) => oldNode ? updater(oldNode) : oldNode
  );
}

/**
 * Helper to recursively update a specific node within a tree by ID.
 * Returns a new tree with the target node updated.
 * Overloaded to handle optional node input for cache updaters.
 */
function updateNodeById(node: Node, targetId: number, updater: (n: Node) => Node): Node;
function updateNodeById(node: Node | undefined, targetId: number, updater: (n: Node) => Node): Node | undefined;
function updateNodeById(node: Node | undefined, targetId: number, updater: (n: Node) => Node): Node | undefined {
  if (!node) return undefined;
  if (node.id === targetId) {
    return updater(node);
  }
  if (node.children && node.children.length > 0) {
    return {
      ...node,
      children: node.children.map(child => updateNodeById(child, targetId, updater)),
    };
  }
  return node;
}

/**
 * Helper to recursively update a node in a tree structure
 */
function updateNodeInTree(nodes: Node[], nodeId: number, updates: Partial<Node>): Node[] {
  return nodes.map(node => {
    if (node.id === nodeId) {
      return { ...node, ...updates };
    }
    if (node.children && node.children.length > 0) {
      return {
        ...node,
        children: updateNodeInTree(node.children, nodeId, updates),
      };
    }
    return node;
  });
}

/**
 * Helper to recursively remove a node from a tree structure
 */
function removeNodeFromTree(nodes: Node[], nodeId: number): Node[] {
  return nodes
    .filter(node => node.id !== nodeId)
    .map(node => {
      if (node.children && node.children.length > 0) {
        return {
          ...node,
          children: removeNodeFromTree(node.children, nodeId),
        };
      }
      return node;
    });
}

// ==================== Node Mutations ====================

// Counter for optimistic IDs - negative to avoid collision with real IDs
// Module-level to ensure uniqueness across all hook instances
let optimisticIdCounter = -1;

/**
 * Hook to create a node (pages or blocks)
 * 
 * For pages: pass is_page: true
 * For blocks: pass parent_id
 * 
 * Uses optimistic updates for blocks to show them immediately.
 */
export function useCreateNode() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: NodeCreate) => nodesApi.createNode(data),
    onMutate: async (variables) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      if (variables.parent_id) {
        await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(variables.parent_id) });
        await queryClient.cancelQueries({ queryKey: nodeKeys.pageContent(variables.parent_id) });
        await queryClient.cancelQueries({ queryKey: ['nodes', 'page-content'] });
      }
      if (variables.is_page) {
        await queryClient.cancelQueries({ queryKey: nodeKeys.pages() });
      }
      
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
          return {
            ...node,
            children: node.children.map(addChildToParent),
          };
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
      const pageContentQueries = queryCache.findAll({ queryKey: ['nodes', 'page-content'] });
      for (const query of pageContentQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = addChildToParent(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }
      
      // Update daily cache
      updateDailyCache(queryClient, addChildToParent);
      
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
        const parentId = variables.parent_id;
        
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
          { queryKey: ['nodes', 'page-content'] },
          (oldNode) => oldNode ? replaceOptimistic(oldNode) : oldNode
        );
        
        updateDailyCache(queryClient, replaceOptimistic);
      } else if (variables.parent_id) {
        // No optimistic update was made, add node to parent now
        const parentId = variables.parent_id;
        
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
        
        const updateChildrenNode = (node: Node): Node => updateChildrenOptional(node) ?? node;
        
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(parentId) },
          updateChildrenOptional
        );
        
        queryClient.setQueriesData<Node>(
          { queryKey: ['nodes', 'page-content'] },
          (oldNode) => {
            if (!oldNode || oldNode.id !== parentId) return oldNode;
            return updateChildrenOptional(oldNode);
          }
        );
        
        updateDailyCache(queryClient, (page) => updateNodeById(page, parentId, updateChildrenNode));
      }
      
      // Invalidate list queries for sidebar updates (soft invalidate, no refetch)
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      
      // If this is a page, add to pages cache
      if (newNode.is_page) {
        queryClient.setQueryData<Node[]>(nodeKeys.pages(), (oldPages) => {
          if (!oldPages) return [newNode];
          if (oldPages.some(p => p.id === newNode.id)) return oldPages;
          return [...oldPages, newNode];
        });
        queryClient.invalidateQueries({ 
          queryKey: nodeKeys.pages(),
          refetchType: 'none',
        });
        queryClient.invalidateQueries({ 
          queryKey: [...nodeKeys.all, 'search'],
          refetchType: 'none',
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
          { queryKey: ['nodes', 'page-content'] },
          (oldNode) => oldNode ? removeOptimistic(oldNode) : oldNode
        );
        
        updateDailyCache(queryClient, removeOptimistic);
      }
    },
  });
}

/**
 * Hook to update a node
 */
export function useUpdateNode() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: NodeUpdate }) => 
      nodesApi.updateNode(id, data),
    onMutate: async ({ id, data }) => {
      // Cancel any outgoing refetches to not overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: ['nodes', 'page-content'] });
      
      // Build update object
      const buildUpdate = (): Partial<Node> => {
        const update: Partial<Node> = {};
        if (data.name !== undefined && data.name !== null) update.name = data.name;
        if (data.icon !== undefined) update.icon = data.icon;
        if (data.color !== undefined) update.color = data.color;
        if (data.parent_id !== undefined) update.parent_id = data.parent_id;
        if (data.sequence !== undefined && data.sequence !== null) update.sequence = data.sequence;
        if (data.collapsed !== undefined && data.collapsed !== null) update.collapsed = data.collapsed;
        return update;
      };
      
      // Helper to update node in tree
      const applyUpdate = (oldNode: Node | undefined): Node | undefined => {
        if (!oldNode) return oldNode;
        if (oldNode.id === id) {
          return { ...oldNode, ...buildUpdate() };
        }
        if (oldNode.children && oldNode.children.length > 0) {
          return {
            ...oldNode,
            children: updateNodeInTree(oldNode.children, id, data as Partial<Node>),
          };
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
      const pageContentQueries = queryCache.findAll({ queryKey: ['nodes', 'page-content'] });
      for (const query of pageContentQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = applyUpdate(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }
      
      // Update daily cache (daily pages have a separate cache key)
      updateDailyCache(queryClient, (page) => applyUpdate(page) ?? page);
    },
    onSuccess: (updatedNode, variables) => {
      // Merge the updated node with existing cached data to preserve children and other fields
      // that aren't returned by the update endpoint
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(updatedNode.id) },
        (oldNode) => {
          if (!oldNode) return updatedNode;
          // Create a filtered version of updatedNode that excludes null values for fields
          // that should be preserved from the cache (children, backlinks, linked_references, properties)
          // These fields are not returned by the update endpoint but exist in the cached data
          const { children, backlinks, linked_references, properties, ...rest } = updatedNode;
          return {
            ...oldNode,
            ...rest,
            // Only overwrite these fields if the API actually returned data for them
            ...(children !== null && children !== undefined ? { children } : {}),
            ...(backlinks !== null && backlinks !== undefined ? { backlinks } : {}),
            ...(linked_references !== null && linked_references !== undefined ? { linked_references } : {}),
            ...(properties !== null && properties !== undefined && Object.keys(properties).length > 0 ? { properties } : {}),
          };
        }
      );
      // SOFT invalidate to prevent race conditions with concurrent mutations
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pages(),
        refetchType: 'none',
      });
      // Also invalidate classes since the updated node might be used as a class
      // and its icon/name could have changed
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.classes(),
        refetchType: 'none',
      });
      
      // If name/content was updated, invalidate link-related caches
      // This ensures backlink badges and linked references update in real-time
      // when block references are added/removed (e.g., [[linkId]] or ((uuid)))
      if (variables.data.name !== undefined) {
        // Invalidate linked references for all nodes - this marks them stale
        // so they will refetch when next observed
        queryClient.invalidateQueries({ 
          queryKey: ['nodes', 'linked-refs'],
        });
        // Also immediately refetch any active queries
        queryClient.refetchQueries({ 
          queryKey: ['nodes', 'linked-refs'],
          type: 'active',
        });
        // Invalidate and refetch backlinks queries
        queryClient.invalidateQueries({ 
          queryKey: ['nodes', 'backlinks'],
        });
        queryClient.refetchQueries({ 
          queryKey: ['nodes', 'backlinks'],
          type: 'active',
        });
        // Invalidate and refetch property backlinks (in case content had property-like references)
        queryClient.invalidateQueries({ 
          queryKey: ['nodes', 'property-backlinks'],
        });
        queryClient.refetchQueries({ 
          queryKey: ['nodes', 'property-backlinks'],
          type: 'active',
        });
        
        // SOFT invalidate the parent page's detail query to refresh children's backlink_count
        // Use refetchType: 'none' to avoid race conditions with optimistic updates
        // The query will be refetched on next access (e.g., navigation back to page)
        // This prevents overwriting optimistic updates from concurrent mutations
        if (updatedNode.page_id) {
          queryClient.invalidateQueries({ 
            queryKey: nodeKeys.detailBase(updatedNode.page_id),
            refetchType: 'none',
          });
        } else if (updatedNode.parent_id) {
          queryClient.invalidateQueries({ 
            queryKey: nodeKeys.detailBase(updatedNode.parent_id),
            refetchType: 'none',
          });
        }
      }
    },
  });
}

/**
 * Hook to delete a node
 * 
 * When a node is deleted:
 * - All [[Page Name]] links to it are replaced with just "Page Name"
 * - All ((uuid)) links are replaced with the block's text content
 * - Type/tag references are removed from properties but inline text remains
 * - If a page is deleted and it's currently being viewed, navigate to home
 */
export function useDeleteNode() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: number) => {
      // Fetch the node info before deleting so we can check if it's a page
      const nodeData = queryClient.getQueryData<Node>(nodeKeys.detail(id, {}));
      await nodesApi.deleteNode(id);
      return nodeData; // Return the cached node data
    },
    onMutate: async (deletedId) => {
      // Cancel any outgoing refetches to not overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: ['nodes', 'page-content'] });
      
      // Helper to remove node from tree
      const removeNode = (oldNode: Node | undefined): Node | undefined => {
        if (!oldNode) return oldNode;
        // If this is the deleted node itself, leave it (will be removed on success)
        if (oldNode.id === deletedId) return oldNode;
        // If this node has children, recursively remove the deleted node
        if (oldNode.children && oldNode.children.length > 0) {
          return {
            ...oldNode,
            children: removeNodeFromTree(oldNode.children, deletedId),
          };
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
      const pageContentQueries = queryCache.findAll({ queryKey: ['nodes', 'page-content'] });
      for (const query of pageContentQueries) {
        const oldData = query.state.data as Node | undefined;
        if (oldData) {
          const newData = removeNode(oldData);
          if (newData !== oldData) {
            queryClient.setQueryData(query.queryKey, newData);
          }
        }
      }
      
      // Update daily cache (daily pages have a separate cache key)
      updateDailyCache(queryClient, (page) => removeNode(page) ?? page);
    },
    onSuccess: async (deletedNode, deletedId) => {
      // Check if we're currently viewing the deleted node (page or block)
      // Use dynamic import to avoid circular dependency issues
      const { useNodesStore } = await import('@/stores');
      const currentNodeId = useNodesStore.getState().currentNodeId;
      
      // If we deleted the page we're currently viewing, navigate to home
      if (currentNodeId === deletedId && deletedNode?.is_page) {
        // Navigate to home and clear the current node
        useNodesStore.setState({ 
          currentNodeId: null,
          mainViewType: 'node'
        });
        window.history.replaceState(null, '', '/');
      }
      
      // Remove the deleted node's queries (all variations)
      queryClient.removeQueries({ queryKey: nodeKeys.detailBase(deletedId) });
      
      // SOFT invalidate queries to prevent race conditions with concurrent mutations
      // Use refetchType: 'none' to mark as stale without immediate refetch
      // This prevents overwriting optimistic updates from other mutations
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pages(),
        refetchType: 'none',
      });
      // Invalidate all backlinks since they may reference the deleted node
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'backlinks'],
        refetchType: 'none',
      });
      // Invalidate linked references (legacy)
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'linked-refs'],
        refetchType: 'none',
      });
      // Invalidate page content as blocks may have been updated
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'page-content'],
        refetchType: 'none',
      });
      // Invalidate all node view query results (linked references, etc.)
      queryClient.invalidateQueries({ 
        queryKey: ['nodeViews', 'queryResults'],
        refetchType: 'none',
      });
    },
  });
}

/**
 * Hook to archive a node
 */
export function useArchiveNode() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (id: number) => nodesApi.archiveNode(id),
    onSuccess: (node) => {
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(node.id) },
        () => node
      );
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pages(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'archived'],
        refetchType: 'none',
      });
    },
  });
}

/**
 * Hook to unarchive a node
 */
export function useUnarchiveNode() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (id: number) => nodesApi.unarchiveNode(id),
    onSuccess: (node) => {
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(node.id) },
        () => node
      );
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pages(),
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'archived'],
        refetchType: 'none',
      });
    },
  });
}

/**
 * Hook to move a node
 */
export function useMoveNode() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, parentId, position }: { id: number; parentId: number | null; position?: number }) => 
      nodesApi.moveNode(id, parentId, position),
    onMutate: async ({ id, parentId, position }) => {
      // Cancel any outgoing refetches to not overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: ['nodes', 'page-content'] });
      
      // Find the node being moved from any cache
      let movedNode: Node | null = null;
      
      // Search through all cached detail queries to find the node
      const detailQueries = queryClient.getQueriesData<Node>({ queryKey: nodeKeys.details() });
      for (const [, data] of detailQueries) {
        if (!data) continue;
        // Check if this is the node itself
        if (data.id === id) {
          movedNode = data;
          break;
        }
        // Check if the node is in children
        const findInChildren = (node: Node): Node | null => {
          if (node.children) {
            for (const child of node.children) {
              if (child.id === id) {
                return child;
              }
              const found = findInChildren(child);
              if (found) return found;
            }
          }
          return null;
        };
        const found = findInChildren(data);
        if (found) {
          movedNode = found;
          break;
        }
      }
      
      if (!movedNode) return; // Can't do optimistic update without the node data
      
      // Helper to remove a node from children array
      const removeFromChildren = (children: Node[] | null | undefined): Node[] => {
        if (!children) return [];
        return children.filter(c => c.id !== id).map(c => ({
          ...c,
          children: removeFromChildren(c.children),
        }));
      };
      
      // Helper to insert node at the correct position in a children array
      const insertAtPosition = (children: Node[], nodeToInsert: Node, pos: number): Node[] => {
        const newChildren = [...children];
        // Update the moved node with new parent and sequence
        const updatedNode = { 
          ...nodeToInsert, 
          parent_id: parentId, 
          sequence: pos 
        };
        // Insert at the right position
        newChildren.splice(pos, 0, updatedNode);
        // Update sequences for nodes after the insertion point
        return newChildren.map((child, idx) => ({
          ...child,
          sequence: idx,
        }));
      };
      
      // Helper to recursively insert the moved node at the new parent location
      const insertAtParent = (node: Node, nodeToInsert: Node, targetParentId: number | null, pos: number): Node => {
        // If this node is the target parent, insert the moved node into its children
        if (node.id === targetParentId) {
          const currentChildren = node.children || [];
          return {
            ...node,
            children: insertAtPosition(currentChildren, nodeToInsert, pos),
          };
        }
        
        // Otherwise, recursively check children
        if (node.children && node.children.length > 0) {
          return {
            ...node,
            children: node.children.map(child => insertAtParent(child, nodeToInsert, targetParentId, pos)),
          };
        }
        
        return node;
      };
      
      // Update all detail queries
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details() },
        (oldNode) => {
          if (!oldNode) return oldNode;
          
          // First remove the moved node from anywhere in the tree
          let updated: Node = {
            ...oldNode,
            children: oldNode.children ? removeFromChildren(oldNode.children) : [],
          };
          
          // Then insert at the new parent location (recursively finds the parent)
          if (movedNode && parentId !== null) {
            updated = insertAtParent(updated, movedNode, parentId, position ?? 0);
          }
          
          return updated;
        }
      );
      
      // Also update page-content queries
      queryClient.setQueriesData<Node>(
        { queryKey: ['nodes', 'page-content'] },
        (oldNode) => {
          if (!oldNode) return oldNode;
          
          // First remove the moved node from anywhere in the tree
          let updated: Node = {
            ...oldNode,
            children: oldNode.children ? removeFromChildren(oldNode.children) : [],
          };
          
          // Then insert at the new parent location (recursively finds the parent)
          if (movedNode && parentId !== null) {
            updated = insertAtParent(updated, movedNode, parentId, position ?? 0);
          }
          
          return updated;
        }
      );
      
      // Update daily cache (daily pages have a separate cache key)
      updateDailyCache(queryClient, (page) => {
        // First remove the node from wherever it currently is (recursively)
        let updated: Node = {
          ...page,
          children: page.children ? removeFromChildren(page.children) : [],
        };
        
        // Insert at the correct parent using the helper
        if (movedNode && parentId) {
          updated = updateNodeById(updated, parentId, (parent) => ({
            ...parent,
            children: insertAtPosition(parent.children || [], movedNode, position ?? (parent.children?.length ?? 0)),
          }));
        }
        
        return updated;
      });
    },
    onSuccess: (_movedNode, _variables) => {
      // The optimistic update in onMutate already handled the tree restructuring.
      // We don't refetch immediately to avoid UI flash.
      // Just mark queries as stale so they'll refetch on next navigation/focus.
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.details(),
        refetchType: 'none', // Mark stale but don't refetch
      });
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'page-content'],
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.lists(),
        refetchType: 'none',
      });
    },
  });
}

/**
 * Hook to add a tag to a node (tags are stored as links with is_tag=true)
 */
export function useAddTag() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, tagId }: { nodeId: number; tagId: number }) => 
      nodesApi.addTagLink(nodeId, tagId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
    },
  });
}

/**
 * Hook to remove a tag from a node (tags are stored as links with is_tag=true)
 */
export function useRemoveTag() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, tagId }: { nodeId: number; tagId: number }) => 
      nodesApi.removeTagLink(nodeId, tagId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
    },
  });
}

/**
 * Hook to add a class to a node
 */
export function useAddClass() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, classId }: { nodeId: number; classId: number }) => 
      nodesApi.addClass(nodeId, classId),
    onSuccess: (updatedNode, { nodeId, classId }) => {
      // Update the node cache with the returned node (which includes the new class)
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId) },
        () => updatedNode
      );
      
      // Invalidate class properties queries to ensure they're refetched
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClass(classId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forClassInherited(classId) });
      
      // Invalidate the classed nodes list so the new node appears immediately
      queryClient.invalidateQueries({ queryKey: ['nodes', 'by-class', classId] });
      
      // Also invalidate lists and page content
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
      
      // If this is a block (has parent_id), invalidate the parent's detail and page content
      // so the block's classes array is refreshed in the parent's children list
      if (updatedNode.parent_id !== null) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.parent_id) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_id) });
      }
      
      // Also invalidate the page's detail if different from parent
      if (updatedNode.page_id !== null && updatedNode.page_id !== updatedNode.parent_id) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.page_id) });
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_id) });
      }
    },
  });
}

/**
 * Hook to remove a class from a node
 */
export function useRemoveClass() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, classId }: { nodeId: number; classId: number }) => 
      nodesApi.removeClass(nodeId, classId),
    onSuccess: (updatedNode, { nodeId, classId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
      
      // Invalidate the classed nodes list so the removed node disappears immediately
      queryClient.invalidateQueries({ queryKey: ['nodes', 'by-class', classId] });
      
      // Also invalidate the page content if the node is a block within a page
      if (updatedNode.page_id !== null && updatedNode.page_id !== nodeId) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.page_id) });
      }
      // Invalidate parent's page content if different
      if (updatedNode.parent_id !== null && updatedNode.parent_id !== nodeId) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(updatedNode.parent_id) });
      }
    },
  });
}

/**
 * Hook to add a tag link
 */
export function useAddTagLink() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, targetNodeId }: { nodeId: number; targetNodeId: number }) => 
      nodesApi.addTagLink(nodeId, targetNodeId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: ['textLinks', nodeId] });
    },
  });
}

/**
 * Hook to remove a tag link
 */
export function useRemoveTagLink() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, targetId }: { nodeId: number; targetId: number }) => 
      nodesApi.removeTagLink(nodeId, targetId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: ['textLinks', nodeId] });
    },
  });
}
