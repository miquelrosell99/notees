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
