import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { queryAll } from '../db/sqlite';
import type { Property, PropertyIconVisibility, PropertyScope, PropertyType, SelectionOption } from '@/types/api';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface UsePropertySchemasResult {
  schemas: Property[];
  isLoading: boolean;
  error: Error | null;
}

function safePropertyType(type: string): PropertyType {
  const validTypes = new Set<PropertyType>([
    'integer', 'float', 'text', 'boolean', 'url', 'email', 'node', 'selection', 'date', 'date_range', 'image',
  ]);
  return validTypes.has(type as PropertyType) ? (type as PropertyType) : 'text';
}

function safeIconVisibility(value: string | null): PropertyIconVisibility {
  if (value === 'before_content' || value === 'after_bullet') return value;
  return 'hidden';
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Read property schema definitions from the property_schema table.
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
      const rows = queryAll<{
        id: string;
        name: string;
        icon: string | null;
        type: string;
        multi: number;
        scope: string;
        node_id: string | null;
        icon_visibility: string | null;
        validation_rules: string | null;
        required: number;
        readonly: number;
        hide_when_empty: number;
        default_value: string | null;
        class_filter_uuids: string;
        options: string;
        created_at: string | null;
        updated_at: string | null;
      }>(
        store.getDb(),
        `SELECT
           id,
           name,
           icon,
           type,
           multi,
           scope,
           node_id AS node_id,
           icon_visibility AS icon_visibility,
           validation_rules,
           required,
           readonly,
           hide_when_empty,
           default_value,
           class_filter_uuids,
           options,
           created_at,
           updated_at
         FROM property_schema
         WHERE workspace_id = ? AND active = 1
         ORDER BY name`,
        [store.getWorkspaceId()]
      );

      setSchemas(
        rows.map((row) => ({
          uuid: row.id,
          name: row.name,
          icon: row.icon,
          type: safePropertyType(row.type),
          multi: row.multi !== 0,
          is_system: false,
          scope: (row.scope as PropertyScope) ?? 'global',
          node_uuid: row.node_id,
          icon_visibility: safeIconVisibility(row.icon_visibility),
          validation_rules: parseJson<Record<string, unknown> | null>(row.validation_rules, null),
          required: row.required !== 0,
          readonly: row.readonly !== 0,
          hide_when_empty: row.hide_when_empty !== 0,
          default_value: parseJson<unknown | null>(row.default_value, null),
          create_date: row.created_at ?? new Date().toISOString(),
          write_date: row.updated_at ?? new Date().toISOString(),
          class_filter_uuids: parseJson<string[]>(row.class_filter_uuids, []),
          options: parseJson<SelectionOption[]>(row.options, []),
        }))
      );
    };

    update();
    return store.subscribeAll(update);
  }, [store]);

  return { schemas, isLoading, error };
}
