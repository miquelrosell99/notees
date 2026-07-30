import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { loadTreeCrdt, saveTreeCrdt } from './crdtState';
import type { ChangeNotification } from './index';

export function applyChildOrderOperation(db: Database, op: Operation): ChangeNotification[] {
  const payload = op.payload as Record<string, unknown>;
  if (!payload.treeUpdate) return [];

  const treeUpdate = Array.isArray(payload.treeUpdate)
    ? new Uint8Array(payload.treeUpdate as number[])
    : (payload.treeUpdate as Uint8Array);

  const nodeId = payload.nodeId as string;
  const tree = loadTreeCrdt(db, nodeId);
  tree.applyUpdate(treeUpdate);
  saveTreeCrdt(db, nodeId, tree);

  db.run('DELETE FROM node_child_order WHERE parent_id = ?', [nodeId]);
  const stmt = db.prepare('INSERT INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)');
  try {
    const children = tree.toArray();
    for (let i = 0; i < children.length; i++) {
      stmt.run([nodeId, children[i], i.toString().padStart(10, '0')]);
    }
  } finally {
    stmt.free();
  }

  return [{ scope: 'tree', nodeId, relatedIds: tree.toArray() }];
}
