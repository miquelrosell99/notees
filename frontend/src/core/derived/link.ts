import { type Database } from 'sql.js';
import { uuidv7 } from '../uuid';
import { queryOne } from '../db/sqlite';
import type { Operation } from '../types/operation';
import type { ChangeNotification } from './index';

export function applyLinkOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;

  if (opType === 'node.delete') {
    const nodeId = payload.nodeId as string;
    db.run('DELETE FROM link_click WHERE node_id = ? OR target_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM node_link WHERE source_id = ? OR target_id = ?', [nodeId, nodeId]);
    return [{ scope: 'all', nodeId }];
  }

  if (opType !== 'link.click') return [];

  const sourceId = payload.sourceNodeId as string;
  const targetId = payload.targetNodeId as string;
  const linkUuid = payload.linkUuid as string | undefined;
  const clickedAt = (payload.clickedAt as string | undefined) ?? new Date().toISOString();

  if (!sourceId || !targetId) {
    return [];
  }

  if (linkUuid) {
    const row = queryOne<{ click_count: number }>(db, 'SELECT click_count FROM node_link WHERE id = ?', [linkUuid]);
    if (row) {
      db.run(
        `UPDATE node_link
         SET click_count = click_count + 1,
             last_navigated_at = ?,
             updated_at = ?
         WHERE id = ?`,
        [clickedAt, clickedAt, linkUuid]
      );
      return [{ scope: 'node', nodeId: sourceId, relatedIds: [targetId] }];
    }
  }

  // Fallback for legacy operations without a linkUuid: update the first
  // node_link row matching (source_id, target_id).
  const fallbackRow = queryOne<{ id: string }>(
    db,
    'SELECT id FROM node_link WHERE source_id = ? AND target_id = ? ORDER BY created_at LIMIT 1',
    [sourceId, targetId]
  );

  if (fallbackRow) {
    db.run(
      `UPDATE node_link
       SET click_count = click_count + 1,
           last_navigated_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [clickedAt, clickedAt, fallbackRow.id]
    );
  } else {
    db.run(
      `INSERT INTO node_link (
         id, workspace_id, source_id, target_id, type, label,
         click_count, last_navigated_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        linkUuid || uuidv7(),
        op.envelope.workspaceId,
        sourceId,
        targetId,
        'node',
        null,
        1,
        clickedAt,
        clickedAt,
        clickedAt,
      ]
    );
  }

  return [{ scope: 'node', nodeId: sourceId, relatedIds: [targetId] }];
}
