import { Database } from "bun:sqlite";
import { loadTreeCrdt, saveTreeCrdt } from "./crdtState";
import type { Operation } from "../operation";

export function applyChildOrderOperation(db: Database, op: Operation): void {
  const payload = op.payload as any;
  if (!payload.treeUpdate) return;

  const tree = loadTreeCrdt(db, payload.nodeId);
  tree.applyUpdate(Uint8Array.from(payload.treeUpdate));
  saveTreeCrdt(db, payload.nodeId, tree);

  db.run("DELETE FROM node_child_order WHERE parent_id = ?", [payload.nodeId]);
  const stmt = db.prepare(
    "INSERT INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)"
  );
  const children = tree.toArray();
  for (let i = 0; i < children.length; i++) {
    stmt.run(payload.nodeId, children[i], i.toString().padStart(10, "0"));
  }
  stmt.finalize();
}
