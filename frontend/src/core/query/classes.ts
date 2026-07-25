import { type Database } from 'sql.js';
import { queryAll, queryOne } from '../db/sqlite';
import type { Node } from '@/types/api';

export interface ClassRow {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  color: string | null;
  description: string | null;
  extendsClassIds: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Project a class table row into the legacy Node shape.
 *
 * The UI still renders classes as if they were a kind of node (icon, color,
 * name, uuid). This adapter lets components keep using Node-based primitives
 * while the underlying source of truth is the dedicated `class` table.
 */
export function classRowToNode(row: ClassRow): Node {
  const now = new Date().toISOString();
  return {
    uuid: row.id,
    name: row.name,
    content: JSON.stringify([{ type: 'text', text: row.name }]),
    icon: row.icon,
    color: row.color,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: row.active,
    is_page: false,
    is_class: true,
    create_date: row.createdAt ?? now,
    write_date: row.updatedAt ?? now,
    open_date: null,
    tags_uuid: [],
    classes_uuid: [],
    classes_path_uuid: [],
    properties_uuid: {},
    children: undefined,
    has_children: false,
    backlinks: [],
    linked_references: [],
    backlink_count: 0,
    comment_count: 0,
    aliases_uuid: [],
    aliased_uuid: null,
    extends_uuid: row.extendsClassIds,
    is_private: false,
    parent_locked: false,
  };
}

const SELECT_COLUMNS = `
  id,
  workspace_id AS workspaceId,
  name,
  icon,
  color,
  description,
  extends_class_ids AS extendsClassIds,
  active,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function rowToClassRow(row: Record<string, unknown>): ClassRow {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    name: row.name as string,
    icon: row.icon as string | null,
    color: row.color as string | null,
    description: row.description as string | null,
    extendsClassIds: parseExtendsClassIds(row.extendsClassIds),
    active: row.active === 1,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function parseExtendsClassIds(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value as string[];
  }
  return [];
}

export function listClasses(db: Database, workspaceId: string): ClassRow[] {
  const rows = queryAll<Record<string, unknown>>(
    db,
    `SELECT ${SELECT_COLUMNS} FROM class WHERE workspace_id = ? AND active = 1 ORDER BY name`,
    [workspaceId]
  );
  return rows.map(rowToClassRow);
}

export function getClass(db: Database, classId: string): ClassRow | undefined {
  const row = queryOne<Record<string, unknown>>(
    db,
    `SELECT ${SELECT_COLUMNS} FROM class WHERE id = ?`,
    [classId]
  );
  return row ? rowToClassRow(row) : undefined;
}
