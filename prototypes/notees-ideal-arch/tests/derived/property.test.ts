import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema } from "../../src/db";
import { applyPropertyOperation } from "../../src/derived/property";
import { createOperation } from "../../src/operation";

test("property.set stores a value", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const op = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "active" } }
  );

  applyPropertyOperation(db, op);
  const row = db
    .query("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status") as { value: string };
  expect(JSON.parse(row.value)).toEqual({ value: "active" });
});

test("property.unset removes a value", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const setOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "active" } }
  );
  applyPropertyOperation(db, setOp);

  const unsetOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1001, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.unset",
    },
    { nodeId: "node-1", schemaId: "status", index: 0 }
  );
  applyPropertyOperation(db, unsetOp);

  const row = db
    .query("SELECT 1 FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status");
  expect(row).toBeNull();
});

test("property.set ignores stale remote write when newer local write exists", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const newerOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 2000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "newer" } }
  );
  applyPropertyOperation(db, newerOp);

  const staleOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-2",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-2", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "stale" } }
  );
  applyPropertyOperation(db, staleOp);

  const row = db
    .query("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status") as { value: string };
  expect(JSON.parse(row.value)).toEqual({ value: "newer" });
});

test("property.unset ignores stale unset when newer set exists", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const setOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 2000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "active" } }
  );
  applyPropertyOperation(db, setOp);

  const staleUnsetOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-2",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.unset",
    },
    { nodeId: "node-1", schemaId: "status", index: 0 }
  );
  applyPropertyOperation(db, staleUnsetOp);

  const row = db
    .query("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status") as { value: string };
  expect(JSON.parse(row.value)).toEqual({ value: "active" });
});

test("tombstone blocks stale property.set after concurrent unset", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const setOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "active" } }
  );
  applyPropertyOperation(db, setOp);

  const unsetOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-2",
      hlc: { physical: 2000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.unset",
    },
    { nodeId: "node-1", schemaId: "status", index: 0 }
  );
  applyPropertyOperation(db, unsetOp);

  const staleSetOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-1",
      hlc: { physical: 1500, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-2", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "stale" } }
  );
  applyPropertyOperation(db, staleSetOp);

  const row = db
    .query("SELECT 1 FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status");
  expect(row).toBeNull();
});

test("tombstone wins property.unset tie-break by actor id", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const setOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-b",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "active" } }
  );
  applyPropertyOperation(db, setOp);

  const unsetOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-c",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.unset",
    },
    { nodeId: "node-1", schemaId: "status", index: 0 }
  );
  applyPropertyOperation(db, unsetOp);

  const row = db
    .query("SELECT 1 FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status");
  expect(row).toBeNull();
});

test("property.unset loses tie-break when actor id is lower than existing set", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const setOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-b",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "active" } }
  );
  applyPropertyOperation(db, setOp);

  const unsetOp = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-a",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.unset",
    },
    { nodeId: "node-1", schemaId: "status", index: 0 }
  );
  applyPropertyOperation(db, unsetOp);

  const row = db
    .query("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status") as { value: string };
  expect(JSON.parse(row.value)).toEqual({ value: "active" });
});

test("property.set wins tie-break by actor id when HLCs are equal", () => {
  const db = new Database(":memory:");
  createSchema(db);
  db.run("INSERT INTO node (id, workspace_id, kind, class_ids, content) VALUES (?, ?, ?, ?, ?)", [
    "node-1", "ws-1", "page", "[]", "[]",
  ]);

  const setOpA = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-a",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-1", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "a" } }
  );
  applyPropertyOperation(db, setOpA);

  const setOpB = createOperation(
    {
      workspaceId: "ws-1",
      actorId: "actor-b",
      hlc: { physical: 1000, logical: 0 },
      affectedNodeIds: ["node-1"],
      opType: "property.set",
    },
    { propertyValueId: "pv-2", nodeId: "node-1", schemaId: "status", index: 0, value: { value: "b" } }
  );
  applyPropertyOperation(db, setOpB);

  const row = db
    .query("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get("node-1", "status") as { value: string };
  expect(JSON.parse(row.value)).toEqual({ value: "b" });
});
