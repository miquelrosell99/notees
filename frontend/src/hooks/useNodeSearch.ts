/**
 * useNodeSearch Hook
 * 
 * Shared search/filter logic for node selection components.
 * Used by:
 * - NodePicker (property value selection)
 * - SuggestionPopup (inline @/# /+ triggers)
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
import { useDebouncedValue } from './useDebouncedValue';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useSearch, usePages, useNodes, useClasses, useSearchClasses, useSuggestions } from './useNodes';
import * as nodesApi from '@/api/nodes';
import type { Node } from '@/types';
import { parseHierarchicalPath, filterNodesByHierarchy } from '@/utils/hierarchicalPath';
import { nodeNameToText } from './useStringifyAST';

export type NodeSearchMode = 'all' | 'pages' | 'blocks' | 'classes' | 'tags' | 'aliases';

export interface NodeSearchFilters {
  /** What types of nodes to include */
  mode?: NodeSearchMode;
  /** Class IDs to filter by (nodes must have at least one of these classes) */
  classFilters?: number[];
  /** Node ID to exclude from results (e.g., self-reference) */
  excludeNodeId?: number;
  /** Maximum number of results per section */
  maxResults?: number;
  /** Node ID to pin at the top of results (current value in single-select pickers) */
  pinnedNodeId?: number | null;
}

export interface NodeSearchItem {
  node: Node;
  section: 'page' | 'block' | 'class';
}

export interface UseNodeSearchReturn {
  /** Page/type results */
  pageResults: NodeSearchItem[];
  /** Block results */
  blockResults: NodeSearchItem[];
  /** All results combined (pages first, then blocks) */
  allResults: NodeSearchItem[];
  /** Whether the search is loading */
  isLoading: boolean;
  /** Whether to show "Create new" option */
  showCreateOption: boolean;
  /** Whether more results were available but truncated by maxResults */
  hasMore: boolean;
}

/**
 * Hook for searching and filtering nodes across components.
 * 
 * @param query - Search query string
 * @param filters - Optional filters for search behavior
 * @returns Filtered and organized search results
 * 
 * @example
 * // Basic usage for page links
 * const { pageResults, blockResults } = useNodeSearch(query);
 * 
 * @example
 * // Class selection (for @ trigger)
 * const { pageResults } = useNodeSearch(query, { mode: 'classes' });
 * 
 * @example
 * // With class filters (for property pickers)
 * const { allResults } = useNodeSearch(query, { 
 *   classFilters: property.class_filters 
 * });
 */
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
  } = filters;

  // Debounce the search query to avoid firing API on every keystroke
  const debouncedQuery = useDebouncedValue(query, 150);

  // Convert classFilters array to comma-separated string for backend
  const classFiltersParam = classFilters.length > 0 ? classFilters.join(',') : undefined;

  // Core search queries - pass class_filters to backend for server-side filtering
  const { data: searchResults, isLoading: isSearchLoading } = useSearch(debouncedQuery, classFiltersParam ? { classFilters: classFiltersParam } : undefined);
  const { data: allPages } = usePages();
  // Suggestions for empty-query state: recently created + recently linked
  const useSuggestionsForEmpty = mode === 'pages' || mode === 'all';
  const { data: suggestions } = useSuggestions(
    classFiltersParam,
    useSuggestionsForEmpty,
  );
  // Filtered pages query for when class_filters are present (empty-query case)
  const { data: filteredPages } = useQuery({
    queryKey: ['nodes', 'filtered-pages', classFiltersParam],
    queryFn: () => nodesApi.listNodes({ pages_only: true, class_filters: classFiltersParam }),
    enabled: !!classFiltersParam,
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
    // Helper to check if a node is a class definition (has is_class flag)
    const isClassDef = (node: Node) => node.is_class === true;
    
    // Parse query for hierarchical path (use debouncedQuery for result filtering)
    const parsed = parseHierarchicalPath(debouncedQuery);
    const searchQuery = parsed.isHierarchical ? parsed.leaf : debouncedQuery;
    
    // Classes mode - special handling for @ trigger
    if (mode === 'classes') {
      let results = searchQuery.length > 0
        ? (classSearchResults ?? [])
        : (allClassNodes ?? []).slice(0, maxResults);
      
      // Apply hierarchical filtering if needed
      if (parsed.isHierarchical && allPages) {
        results = filterNodesByHierarchy(query, results, allPages);
      }

      if (excludeNodeId !== undefined) {
        results = results.filter(n => n.id !== excludeNodeId);
      }

      const truncatedClasses = results.length > maxResults;
      return {
        pageResults: results.slice(0, maxResults).map(node => ({
          node,
          section: 'class' as const,
        })),
        blockResults: [],
        truncated: truncatedClasses,
      };
    }

    // Tags mode - show all pages (tags are pages in Notees)
    // Exclude nodes that are class definitions (they shouldn't appear as tags)
    if (mode === 'tags') {
      let results = (searchQuery.length > 0
        ? (searchResults ?? []).filter(n => n.is_page)
        : (allPages ?? []).slice(0, maxResults * 3)
      ).filter(n => !isClassDef(n));
      
      // Apply hierarchical filtering if needed
      if (parsed.isHierarchical && allPages) {
        results = filterNodesByHierarchy(query, results, allPages);
      }

      // Apply class filters if provided
      if (classFilters.length > 0) {
        results = results.filter(node => {
          if (node.classes && node.classes.length > 0) {
            return classFilters.some(filterId => node.classes!.includes(filterId));
          }
          return false;
        });
      }
      
      if (excludeNodeId !== undefined) {
        results = results.filter(n => n.id !== excludeNodeId);
      }

      const truncatedTags = results.length > maxResults;
      results = results.slice(0, maxResults);

      return {
        pageResults: results.map(node => ({
          node,
          section: 'page' as const,
        })),
        blockResults: [],
        truncated: truncatedTags,
      };
    }

    // Aliases mode - show pages that are NOT already an alias of another node
    // Exclude class definitions, non-page nodes, nodes with aliased_id, nodes with aliases array, and self
    if (mode === 'aliases') {
      let results = (searchQuery.length > 0
        ? (searchResults ?? []).filter(n => n.is_page)
        : (allPages ?? []).slice(0, maxResults * 3)
      ).filter(n => !isClassDef(n) && !n.aliased_id && (!n.aliases || n.aliases.length === 0));
      
      // Apply hierarchical filtering if needed
      if (parsed.isHierarchical && allPages) {
        results = filterNodesByHierarchy(query, results, allPages);
      }

      if (excludeNodeId !== undefined) {
        results = results.filter(n => n.id !== excludeNodeId);
      }
      
      const truncatedAliases = results.length > maxResults;
      results = results.slice(0, maxResults);

      return {
        pageResults: results.map(node => ({
          node,
          section: 'page' as const,
        })),
        blockResults: [],
        truncated: truncatedAliases,
      };
    }

    // Pages-only mode
    if (mode === 'pages') {
      let results: Node[];
      if (searchQuery.length > 0) {
        // Search results are already filtered by class_filters on the backend
        results = (searchResults ?? []).filter(n => n.is_page || n.parent_id === null);
      } else if (suggestions && suggestions.length > 0) {
        // Use smart suggestions: recently created (15 min) + recently linked
        results = suggestions;
      } else if (classFilters.length > 0) {
        // Use backend-filtered pages when class filters are active
        results = (filteredPages ?? []).slice(0, maxResults * 3);
      } else {
        results = (allPages ?? []).slice(0, maxResults * 3);
      }
      
      // Apply hierarchical filtering if needed
      if (parsed.isHierarchical && allPages) {
        results = filterNodesByHierarchy(query, results, allPages);
      }

      // Apply exclusion filter
      if (excludeNodeId !== undefined) {
        results = results.filter(n => n.id !== excludeNodeId);
      }

      // Pin current value at top when no active search
      if (pinnedNodeId && searchQuery.length === 0) {
        const pinnedIdx = results.findIndex(n => n.id === pinnedNodeId);
        if (pinnedIdx > 0) {
          const [pinned] = results.splice(pinnedIdx, 1);
          results.unshift(pinned);
        } else if (pinnedIdx === -1 && allPages) {
          const pinnedNode = allPages.find(n => n.id === pinnedNodeId);
          if (pinnedNode) results.unshift(pinnedNode);
        }
      }

      return {
        pageResults: results.slice(0, maxResults).map(node => ({
          node,
          section: 'page' as const,
        })),
        blockResults: [],
        truncated: results.length > maxResults,
      };
    }

    // Blocks-only mode
    if (mode === 'blocks') {
      const results = searchQuery.length > 0
        ? (searchResults ?? []).filter(n => !n.is_page && n.parent_id !== null)
        : (allNodes ?? []).filter(n => !n.is_page).slice(0, maxResults);

      return {
        pageResults: [],
        blockResults: results.slice(0, maxResults).map(node => ({
          node,
          section: 'block' as const,
        })),
        truncated: results.length > maxResults,
      };
    }

    // 'all' mode - pages first, then blocks
    let baseResults = searchQuery.length > 0
      ? (searchResults ?? [])
      : suggestions && suggestions.length > 0
        ? [
            ...suggestions.slice(0, Math.floor(maxResults / 2)),
            ...(allNodes ?? []).filter(n => n.parent_id !== null).slice(0, Math.floor(maxResults / 2)),
          ]
        : [
            ...(allPages ?? []).slice(0, Math.floor(maxResults / 2)),
            ...(allNodes ?? []).filter(n => n.parent_id !== null).slice(0, Math.floor(maxResults / 2)),
          ];
    
    // Apply hierarchical filtering if needed (only for pages)
    if (parsed.isHierarchical && allPages) {
      const pagesOnly = baseResults.filter(n => n.is_page || n.parent_id === null);
      const blocksOnly = baseResults.filter(n => !n.is_page && n.parent_id !== null);
      const filteredPages = filterNodesByHierarchy(query, pagesOnly, allPages);
      baseResults = [...filteredPages, ...blocksOnly];
    }

    // Apply class filters if provided (filter by assigned classes)
    // Now that list/search endpoints reliably populate `classes`, we can use it directly
    if (classFilters.length > 0) {
      baseResults = baseResults.filter(node => {
        // Include nodes with matching class - classes is now reliably populated
        if (node.classes && node.classes.length > 0) {
          return classFilters.some(filterId => node.classes!.includes(filterId));
        }
        return false;
      });
    }

    // Apply exclusion filter
    if (excludeNodeId !== undefined) {
      baseResults = baseResults.filter(n => n.id !== excludeNodeId);
    }

    // Pin current value at top when no active search
    if (pinnedNodeId && searchQuery.length === 0) {
      const pinnedIdx = baseResults.findIndex(n => n.id === pinnedNodeId);
      if (pinnedIdx > 0) {
        const [pinned] = baseResults.splice(pinnedIdx, 1);
        baseResults.unshift(pinned);
      } else if (pinnedIdx === -1 && allPages) {
        const pinnedNode = allPages.find(n => n.id === pinnedNodeId);
        if (pinnedNode) baseResults.unshift(pinnedNode);
      }
    }

    // Separate into pages and blocks
    const pages: NodeSearchItem[] = [];
    const blocks: NodeSearchItem[] = [];

    for (const node of baseResults) {
      if (node.is_page || node.parent_id === null) {
        if (pages.length < maxResults) {
          pages.push({
            node,
            section: 'page',
          });
        }
      } else {
        if (blocks.length < maxResults) {
          blocks.push({
            node,
            section: 'block',
          });
        }
      }
    }

    // Check if we had to truncate either section
    const totalAvailable = baseResults.length;
    const totalShown = pages.length + blocks.length;
    return { pageResults: pages, blockResults: blocks, truncated: totalAvailable > totalShown };
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
  // Don't show while still debouncing to prevent "Create page" flash
  const showCreateOption = useMemo(() => {
    if (!query.trim()) return false;
    if (debouncedQuery !== query) return false; // Still debouncing, don't flash "Create"
    
    const parsed = parseHierarchicalPath(query);
    const searchTerm = parsed.isHierarchical ? parsed.leaf : query;
    
    // For hierarchical paths, only show create if the parent path exists
    if (parsed.isHierarchical && allPages) {
      // Check if we can resolve all parent segments
      let currentParentId: number | null = null;
      for (const segment of parsed.parentSegments) {
        const matchingPage = allPages.find(
          p => p.name === segment && p.parent_id === currentParentId
        );
        if (!matchingPage) {
          // Parent path doesn't exist, can't create - but we could show "Create Page1/Page2..."
          return true; // Allow creation to create intermediate pages
        }
        currentParentId = matchingPage.id;
      }
      
      // Parent path exists, check if leaf exists
      const leafExists = pageResults.some(
        r => nodeNameToText(r.node.name) === parsed.leaf && r.node.parent_id === currentParentId
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
