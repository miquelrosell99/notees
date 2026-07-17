import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { MemoryRelay } from "../src/relay";
import { SyncEngine } from "../src/sync";
import { deriveKey } from "../src/crypto";

test("two clients converge after offline edits", async () => {
  const key = await deriveKey("shared-secret");
  const relay = new MemoryRelay();

  const dbA = new Database(":memory:");
  const storeA = new WorkspaceStore(dbA, "ws-1", "actor-a");
  const syncA = new SyncEngine(storeA, "actor-a", key);

  const dbB = new Database(":memory:");
  const storeB = new WorkspaceStore(dbB, "ws-1", "actor-b");
  const syncB = new SyncEngine(storeB, "actor-b", key);

  // Client A creates page offline.
  storeA.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  storeA.updateText("page-1", (t) => t.insert(0, "A"));

  // Client B creates page offline.
  storeB.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  storeB.updateText("page-1", (t) => t.insert(0, "B"));

  // Sync both ways through relay.
  await syncA.pushTo(relay);
  await syncB.pullFrom(relay);
  await syncB.pushTo(relay);
  await syncA.pullFrom(relay);

  const nodeA = storeA.getNode("page-1");
  const nodeB = storeB.getNode("page-1");
  expect(nodeA.content).toBe(nodeB.content);
});
