/**
 * useClasses — local-first class list from the dedicated class table.
 *
 * Replaces the legacy queryNodes-based class lookup. Classes are no longer
 * nodes with kind='class'; they live in the `class` derived table.
 */
import { useEffect, useState } from 'react';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';
import type { ClassRow } from '@/core/query/classes';

export interface UseClassesResult {
  data: ClassRow[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useClasses(options?: { enabled?: boolean }): UseClassesResult {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const enabled = options?.enabled ?? true;
  const { client, isLoading, error } = useWorkspaceStoreClient(
    enabled && workspaceUuid ? workspaceUuid : undefined
  );

  const [data, setData] = useState<ClassRow[] | undefined>(undefined);

  useEffect(() => {
    if (!client || !workspaceUuid) {
      setData(undefined);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<ClassRow[]>('listClasses', [workspaceUuid])
        .then((result) => {
          if (!cancelled) {
            setData(result);
          }
        })
        .catch((err) => {
          console.error('[useClasses] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(null, update);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, workspaceUuid]);

  return {
    data,
    isLoading,
    error,
  };
}
