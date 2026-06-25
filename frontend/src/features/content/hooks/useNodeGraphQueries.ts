/**
 * useNodeGraphQueries
 */

import { useQuery } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from '@/hooks/queryKeys';

export function useGraphData(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: nodeKeys.graph(),
    queryFn: () => nodesApi.getWorkspaceData(),
    enabled: options?.enabled ?? true,
  });
}

/**
 * Hook to fetch workspace nodes only (without links).
 * Use with useGraphLinks for efficient data loading.
 */

export function useGraphNodes(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: nodeKeys.graphNodes(),
    queryFn: () => nodesApi.getGraphNodes(),
    enabled: options?.enabled ?? true,
    select: (data) => data.items,
  });
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
  const cooccurrence = options?.cooccurrence ?? false;
  const contextNodeUuid = options?.contextNodeUuid ?? null;
  return useQuery({
    queryKey: nodeKeys.graphLinks(nodeUuids, scope, cooccurrence, contextNodeUuid),
    queryFn: () => nodesApi.getLinksForNodes(nodeUuids, scope, cooccurrence, contextNodeUuid ?? undefined),
    enabled: (options?.enabled ?? true) && nodeUuids.length > 0,
  });
}

/**
 * Hook to fetch backlinks for a node
 */

