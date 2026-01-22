/**
 * React Query hooks for nodes API
 * 
 * Uses the node-centric architecture where everything is a node.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import * as propertiesApi from '@/api/properties';
import type { NodeCreate, NodeUpdate, PropertyCreate, Node } from '@/types/api';

// ==================== Query Keys ====================

export const nodeKeys = {
  all: ['nodes'] as const,
  lists: () => [...nodeKeys.all, 'list'] as const,
  list: (filters: { pages_only?: boolean; parent_id?: number; tag_id?: number }) => 
    [...nodeKeys.lists(), filters] as const,
  details: () => [...nodeKeys.all, 'detail'] as const,
  detail: (id: number, options?: { include_children?: boolean; include_backlinks?: boolean; include_properties?: boolean }) => 
    [...nodeKeys.details(), id, options ?? {}] as const,
  // Use this for cache invalidation - matches all detail queries for a node regardless of options
  detailBase: (id: number) => [...nodeKeys.details(), id] as const,
  byUuid: (uuid: string) => [...nodeKeys.all, 'uuid', uuid] as const,
  pageContent: (id: number) => [...nodeKeys.all, 'page-content', id] as const,
  backlinks: (id: number) => [...nodeKeys.all, 'backlinks', id] as const,
  linkedRefs: (id: number) => [...nodeKeys.all, 'linked-refs', id] as const,
  propertyBacklinks: (id: number) => [...nodeKeys.all, 'property-backlinks', id] as const,
  daily: (date: string) => [...nodeKeys.all, 'daily', date] as const,
  monthly: (year: number, month: number) => [...nodeKeys.all, 'monthly', year, month] as const,
  yearly: (year: number) => [...nodeKeys.all, 'yearly', year] as const,
  search: (query: string) => [...nodeKeys.all, 'search', query] as const,
  pages: () => [...nodeKeys.all, 'pages'] as const,
  tags: () => [...nodeKeys.all, 'tags'] as const,
  types: () => [...nodeKeys.all, 'types'] as const,
  tasks: (includeComplete?: boolean) => [...nodeKeys.all, 'tasks', { includeComplete }] as const,
  graph: () => [...nodeKeys.all, 'graph'] as const,
  
  // PERFORMANCE: Metadata-only keys for lightweight queries
  // These are separate from detail queries to avoid cache pollution
  metadata: (id: number) => [...nodeKeys.all, 'metadata', id] as const,
  childrenOnly: (id: number) => [...nodeKeys.all, 'children-only', id] as const,
  breadcrumbs: (id: number) => [...nodeKeys.all, 'breadcrumbs', id] as const,
};

export const propertyKeys = {
  all: ['properties'] as const,
  lists: () => [...propertyKeys.all, 'list'] as const,
  list: (type?: string) => [...propertyKeys.lists(), { type }] as const,
  detail: (id: number) => [...propertyKeys.all, 'detail', id] as const,
  forTag: (tagId: number) => [...propertyKeys.all, 'tag', tagId] as const,
  forType: (typeId: number) => [...propertyKeys.all, 'type', typeId] as const,
  forTypeInherited: (typeId: number) => [...propertyKeys.all, 'type-inherited', typeId] as const,
  typeExtends: (typeId: number) => [...propertyKeys.all, 'type-extends', typeId] as const,
};

// ==================== Node Queries ====================

/**
 * Hook to fetch all nodes
 * Pass undefined to disable the query (useful for conditional fetching)
 */
export function useNodes(filters?: { pages_only?: boolean; parent_id?: number; tag_id?: number } | null) {
  return useQuery({
    queryKey: nodeKeys.list(filters ?? {}),
    queryFn: () => nodesApi.listNodes(filters ?? undefined),
    enabled: filters !== null,
  });
}

/**
 * Hook to fetch a single node by ID
 */
export function useNode(
  id: number | null, 
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
    include_properties?: boolean;
  }
) {
  return useQuery({
    queryKey: nodeKeys.detail(id ?? 0, options),
    queryFn: () => nodesApi.getNode(id!, options),
    enabled: !!id,
  });
}

/**
 * PERFORMANCE: Metadata-only node fetch
 * 
 * Loads minimal node data without children, backlinks, or properties.
 * Use for breadcrumbs, link previews, and other lightweight displays.
 * 
 * This uses a separate cache key to avoid polluting the full detail cache.
 */
export function useNodeMetadata(id: number | null) {
  return useQuery({
    queryKey: nodeKeys.metadata(id ?? 0),
    queryFn: () => nodesApi.getNode(id!, {
      include_children: false,
      include_backlinks: false,
      include_properties: false,
    }),
    enabled: !!id,
    // Metadata is stable, cache longer
    staleTime: 1000 * 60 * 10, // 10 minutes
  });
}

/**
 * PERFORMANCE: Children-only fetch
 * 
 * Loads just the direct children of a node, useful for lazy-loading tree views.
 * Results are normalized into the main node cache on success.
 */
export function useNodeChildren(parentId: number | null) {
  return useQuery({
    queryKey: nodeKeys.childrenOnly(parentId ?? 0),
    queryFn: async () => {
      const parent = await nodesApi.getNode(parentId!, { include_children: true });
      return parent.children ?? [];
    },
    enabled: !!parentId,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Hook to fetch a node by UUID
 */
export function useNodeByUuid(
  uuid: string | null,
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
  }
) {
  return useQuery({
    queryKey: nodeKeys.byUuid(uuid ?? ''),
    queryFn: () => nodesApi.getNodeByUuid(uuid!, options),
    enabled: !!uuid,
  });
}

/**
 * Hook to fetch page content (blocks, properties, backlinks)
 */
export function usePageContent(pageId: number | null) {
  return useQuery({
    queryKey: nodeKeys.pageContent(pageId ?? 0),
    queryFn: () => nodesApi.getPageContent(pageId!),
    enabled: !!pageId,
  });
}

/**
 * Alias for usePageContent (backward compatibility)
 */
export const usePage = usePageContent;

/**
 * Hook to fetch graph data for visualization
 */
export function useGraphData() {
  return useQuery({
    queryKey: nodeKeys.graph(),
    queryFn: () => nodesApi.getGraphData(),
  });
}

/**
 * Hook to fetch backlinks for a node
 */
export function useBacklinks(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.backlinks(nodeId ?? 0),
    queryFn: () => nodesApi.getBacklinks(nodeId!),
    enabled: !!nodeId,
  });
}

/**
 * Hook to fetch linked references with context
 */
export function useLinkedReferences(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.linkedRefs(nodeId ?? 0),
    queryFn: () => nodesApi.getLinkedReferences(nodeId!),
    enabled: !!nodeId,
  });
}

/**
 * Hook to fetch property backlinks (pages referencing via date/node properties)
 */
export function usePropertyBacklinks(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.propertyBacklinks(nodeId ?? 0),
    queryFn: () => nodesApi.getPropertyBacklinks(nodeId!),
    enabled: !!nodeId,
  });
}

/**
 * Format date to YYYY-MM-DD in local timezone (avoids UTC conversion issues)
 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Hook to fetch all existing daily pages (without creating new ones)
 */
export function useExistingDailyPages() {
  return useQuery({
    queryKey: [...nodeKeys.all, 'daily-pages'],
    queryFn: () => nodesApi.listDailyPages(),
  });
}

/**
 * Hook to fetch/create daily note
 * 
 * Note: This can create new daily, monthly, and yearly pages.
 * We invalidate the pages cache to ensure new pages appear in All Pages view.
 */
export function useDailyNote(date?: Date) {
  const queryClient = useQueryClient();
  const dateStr = formatLocalDate(date ?? new Date());
  
  return useQuery({
    queryKey: nodeKeys.daily(dateStr),
    queryFn: async () => {
      const node = await nodesApi.getOrCreateDaily(dateStr);
      // Also populate the detail cache so mutations can update it
      queryClient.setQueryData(nodeKeys.detail(node.id, { include_children: true }), node);
      // Invalidate pages list since this might have created new day/month/year pages
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      return node;
    },
  });
}

/**
 * Hook to fetch today's note
 */
export function useTodayNote() {
  return useDailyNote(new Date());
}

/**
 * Hook to fetch/create monthly note
 * 
 * Note: This can create new monthly and yearly pages.
 * We invalidate the pages cache to ensure new pages appear in All Pages view.
 */
export function useMonthlyNote(year: number, month: number) {
  const queryClient = useQueryClient();
  
  return useQuery({
    queryKey: nodeKeys.monthly(year, month),
    queryFn: async () => {
      const node = await nodesApi.getOrCreateMonthly(year, month);
      // Invalidate pages list since this might have created new month/year pages
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      return node;
    },
    enabled: year >= 1900 && month >= 1 && month <= 12,
  });
}

/**
 * Hook to fetch/create yearly note
 * 
 * Note: This can create a new yearly page.
 * We invalidate the pages cache to ensure new pages appear in All Pages view.
 */
export function useYearlyNote(year: number) {
  const queryClient = useQueryClient();
  
  return useQuery({
    queryKey: nodeKeys.yearly(year),
    queryFn: async () => {
      const node = await nodesApi.getOrCreateYearly(year);
      // Invalidate pages list since this might have created a new year page
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      return node;
    },
    enabled: year >= 1900,
  });
}

/**
 * Alias for useTodayNote (backward compatibility)
 */
export const useTodayPage = useTodayNote;

/**
 * Hook to fetch all pages
 */
export function usePages() {
  return useQuery({
    queryKey: nodeKeys.pages(),
    queryFn: () => nodesApi.listNodes({ pages_only: true }),
  });
}

/**
 * Hook to search nodes
 */
export function useSearch(query: string) {
  return useQuery({
    queryKey: nodeKeys.search(query),
    queryFn: () => nodesApi.searchNodes(query),
    enabled: query.length > 0,
  });
}

/**
 * Hook to fetch all tags (pages that can be used as tags)
 * Tags are regular pages (not type definitions) that users link with #
 */
export function useTags() {
  return useQuery({
    queryKey: nodeKeys.tags(),
    queryFn: () => nodesApi.listNodes({ pages_only: true }),
  });
}

/**
 * Hook to fetch all types (nodes that can be used as types)
 * Types are essentially pages that can categorize other nodes
 */
export function useTypes() {
  return useQuery({
    queryKey: nodeKeys.types(),
    queryFn: () => nodesApi.listTypes(),
  });
}

/**
 * Hook to search for types
 */
export function useSearchTypes(query: string) {
  return useQuery({
    queryKey: [...nodeKeys.types(), 'search', query] as const,
    queryFn: () => nodesApi.searchTypes(query),
    enabled: query.length > 0,
  });
}

/**
 * Hook to fetch nodes by tag
 */
export function useNodesByTag(tagId: number | null) {
  return useQuery({
    queryKey: nodeKeys.list({ tag_id: tagId ?? 0 }),
    queryFn: () => nodesApi.listNodes({ tag_id: tagId! }),
    enabled: !!tagId,
  });
}

/**
 * Hook to fetch tasks
 */
export function useTasks(includeComplete = false) {
  return useQuery({
    queryKey: nodeKeys.tasks(includeComplete),
    queryFn: () => nodesApi.listTasks(includeComplete),
  });
}

// ==================== Node Mutations ====================

/**
 * Helper to update daily cache entries.
 * Daily pages are just nodes, but they have a separate cache for the useDailyNote hook.
 * This helper ensures both caches stay in sync during optimistic updates.
 * 
 * @param queryClient - The query client instance
 * @param updater - Function that updates a node tree, applied to all daily cache entries
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
 */
function updateNodeById(node: Node, targetId: number, updater: (n: Node) => Node): Node {
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
        const updateChildren = (oldNode: Node | undefined): Node | undefined => {
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
        
        // Update the parent node's detail cache (matches any options)
        queryClient.setQueriesData<Node>(
          { queryKey: nodeKeys.detailBase(parentId) },
          updateChildren
        );
        
        // Update the parent's page content cache if it exists
        queryClient.setQueriesData<Node>(
          { queryKey: ['nodes', 'page-content'] },
          (oldNode) => {
            if (!oldNode || oldNode.id !== parentId) return oldNode;
            return updateChildren(oldNode);
          }
        );
        
        // Update daily cache (daily pages have a separate cache key)
        updateDailyCache(queryClient, (page) => 
          updateNodeById(page, parentId, updateChildren)
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
    onSuccess: (deletedNode, deletedId) => {
      // Check if we're currently viewing the deleted node (page or block)
      // Dynamic import to avoid circular dependency
      import('@/stores').then(({ useNodesStore }) => {
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
      });
      
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
 * Hook to fetch archived pages
 */
export function useArchivedPages() {
  return useQuery({
    queryKey: ['nodes', 'archived'],
    queryFn: () => nodesApi.getArchivedPages(),
  });
}

/**
 * Hook to fetch nodes with a specific type
 */
export function useNodesWithType(typeId: number | null) {
  return useQuery({
    queryKey: ['nodes', 'by-type', typeId],
    queryFn: () => nodesApi.getNodesWithType(typeId!),
    enabled: !!typeId,
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
      let oldParentId: number | null = null;
      
      // Search through all cached detail queries to find the node
      const detailQueries = queryClient.getQueriesData<Node>({ queryKey: nodeKeys.details() });
      for (const [, data] of detailQueries) {
        if (!data) continue;
        // Check if this is the node itself
        if (data.id === id) {
          movedNode = data;
          oldParentId = data.parent_id;
          break;
        }
        // Check if the node is in children
        const findInChildren = (node: Node): Node | null => {
          if (node.children) {
            for (const child of node.children) {
              if (child.id === id) {
                oldParentId = node.id;
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
        let updated = {
          ...page,
          children: page.children ? removeFromChildren(page.children) : [],
        };
        
        // Insert at the correct parent using the helper
        if (movedNode) {
          updated = updateNodeById(updated, parentId!, (parent) => {
            const currentChildren = parent.children || [];
            const pos = position ?? currentChildren.length;
            return {
              ...parent,
              children: insertAtPosition(currentChildren, movedNode, pos),
            };
          });
        }
        
        return updated;
      });
    },
    onSuccess: (movedNode, { parentId }) => {
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
 * Hook to add a tag to a node (tags are implemented as types)
 */
export function useAddTag() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, tagId }: { nodeId: number; tagId: number }) => 
      nodesApi.addType(nodeId, tagId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
    },
  });
}

/**
 * Hook to remove a tag from a node (tags are implemented as types)
 */
export function useRemoveTag() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, tagId }: { nodeId: number; tagId: number }) => 
      nodesApi.removeType(nodeId, tagId),
    onSuccess: (updatedNode, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
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
    onSuccess: (updatedNode, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
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

// ==================== Property Queries ====================

/**
 * Hook to fetch all properties
 */
export function useProperties() {
  return useQuery({
    queryKey: propertyKeys.list(),
    queryFn: () => propertiesApi.listProperties(),
  });
}

/**
 * Hook to fetch a single property
 */
export function useProperty(id: number | null) {
  return useQuery({
    queryKey: propertyKeys.detail(id ?? 0),
    queryFn: () => propertiesApi.getProperty(id!),
    enabled: !!id,
  });
}

// ==================== Property Mutations ====================

/**
 * Hook to create a property
 */
export function useCreateProperty() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: PropertyCreate) => 
      propertiesApi.createProperty(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

/**
 * Hook to update a property
 */
export function useUpdateProperty() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; icon?: string } }) => 
      propertiesApi.updateProperty(id, data),
    onSuccess: (updated) => {
      queryClient.setQueryData(propertyKeys.detail(updated.id), updated);
      queryClient.invalidateQueries({ queryKey: propertyKeys.lists() });
    },
  });
}

// ==================== Type Properties (for Types/Classes) ====================

/**
 * Hook to fetch properties for a type/class
 */
export function useTypeProperties(typeId: number | null, includeInherited: boolean = false) {
  return useQuery({
    queryKey: includeInherited 
      ? propertyKeys.forTypeInherited(typeId ?? 0)
      : propertyKeys.forType(typeId ?? 0),
    queryFn: () => propertiesApi.getTypeProperties(typeId!, includeInherited),
    enabled: !!typeId,
  });
}

/**
 * Hook to fetch types that a type extends (parents)
 */
export function useTypeExtends(typeId: number | null) {
  return useQuery({
    queryKey: propertyKeys.typeExtends(typeId ?? 0),
    queryFn: () => propertiesApi.getTypeExtends(typeId!),
    enabled: !!typeId,
  });
}

/**
 * Hook to add property to type/class
 */
export function useAddPropertyToType() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ typeId, propertyId }: { typeId: number; propertyId: number }) => 
      propertiesApi.addTypeProperty(typeId, propertyId),
    onSuccess: (_, { typeId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forType(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
    },
  });
}

/**
 * Hook to remove property from type/class
 */
export function useRemovePropertyFromType() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ typeId, propertyId }: { typeId: number; propertyId: number }) => 
      propertiesApi.removeTypeProperty(typeId, propertyId),
    onSuccess: (_, { typeId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.forType(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
    },
  });
}

/**
 * Hook to add type extension (inheritance)
 */
export function useAddTypeExtends() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ typeId, extendsTypeId }: { typeId: number; extendsTypeId: number }) => 
      propertiesApi.addTypeExtends(typeId, extendsTypeId),
    onSuccess: (_, { typeId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.typeExtends(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
    },
  });
}

/**
 * Hook to remove type extension (inheritance)
 */
export function useRemoveTypeExtends() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ typeId, extendsTypeId }: { typeId: number; extendsTypeId: number }) => 
      propertiesApi.removeTypeExtends(typeId, extendsTypeId),
    onSuccess: (_, { typeId }) => {
      queryClient.invalidateQueries({ queryKey: propertyKeys.typeExtends(typeId) });
      queryClient.invalidateQueries({ queryKey: propertyKeys.forTypeInherited(typeId) });
    },
  });
}

/**
 * Hook to set node property value
 * When value is null, removes the property instead of setting it to null
 */
export function useSetNodeProperty() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ nodeId, propertyId, value }: { nodeId: number; propertyId: number; value: unknown }) => {
      // If value is null, remove the property instead of setting it
      if (value === null) {
        return nodesApi.removeProperty(nodeId, propertyId);
      }
      return nodesApi.setProperty(nodeId, propertyId, value);
    },
    onSuccess: (_, { nodeId }) => {
      // Invalidate both detail and page content queries since properties
      // are used in page headers (cover, banner) and node details
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(nodeId) });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContent(nodeId) });
    },
    onError: (error, variables) => {
      console.error(`Failed to set property ${variables.propertyId} on node ${variables.nodeId}:`, error);
    },
  });
}

/**
 * Hook to get nodes that have a specific property using the property ID
 */
export function useNodesWithProperty(propertyId: number | null) {
  return useQuery({
    queryKey: ['property-nodes', propertyId],
    queryFn: async () => {
      if (!propertyId) return [];
      // Use the dedicated API endpoint that queries by property ID
      const { getNodesWithProperty } = await import('@/api/properties');
      const response = await getNodesWithProperty(propertyId);
      
      // Convert API response to Node format
      return response.nodes.map(item => ({
        id: item.node_id,
        uuid: item.node_uuid,
        name: item.node_name,
        icon: item.node_icon,
        color: item.node_color,
        parent_id: item.parent_id,
        page_id: item.page_id,
        is_page: item.is_page,
        is_type: item.is_type,
        sequence: 0,
        collapsed: false,
        active: true,
        create_date: item.create_date,
        write_date: item.write_date,
      } as Node));
    },
    enabled: !!propertyId,
    staleTime: 30000,
  });
}

// ==================== Comments Queries ====================

export const commentKeys = {
  all: ['comments'] as const,
  forNode: (nodeId: number) => [...commentKeys.all, 'node', nodeId] as const,
  count: (nodeId: number) => [...commentKeys.all, 'count', nodeId] as const,
};

/**
 * Hook to fetch comments for a node
 */
export function useComments(nodeId: number | null) {
  return useQuery({
    queryKey: commentKeys.forNode(nodeId ?? 0),
    queryFn: () => nodesApi.getComments(nodeId!),
    enabled: !!nodeId,
  });
}

/**
 * Hook to fetch comment count for a node (useful for showing indicators)
 */
export function useCommentCount(nodeId: number | null) {
  return useQuery({
    queryKey: commentKeys.count(nodeId ?? 0),
    queryFn: () => nodesApi.getCommentCount(nodeId!),
    enabled: !!nodeId,
    staleTime: 30000, // Cache for 30 seconds
  });
}

// ==================== Comments Mutations ====================

/**
 * Hook to create a comment on a node
 */
export function useCreateComment() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, name }: { nodeId: number; name: string }) => 
      nodesApi.createComment(nodeId, name),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeId) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeId) });
    },
  });
}

/**
 * Hook to delete a comment from a node
 */
export function useDeleteComment() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, commentId }: { nodeId: number; commentId: number }) => 
      nodesApi.deleteComment(nodeId, commentId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: commentKeys.forNode(nodeId) });
      queryClient.invalidateQueries({ queryKey: commentKeys.count(nodeId) });
    },
  });
}

// ==================== Activity Tracking ====================
import * as activityApi from '@/api/activity';

export const activityKeys = {
  all: ['activity'] as const,
  forNode: (nodeId: number) => [...activityKeys.all, 'node', nodeId] as const,
  linkClicks: (sourceNodeId: number) => [...activityKeys.all, 'link-clicks', sourceNodeId] as const,
  linkClick: (sourceNodeId: number, targetNodeId: number) => [...activityKeys.all, 'link-click', sourceNodeId, targetNodeId] as const,
};

/**
 * Hook to fetch activity log for a node
 */
export function useNodeActivity(nodeId: number | null, limit = 50) {
  return useQuery({
    queryKey: activityKeys.forNode(nodeId ?? 0),
    queryFn: () => activityApi.getNodeActivity(nodeId!, limit),
    enabled: !!nodeId,
  });
}

/**
 * Hook to create a new activity entry
 */
export function useCreateNodeActivity() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: activityApi.NodeActivityCreate) => activityApi.createNodeActivity(data),
    onSuccess: (_, { node_id }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.forNode(node_id) });
    },
  });
}

/**
 * Hook to delete an activity entry
 */
export function useDeleteNodeActivity() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ nodeId, activityId }: { nodeId: number; activityId: number }) => 
      activityApi.deleteNodeActivity(nodeId, activityId),
    onSuccess: (_, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.forNode(nodeId) });
    },
  });
}

// ==================== Link Click Tracking ====================

/**
 * Hook to fetch all link click counts from a source node
 */
export function useLinkClicks(sourceNodeId: number | null) {
  return useQuery({
    queryKey: activityKeys.linkClicks(sourceNodeId ?? 0),
    queryFn: () => activityApi.getLinkClicks(sourceNodeId!),
    enabled: !!sourceNodeId,
    staleTime: 60000, // Cache for 1 minute
  });
}

/**
 * Hook to fetch click count for a specific link
 */
export function useLinkClick(sourceNodeId: number | null, targetNodeId: number | null) {
  return useQuery({
    queryKey: activityKeys.linkClick(sourceNodeId ?? 0, targetNodeId ?? 0),
    queryFn: () => activityApi.getLinkClick(sourceNodeId!, targetNodeId!),
    enabled: !!sourceNodeId && !!targetNodeId,
    staleTime: 60000,
  });
}

/**
 * Hook to track a link click
 */
export function useTrackLinkClick() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ sourceNodeId, targetNodeId }: { sourceNodeId: number; targetNodeId: number }) => 
      activityApi.trackLinkClick(sourceNodeId, targetNodeId),
    onSuccess: (_, { sourceNodeId, targetNodeId }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.linkClicks(sourceNodeId) });
      queryClient.invalidateQueries({ queryKey: activityKeys.linkClick(sourceNodeId, targetNodeId) });
    },
  });
}

/**
 * Hook to reset link click counter
 */
export function useResetLinkClick() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ sourceNodeId, targetNodeId }: { sourceNodeId: number; targetNodeId: number }) => 
      activityApi.resetLinkClick(sourceNodeId, targetNodeId),
    onSuccess: (_, { sourceNodeId, targetNodeId }) => {
      queryClient.invalidateQueries({ queryKey: activityKeys.linkClicks(sourceNodeId) });
      queryClient.invalidateQueries({ queryKey: activityKeys.linkClick(sourceNodeId, targetNodeId) });
    },
  });
}

// ==================== Text Links (with is_tag info) ====================

/**
 * Hook to fetch text links for a node with is_tag info
 */
export function useTextLinks(nodeId: number | null) {
  return useQuery({
    queryKey: ['textLinks', nodeId],
    queryFn: () => nodesApi.getTextLinks(nodeId!),
    enabled: !!nodeId,
    staleTime: 30000,
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
