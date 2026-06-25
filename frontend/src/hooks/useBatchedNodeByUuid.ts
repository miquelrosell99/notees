/**
 * Batched Node-by-UUID Fetching
 *
 * Automatically batches individual node-by-UUID requests into a single
 * POST /batch-get-by-uuid API call. This eliminates N+1 query waterfalls
 * when many components (NodeRef, NodeNameContent, table cells, etc.) each
 * need to resolve a UUID independently.
 *
 * How it works:
 * 1. Components call useBatchedNodeByUuid(uuid) instead of useNodeByUuid(uuid)
 * 2. UUIDs are queued in a microtask batch window
 * 3. After the microtask settles, all queued UUIDs are fetched in one API call
 * 4. Results are split back into individual React Query cache entries
 *
 * Each individual node is cached under nodeKeys.byUuid(uuid) so it can be
 * read from cache by other hooks as well.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { batchGetNodesByUuid } from '@/api/nodes';
import { nodeKeys } from './queryKeys';
import type { Node } from '@/types/api';

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
function queueForBatch(uuid: string, queryClient: QueryClient): Promise<Record<string, Node>> {
  // Skip if already cached
  const cached = queryClient.getQueryData<Node>(nodeKeys.byUuid(uuid));
  if (cached) {
    return Promise.resolve({ [uuid]: cached });
  }

  pendingUuids.add(uuid);

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
          const response = await batchGetNodesByUuid({ uuids: chunk });
          Object.assign(allNodes, response.nodes);
        }

        // Populate individual cache entries
        for (const [nodeUuid, node] of Object.entries(allNodes)) {
          queryClient.setQueryData(nodeKeys.byUuid(nodeUuid), node);
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
 * Fetch a single node by UUID using the batched fetcher.
 *
 * Multiple concurrent useBatchedNodeByUuid(uuid) calls within a render cycle
 * are automatically combined into a single POST /batch-get-by-uuid API call.
 *
 * Use this instead of useNodeByUuid(uuid) when you only need basic node data
 * (no children, backlinks, or properties) — e.g., NodeRef, NodeNameContent,
 * link previews, table cells.
 */
export function useBatchedNodeByUuid(nodeUuid: string | null, meta?: Record<string, unknown>) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: nodeKeys.byUuid(nodeUuid ?? ''),
    queryFn: async () => {
      if (!nodeUuid) throw new Error('No node UUID');

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
