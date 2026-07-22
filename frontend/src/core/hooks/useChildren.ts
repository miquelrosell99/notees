import { useEffect, useState } from 'react';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';

export interface UseChildrenResult {
  children: string[];
  isLoading: boolean;
  error: Error | null;
}

export function useChildren(workspaceId: string, parentId: string | undefined): UseChildrenResult {
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId);
  const [children, setChildren] = useState<string[]>([]);

  useEffect(() => {
    if (!client || !parentId) {
      setChildren([]);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<string[]>('getChildren', [parentId])
        .then((result) => {
          if (!cancelled) {
            setChildren(result);
          }
        })
        .catch((err) => {
          console.error('[useChildren] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(parentId, update);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, parentId]);

  return { children, isLoading, error };
}
