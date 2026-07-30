import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { queryOne } from '../db/sqlite';
import type { ChangeNotification } from './index';

export function applyFavoriteOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType, actorId, workspaceId } = op.envelope;
  const payload = op.payload as Record<string, unknown>;

  if (opType === 'user.favorite.add') {
    const nodeId = payload.nodeId as string;
    const maxPosition = queryOne<{ pos: number }>(
      db,
      'SELECT COALESCE(MAX(position), -1) AS pos FROM user_favorite WHERE actor_id = ? AND workspace_id = ?',
      [actorId, workspaceId]
    );
    const nextPosition = maxPosition?.pos ?? -1;
    db.run(
      'INSERT OR IGNORE INTO user_favorite (actor_id, node_id, workspace_id, position) VALUES (?, ?, ?, ?)',
      [actorId, nodeId, workspaceId, nextPosition + 1]
    );
    return [{ scope: 'node', nodeId }];
  }

  if (opType === 'user.favorite.remove') {
    const nodeId = payload.nodeId as string;
    db.run(
      'DELETE FROM user_favorite WHERE actor_id = ? AND node_id = ? AND workspace_id = ?',
      [actorId, nodeId, workspaceId]
    );
    return [{ scope: 'node', nodeId }];
  }

  if (opType === 'user.favorite.reorder') {
    const nodeIds = (payload.nodeIds as string[]) ?? [];
    db.run(
      'DELETE FROM user_favorite WHERE actor_id = ? AND workspace_id = ? AND node_id NOT IN (' +
        nodeIds.map(() => '?').join(',') +
        ')',
      [actorId, workspaceId, ...nodeIds]
    );
    nodeIds.forEach((nodeId, index) => {
      db.run(
        'INSERT OR REPLACE INTO user_favorite (actor_id, node_id, workspace_id, position) VALUES (?, ?, ?, ?)',
        [actorId, nodeId, workspaceId, index]
      );
    });
    return [{ scope: 'all' }];
  }

  return [];
}
