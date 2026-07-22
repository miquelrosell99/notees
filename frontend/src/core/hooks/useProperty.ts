import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';

export interface UsePropertyResult {
  value: unknown;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Read a single property value for a node from the SQLite store.
 */
export function useProperty(args: {
  nodeId: string;
  schemaId: string;
  index?: number;
}): UsePropertyResult {
  const { nodeId, schemaId, index } = args;
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId ?? '');
  const [value, setValue] = useState<unknown>(undefined);

  useEffect(() => {
    if (!client || !nodeId || !schemaId) {
      setValue(undefined);
      return;
    }

    let cancelled = false;

    const update = async (): Promise<void> => {
      const row = await client.query<{ value: string } | undefined>('getProperty', [
        { nodeId, schemaId, index },
      ]);
      if (cancelled) return;
      if (!row) {
        setValue(undefined);
        return;
      }
      try {
        setValue(JSON.parse(row.value));
      } catch {
        setValue(row.value);
      }
    };

    update();
    const unsubscribe = client.subscribe(nodeId, update);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, nodeId, schemaId, index]);

  return { value, isLoading, error };
}
