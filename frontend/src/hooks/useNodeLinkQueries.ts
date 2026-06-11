/**
 * useNodeLinkQueries
 */

import { useQuery } from '@tanstack/react-query';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './queryKeys';

export function useBacklinks(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.backlinks(nodeId ?? 0),
    queryFn: () => nodesApi.getBacklinks(nodeId!),
    enabled: !!nodeId,
    placeholderData: [],
  });
}

/**
 * Hook to fetch linked references with context
 */

export function useLinkedReferences(
  nodeId: number | null,
  params?: { limit?: number; offset?: number }
) {
  return useQuery({
    queryKey: nodeKeys.linkedRefs(nodeId ?? 0, params),
    queryFn: () => nodesApi.getLinkedReferences(nodeId!, params),
    enabled: !!nodeId,
    placeholderData: (previousData) => previousData,
  });
}

/**
 * Hook to fetch property backlinks (pages referencing via date/node properties)
 */

export function usePropertyBacklinks(nodeId: number | null) {
  return useQuery({
    queryKey: nodeKeys.propertyBacklinks(nodeId ?? 0),
    queryFn: () => nodesApi.getPropertyBacklinks(nodeId!),
    enabled: !!nodeId,
    placeholderData: [],
  });
}

/**
 * Hook to fetch all existing daily pages (without creating new ones).
 * Both useExistingDailyPages and useDailyPages share the same query key
 * to avoid duplicate requests to GET /nodes/daily/list.
 */

