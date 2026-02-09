/**
 * Node Query Hooks
 * 
 * Read-only React Query hooks for fetching node data.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';

// ==================== Helper Functions ====================

/**
 * Format date to YYYY-MM-DD in local timezone (avoids UTC conversion issues)
 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
    placeholderData: [],
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
  const result = useQuery({
    queryKey: nodeKeys.detail(id ?? 0, options),
    queryFn: () => nodesApi.getNode(id!, options),
    enabled: !!id,
    // IMPORTANT: structuralSharing must be disabled for nodes with nested children.
    // React Query's structural sharing compares objects by reference and can preserve
    // stale references in deeply nested structures (e.g., page -> block -> child-block).
    // When optimistic updates modify a child-child block, the parent and grandparent
    // need new references for React to detect the change and re-render.
    // Without this, Enter/Backspace at deep nesting levels won't update the UI.
    structuralSharing: false,
    retry: (failureCount, error) => {
      // Don't retry on 404 - node has been deleted
      if (isAxiosError(error) && error.response?.status === 404) {
        return false;
      }
      return failureCount < 1;
    },
  });
  
  // If we get a 404 for the currently viewed node, navigate to home
  // Note: We need to use dynamic import here to avoid circular dependency
  if (result.error && isAxiosError(result.error) && result.error.response?.status === 404 && id) {
    import('@/stores').then(({ useNodesStore }) => {
      const currentNodeId = useNodesStore.getState().currentNodeId;
      if (currentNodeId === id) {
        // Node was deleted, navigate away
        useNodesStore.setState({ 
          currentNodeId: null,
          mainViewType: 'node'
        });
        window.history.replaceState(null, '', '/');
      }
    });
  }
  
  return result;
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
    // IMPORTANT: See useNode comment - structuralSharing must be disabled for nested children.
    structuralSharing: false,
  });
}

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
    placeholderData: [],
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
    placeholderData: [],
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
    placeholderData: [],
  });
}

/**
 * Hook to fetch all existing daily pages (without creating new ones).
 * Both useExistingDailyPages and useDailyPages share the same query key
 * to avoid duplicate requests to GET /nodes/daily/list.
 */
export function useExistingDailyPages() {
  return useQuery({
    queryKey: nodeKeys.dailyList(),
    queryFn: () => nodesApi.listDailyPages(),
    placeholderData: [], // Use placeholderData instead of initialData to allow fetching
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
      queryClient.invalidateQueries({ queryKey: nodeKeys.dailyList() });
      return node;
    },
    // IMPORTANT: See useNode comment - structuralSharing must be disabled for nested children.
    structuralSharing: false,
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
    // IMPORTANT: See useNode comment - structuralSharing must be disabled for nested children.
    structuralSharing: false,
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
    // IMPORTANT: See useNode comment - structuralSharing must be disabled for nested children.
    structuralSharing: false,
  });
}

/**
 * Hook to fetch all pages
 * @param options.includeChildren - Include nested child pages
 * @param options.rootOnly - Only return root pages (no parent)
 */
export function usePages(options?: { includeChildren?: boolean; rootOnly?: boolean }) {
  const { includeChildren = false, rootOnly = false } = options ?? {};
  return useQuery({
    queryKey: nodeKeys.pages({ includeChildren, rootOnly }),
    queryFn: () => nodesApi.listNodes({ 
      pages_only: true, 
      include_children: includeChildren,
      root_only: rootOnly,
    }),
    placeholderData: [],
  });
}

/**
 * Hook to search nodes
 * @param query - Search query string
 * @param classFilters - Optional comma-separated class IDs to filter results
 */
export function useSearch(query: string, classFilters?: string) {
  return useQuery({
    queryKey: nodeKeys.search(query, classFilters),
    queryFn: () => nodesApi.searchNodes(query, classFilters),
    enabled: query.length > 0,
    placeholderData: [],
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
    placeholderData: [],
  });
}

/**
 * Hook to fetch all classes (nodes that can be used as classes)
 * Classes are essentially pages that can categorize other nodes
 */
export function useClasses() {
  return useQuery({
    queryKey: nodeKeys.classes(),
    queryFn: () => nodesApi.listClasses(),
    placeholderData: [],
  });
}

/**
 * Hook to search for classes
 */
export function useSearchClasses(query: string) {
  return useQuery({
    queryKey: [...nodeKeys.classes(), 'search', query] as const,
    queryFn: () => nodesApi.searchClasses(query),
    enabled: query.length > 0,
    placeholderData: [],
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
    placeholderData: [],
  });
}

/**
 * Hook to fetch tasks
 */
export function useTasks(includeComplete = false) {
  return useQuery({
    queryKey: nodeKeys.tasks(includeComplete),
    queryFn: () => nodesApi.listTasks(includeComplete),
    placeholderData: [],
  });
}

/**
 * Hook to fetch archived pages
 */
export function useArchivedPages() {
  return useQuery({
    queryKey: ['nodes', 'archived'],
    queryFn: () => nodesApi.getArchivedPages(),
    placeholderData: [],
  });
}

/**
 * Hook to fetch nodes with a specific class
 */
export function useNodesWithClass(classId: number | null) {
  return useQuery({
    queryKey: ['nodes', 'by-class', classId],
    queryFn: () => nodesApi.getNodesWithClass(classId!),
    enabled: !!classId,
    placeholderData: [],
    select: (nodes) => nodes,  // Returns Node[]
  });
}

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
