import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../../src/store";
import { uuidv7 } from "../../src/uuid";

test("search_index is populated on text update", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  const nodeId = uuidv7();

  store.createNode({ nodeId, kind: "page", parentId: null });
  store.updateText(nodeId, (t) => t.insert(0, "Hello world"));

  const rows = db.query("SELECT content FROM search_index WHERE node_id = ?").all(nodeId) as {
    content: string;
  }[];
  expect(rows.length).toBe(1);
  expect(rows[0].content).toBe("Hello world");
});

test("search_index is replaced on subsequent text updates", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  const nodeId = uuidv7();

  store.createNode({ nodeId, kind: "page", parentId: null });
  store.updateText(nodeId, (t) => t.insert(0, "Hello world"));
  store.updateText(nodeId, (t) => {
    t.delete(0, 5);
    t.insert(0, "Goodbye");
  });

  const rows = db.query("SELECT content FROM search_index WHERE node_id = ?").all(nodeId) as {
    content: string;
  }[];
  expect(rows.length).toBe(1);
  expect(rows[0].content).toBe("Goodbye world");
});

test("search_index supports full-text search", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  const nodeA = uuidv7();
  const nodeB = uuidv7();

  store.createNode({ nodeId: nodeA, kind: "page", parentId: null });
  store.createNode({ nodeId: nodeB, kind: "page", parentId: null });
  store.updateText(nodeA, (t) => t.insert(0, "The quick brown fox"));
  store.updateText(nodeB, (t) => t.insert(0, "Lazy dog afternoon"));

  const matches = db
    .query("SELECT node_id FROM search_index WHERE content MATCH ?")
    .all("quick") as { node_id: string }[];
  expect(matches.map((m) => m.node_id)).toContain(nodeA);
  expect(matches.map((m) => m.node_id)).not.toContain(nodeB);
});

test("search_index row is removed when node is deleted", () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  const nodeId = uuidv7();

  store.createNode({ nodeId, kind: "page", parentId: null });
  store.updateText(nodeId, (t) => t.insert(0, "Hello world"));
  store.deleteNode(nodeId);

  const rows = db.query("SELECT 1 FROM search_index WHERE node_id = ?").all(nodeId) as unknown[];
  expect(rows.length).toBe(0);
});
