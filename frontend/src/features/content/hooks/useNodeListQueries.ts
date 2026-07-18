/**
 * useNodeListQueries
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useConnectionStore } from '@/stores/connectionStore';
import { useWorkspaces } from '@/features/workspace';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { queryNodes } from '@/core/query/queryNodes';
import { useClasses as useCoreClasses } from '@/core/hooks';

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
  const isOnline = useOnlineStatus();
  const backendHealthy = useConnectionStore((s) => s.healthy);
  const isOffline = !isOnline || backendHealthy === false;

  const { data: workspacesData } = useWorkspaces({ enabled: isOffline });
  const activeWorkspace = workspacesData?.items?.find((ws) => ws.is_active) ?? workspacesData?.items?.[0];
  const workspaceUuid = activeWorkspace?.uuid;

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

  const serverEnabled = !isOffline && (query.length > 0 || hasFilters);
  const localEnabled = isOffline && !!workspaceUuid && (query.length > 0 || hasFilters);

  return useQuery({
    queryKey: nodeKeys.search(query, searchFilters),
    queryFn: async () => {
      if (isOffline) {
        if (!workspaceUuid) return [];
        const store = getWorkspaceStore(workspaceUuid);
        if (!store) return [];
        const classIds = filters?.classFilters ? filters.classFilters.split(',') : undefined;
        return queryNodes(store, {
          query,
          isPage: filters?.isPage,
          isClass: filters?.isClass,
          isDaily: filters?.isDaily,
          classIds,
        });
      }
      return nodesApi.searchNodes(query, {
        class_filters: filters?.classFilters,
        node_uuid: filters?.nodeUuid,
        is_page: filters?.isPage,
        is_class: filters?.isClass,
        is_daily: filters?.isDaily,
        is_user_page: filters?.isUserPage,
      });
    },
    enabled: serverEnabled || localEnabled,
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
  return useQuery({
    queryKey: nodeKeys.list({ tag_uuid: tagUuid ?? '' }),
    queryFn: () => {
      if (!tagUuid) throw new Error('Tag UUID not found');
      return nodesApi.listNodes({ tag_uuid: tagUuid });
    },
    enabled: !!tagUuid,
    placeholderData: [],
  });
}

/**
 * Hook to fetch tasks
 */

