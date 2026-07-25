import { type Database } from 'sql.js';
import { queryAll, queryOne } from '../db/sqlite';

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
