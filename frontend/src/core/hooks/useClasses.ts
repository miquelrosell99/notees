/**
 * useClasses — local-first class list from the core workspace store.
 *
 * Replaces the legacy `/api/nodes/classes` TanStack Query hook. Classes are
 * nodes with the `isClass` flag derived from the operation log.
 */
import { useEffect, useState } from 'react';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';
import type { Node } from '@/types/api';

export interface UseClassesResult {
  data: Node[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useClasses(options?: { enabled?: boolean }): UseClassesResult {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const enabled = options?.enabled ?? true;
  const { client, isLoading, error } = useWorkspaceStoreClient(
    enabled && workspaceUuid ? workspaceUuid : undefined
  );

  const [data, setData] = useState<Node[] | undefined>(undefined);

  useEffect(() => {
    if (!client) {
      setData(undefined);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<Node[]>('queryNodes', [{ isClass: true, projectionDepth: 0 }])
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
  }, [client]);

  return {
    data,
    isLoading,
    error,
  };
}
