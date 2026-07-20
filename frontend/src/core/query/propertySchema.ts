/**
 * Property schema queries against the local SQLite derived store.
 */
import type { Property, PropertyIconVisibility, PropertyScope, PropertyType, SelectionOption } from '@/types/api';
import type { WorkspaceStore } from '../store';
import { queryAll } from '../db/sqlite';

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

function rowToProperty(row: Record<string, unknown>): Property {
  return {
    uuid: row.id as string,
    name: row.name as string,
    icon: (row.icon as string | null) ?? null,
    type: safePropertyType(row.type as string),
    multi: (row.multi as number) !== 0,
    is_system: false,
    scope: ((row.scope as string) ?? 'global') as PropertyScope,
    node_uuid: (row.node_id as string | null) ?? null,
    icon_visibility: safeIconVisibility(row.icon_visibility as string | null),
    validation_rules: parseJson<Record<string, unknown> | null>(row.validation_rules as string | null, null),
    required: (row.required as number) !== 0,
    readonly: (row.readonly as number) !== 0,
    hide_when_empty: (row.hide_when_empty as number) !== 0,
    default_value: parseJson<unknown | null>(row.default_value as string | null, null),
    create_date: (row.created_at as string | null) ?? new Date().toISOString(),
    write_date: (row.updated_at as string | null) ?? new Date().toISOString(),
    class_filter_uuids: parseJson<string[]>(row.class_filter_uuids as string, []),
    options: parseJson<SelectionOption[]>(row.options as string, []),
  };
}

/**
 * Return a property schema by UUID, or undefined if not found.
 */
export function getPropertySchemaByUuid(store: WorkspaceStore, schemaId: string): Property | undefined {
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
       node_id,
       icon_visibility,
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
     WHERE id = ? AND workspace_id = ? AND active = 1`,
    [schemaId, store.getWorkspaceId()]
  );

  if (rows.length === 0) return undefined;
  return rowToProperty(rows[0]);
}
