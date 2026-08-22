import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import type { ChangeNotification } from './index';

export function applyAssetOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;
  const nodeId = payload.nodeId as string;

  if (opType === 'node.delete') {
    db.run('DELETE FROM node_asset WHERE node_id = ?', [nodeId]);
    return [{ scope: 'all', nodeId }];
  }

  if (opType === 'asset.upload') {
    db.run(
      `INSERT OR IGNORE INTO node_asset (node_id, asset_hash, mime_type, size, original_name, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        nodeId,
        payload.assetHash as string,
        payload.mimeType as string,
        payload.sizeBytes as number,
        payload.originalName as string,
        new Date().toISOString(),
      ]
    );
    return [{ scope: 'node', nodeId }];
  }

  if (opType === 'asset.delete') {
    const assetHash = payload.assetHash as string | undefined;
    if (assetHash) {
      db.run('DELETE FROM node_asset WHERE node_id = ? AND asset_hash = ?', [nodeId, assetHash]);
    } else {
      db.run('DELETE FROM node_asset WHERE node_id = ?', [nodeId]);
    }
    return [{ scope: 'node', nodeId }];
  }

  return [];
}
