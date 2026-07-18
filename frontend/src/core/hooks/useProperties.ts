import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { queryAll } from '../db/sqlite';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface UsePropertiesResult {
  properties: Record<string, unknown[]>;
  isLoading: boolean;
  error: Error | null;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Aggregate all property values for a node, keyed by property schema UUID.
 */
export function useProperties(nodeId: string): UsePropertiesResult {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');
  const [properties, setProperties] = useState<Record<string, unknown[]>>({});

  useEffect(() => {
    if (!store || !nodeId) {
      setProperties({});
      return;
    }

    const update = (): void => {
      const rows = queryAll<{
        property_schema_id: string;
        value: string;
        idx: number;
      }>(
        store.getDb(),
        'SELECT property_schema_id, value, idx FROM property_value WHERE node_id = ? ORDER BY idx',
        [nodeId]
      );

      const map: Record<string, unknown[]> = {};
      for (const row of rows) {
        const list = (map[row.property_schema_id] ??= []);
        list[row.idx] = parseValue(row.value);
      }
      setProperties(map);
    };

    update();
    return store.subscribe(nodeId, update);
  }, [store, nodeId]);

  return { properties, isLoading, error };
}
