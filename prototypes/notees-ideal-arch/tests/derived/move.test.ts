import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../../src/store";
import { uuidv7 } from "../../src/uuid";

function getChildren(db: Database, parentId: string): string[] {
  return (db
    .query("SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position")
    .all(parentId) as { child_id: string }[]
  ).map((r) => r.child_id);
}

test("moveNode updates child order for old and new parents", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");

  const parentAId = uuidv7();
  const parentBId = uuidv7();
  const childId = uuidv7();

  store.createNode({ nodeId: parentAId, kind: "page", parentId: null });
  store.createNode({ nodeId: parentBId, kind: "page", parentId: null });
  store.createNode({ nodeId: childId, kind: "block", parentId: parentAId });

  // Seed parentA's child-order CRDT by moving childId to itself (no-op move)
  // so the derived table reflects the initial parent relationship.
  store.moveNode(childId, parentAId);
  expect(getChildren(db, parentAId)).toEqual([childId]);
  expect(getChildren(db, parentBId)).toEqual([]);

  store.moveNode(childId, parentBId);

  const nodeRow = db.query("SELECT parent_id FROM node WHERE id = ?").get(childId) as {
    parent_id: string;
  };
  expect(nodeRow.parent_id).toBe(parentBId);

  expect(getChildren(db, parentAId)).toEqual([]);
  expect(getChildren(db, parentBId)).toEqual([childId]);
});

test("moveNode removes child from old parent and inserts under new parent", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");

  const parentAId = uuidv7();
  const parentBId = uuidv7();
  const child1Id = uuidv7();
  const child2Id = uuidv7();

  store.createNode({ nodeId: parentAId, kind: "page", parentId: null });
  store.createNode({ nodeId: parentBId, kind: "page", parentId: null });
  store.createNode({ nodeId: child1Id, kind: "block", parentId: parentAId });
  store.createNode({ nodeId: child2Id, kind: "block", parentId: parentAId });

  store.moveNode(child1Id, parentAId);
  store.moveNode(child2Id, parentAId);
  expect(getChildren(db, parentAId)).toEqual([child1Id, child2Id]);

  store.moveNode(child2Id, parentBId);
  expect(getChildren(db, parentAId)).toEqual([child1Id]);
  expect(getChildren(db, parentBId)).toEqual([child2Id]);
});
