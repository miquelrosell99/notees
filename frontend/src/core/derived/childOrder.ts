import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { loadTreeCrdt, saveTreeCrdt } from './crdtState';

export function applyChildOrderOperation(db: Database, op: Operation): void {
  const payload = op.payload as Record<string, unknown>;
  if (!payload.treeUpdate) return;

  const treeUpdate = Array.isArray(payload.treeUpdate)
    ? new Uint8Array(payload.treeUpdate as number[])
    : (payload.treeUpdate as Uint8Array);

  const tree = loadTreeCrdt(db, payload.nodeId as string);
  tree.applyUpdate(treeUpdate);
  saveTreeCrdt(db, payload.nodeId as string, tree);

  db.run('DELETE FROM node_child_order WHERE parent_id = ?', [payload.nodeId as string]);
  const stmt = db.prepare('INSERT INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)');
  try {
    const children = tree.toArray();
    for (let i = 0; i < children.length; i++) {
      stmt.run([payload.nodeId as string, children[i], i.toString().padStart(10, '0')]);
    }
  } finally {
    stmt.free();
  }
}
