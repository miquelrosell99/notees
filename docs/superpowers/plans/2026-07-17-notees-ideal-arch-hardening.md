# Notees Ideal Architecture — Prototype Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan slice-by-slice. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close foundational gaps in the vertical slice prototype so that the operation log becomes a true, reconstructible source of truth and derived state remains consistent after every supported operation.

**Architecture:** The prototype keeps the same structure as the vertical slice. Operations are still immutable HLC-ordered events. Derived tables are still eagerly maintained in the same transaction that appends the operation. The hardening work focuses on completeness of derived projections and determinism of sync.

**Tech Stack:** Same as vertical slice: Bun runtime, `bun:sqlite`, TypeScript 5.x, `yjs`, `uuidv7`, Web Crypto API.

## Global Constraints

- Every addressable entity uses UUIDv7.
- No integer IDs anywhere.
- Operations are immutable and carry HLC `{ physical: number; logical: number }`.
- Workspace-private payloads are encrypted; envelope routing metadata is unencrypted.
- Derived tables are eagerly maintained but **rebuildable from the operation log**.
- All code is tested with Bun's built-in test runner (`bun test`).
- Frequent commits; each slice ends with a passing test.

---

## Slice 1: Delete/Move Cascade and Reconstructible Derived State

**Why this slice first:** The architecture claims the operation log is the source of truth. Right now `node.delete` leaves orphaned derived rows and `node.move` leaves `node_child_order` stale. Replaying the log into a fresh database would not reproduce the correct derived state, which invalidates snapshots, compaction, and sync.

**Files:**
- Modify: `prototypes/notees-ideal-arch/src/derived/node.ts`
- Modify: `prototypes/notees-ideal-arch/src/derived/childOrder.ts`
- Modify: `prototypes/notees-ideal-arch/src/derived/property.ts`
- Modify: `prototypes/notees-ideal-arch/src/derived/edge.ts`
- Modify: `prototypes/notees-ideal-arch/src/derived/crdtState.ts`
- Modify: `prototypes/notees-ideal-arch/src/store.ts`
- Create: `prototypes/notees-ideal-arch/tests/reconstructibility.test.ts`
- Create or modify: `prototypes/notees-ideal-arch/tests/derived/delete.test.ts`
- Create or modify: `prototypes/notees-ideal-arch/tests/derived/move.test.ts`

**Interfaces:**
- `node.delete` removes the node row and all related rows in `node_child_order`, `property_value`, `edge`, and `crdt_state`.
- `node.move` updates `node.parent_id` **and** updates the child-order CRDT/derived table so the moved node appears under its new parent.
- `WorkspaceStore` exposes `deleteNode(nodeId)` and `moveNode(nodeId, newParentId)` where `moveNode` emits a `node.updateContent` operation with a `treeUpdate` for the old parent, the new parent, and the moved node itself if needed.
- A new `reconstructibility.test.ts` replays the `operation` table into a fresh in-memory database and asserts the derived tables match the original.

**Detailed design:**

### `node.delete` cascade

In `src/derived/node.ts`, extend the `node.delete` branch:

```typescript
} else if (opType === "node.delete") {
  const nodeId = payload.nodeId;
  db.run("DELETE FROM node WHERE id = ?", [nodeId]);
  db.run("DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?", [nodeId, nodeId]);
  db.run("DELETE FROM property_value WHERE node_id = ?", [nodeId]);
  db.run("DELETE FROM edge WHERE source_id = ? OR target_id = ?", [nodeId, nodeId]);
  db.run("DELETE FROM crdt_state WHERE node_id = ?", [nodeId]);
  // search_index cleanup if populated
}
```

### `node.move` child-order update

`WorkspaceStore.moveNode` currently emits a `node.move` operation that only carries `newParentId`. Change it so that the store:

1. Loads the child-order CRDT for the **old parent** and removes `nodeId`.
2. Loads the child-order CRDT for the **new parent** and inserts `nodeId`.
3. Emits a single `node.updateContent` operation with a `treeUpdate` for each affected parent, OR emits separate operations for old-parent and new-parent updates.

For simplicity, emit two operations:
- `node.updateContent` for the old parent with `treeUpdate`.
- `node.updateContent` for the new parent with `treeUpdate`.
- `node.move` for the node row's `parent_id`.

All three are applied inside the same public `moveNode` call.

`applyChildOrderOperation` already handles `node.updateContent` with `treeUpdate`. Ensure it runs for both old and new parents.

### Reconstructibility test

```typescript
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkspaceStore } from "../src/store";
import { createSchema } from "../src/db";
import { applyNodeOperation } from "../src/derived/node";
import { applyChildOrderOperation } from "../src/derived/childOrder";
import { applyPropertyOperation } from "../src/derived/property";
import { rebuildEdgesForNode } from "../src/derived/edge";

test("derived state is reconstructible from operation log", () => {
  const db1 = new Database(":memory:");
  const store1 = new WorkspaceStore(db1, "ws-1", "actor-1");
  store1.createNode({ nodeId: "parent", kind: "page", parentId: null });
  store1.createNode({ nodeId: "child", kind: "block", parentId: "parent" });
  store1.updateText("child", (t) => t.insert(0, "Hello"));
  store1.setProperty({ propertyValueId: "pv-1", nodeId: "parent", schemaId: "status", value: { value: "active" } });
  store1.deleteNode("child");

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
        [row.id, row.workspace_id, row.actor_id, row.hlc_physical, row.hlc_logical, row.affected_node_ids, row.op_type, row.payload, row.timestamp]
      );
      applyNodeOperation(db2, op);
      applyChildOrderOperation(db2, op);
      applyPropertyOperation(db2, op);
      const p = op.payload as any;
      if (p?.nodeId) rebuildEdgesForNode(db2, p.nodeId);
    })();
  }

  // Compare derived tables
  const nodes1 = db1.query("SELECT id, kind, parent_id, content FROM node ORDER BY id").all();
  const nodes2 = db2.query("SELECT id, kind, parent_id, content FROM node ORDER BY id").all();
  expect(nodes2).toEqual(nodes1);

  const props1 = db1.query("SELECT node_id, property_schema_id, value FROM property_value ORDER BY node_id, property_schema_id").all();
  const props2 = db2.query("SELECT node_id, property_schema_id, value FROM property_value ORDER BY node_id, property_schema_id").all();
  expect(props2).toEqual(props1);

  const order1 = db1.query("SELECT parent_id, child_id FROM node_child_order ORDER BY parent_id, child_id").all();
  const order2 = db2.query("SELECT parent_id, child_id FROM node_child_order ORDER BY parent_id, child_id").all();
  expect(order2).toEqual(order1);

  const edges1 = db1.query("SELECT source_id, target_id, type FROM edge ORDER BY source_id, target_id").all();
  const edges2 = db2.query("SELECT source_id, target_id, type FROM edge ORDER BY source_id, target_id").all();
  expect(edges2).toEqual(edges1);
});
```

**Steps:**

1. Add `deleteNode(nodeId)` to `WorkspaceStore`.
2. Update `node.delete` cascade in `src/derived/node.ts`.
3. Update `moveNode` in `WorkspaceStore` to emit child-order updates.
4. Add `delete.test.ts` and `move.test.ts`.
5. Add `reconstructibility.test.ts`.
6. Run full suite and ensure all tests pass.
7. Commit.

---

## Slice 2: Deterministic Sync Ordering and Persisted Watermark

**Why this slice:** The current `SyncEngine.pullFrom` applies envelopes in relay-insertion order. For CRDT-backed text/tree this is fine, but for non-commutative operations (e.g., `node.delete` vs `node.updateContent`) the derived state can diverge. Also, `lastReceivedHlc` is in-memory only.

**Goals:**
- Sort pulled envelopes by HLC before applying.
- Persist `lastReceivedHlc` in the local DB (e.g., a `sync_watermark` table or a simple key-value row).
- Make `property.set` and `property.unset` HLC-aware so stale remote writes cannot clobber newer local writes when envelopes arrive out of order.
- Add tests with interleaved offline edits that verify convergence after multiple pull/push cycles.

**Files:**
- Modify: `src/sync.ts`
- Modify: `src/db.ts` (add `sync_watermark` table; add HLC columns to `property_value`)
- Modify: `src/derived/property.ts`
- Modify: `tests/sync.test.ts`

---

## Slice 3: Search Index and Backlink Population

**Why this slice:** The `search_index` FTS5 table and `edge` backlink table exist but are not populated by normal store operations.

**Goals:**
- On `node.updateContent`, tokenize plaintext and insert/update `search_index` rows.
- On `node.updateContent`, parse inline `ref` marks and create `edge` rows.
- Expose a store API or derived helper to query backlinks for a node.
- Add tests for search and backlinks.

**Files:**
- Modify: `src/derived/node.ts` or create `src/derived/search.ts`
- Modify: `src/derived/edge.ts`
- Modify: `src/store.ts`
- Create: `tests/derived/search.test.ts`
- Create: `tests/derived/backlinks.test.ts`

---

## Self-Review

**Spec coverage after all slices:**
- Operation log + HLC: complete
- Derived projections: complete for create, delete, move, content, property, edge, search
- CRDT tree/text: complete
- Snapshots/compaction: source-of-truth guarantee valid
- Encrypted sync: routing metadata preserved
- Offline→online convergence: deterministic ordering

**Known remaining out-of-scope items:**
- Real network transport / WebSocket relay
- Workspace key rotation and member removal
- Schema evolution for property values
- Cross-workspace references (still forbidden)
- Plugin extensibility, whiteboard, computed properties, publishing, AI API

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-07-17-notees-ideal-arch-hardening.md`.

Recommended approach: Subagent-Driven Development, one fresh subagent per hardening slice, with review between slices.
