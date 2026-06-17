/**
 * useVirtualizedQuery Hook
 *
 * High-performance query execution hook that combines:
 * - Debounced execution (300ms) to avoid excessive backend calls during editing
 * - Windowed/virtualized result slicing for large result sets
 * - Auto-fix of system queries before execution
 * - Pagination metadata (total_count) from backend
 * - Execution metrics logging
 * 
 * Usage:
 *   const { visibleNodes, totalCount, isLoading, metrics } = useVirtualizedQuery({
 *     viewId,
 *     runtimeParams: { current_node_uuid: '...' },
 *     ast: editingAST,            // live AST (debounced)
 *     viewType: 'linked_references',
 *     nodeUuid: '...',
 *     windowSize: 200,            // render this many at a time
 *   });
 */
import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { executeNodeViewQuery, executeQuery as executeAdHocQuery } from '@/api/nodeViews';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { normalizeAST } from '@/lib/astNormalizer';
import { useDebouncedValue } from './useDebouncedValue';
import { nodeViewKeys } from '@/features/content/hooks/useNodeViews';
import type { QueryAST } from '@/types/queryAST';
import type { QueryExecuteResponse, QueryExecutionMetrics } from '@/types/nodeView';
import type { Node } from '@/types/api';

// ==================== Types ====================

export interface UseVirtualizedQueryOptions {
  /** NodeView ID to execute (0 = ad-hoc) */
  viewId: number;
  /** Runtime parameters for placeholder substitution */
  runtimeParams?: Record<string, unknown>;
  /** Live AST for ad-hoc / preview queries (will be debounced) */
  ast?: QueryAST;
  /** View type for auto-fix */
  viewType?: string;
  /** Node UUID for auto-fix context */
  nodeUuid?: string;
  /** Whether to include children in results */
  includeChildren?: boolean;
  /** Whether to include properties in results */
  includeProperties?: boolean;
  /** Enrichment overrides */
  enrich?: { children?: boolean; classes?: boolean; properties?: boolean };
  /** Debounce delay in ms (default 300) */
  debounceMs?: number;
  /** Maximum nodes to render at once (virtualization window, default 500) */
  windowSize?: number;
  /** Backend page size limit */
  limit?: number;
  /** Backend offset */
  offset?: number;
  /** Enable/disable the query */
  enabled?: boolean;
  /** TanStack staleTime override (default 30s for view queries, 0 for ad-hoc) */
  staleTime?: number;
}

export interface UseVirtualizedQueryResult {
  /** All nodes returned by the query */
  allNodes: Node[];
  /** Windowed subset of nodes for rendering (up to windowSize) */
  visibleNodes: Node[];
  /** Total count of matching rows (from backend pagination) */
  totalCount: number | null;
  /** Number of nodes currently loaded */
  loadedCount: number;
  /** Whether the query is loading */
  isLoading: boolean;
  /** Whether the query is fetching (background refetch) */
  isFetching: boolean;
  /** Execution metrics from the backend */
  metrics: QueryExecutionMetrics | null;
  /** Scroll to load more — call when user nears end */
  loadMore: () => void;
  /** Whether there are more nodes to show */
  hasMore: boolean;
  /** Current window offset */
  windowOffset: number;
  /** Refetch the query */
  refetch: () => void;
}

// ==================== Hook ====================

export function useVirtualizedQuery(
  options: UseVirtualizedQueryOptions
): UseVirtualizedQueryResult {
  const {
    viewId,
    runtimeParams,
    ast,
    viewType,
    nodeUuid,
    includeChildren = false,
    includeProperties = false,
    enrich,
    debounceMs = 300,
    windowSize = 500,
    limit,
    offset,
    enabled = true,
    staleTime,
  } = options;

  // Debounce the AST to avoid hammering the backend during edits
  const debouncedAST = useDebouncedValue(ast, debounceMs);

  // Auto-fix + normalize the debounced AST
  const preparedAST = useMemo(() => {
    if (!debouncedAST) return undefined;
    let fixed = debouncedAST;
    if (viewType && nodeUuid) {
      fixed = autoFixSystemQuery(fixed, viewType, { nodeUuid });
    }
    return normalizeAST(fixed);
  }, [debouncedAST, viewType, nodeUuid]);

  // Window state for virtualization
  const [windowEnd, setWindowEnd] = useState(windowSize);

  // Reset window when query changes
  const prevQueryRef = useRef<string>('');
  const queryFingerprint = useMemo(() => {
    // Use primitive fields only to avoid expensive JSON.stringify on large ASTs
    const astKey = preparedAST ? `${preparedAST.type}-${preparedAST.id ?? 'no-id'}` : 'none';
    const paramsKey = runtimeParams
      ? Object.entries(runtimeParams)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}:${String(v)}`)
          .join('|')
      : 'none';
    return `${viewId}|${paramsKey}|${astKey}|${limit ?? 'all'}|${offset ?? 0}`;
  }, [viewId, runtimeParams, preparedAST, limit, offset]);

  useEffect(() => {
    if (queryFingerprint !== prevQueryRef.current) {
      prevQueryRef.current = queryFingerprint;
      setWindowEnd(windowSize);
    }
  }, [queryFingerprint, windowSize]);

  // Build the query key
  const queryKey = useMemo(() => {
    if (viewId > 0 && !preparedAST) {
      // View-based query
      return nodeViewKeys.queryResult(viewId, {
        runtimeParams,
        limit,
        offset,
        includeChildren,
        includeProperties,
        enrich,
      });
    }
    // Ad-hoc query
    return [
      ...nodeViewKeys.queryResults(),
      'virtualized',
      viewId,
      preparedAST,
      runtimeParams,
      limit,
      offset,
    ];
  }, [viewId, preparedAST, runtimeParams, limit, offset, includeChildren, includeProperties, enrich]);

  // Execute the query
  const {
    data,
    isLoading,
    isFetching,
    refetch,
  } = useQuery<QueryExecuteResponse>({
    queryKey,
    queryFn: async (): Promise<QueryExecuteResponse> => {
      const requestOpts = {
        runtime_params: runtimeParams as Record<string, unknown>,
        limit,
        offset,
        include_children: includeChildren,
        include_properties: includeProperties,
        enrich,
      };

      if (viewId > 0 && !preparedAST) {
        // Execute against a saved view
        return executeNodeViewQuery(viewId, requestOpts);
      }

      // Ad-hoc query
      return executeAdHocQuery({
        query_ast: preparedAST,
        ...requestOpts,
      });
    },
    enabled: enabled && (viewId > 0 || !!preparedAST),
    staleTime: staleTime ?? (viewId > 0 ? 30_000 : 0),
  });

  const allNodes = useMemo(() => data?.nodes ?? [], [data?.nodes]);
  const totalCount = data?.total_count ?? null;
  const metrics = data?.metrics ?? null;

  // Virtualized window
  const visibleNodes = useMemo(
    () => allNodes.slice(0, windowEnd),
    [allNodes, windowEnd]
  );

  const hasMore = windowEnd < allNodes.length;

  const loadMore = useCallback(() => {
    setWindowEnd((prev) => Math.min(prev + windowSize, allNodes.length));
  }, [windowSize, allNodes.length]);

  return {
    allNodes,
    visibleNodes,
    totalCount,
    loadedCount: allNodes.length,
    isLoading,
    isFetching,
    metrics,
    loadMore,
    hasMore,
    windowOffset: 0,
    refetch,
  };
}
