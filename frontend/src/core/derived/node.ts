import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { loadTextCrdt, saveTextCrdt } from './crdtState';
import { reindexNode } from './search';
import { queryOne } from '../db/sqlite';

export function applyNodeOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;

  if (opType === 'node.create') {
    db.run(
      `INSERT OR IGNORE INTO node (id, workspace_id, kind, class_ids, parent_id, content, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.nodeId as string,
        op.envelope.workspaceId,
        payload.kind as string,
        JSON.stringify((payload.classIds as string[]) ?? []),
        (payload.parentId as string | null) ?? null,
        JSON.stringify((payload.initialContent as unknown[]) ?? []),
        new Date().toISOString(),
        new Date().toISOString(),
        op.envelope.actorId,
        op.envelope.actorId,
      ]
    );
    reindexNode(db, payload.nodeId as string);
  } else if (opType === 'node.delete') {
    const nodeId = payload.nodeId as string;
    db.run('DELETE FROM node WHERE id = ?', [nodeId]);
    db.run('DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM property_value WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM property_value_tombstone WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM edge WHERE source_id = ? OR target_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM crdt_state WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM search_index WHERE node_id = ?', [nodeId]);
  } else if (opType === 'node.move') {
    db.run('UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      (payload.newParentId as string | null) ?? null,
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId as string,
    ]);
  } else if (opType === 'class.assign') {
    const row = queryOne<{ class_ids: string }>(db, 'SELECT class_ids FROM node WHERE id = ?', [
      payload.nodeId as string,
    ]);
    if (!row) return;
    const ids = new Set(JSON.parse(row.class_ids) as string[]);
    ids.add(payload.classId as string);
    db.run('UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      JSON.stringify(Array.from(ids)),
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId as string,
    ]);
  } else if (opType === 'class.unassign') {
    const row = queryOne<{ class_ids: string }>(db, 'SELECT class_ids FROM node WHERE id = ?', [
      payload.nodeId as string,
    ]);
    if (!row) return;
    const ids = new Set(JSON.parse(row.class_ids) as string[]);
    ids.delete(payload.classId as string);
    db.run('UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      JSON.stringify(Array.from(ids)),
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId as string,
    ]);
  } else if (opType === 'node.updateContent') {
    if (payload.textUpdate) {
      const textUpdate = Array.isArray(payload.textUpdate)
        ? new Uint8Array(payload.textUpdate as number[])
        : (payload.textUpdate as Uint8Array);
      const text = loadTextCrdt(db, payload.nodeId as string);
      text.applyUpdate(textUpdate);
      saveTextCrdt(db, payload.nodeId as string, text);
      const ast = [{ type: 'text', text: text.toPlaintext() }];
      db.run('UPDATE node SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        JSON.stringify(ast),
        new Date().toISOString(),
        op.envelope.actorId,
        payload.nodeId as string,
      ]);
      reindexNode(db, payload.nodeId as string);
    }
  }
}
