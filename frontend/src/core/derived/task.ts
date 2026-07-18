import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';

export function applyTaskOperation(db: Database, op: Operation): void {
  const { opType, id, actorId } = op.envelope;
  const payload = op.payload as Record<string, unknown>;
  const nodeId = payload.nodeId as string;

  if (opType === 'node.delete') {
    db.run('DELETE FROM task_completion WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM task_recurrence WHERE node_id = ?', [nodeId]);
    return;
  }

  if (opType === 'task.recordCompletion') {
    const completionId = (payload.completionId as string | undefined) ?? id;
    db.run(
      `INSERT OR IGNORE INTO task_completion (id, node_id, completed_at, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        completionId,
        nodeId,
        (payload.completedAt as string | undefined) ?? new Date().toISOString(),
        actorId,
        new Date().toISOString(),
      ]
    );
  } else if (opType === 'task.deleteCompletion') {
    db.run('DELETE FROM task_completion WHERE node_id = ? AND id = ?', [
      nodeId,
      payload.completionId as string,
    ]);
  } else if (opType === 'task.setRecurrence') {
    const recurrenceId = (payload.recurrenceId as string | undefined) ?? id;
    db.run(
      `INSERT OR REPLACE INTO task_recurrence (id, node_id, rule, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [recurrenceId, nodeId, payload.rule as string, actorId, new Date().toISOString()]
    );
  } else if (opType === 'task.deleteRecurrence') {
    db.run('DELETE FROM task_recurrence WHERE node_id = ? AND id = ?', [
      nodeId,
      payload.recurrenceId as string,
    ]);
  }
}
