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

  useEffect(() => {
    if (!client || !classId) {
      setData(undefined);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<ClassProperty[]>('getClassProperties', [classId, includeInherited])
        .then((result) => {
          if (!cancelled) {
            setData(result);
          }
        })
        .catch((err) => {
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

  return toQueryResult(data, isLoading, error);
}

/**
 * Adapter for fetching class-property edges for all classes of a node.
 */
export function useNodeClassPropertyEdgesAdapter(classUuids: string[]): ClassProperty[] {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId);
  const [data, setData] = useState<ClassProperty[]>([]);
  const classUuidsKey = classUuids.join(',');

  useEffect(() => {
    if (!client || classUuidsKey === '') {
      setData([]);
      return;
    }

    const ids = classUuidsKey.split(',');
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
