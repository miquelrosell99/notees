/**
 * useNodeListQueries
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { queryNodes } from '@/core/query/queryNodes';
import { useClasses as useCoreClasses } from '@/core/hooks';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';

function useCoreNodeQuery(
  queryKey: readonly unknown[],
  filters: Parameters<typeof queryNodes>[1],
  enabled = true,
) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(enabled && workspaceUuid ? workspaceUuid : '');

  const result = useQuery({
    queryKey: [...queryKey],
    queryFn: () => {
      if (!store) return [];
      return queryNodes(store, filters);
    },
    enabled: enabled && !!store,
    placeholderData: [],
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

export function usePages(options?: { includeChildren?: boolean; rootOnly?: boolean }) {
  const { includeChildren = false, rootOnly = false } = options ?? {};
  // TODO(D9): includeChildren/rootOnly are legacy API concepts. The core store
  // lists all pages; tree roots vs. children should be filtered by callers that
  // need top-level pages only.
  return useCoreNodeQuery(nodeKeys.pages({ includeChildren, rootOnly }), { isPage: true });
}

/**
 * Hook to search nodes
 * @param query - Search query string
 * @param filters - Optional search filters (class_filters, node_uuid, is_page, is_class, is_daily)
 */

export function useSearch(query: string, filters?: {
  classFilters?: string;
  nodeUuid?: string;
  isPage?: boolean;
  isClass?: boolean;
  isDaily?: boolean;
  isUserPage?: boolean;
}) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const searchFilters: Record<string, string | boolean | undefined> = {
    classFilters: filters?.classFilters,
    nodeUuid: filters?.nodeUuid,
    isPage: filters?.isPage,
    isClass: filters?.isClass,
    isDaily: filters?.isDaily,
    isUserPage: filters?.isUserPage,
  };

  const hasFilters =
    !!filters?.nodeUuid ||
    !!filters?.classFilters ||
    filters?.isPage !== undefined ||
    filters?.isClass !== undefined ||
    filters?.isDaily !== undefined ||
    filters?.isUserPage !== undefined;

  const enabled = !!store && (query.length > 0 || hasFilters);

  const result = useQuery({
    queryKey: nodeKeys.search(query, searchFilters),
    queryFn: () => {
      if (!store) return [];
      const classIds = filters?.classFilters ? filters.classFilters.split(',') : undefined;
      return queryNodes(store, {
        query,
        isPage: filters?.isPage,
        isClass: filters?.isClass,
        isDaily: filters?.isDaily,
        classIds,
      });
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30, // 30s - search results change less often than typed
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch all tags (pages that can be used as tags)
 * Tags are regular pages (not type definitions) that users link with #
 */

export function useTags() {
  return useCoreNodeQuery(nodeKeys.tags(), { isPage: true });
}

/**
 * Hook to fetch all classes (nodes that can be used as classes)
 * Classes are essentially pages that can categorize other nodes
 */

export function useClasses(options?: { enabled?: boolean }) {
  return useCoreClasses(options);
}

/**
 * Hook to search for classes
 */

export function useSearchClasses(query: string) {
  const { data: allClasses, isLoading, error } = useCoreClasses({ enabled: query.length > 0 });
  const normalizedQuery = query.toLowerCase().trim();
  const filtered = !normalizedQuery
    ? allClasses
    : allClasses?.filter((cls) =>
        (typeof cls.name === 'string' ? cls.name : '').toLowerCase().includes(normalizedQuery),
      );
  return {
    data: filtered,
    isLoading,
    error,
  };
}

/**
 * Hook to fetch nodes by tag
 */

export function useNodesByTag(tagUuid: string | null) {
  return useCoreNodeQuery(
    nodeKeys.list({ tag_uuid: tagUuid ?? '' }),
    { classIds: tagUuid ? [tagUuid] : [] },
    !!tagUuid,
  );
}

/**
 * Hook to fetch tasks
 */
