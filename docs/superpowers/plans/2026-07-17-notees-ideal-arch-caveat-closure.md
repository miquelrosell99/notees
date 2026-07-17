# Notees Ideal Architecture — Caveat Closure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining caveats from the prototype hardening review so the architecture's correctness and maintainability claims hold.

**Caveats to close:**
1. `property.unset` needs tombstone support so a stale `property.set` cannot resurrect a deleted value.
2. HLC ties are not deterministically resolved beyond envelope-id sort order.
3. `SyncEngine` reaches into `WorkspaceStore` private fields via `as any`.
4. Edge rows are regenerated with new UUIDs on every content update (unstable edge identity).

**Tech Stack:** Same as prototype: Bun runtime, `bun:sqlite`, TypeScript 5.x, `yjs`, `uuidv7`.

## Global Constraints

- Every addressable entity uses UUIDv7.
- No integer IDs anywhere.
- Operations are immutable and carry HLC `{ physical: number; logical: number }`.
- Derived tables are eagerly maintained and rebuildable from the operation log.
- All code is tested with `bun test`.

---

## Status

All four caveats are closed. The prototype now passes `bun test` (50 tests) and `npx tsc -b --noEmit`.

- [x] Task 1: Property tombstones for robust LWW unset
- [x] Task 2: HLC tie-breaking by actor ID
- [x] Task 3: SyncEngine uses public WorkspaceStore accessors
- [x] Task 4: Stable edge identity on rebuild

---

## Task 1: Property Tombstones for Robust LWW Unset

**Why:** Without tombstones, a stale `property.set` can re-insert a value after a newer `property.unset` has deleted it. This breaks last-write-wins semantics.

**Status:** Done.

**Files:**
- Modify: `prototypes/notees-ideal-arch/src/db.ts` (add `property_value_tombstone` table)
- Modify: `prototypes/notees-ideal-arch/src/derived/property.ts`
- Modify: `prototypes/notees-ideal-arch/src/derived/node.ts` (cascade tombstones on delete)
- Modify: `prototypes/notees-ideal-arch/tests/derived/property.test.ts`
- Modify: `prototypes/notees-ideal-arch/tests/reconstructibility.test.ts`

**Design:**
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS property_value_tombstone (
    node_id TEXT NOT NULL,
    property_schema_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    PRIMARY KEY (node_id, property_schema_id, idx)
  );
  ```
- `property.set` checks tombstone before insert/update. If tombstone HLC > incoming HLC, ignore. If tombstone HLC == incoming HLC, use actor ID tie-breaker (see Task 2). If tombstone HLC < incoming HLC, proceed.
- `property.unset` deletes the row and upserts a tombstone with the unset's HLC and actor ID.
- `node.delete` cascades tombstones for the node.
- Reconstructibility test compares tombstone rows.

---

## Task 2: HLC Tie-Breaking by Actor ID

**Why:** Two actors can produce identical HLCs. Without a tie-breaker, LWW operations are non-deterministic.

**Status:** Done.

**Files:**
- Modify: `prototypes/notees-ideal-arch/src/derived/property.ts`
- Modify: `prototypes/notees-ideal-arch/src/db.ts` (add `actor_id` to `property_value`)
- Modify: `prototypes/notees-ideal-arch/tests/derived/property.test.ts`

**Design:**
- Store `actor_id` on `property_value` rows.
- Comparison order: HLC first, then `actor_id` lexicographically (UUIDv7 strings are sortable by creation time, which is a useful side effect).
- A tie-breaker helper `compareLww(incomingHlc, incomingActor, existingHlc, existingActor): number` returns positive only if incoming wins.
- Apply this helper to both `property.set` and `property.unset` (and tombstone checks).

---

## Task 3: SyncEngine Uses Public WorkspaceStore Accessors

**Why:** `SyncEngine` currently casts `WorkspaceStore` to `any` to access private `db` and `workspaceId`. This is fragile.

**Status:** Done.

**Files:**
- Modify: `prototypes/notees-ideal-arch/src/store.ts` (add public `getDb()` and `getWorkspaceId()`)
- Modify: `prototypes/notees-ideal-arch/src/sync.ts` (use public accessors)

**Design:**
- Add `getDb(): Database` and `getWorkspaceId(): string` methods to `WorkspaceStore`.
- Replace `(this.store as any).db` and `(this.store as any).workspaceId` in `SyncEngine` with these methods.

---

## Task 4: Stable Edge Identity on Rebuild

**Why:** `rebuildEdgesForNode` currently deletes all edges for a source and re-inserts them, generating new UUIDs and timestamps every time. Edge identity should be stable.

**Status:** Done.

**Files:**
- Modify: `prototypes/notees-ideal-arch/src/derived/edge.ts`
- Modify: `prototypes/notees-ideal-arch/tests/derived/edge.test.ts`
- Modify: `prototypes/notees-ideal-arch/tests/reconstructibility.test.ts`

**Design:**
- Compute desired edge set from content.
- Query existing edges for the source.
- Delete edges whose target is no longer desired.
- Insert edges for targets that are newly desired.
- Leave unchanged edges untouched (preserving `id`, `created_at`, and metadata).
- For explicit `ref` children, preserve labels. For inline `[[targetId]]` refs, label is null.

---

## Self-Review

After all tasks:
- Operation log remains the reconstructible source of truth.
- Property LWW is robust to out-of-order delivery and ties.
- Sync engine has no `as any` casts.
- Edge identity is stable across content updates.

**Known remaining out-of-scope items:**
- Real network transport / WebSocket relay
- Workspace key rotation and member removal
- Schema evolution for property values
- Cross-workspace references
- Plugin extensibility, whiteboard, computed properties, publishing, AI API

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-07-17-notees-ideal-arch-caveat-closure.md`.

Recommended approach: Subagent-Driven Development, one fresh subagent per task, with review between tasks.
