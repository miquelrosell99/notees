import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkspaceStore } from './useWorkspaceStore';

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
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');
  const [value, setValue] = useState<unknown>(undefined);

  useEffect(() => {
    if (!store || !nodeId || !schemaId) {
      setValue(undefined);
      return;
    }

    const update = (): void => {
      const row = store.getProperty({ nodeId, schemaId, index });
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
    return store.subscribe(nodeId, update);
  }, [store, nodeId, schemaId, index]);

  return { value, isLoading, error };
}
