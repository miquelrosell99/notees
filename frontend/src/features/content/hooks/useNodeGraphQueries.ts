/**
 * useNodeGraphQueries
 */

import { useQuery } from '@tanstack/react-query';

import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { buildGraphData } from '@/core/query/graphData';
import { buildGraphNodes } from '@/core/query/graphNodes';
import { buildGraphLinks } from '@/core/query/graphLinks';

export function useGraphData(options?: { enabled?: boolean }) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<ReturnType<typeof buildGraphData>>({
    queryKey: nodeKeys.graph(),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      return buildGraphData(store);
    },
    enabled: (options?.enabled ?? true) && !!store,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch workspace nodes only (without links).
 * Use with useGraphLinks for efficient data loading.
 */

export function useGraphNodes(options?: { enabled?: boolean }) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<ReturnType<typeof buildGraphNodes>, Error, ReturnType<typeof buildGraphNodes>['items']>({
    queryKey: nodeKeys.graphNodes(),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      return buildGraphNodes(store);
    },
    enabled: (options?.enabled ?? true) && !!store,
    select: (data) => data.items,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}

/**
 * Hook to fetch links between a specific set of node IDs.
 * @param scope - "between" (default): both ends must be in the set.
 *               "touching": at least one end in the set (for neighborhood discovery).
 */

export function useGraphLinks(
  nodeUuids: string[],
  options?: { enabled?: boolean; scope?: 'between' | 'touching'; cooccurrence?: boolean; contextNodeUuid?: string | null }
) {
  const scope = options?.scope ?? 'between';
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store, isLoading, error } = useWorkspaceStore(workspaceUuid ?? '');

  const result = useQuery<ReturnType<typeof buildGraphLinks>>({
    queryKey: nodeKeys.graphLinks(nodeUuids, scope, options?.cooccurrence, options?.contextNodeUuid),
    queryFn: () => {
      if (!store) throw new Error('Workspace store is not ready');
      return buildGraphLinks(store, nodeUuids, scope);
    },
    enabled: (options?.enabled ?? true) && nodeUuids.length > 0 && !!store,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}
