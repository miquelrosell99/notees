import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSnapshot, loadSnapshotData, latestSnapshot } from "../src/snapshot";

test("snapshot captures and restores derived state", async () => {
  const db1 = new Database(":memory:");
  const store = new WorkspaceStore(db1, "ws-1", "actor-1");
  store.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  store.updateText("page-1", (t) => t.insert(0, "Hello"));

  const snap = await createSnapshot(db1, "ws-1");

  const db2 = loadSnapshotData(snap.data);
  const node = db2.query("SELECT content FROM node WHERE id = ?").get("page-1") as { content: string };
  expect(JSON.parse(node.content)[0].text).toBe("Hello");
});
