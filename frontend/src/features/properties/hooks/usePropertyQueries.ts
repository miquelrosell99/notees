/**
 * Property Query Hooks
 */
import { useQuery } from '@tanstack/react-query';
import * as propertiesApi from '@/api/properties';
import * as nodesApi from '@/api/nodes';
import type { BatchPropertiesResult } from '@/api/nodes';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import {
  usePropertiesAdapter,
  useAvailablePropertiesAdapter,
  usePropertyAdapter,
  useBatchPropertyValuesAdapter,
} from '@/core/adapters/usePropertiesAdapter';

/**
 * Legacy list-properties query. Imported by the SQLite adapter so it can
 * delegate when ENABLE_SQLITE_STORE is off without creating a circular call.
 */
export function usePropertiesLegacy() {
  return useQuery({
    // NOTE: must stay on propertyKeys.lists() — imperative readers
    // (useRuntimeSync.resolveTaskStatus, useTaskActions.resolveTaskStatusIds)
    // and all property-mutation invalidations target this exact key.
    queryKey: propertyKeys.lists(),
    queryFn: () => propertiesApi.listProperties(),
  });
}

export function useProperties() {
  return usePropertiesAdapter();
}

/**
 * Legacy available-properties query. Imported by the SQLite adapter.
 */
export function useAvailablePropertiesLegacy(opts: {
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

export function useAvailableProperties(opts: {
  contextNodeId?: string;
  contextClassIds?: string[];
} = {}) {
  return useAvailablePropertiesAdapter(opts);
}

/**
 * Legacy single-property query. Imported by the SQLite adapter.
 */
export function usePropertyLegacy(id: string | null) {
  return useQuery({
    queryKey: propertyKeys.detail(id ?? ''),
    queryFn: () => propertiesApi.getProperty(id!),
    enabled: !!id,
  });
}

export function useProperty(id: string | null) {
  return usePropertyAdapter(id);
}

/**
 * Legacy batch-property-values query. Imported by the SQLite adapter.
 */
export function useBatchPropertyValuesLegacy(nodeUuids: string[]) {
  return useQuery<BatchPropertiesResult>({
    queryKey: nodeKeys.batchProperties(nodeUuids),
    queryFn: () => nodesApi.batchGetPropertyValues(nodeUuids),
    enabled: nodeUuids.length > 0,
    staleTime: 30_000,
  });
}

export function useBatchPropertyValues(nodeUuids: string[]) {
  return useBatchPropertyValuesAdapter(nodeUuids);
}
