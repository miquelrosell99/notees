/**
 * Node Query Hooks
 * 
 * Read-only React Query hooks for fetching node data.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { isApiError } from '@/api/client';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import type { Node, PaginatedResponse } from '@/types/api';

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

/**
 * Recursively search a node tree for a node by ID.
 * Returns the matching node or undefined.
 */
function findNodeInTree(root: Node, targetId: number): Node | undefined {
  if (root.id === targetId) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeInTree(child, targetId);
      if (found) return found;
    }
  }
  return undefined;
}

// ==================== Node Queries ====================

/**
 * Hook to fetch all nodes
 * Pass undefined to disable the query (useful for conditional fetching)
 */
export function useNodes(filters?: { pages_only?: boolean; parent_id?: number; tag_id?: number; page_size?: number } | null) {
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
    meta?: Record<string, unknown>;
    staleTime?: number;
  }
) {
  const queryClient = useQueryClient();
  const { meta, staleTime, ...apiOptions } = options || {};
  const result = useQuery({
    queryKey: nodeKeys.detail(id ?? 0, apiOptions),
    queryFn: () => nodesApi.getNode(id!, apiOptions),
    enabled: !!id,
    meta,
    staleTime,
    // Provide data from existing parent caches while the fresh fetch loads.
    // This prevents showing empty content when navigating to a block's
    // focused view before its content save has completed on the server.
    placeholderData: () => {
      if (!id) return undefined;
      const queryCache = queryClient.getQueryCache();
      for (const query of queryCache.findAll({ queryKey: nodeKeys.details() })) {
        const data = query.state.data as Node | undefined;
        if (data) {
          const found = findNodeInTree(data, id);
          if (found) return found;
        }
      }
      return undefined;
    },

    retry: (failureCount, error) => {
      // Don't retry on 404 - node has been deleted
      if (isApiError(error) && error.response?.status === 404) {
        return false;
      }
      return failureCount < 1;
    },
  });
  
  // If we get a 404 for the currently viewed node, navigate to home
  // Wrapped in useEffect to avoid scheduling state updates during render,
  // which can trigger "Maximum update depth exceeded" loops.
  useEffect(() => {
    if (result.error && isApiError(result.error) && result.error.response?.status === 404 && id) {
      import('@/stores').then(({ useNavigationStore }) => {
        const currentNodeId = useNavigationStore.getState().currentNodeId;
        if (currentNodeId === id) {
          // Node was deleted, navigate away
          useNavigationStore.setState({
            currentNodeId: null,
            mainViewType: 'node'
          });
          // Navigate to workspace home (extract workspace UUID from current path)
          const wsMatch = window.location.pathname.match(/^\/([0-9a-f-]{36})/);
          window.history.replaceState(null, '', wsMatch ? `/${wsMatch[1]}` : '/');
        }
      });
    }
  }, [result.error, id]);

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
    meta?: Record<string, unknown>;
  }
) {
  const { meta, ...apiOptions } = options || {};
  return useQuery({
    queryKey: nodeKeys.byUuid(uuid ?? ''),
    queryFn: () => nodesApi.getNodeByUuid(uuid!, apiOptions),
    enabled: !!uuid,
    meta,
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
 * Hook to fetch workspace data for visualization
 * @deprecated Use useGraphNodes + useGraphLinks separately instead
 */
export function useGraphData(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: nodeKeys.graph(),
    queryFn: () => nodesApi.getWorkspaceData(),
    enabled: options?.enabled ?? true,
  });
}

/**
 * Hook to fetch workspace nodes only (without links).
 * Use with useGraphLinks for efficient data loading.
 */
export function useGraphNodes(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: nodeKeys.graphNodes(),
    queryFn: () => nodesApi.getGraphNodes(),
    enabled: options?.enabled ?? true,
    select: (data) => data.items,
  });
}

/**
 * Hook to fetch links between a specific set of node IDs.
 * @param scope - "between" (default): both ends must be in the set.
 *               "touching": at least one end in the set (for neighborhood discovery).
 */
export function useGraphLinks(
  nodeIds: number[],
  options?: { enabled?: boolean; scope?: 'between' | 'touching'; cooccurrence?: boolean; contextNodeId?: number | null }
) {
  const scope = options?.scope ?? 'between';
  const cooccurrence = options?.cooccurrence ?? false;
  const contextNodeId = options?.contextNodeId ?? null;
  return useQuery({
    queryKey: nodeKeys.graphLinks(nodeIds, scope, cooccurrence, contextNodeId),
    queryFn: () => nodesApi.getLinksForNodes(nodeIds, scope, cooccurrence, contextNodeId),
    enabled: (options?.enabled ?? true) && nodeIds.length > 0,
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
export function useLinkedReferences(
  nodeId: number | null,
  params?: { limit?: number; offset?: number }
) {
  return useQuery({
    queryKey: nodeKeys.linkedRefs(nodeId ?? 0, params),
    queryFn: () => nodesApi.getLinkedReferences(nodeId!, params),
    enabled: !!nodeId,
    placeholderData: (previousData) => previousData,
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
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.dailyList(),
    queryFn: () => nodesApi.listDailyPages(),
    select: (data) => data.items,
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
 * @param filters - Optional search filters (class_filters, uuid, is_page, is_class, is_daily)
 */
export function useSearch(query: string, filters?: {
  classFilters?: string;
  uuid?: string;
  isPage?: boolean;
  isClass?: boolean;
  isDaily?: boolean;
  isUserPage?: boolean;
}) {
  const searchFilters: Record<string, string | boolean | undefined> = {
    classFilters: filters?.classFilters,
    uuid: filters?.uuid,
    isPage: filters?.isPage,
    isClass: filters?.isClass,
    isDaily: filters?.isDaily,
    isUserPage: filters?.isUserPage,
  };
  return useQuery({
    queryKey: nodeKeys.search(query, searchFilters),
    queryFn: () => nodesApi.searchNodes(query, {
      class_filters: filters?.classFilters,
      uuid: filters?.uuid,
      is_page: filters?.isPage,
      is_class: filters?.isClass,
      is_daily: filters?.isDaily,
      is_user_page: filters?.isUserPage,
    }),
    enabled: query.length > 0 || !!filters?.uuid || !!filters?.classFilters || filters?.isPage !== undefined || filters?.isClass !== undefined || filters?.isDaily !== undefined || filters?.isUserPage !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30, // 30s - search results change less often than typed
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
    staleTime: 1000 * 60 * 5, // 5 minutes - class list rarely changes
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
    placeholderData: keepPreviousData,
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
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.tasks(includeComplete),
    queryFn: () => nodesApi.listTasks(includeComplete),
    select: (data) => data.items,
  });
}

/**
 * Hook to fetch archived pages
 */
export function useArchivedPages() {
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.archived(),
    queryFn: () => nodesApi.getArchivedPages(),
    select: (data) => data.items,
  });
}

/**
 * Hook to fetch nodes with a specific class
 */
export function useNodesWithClass(classId: number | null) {
  return useQuery<PaginatedResponse<Node>, Error, Node[]>({
    queryKey: nodeKeys.byClass(classId ?? 0),
    queryFn: () => nodesApi.getNodesWithClass(classId!),
    enabled: !!classId,
    select: (data) => data.items,
  });
}

/**
 * Hook to fetch text links for a node with is_tag info
 */
export function useTextLinks(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.textLinks(nodeId ?? 0),
    queryFn: () => nodesApi.getTextLinks(nodeId!),
    enabled: !!nodeId,
    staleTime: 30000,
  });
}

/**
 * Hook to fetch suggested pages for node pickers.
 * Returns recently created (last 15 min) then most recently linked pages.
 */
export function useSuggestions(classFilters?: string, enabled = true) {
  return useQuery({
    queryKey: nodeKeys.suggestions(classFilters),
    queryFn: () => nodesApi.getSuggestions(20, classFilters),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30,
  });
}
