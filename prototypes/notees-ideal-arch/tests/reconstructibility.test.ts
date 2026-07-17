import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSchema } from "../src/db";
import { applyNodeOperation } from "../src/derived/node";
import { applyChildOrderOperation } from "../src/derived/childOrder";
import { applyPropertyOperation } from "../src/derived/property";
import { rebuildEdgesForNode } from "../src/derived/edge";
import { uuidv7 } from "../src/uuid";

test("derived state is reconstructible from operation log", () => {
  const db1 = new Database(":memory:");
  const store1 = new WorkspaceStore(db1, "ws-1", "actor-1");

  const parentId = uuidv7();
  const childId = uuidv7();
  const propertyValueId = uuidv7();
  const schemaId = uuidv7();

  store1.createNode({ nodeId: parentId, kind: "page", parentId: null });
  store1.createNode({ nodeId: childId, kind: "block", parentId: parentId });
  store1.updateText(childId, (t) => t.insert(0, "Hello"));
  store1.setProperty({
    propertyValueId,
    nodeId: parentId,
    schemaId,
    value: { value: "active" },
  });
  store1.moveNode(childId, null);
  store1.deleteNode(childId);

  const db2 = new Database(":memory:");
  createSchema(db2);

  const ops = db1
    .query("SELECT * FROM operation ORDER BY hlc_physical ASC, hlc_logical ASC")
    .all() as any[];

  for (const row of ops) {
    const op = {
      envelope: {
        id: row.id,
        workspaceId: row.workspace_id,
        actorId: row.actor_id,
        hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
        affectedNodeIds: JSON.parse(row.affected_node_ids),
        opType: row.op_type,
      },
      payload: JSON.parse(row.payload),
    };

    db2.transaction(() => {
      db2.run(
        `INSERT INTO operation (id, workspace_id, actor_id, hlc_physical, hlc_logical, affected_node_ids, op_type, payload, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.workspace_id,
          row.actor_id,
          row.hlc_physical,
          row.hlc_logical,
          row.affected_node_ids,
          row.op_type,
          row.payload,
          row.timestamp,
        ]
      );
      applyNodeOperation(db2, op);
      applyChildOrderOperation(db2, op);
      applyPropertyOperation(db2, op);
      const p = op.payload as any;
      if (p?.nodeId) rebuildEdgesForNode(db2, p.nodeId);
    })();
  }

  const nodes1 = db1.query("SELECT id, kind, parent_id, content FROM node ORDER BY id").all();
  const nodes2 = db2.query("SELECT id, kind, parent_id, content FROM node ORDER BY id").all();
  expect(nodes2).toEqual(nodes1);

  const props1 = db1
    .query("SELECT node_id, property_schema_id, value FROM property_value ORDER BY node_id, property_schema_id")
    .all();
  const props2 = db2
    .query("SELECT node_id, property_schema_id, value FROM property_value ORDER BY node_id, property_schema_id")
    .all();
  expect(props2).toEqual(props1);

  const order1 = db1
    .query("SELECT parent_id, child_id FROM node_child_order ORDER BY parent_id, child_id")
    .all();
  const order2 = db2
    .query("SELECT parent_id, child_id FROM node_child_order ORDER BY parent_id, child_id")
    .all();
  expect(order2).toEqual(order1);

  const edges1 = db1.query("SELECT source_id, target_id, type FROM edge ORDER BY source_id, target_id").all();
  const edges2 = db2.query("SELECT source_id, target_id, type FROM edge ORDER BY source_id, target_id").all();
  expect(edges2).toEqual(edges1);
});
