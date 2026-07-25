/**
 * Class Properties Hooks
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ClassProperty, ClassExtends, InheritedProperty, ExtendedByClass, Node } from '@/types/api';
import {
  useClassPropertiesAdapter,
  useNodeClassPropertyEdgesAdapter,
} from '@/core/adapters/useClassPropertiesAdapter';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { useClasses } from '@/core/hooks';
import { classRowToNode } from '@/core/query/classes';

function useClassRows(): Node[] {
  const { data: classes } = useClasses();
  return useMemo(() => classes?.map(classRowToNode) ?? [], [classes]);
}

function toQueryResult<TData>(
  data: TData | undefined,
  isLoading: boolean,
  error: Error | null
): UseQueryResult<TData, Error> {
  return {
    data,
    isLoading,
    isError: error !== null,
    error,
    isPending: isLoading,
    isSuccess: !isLoading && error === null,
    status: isLoading ? 'pending' : error ? 'error' : 'success',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<TData, Error>;
}

export function useClassProperties(classId: string | null, includeInherited: boolean = false) {
  return useClassPropertiesAdapter(classId, includeInherited);
}

export function useNodeClassPropertyEdges(classUuids: string[]): ClassProperty[] {
  return useNodeClassPropertyEdgesAdapter(classUuids);
}

export function useClassExtends(classId: string | null): UseQueryResult<ClassExtends[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId ?? '');
  const classes = useClassRows();
  const [data, setData] = useState<ClassExtends[] | undefined>(undefined);

  useEffect(() => {
    if (!client || !classId) {
      setData(undefined);
      return;
    }
    const cancelled = { value: false };
    const update = (): void => {
      client
        .query<ClassExtends[]>('getClassExtends', [classId, classes])
        .then((result) => {
          if (!cancelled.value) setData(result);
        })
        .catch((err) => {
          console.error('[useClassExtends] query failed:', err);
        });
    };
    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled.value = true;
      unsubscribe();
    };
  }, [client, classId, classes]);

  return toQueryResult(data, isLoading, error);
}

export function useInheritedProperties(classId: string | null): UseQueryResult<InheritedProperty[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId ?? '');
  const classes = useClassRows();
  const [data, setData] = useState<InheritedProperty[] | undefined>(undefined);

  useEffect(() => {
    if (!client || !classId) {
      setData(undefined);
      return;
    }
    const cancelled = { value: false };
    const update = (): void => {
      client
        .query<InheritedProperty[]>('getInheritedProperties', [classId, classes])
        .then((result) => {
          if (!cancelled.value) setData(result);
        })
        .catch((err) => {
          console.error('[useInheritedProperties] query failed:', err);
        });
    };
    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled.value = true;
      unsubscribe();
    };
  }, [client, classId, classes]);

  return toQueryResult(data, isLoading, error);
}

export function useExtendedByClasses(classId: string | null): UseQueryResult<ExtendedByClass[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId ?? '');
  const classes = useClassRows();
  const [data, setData] = useState<ExtendedByClass[] | undefined>(undefined);

  useEffect(() => {
    if (!client || !classId) {
      setData(undefined);
      return;
    }
    const cancelled = { value: false };
    const update = (): void => {
      client
        .query<ExtendedByClass[]>('getExtendedByClasses', [classId, classes])
        .then((result) => {
          if (!cancelled.value) setData(result);
        })
        .catch((err) => {
          console.error('[useExtendedByClasses] query failed:', err);
        });
    };
    update();
    const unsubscribe = client.subscribe(null, update);
    return () => {
      cancelled.value = true;
      unsubscribe();
    };
  }, [client, classId, classes]);

  return toQueryResult(data, isLoading, error);
}

export function useValidateClassExtends() {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  return {
    mutate: async ({
      classId,
      extendsIds,
    }: {
      classId: string;
      extendsIds: string[];
    }): Promise<{ valid: boolean; error?: string; cycle_path?: string[] }> => {
      if (!client) {
        return { valid: true };
      }

      return client.query<{ valid: boolean; error?: string; cycle_path?: string[] }>(
        'validateClassExtends',
        [classId, extendsIds]
      );
    },
  };
}
