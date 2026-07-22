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
 * - Hierarchical path support (e.g., "Page1/Page2" searches for Page2 child of Page1)
 * - "Create new" option detection
 */
import { useMemo } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useSearch, usePages, useNodes, useClasses, useSearchClasses, useSuggestions } from './useNodes';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { queryNodes } from '@/core/query/queryNodes';
import { parseHierarchicalPath } from '@/utils/hierarchicalPath';
import { nodeNameToText } from '@/features/queries';
import type { NodeSearchMode, NodeSearchFilters, NodeSearchItem, UseNodeSearchReturn } from './useNodeSearch.types';
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
  const { data: searchResults, isLoading: isSearchLoading } = useSearch(
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
  const { store } = useWorkspaceStore(workspaceUuid ?? '');
  const { data: filteredPages } = useQuery({
    queryKey: nodeKeys.filteredPages(classFiltersParam),
    queryFn: () => {
      if (!store) return [];
      const classIds = classFiltersParam ? classFiltersParam.split(',').filter(Boolean) : undefined;
      return queryNodes(store, { isPage: true, classIds, projectionDepth: 0 });
    },
    enabled: !!classFiltersParam && !!store,
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

  // Use debouncedQuery for API-driven filtering, but keep original query for "Create new" detection
  const isLoading = isSearchLoading || isClassSearchLoading || debouncedQuery !== query;

  // Filter and organize results
  const { pageResults, blockResults, truncated } = useMemo(() => {
    if (mode === 'classes') {
      return getClassesResults(debouncedQuery, query, classSearchResults, allClassNodes, allPages, excludeNodeId, maxResults);
    }
    if (mode === 'users') {
      return getUsersResults(debouncedQuery, searchResults, excludeNodeId, maxResults);
    }
    if (mode === 'tags') {
      return getTagsResults(debouncedQuery, query, searchResults, allPages, classFilters, excludeNodeId, maxResults);
    }
    if (mode === 'aliases') {
      return getAliasesResults(debouncedQuery, query, searchResults, allPages, excludeNodeId, maxResults);
    }
    if (mode === 'pages') {
      return getPagesResults(debouncedQuery, query, searchResults, suggestions, filteredPages, allPages, classFilters, excludeNodeId, pinnedNodeId, maxResults);
    }
    if (mode === 'blocks') {
      return getBlocksResults(debouncedQuery, searchResults, allNodes, maxResults);
    }
    return getAllResults(debouncedQuery, query, searchResults, suggestions, allPages, allNodes, classFilters, excludeNodeId, pinnedNodeId, maxResults);
  }, [
    mode,
    debouncedQuery,
    query,
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
  // Don't show while still debouncing to prevent "Create page" flash
  const showCreateOption = useMemo(() => {
    if (!query.trim()) return false;
    if (debouncedQuery !== query) return false; // Still debouncing, don't flash "Create"

    const parsed = parseHierarchicalPath(query);
    const searchTerm = parsed.isHierarchical ? parsed.leaf : query;

    // For hierarchical paths, only show create if the parent path exists
    if (parsed.isHierarchical && allPages) {
      // Check if we can resolve all parent segments
      let currentParentId: string | null = null;
      for (const segment of parsed.parentSegments) {
        const matchingPage = allPages.find(
          p => p.name === segment && p.parent_uuid === currentParentId
        );
        if (!matchingPage) {
          // Parent path doesn't exist, can't create - but we could show "Create Page1/Page2..."
          return true; // Allow creation to create intermediate pages
        }
        currentParentId = matchingPage.uuid;
      }

      // Parent path exists, check if leaf exists
      const leafExists = pageResults.some(
        r => nodeNameToText(r.node.name) === parsed.leaf && r.node.parent_uuid === currentParentId
      );
      return !leafExists;
    }

    // No exact match in page results (case-sensitive comparison)
    return !pageResults.some(r => nodeNameToText(r.node.name) === searchTerm);
  }, [pageResults, query, debouncedQuery, allPages]);

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
