/**
 * React Query hook for property suggestions.
 *
 * Derives usage-ranked suggestions locally from the SQLite derived store.
 */
import { useParams } from 'react-router-dom';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { queryAll } from '@/core/db/sqlite';
import { propertyKeys } from '@/hooks/queryKeys';
import { useQuery } from '@tanstack/react-query';

export function usePropertySuggestions(contextNodeUuid?: string, options?: { enabled?: boolean }) {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading: storeLoading, error: _error } = useWorkspaceStore(workspaceId ?? '');
  const enabled = options?.enabled ?? true;

  return useQuery({
    queryKey: propertyKeys.suggestions(contextNodeUuid),
    queryFn: () => {
      if (!store) return [];
      const db = store.getDb();

      // Count how many nodes have a value for each property schema.
      const usageRows = queryAll<{ property_schema_id: string; usage_count: number }>(
        db,
        `SELECT property_schema_id, COUNT(DISTINCT node_id) AS usage_count
         FROM property_value
         GROUP BY property_schema_id`
      );
      const usageMap = new Map(usageRows.map((r) => [r.property_schema_id, r.usage_count]));

      // Optionally determine which properties the context node already has.
      const nodePropertyIds = new Set<string>();
      if (contextNodeUuid) {
        const nodeRows = queryAll<{ property_schema_id: string }>(
          db,
          'SELECT DISTINCT property_schema_id FROM property_value WHERE node_id = ?',
          [contextNodeUuid]
        );
        for (const row of nodeRows) {
          nodePropertyIds.add(row.property_schema_id);
        }
      }

      const schemaRows = queryAll<{ id: string; name: string; icon: string | null; type: string }>(
        db,
        `SELECT id, name, icon, type
         FROM property_schema
         WHERE workspace_id = ? AND active = 1`,
        [store.getWorkspaceId()]
      );

      return schemaRows
        .map((schema) => ({
          property_uuid: schema.id,
          name: schema.name,
          icon: schema.icon,
          type: schema.type,
          usage_count: usageMap.get(schema.id) ?? 0,
          already_assigned: contextNodeUuid ? nodePropertyIds.has(schema.id) : false,
        }))
        .sort((a, b) => b.usage_count - a.usage_count);
    },
    enabled: enabled && !storeLoading && !!store,
    staleTime: 30_000,
  });
}
