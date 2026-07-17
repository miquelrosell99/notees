# Notees Full Migration Plan: Current App → Ideal Architecture

**Date:** 2026-07-17  
**Branch:** `main` (caveat closure merged at `df9f567d`)  
**Scope:** Migrate the real Notees app (`app/`, `frontend/`, PostgreSQL) to the local-first, operation-log, CRDT-driven architecture defined in `docs/superpowers/specs/2026-07-17-notees-ideal-data-architecture-design.md`.

---

## Executive Summary

The gap analysis (`agents/plans/notees-migration-gap-analysis.md`) confirms this is a **fundamental rewrite**, not an incremental migration. The current Notees app has mutable PostgreSQL rows as the source of truth; the ideal architecture has an immutable operation log with client-side SQLite derived state.

This plan uses a **parallel-track rewrite** strategy:
- Track A: Build the new ideal core (operation log, SQLite derived state, CRDT reducers, encrypted relay) in a clean module tree.
- Track B: Build a one-way PostgreSQL → operation-log migration/export path.
- Track C: Gradually replace frontend data layer (TanStack Query → local SQLite).
- Track D: Cut over and deprecate the old stack.

Each phase produces a snapshot commit and a verifiable milestone.

---

## Approach

**Recommended: Parallel-track rewrite with gradual cut-over.**

Rationale:
- Incremental in-place migration is impossible because the storage model (mutable rows vs. immutable log) and authority model (server vs. client) are incompatible.
- A clean rewrite lets the prototype (`prototypes/notees-ideal-arch/`) evolve into the production core without fighting existing code.
- Keeping the old app running during construction avoids breaking the current product.

Alternatives considered and rejected:
- **Big-bang rewrite:** too risky; loses intermediate working states.
- **Strangler fig inside the same codebase:** the data authority boundary cannot be strangled incrementally; every feature would need dual writes.

---

## Global Constraints

- UUIDv7 everywhere; no integer IDs in the new core.
- Operation log is the source of truth; all other tables are derived.
- End-to-end encryption for workspace-private payloads.
- Server is an encrypted operation relay + permission enforcer.
- Frontend SQLite is the primary runtime store.
- Snapshot commits after every completed phase.

---

## Phase 1: New Core Skeleton (Foundation)

**Goal:** Establish the new architecture module tree and the operation-log/SQLite core inside the real Notees repo.

**Status:** Done. Committed as `feat(core,relay,frontend): Phase 1 new core skeleton`.

**Completed sub-tasks:**
- A1: `app/core/` operation types, HLC, UUIDv7, validation (28 tests).
- A2: `app/relay/` encrypted operation relay with SQLite storage, FastAPI router, permission stubs (17 tests).
- A3: `frontend/src/core/` SQLite runtime, CRDT adapters, workspace store, sync engine (6 tests).
- A4: `pyproject.toml` packages, `@/core` Vite alias, relay router tests.

**Verification:**
- `uv run pytest tests/core -m unit --no-cov` → 45 passed.
- `uv run ruff check app/core app/relay tests/core pyproject.toml` → clean.
- `cd frontend && npm run test:run src/core && npm run typecheck` → 6 passed, typecheck clean.

**Deliverables:**
1. New backend package `app/core/` containing:
   - `operation/` — operation envelope, payload types, HLC, validation.
   - `clock/` — HLC implementation (port from prototype or reuse).
   - `crdt/` — tree ordering CRDT and text CRDT adapters (Yjs-based).
   - `derived/` — SQLite derived-state appliers: node, child order, property, edge, search.
   - `workspace_store/` — local SQLite workspace store (port from prototype).
   - `sync_engine/` — encrypted push/pull sync engine.
2. New backend package `app/relay/` — encrypted operation relay server with workspace/node-level permission checks.
3. New frontend package `frontend/src/core/` with SQLite runtime wrapper (sql.js/OPFS), sync client, and derived-state hooks.
4. Shared TypeScript/Python operation schemas in a new `schemas/` or `packages/` directory.
5. Tests for the new core: `tests/core/`, `frontend/src/core/**/*.test.ts`.

**Files to create/modify:**
- Create `app/core/` (new package, ~15–20 files).
- Create `app/relay/` (new package, ~5 files).
- Create `frontend/src/core/` (new package, ~10–15 files).
- Create `tests/core/` (new test tree).
- Modify `pyproject.toml` to include new packages.
- Modify `frontend/vite.config.ts` for sql.js wasm bundling if needed.

**Verification:**
- `uv run pytest tests/core -m unit --no-cov` passes.
- `cd frontend && npm run test:run` for core tests passes.
- Type checking passes for both stacks.

**Subagent breakdown:**
- Subagent A1: Port/adapt operation log + HLC + CRDT reducers from prototype to `app/core/`.
- Subagent A2: Build `app/relay/` encrypted relay + permission stubs.
- Subagent A3: Build `frontend/src/core/` SQLite runtime + sync client.
- Subagent A4: Add tests and wire build configs.

---

## Phase 2: PostgreSQL → Operation Log Migration Path

**Goal:** Export existing Notees workspaces into the new operation-log + SQLite format.

**Status:** Pending.

**Deliverables:**
1. `scripts/migrate_to_ideal.py` — read PostgreSQL, emit operations for every workspace.
2. Operation generators for:
   - `node.create` (pages, blocks, classes, with class assignments).
   - `node.updateContent` (title/body text as CRDT updates).
   - `node.move` (reconstruct tree positions).
   - `propertySchema.create` and `property.set`.
   - `class.create` / `class.update`.
   - `node.delete` for soft-deleted rows.
3. Asset migration: create `file` property nodes and copy blobs into content-addressed storage.
4. Validation: replay generated operations into a test SQLite store and compare derived state against PostgreSQL.

**Files to create/modify:**
- Create `scripts/migrate_to_ideal.py`.
- Create `app/core/migration/` package.
- Create `tests/core/migration/` tests.
- Read-only access to `app/db/schema/sql.py`, `app/features/nodes/`, `app/features/properties/`.

**Verification:**
- Migration script runs against a copy of production-like data.
- Derived SQLite state matches PostgreSQL state for nodes, properties, hierarchy, and edges within tolerance.

**Subagent breakdown:**
- Subagent B1: Node/hierarchy migration.
- Subagent B2: Property/class/schema migration.
- Subagent B3: Asset/link/reference migration.
- Subagent B4: Validation and reconciliation tests.

---

## Phase 3: QueryAST Retarget to SQLite

**Goal:** Make QueryAST compile to SQLite SQL against the new derived tables.

**Status:** Pending.

**Deliverables:**
1. `app/core/query_ast/` — SQLite SQL compiler mirroring `app/domain/services/query_ast_sql.py`.
2. Frontend QueryAST compiler `frontend/src/core/query/compileToSqlite.ts`.
3. Test parity: run existing QueryAST test cases against the SQLite compiler.

**Files to create/modify:**
- Create `app/core/query_ast/`.
- Create `frontend/src/core/query/`.
- Create `tests/core/query_ast/`.

**Verification:**
- Existing QueryAST fixtures produce equivalent results against SQLite derived state.

**Subagent breakdown:**
- Subagent C1: Backend SQLite QueryAST compiler.
- Subagent C2: Frontend SQLite QueryAST compiler + tests.

---

## Phase 4: Frontend Cut-Over

**Goal:** Replace the authoritative TanStack Query cache with the local SQLite store.

**Status:** Pending.

**Deliverables:**
1. `frontend/src/core/stores/workspaceStore.ts` — Zustand/TanStack Query integration where SQLite is source of truth.
2. `frontend/src/core/hooks/useNode.ts`, `useQueryAst.ts`, `useSync.ts`.
3. Adapter layer that bridges existing UI components to the new core while old components are rewritten.
4. Service worker updated to serve offline from SQLite.

**Files to create/modify:**
- Create `frontend/src/core/hooks/`.
- Modify `frontend/src/main.tsx` to initialize SQLite runtime.
- Modify `frontend/src/App.tsx` routing to use new data hooks.
- Gradually modify `frontend/src/features/content/`, `frontend/src/features/properties/`.

**Verification:**
- Existing E2E tests pass against new data layer (or are replaced).
- Offline smoke test: create node, go offline, edit, reconnect, converge.

**Subagent breakdown:**
- Subagent D1: Core hooks + store adapter.
- Subagent D2: Content/editor feature bridge.
- Subagent D3: Properties/views feature bridge.
- Subagent D4: Service worker + PWA offline tests.

---

## Phase 5: Server Relay Hardening and Production Cut-Over

**Goal:** Replace the current FastAPI mutation endpoints with the encrypted operation relay.

**Status:** Pending.

**Deliverables:**
1. `app/relay/` becomes the primary server API.
2. WebSocket endpoint forwards encrypted envelopes per workspace.
3. `POST /api/relay/batch` accepts encrypted operation batches.
4. Catch-up endpoint serves operations since a given HLC.
5. Share/public-link endpoints adapted to operation-log model.
6. Workspace key management endpoints.

**Files to create/modify:**
- Modify `app/main.py` to mount relay routers alongside legacy routers.
- Modify `app/features/shares/` to integrate with relay permissions.
- Create `app/relay/permissions.py`, `app/relay/storage.py`.

**Verification:**
- Multi-client sync convergence tests pass.
- Permission tests: unauthorized clients cannot pull operations.
- Load tests on catch-up replay.

**Subagent breakdown:**
- Subagent E1: Relay HTTP/WebSocket endpoints.
- Subagent E2: Permission + share integration.
- Subagent E3: Key management + encryption.
- Subagent E4: Conformance and load tests.

---

## Phase 6: Cleanup and Deprecation

**Goal:** Remove the old mutable-row stack once the new stack is proven.

**Status:** Pending.

**Deliverables:**
1. Remove `app/features/nodes/`, `app/features/properties/`, `app/features/sync/` old implementations.
2. Remove old `app/routers/`, `app/domain/services/query_ast_sql.py`, mutable schema sections.
3. Remove old frontend `frontend/src/features/sync/local/` IndexedDB mirror.
4. Final migration run for all workspaces.
5. Update documentation and AGENTS.md.

**Files to modify/delete:**
- Large deletion PR; final cleanup.

**Verification:**
- Full test suite passes.
- Production migration smoke test passes.

---

## Execution Order

Phases run mostly sequentially because each depends on the previous, but within a phase subagents work in parallel:

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
   │          │          │          │          │          │
   └─ A1..A4  └─ B1..B4  └─ C1..C2  └─ D1..D4  └─ E1..E4  └─ cleanup
```

---

## Snapshot Commit Policy

- Commit after each phase completes and tests pass.
- Conventional Commits: `feat(core): ...`, `feat(relay): ...`, `feat(migration): ...`, `test(core): ...`.
- Each commit message references the phase number and milestone.
- No force-pushes; merge to `main` via fast-forward or PR as appropriate.

---

## Risk Register

| Risk | Mitigation |
|---|---|
| CRDT complexity | Validate with convergence tests after Phase 1. |
| Migration data loss | Phase 2 validation compares derived state to PostgreSQL. |
| OPFS/sql.js browser limits | Phase 4 includes platform smoke tests. |
| Performance on large workspaces | Phase 5 load tests catch-up replay and snapshots. |
| Team disruption | Parallel-track keeps old app deployable until Phase 6. |

---

## Immediate Next Step

Begin **Phase 1** by creating the `app/core/` skeleton and porting the operation-log/HLC/CRDT foundation from `prototypes/notees-ideal-arch/` into the production codebase.
