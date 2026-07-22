import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Property } from '@/types/api';
import { useWorkspaceStoreClient } from './useWorkspaceStoreClient';

export interface UsePropertySchemasResult {
  schemas: Property[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * Read property schema definitions from the property_schema table.
 */
export function usePropertySchemas(): UsePropertySchemasResult {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client, isLoading, error } = useWorkspaceStoreClient(workspaceId);
  const [schemas, setSchemas] = useState<Property[]>([]);

  useEffect(() => {
    if (!client) {
      setSchemas([]);
      return;
    }

    let cancelled = false;
    const update = (): void => {
      client
        .query<Property[]>('getPropertySchemas', [])
        .then((result) => {
          if (!cancelled) {
            setSchemas(result);
          }
        })
        .catch((err) => {
          console.error('[usePropertySchemas] query failed:', err);
        });
    };

    update();
    const unsubscribe = client.subscribe(null, update);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  return { schemas, isLoading, error };
}
