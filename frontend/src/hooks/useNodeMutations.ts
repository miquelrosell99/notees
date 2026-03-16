/**
 * Node Mutation Hooks
 * 
 * React Query mutation hooks for creating, updating, deleting, and moving nodes.
 * 
 * CACHE ARCHITECTURE NOTE:
 * Daily/monthly/yearly pages are just normal nodes. They have separate cache keys
 * (nodeKeys.daily, nodeKeys.monthly, nodeKeys.yearly) for the "get or create by date"
 * functionality, but these caches do NOT include children. Views use useNode() with
 * include_children: true, which caches under nodeKeys.detail. Therefore, mutations
 * only update the detail cache - we don't need to update the date-based caches.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import type { NodeCreate, NodeUpdate, Node } from '@/types/api';
import { nodeKeys, propertyKeys } from './queryKeys';
import { nodeViewKeys } from './useNodeViews';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import {
  updateNodeByIdImmutable,
  updateNodeInTreeImmutable,
  removeNodeFromTreeImmutable,
  findNodeInRootTree,
} from '@/utils/nodeTree';

// ==================== Helper Functions ====================

// Tree traversal helpers are imported from @/utils/nodeTree:
// - updateNodeByIdImmutable (single root, ref-equality optimized)
// - updateNodeInTreeImmutable (array, ref-equality optimized)
// - removeNodeFromTreeImmutable (array, ref-equality optimized)
// - findNodeInRootTree (single root DFS)

/**
 * Helper to invalidate common node-related caches after mutations.
 * Centralizes the invalidation logic that's duplicated across multiple mutations.
 * 
 * @param queryClient - React Query client
 * @param options - Flags to control which caches to invalidate
 */
function invalidateNodeCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  options: {
    /** Invalidate list queries (sidebar) */
    lists?: boolean;
    /** Invalidate pages queries */
    pages?: boolean;
    /** Invalidate classes queries */
    classes?: boolean;
    /** Invalidate search queries */
    search?: boolean;
    /** Invalidate linked references queries */
    linkedRefs?: boolean;
    /** Invalidate backlinks queries */
    backlinks?: boolean;
    /** Invalidate property backlinks queries */
    propertyBacklinks?: boolean;
    /** Invalidate node view query results */
    queryResults?: boolean;
    /** Invalidate graph data query */
    graph?: boolean;
    /** Invalidate breadcrumbs queries */
    breadcrumbs?: boolean;
    /** Invalidate a specific node's detail cache */
    nodeId?: number;
    /** Whether to actively refetch (default: false for soft invalidation) */
    refetch?: boolean;
  } = {}
) {
  const {
    lists = false,
    pages = false,
    classes = false,
    search = false,
    linkedRefs = false,
    backlinks = false,
    propertyBacklinks = false,
    queryResults = false,
    graph = false,
    breadcrumbs = false,
    nodeId,
    refetch = false,
  } = options;

  const refetchType = refetch ? 'active' : 'none';

  if (lists) {
    queryClient.invalidateQueries({ 
      queryKey: nodeKeys.lists(),
      refetchType,
    });
  }

  if (pages) {
    // Use ['nodes', 'pages'] prefix (without options) so ALL usePages() variants
    // are matched — e.g. usePages({ includeChildren: true }) which uses a different
    // options object and would otherwise be missed.
    queryClient.invalidateQueries({ 
      queryKey: [...nodeKeys.all, 'pages'],
      refetchType,
    });
  }

  if (classes) {
    queryClient.invalidateQueries({ 
      queryKey: nodeKeys.classes(),
      refetchType,
    });
  }

  if (search) {
    queryClient.invalidateQueries({ 
      queryKey: [...nodeKeys.all, 'search'],
      refetchType,
    });
  }

  if (linkedRefs) {
    queryClient.invalidateQueries({ 
      queryKey: ['nodes', 'linked-refs'],
      refetchType,
    });
  }

  if (backlinks) {
    queryClient.invalidateQueries({ 
      queryKey: ['nodes', 'backlinks'],
      refetchType,
    });
  }

  if (propertyBacklinks) {
    queryClient.invalidateQueries({ 
      queryKey: ['nodes', 'property-backlinks'],
      refetchType,
    });
  }

  if (queryResults) {
    queryClient.invalidateQueries({ 
      queryKey: nodeViewKeys.queryResults(),
      refetchType,
    });
  }

  if (graph) {
    queryClient.invalidateQueries({ 
      queryKey: nodeKeys.graph(),
      refetchType,
    });
  }

  if (breadcrumbs) {
    queryClient.invalidateQueries({ 
      queryKey: [...nodeKeys.all, 'breadcrumbs'],
      refetchType,
    });
  }

  if (nodeId !== undefined) {
    queryClient.invalidateQueries({ 
      queryKey: nodeKeys.detailBase(nodeId),
      refetchType,
    });
  }
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
          { queryKey: ['nodes', 'page-content'] },
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
          { queryKey: ['nodes', 'page-content'] },
          (oldNode) => {
            if (!oldNode || oldNode.id !== variables.parent_id) return oldNode;
            return updateChildrenOptional(oldNode);
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
          queryKey: ['pseudo-node-query'],
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
          { queryKey: ['nodes', 'page-content'] },
          (oldNode) => oldNode ? removeOptimistic(oldNode) : oldNode
        );
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

      // Update nodeViews queryResults (flat Node[] arrays used by QueryNodeCollection table/list view)
      const viewQueryQueries = queryCache.findAll({ queryKey: ['nodeViews', 'queryResults'] });
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
        const { children, backlinks, linked_references, properties, classes, tags, ...rest } = updatedNode;
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
        { queryKey: ['nodeViews', 'queryResults'] },
        (oldData) => {
          if (!oldData || !Array.isArray(oldData)) return oldData;
          return oldData.map(n => n.id === updatedNode.id ? mergeUpdate(n) : n);
        }
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
        // If this node is a class, invalidate the classes cache so pages
        // that inherit their icon from this class update immediately
        if (updatedNode.is_class) {
          queryClient.invalidateQueries({
            queryKey: nodeKeys.classes(),
          });
        }
      }
      
      // Invalidate inline classes query to update pill display (only if color changed)
      if (variables.data.color !== undefined) {
        queryClient.invalidateQueries({ 
          queryKey: ['inlineClasses', updatedNode.id],
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
            queryKey: ['nodeViews', 'queryResults'],
            refetchType: 'none', // Soft invalidation
          });
        }
        
        // Also get old parent from cache to invalidate its views
        const cachedNode = queryClient.getQueryData<Node>(nodeKeys.detail(updatedNode.id));
        const oldParentId = cachedNode?.parent_id;
        if (oldParentId && oldParentId !== newParentId) {
          queryClient.invalidateQueries({ 
            queryKey: ['nodeViews', 'queryResults'],
            refetchType: 'none', // Soft invalidation
          });
        }

        // Invalidate breadcrumbs for this node so the breadcrumb bar updates immediately
        queryClient.invalidateQueries({
          queryKey: nodeKeys.breadcrumbs(updatedNode.id),
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
      }
    },
    onError: (error: any, variables) => {
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

// Table class UUID for detecting table cells
const TABLE_CLASS_UUID = '00000000-0000-0000-0001-000000000015';

/**
 * Helper to find a node in the query cache by ID
 * Searches through all detail and page-content queries
 */
function findNodeInCache(queryClient: ReturnType<typeof useQueryClient>, nodeId: number): Node | null {
  const queryCache = queryClient.getQueryCache();
  
  // Search all detail queries
  const detailQueries = queryCache.findAll({ queryKey: nodeKeys.details() });
  for (const query of detailQueries) {
    const data = query.state.data as Node | undefined;
    if (data) {
      const found = findNodeInRootTree(data, nodeId);
      if (found) return found;
    }
  }
  
  // Search all page-content queries
  const pageContentQueries = queryCache.findAll({ queryKey: ['nodes', 'page-content'] });
  for (const query of pageContentQueries) {
    const data = query.state.data as Node | undefined;
    if (data) {
      const found = findNodeInRootTree(data, nodeId);
      if (found) return found;
    }
  }
  
  return null;
}

/**
 * Check if a node has the table class
 */
function hasTableClass(node: Node, allClasses: Node[] | undefined): boolean {
  if (!node.classes || !allClasses) return false;
  
  const tableClass = allClasses.find(c => c.uuid === TABLE_CLASS_UUID);
  if (!tableClass) return false;
  
  return node.classes.includes(tableClass.id);
}

/**
 * Hook to delete a node
 * 
 * When a node is deleted:
 * - All [[Page Name]] links to it are replaced with just "Page Name"
 * - All ((uuid)) links are replaced with the block's text content
 * - Type/tag references are removed from properties but inline text remains
 * - If a page is deleted and it's currently being viewed, navigate to home
 * - If the node is a table cell (grandparent has table class), a replacement cell is created
 */
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
      // Cancel any outgoing refetches to not overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      await queryClient.cancelQueries({ queryKey: ['nodes', 'page-content'] });
      
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
    },
    onSuccess: async ({ deletedNode: _deletedNode, tableCellInfo }, deletedId) => {
      // Check if we're currently viewing the deleted node (page or block)
      // Use dynamic import to avoid circular dependency issues
      const { useAppStore } = await import('@/stores');
      const currentNodeId = useAppStore.getState().currentNodeId;
      
      // If we deleted the node we're currently viewing, navigate to home
      if (currentNodeId === deletedId) {
        // Navigate to home and clear the current node
        useAppStore.setState({ 
          currentNodeId: null,
          mainViewType: 'node'
        });
        window.history.replaceState(null, '', '/');
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
        queryKey: ['nodes', 'page-content'],
        refetchType: 'none',
      });
      // Actively refetch all node view query results so views update immediately
      queryClient.invalidateQueries({ 
        queryKey: ['nodeViews', 'queryResults'],
        refetchType: 'active',
      });
      // Invalidate pseudo-node queries (e.g., All Pages view)
      queryClient.invalidateQueries({ 
        queryKey: ['pseudo-node-query'],
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
        refetchType: 'active',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeViewKeys.queryResults(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({ 
        queryKey: ['pseudo-node-query'],
        refetchType: 'active',
      });
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'archived'],
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.graph(),
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
        refetchType: 'active',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeViewKeys.queryResults(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({ 
        queryKey: ['pseudo-node-query'],
        refetchType: 'active',
      });
      queryClient.invalidateQueries({ 
        queryKey: ['nodes', 'archived'],
        refetchType: 'none',
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.graph(),
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
    onMutate: async ({ nodeId, classId }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      
      // Get the old node - try direct cache first, then search in nested children
      let oldNode = queryClient.getQueryData<Node>(nodeKeys.detailBase(nodeId));
      if (!oldNode) {
        oldNode = findNodeInCache(queryClient, nodeId) ?? undefined;
      }
      
      // Helper to add class to a node
      const addClassToNode = (node: Node): Node => {
        const currentClasses = node.classes ?? [];
        if (currentClasses.includes(classId)) return node;
        return { ...node, classes: [...currentClasses, classId] };
      };
      
      // Optimistically update the cache to add the class immediately
      // First, update any direct cache entries for this node
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? addClassToNode(old) : old
      );
      
      // Also update ALL detail caches that may contain this node as a nested child
      // This handles the focused block view case where children are nested
      const newClasses = [...(oldNode?.classes ?? []), classId];
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details(), exact: false },
        (old) => {
          if (!old?.children) return old;
          const newChildren = updateNodeInTreeImmutable(old.children, nodeId, { classes: newClasses });
          return newChildren !== old.children ? { ...old, children: newChildren } : old;
        }
      );
      
      // Also optimistically update query results so query section list views update immediately
      queryClient.setQueriesData<Node[]>(
        { queryKey: nodeViewKeys.queryResults(), exact: false },
        (old) => {
          if (!old || !Array.isArray(old)) return old;
          return updateNodeInTreeImmutable(old, nodeId, { classes: newClasses });
        }
      );
      
      return { oldNode };
    },
    onError: (_err, { nodeId }, context) => {
      // Rollback on error - restore original classes in all caches
      if (context?.oldNode) {
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(nodeId), exact: false },
          () => context.oldNode
        );
        // Also rollback in all detail caches that may contain this node as a child
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.details(), exact: false },
          (old) => {
            if (!old?.children) return old;
            const newChildren = updateNodeInTreeImmutable(old.children, nodeId, { classes: context.oldNode!.classes });
            return newChildren !== old.children ? { ...old, children: newChildren } : old;
          }
        );
        // Also rollback query results
        queryClient.setQueriesData<Node[]>(
          { queryKey: nodeViewKeys.queryResults(), exact: false },
          (old) => {
            if (!old || !Array.isArray(old)) return old;
            return updateNodeInTreeImmutable(old, nodeId, { classes: context.oldNode!.classes });
          }
        );
      }
    },
    onSuccess: (updatedNode, { nodeId, classId }, context) => {
      const oldNode = context?.oldNode;
      
      // Update cache with the returned node data for immediate UI update
      const classUpdates = {
        classes: updatedNode.classes,
        is_page: updatedNode.is_page,
        is_class: updatedNode.is_class,
        is_daily: updatedNode.is_daily,
        is_monthly: updatedNode.is_monthly,
        is_yearly: updatedNode.is_yearly,
        write_date: updatedNode.write_date,
      };
      
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? { ...old, ...classUpdates } : updatedNode
      );
      
      // Also update ALL detail caches that may contain this node as a nested child
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details(), exact: false },
        (old) => {
          if (!old?.children) return old;
          const newChildren = updateNodeInTreeImmutable(old.children, nodeId, classUpdates);
          return newChildren !== old.children ? { ...old, children: newChildren } : old;
        }
      );
      
      // Invalidate the node query to refetch with all fields (including properties)
      // This ensures the cover section and other property-dependent UI doesn't break
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      
      // GLOBAL: If is_page flag changed, invalidate pages cache
      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
      }
      
      // Always invalidate classes cache so newly created classes are picked up
      // by useResolvedClassDetails (which needs allClasses to resolve class IDs to Node objects).
      // Previously this was conditional on is_class changing, which missed the case where
      // a new class was just created and then added to a node in the same flow.
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      
      // Invalidate search so node.classes arrays in search results stay fresh
      queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'search'] });
      
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
      
      // Invalidate NodeView queries - the backend may create views when certain classes are added
      // (e.g., query class creates a main_content view)
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });
      
      // Invalidate query results so table views and query views update immediately
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      
      // Invalidate graph data since class links changed
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
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
    onMutate: async ({ nodeId, classId }) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      
      // Get the old node - try direct cache first, then search in nested children
      let oldNode = queryClient.getQueryData<Node>(nodeKeys.detailBase(nodeId));
      if (!oldNode) {
        oldNode = findNodeInCache(queryClient, nodeId) ?? undefined;
      }
      
      // Helper to update classes on a node
      const updateClasses = (node: Node): Node => ({
        ...node,
        classes: node.classes?.filter((id: number) => id !== classId) ?? [],
      });
      
      // Optimistically update the cache to remove the class immediately
      queryClient.setQueriesData<Node>(
        { 
          queryKey: nodeKeys.detailBase(nodeId),
          exact: false  // Match all queries starting with this key
        },
        (old) => old ? updateClasses(old) : old
      );
      
      // Also update ALL detail caches that may contain this node as a nested child
      const newClasses = oldNode?.classes?.filter((id: number) => id !== classId) ?? [];
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details(), exact: false },
        (old) => {
          if (!old?.children) return old;
          const newChildren = updateNodeInTreeImmutable(old.children, nodeId, { classes: newClasses });
          return newChildren !== old.children ? { ...old, children: newChildren } : old;
        }
      );
      
      // Also optimistically update query results so query section list views update immediately
      queryClient.setQueriesData<Node[]>(
        { queryKey: nodeViewKeys.queryResults(), exact: false },
        (old) => {
          if (!old || !Array.isArray(old)) return old;
          return updateNodeInTreeImmutable(old, nodeId, { classes: newClasses });
        }
      );
      
      return { oldNode };
    },
    onError: (_err, { nodeId }, context) => {
      // Rollback on error - restore original classes in all caches
      if (context?.oldNode) {
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(nodeId), exact: false },
          () => context.oldNode
        );
        // Also rollback in all detail caches that may contain this node as a child
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.details(), exact: false },
          (old) => {
            if (!old?.children) return old;
            const newChildren = updateNodeInTreeImmutable(old.children, nodeId, { classes: context.oldNode!.classes });
            return newChildren !== old.children ? { ...old, children: newChildren } : old;
          }
        );
        // Also rollback query results
        queryClient.setQueriesData<Node[]>(
          { queryKey: nodeViewKeys.queryResults(), exact: false },
          (old) => {
            if (!old || !Array.isArray(old)) return old;
            return updateNodeInTreeImmutable(old, nodeId, { classes: context.oldNode!.classes });
          }
        );
      }
    },
    onSuccess: (updatedNode, { nodeId, classId }, context) => {
      const oldNode = context?.oldNode;
      
      // Update cache with the returned node data for immediate UI update
      // Only update fields that are in the response to avoid overwriting children/properties
      const classUpdates = {
        classes: updatedNode.classes,
        is_page: updatedNode.is_page,
        is_class: updatedNode.is_class,
        is_daily: updatedNode.is_daily,
        is_monthly: updatedNode.is_monthly,
        is_yearly: updatedNode.is_yearly,
        write_date: updatedNode.write_date,
      };
      
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? { ...old, ...classUpdates } : updatedNode
      );
      
      // Also update ALL detail caches that may contain this node as a nested child
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details(), exact: false },
        (old) => {
          if (!old?.children) return old;
          const newChildren = updateNodeInTreeImmutable(old.children, nodeId, classUpdates);
          return newChildren !== old.children ? { ...old, children: newChildren } : old;
        }
      );
      
      // Also update query results with the server-confirmed class data
      queryClient.setQueriesData<Node[]>(
        { queryKey: nodeViewKeys.queryResults(), exact: false },
        (old) => {
          if (!old || !Array.isArray(old)) return old;
          return updateNodeInTreeImmutable(old, nodeId, classUpdates);
        }
      );
      
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
      
      // GLOBAL: If is_page flag changed, invalidate pages cache
      if (oldNode && oldNode.is_page !== updatedNode.is_page) {
        queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
      }
      
      // GLOBAL: If is_class flag changed, invalidate classes cache
      if (oldNode && oldNode.is_class !== updatedNode.is_class) {
        queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      }
      
      // Invalidate search so node.classes arrays in search results stay fresh
      queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'search'] });
      
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
      
      // Invalidate NodeView queries - the backend may delete views when certain classes are removed
      // (e.g., query class removal deletes the main_content view)
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(nodeId) });
      
      // Invalidate query results so table views and query views update immediately
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      
      // Invalidate graph data since class links changed
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });
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

// ==================== Alias Mutations ====================

/**
 * Hook to add an alias to a node
 */
export function useAddAlias() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, aliasNodeId }: { nodeId: number; aliasNodeId: number }) => 
      nodesApi.addAlias(nodeId, aliasNodeId),
    onSuccess: (updatedNode, { nodeId, aliasNodeId }) => {
      // Update cache directly with the returned node (includes updated aliases array)
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.detailBase(nodeId), exact: false },
        (old) => old ? { ...old, aliases: updatedNode.aliases, write_date: updatedNode.write_date } : updatedNode
      );
      
      // Also update nested caches that may contain this node
      queryClient.setQueriesData<Node>(
        { queryKey: nodeKeys.details(), exact: false },
        (old) => {
          if (!old || old.id !== nodeId) return old;
          return { ...old, aliases: updatedNode.aliases, write_date: updatedNode.write_date };
        }
      );
      
      // Invalidate both the main node and the alias node caches with active refetch
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.detailBase(nodeId),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pageContent(nodeId),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.detailBase(aliasNodeId),
        refetchType: 'active'
      });
      // Also invalidate linked references since aliases affect backlinks
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.linkedRefs(nodeId),
        refetchType: 'active'
      });
      // Invalidate pages list (aliased_id changed on the alias node)
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pages(),
        refetchType: 'active'
      });
    },
  });
}

/**
 * Hook to remove an alias from a node
 */
export function useRemoveAlias() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, aliasId }: { nodeId: number; aliasId: number }) => 
      nodesApi.removeAlias(nodeId, aliasId),
    onSuccess: (_, { nodeId, aliasId }) => {
      // Invalidate with active refetch to ensure changes show immediately
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.detailBase(nodeId),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pageContent(nodeId),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.detailBase(aliasId),
        refetchType: 'active'
      });
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.linkedRefs(nodeId),
        refetchType: 'active'
      });
      // Invalidate pages list (aliased_id cleared on the alias node)
      queryClient.invalidateQueries({ 
        queryKey: nodeKeys.pages(),
        refetchType: 'active'
      });
    },
  });
}
