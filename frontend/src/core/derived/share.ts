import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import type { ChangeNotification } from './index';

export function applyShareOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType, actorId } = op.envelope;
  const payload = op.payload as Record<string, unknown>;
  const nodeId = payload.nodeId as string;

  if (opType === 'node.delete') {
    db.run('DELETE FROM node_public_share WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM node_user_share WHERE node_id = ?', [nodeId]);
    return [{ scope: 'all', nodeId }];
  }

  if (opType === 'share.public.create') {
    db.run(
      `INSERT OR REPLACE INTO node_public_share (node_id, slug, password_hash, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        nodeId,
        (payload.slug as string | undefined) ?? null,
        (payload.passwordHash as string | undefined) ?? null,
        new Date().toISOString(),
        actorId,
      ]
    );
    return [{ scope: 'node', nodeId }];
  }

  if (opType === 'share.public.revoke') {
    db.run('DELETE FROM node_public_share WHERE node_id = ?', [nodeId]);
    return [{ scope: 'node', nodeId }];
  }

  if (opType === 'share.user.grant') {
    const targetUserId = payload.targetUserId as string;
    db.run(
      `INSERT OR REPLACE INTO node_user_share (node_id, user_id, role, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        nodeId,
        targetUserId,
        (payload.role as string | undefined) ?? '',
        new Date().toISOString(),
        actorId,
      ]
    );
    return [{ scope: 'node', nodeId, relatedIds: [targetUserId] }];
  }

  if (opType === 'share.user.revoke') {
    // The frontend node_user_share table has no share_id column, so revoke by
    // the (nodeId, targetUserId) pair the producer emits.
    const targetUserId = payload.targetUserId as string;
    db.run('DELETE FROM node_user_share WHERE node_id = ? AND user_id = ?', [nodeId, targetUserId]);
    return [{ scope: 'node', nodeId, relatedIds: [targetUserId] }];
  }

  return [];
}
