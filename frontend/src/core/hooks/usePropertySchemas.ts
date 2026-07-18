import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { queryAll } from '../db/sqlite';
import type { Property } from '@/types/api';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface UsePropertySchemasResult {
  schemas: Property[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * Derive property schema definitions from the property_value table.
 *
 * TODO(D3): Full schema CRUD is not implemented in the SQLite prototype slice.
 * This hook returns minimal Property objects inferred from existing values.
 */
export function usePropertySchemas(): UsePropertySchemasResult {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');
  const [schemas, setSchemas] = useState<Property[]>([]);

  useEffect(() => {
    if (!store) {
      setSchemas([]);
      return;
    }

    const update = (): void => {
      const rows = queryAll<{ property_schema_id: string }>(
        store.getDb(),
        'SELECT DISTINCT property_schema_id FROM property_value'
      );

      // TODO(D3): replace with proper schema table once CRUD is wired.
      setSchemas(
        rows.map((row) => ({
          uuid: row.property_schema_id,
          name: row.property_schema_id,
          icon: null,
          type: 'text' as const,
          multi: false,
          is_system: false,
          scope: 'global' as const,
          node_uuid: null,
          icon_visibility: 'hidden' as const,
          validation_rules: null,
          required: false,
          readonly: false,
          hide_when_empty: false,
          default_value: null,
          create_date: new Date().toISOString(),
          write_date: new Date().toISOString(),
          class_filter_uuids: [],
          options: [],
        }))
      );
    };

    update();
  }, [store]);

  return { schemas, isLoading, error };
}
