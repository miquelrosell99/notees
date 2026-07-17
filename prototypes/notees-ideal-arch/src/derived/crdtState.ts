import { Database } from "bun:sqlite";
import { TextCrdt } from "../crdt/text";
import { TreeCrdt } from "../crdt/tree";

export function loadTreeCrdt(db: Database, nodeId: string): TreeCrdt {
  const row = db.query("SELECT tree_state FROM crdt_state WHERE node_id = ?").get(nodeId) as
    | { tree_state: Uint8Array }
    | undefined;
  return new TreeCrdt(row?.tree_state);
}

export function saveTreeCrdt(db: Database, nodeId: string, crdt: TreeCrdt): void {
  db.run(
    `INSERT INTO crdt_state (node_id, tree_state) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET tree_state = excluded.tree_state`,
    [nodeId, crdt.getState()]
  );
}

export function loadTextCrdt(db: Database, nodeId: string): TextCrdt {
  const row = db.query("SELECT text_state FROM crdt_state WHERE node_id = ?").get(nodeId) as
    | { text_state: Uint8Array }
    | undefined;
  return new TextCrdt(row?.text_state);
}

export function saveTextCrdt(db: Database, nodeId: string, crdt: TextCrdt): void {
  db.run(
    `INSERT INTO crdt_state (node_id, text_state) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET text_state = excluded.text_state`,
    [nodeId, crdt.getState()]
  );
}
