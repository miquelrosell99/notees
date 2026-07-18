# Notees Full Migration Plan: Current App → Ideal Architecture

**Date:** 2026-07-18  
**Branch:** `main` (Phase 3 complete, Phase 4 in progress)  
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

**Status:** Done. Committed as `feat(core,relay,frontend): Phase 1 new core skeleton` (`8c193397`).

**Completed sub-tasks:**
- A1: `app/core/` operation types, HLC, UUIDv7, validation (28 tests).
- A2: `app/relay/` encrypted operation relay with SQLite storage, FastAPI router, permission stubs (17 tests).
- A3: `frontend/src/core/` SQLite runtime, CRDT adapters, workspace store, sync engine (6 tests).
- A4: `pyproject.toml` packages, `@/core` Vite alias, relay router tests.

**Verification:**
- `uv run pytest tests/core -m unit --no-cov` → 98 passed.
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

**Status:** Done. Snapshot committed to `main`.

**Completed sub-tasks:**
- B1: Node/hierarchy migration (`app/core/migration/nodes.py`).
  - Reuses fixed PostgreSQL system-class UUIDs (`task`, `day`, `asset`, etc.).
  - Creates soft-deleted-only nodes before deleting them so references stay valid.
  - Skips `node.move` for dangling parent references.
- B2: Property/class/schema migration (`app/core/migration/properties.py`).
  - Maps legacy scalar/relation/selection values to `propertySchema.create` and `property.set`.
  - Skips property values attached to deleted nodes.
- B3: Asset/link/reference migration (`app/core/migration/assets.py`, `links.py`).
  - Rewrites inline `node_link` AST entries with migrated target UUIDs.
  - Maps asset rows to `asset` class file nodes and copies blobs content-addressed.
- B4: Validation/replay (`app/core/migration/validation.py`, `replay.py`, `scripts/validate_migration.py`).
  - Replays operations into SQLite and reports counts, orphans, duplicates.
  - Recursively extracts reference edges from nested AST paragraphs.

**Key fixes applied during this phase:**
- `_is_valid_uuid` now accepts `uuid.UUID` objects returned by asyncpg, so existing PostgreSQL UUIDs are preserved instead of regenerated.
- System-class `class.assign` operations reference the same global UUIDs already stored in PostgreSQL, eliminating 2,474 orphans.
- `node_link` edges are parsed from the first segment of `link_id`, raising edge count from 3 to ~16k (matching `node_link` row count).

**Files created/modified:**
- `app/core/migration/` package (nodes, properties, assets, links, replay, validation, writer, connection).
- `scripts/validate_migration.py`.
- `tests/core/migration/` test suite.

**Verification:**
- `uv run pytest tests/core -m unit --no-cov` → 98 passed.
- `uv run ruff check app/core/migration tests/core/migration scripts/validate_migration.py` → clean.
- `uv run python scripts/validate_migration.py` against the live PostgreSQL database:
  ```
  Operations:        133,804
  Nodes:             35,655
  Hierarchy edges:   30,289
  Properties:        3,160
  Edges:             16,652
  Orphan operations: 0
  Duplicate ids:     0
  ```
  - Zero orphan operations and zero duplicate operation IDs.
  - Edges align with the 16,658 `node_link` rows in PostgreSQL (small variance from duplicate source/target pairs).
  - Hierarchy edges differ from PostgreSQL `parent_id IS NOT NULL` count (30,294) by 5 due to skipped dangling-parent moves.
  - Node count differs from PostgreSQL live-node row count (36,021) because PostgreSQL duplicates system-class rows per workspace while the derived store uses a single UUID per system class.

**Subagent breakdown:**
- Subagent B1: Node/hierarchy migration.
- Subagent B2: Property/class/schema migration.
- Subagent B3: Asset/link/reference migration.
- Subagent B4: Validation and reconciliation tests.

---

## Phase 3: QueryAST Retarget to SQLite

**Goal:** Make QueryAST compile to SQLite SQL against the new derived tables.

**Status:** Done. Snapshot committed to `main`.

**Completed sub-tasks (C1):**
- Created `app/core/query_ast/compiler.py` and `app/core/query_ast/__init__.py` with `QueryASTToSQLite`.
- Extended `app/core/migration/replay.py` with the `class_hierarchy` table and eager transitive-closure appliers for `class.create`/`class.update`.
- Added `tests/core/query_ast/test_compiler.py` and `tests/core/query_ast/test_executor_against_replay.py`.
- Added `app.core.query_ast` to `pyproject.toml` packages.

**Completed sub-tasks (C2):**
- Created `frontend/src/core/query/compileToSqlite.ts` and `frontend/src/core/query/__tests__/compileToSqlite.test.ts`.
- Added `class_hierarchy` table to `frontend/src/core/db/schema.ts` and populated it from `class.create`/`class.update` in `frontend/src/core/derived/node.ts`.

**Completed sub-tasks (C3):**
- Created `tests/core/query_ast/test_parity_with_postgres.py`: shared AST fixtures compiled with both `QueryASTToSQL` and `QueryASTToSQLite`, with SQLite SQL executed against the derived schema for syntax/structural parity.
- Created `tests/core/query_ast/test_parity_against_migration.py`: replays the Phase 2 migration path for the first active workspace into an in-memory SQLite store and validates realistic QueryAST results against direct SQLite queries. Skips gracefully when PostgreSQL is unavailable.
- Fixed bugs discovered during parity testing:
  - `ScopeNode` missing `page_uuids` field, breaking `specific_pages` scope handling.
  - SQLite `specific_pages` parameter handling (extra unused workspace id and invalid `pa2.workspace_id` reference).
  - PostgreSQL `ParentPathCondition`/`ChildPathCondition` referencing old `blocks` attribute and non-existent `min_depth`.

**Caveats:**
- `tag` conditions and `regex`/`fts` content operators are out of scope (as documented in `phase3-queryast-sqlite.md`).
- `StyleCondition` `is`/`is_not` operators are best-effort using SQLite JSON1.
- Dynamic `nested_group` modes for path conditions are supported for simple cases but not exhaustively tested.

**Files to create/modify:**
- Create `app/core/query_ast/`.
- Create `frontend/src/core/query/`.
- Create `tests/core/query_ast/`.
- Modify `app/core/migration/replay.py` for `class_hierarchy`.
- Modify `frontend/src/core/db/schema.ts` and derived appliers for `class_hierarchy`.

**Verification:**
- `uv run pytest tests/core/query_ast -m unit --no-cov` → 55 passed, 3 skipped.
- `uv run ruff check tests/core/query_ast app/core/query_ast app/domain/entities/query_ast.py app/domain/services/query_ast_sql.py` → clean.
- `uv run python scripts/validate_migration.py` → 0 orphan operations, 0 duplicate ids.
- `cd frontend && npm run test:run src/core/query && npx tsc -b --noEmit` → passed (verified during C2).

**Subagent breakdown:**
- Subagent C1: Backend SQLite QueryAST compiler + `class_hierarchy` replay extension. ✅ Done
- Subagent C2: Frontend SQLite QueryAST compiler + `class_hierarchy` schema/applier extension. ✅ Done
- Subagent C3: Parity tests comparing PostgreSQL and SQLite compilers on shared fixtures. ✅ Done

---

## Phase 4: Frontend Cut-Over

**Goal:** Replace the authoritative TanStack Query cache with the local SQLite store.

**Status:** Implementation in progress. Detailed plan in `agents/plans/phase4-frontend-cutover.md`.

**Approach:**
- Build React hooks and an adapter layer so existing feature components can read/write through the new core without a full rewrite.
- Gate the cut-over behind `VITE_ENABLE_SQLITE_STORE` so legacy TanStack Query code keeps running until the new layer is proven.
- Persist the SQLite database and pending operations in IndexedDB for offline support.
- Mount the encrypted relay router on the backend and provide a seed script for existing workspaces.

**Key design decisions:**
- SQLite is the primary runtime store; TanStack Query becomes a transitional loading-state helper only.
- `node.delete` maps to a hard delete in the operation log for Phase 4. Trash/archive behavior is deferred.
- One workspace = one SQLite database. The active workspace store is opened lazily by `useWorkspaceStore(workspaceId)`.

**Deliverables:**
1. **D1 — Core hooks + workspace store adapter + IndexedDB persistence:**
   - `frontend/src/core/hooks/useWorkspaceStore.ts`, `useNode.ts`, `useNodes.ts`, `useChildren.ts`, `useCreateNode.ts`, `useUpdateText.ts`, `useMoveNode.ts`, `useDeleteNode.ts`, `useSync.ts`.
   - `frontend/src/core/persistence/indexedDb.ts` and `operationQueue.ts`.
   - `frontend/src/core/adapters/workspaceStoreAdapter.ts` singleton registry.
   - Reactive subscriptions added to `WorkspaceStore`; auto-sync controls added to `SyncEngine`.
2. **D2 — Node read/write bridge:**
   - Adapter hooks that expose legacy node shapes (`useNodeAdapter`, `useNodesAdapter`, `useNodeChildrenAdapter`, `useInlineEditorAdapter`).
   - Legacy feature hooks delegate to adapters when the feature flag is on.
3. **D3 — Properties / views / QueryAST bridge:**
   - `useProperty.ts`, `useProperties.ts`, `usePropertySchemas.ts`, `useQueryAst.ts`.
   - Adapter hooks compatible with `features/properties/` and `features/queries/`.
4. **D4 — Offline + relay integration:**
   - Service-worker offline strategy aligned with local-first state.
   - `app/relay/router.py`, `permissions.py`, `storage.py` mounted in `app/main.py`.
   - `scripts/seed_relay_from_postgres.py` to migrate all workspaces into the relay.

**Files to create/modify:**
- Create `frontend/src/core/hooks/`.
- Create `frontend/src/core/persistence/`.
- Create `frontend/src/core/adapters/`.
- Create `frontend/src/core/serviceWorker/`.
- Create/modify `app/relay/router.py`, `app/relay/permissions.py`, `app/relay/storage.py`.
- Create `scripts/seed_relay_from_postgres.py`.
- Modify `frontend/src/core/index.ts`, `frontend/src/core/store.ts`, `frontend/src/core/sync.ts`, `frontend/src/core/db/connection.ts`.
- Modify `frontend/src/App.tsx` to initialize the workspace store adapter.
- Modify `frontend/src/main.tsx` to restore IndexedDB-backed SQLite databases.
- Modify legacy feature hooks under `frontend/src/features/content/hooks/`, `frontend/src/features/properties/hooks/`, `frontend/src/features/queries/hooks/`.

**Verification:**
- `uv run pytest tests/core tests/relay -m unit --no-cov` passes.
- `uv run ruff check app/core app/relay scripts/seed_relay_from_postgres.py frontend/src/core` clean.
- `uv run python scripts/validate_migration.py` reports zero orphans and zero duplicates.
- `cd frontend && npm run test:run src/core && npx tsc -b --noEmit && npm run lint` passes.
- Manual smoke test with `VITE_ENABLE_SQLITE_STORE=true`: open workspace, CRUD nodes, edit properties, run QueryAST view, go offline, reconnect, converge.

**Subagent breakdown:**
- Subagent D1: Core hooks + store adapter + IndexedDB persistence. ✅ Done (`8a74fe71`).
- Subagent D2: Content/editor feature bridge. ✅ Done (`06626a6d`).
- Subagent D3: Properties/views/QueryAST bridge. ✅ Done (`c2fe306f`).
- Subagent D4: Service worker/PWA offline + relay router mount + backend seed script.

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

Begin **Phase 4** (frontend cut-over) by dispatching subagent D1 to build the core React hooks, workspace store adapter, and IndexedDB persistence layer. See `agents/plans/phase4-frontend-cutover.md` for the full sub-task breakdown.
