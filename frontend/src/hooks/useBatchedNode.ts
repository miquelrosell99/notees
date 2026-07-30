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
import type { Node, BreadcrumbItemResponse } from '@/types/api';

/**
 * Fetch a single node using the core store.
 *
 * Use this when you only need basic node data (no children, backlinks, or
 * properties) — e.g., NodeRef, breadcrumbs, link previews, table cells.
 */
export function useBatchedNode(nodeUuid: string | null, meta?: Record<string, unknown>) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<Node | null>({
    queryKey: nodeKeys.byUuid(nodeUuid ?? '__unresolved__'),
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

/**
 * Hook to fetch breadcrumbs for a node from the core store.
 *
 * Returns an ordered list of ancestors from root to immediate parent.
 */
export function useBreadcrumbs(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<BreadcrumbItemResponse[]>({
    queryKey: nodeKeys.breadcrumbsByUuid(nodeUuid ?? '__unresolved__'),
    queryFn: async () => {
      if (!nodeUuid || !client) return [];
      return client.query<BreadcrumbItemResponse[]>('buildBreadcrumbs', [nodeUuid]);
    },
    enabled: !!nodeUuid && !!client,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}
