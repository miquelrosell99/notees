/**
 * Property Query Hooks
 */
import { useQuery } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import * as nodesApi from '@/api/nodes';
import type { BatchPropertiesResult } from '@/api/nodes';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { resolveNodeUuids, resolvePropertyUuid, resolveNodeUuid } from '@/utils/resolveNodeUuid';

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
  const contextNodeUuid = opts.contextNodeId == null ? undefined : typeof opts.contextNodeId === 'string' ? opts.contextNodeId : resolveNodeUuid(opts.contextNodeId);
  const contextClassUuids = opts.contextClassIds?.map((id) => typeof id === 'string' ? id : resolveNodeUuid(id));
  return useQuery({
    queryKey: propertyKeys.available({ contextNodeId: contextNodeUuid, contextClassIds: contextClassUuids }),
    queryFn: () =>
      hasContext
        ? propertiesApi.getAvailableProperties({ contextNodeId: contextNodeUuid, contextClassIds: contextClassUuids })
        : propertiesApi.listProperties(),
  });
}

export function useProperty(id: string | number | null) {
  const propertyUuid = id == null ? null : typeof id === 'string' ? id : resolvePropertyUuid(id);
  return useQuery({
    queryKey: propertyKeys.detail(propertyUuid ?? ''),
    queryFn: () => propertiesApi.getProperty(propertyUuid!),
    enabled: !!propertyUuid,
  });
}

export function useBatchPropertyValues(nodeIds: (string | number)[]) {
  return useQuery<BatchPropertiesResult>({
    queryKey: nodeKeys.batchProperties(resolveNodeUuids(nodeIds)),
    queryFn: () => nodesApi.batchGetPropertyValues(resolveNodeUuids(nodeIds)),
    enabled: nodeIds.length > 0,
    staleTime: 30_000,
  });
}
