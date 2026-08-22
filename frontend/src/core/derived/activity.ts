import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import type { ChangeNotification } from './index';

export function applyActivityOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType, id, workspaceId, actorId } = op.envelope;
  const payload = op.payload as Record<string, unknown>;

  if (opType === 'node.delete') {
    const nodeId = payload.nodeId as string;
    db.run('DELETE FROM activity_log WHERE node_id = ?', [nodeId]);
    return [{ scope: 'all', nodeId }];
  }

  if (opType === 'activity.delete') {
    const activityId = payload.activityId as string;
    const nodeId = payload.nodeId as string | undefined;
    db.run('DELETE FROM activity_log WHERE id = ?', [activityId]);
    return nodeId ? [{ scope: 'node', nodeId }] : [];
  }

  if (opType !== 'activity.record') return [];

  const activityType = payload.activityType as string | undefined;
  const nodeId = payload.nodeId as string | undefined;
  const metadata = payload.metadata as Record<string, unknown> | undefined;

  db.run(
    `INSERT OR IGNORE INTO activity_log (id, workspace_id, actor_id, op_id, node_id, op_type, metadata, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      actorId,
      id,
      nodeId ?? null,
      activityType ?? null,
      JSON.stringify(metadata ?? {}),
      new Date().toISOString(),
    ]
  );

  return nodeId ? [{ scope: 'node', nodeId }] : [];
}
