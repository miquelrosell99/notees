import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Property, BatchPropertiesResult } from '@/types/api';
import { usePropertySchemas } from '../hooks/usePropertySchemas';
import { useWorkspaceStoreClient } from '../hooks/useWorkspaceStoreClient';

function toQueryResult<TData>(
  data: TData | undefined,
  isLoading: boolean,
  error: Error | null
): UseQueryResult<TData, Error> {
  const isErrorState = error !== null;
  const status: UseQueryResult<TData, Error>['status'] = isLoading
    ? 'pending'
    : isErrorState
      ? 'error'
      : 'success';

  return {
    data,
    isLoading,
    isError: isErrorState,
    error,
    isPending: isLoading,
    isSuccess: !isLoading && !isErrorState,
    status,
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<TData, Error>;
}

/**
 * Adapter for listing property schemas. Derives schemas from the property_schema table.
 */
export function usePropertiesAdapter(): UseQueryResult<Property[], Error> {
  const { schemas, isLoading, error } = usePropertySchemas();
  return toQueryResult(schemas, isLoading, error);
}

/**
 * Adapter for listing properties available in a given context.
 *
 * Returns global properties plus:
 * - node-scoped properties bound to contextNodeId
 * - class-scoped properties bound to any of contextClassIds
 */
export function useAvailablePropertiesAdapter(opts: {
  contextNodeId?: string;
  contextClassIds?: string[];
} = {}): UseQueryResult<Property[], Error> {
  const { schemas, isLoading, error } = usePropertySchemas();

  const available = useMemoizedAvailableProperties(schemas, opts.contextNodeId, opts.contextClassIds);
  return toQueryResult(available, isLoading, error);
}

function useMemoizedAvailableProperties(
  schemas: Property[],
  contextNodeId: string | undefined,
  contextClassIds: string[] | undefined
): Property[] {
  return useMemo(() => {
    const classIds = new Set(contextClassIds ?? []);
    return schemas.filter((schema) => {
      if (schema.scope === 'global') return true;
      if (schema.scope === 'node' && schema.node_uuid === contextNodeId) return true;
      if (schema.scope === 'class' && schema.node_uuid && classIds.has(schema.node_uuid)) return true;
      return false;
    });
  }, [schemas, contextNodeId, contextClassIds]);
}

/**
 * Adapter for fetching a single property schema by UUID.
 */
export function usePropertyAdapter(id: string | null): UseQueryResult<Property, Error> {
  const { schemas, isLoading, error } = usePropertySchemas();
  const schema = id ? schemas.find((s) => s.uuid === id) : undefined;
  return toQueryResult(schema, isLoading, error);
}

/**
 * Adapter for batch-fetching property values for multiple nodes.
 */
export function useBatchPropertyValuesAdapter(
  nodeUuids: string[]
): UseQueryResult<BatchPropertiesResult, Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId);
  const [data, setData] = useState<BatchPropertiesResult>({});
  const [queryError, setQueryError] = useState<Error | null>(null);
  const nodeUuidsKey = JSON.stringify(nodeUuids);

  useEffect(() => {
    if (!client || nodeUuidsKey === '[]') {
      setData({});
      setQueryError(null);
      return;
    }

    const ids = JSON.parse(nodeUuidsKey) as string[];
    let cancelled = false;
    const update = (): void => {
      client
        .query<BatchPropertiesResult>('getBatchPropertyValues', [ids])
        .then((result) => {
          if (!cancelled) {
            setData(result);
            setQueryError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setQueryError(err instanceof Error ? err : new Error(String(err)));
          }
          console.error('[useBatchPropertyValuesAdapter] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(null, update);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, nodeUuidsKey]);

  return toQueryResult(data, isLoading, error ?? queryError);
}
