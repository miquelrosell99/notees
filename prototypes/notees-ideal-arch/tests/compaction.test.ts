import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSnapshot } from "../src/snapshot";
import { createCompactionSegment, listCompactionSegments } from "../src/compaction";

test("compaction segment records operation range", async () => {
  const db = new Database(":memory:");
  const store = new WorkspaceStore(db, "ws-1", "actor-1");
  store.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  store.updateText("page-1", (t) => t.insert(0, "Hello"));

  const snap = await createSnapshot(db, "ws-1");
  const segment = createCompactionSegment(db, "ws-1", snap.id);

  expect(segment.operationCount).toBe(2);
  expect(listCompactionSegments(db, "ws-1").length).toBe(1);
});
