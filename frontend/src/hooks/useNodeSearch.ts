/**
 * useNodeSearch Hook
 * 
 * Shared search/filter logic for node selection components.
 * Used by:
 * - NodePicker (property value selection)
 * - SuggestionPopup (inline @/# /[[ triggers)
 * - NodeLinkSearch (modal link insertion)
 * 
 * Features:
 * - Query-based search using useSearch API
 * - Fallback to pages/nodes when query is empty
 * - Separation of results into pages and blocks
 * - Optional filtering by tag/type
 * - "Create new" option detection
 */
import { useMemo } from 'react';
import { useSearch, usePages, useNodes, useClasses, useSearchClasses } from './useNodes';
import type { Node } from '@/types';

export type NodeSearchMode = 'all' | 'pages' | 'blocks' | 'classes' | 'tags';

export interface NodeSearchFilters {
  /** What types of nodes to include */
  mode?: NodeSearchMode;
  /** Class IDs to filter by (nodes must have at least one of these classes) */
  classFilters?: number[];
  /** Node ID to exclude from results (e.g., self-reference) */
  excludeNodeId?: number;
  /** Maximum number of results per section */
  maxResults?: number;
  /** @deprecated Use classFilters instead */
  tagFilters?: number[];
}

export interface NodeSearchItem {
  node: Node;
  displayName: string;
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
    classFilters = filters.tagFilters ?? [], // Support both new and deprecated prop
    excludeNodeId,
    maxResults = 10,
  } = filters;

  // Core search queries
  const { data: searchResults, isLoading: isSearchLoading } = useSearch(query);
  const { data: allPages } = usePages();
  const { data: allNodes } = useNodes(
    mode === 'all' || mode === 'blocks' ? {} : null
  );
  
  // Class-specific queries (only enabled when mode is 'classes')
  const { data: allClassNodes } = useClasses();
  const { data: classSearchResults, isLoading: isClassSearchLoading } = useSearchClasses(
    mode === 'classes' ? query : ''
  );

  // Filter and organize results
  const { pageResults, blockResults } = useMemo(() => {
    // Helper to check if a node is a class definition (has is_class flag)
    const isClassDef = (node: Node) => node.is_class === true;
    
    // Classes mode - special handling for @ trigger
    if (mode === 'classes') {
      const results = query.length > 0
        ? (classSearchResults ?? [])
        : (allClassNodes ?? []).slice(0, maxResults);

      return {
        pageResults: results.map(node => ({
          node,
          displayName: node.name || 'Untitled',
          section: 'class' as const,
        })),
        blockResults: [],
      };
    }

    // Tags mode - show all pages (tags are pages in Notees)
    // Exclude nodes that are class definitions (they shouldn't appear as tags)
    if (mode === 'tags') {
      const results = (query.length > 0
        ? (searchResults ?? []).filter(n => n.is_page)
        : (allPages ?? []).slice(0, maxResults * 2)  // Get extra to account for filtering
      ).filter(n => !isClassDef(n)).slice(0, maxResults);

      return {
        pageResults: results.map(node => ({
          node,
          displayName: node.name || 'Untitled',
          section: 'page' as const,
        })),
        blockResults: [],
      };
    }

    // Pages-only mode
    if (mode === 'pages') {
      const results = query.length > 0
        ? (searchResults ?? []).filter(n => n.is_page || n.parent_id === null)
        : (allPages ?? []).slice(0, maxResults);

      return {
        pageResults: results.slice(0, maxResults).map(node => ({
          node,
          displayName: node.name || 'Untitled',
          section: 'page' as const,
        })),
        blockResults: [],
      };
    }

    // Blocks-only mode
    if (mode === 'blocks') {
      const results = query.length > 0
        ? (searchResults ?? []).filter(n => !n.is_page && n.parent_id !== null)
        : (allNodes ?? []).filter(n => !n.is_page).slice(0, maxResults);

      return {
        pageResults: [],
        blockResults: results.slice(0, maxResults).map(node => ({
          node,
          displayName: node.name || node.display_name || 'Untitled block',
          section: 'block' as const,
        })),
      };
    }

    // 'all' mode - pages first, then blocks
    let baseResults = query.length > 0
      ? (searchResults ?? [])
      : [
          ...(allPages ?? []).slice(0, Math.floor(maxResults / 2)),
          ...(allNodes ?? []).filter(n => n.parent_id !== null).slice(0, Math.floor(maxResults / 2)),
        ];

    // Apply class filters if provided (filter by assigned classes)
    // Now that list/search endpoints reliably populate `classes`, we can use it directly
    if (classFilters.length > 0) {
      baseResults = baseResults.filter(node => {
        // Always include pages
        if (node.is_page || node.parent_id === null) return true;
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

    // Separate into pages and blocks
    const pages: NodeSearchItem[] = [];
    const blocks: NodeSearchItem[] = [];

    for (const node of baseResults) {
      if (node.is_page || node.parent_id === null) {
        if (pages.length < maxResults) {
          pages.push({
            node,
            displayName: node.name || 'Untitled',
            section: 'page',
          });
        }
      } else {
        if (blocks.length < maxResults) {
          blocks.push({
            node,
            displayName: node.name || node.display_name || 'Untitled block',
            section: 'block',
          });
        }
      }
    }

    return { pageResults: pages, blockResults: blocks };
  }, [
    effectiveMode,
    query,
    searchResults,
    allPages,
    allNodes,
    allClassNodes,
    classSearchResults,
    classFilters,
    excludeNodeId,
    maxResults,
  ]);

  // Combined results for easy iteration
  const allResults = useMemo(
    () => [...pageResults, ...blockResults],
    [pageResults, blockResults]
  );

  // Determine if "Create new" option should be shown
  const showCreateOption = useMemo(() => {
    if (!query.trim()) return false;
    // No exact match in page results (case-sensitive comparison)
    return !pageResults.some(r => r.displayName === query);
  }, [pageResults, query]);

  return {
    pageResults,
    blockResults,
    allResults,
    isLoading: isSearchLoading || isClassSearchLoading,
    showCreateOption,
  };
}

export default useNodeSearch;
