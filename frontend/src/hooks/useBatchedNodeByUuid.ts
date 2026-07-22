/**
 * Batched Node-by-UUID Fetching
 *
 * Reads nodes directly from the local-first core SQLite store.
 * The global HTTP batcher has been removed; store lookups are cheap enough
 * that batching is no longer required.
 */
import { useQuery } from '@tanstack/react-query';
import { nodeKeys } from './queryKeys';
import { useCurrentWorkspaceUuid } from './useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { projectNodeFromClient } from '@/core/adapters/nodeProjection';
import type { Node } from '@/types/api';

/**
 * Fetch a single node by UUID from the core store.
 *
 * Use this when you only need basic node data (no children, backlinks, or
 * properties) — e.g., NodeRef, NodeNameContent, link previews, table cells.
 */
export function useBatchedNodeByUuid(nodeUuid: string | null, meta?: Record<string, unknown>) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<Node | null>({
    queryKey: nodeKeys.byUuid(nodeUuid ?? ''),
    queryFn: async () => {
      if (!nodeUuid || !client) return null;
      return (await projectNodeFromClient(client, nodeUuid)) ?? null;
    },
    enabled: !!nodeUuid && !!client,
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

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}
