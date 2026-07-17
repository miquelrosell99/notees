import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../../src/store";
import { uuidv7 } from "../../src/uuid";

test("inline [[targetId]] reference creates an edge", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  const sourceId = uuidv7();
  const targetId = uuidv7();

  store.createNode({ nodeId: sourceId, kind: "page", parentId: null });
  store.createNode({ nodeId: targetId, kind: "page", parentId: null });
  store.updateText(sourceId, (t) => t.insert(0, `See also [[${targetId}]] for details`));

  const rows = db
    .query("SELECT target_id FROM edge WHERE source_id = ?")
    .all(sourceId) as { target_id: string }[];
  expect(rows.map((r) => r.target_id)).toContain(targetId);
});

test("getBacklinks returns source nodes that reference a target", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  const sourceA = uuidv7();
  const sourceB = uuidv7();
  const targetId = uuidv7();

  store.createNode({ nodeId: sourceA, kind: "page", parentId: null });
  store.createNode({ nodeId: sourceB, kind: "page", parentId: null });
  store.createNode({ nodeId: targetId, kind: "page", parentId: null });

  store.updateText(sourceA, (t) => t.insert(0, `Link to [[${targetId}]]`));
  store.updateText(sourceB, (t) => t.insert(0, `Another [[${targetId}]] mention`));

  const backlinks = store.getBacklinks(targetId);
  expect(backlinks).toHaveLength(2);
  expect(backlinks).toContain(sourceA);
  expect(backlinks).toContain(sourceB);
});

test("backlinks are removed when source node is deleted", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  const sourceId = uuidv7();
  const targetId = uuidv7();

  store.createNode({ nodeId: sourceId, kind: "page", parentId: null });
  store.createNode({ nodeId: targetId, kind: "page", parentId: null });
  store.updateText(sourceId, (t) => t.insert(0, `Link to [[${targetId}]]`));
  store.deleteNode(sourceId);

  expect(store.getBacklinks(targetId)).toHaveLength(0);
});

test("backlinks are updated when source content changes", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  const sourceId = uuidv7();
  const targetA = uuidv7();
  const targetB = uuidv7();

  store.createNode({ nodeId: sourceId, kind: "page", parentId: null });
  store.createNode({ nodeId: targetA, kind: "page", parentId: null });
  store.createNode({ nodeId: targetB, kind: "page", parentId: null });

  store.updateText(sourceId, (t) => t.insert(0, `First [[${targetA}]]`));
  expect(store.getBacklinks(targetA)).toContain(sourceId);
  expect(store.getBacklinks(targetB)).toHaveLength(0);

  store.updateText(sourceId, (t) => {
    t.delete(0, t.toPlaintext().length);
    t.insert(0, `Now [[${targetB}]]`);
  });
  expect(store.getBacklinks(targetA)).toHaveLength(0);
  expect(store.getBacklinks(targetB)).toContain(sourceId);
});
