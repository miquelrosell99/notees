/**
 * Worker-side query helpers for property schemas and values.
 *
 * These functions run against the sql.js Database inside the Web Worker (or the
 * inline jsdom shim). They are invoked through IWorkspaceStoreClient.query by
 * name and return fully serialisable results.
 */

import type { Database } from 'sql.js';
import type {
  BatchPropertiesResult,
  ClassProperty,
  Property,
  PropertyIconVisibility,
  PropertyScope,
  PropertyType,
  SelectionOption,
} from '@/types/api';
import { queryAll, queryOne } from '../db/sqlite';
import type { WorkspaceStore } from '../store';

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safePropertyType(type: string): PropertyType {
  const validTypes = new Set<PropertyType>([
    'integer',
    'float',
    'text',
    'boolean',
    'url',
    'email',
    'node',
    'selection',
    'date',
    'date_range',
    'image',
  ]);
  return validTypes.has(type as PropertyType) ? (type as PropertyType) : 'text';
}

function safeIconVisibility(value: string | null): PropertyIconVisibility {
  if (value === 'before_content' || value === 'after_bullet') return value;
  return 'hidden';
}

interface PropertySchemaRow {
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
}

function rowToProperty(row: PropertySchemaRow): Property {
  return {
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
  };
}

/**
 * Aggregate all property values for a node, keyed by property schema UUID.
 */
export function getNodeProperties(store: WorkspaceStore, nodeId: string): Record<string, unknown[]> {
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
  return map;
}

/**
 * Return a property schema by UUID, or undefined if not found.
 */
export function getPropertySchemaByUuid(store: WorkspaceStore, schemaId: string): Property | undefined {
  const rows = queryAll<PropertySchemaRow>(
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
     WHERE id = ? AND workspace_id = ? AND active = 1`,
    [schemaId, store.getWorkspaceId()]
  );

  if (rows.length === 0) return undefined;
  return rowToProperty(rows[0]);
}

/**
 * Read active property schema definitions for the current workspace.
 */
export function getPropertySchemas(store: WorkspaceStore): Property[] {
  const rows = queryAll<PropertySchemaRow>(
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

  return rows.map(rowToProperty);
}

/**
 * Batch-fetch property values for multiple nodes.
 */
export function getBatchPropertyValues(store: WorkspaceStore, nodeUuids: string[]): BatchPropertiesResult {
  const result: BatchPropertiesResult = {};
  if (nodeUuids.length === 0) return result;

  for (const nodeId of nodeUuids) {
    const rows = queryAll<{ property_schema_id: string; value: string }>(
      store.getDb(),
      'SELECT property_schema_id, value FROM property_value WHERE node_id = ?',
      [nodeId]
    );
    const map: Record<string, unknown> = {};
    for (const row of rows) {
      map[row.property_schema_id] = parseValue(row.value);
    }
    result[nodeId] = map;
  }
  return result;
}

interface EdgeRow {
  class_id: string;
  property_schema_id: string;
  sequence: number;
  default_value: string | null;
  hidden: number;
  required: number | null;
  readonly: number | null;
  hide_when_empty: number | null;
  property_name: string;
  property_type: string;
}

function fetchClassName(db: Database, classId: string): string | null {
  const row = queryOne<{ content: string }>(
    db,
    'SELECT content FROM node WHERE id = ? AND kind = ?',
    [classId, 'class']
  );
  if (!row) return null;
  try {
    const content = JSON.parse(row.content) as unknown[];
    const text = content
      .map((c) => (c as { text?: string }).text ?? '')
      .join('')
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

function rowToClassProperty(db: Database, row: EdgeRow): ClassProperty {
  return {
    class_node_uuid: row.class_id,
    class_node_name: fetchClassName(db, row.class_id) ?? row.class_id,
    property_uuid: row.property_schema_id,
    property_name: row.property_name,
    property_type: safePropertyType(row.property_type),
    sequence: row.sequence,
    default_value: parseJson<unknown | null>(row.default_value, null),
    hidden: row.hidden !== 0,
    required: row.required === null ? null : row.required !== 0,
    readonly: row.readonly === null ? null : row.readonly !== 0,
    hide_when_empty: row.hide_when_empty === null ? null : row.hide_when_empty !== 0,
  };
}

function fetchDirectEdges(db: Database, classId: string): EdgeRow[] {
  return queryAll<EdgeRow>(
    db,
    `SELECT
       e.class_id,
       e.property_schema_id,
       e.sequence,
       e.default_value,
       e.hidden,
       e.required,
       e.readonly,
       e.hide_when_empty,
       s.name AS property_name,
       s.type AS property_type
     FROM class_property_edge e
     JOIN property_schema s ON s.id = e.property_schema_id
     WHERE e.class_id = ? AND s.active = 1
     ORDER BY e.sequence`,
    [classId]
  );
}

function fetchAncestorEdges(db: Database, classId: string): EdgeRow[] {
  return queryAll<EdgeRow>(
    db,
    `SELECT
       e.class_id,
       e.property_schema_id,
       e.sequence,
       e.default_value,
       e.hidden,
       e.required,
       e.readonly,
       e.hide_when_empty,
       s.name AS property_name,
       s.type AS property_type
     FROM class_hierarchy h
     JOIN class_property_edge e ON e.class_id = h.ancestor_id
     JOIN property_schema s ON s.id = e.property_schema_id
     WHERE h.class_id = ? AND h.ancestor_id != ? AND s.active = 1
     ORDER BY e.sequence`,
    [classId, classId]
  );
}

function buildClassProperties(
  db: Database,
  classId: string,
  includeInherited: boolean
): ClassProperty[] {
  const direct = fetchDirectEdges(db, classId).map((row) => rowToClassProperty(db, row));
  if (!includeInherited) return direct;

  const seen = new Set(direct.map((e) => e.property_uuid));
  const inherited = fetchAncestorEdges(db, classId)
    .filter((row) => !seen.has(row.property_schema_id))
    .map((row) => rowToClassProperty(db, row));
  return [...direct, ...inherited];
}

/**
 * Fetch class-property edges for a single class.
 */
export function getClassProperties(
  store: WorkspaceStore,
  classId: string,
  includeInherited: boolean
): ClassProperty[] {
  return buildClassProperties(store.getDb(), classId, includeInherited);
}

/**
 * Raw property-schema ids bound to a class, without joining property_schema.
 * Unlike getClassProperties, edges whose schema row does not exist locally
 * (e.g. base system properties not yet synced) are still returned — the
 * local seed's idempotency check depends on this.
 */
export function getClassPropertyEdgeIds(store: WorkspaceStore, classId: string): string[] {
  return queryAll<{ property_schema_id: string }>(
    store.getDb(),
    'SELECT property_schema_id FROM class_property_edge WHERE class_id = ?',
    [classId]
  ).map((row) => row.property_schema_id);
}

/**
 * Fetch class-property edges for multiple classes.
 */
export function getNodeClassPropertyEdges(
  store: WorkspaceStore,
  classUuids: string[]
): ClassProperty[][] {
  return classUuids.map((classId) => buildClassProperties(store.getDb(), classId, true));
}
