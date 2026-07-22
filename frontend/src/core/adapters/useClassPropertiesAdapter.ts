import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Database } from 'sql.js';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ClassProperty, PropertyType } from '@/types/api';
import { useWorkspaceStore } from '../hooks/useWorkspaceStore';
import { queryAll, queryOne } from '../db/sqlite';
import { orderClassPropertyEdges } from '@/features/properties/utils/classPropertyEdges';

// TODO: Migrate to the async WorkspaceStoreClient. This adapter runs raw SQL
// against `store.getDb()`, which is not transferable from a Web Worker. Add
// worker-side query methods for class-property edges before switching to
// `useWorkspaceStoreClient` and `getOrCreateWorkspaceStoreClient`.

function toQueryResult<TData>(
  data: TData | undefined,
  isLoading: boolean,
  error: Error | null
): UseQueryResult<TData, Error> {
  const isErrorState = error !== null;
  const status: UseQueryResult<TData, Error>['status'] = isLoading
    ? 'pending'
    : isErrorState
      ? 'error'
      : 'success';

  return {
    data,
    isLoading,
    isError: isErrorState,
    error,
    isPending: isLoading,
    isSuccess: !isLoading && !isErrorState,
    status,
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<TData, Error>;
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
    'integer', 'float', 'text', 'boolean', 'url', 'email', 'node', 'selection', 'date', 'date_range', 'image',
  ]);
  return validTypes.has(type as PropertyType) ? (type as PropertyType) : 'text';
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

function fetchAncestorEdges(
  db: Database,
  classId: string
): EdgeRow[] {
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
 * Adapter for fetching properties linked to a class.
 */
export function useClassPropertiesAdapter(
  classId: string | null,
  includeInherited: boolean = false
): UseQueryResult<ClassProperty[], Error> {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading, error } = useWorkspaceStore(workspaceId ?? '');
  const [data, setData] = useState<ClassProperty[] | undefined>(undefined);

  useEffect(() => {
    if (!store || !classId) {
      setData(undefined);
      return;
    }
    const update = (): void => {
      setData(buildClassProperties(store.getDb(), classId, includeInherited));
    };
    update();
    return store.subscribeAll(update);
  }, [store, classId, includeInherited]);

  return toQueryResult(data, isLoading, error);
}

/**
 * Adapter for fetching class-property edges for all classes of a node.
 */
export function useNodeClassPropertyEdgesAdapter(classUuids: string[]): ClassProperty[] {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');
  const [data, setData] = useState<ClassProperty[]>([]);

  useEffect(() => {
    if (!store || classUuids.length === 0) {
      setData([]);
      return;
    }
    const db = store.getDb();
    const update = (): void => {
      const perClassEdges = classUuids.map((classId) =>
        buildClassProperties(db, classId, true)
      );
      setData(orderClassPropertyEdges(classUuids, perClassEdges));
    };
    update();
    return store.subscribeAll(update);
  }, [store, classUuids]);

  return data;
}
