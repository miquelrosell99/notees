import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { TreeCrdt } from "../../src/crdt/tree";
import { applyChildOrderOperation } from "../../src/derived/childOrder";
import { createOperation } from "../../src/operation";

test("applies tree update to node_child_order", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "parent", "ws-1", "page", "[]", "[]",
  ]);

  const tree = new TreeCrdt();
  tree.insert("child-a", 0);
  tree.insert("child-b", 1);

  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["parent"],
      opType: "node.updateContent",
    },
    { nodeId: "parent", treeUpdate: Array.from(tree.getState()) }
  );

  applyChildOrderOperation(db, op);
  const rows = db
    .query("SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position")
    .all("parent") as { child_id: string }[];
  expect(rows.map((r) => r.child_id)).toEqual(["child-a", "child-b"]);
});
