import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';

export function applyAssetOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;
  const nodeId = payload.nodeId as string;

  if (opType === 'node.delete') {
    db.run('DELETE FROM node_asset WHERE node_id = ?', [nodeId]);
    return;
  }

  if (opType === 'asset.upload') {
    db.run(
      `INSERT OR IGNORE INTO node_asset (node_id, asset_hash, mime_type, size, original_name, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        nodeId,
        payload.assetHash as string,
        payload.mimeType as string,
        payload.size as number,
        payload.originalName as string,
        new Date().toISOString(),
      ]
    );
  } else if (opType === 'asset.delete') {
    const assetHash = payload.assetHash as string | undefined;
    if (assetHash) {
      db.run('DELETE FROM node_asset WHERE node_id = ? AND asset_hash = ?', [nodeId, assetHash]);
    } else {
      db.run('DELETE FROM node_asset WHERE node_id = ?', [nodeId]);
    }
  }
}
