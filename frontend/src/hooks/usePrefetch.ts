/**
 * usePrefetch Hook
 * 
 * Hooks for prefetching node data on hover/expand intent.
 * Uses TanStack Query's prefetching capabilities for intelligent caching.
 * 
 * Performance Benefits:
 * - Reduces perceived load time by fetching data before user needs it
 * - Leverages existing cache infrastructure
 * - Minimizes network requests through deduplication
 * 
 * Usage:
 * ```tsx
 * function NodeListItem({ node }) {
 *   const { prefetchOnHover, prefetchChildren } = usePrefetch();
 *   
 *   return (
 *     <div 
 *       onMouseEnter={() => prefetchOnHover(node.id)}
 *       onClick={() => prefetchChildren(node.id)}
 *     >
 *       {node.name}
 *     </div>
 *   );
 * }
 * ```
 */
import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './useNodes';

export interface UsePrefetchOptions {
  /** Delay before prefetching on hover (ms) */
  hoverDelay?: number;
  /** Whether prefetching is enabled */
  enabled?: boolean;
  /** Stale time for prefetched queries */
  staleTime?: number;
}

export interface UsePrefetchReturn {
  /** Prefetch node detail on hover (with delay) */
  prefetchOnHover: (nodeId: number) => void;
  /** Cancel pending hover prefetch */
  cancelHoverPrefetch: () => void;
  /** Immediately prefetch node with children */
  prefetchWithChildren: (nodeId: number) => Promise<void>;
  /** Prefetch page content (blocks + properties + backlinks) */
  prefetchPageContent: (pageId: number) => Promise<void>;
  /** Prefetch multiple nodes in batch */
  prefetchBatch: (nodeIds: number[]) => Promise<void>;
  /** Prefetch linked references for a node */
  prefetchLinkedRefs: (nodeId: number) => Promise<void>;
}

/**
 * Hook for prefetching node data
 */
export function usePrefetch(options: UsePrefetchOptions = {}): UsePrefetchReturn {
  const {
    hoverDelay = 150,
    enabled = true,
    staleTime = 1000 * 60 * 5, // 5 minutes default
  } = options;
  
  const queryClient = useQueryClient();
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel any pending hover prefetch
  const cancelHoverPrefetch = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  // Prefetch node detail on hover (with delay to avoid unnecessary fetches)
  const prefetchOnHover = useCallback((nodeId: number) => {
    if (!enabled) return;
    
    // Cancel existing timeout
    cancelHoverPrefetch();
    
    // Set up delayed prefetch
    hoverTimeoutRef.current = setTimeout(() => {
      // Only prefetch if not already cached or stale
      const existingData = queryClient.getQueryData(
        nodeKeys.detail(nodeId, { include_children: false })
      );
      
      if (!existingData) {
        queryClient.prefetchQuery({
          queryKey: nodeKeys.detail(nodeId, { include_children: false }),
          queryFn: () => nodesApi.getNode(nodeId, { include_children: false }),
          staleTime,
        });
      }
    }, hoverDelay);
  }, [enabled, hoverDelay, staleTime, queryClient, cancelHoverPrefetch]);

  // Immediately prefetch node with children
  const prefetchWithChildren = useCallback(async (nodeId: number) => {
    if (!enabled) return;
    
    await queryClient.prefetchQuery({
      queryKey: nodeKeys.detail(nodeId, { include_children: true }),
      queryFn: () => nodesApi.getNode(nodeId, { include_children: true }),
      staleTime,
    });
  }, [enabled, staleTime, queryClient]);

  // Prefetch full page content
  const prefetchPageContent = useCallback(async (pageId: number) => {
    if (!enabled) return;
    
    await queryClient.prefetchQuery({
      queryKey: nodeKeys.pageContent(pageId),
      queryFn: () => nodesApi.getPageContent(pageId),
      staleTime,
    });
  }, [enabled, staleTime, queryClient]);

  // Prefetch multiple nodes in batch
  const prefetchBatch = useCallback(async (nodeIds: number[]) => {
    if (!enabled || nodeIds.length === 0) return;
    
    // Filter out already cached nodes
    const uncachedIds = nodeIds.filter(id => {
      const cached = queryClient.getQueryData(
        nodeKeys.detail(id, { include_children: false })
      );
      return !cached;
    });
    
    // Prefetch uncached nodes in parallel (max 5 concurrent)
    const BATCH_SIZE = 5;
    for (let i = 0; i < uncachedIds.length; i += BATCH_SIZE) {
      const batch = uncachedIds.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(id =>
          queryClient.prefetchQuery({
            queryKey: nodeKeys.detail(id, { include_children: false }),
            queryFn: () => nodesApi.getNode(id, { include_children: false }),
            staleTime,
          })
        )
      );
    }
  }, [enabled, staleTime, queryClient]);

  // Prefetch linked references
  const prefetchLinkedRefs = useCallback(async (nodeId: number) => {
    if (!enabled) return;
    
    await queryClient.prefetchQuery({
      queryKey: nodeKeys.linkedRefs(nodeId),
      queryFn: () => nodesApi.getLinkedReferences(nodeId),
      staleTime,
    });
  }, [enabled, staleTime, queryClient]);

  return {
    prefetchOnHover,
    cancelHoverPrefetch,
    prefetchWithChildren,
    prefetchPageContent,
    prefetchBatch,
    prefetchLinkedRefs,
  };
}

/**
 * Hook for prefetching on expand intent
 * Prefetches children when user hovers over expand button
 */
export function usePrefetchOnExpandIntent(nodeId: number, hasChildren: boolean) {
  const { prefetchWithChildren, cancelHoverPrefetch } = usePrefetch({
    hoverDelay: 100, // Faster for expand intent
  });
  
  const handleExpandHover = useCallback(() => {
    if (hasChildren) {
      prefetchWithChildren(nodeId);
    }
  }, [nodeId, hasChildren, prefetchWithChildren]);
  
  const handleExpandLeave = useCallback(() => {
    cancelHoverPrefetch();
  }, [cancelHoverPrefetch]);
  
  return {
    onExpandHover: handleExpandHover,
    onExpandLeave: handleExpandLeave,
  };
}

/**
 * Hook for smart prefetching in list views
 * Prefetches visible items and items likely to be scrolled to
 */
export function useListPrefetch(nodeIds: number[], visibleCount: number = 10) {
  const { prefetchBatch } = usePrefetch();
  const prefetchedRef = useRef(new Set<number>());
  
  // Prefetch visible items + buffer
  const prefetchVisible = useCallback(async (startIndex: number) => {
    const endIndex = Math.min(startIndex + visibleCount + 5, nodeIds.length);
    const toPrefetch = nodeIds
      .slice(startIndex, endIndex)
      .filter(id => !prefetchedRef.current.has(id));
    
    if (toPrefetch.length > 0) {
      await prefetchBatch(toPrefetch);
      toPrefetch.forEach(id => prefetchedRef.current.add(id));
    }
  }, [nodeIds, visibleCount, prefetchBatch]);
  
  return { prefetchVisible };
}

export default usePrefetch;
