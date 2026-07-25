import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { loadTextCrdt, saveTextCrdt } from './crdtState';
import { reindexNode } from './search';
import { deleteNodeViewsForNode } from './nodeView';
import { queryOne } from '../db/sqlite';

function recordNodeVersion(
  db: Database,
  opId: string,
  nodeId: string,
  contentJson: string,
  actorId: string,
  createdAt: string
): void {
  db.run(
    'INSERT OR REPLACE INTO node_version (id, node_id, content, actor_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [opId, nodeId, contentJson, actorId, createdAt]
  );
}

export function applyNodeOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;

  if (opType === 'node.create') {
    db.run(
      `INSERT OR IGNORE INTO node (id, workspace_id, kind, class_ids, parent_id, content, active, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.nodeId as string,
        op.envelope.workspaceId,
        payload.kind as string,
        JSON.stringify((payload.classIds as string[]) ?? []),
        (payload.parentId as string | null) ?? null,
        JSON.stringify((payload.initialContent as unknown[]) ?? []),
        1,
        new Date().toISOString(),
        new Date().toISOString(),
        op.envelope.actorId,
        op.envelope.actorId,
      ]
    );
    reindexNode(db, payload.nodeId as string);
  } else if (opType === 'node.archive') {
    db.run('UPDATE node SET active = 0, updated_at = ?, updated_by = ? WHERE id = ?', [
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId as string,
    ]);
  } else if (opType === 'node.restore') {
    db.run('UPDATE node SET active = 1, updated_at = ?, updated_by = ? WHERE id = ?', [
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId as string,
    ]);
  } else if (opType === 'node.permanentDelete') {
    const nodeId = payload.nodeId as string;
    db.run('DELETE FROM node WHERE id = ?', [nodeId]);
    db.run('DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM property_value WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM property_value_tombstone WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM property_schema WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM class_property_edge WHERE class_id = ?', [nodeId]);
    db.run('DELETE FROM edge WHERE source_id = ? OR target_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM crdt_state WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM search_index WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM class_hierarchy WHERE class_id = ? OR ancestor_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM node_alias WHERE alias_node_id = ? OR canonical_node_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM node_version WHERE node_id = ?', [nodeId]);
    deleteNodeViewsForNode(db, nodeId);
  } else if (opType === 'node.delete') {
    const nodeId = payload.nodeId as string;
    db.run('DELETE FROM node WHERE id = ?', [nodeId]);
    db.run('DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM property_value WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM property_value_tombstone WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM property_schema WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM class_property_edge WHERE class_id = ?', [nodeId]);
    db.run('DELETE FROM edge WHERE source_id = ? OR target_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM crdt_state WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM search_index WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM class_hierarchy WHERE class_id = ? OR ancestor_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM node_alias WHERE alias_node_id = ? OR canonical_node_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM node_version WHERE node_id = ?', [nodeId]);
    deleteNodeViewsForNode(db, nodeId);
  } else if (opType === 'node.addAlias') {
    db.run('INSERT OR REPLACE INTO node_alias (alias_node_id, canonical_node_id) VALUES (?, ?)', [
      payload.aliasNodeId as string,
      payload.canonicalNodeId as string,
    ]);
  } else if (opType === 'node.removeAlias') {
    db.run('DELETE FROM node_alias WHERE alias_node_id = ? AND canonical_node_id = ?', [
      payload.aliasNodeId as string,
      payload.canonicalNodeId as string,
    ]);
  } else if (opType === 'node.move') {
    db.run('UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      (payload.newParentId as string | null) ?? null,
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId as string,
    ]);
  } else if (opType === 'node.convert') {
    db.run(
      'UPDATE node SET kind = ?, parent_id = ?, class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      [
        payload.kind as string,
        (payload.parentId as string | null) ?? null,
        JSON.stringify((payload.classIds as string[]) ?? []),
        new Date().toISOString(),
        op.envelope.actorId,
        payload.nodeId as string,
      ]
    );
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
      const contentJson = JSON.stringify(ast);
      db.run('UPDATE node SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        contentJson,
        new Date().toISOString(),
        op.envelope.actorId,
        payload.nodeId as string,
      ]);
      recordNodeVersion(db, op.envelope.id, payload.nodeId as string, contentJson, op.envelope.actorId, new Date().toISOString());
      reindexNode(db, payload.nodeId as string);
    } else {
      // ``content`` is a direct AST payload; ``crdtUpdate`` is the legacy
      // migration path that also carries an AST (the name is historical).
      const rawContent = (payload.content ?? payload.crdtUpdate) as unknown;
      if (!rawContent) return;
      const content = Array.isArray(rawContent) ? rawContent : [rawContent];
      const contentJson = JSON.stringify(content);
      db.run('UPDATE node SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        contentJson,
        new Date().toISOString(),
        op.envelope.actorId,
        payload.nodeId as string,
      ]);
      recordNodeVersion(db, op.envelope.id, payload.nodeId as string, contentJson, op.envelope.actorId, new Date().toISOString());
      reindexNode(db, payload.nodeId as string);
    }
  }
}
