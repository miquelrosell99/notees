import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { queryAll, queryOne } from '../db/sqlite';
import type { ChangeNotification } from './index';

interface AstNode {
  type: string;
  text?: string;
  children?: AstNode[];
}

function collectText(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, parts);
  } else if (value && typeof value === 'object') {
    const node = value as AstNode;
    if (node.type === 'text' && typeof node.text === 'string') {
      parts.push(node.text);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) collectText(child, parts);
    }
  }
}

function normalizeClassName(name: unknown): string {
  if (typeof name !== 'string') return 'Untitled class';
  const trimmed = name.trim();
  if (!trimmed) return 'Untitled class';
  if (trimmed.startsWith('[')) {
    try {
      const ast = JSON.parse(trimmed) as unknown;
      if (Array.isArray(ast)) {
        const parts: string[] = [];
        collectText(ast, parts);
        return parts.join('').trim() || 'Untitled class';
      }
    } catch {
      // Not valid JSON — fall through to returning the raw string.
    }
  }
  return trimmed;
}

function computeAncestors(db: Database, classId: string, extendsClassIds: string[]): string[] {
  const ancestors = new Set<string>();
  const visited = new Set<string>([classId]);
  const stack = [...extendsClassIds];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    ancestors.add(current);
    const rows = queryAll<{ ancestor_id: string }>(
      db,
      'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?',
      [current]
    );
    for (const row of rows) stack.push(row.ancestor_id);
  }
  return [...ancestors].sort();
}

function parseStoredExtends(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as string[]) : [];
  } catch {
    return [];
  }
}

export function classExtendsWouldCycle(
  db: Database,
  classId: string,
  extendsClassIds: string[]
): string | null {
  for (const parentId of extendsClassIds) {
    if (parentId === classId) return parentId;
    const row = queryOne<{ found: number }>(
      db,
      'SELECT 1 AS found FROM class_hierarchy WHERE class_id = ? AND ancestor_id = ? LIMIT 1',
      [parentId, classId]
    );
    if (row) return parentId;
  }
  return null;
}

function applyClassHierarchy(
  db: Database,
  classId: string,
  extendsClassIds: string[],
  seen?: Set<string>
): void {
  const visitedClasses = seen ?? new Set<string>();
  if (visitedClasses.has(classId)) return;
  visitedClasses.add(classId);

  db.run('DELETE FROM class_hierarchy WHERE class_id = ?', [classId]);
  db.run(
    'INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)',
    [classId, classId]
  );
  for (const ancestorId of computeAncestors(db, classId, extendsClassIds)) {
    db.run(
      'INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)',
      [classId, ancestorId]
    );
  }

  const children = queryAll<{ id: string; extends_class_ids: string | null }>(
    db,
    'SELECT id, extends_class_ids FROM class WHERE id != ?',
    [classId]
  );
  for (const child of children) {
    const childExtends = parseStoredExtends(child.extends_class_ids);
    if (childExtends.includes(classId)) {
      applyClassHierarchy(db, child.id, childExtends, visitedClasses);
    }
  }
}

export function applyClassOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;
  const ts = new Date().toISOString();

  if (opType === 'class.create') {
    const classId = payload.classId as string;
    const name = normalizeClassName(payload.name);
    const icon = (payload.icon as string | null | undefined) ?? null;
    const color = (payload.color as string | null | undefined) ?? null;
    const extendsClassIds = Array.isArray(payload.extends)
      ? (payload.extends as string[])
      : [];

    db.run(
      `INSERT OR REPLACE INTO class (
        id, workspace_id, name, icon, color, description, extends_class_ids,
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [classId, op.envelope.workspaceId, name, icon, color, null, JSON.stringify(extendsClassIds), 1, ts, ts]
    );
    applyClassHierarchy(db, classId, extendsClassIds);
    return [{ scope: 'class', nodeId: classId }];
  }

  if (opType === 'class.update') {
    const classId = payload.classId as string;
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if ('name' in payload) {
      sets.push('name = ?');
      values.push(normalizeClassName(payload.name));
    }
    if ('icon' in payload) {
      sets.push('icon = ?');
      values.push(payload.icon as string | null);
    }
    if ('color' in payload) {
      sets.push('color = ?');
      values.push(payload.color as string | null);
    }
    if ('description' in payload) {
      sets.push('description = ?');
      values.push(payload.description as string | null);
    }

    let hierarchyChanged = false;
    if ('extends' in payload) {
      const extendsClassIds = Array.isArray(payload.extends) ? (payload.extends as string[]) : [];
      applyClassHierarchy(db, classId, extendsClassIds);
      hierarchyChanged = true;
    }

    if (sets.length === 0) {
      return hierarchyChanged ? [{ scope: 'class', nodeId: classId }] : [];
    }

    sets.push('updated_at = ?');
    values.push(ts, classId);

    db.run(`UPDATE class SET ${sets.join(', ')} WHERE id = ?`, values);
    return [{ scope: 'class', nodeId: classId }];
  }

  if (opType === 'class.delete') {
    const classId = payload.classId as string;
    db.run('UPDATE class SET active = 0, updated_at = ? WHERE id = ?', [ts, classId]);
    return [{ scope: 'class', nodeId: classId }];
  }

  if (opType === 'class.setExtends') {
    const classId = payload.classId as string;
    const extendsClassIds = Array.isArray(payload.extendsClassIds)
      ? (payload.extendsClassIds as string[])
      : Array.isArray(payload.extends)
        ? (payload.extends as string[])
        : [];

    db.run('UPDATE class SET extends_class_ids = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(extendsClassIds),
      ts,
      classId,
    ]);
    applyClassHierarchy(db, classId, extendsClassIds);
    return [{ scope: 'class', nodeId: classId, relatedIds: extendsClassIds }];
  }

  return [];
}
