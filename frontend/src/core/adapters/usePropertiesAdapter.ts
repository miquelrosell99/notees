import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Property } from '@/types/api';
import type { BatchPropertiesResult } from '@/api/nodes';
import {
  usePropertiesLegacy,
  useAvailablePropertiesLegacy,
  usePropertyLegacy,
  useBatchPropertyValuesLegacy,
} from '@/features/properties/hooks/usePropertyQueries';
import { usePropertySchemas } from '../hooks/usePropertySchemas';
import { useWorkspaceStore } from '../hooks/useWorkspaceStore';
import { queryAll } from '../db/sqlite';
import { ENABLE_SQLITE_STORE } from '../utils/featureFlags';

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
 * Adapter for listing property schemas. Delegates to the legacy hook when
 * ENABLE_SQLITE_STORE is off; otherwise derives schemas from property_value rows.
 */
export function usePropertiesAdapter(): UseQueryResult<Property[], Error> {
  const legacyResult = usePropertiesLegacy();
  const { schemas, isLoading, error } = usePropertySchemas();

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as UseQueryResult<Property[], Error>;
  }

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
  const legacyResult = useAvailablePropertiesLegacy(opts);
  const { schemas, isLoading, error } = usePropertySchemas();

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as UseQueryResult<Property[], Error>;
  }

  // TODO(D3): filter by contextNodeId / contextClassIds once schema metadata exists.
  void opts;
  return toQueryResult(schemas, isLoading, error);
}

/**
 * Adapter for fetching a single property schema by UUID.
 */
export function usePropertyAdapter(id: string | null): UseQueryResult<Property, Error> {
  const legacyResult = usePropertyLegacy(id);
  const { schemas, isLoading, error } = usePropertySchemas();

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as UseQueryResult<Property, Error>;
  }

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
  const legacyResult = useBatchPropertyValuesLegacy(nodeUuids);
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');

  if (!ENABLE_SQLITE_STORE) {
    return legacyResult as UseQueryResult<BatchPropertiesResult, Error>;
  }

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
