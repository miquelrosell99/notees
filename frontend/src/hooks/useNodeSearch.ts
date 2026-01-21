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
import { useSearch, usePages, useNodes, useTypes, useSearchTypes } from './useNodes';
import type { Node } from '@/types';

export type NodeSearchMode = 'all' | 'pages' | 'blocks' | 'types' | 'tags';

export interface NodeSearchFilters {
  /** What types of nodes to include */
  mode?: NodeSearchMode;
  /** Tag IDs to filter by (nodes must have at least one of these types) */
  tagFilters?: number[];
  /** Node ID to exclude from results (e.g., self-reference) */
  excludeNodeId?: number;
  /** Maximum number of results per section */
  maxResults?: number;
}

export interface NodeSearchItem {
  node: Node;
  displayName: string;
  section: 'page' | 'block' | 'type';
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
 * // Type selection (for @ trigger)
 * const { pageResults } = useNodeSearch(query, { mode: 'types' });
 * 
 * @example
 * // With tag filters (for property pickers)
 * const { allResults } = useNodeSearch(query, { 
 *   tagFilters: property.tag_filters 
 * });
 */
export function useNodeSearch(
  query: string,
  filters: NodeSearchFilters = {}
): UseNodeSearchReturn {
  const {
    mode = 'all',
    tagFilters = [],
    excludeNodeId,
    maxResults = 10,
  } = filters;

  // Core search queries
  const { data: searchResults, isLoading: isSearchLoading } = useSearch(query);
  const { data: allPages } = usePages();
  const { data: allNodes } = useNodes(
    mode === 'all' || mode === 'blocks' ? {} : null
  );
  
  // Type-specific queries (only enabled when mode is 'types')
  const { data: allTypeNodes } = useTypes();
  const { data: typeSearchResults, isLoading: isTypeSearchLoading } = useSearchTypes(
    mode === 'types' ? query : ''
  );

  // Filter and organize results
  const { pageResults, blockResults } = useMemo(() => {
    // Types mode - special handling for @ trigger
    if (mode === 'types') {
      const results = query.length > 0
        ? (typeSearchResults ?? [])
        : (allTypeNodes ?? []).slice(0, maxResults);

      return {
        pageResults: results.map(node => ({
          node,
          displayName: node.name || 'Untitled',
          section: 'type' as const,
        })),
        blockResults: [],
      };
    }

    // Tags mode - show all pages (tags are pages in Notees)
    if (mode === 'tags') {
      const results = query.length > 0
        ? (searchResults ?? []).filter(n => n.is_page)
        : (allPages ?? []).slice(0, maxResults);

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

    // Apply tag filters if provided
    if (tagFilters.length > 0) {
      baseResults = baseResults.filter(node => {
        // Always include pages
        if (node.is_page || node.parent_id === null) return true;
        // Include nodes with matching type
        if (node.types) {
          return tagFilters.some(filterId => node.types?.includes(filterId));
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
    mode,
    query,
    searchResults,
    allPages,
    allNodes,
    allTypeNodes,
    typeSearchResults,
    tagFilters,
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
    // No exact match in page results
    return !pageResults.some(
      r => r.displayName.toLowerCase() === query.toLowerCase()
    );
  }, [pageResults, query]);

  return {
    pageResults,
    blockResults,
    allResults,
    isLoading: isSearchLoading || isTypeSearchLoading,
    showCreateOption,
  };
}

export default useNodeSearch;
