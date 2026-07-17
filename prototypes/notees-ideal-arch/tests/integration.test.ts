import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSnapshot } from "../src/snapshot";
import { createCompactionSegment } from "../src/compaction";
import { SyncEngine } from "../src/sync";
import { MemoryRelay } from "../src/relay";
import { deriveKey } from "../src/crypto";

test("full vertical slice: create, snapshot, compact, sync, converge", async () => {
  const key = await deriveKey("slice-secret");
  const relay = new MemoryRelay();

  const dbA = new Database(":memory:");
  const storeA = new WorkspaceStore(dbA, "ws-1", "actor-a");
  storeA.createNode({ nodeId: "root", kind: "page", parentId: null });
  storeA.createNode({ nodeId: "child", kind: "block", parentId: "root" });
  storeA.updateText("child", (t) => t.insert(0, "Hello world"));
  storeA.setProperty({ propertyValueId: "pv-1", nodeId: "root", schemaId: "status", value: { value: "active" } });

  const snap = await createSnapshot(dbA, "ws-1");
  const segment = createCompactionSegment(dbA, "ws-1", snap.id);
  expect(segment.operationCount).toBeGreaterThan(0);

  const syncA = new SyncEngine(storeA, "actor-a", key);
  await syncA.pushTo(relay);

  const dbB = new Database(":memory:");
  const storeB = new WorkspaceStore(dbB, "ws-1", "actor-b");
  const syncB = new SyncEngine(storeB, "actor-b", key);
  await syncB.pullFrom(relay);

  const nodeA = storeA.getNode("child");
  const nodeB = storeB.getNode("child");
  expect(JSON.parse(nodeA.content)[0].text).toBe("Hello world");
  expect(nodeA.content).toBe(nodeB.content);
});
