import { type Database } from 'sql.js';
import { TextCrdt } from '../crdt/text';
import { TreeCrdt } from '../crdt/tree';
import { queryOne } from '../db/sqlite';

export function loadTreeCrdt(db: Database, nodeId: string): TreeCrdt {
  const row = queryOne<{ tree_state: Uint8Array | null }>(db, 'SELECT tree_state FROM crdt_state WHERE node_id = ?', [
    nodeId,
  ]);
  return new TreeCrdt(row?.tree_state ?? undefined);
}

export function saveTreeCrdt(db: Database, nodeId: string, crdt: TreeCrdt): void {
  db.run(
    `INSERT INTO crdt_state (node_id, tree_state) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET tree_state = excluded.tree_state`,
    [nodeId, crdt.getState()]
  );
}

export function loadTextCrdt(db: Database, nodeId: string): TextCrdt {
  const row = queryOne<{ text_state: Uint8Array | null }>(db, 'SELECT text_state FROM crdt_state WHERE node_id = ?', [
    nodeId,
  ]);
  return new TextCrdt(row?.text_state ?? undefined);
}

export function saveTextCrdt(db: Database, nodeId: string, crdt: TextCrdt): void {
  db.run(
    `INSERT INTO crdt_state (node_id, text_state) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET text_state = excluded.text_state`,
    [nodeId, crdt.getState()]
  );
}
