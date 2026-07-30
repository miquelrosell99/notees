import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import type { ChangeNotification } from './index';

export function applyPluginOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType, id, workspaceId, actorId } = op.envelope;
  const payload = op.payload as Record<string, unknown>;

  if (opType !== 'plugin.op') return [];

  db.run(
    `INSERT OR IGNORE INTO plugin_op_log (id, workspace_id, op_id, plugin_id, op_type, data, actor_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      id,
      payload.pluginId as string,
      payload.opType as string,
      JSON.stringify((payload.data as Record<string, unknown> | undefined) ?? {}),
      actorId,
      new Date().toISOString(),
    ]
  );

  return [{ scope: 'all' }];
}
