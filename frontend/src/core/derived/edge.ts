import { type Database } from 'sql.js';
import { uuidv7 } from '../uuid';
import { queryAll, queryOne } from '../db/sqlite';
import { parseLinkId } from '@/lib/astBuilder';
import { generateLegacyLinkUuid } from '@/utils/uuid';

const REF_MARK_RE = /\[\[([^\]]+)\]\]/g;

interface NodeLinkInstance {
  linkUuid: string;
  targetUuid: string;
  type: string;
  label: string | null;
}

function extractNodeLinkInstances(content: unknown[], sourceId: string): NodeLinkInstance[] {
  const instances: NodeLinkInstance[] = [];
  const seenLegacyTargets = new Set<string>();

  function walk(node: unknown) {
    const c = node as {
      type?: string;
      targetId?: string;
      label?: string;
      text?: string;
      link_id?: string;
      ref_type?: string;
      children?: unknown[];
    };
    if (c.type === 'node_link' && c.link_id) {
      const { nodeUuid, linkUuid } = parseLinkId(c.link_id);
      if (nodeUuid) {
        instances.push({
          linkUuid: linkUuid ?? generateLegacyLinkUuid(sourceId, nodeUuid),
          targetUuid: nodeUuid,
          type: c.ref_type ?? 'node',
          label: c.label ?? null,
        });
      }
      return;
    }
    if (c.type === 'ref' && c.targetId) {
      if (!seenLegacyTargets.has(c.targetId)) {
        seenLegacyTargets.add(c.targetId);
        instances.push({
          linkUuid: generateLegacyLinkUuid(sourceId, c.targetId),
          targetUuid: c.targetId,
          type: 'node',
          label: c.label ?? null,
        });
      }
      return;
    }
    if (c.type === 'text' && typeof c.text === 'string') {
      let match: RegExpExecArray | null;
      REF_MARK_RE.lastIndex = 0;
      while ((match = REF_MARK_RE.exec(c.text)) !== null) {
        const targetId = match[1];
        if (!seenLegacyTargets.has(targetId)) {
          seenLegacyTargets.add(targetId);
          instances.push({
            linkUuid: generateLegacyLinkUuid(sourceId, targetId),
            targetUuid: targetId,
            type: 'node',
            label: null,
          });
        }
      }
      return;
    }
    if (Array.isArray(c.children)) {
      for (const child of c.children) walk(child);
    }
  }

  for (const child of content) walk(child);
  return instances;
}

export function rebuildNodeLinksForNode(db: Database, nodeId: string): string[] {
  const node = queryOne<{ workspace_id: string; content: string }>(
    db,
    'SELECT workspace_id, content FROM node WHERE id = ?',
    [nodeId]
  );
  if (!node) return [];

  const content = JSON.parse(node.content) as unknown[];
  const desired = extractNodeLinkInstances(content, nodeId);
  const desiredIds = new Set(desired.map((link) => link.linkUuid));

  const ts = new Date().toISOString();

  const upsert = db.prepare(
    `INSERT INTO node_link (
       id, workspace_id, source_id, target_id, type, label,
       click_count, last_navigated_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source_id = excluded.source_id,
       target_id = excluded.target_id,
       type = excluded.type,
       label = excluded.label,
       updated_at = excluded.updated_at`
  );
  try {
    for (const link of desired) {
      upsert.run([
        link.linkUuid,
        node.workspace_id,
        nodeId,
        link.targetUuid,
        link.type,
        link.label,
        0,
        null,
        ts,
        ts,
      ]);
    }
  } finally {
    upsert.free();
  }

  const existingRows = queryAll<{ id: string }>(
    db,
    'SELECT id FROM node_link WHERE source_id = ?',
    [nodeId]
  );
  for (const row of existingRows) {
    if (!desiredIds.has(row.id)) {
      db.run('DELETE FROM node_link WHERE id = ?', [row.id]);
    }
  }

  const affectedIds = new Set<string>([nodeId]);
  for (const link of desired) {
    affectedIds.add(link.targetUuid);
  }
  return Array.from(affectedIds);
}

export function rebuildEdgesForNode(db: Database, nodeId: string): string[] {
  rebuildNodeLinksForNode(db, nodeId);

  const node = queryOne<{ workspace_id: string }>(
    db,
    'SELECT workspace_id FROM node WHERE id = ?',
    [nodeId]
  );
  if (!node) return [];

  const desiredEdges = new Map<string, { label: string | null; metadata: string }>();
  const rows = queryAll<{ target_id: string; label: string | null }>(
    db,
    'SELECT target_id, label FROM node_link WHERE source_id = ?',
    [nodeId]
  );
  for (const row of rows) {
    if (!desiredEdges.has(row.target_id)) {
      desiredEdges.set(row.target_id, {
        label: row.label,
        metadata: JSON.stringify({ label: row.label }),
      });
    }
  }

  const existingRows = queryAll<{ id: string; target_id: string; metadata: string }>(
    db,
    'SELECT id, target_id, metadata FROM edge WHERE source_id = ? AND type = ?',
    [nodeId, 'reference']
  );

  for (const row of existingRows) {
    const wanted = desiredEdges.get(row.target_id);
    if (!wanted) {
      db.run('DELETE FROM edge WHERE id = ?', [row.id]);
    } else if (row.metadata !== wanted.metadata) {
      db.run('UPDATE edge SET metadata = ? WHERE id = ?', [wanted.metadata, row.id]);
    }
    desiredEdges.delete(row.target_id);
  }

  const insert = db.prepare(
    'INSERT INTO edge (id, workspace_id, source_id, target_id, type, property_schema_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  try {
    for (const [targetId, { metadata }] of desiredEdges) {
      insert.run([uuidv7(), node.workspace_id, nodeId, targetId, 'reference', null, metadata, new Date().toISOString()]);
    }
  } finally {
    insert.free();
  }

  const affectedIds = new Set<string>([nodeId]);
  for (const row of existingRows) {
    affectedIds.add(row.target_id);
  }
  for (const targetId of desiredEdges.keys()) {
    affectedIds.add(targetId);
  }
  return Array.from(affectedIds);
}

export function getBacklinks(db: Database, nodeId: string): string[] {
  const rows = queryAll<{ source_id: string }>(
    db,
    'SELECT DISTINCT source_id FROM node_link WHERE target_id = ? ORDER BY source_id',
    [nodeId]
  );
  return rows.map((r) => r.source_id);
}
