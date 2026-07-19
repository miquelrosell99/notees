/**
 * Query node version snapshots from the derived node_version table.
 */

import type { NodeVersion } from '@/types/api';
import { queryAll } from '../db/sqlite';
import type { WorkspaceStore } from '../store';

function deriveVersionName(contentJson: string): string | null {
  try {
    const ast = JSON.parse(contentJson) as unknown;
    const text = findFirstText(ast);
    return text ? text.substring(0, 80) || null : null;
  } catch {
    const raw = contentJson.trim();
    return raw ? raw.substring(0, 80) : null;
  }
}

function findFirstText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstText(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string' && obj.text.length > 0) {
      return obj.text;
    }
    for (const child of Object.values(obj)) {
      const found = findFirstText(child);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

export function getNodeVersions(store: WorkspaceStore, nodeId: string, limit = 50): NodeVersion[] {
  const db = store.getDb();
  const rows = queryAll<{ id: string; content: string; actor_id: string | null; created_at: string }>(
    db,
    'SELECT id, content, actor_id, created_at FROM node_version WHERE node_id = ? ORDER BY created_at DESC LIMIT ?',
    [nodeId, limit]
  );

  return rows.map((row) => ({
    uuid: row.id,
    name: deriveVersionName(row.content),
    created_at: row.created_at,
    user: row.actor_id,
  }));
}

export function getNodeVersionContent(store: WorkspaceStore, nodeId: string, versionId: string): unknown[] | null {
  const db = store.getDb();
  const row = queryAll<{ content: string }>(
    db,
    'SELECT content FROM node_version WHERE node_id = ? AND id = ?',
    [nodeId, versionId]
  )[0];
  if (!row) return null;
  try {
    return JSON.parse(row.content) as unknown[];
  } catch {
    return [{ type: 'text', text: row.content }];
  }
}
