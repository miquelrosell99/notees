import { type Database } from 'sql.js';
import { uuidv7 } from '../uuid';
import { queryAll, queryOne } from '../db/sqlite';
import { parseLinkId } from '@/lib/astBuilder';
import { rebuildNodeStats } from './nodeStats';

const REF_MARK_RE = /\[\[([^\]]+)\]\]/g;

interface RefTarget {
  targetId: string;
  label: string | null;
}

function extractRefTargets(content: unknown[]): RefTarget[] {
  const targets = new Map<string, string | null>();

  function walk(node: unknown) {
    const c = node as {
      type?: string;
      targetId?: string;
      label?: string;
      text?: string;
      link_id?: string;
      children?: unknown[];
    };
    if (c.type === 'ref' && c.targetId) {
      targets.set(c.targetId, c.label ?? null);
      return;
    }
    if (c.type === 'node_link' && c.link_id) {
      const { nodeUuid } = parseLinkId(c.link_id);
      if (nodeUuid) {
        targets.set(nodeUuid, c.label ?? null);
      }
      return;
    }
    if (c.type === 'text' && typeof c.text === 'string') {
      let match: RegExpExecArray | null;
      REF_MARK_RE.lastIndex = 0;
      while ((match = REF_MARK_RE.exec(c.text)) !== null) {
        if (!targets.has(match[1])) {
          targets.set(match[1], null);
        }
      }
      return;
    }
    if (Array.isArray(c.children)) {
      for (const child of c.children) walk(child);
    }
  }

  for (const child of content) walk(child);
  return Array.from(targets.entries()).map(([targetId, label]) => ({ targetId, label }));
}

export function rebuildEdgesForNode(db: Database, nodeId: string): string[] {
  const node = queryOne<{ workspace_id: string; content: string }>(
    db,
    'SELECT workspace_id, content FROM node WHERE id = ?',
    [nodeId]
  );
  if (!node) return [];

  const content = JSON.parse(node.content) as unknown[];
  const desired = new Map<string, { label: string | null; metadata: string }>();
  for (const { targetId, label } of extractRefTargets(content)) {
    desired.set(targetId, { label, metadata: JSON.stringify({ label }) });
  }

  const existingRows = queryAll<{ id: string; target_id: string; metadata: string }>(
    db,
    'SELECT id, target_id, metadata FROM edge WHERE source_id = ? AND type = ?',
    [nodeId, 'reference']
  );

  for (const row of existingRows) {
    const wanted = desired.get(row.target_id);
    if (!wanted) {
      db.run('DELETE FROM edge WHERE id = ?', [row.id]);
    } else if (row.metadata !== wanted.metadata) {
      db.run('UPDATE edge SET metadata = ? WHERE id = ?', [wanted.metadata, row.id]);
    }
    desired.delete(row.target_id);
  }

  const stmt = db.prepare(
    'INSERT INTO edge (id, workspace_id, source_id, target_id, type, property_schema_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  try {
    for (const [targetId, { metadata }] of desired) {
      stmt.run([uuidv7(), node.workspace_id, nodeId, targetId, 'reference', null, metadata, new Date().toISOString()]);
    }
  } finally {
    stmt.free();
  }

  const affectedIds = new Set<string>([nodeId]);
  for (const row of existingRows) {
    affectedIds.add(row.target_id);
  }
  for (const targetId of desired.keys()) {
    affectedIds.add(targetId);
  }
  rebuildNodeStats(db, Array.from(affectedIds));
  return Array.from(affectedIds);
}

export function getBacklinks(db: Database, nodeId: string): string[] {
  const rows = queryAll<{ source_id: string }>(
    db,
    'SELECT DISTINCT source_id FROM edge WHERE target_id = ? ORDER BY source_id',
    [nodeId]
  );
  return rows.map((r) => r.source_id);
}
