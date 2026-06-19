/**
 * useNodeListQueries
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { useAuthStore } from '@/stores';

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

export function useClasses(options?: { enabled?: boolean }) {
  const authVerified = useAuthStore((s) => s.authVerified);
  return useQuery({
    queryKey: nodeKeys.classes(),
    queryFn: () => nodesApi.listClasses(),
    placeholderData: [],
    staleTime: 1000 * 60 * 5, // 5 minutes - class list rarely changes
    enabled: options?.enabled ?? authVerified,
  });
}

/**
 * Hook to search for classes
 */

export function useSearchClasses(query: string) {
  return useQuery({
    queryKey: nodeKeys.classSearch(query),
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

