import { Database } from "bun:sqlite";
import type { Operation } from "../operation";

export function applyNodeOperation(db: Database, op: Operation): void {
  const { opType } = op.envelope;
  const payload = op.payload as any;

  if (opType === "node.create") {
    db.run(
      `INSERT INTO node (id, workspace_id, kind, class_ids, parent_id, content, created_at, updated_at, created_by, updated_by)
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
    db.run("DELETE FROM node WHERE id = ?", [payload.nodeId]);
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
  }
}
