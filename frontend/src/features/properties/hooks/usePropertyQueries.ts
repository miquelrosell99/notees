/**
 * Property Query Hooks
 */
import { useQuery } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import * as nodesApi from '@/api/nodes';
import type { BatchPropertiesResult } from '@/api/nodes';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';


export function useProperties() {
  return useQuery({
    queryKey: propertyKeys.list(),
    queryFn: () => propertiesApi.listProperties(),
  });
}

export function useAvailableProperties(opts: {
  contextNodeId?: string;
  contextClassIds?: string[];
} = {}) {
  const hasContext = opts.contextNodeId != null || (opts.contextClassIds?.length ?? 0) > 0;
  const contextNodeUuid = opts.contextNodeId;
  const contextClassUuids = opts.contextClassIds;
  return useQuery({
    queryKey: propertyKeys.available({ contextNodeUuid, contextClassUuids }),
    queryFn: () =>
      hasContext
        ? propertiesApi.getAvailableProperties({ contextNodeUuid, contextClassUuids })
        : propertiesApi.listProperties(),
  });
}

export function useProperty(id: string | null) {
  return useQuery({
    queryKey: propertyKeys.detail(id ?? ''),
    queryFn: () => propertiesApi.getProperty(id!),
    enabled: !!id,
  });
}

export function useBatchPropertyValues(nodeUuids: string[]) {
  return useQuery<BatchPropertiesResult>({
    queryKey: nodeKeys.batchProperties(nodeUuids),
    queryFn: () => nodesApi.batchGetPropertyValues(nodeUuids),
    enabled: nodeUuids.length > 0,
    staleTime: 30_000,
  });
}
