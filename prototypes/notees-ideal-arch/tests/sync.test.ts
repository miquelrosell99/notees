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

function getPropertyValue(db: Database, propertyValueId: string): unknown {
  const row = db
    .query("SELECT value FROM property_value WHERE id = ?")
    .get(propertyValueId) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}

function getOperationRows(db: Database): { id: string; hlc: { physical: number; logical: number } }[] {
  const rows = db
    .query("SELECT id, hlc_physical, hlc_logical FROM operation ORDER BY hlc_physical ASC, hlc_logical ASC, id ASC")
    .all() as any[];
  return rows.map((r) => ({ id: r.id, hlc: { physical: r.hlc_physical, logical: r.hlc_logical } }));
}

test("converges after interleaved offline edits with non-commutative ordering", async () => {
  const key = await deriveKey("shared-secret");
  const relay = new MemoryRelay();

  const dbA = new Database(":memory:");
  const storeA = new WorkspaceStore(dbA, "ws-1", "actor-a");
  const syncA = new SyncEngine(storeA, "actor-a", key);

  const dbB = new Database(":memory:");
  const storeB = new WorkspaceStore(dbB, "ws-1", "actor-b");
  const syncB = new SyncEngine(storeB, "actor-b", key);

  // Establish a shared starting state.
  storeA.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  storeA.setProperty({ propertyValueId: "pv-1", nodeId: "page-1", schemaId: "status", value: { value: "draft" } });
  await syncA.pushTo(relay);
  await syncB.pullFrom(relay);

  // Both clients go offline and edit the same property value.
  // B edits first in physical time -> lower HLC.
  storeB.setProperty({ propertyValueId: "pv-1", nodeId: "page-1", schemaId: "status", value: { value: "review" } });
  await new Promise((r) => setTimeout(r, 50));
  // A edits second in physical time -> higher HLC.
  storeA.setProperty({ propertyValueId: "pv-1", nodeId: "page-1", schemaId: "status", value: { value: "done" } });

  // A pushes first, so the relay holds the higher-HLC envelope before the lower-HLC one.
  await syncA.pushTo(relay);
  await syncB.pushTo(relay);

  // Pull in both directions.
  await syncA.pullFrom(relay);
  await syncB.pullFrom(relay);
  await syncA.pullFrom(relay);

  // HLC ordering must make A's later write win on both sides.
  const valueA = getPropertyValue(dbA, "pv-1");
  const valueB = getPropertyValue(dbB, "pv-1");
  expect(valueA).toEqual({ value: "done" });
  expect(valueB).toEqual(valueA);

  // Operation-log integrity: both logs sorted by HLC are identical.
  expect(getOperationRows(dbA)).toEqual(getOperationRows(dbB));
});

test("SyncEngine loads persisted watermark on restart and avoids replay", async () => {
  const key = await deriveKey("shared-secret");
  const relay = new MemoryRelay();

  const dbB = new Database(":memory:");
  const storeB = new WorkspaceStore(dbB, "ws-1", "actor-b");
  const syncB = new SyncEngine(storeB, "actor-b", key);

  const dbA = new Database(":memory:");
  const storeA = new WorkspaceStore(dbA, "ws-1", "actor-a");
  const syncA = new SyncEngine(storeA, "actor-a", key);

  storeA.createNode({ nodeId: "page-1", kind: "page", parentId: null });
  await syncA.pushTo(relay);
  await syncB.pullFrom(relay);

  // Simulate restart by constructing a new SyncEngine against the same store.
  const syncBRestarted = new SyncEngine(storeB, "actor-b", key);
  await syncBRestarted.pullFrom(relay);

  // The watermark row should exist and match the latest operation.
  const watermark = dbB
    .query("SELECT hlc_physical, hlc_logical FROM sync_watermark WHERE workspace_id = ?")
    .get("ws-1") as { hlc_physical: number; hlc_logical: number } | undefined;
  expect(watermark).toBeDefined();

  const latestOp = dbB
    .query("SELECT hlc_physical, hlc_logical FROM operation ORDER BY hlc_physical DESC, hlc_logical DESC LIMIT 1")
    .get() as { hlc_physical: number; hlc_logical: number };
  expect(watermark).toEqual({ hlc_physical: latestOp.hlc_physical, hlc_logical: latestOp.hlc_logical });

  // Operation count is unchanged (no replay).
  const countB = dbB.query("SELECT COUNT(*) as count FROM operation").get() as { count: number };
  expect(countB.count).toBe(1);
});
