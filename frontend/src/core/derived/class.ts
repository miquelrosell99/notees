import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { queryAll } from '../db/sqlite';
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

function applyClassHierarchy(db: Database, classId: string, extendsClassIds: string[]): void {
  db.run('DELETE FROM class_hierarchy WHERE class_id = ?', [classId]);
  db.run(
    'INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)',
    [classId, classId]
  );
  for (const ancestorId of extendsClassIds) {
    db.run(
      'INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)',
      [classId, ancestorId]
    );
    const rows = queryAll<{ ancestor_id: string }>(
      db,
      'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?',
      [ancestorId]
    );
    for (const row of rows) {
      db.run(
        'INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)',
        [classId, row.ancestor_id]
      );
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

    if (sets.length === 0) return [];

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
