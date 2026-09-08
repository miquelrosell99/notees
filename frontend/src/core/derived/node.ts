import { type Database } from 'sql.js';
import type { Operation } from '../types/operation';
import { loadTextCrdt, saveTextCrdt } from './crdtState';
import { claimNodeField, compareLww, nodeFieldClaimLost, type LwwRecord } from './lww';
import { claimClassMembership, maxClassMembershipRecord, recomputeClassIds } from './classMembership';
import { reindexNode } from './search';
import { extractTextContent } from './textContent';
import { deleteNodeViewsForNode } from './nodeView';
import { queryOne } from '../db/sqlite';
import type { ChangeNotification } from './index';

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

export function applyNodeOperation(db: Database, op: Operation): ChangeNotification[] {
  const { opType } = op.envelope;
  const payload = op.payload as Record<string, unknown>;
  const incoming: LwwRecord = { hlc: op.envelope.hlc, actorId: op.envelope.actorId };

  if (opType === 'node.create') {
    const contentJson = JSON.stringify((payload.initialContent as unknown[]) ?? []);
    db.run(
      `INSERT OR IGNORE INTO node (id, workspace_id, kind, class_ids, parent_id, content, text_content, icon, color, active, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.nodeId as string,
        op.envelope.workspaceId,
        payload.kind as string,
        JSON.stringify((payload.classIds as string[]) ?? []),
        (payload.parentId as string | null) ?? null,
        contentJson,
        extractTextContent(contentJson),
        (payload.icon as string | null) ?? null,
        (payload.color as string | null) ?? null,
        1,
        new Date().toISOString(),
        new Date().toISOString(),
        op.envelope.actorId,
        op.envelope.actorId,
      ]
    );
    // Seed the OR-Set membership table from the create payload so the
    // materialized class_ids and the membership set stay consistent on replay.
    for (const classId of (payload.classIds as string[]) ?? []) {
      claimClassMembership(db, payload.nodeId as string, classId, incoming, true);
    }
    reindexNode(db, payload.nodeId as string);
    return [{ scope: 'node', nodeId: payload.nodeId as string }];
  }

  if (opType === 'node.updateIcon') {
    const nodeId = payload.nodeId as string;
    if (!claimNodeField(db, nodeId, 'icon', incoming)) return [];
    db.run('UPDATE node SET icon = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      (payload.icon as string | null) ?? null,
      new Date().toISOString(),
      op.envelope.actorId,
      nodeId,
    ]);
    return [{ scope: 'node', nodeId }];
  }

  if (opType === 'node.updateColor') {
    const nodeId = payload.nodeId as string;
    if (!claimNodeField(db, nodeId, 'color', incoming)) return [];
    db.run('UPDATE node SET color = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      (payload.color as string | null) ?? null,
      new Date().toISOString(),
      op.envelope.actorId,
      nodeId,
    ]);
    return [{ scope: 'node', nodeId }];
  }

  if (opType === 'node.archive' || opType === 'node.restore') {
    const nodeId = payload.nodeId as string;
    if (!claimNodeField(db, nodeId, 'active', incoming)) return [];
    db.run('UPDATE node SET active = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      opType === 'node.restore' ? 1 : 0,
      new Date().toISOString(),
      op.envelope.actorId,
      nodeId,
    ]);
    return [{ scope: 'node', nodeId }];
  }

  if (opType === 'node.permanentDelete' || opType === 'node.delete') {
    const nodeId = payload.nodeId as string;
    db.run('DELETE FROM node WHERE id = ?', [nodeId]);
    db.run('DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM property_value WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM property_value_tombstone WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM property_schema WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM class_property_edge WHERE class_id = ?', [nodeId]);
    db.run('DELETE FROM edge WHERE source_id = ? OR target_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM node_link WHERE source_id = ? OR target_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM crdt_state WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM search_index WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM class_hierarchy WHERE class_id = ? OR ancestor_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM node_alias WHERE alias_node_id = ? OR canonical_node_id = ?', [nodeId, nodeId]);
    db.run('DELETE FROM node_version WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM node_field_lww WHERE node_id = ?', [nodeId]);
    db.run('DELETE FROM class_member_set WHERE node_id = ?', [nodeId]);
    deleteNodeViewsForNode(db, nodeId);
    return [{ scope: 'all', nodeId }];
  }

  if (opType === 'node.addAlias') {
    db.run('INSERT OR REPLACE INTO node_alias (alias_node_id, canonical_node_id) VALUES (?, ?)', [
      payload.aliasNodeId as string,
      payload.canonicalNodeId as string,
    ]);
    return [
      {
        scope: 'node',
        nodeId: payload.aliasNodeId as string,
        relatedIds: [payload.canonicalNodeId as string],
      },
    ];
  }

  if (opType === 'node.removeAlias') {
    db.run('DELETE FROM node_alias WHERE alias_node_id = ? AND canonical_node_id = ?', [
      payload.aliasNodeId as string,
      payload.canonicalNodeId as string,
    ]);
    return [
      {
        scope: 'node',
        nodeId: payload.aliasNodeId as string,
        relatedIds: [payload.canonicalNodeId as string],
      },
    ];
  }

  if (opType === 'node.move') {
    const nodeId = payload.nodeId as string;
    if (!claimNodeField(db, nodeId, 'parent', incoming)) return [];
    db.run('UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      (payload.newParentId as string | null) ?? null,
      new Date().toISOString(),
      op.envelope.actorId,
      nodeId,
    ]);
    return [{ scope: 'tree', nodeId }];
  }

  if (opType === 'node.convert') {
    // convert writes three LWW fields at once; claim each independently so a
    // newer move/assign on one field is not regressed by an older convert.
    const nodeId = payload.nodeId as string;
    const now = new Date().toISOString();
    const notifications: ChangeNotification[] = [];
    if (claimNodeField(db, nodeId, 'kind', incoming)) {
      db.run('UPDATE node SET kind = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        payload.kind as string,
        now,
        op.envelope.actorId,
        nodeId,
      ]);
      notifications.push({ scope: 'node', nodeId });
    }
    if (claimNodeField(db, nodeId, 'parent', incoming)) {
      db.run('UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        (payload.parentId as string | null) ?? null,
        now,
        op.envelope.actorId,
        nodeId,
      ]);
      notifications.push({ scope: 'node', nodeId });
    }
    // Wholesale class-set replace: wins only against BOTH the wholesale
    // record and every membership claim, so a reordered assign/unassign is
    // neither regressed nor lost. Element claims are recorded for old ∪ new
    // (present only for the new set) so older element ops stay blocked.
    const maxElement = maxClassMembershipRecord(db, nodeId);
    if (
      claimNodeField(db, nodeId, 'class_ids', incoming) &&
      (!maxElement || compareLww(incoming, maxElement) > 0)
    ) {
      const row = queryOne<{ class_ids: string }>(db, 'SELECT class_ids FROM node WHERE id = ?', [
        nodeId,
      ]);
      const oldIds = new Set(row ? (JSON.parse(row.class_ids) as string[]) : []);
      const newIds = new Set((payload.classIds as string[]) ?? []);
      for (const classId of new Set([...oldIds, ...newIds])) {
        claimClassMembership(db, nodeId, classId, incoming, newIds.has(classId));
      }
      recomputeClassIds(db, nodeId, op.envelope.actorId);
      notifications.push({ scope: 'node', nodeId });
    }
    return notifications;
  }

  if (opType === 'class.assign' || opType === 'class.unassign') {
    // OR-Set membership: claims resolve per class id (add-wins on ties), so
    // concurrent memberships from different actors survive and any arrival
    // order converges. Also loses to a newer wholesale convert replace.
    const nodeId = payload.nodeId as string;
    const classId = payload.classId as string;
    if (nodeFieldClaimLost(db, nodeId, 'class_ids', incoming)) return [];
    if (!claimClassMembership(db, nodeId, classId, incoming, opType === 'class.assign')) return [];
    recomputeClassIds(db, nodeId, op.envelope.actorId);
    return [{ scope: 'class', nodeId, relatedIds: [classId] }];
  }

  if (opType === 'node.updateContent') {
    if (payload.textUpdate) {
      const textUpdate = Array.isArray(payload.textUpdate)
        ? new Uint8Array(payload.textUpdate as number[])
        : (payload.textUpdate as Uint8Array);
      const text = loadTextCrdt(db, payload.nodeId as string);
      text.applyUpdate(textUpdate);
      saveTextCrdt(db, payload.nodeId as string, text);
      const ast = [{ type: 'text', text: text.toPlaintext() }];
      const contentJson = JSON.stringify(ast);
      db.run('UPDATE node SET content = ?, text_content = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        contentJson,
        extractTextContent(contentJson),
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
      if (!rawContent) return [];
      const content = Array.isArray(rawContent) ? rawContent : [rawContent];
      const contentJson = JSON.stringify(content);
      db.run('UPDATE node SET content = ?, text_content = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        contentJson,
        extractTextContent(contentJson),
        new Date().toISOString(),
        op.envelope.actorId,
        payload.nodeId as string,
      ]);
      recordNodeVersion(db, op.envelope.id, payload.nodeId as string, contentJson, op.envelope.actorId, new Date().toISOString());
      reindexNode(db, payload.nodeId as string);
    }
    return [{ scope: 'node', nodeId: payload.nodeId as string }];
  }

  return [];
}
