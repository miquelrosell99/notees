import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';

export interface UsePropertiesResult {
  properties: Record<string, unknown[]>;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Aggregate all property values for a node, keyed by property schema UUID.
 */
export function useProperties(nodeId: string): UsePropertiesResult {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId);
  const [properties, setProperties] = useState<Record<string, unknown[]>>({});
  const [queryError, setQueryError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !nodeId) {
      setProperties({});
      setQueryError(null);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<Record<string, unknown[]>>('getNodeProperties', [nodeId])
        .then((result) => {
          if (!cancelled) {
            setProperties(result);
            setQueryError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setQueryError(err instanceof Error ? err : new Error(String(err)));
          }
          console.error('[useProperties] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(nodeId, update);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, nodeId]);

  return { properties, isLoading, error: error ?? queryError };
}
