/**
 * Property Query Hooks
 */
import { useQuery } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import * as nodesApi from '@/api/nodes';
import type { BatchPropertiesResult } from '@/api/nodes';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { resolveNodeUuids } from '@/utils/resolveNodeUuid';

export function useProperties() {
  return useQuery({
    queryKey: propertyKeys.list(),
    queryFn: () => propertiesApi.listProperties(),
  });
}

export function useAvailableProperties(opts: {
  contextNodeId?: string | number;
  contextClassIds?: (string | number)[];
} = {}) {
  const hasContext = opts.contextNodeId != null || (opts.contextClassIds?.length ?? 0) > 0;
  return useQuery({
    queryKey: propertyKeys.available(opts),
    queryFn: () =>
      hasContext
        ? propertiesApi.getAvailableProperties(opts)
        : propertiesApi.listProperties(),
  });
}

export function useProperty(id: string | number | null) {
  return useQuery({
    queryKey: propertyKeys.detail(id ?? ''),
    queryFn: () => propertiesApi.getProperty(id!),
    enabled: !!id,
  });
}

export function useBatchPropertyValues(nodeIds: (string | number)[]) {
  return useQuery<BatchPropertiesResult>({
    queryKey: nodeKeys.batchProperties(nodeIds),
    queryFn: () => nodesApi.batchGetPropertyValues(resolveNodeUuids(nodeIds)),
    enabled: nodeIds.length > 0,
    staleTime: 30_000,
  });
}
