import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { queryAll, queryOne } from '../db/sqlite';

function deriveNameFromContent(content: unknown[]): string {
  for (const item of content) {
    if (typeof item === 'object' && item !== null && 'text' in item) {
      const text = (item as { text?: string }).text;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  return 'Untitled class';
}

function getNodeKind(db: Database, nodeId: string): string | null {
  const row = queryOne<{ kind: string }>(db, 'SELECT kind FROM node WHERE id = ?', [nodeId]);
  return row?.kind ?? null;
}

function getNodeContent(db: Database, nodeId: string): unknown[] {
  const row = queryOne<{ content: string }>(db, 'SELECT content FROM node WHERE id = ?', [nodeId]);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.content) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

export function applyClassOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;
  const ts = new Date().toISOString();

  if (opType === 'node.create' || opType === 'node.convert') {
    if (payload.kind !== 'class') return;

    const nodeId = payload.nodeId as string;
    let content: unknown[] = [];
    if (Array.isArray(payload.initialContent)) {
      content = payload.initialContent as unknown[];
    } else if (opType === 'node.convert') {
      content = getNodeContent(db, nodeId);
    }
    const name = deriveNameFromContent(content);

    db.run(
      `INSERT OR REPLACE INTO class (
        id, workspace_id, name, description, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nodeId, op.envelope.workspaceId, name, null, 1, ts, ts]
    );
  } else if (opType === 'node.updateContent') {
    const nodeId = payload.nodeId as string;
    if (getNodeKind(db, nodeId) !== 'class') return;

    const content = getNodeContent(db, nodeId);
    const name = deriveNameFromContent(content);

    db.run('UPDATE class SET name = ?, description = ?, updated_at = ? WHERE id = ?', [
      name,
      null,
      ts,
      nodeId,
    ]);
  } else if (opType === 'node.delete') {
    const nodeId = payload.nodeId as string;
    if (getNodeKind(db, nodeId) !== 'class') return;

    db.run('UPDATE class SET active = 0, updated_at = ? WHERE id = ?', [ts, nodeId]);
  } else if (opType === 'class.create') {
    const classId = payload.classId as string;
    const name = (payload.name as string) ?? 'Untitled class';
    const icon = (payload.icon as string | null | undefined) ?? null;
    const color = (payload.color as string | null | undefined) ?? null;

    db.run(
      `INSERT OR REPLACE INTO class (
        id, workspace_id, name, icon, color, description, extends_class_ids,
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [classId, op.envelope.workspaceId, name, icon, color, null, '[]', 1, ts, ts]
    );
  } else if (opType === 'class.update') {
    const classId = payload.classId as string;
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if ('name' in payload) {
      sets.push('name = ?');
      values.push(payload.name as string);
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

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(ts, classId);

    db.run(`UPDATE class SET ${sets.join(', ')} WHERE id = ?`, values);
  } else if (opType === 'class.delete') {
    const classId = payload.classId as string;
    db.run('UPDATE class SET active = 0, updated_at = ? WHERE id = ?', [ts, classId]);
  } else if (opType === 'class.setExtends') {
    const classId = payload.classId as string;
    const extendsClassIds = Array.isArray(payload.extendsClassIds)
      ? (payload.extendsClassIds as string[])
      : [];

    db.run('UPDATE class SET extends_class_ids = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(extendsClassIds),
      ts,
      classId,
    ]);
    applyClassHierarchy(db, classId, extendsClassIds);
  }
}
