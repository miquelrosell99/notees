import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Property, BatchPropertiesResult } from '@/types/api';
import { usePropertySchemas } from '../hooks/usePropertySchemas';
import { useWorkspaceStore } from '../hooks/useWorkspaceStore';
import { queryAll } from '../db/sqlite';

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
 * Adapter for listing property schemas. Derives schemas from property_value rows.
 */
export function usePropertiesAdapter(): UseQueryResult<Property[], Error> {
  const { schemas, isLoading, error } = usePropertySchemas();
  return toQueryResult(schemas, isLoading, error);
}

/**
 * Adapter for listing properties available in a given context.
 *
 * TODO(D3): context filtering (node/class scope) is not yet derived from SQLite.
 */
export function useAvailablePropertiesAdapter(opts: {
  contextNodeId?: string;
  contextClassIds?: string[];
} = {}): UseQueryResult<Property[], Error> {
  const { schemas, isLoading, error } = usePropertySchemas();
  // TODO(D3): filter by contextNodeId / contextClassIds once schema metadata exists.
  void opts;
  return toQueryResult(schemas, isLoading, error);
}

/**
 * Adapter for fetching a single property schema by UUID.
 */
export function usePropertyAdapter(id: string | null): UseQueryResult<Property, Error> {
  const { schemas, isLoading, error } = usePropertySchemas();
  const schema = id ? schemas.find((s) => s.uuid === id) : undefined;
  return toQueryResult(schema, isLoading, error);
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Adapter for batch-fetching property values for multiple nodes.
 */
export function useBatchPropertyValuesAdapter(
  nodeUuids: string[]
): UseQueryResult<BatchPropertiesResult, Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');

  const result: BatchPropertiesResult = {};
  if (store && nodeUuids.length > 0) {
    for (const nodeId of nodeUuids) {
      const rows = queryAll<{ property_schema_id: string; value: string }>(
        store.getDb(),
        'SELECT property_schema_id, value FROM property_value WHERE node_id = ?',
        [nodeId]
      );
      const map: Record<string, unknown> = {};
      for (const row of rows) {
        map[row.property_schema_id] = parseValue(row.value);
      }
      result[nodeId] = map;
    }
  }

  return toQueryResult(result, isLoading, error);
}
