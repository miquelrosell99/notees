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

/**
 * Hook to create a node (pages or blocks)
 * 
 * For pages: pass is_page: true
 * For blocks: pass parent_id
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
      }
      // For pages, cancel pages query to prepare for optimistic update
      if (variables.is_page) {
        await queryClient.cancelQueries({ queryKey: nodeKeys.pages() });
      }
    },
    onSuccess: (newNode, variables) => {
      // Add the new node to the cache (matches any options)
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(newNode.id) },
        () => newNode
      );
      
      // If the node has a parent, update the parent's cached data to include the new child
      if (variables.parent_id) {
        const parentId = variables.parent_id;
        
        // Helper to update a node's children array, inserting at the correct position by sequence
        const updateChildrenOptional = (oldNode: Node | undefined): Node | undefined => {
          if (!oldNode) return oldNode;
          // Check if the new node is already in the children (avoid duplicates)
          const alreadyExists = oldNode.children?.some(c => c.id === newNode.id);
          if (alreadyExists) return oldNode;
          
          const existingChildren = oldNode.children || [];
          // Insert the new node at the correct position based on sequence
          const insertIndex = existingChildren.findIndex(c => c.sequence >= newNode.sequence);
          const newChildren = insertIndex === -1
            ? [...existingChildren, newNode] // Add at end if no child has higher sequence
            : [
                ...existingChildren.slice(0, insertIndex),
                newNode,
                ...existingChildren.slice(insertIndex),
              ];
          
          return {
            ...oldNode,
            children: newChildren,
          };
        };
        
        // Type-safe updater for updateNodeById (guaranteed non-undefined)
        const updateChildrenNode = (node: Node): Node => {
          const result = updateChildrenOptional(node);
          return result ?? node;
        };
        
        // Update the parent node's detail cache (matches any options)
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(parentId) },
          updateChildrenOptional
        );
        
        // Update the parent's page content cache if it exists
        queryClient.setQueriesData<Node>(
          { queryKey: ['nodes', 'page-content'] },
          (oldNode) => {
            if (!oldNode || oldNode.id !== parentId) return oldNode;
            return updateChildrenOptional(oldNode);
          }
        );
        
        // Update daily cache (daily pages have a separate cache key)
        updateDailyCache(queryClient, (page) => 
          updateNodeById(page, parentId, updateChildrenNode)
        );
      }
      
      // Invalidate list queries for sidebar updates, etc.
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      
      // If this is a page, optimistically add to pages cache and invalidate
      if (newNode.is_page) {
        // Optimistically add new page to the pages cache
        queryClient.setQueryData<Node[]>(nodeKeys.pages(), (oldPages) => {
          if (!oldPages) return [newNode];
          // Check if already exists (avoid duplicates)
          if (oldPages.some(p => p.id === newNode.id)) return oldPages;
          return [...oldPages, newNode];
        });
        // Also invalidate to ensure consistency
        queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
        // Invalidate search results so the new page shows up in searches
        queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'search'] });
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
      
      // Optimistically update any parent nodes that might contain this node as a child
      // by finding all detail queries and updating children recursively
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details() },
        applyUpdate
      );
      
      // Also update page-content queries
      queryClient.setQueriesData<Node>(
        { queryKey: ['nodes', 'page-content'] },
        applyUpdate
      );
      
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
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      // Also invalidate types since the updated node might be used as a type
      // and its icon/name could have changed
      queryClient.invalidateQueries({ queryKey: nodeKeys.types() });
      
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
        
        // Invalidate the parent page's detail query to refresh children's backlink_count
        // This is needed because backlink_count is included in the children data
        if (updatedNode.page_id) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.page_id) });
        } else if (updatedNode.parent_id) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(updatedNode.parent_id) });
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
      
      // Optimistically remove the node from any parent's children array
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details() },
        removeNode
      );
      
      // Also update page-content queries
      queryClient.setQueriesData<Node>(
        { queryKey: ['nodes', 'page-content'] },
        removeNode
      );
      
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
      // Invalidate all node lists since content may have changed
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      // Invalidate all backlinks since they may reference the deleted node
      queryClient.invalidateQueries({ queryKey: ['nodes', 'backlinks'] });
      // Invalidate linked references
      queryClient.invalidateQueries({ queryKey: ['nodes', 'linked-refs'] });
      // Invalidate page content as blocks may have been updated
      queryClient.invalidateQueries({ queryKey: ['nodes', 'page-content'] });
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
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'archived'] });
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
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'archived'] });
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
      
      // Helper to insert node at the correct position
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
      
      // Update all detail queries
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details() },
        (oldNode) => {
          if (!oldNode) return oldNode;
          
          let updated = { ...oldNode };
          
          // Remove the moved node if it's in this node's children
          if (updated.children && updated.children.length > 0) {
            const hadNode = updated.children.some(c => c.id === id);
            if (hadNode) {
              updated = {
                ...updated,
                children: removeFromChildren(updated.children),
              };
            }
          }
          
          // Add the moved node to this node's children if this is the new parent
          if (updated.id === parentId && movedNode) {
            const currentChildren = updated.children || [];
            const pos = position ?? currentChildren.length;
            updated = {
              ...updated,
              children: insertAtPosition(currentChildren, movedNode, pos),
            };
          }
          
          return updated;
        }
      );
      
      // Also update page-content queries
      queryClient.setQueriesData<Node>(
        { queryKey: ['nodes', 'page-content'] },
        (oldNode) => {
          if (!oldNode) return oldNode;
          
          let updated = { ...oldNode };
          
          // Remove the moved node from children
          if (updated.children && updated.children.length > 0) {
            updated = {
              ...updated,
              children: removeFromChildren(updated.children),
            };
          }
          
          // Add to this node if it's the new parent
          if (updated.id === parentId && movedNode) {
            const currentChildren = updated.children || [];
            const pos = position ?? currentChildren.length;
            updated = {
              ...updated,
              children: insertAtPosition(currentChildren, movedNode, pos),
            };
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
      // Invalidate ALL detail queries (this covers nodes with include_children: true)
      // The detail queries are used by NodeView to display page content with children
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.details(),
        refetchType: 'active',
      });
      
      // Also invalidate page-content queries for any components using that
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'page-content'],
        refetchType: 'active',
      });
      
      // Invalidate list queries for sidebar updates
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
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
 * Hook to add a type to a node
 */
export function useAddType() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, typeId }: { nodeId: number; typeId: number }) => 
      nodesApi.addType(nodeId, typeId),
    onSuccess: (updatedNode, { nodeId, typeId }) => {
      // Update the node cache with the returned node (which includes the new type)
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId) },
        () => updatedNode
      );
      
      // Invalidate type properties queries to ensure they're refetched
      queryClient.invalidateQueries({ queryKey: propertyKeys.forType(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
      
      // Invalidate the typed nodes list so the new node appears immediately
      queryClient.invalidateQueries({ queryKey: ['nodes', 'by-type', typeId] });
      
      // Also invalidate lists and page content
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
      
      // If this is a block (has parent_id), invalidate the parent's detail and page content
      // so the block's types array is refreshed in the parent's children list
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
 * Hook to remove a type from a node
 */
export function useRemoveType() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, typeId }: { nodeId: number; typeId: number }) => 
      nodesApi.removeType(nodeId, typeId),
    onSuccess: (updatedNode, { nodeId, typeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
      
      // Invalidate the typed nodes list so the removed node disappears immediately
      queryClient.invalidateQueries({ queryKey: ['nodes', 'by-type', typeId] });
      
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
