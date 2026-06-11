/**
 * Property Query Hooks
 */
import { useQuery } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import * as nodesApi from '@/api/nodes';
import type { BatchPropertiesResult } from '@/api/nodes';
import { nodeKeys, propertyKeys } from './queryKeys';

export function useProperties() {
  return useQuery({
    queryKey: propertyKeys.list(),
    queryFn: () => propertiesApi.listProperties(),
  });
}

export function useAvailableProperties(opts: {
  contextNodeId?: number;
  contextClassIds?: number[];
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

export function useProperty(id: number | null) {
  return useQuery({
    queryKey: propertyKeys.detail(id ?? 0),
    queryFn: () => propertiesApi.getProperty(id!),
    enabled: !!id,
  });
}

export function useBatchPropertyValues(nodeIds: number[]) {
  return useQuery<BatchPropertiesResult>({
    queryKey: nodeKeys.batchProperties(nodeIds),
    queryFn: () => nodesApi.batchGetPropertyValues(nodeIds),
    enabled: nodeIds.length > 0,
    staleTime: 30_000,
  });
}
