import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { queryOne } from '../db/sqlite';

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
  }
}
