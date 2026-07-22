import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ClassProperty } from '@/types/api';
import { useWorkspaceStoreClient } from '../hooks/useWorkspaceStoreClient';
import { orderClassPropertyEdges } from '@/features/properties/utils/classPropertyEdges';

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
 * Adapter for fetching properties linked to a class.
 */
export function useClassPropertiesAdapter(
  classId: string | null,
  includeInherited: boolean = false
): UseQueryResult<ClassProperty[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId);
  const [data, setData] = useState<ClassProperty[] | undefined>(undefined);
  const [queryError, setQueryError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !classId) {
      setData(undefined);
      setQueryError(null);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<ClassProperty[]>('getClassProperties', [classId, includeInherited])
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
          console.error('[useClassPropertiesAdapter] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(null, update);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, classId, includeInherited]);

  return toQueryResult(data, isLoading, error ?? queryError);
}

/**
 * Adapter for fetching class-property edges for all classes of a node.
 */
export function useNodeClassPropertyEdgesAdapter(classUuids: string[]): ClassProperty[] {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId);
  const [data, setData] = useState<ClassProperty[]>([]);
  const classUuidsKey = JSON.stringify(classUuids);

  useEffect(() => {
    if (!client || classUuidsKey === '[]') {
      setData([]);
      return;
    }

    const ids = JSON.parse(classUuidsKey) as string[];
    let cancelled = false;
    const update = (): void => {
      client
        .query<ClassProperty[][]>('getNodeClassPropertyEdges', [ids])
        .then((perClassEdges) => {
          if (!cancelled) {
            setData(orderClassPropertyEdges(ids, perClassEdges));
          }
        })
        .catch((err) => {
          console.error('[useNodeClassPropertyEdgesAdapter] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(null, update);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, classUuidsKey]);

  return data;
}
