/**
 * useNodeSearch Hook
 *
 * Shared search/filter logic for node selection components.
 * Used by:
 * - NodePicker (property value selection)
 * - SuggestionPopup (inline @/+ /# triggers)
 *
 * Features:
 * - Query-based search using useSearch API
 * - Fallback to pages/nodes when query is empty
 * - Separation of results into pages and blocks
 * - Optional filtering by tag/type
 * - "Create new" option detection
 */
import { useMemo } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useSearch, usePages, useNodes, useClasses, useSearchClasses, useSuggestions } from './useNodes';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { nodeNameToText } from '@/features/queries';
import type { NodeSearchMode, NodeSearchFilters, NodeSearchItem, UseNodeSearchReturn } from './useNodeSearch.types';
import type { Node } from '@/types/api';
import { nodeKeys } from '@/hooks/queryKeys';

import {
  getClassesResults,
  getUsersResults,
  getTagsResults,
  getAliasesResults,
  getPagesResults,
  getBlocksResults,
  getAllResults,
} from './useNodeSearch.utils';

export type { NodeSearchMode, NodeSearchFilters, NodeSearchItem, UseNodeSearchReturn };

export function useNodeSearch(
  query: string,
  filters: NodeSearchFilters = {}
): UseNodeSearchReturn {
  const {
          mode = 'all',
          classFilters = [],
          excludeNodeId,
          maxResults = 10,
          pinnedNodeId,
          nodeUuid,
          isPage,
          isClass,
          isDaily,
          isUserPage } = filters;

  // Debounce the search query to avoid firing API on every keystroke
  const debouncedQuery = useDebouncedValue(query, 150);

  // Convert classFilters array to comma-separated string for backend
  const classFiltersParam = classFilters.length > 0 ? classFilters.join(',') : undefined;

  // Core search queries - pass class_filters to backend for server-side filtering
  const searchFilterOptions = {
    ...(classFiltersParam ? { classFilters: classFiltersParam } : {}),
    ...(nodeUuid ? { nodeUuid } : {}),
    ...(isPage !== undefined ? { isPage } : {}),
    ...(isClass !== undefined ? { isClass } : {}),
    ...(isDaily !== undefined ? { isDaily } : {}),
    ...(isUserPage !== undefined ? { isUserPage } : {}),
  };
  const hasSearchFilters = Object.keys(searchFilterOptions).length > 0;
  const { data: searchResults, isFetching: isSearchFetching } = useSearch(
    debouncedQuery,
    hasSearchFilters ? searchFilterOptions : undefined
  );
  const { data: allPages } = usePages();
  // Suggestions for empty-query state: recently created + recently linked
  const useSuggestionsForEmpty = mode === 'pages' || mode === 'all';
  const { data: suggestions } = useSuggestions(
    classFiltersParam,
    useSuggestionsForEmpty && !nodeUuid && isPage === undefined && isClass === undefined && isDaily === undefined && isUserPage === undefined,
  );
  // Filtered pages query for when class_filters are present (empty-query case)
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const { data: filteredPages } = useQuery({
    queryKey: nodeKeys.filteredPages(classFiltersParam),
    queryFn: async () => {
      if (!client) return [];
      const classIds = classFiltersParam ? classFiltersParam.split(',').filter(Boolean) : undefined;
      return client.query<Node[]>('queryNodes', [{ isPage: true, classIds, projectionDepth: 0 }]);
    },
    enabled: !!classFiltersParam && !!client,
    placeholderData: keepPreviousData,
  });
  const { data: allNodes } = useNodes(
    mode === 'all' || mode === 'blocks' ? {} : null
  );

  // Class-specific queries (only enabled when mode is 'classes')
  const { data: allClassNodes } = useClasses();
  const { data: classSearchResults, isLoading: isClassSearchLoading } = useSearchClasses(
    mode === 'classes' ? debouncedQuery : ''
  );

  // Use debouncedQuery for API-driven filtering, but keep original query for "Create new" detection.
  // Show a loading state while the query is debouncing or a new search fetch is in flight,
  // so stale results from the previous query are not displayed.
  const isLoading = isSearchFetching || isClassSearchLoading || debouncedQuery !== query;

  // Filter and organize results
  const { pageResults, blockResults, truncated } = useMemo(() => {
    if (mode === 'classes') {
      return getClassesResults(debouncedQuery, classSearchResults, allClassNodes, excludeNodeId, maxResults);
    }
    if (mode === 'users') {
      return getUsersResults(debouncedQuery, searchResults, excludeNodeId, maxResults);
    }
    if (mode === 'tags') {
      return getTagsResults(debouncedQuery, searchResults, allPages, classFilters, excludeNodeId, maxResults);
    }
    if (mode === 'aliases') {
      return getAliasesResults(debouncedQuery, searchResults, allPages, excludeNodeId, maxResults);
    }
    if (mode === 'pages') {
      return getPagesResults(debouncedQuery, searchResults, suggestions, filteredPages, allPages, classFilters, excludeNodeId, pinnedNodeId, maxResults);
    }
    if (mode === 'blocks') {
      return getBlocksResults(debouncedQuery, searchResults, allNodes, maxResults);
    }
    return getAllResults(debouncedQuery, searchResults, suggestions, allPages, allNodes, classFilters, excludeNodeId, pinnedNodeId, maxResults);
  }, [
    mode,
    debouncedQuery,
    searchResults,
    allPages,
    suggestions,
    filteredPages,
    allNodes,
    allClassNodes,
    classSearchResults,
    classFilters,
    excludeNodeId,
    maxResults,
    pinnedNodeId,
  ]);

  // Combined results for easy iteration
  const allResults = useMemo(
    () => [...pageResults, ...blockResults],
    [pageResults, blockResults]
  );

  // Determine if "Create new" option should be shown
  // Don't show while still debouncing or fetching to prevent "Create page" flash / duplicates
  const showCreateOption = useMemo(() => {
    if (!query.trim()) return false;
    if (isLoading) return false;

    // No exact match in page results (case-sensitive comparison, names are literal)
    return !pageResults.some(r => nodeNameToText(r.node.name) === query);
  }, [pageResults, query, isLoading]);

  return {
    pageResults,
    blockResults,
    allResults,
    isLoading,
    showCreateOption,
    hasMore: truncated,
  };
}

export default useNodeSearch;
