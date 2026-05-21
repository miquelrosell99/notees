/**
 * Batched Node Fetching
 * 
 * Automatically batches individual node-by-ID requests into a single
 * POST /batch-get API call. This eliminates N+1 query waterfalls when
 * many components (NodeRef, breadcrumbs, table rows, etc.) each need
 * to fetch a node independently.
 * 
 * How it works:
 * 1. Components call useBatchedNode(id) instead of useNode(id)
 * 2. IDs are queued in a microtask batch window
 * 3. After the microtask settles, all queued IDs are fetched in one API call
 * 4. Results are split back into individual React Query cache entries
 * 
 * Each individual node is cached under nodeKeys.metadata(id) so it can
 * be read from cache by other hooks as well.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import type { Node } from '@/types/api';

// ─── Global Batcher ──────────────────────────────────────────────────────────

/** Pending batch state — shared across all hook instances */
let pendingIds: Set<number> = new Set();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let batchResolvers: Array<(value: Record<string, Node>) => void> = [];

/** Time window to collect IDs before firing the batch (ms) */
const BATCH_DELAY_MS = 10;

/** Maximum batch size — split into multiple requests if exceeded */
const MAX_BATCH_SIZE = 200;

/**
 * Queue a node ID for batched fetching.
 * Returns a promise that resolves with the full batch result map.
 */
function queueForBatch(id: number, queryClient: QueryClient): Promise<Record<string, Node>> {
  // Skip if already cached
  const cached = queryClient.getQueryData<Node>(nodeKeys.metadata(id));
  if (cached) {
    return Promise.resolve({ [String(id)]: cached });
  }

  pendingIds.add(id);

  return new Promise<Record<string, Node>>((resolve) => {
    batchResolvers.push(resolve);

    // Reset/start the batch timer
    if (batchTimer !== null) {
      clearTimeout(batchTimer);
    }

    batchTimer = setTimeout(async () => {
      const idsToFetch = Array.from(pendingIds);
      const resolvers = [...batchResolvers];

      // Reset global state immediately so new requests create a new batch
      pendingIds = new Set();
      batchResolvers = [];
      batchTimer = null;

      if (idsToFetch.length === 0) {
        const empty = {};
        resolvers.forEach(r => r(empty));
        return;
      }

      try {
        // Split into chunks if needed
        const allNodes: Record<string, Node> = {};

        for (let i = 0; i < idsToFetch.length; i += MAX_BATCH_SIZE) {
          const chunk = idsToFetch.slice(i, i + MAX_BATCH_SIZE);
          const response = await nodesApi.batchGetNodes({ ids: chunk });
          Object.assign(allNodes, response.nodes);
        }

        // Populate individual cache entries
        for (const [idStr, node] of Object.entries(allNodes)) {
          queryClient.setQueryData(nodeKeys.metadata(Number(idStr)), node);
        }

        resolvers.forEach(r => r(allNodes));
      } catch (error) {
        // On error, resolve with empty — individual queries will show as errors
        resolvers.forEach(r => r({}));
      }
    }, BATCH_DELAY_MS);
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Fetch a single node using the batched fetcher.
 * 
 * Multiple concurrent useBatchedNode(id) calls within a render cycle
 * are automatically combined into a single POST /batch-get API call.
 * 
 * Use this instead of useNode(id) when you only need basic node data
 * (no children, backlinks, or properties) — e.g., NodeRef, breadcrumbs,
 * link previews, table cells.
 */
export function useBatchedNode(id: number | null, meta?: Record<string, unknown>) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: nodeKeys.metadata(id ?? 0),
    queryFn: async () => {
      if (!id) throw new Error('No node ID');

      const result = await queueForBatch(id, queryClient);
      const node = result[String(id)];
      if (!node) {
        throw new Error(`Node ${id} not found`);
      }
      return node;
    },
    enabled: !!id,
    staleTime: 1000 * 60 * 10, // 10 minutes — metadata is stable
    retry: (failureCount, error) => {
      // Don't retry on "not found"
      if (error instanceof Error && error.message.includes('not found')) {
        return false;
      }
      return failureCount < 1;
    },
    meta,
  });
}

/**
 * Hook to fetch breadcrumbs for a node via the dedicated API endpoint.
 * 
 * Returns an ordered list of ancestors from root to immediate parent.
 * Uses the closure table — O(1) regardless of depth.
 */
export function useBreadcrumbs(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.breadcrumbs(nodeId ?? 0),
    queryFn: async () => {
      if (!nodeId) throw new Error('No node ID');
      const response = await nodesApi.getBreadcrumbs(nodeId);
      return response.breadcrumbs;
    },
    enabled: !!nodeId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
