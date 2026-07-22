import { useEffect, useState } from 'react';
import type { NodeRow } from '../store';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';

export interface UseNodeResult {
  node: NodeRow | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useNode(workspaceId: string, nodeId: string | undefined): UseNodeResult {
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId);
  const [node, setNode] = useState<NodeRow | undefined>(undefined);

  useEffect(() => {
    if (!client || !nodeId) {
      setNode(undefined);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<NodeRow | undefined>('getNode', [nodeId])
        .then((result) => {
          if (!cancelled) {
            setNode(result);
          }
        })
        .catch((err) => {
          console.error('[useNode] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(nodeId, update);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, nodeId]);

  return { node, isLoading, error };
}
