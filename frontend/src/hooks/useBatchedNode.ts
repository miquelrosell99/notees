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
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { projectNode } from '@/core/adapters/nodeProjection';
import { buildBreadcrumbs } from '@/core/query/breadcrumbs';
import type { Node, BreadcrumbItemResponse } from '@/types/api';

/**
 * Fetch a single node using the core store.
 *
 * Use this when you only need basic node data (no children, backlinks, or
 * properties) — e.g., NodeRef, breadcrumbs, link previews, table cells.
 */
export function useBatchedNode(nodeUuid: string | null, meta?: Record<string, unknown>) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<Node | null>({
    queryKey: nodeKeys.byUuid(nodeUuid ?? '__unresolved__'),
    queryFn: () => {
      if (!nodeUuid || !store) return null;
      return projectNode(store, nodeUuid) ?? null;
    },
    enabled: !!nodeUuid && !!store,
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
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<BreadcrumbItemResponse[]>({
    queryKey: nodeKeys.breadcrumbsByUuid(nodeUuid ?? '__unresolved__'),
    queryFn: () => {
      if (!nodeUuid || !store) return [];
      return buildBreadcrumbs(store, nodeUuid);
    },
    enabled: !!nodeUuid && !!store,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}
