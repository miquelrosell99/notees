import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSchema } from "../src/db";
import { applyNodeOperation } from "../src/derived/node";
import { applyChildOrderOperation } from "../src/derived/childOrder";
import { applyPropertyOperation } from "../src/derived/property";
import { rebuildEdgesForNode } from "../src/derived/edge";
import { reindexNode } from "../src/derived/search";
import { uuidv7 } from "../src/uuid";

test("derived state is reconstructible from operation log", () => {
  const db1 = new Database(":memory:");
  const store1 = new WorkspaceStore(db1, "ws-1", "actor-1");

  const parentId = uuidv7();
  const otherParentId = uuidv7();
  const childId = uuidv7();

  store1.createNode({ nodeId: parentId, kind: "page", parentId: null });
  store1.createNode({ nodeId: otherParentId, kind: "page", parentId: null });
  store1.updateText(parentId, (t) => t.insert(0, "Parent title"));

  store1.createNode({ nodeId: childId, kind: "block", parentId: parentId });
  store1.moveNode(childId, otherParentId);
  store1.updateText(childId, (t) => t.insert(0, "Hello"));
  store1.setProperty({
    propertyValueId: uuidv7(),
    nodeId: childId,
    schemaId: uuidv7(),
    value: { value: "child-value" },
  });
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
      if (p?.nodeId) {
        rebuildEdgesForNode(db2, p.nodeId);
        reindexNode(db2, p.nodeId);
      }
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

  const tombstones1 = db1
    .query("SELECT node_id, property_schema_id, idx, hlc_physical, hlc_logical, actor_id FROM property_value_tombstone ORDER BY node_id, property_schema_id, idx")
    .all();
  const tombstones2 = db2
    .query("SELECT node_id, property_schema_id, idx, hlc_physical, hlc_logical, actor_id FROM property_value_tombstone ORDER BY node_id, property_schema_id, idx")
    .all();
  expect(tombstones2).toEqual(tombstones1);

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

  const crdt1 = db1
    .query("SELECT node_id, text_state, tree_state FROM crdt_state ORDER BY node_id")
    .all() as { node_id: string; text_state: Uint8Array; tree_state: Uint8Array }[];
  const crdt2 = db2
    .query("SELECT node_id, text_state, tree_state FROM crdt_state ORDER BY node_id")
    .all() as { node_id: string; text_state: Uint8Array; tree_state: Uint8Array }[];
  expect(crdt2.length).toBe(crdt1.length);
  for (let i = 0; i < crdt1.length; i++) {
    expect(crdt2[i].node_id).toBe(crdt1[i].node_id);
    expect(crdt2[i].text_state).toEqual(crdt1[i].text_state);
    expect(crdt2[i].tree_state).toEqual(crdt1[i].tree_state);
  }

  const search1 = db1.query("SELECT node_id, content FROM search_index ORDER BY node_id").all();
  const search2 = db2.query("SELECT node_id, content FROM search_index ORDER BY node_id").all();
  expect(search2).toEqual(search1);
});
