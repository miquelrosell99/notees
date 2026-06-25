/**
 * Batched Node-by-UUID Fetching
 *
 * Automatically batches individual node-by-UUID requests into a single
 * POST /batch-get-by-uuid API call. This eliminates N+1 query waterfalls when
 * many components (NodeRef, breadcrumbs, table rows, etc.) each need
 * to fetch a node independently.
 *
 * How it works:
 * 1. Components call useBatchedNode(nodeUuid) instead of useNode(nodeUuid)
 * 2. UUIDs are queued in a microtask batch window
 * 3. After the microtask settles, all queued UUIDs are fetched in one API call
 * 4. Results are split back into individual React Query cache entries
 *
 * Each individual node is cached under nodeKeys.byUuid(nodeUuid) so it can
 * be read from cache by other hooks as well.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import type { Node } from '@/types/api';
import { tryResolveNodeUuid } from '@/utils/resolveNodeUuid';

// ─── Global Batcher ──────────────────────────────────────────────────────────

/** Pending batch state — shared across all hook instances */
let pendingUuids: Set<string> = new Set();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let batchResolvers: Array<(value: Record<string, Node>) => void> = [];

/** Time window to collect UUIDs before firing the batch (ms) */
const BATCH_DELAY_MS = 10;

/** Maximum batch size — split into multiple requests if exceeded */
const MAX_BATCH_SIZE = 200;

/**
 * Queue a node UUID for batched fetching.
 * Returns a promise that resolves with the full batch result map.
 */
function queueForBatch(nodeUuid: string, queryClient: QueryClient): Promise<Record<string, Node>> {
  // Skip if already cached
  const cached = queryClient.getQueryData<Node>(nodeKeys.byUuid(nodeUuid));
  if (cached) {
    return Promise.resolve({ [nodeUuid]: cached });
  }

  pendingUuids.add(nodeUuid);

  return new Promise<Record<string, Node>>((resolve) => {
    batchResolvers.push(resolve);

    // Reset/start the batch timer
    if (batchTimer !== null) {
      clearTimeout(batchTimer);
    }

    batchTimer = setTimeout(async () => {
      const uuidsToFetch = Array.from(pendingUuids);
      const resolvers = [...batchResolvers];

      // Reset global state immediately so new requests create a new batch
      pendingUuids = new Set();
      batchResolvers = [];
      batchTimer = null;

      if (uuidsToFetch.length === 0) {
        const empty = {};
        resolvers.forEach(r => r(empty));
        return;
      }

      try {
        // Split into chunks if needed
        const allNodes: Record<string, Node> = {};

        for (let i = 0; i < uuidsToFetch.length; i += MAX_BATCH_SIZE) {
          const chunk = uuidsToFetch.slice(i, i + MAX_BATCH_SIZE);
          const response = await nodesApi.batchGetNodesByUuid({ uuids: chunk });
          Object.assign(allNodes, response.nodes);
        }

        // Populate individual cache entries
        for (const [fetchedUuid, node] of Object.entries(allNodes)) {
          queryClient.setQueryData(nodeKeys.byUuid(fetchedUuid), node);
        }

        resolvers.forEach(r => r(allNodes));
      } catch {
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
 * Multiple concurrent useBatchedNode(nodeUuid) calls within a render cycle
 * are automatically combined into a single POST /batch-get-by-uuid API call.
 *
 * Use this instead of useNodeByUuid(nodeUuid) when you only need basic node data
 * (no children, backlinks, or properties) — e.g., NodeRef, breadcrumbs,
 * link previews, table cells.
 */
export function useBatchedNode(nodeId: string | number | null, meta?: Record<string, unknown>) {
  const queryClient = useQueryClient();
  const nodeUuid = nodeId === null ? null : typeof nodeId === 'string' ? nodeId : tryResolveNodeUuid(nodeId);

  return useQuery({
    queryKey: nodeKeys.byUuid(nodeUuid ?? '__unresolved__'),
    queryFn: async () => {
      if (!nodeUuid) return null;

      const result = await queueForBatch(nodeUuid, queryClient);
      const node = result[nodeUuid];
      if (!node) {
        throw new Error(`Node ${nodeUuid} not found`);
      }
      return node;
    },
    enabled: !!nodeUuid,
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
export function useBreadcrumbs(nodeId: string | number | null) {
  const nodeUuid = nodeId === null ? null : typeof nodeId === 'string' ? nodeId : tryResolveNodeUuid(nodeId);
  return useQuery({
    queryKey: nodeKeys.breadcrumbsByUuid(nodeUuid ?? '__unresolved__'),
    queryFn: async () => {
      if (!nodeUuid) return [];
      const response = await nodesApi.getBreadcrumbs(nodeUuid);
      return response.breadcrumbs;
    },
    enabled: !!nodeUuid,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
