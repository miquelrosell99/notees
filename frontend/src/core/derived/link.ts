import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';

export function applyLinkOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;

  if (opType === 'node.delete') {
    const nodeId = payload.nodeId as string;
    db.run('DELETE FROM link_click WHERE node_id = ? OR target_id = ?', [nodeId, nodeId]);
    return;
  }

  if (opType !== 'link.click') return;

  const nodeId = payload.nodeId as string;
  const targetId = (payload.targetId as string | undefined) ?? '';

  db.run(
    `INSERT INTO link_click (node_id, target_id, click_count, last_clicked_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(node_id, target_id) DO UPDATE SET
       click_count = click_count + 1,
       last_clicked_at = excluded.last_clicked_at`,
    [nodeId, targetId, new Date().toISOString()]
  );
}
