import { Database } from "bun:sqlite";
import type { Operation } from "../operation";
import { loadTextCrdt, saveTextCrdt } from "./crdtState";

export function applyNodeOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;
  const payload = op.payload as any;

  if (opType === "node.create") {
    db.run(
      `INSERT OR IGNORE INTO node (id, workspace_id, kind, class_ids, parent_id, content, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.nodeId,
        op.envelope.workspaceId,
        payload.kind,
        JSON.stringify(payload.classIds ?? []),
        payload.parentId ?? null,
        JSON.stringify(payload.initialContent ?? []),
        new Date().toISOString(),
        new Date().toISOString(),
        op.envelope.actorId,
        op.envelope.actorId,
      ]
    );
  } else if (opType === "node.delete") {
    const nodeId = payload.nodeId;
    db.run("DELETE FROM node WHERE id = ?", [nodeId]);
    db.run("DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?", [nodeId, nodeId]);
    db.run("DELETE FROM property_value WHERE node_id = ?", [nodeId]);
    db.run("DELETE FROM edge WHERE source_id = ? OR target_id = ?", [nodeId, nodeId]);
    db.run("DELETE FROM crdt_state WHERE node_id = ?", [nodeId]);
  } else if (opType === "node.move") {
    db.run("UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
      payload.newParentId ?? null,
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId,
    ]);
  } else if (opType === "class.assign") {
    const row = db.query("SELECT class_ids FROM node WHERE id = ?").get(payload.nodeId) as
      | { class_ids: string }
      | undefined;
    if (!row) return;
    const ids = new Set(JSON.parse(row.class_ids));
    ids.add(payload.classId);
    db.run("UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
      JSON.stringify(Array.from(ids)),
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId,
    ]);
  } else if (opType === "class.unassign") {
    const row = db.query("SELECT class_ids FROM node WHERE id = ?").get(payload.nodeId) as
      | { class_ids: string }
      | undefined;
    if (!row) return;
    const ids = new Set(JSON.parse(row.class_ids));
    ids.delete(payload.classId);
    db.run("UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
      JSON.stringify(Array.from(ids)),
      new Date().toISOString(),
      op.envelope.actorId,
      payload.nodeId,
    ]);
  } else if (opType === "node.updateContent") {
    if (payload.textUpdate) {
      const text = loadTextCrdt(db, payload.nodeId);
      text.applyUpdate(Uint8Array.from(payload.textUpdate));
      saveTextCrdt(db, payload.nodeId, text);
      const ast = [{ type: "text", text: text.toPlaintext() }];
      db.run("UPDATE node SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
        JSON.stringify(ast),
        new Date().toISOString(),
        op.envelope.actorId,
        payload.nodeId,
      ]);
    }
  }
}
