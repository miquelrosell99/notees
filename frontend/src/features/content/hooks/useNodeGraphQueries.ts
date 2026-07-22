/**
 * useNodeGraphQueries
 */

import { useQuery } from '@tanstack/react-query';

import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { buildGraphDataFromClient } from '@/core/query/graphData';
import { buildGraphNodesFromClient } from '@/core/query/graphNodes';
import { buildGraphLinksFromClient } from '@/core/query/graphLinks';

export function useGraphData(options?: { enabled?: boolean }) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<Awaited<ReturnType<typeof buildGraphDataFromClient>>>({
    queryKey: nodeKeys.graph(),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      return buildGraphDataFromClient(client);
    },
    enabled: (options?.enabled ?? true) && !!client,
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
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<Awaited<ReturnType<typeof buildGraphNodesFromClient>>, Error, Awaited<ReturnType<typeof buildGraphNodesFromClient>>['items']>({
    queryKey: nodeKeys.graphNodes(),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      return buildGraphNodesFromClient(client);
    },
    enabled: (options?.enabled ?? true) && !!client,
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
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<Awaited<ReturnType<typeof buildGraphLinksFromClient>>>({
    queryKey: nodeKeys.graphLinks(nodeUuids, scope, options?.cooccurrence, options?.contextNodeUuid),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      return buildGraphLinksFromClient(client, nodeUuids, scope);
    },
    enabled: (options?.enabled ?? true) && nodeUuids.length > 0 && !!client,
  });

  return {
    ...result,
    isLoading: result.isLoading || isLoading,
    error: result.error ?? error,
  };
}
