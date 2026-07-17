import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../../src/store";
import { uuidv7 } from "../../src/uuid";

test("node.delete cascades to derived tables", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");

  const parentId = uuidv7();
  const childId = uuidv7();
  const otherId = uuidv7();
  const propertyValueId = uuidv7();
  const schemaId = uuidv7();

  store.createNode({ nodeId: parentId, kind: "page", parentId: null });
  store.createNode({ nodeId: otherId, kind: "page", parentId: null });
  store.createNode({ nodeId: childId, kind: "block", parentId: parentId });
  // Populate node_child_order by moving the child; createNode alone does not.
  store.moveNode(childId, otherId);
  store.updateText(childId, (t) => t.insert(0, "Hello [[ref]]"));
  store.setProperty({ propertyValueId, nodeId: childId, schemaId, value: { value: "active" } });

  // Manually insert an edge where childId is the source and otherId is the target.
  db.run(
    "INSERT INTO edge (id, workspace_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
    [uuidv7(), "ws-1", childId, otherId, "reference"]
  );

  store.deleteNode(childId);

  const nodeRow = db.query("SELECT id FROM node WHERE id = ?").get(childId);
  expect(nodeRow).toBeNull();

  const childOrderRows = db
    .query("SELECT 1 FROM node_child_order WHERE parent_id = ? OR child_id = ?")
    .all(childId, childId) as unknown[];
  expect(childOrderRows.length).toBe(0);

  const propertyRows = db
    .query("SELECT 1 FROM property_value WHERE node_id = ?")
    .all(childId) as unknown[];
  expect(propertyRows.length).toBe(0);

  const edgeRows = db
    .query("SELECT 1 FROM edge WHERE source_id = ? OR target_id = ?")
    .all(childId, childId) as unknown[];
  expect(edgeRows.length).toBe(0);

  const crdtRows = db.query("SELECT 1 FROM crdt_state WHERE node_id = ?").all(childId) as unknown[];
  expect(crdtRows.length).toBe(0);
});
