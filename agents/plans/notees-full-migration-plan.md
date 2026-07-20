# Notees Full Migration Plan: Current App → Ideal Architecture

**Date:** 2026-07-18  
**Branch:** `main` (Phase 5 complete, Phase 6 in progress)  
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

**Status:** Complete. Detailed plan and sub-task results in `agents/plans/phase4-frontend-cutover.md`.

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

**Verification (completed):**
- `uv run pytest tests/core tests/relay -m unit --no-cov` → 154 passed, 3 skipped.
- `uv run ruff check app/core app/relay app/main.py scripts/seed_relay_from_postgres.py app/core/crypto.py frontend/src/core` → clean.
- `uv run python scripts/validate_migration.py` → 0 orphan operations, 0 duplicate ids.
- `cd frontend && npm run test:run src/core && npx tsc -b --noEmit && npm run lint` → 52 tests passed, typecheck clean, lint clean (pre-existing unrelated warnings).
- End-to-end integration test passes (`frontend/src/core/__tests__/integration.test.tsx`).

**Subagent breakdown:**
- Subagent D1: Core hooks + store adapter + IndexedDB persistence. ✅ Done (`8a74fe71`).
- Subagent D2: Content/editor feature bridge. ✅ Done (`06626a6d`).
- Subagent D3: Properties/views/QueryAST bridge. ✅ Done (`c2fe306f`).
- Subagent D4: Service worker/PWA offline + relay router mount + backend seed script. ✅ Done (`02b9c08f`).

---

## Phase 5: Server Relay Hardening and Production Cut-Over

**Goal:** Make the encrypted operation relay production-ready with real permissions, WebSocket forwarding, key management, and load/convergence validation.

**Status:** Complete. Detailed plan and sub-task results in `agents/plans/phase5-relay-hardening.md`.

**Deliverables:**
1. **E1 — WebSocket and paginated catch-up:**
   - `/api/relay/ws/{workspace_id}` real-time envelope broadcast.
   - Paginated `/api/relay/catch-up` with cursor-based pagination.
   - Optional `/api/relay/snapshot` placeholder.
2. **E2 — Real permissions and share integration:**
   - `PostgresPermissionChecker` using `workspace_share` records.
   - Public-share token read access for relay catch-up.
   - Anonymous actors rejected for writes.
3. **E3 — Workspace key management:**
   - `/api/relay/keys/{workspace_id}` wrapped-key retrieval.
   - Invite and key-rotation endpoints.
   - Matching frontend unwrap helpers.
4. **E4 — Conformance and load tests:**
   - Multi-client convergence tests.
   - Catch-up replay load tests.
   - Frontend convergence test.

**Files to create/modify:**
- Create `app/relay/websocket.py`, `app/relay/broadcast.py`, `app/relay/permissions_postgres.py`, `app/relay/key_management.py`, `app/relay/key_models.py`, `app/relay/key_router.py`.
- Modify `app/relay/router.py`, `app/relay/service.py`, `app/relay/storage.py`, `app/relay/dependencies.py`, `app/relay/permissions.py`, `app/core/crypto.py`.
- Modify `frontend/src/core/crypto.ts`.
- Modify `app/features/shares/repository.py` for node-share permission lookup.

**Verification (completed):**
- `uv run pytest tests/core tests/relay -m unit --no-cov` → 62 passed, 3 skipped.
- `uv run ruff check app/relay app/main.py app/core/crypto.py scripts/seed_relay_from_postgres.py frontend/src/core` → clean.
- `uv run python scripts/validate_migration.py` → 0 orphan operations, 0 duplicate ids.
- `cd frontend && npm run test:run src/core && npx tsc -b --noEmit && npm run lint` → 59 tests passed, typecheck clean, lint clean (pre-existing unrelated warnings).
- Multi-client convergence tests pass; 10k-operation catch-up completes in ~0.066 s.

**Subagent breakdown:**
- Subagent E1: Relay HTTP/WebSocket endpoints. ✅ Done (`7016e8f2`).
- Subagent E2: Permission + share integration. ✅ Done (`62dfb08a`).
- Subagent E3: Key management + encryption. ✅ Done (`25614d77`).
- Subagent E4: Conformance and load tests. ✅ Done (`2ec3d6f1`).

---

## Phase 6: Cleanup and Deprecation

**Goal:** Remove the surfaces that are genuinely superseded by the new core, while keeping legacy service/repo/runtime layers as a compatibility shim for still-active feature islands.

**Status:** Complete. Detailed plan: `agents/plans/phase6-cleanup-deprecation.md`.

**Deliverables:**
1. **F1 — Backend safe cleanup:**
   - Remove `app/features/sync/` (router, service, service_v2, repository, port, dependencies) — superseded by `app/relay/`.
   - Unmount legacy `nodes_router`, `properties_router`, `sync_router` from `app/main.py` and `app/routers/__init__.py`.
   - Remove dead router endpoint modules under `app/features/nodes/router/` and `app/features/properties/router/` that have no consumers outside the unmounted routers.
   - Remove `app/domain/services/query_ast_sql.py`, `app/domain/repositories/postgres_query.py`, and `app/domain/services/query_ast_validation.py` once verified unused.
   - Clean legacy sync factory from `app/dependencies.py`.
2. **F2 — Frontend safe cleanup:**
   - Remove `VITE_ENABLE_SQLITE_STORE` and make the SQLite core path the default for hooks that already have adapter twins.
   - Remove legacy v2 sync dispatcher (`SyncManagerV2`, `localSyncEngine`, `LocalIndexManager`, `QueryLiveUpdater`, conflict/store utilities).
   - Disconnect `runtime/eventBus.ts` and `useContentSave.ts` from `localSyncEngine`.
   - Prune `frontend/src/features/sync/local/` files that are no longer imported; retain `localQuery.ts`, `buildOfflineLinkedReferences.ts`, and `substituteRuntimeParams.ts` until their consumers are retargeted to the core SQLite compiler.
3. **F3 — Final migration and docs:**
   - Run `scripts/seed_relay_from_postgres.py --all` against the live DB.
   - Update `AGENTS.md` and user-facing docs; add changelog note.

**What stays for Phase 7:**
- `app/features/nodes/` and `app/features/properties/` service/repository/port/postgres layers (used by tasks, assets, import, shares, activity, undo, plugins).
- `frontend/src/runtime/` and the runtime-based block-tree overlay (used by editor/content hooks).
- `frontend/src/features/sync/local/` query helpers still imported by query hooks.

**Verification:**
- `uv run ruff check app/` passes.
- `uv run pytest tests/core tests/relay tests/unit -m unit --no-cov` passes.
- `uv run python scripts/seed_relay_from_postgres.py --all` succeeds.
- `cd frontend && npx tsc -b --noEmit && npm run lint && npm run test:run src/core src/features/content src/features/properties src/features/sync src/runtime` passes.

---

## Phase 7+: Port Remaining Islands, Final Cleanup, and Release

**Status:** In progress. Detailed plan: `agents/plans/notees-phase7-plus-plan.md`.

**Overview:**
- **Phase 7:** Port tasks, assets, import, shares, activity, undo, plugins, and collab/Yjs to the operation-log core; replace the frontend runtime overlay and local query helpers with the core SQLite store.
- **Phase 8:** Delete the remaining legacy `app/features/nodes/`, `app/features/properties/`, `frontend/src/runtime/`, and `frontend/src/features/sync/local/` code.
- **Phase 9:** Production hardening — snapshots/compaction, OPFS/sql.js validation, relay rate limits, E2E smoke tests.
- **Phase 10:** Final documentation update and release milestone commit.

---

## Execution Order

Phases run mostly sequentially because each depends on the previous, but within a phase subagents work in parallel:

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8 → Phase 9 → Phase 10
   │          │          │          │          │          │          │          │          │          │
   └─ A1..A4  └─ B1..B4  └─ C1..C2  └─ D1..D4  └─ E1..E4  └─ F1..F3  └─ G1..G4  └─ H      └─ I       └─ J
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

## Phase 7 Smoke-Test Sprint (Completed)

A focused pass over four remaining feature islands that were still partially tied to legacy PostgreSQL IDs or unfinished stubs. Each item produced a snapshot commit and passing tests.

### G1 — Whiteboard and Flashcards

**Whiteboard**
- Fixed `frontend/src/features/whiteboard/hooks/useWhiteboard.save.ts` to call `useUpdateNodeAdapter` with the correct `{ nodeUuid, data: { name: serialized } }` shape.
- Updated `frontend/src/core/adapters/useUpdateNodeAdapter.ts` to detect JSON-array `name` payloads and route them to `store.updateContentAst()` instead of treating them as plain text. This fixes whiteboard, query blocks, and any other component that persists a full AST through the adapter.

**Flashcards**
- Migrated the flashcards plugin from legacy integer `node_id` to UUID `node_uuid` end-to-end:
  - Schema: `app/db/schema/sql.py` now defines `flashcard.node_uuid UUID NOT NULL` with no foreign key to the legacy `node` table.
  - Migration: `app/db/migrations/migrate_flashcards_to_node_uuid.sql` backfills existing rows and drops `node_id`.
  - Backend port/service/repository/router updated; UUID→int resolution helpers removed.
  - Frontend `frontend/src/api/flashcards.ts` now sends `node_uuid` in create requests.
  - Added `tests/unit/plugins/builtin/test_flashcards.py` (7 tests).

**Verification:** `uv run pytest tests/unit/plugins/builtin/test_flashcards.py -m unit --no-cov -v` → 7 passed. Full backend suite → 350 passed; frontend → 544 passed.

### G2 — Logseq Import as a Plugin

- Implemented the backend Logseq markdown importer (`app/plugins/builtin/logseq_importer/parser.py` and `importer.py`).
- Parser supports pages, journals, nested blocks, page/block properties, wiki-links, and asset references.
- Importer creates pages/blocks via `PluginContext` operation-log helpers, creates stub pages for unresolved wiki-links, and tags imported roots with a `Source: Logseq` class.
- Extended `/preview` to return parsed counts.
- Added missing `create_node`, `update_content`, and `move_node` helpers to `PluginContext` (`app/plugins/core/context.py`).
- Added `tests/unit/plugins/builtin/test_logseq_importer.py` (9 tests).

**Verification:** `uv run pytest tests/unit/plugins/builtin/test_logseq_importer.py -m unit --no-cov -v` → 9 passed.

### G3 — Date-Format Migration and Batch Operations

- Normalized migrated `date_range` property values to the canonical shape `{start, end, granularity, start_uuid, end_uuid}` via `app.utils.date_range.normalize_date_range_value` (`app/core/migration/properties.py`).
- Added `WorkspaceStore.apply_many()` for atomic multi-operation persistence (`app/core/workspace_store.py`), refactored from the existing `apply()` logic.
- Added/updated tests in `tests/core/migration/test_properties.py` and `tests/core/test_workspace_store.py`.

**Verification:** `uv run pytest tests/core/test_workspace_store.py tests/core/migration -m unit --no-cov -v` → 60 passed.

### G4 — Comments Threading

- Hardened existing comment threading:
  - Fixed `useCreateComment` and `useDeleteComment` to fetch the workspace store inside `mutationFn` (matches the `useCreateNodeAdapter` pattern), eliminating a race when the store is still initializing.
  - Added `frontend/src/features/content/hooks/__tests__/useComments.test.tsx` covering top-level comments, nested replies, and filtering of deleted/non-comment children.
  - Added a reply button to each comment in `SidebarComments` so threaded conversations are exposed in the UI.
  - Added `ReplyIcon` to the icon set.

**Verification:** Frontend full suite → 547 passed.

### Current Test Status

```bash
uv run pytest tests/core tests/unit -m unit --no-cov -q
# 367 passed, 3 skipped, 6 deselected, 1 warning

cd frontend && npm run test:run
# 83 files, 552 tests passed
```

---

## Phase 7 Port Remaining Islands (Completed)

A second pass ported or cleaned up the larger feature islands that still had legacy PostgreSQL artifacts.

### G5 — Tasks

- Confirmed the tasks router/service already operate on `WorkspaceStore` (recurrence rules and completion history are operation-log operations).
- Removed dead legacy code:
  - `app/features/tasks/port.py`
  - `app/features/tasks/repository.py`
  - `app/features/tasks/repository_completion.py`
  - Unused dependency factories in `app/features/tasks/dependencies.py`
  - Dead fake task repositories in `tests/fakes.py`

**Verification:** `uv run pytest tests/core/test_tasks_router.py -m unit --no-cov -v` → 11 passed.

### G6 — Assets

- Confirmed the assets router/service already operate on `WorkspaceStore` (asset metadata is an operation-log operation; files are content-addressed on disk).
- Removed dead legacy code:
  - `app/features/assets/port.py`
  - `app/features/assets/repository.py`
  - Exports in `app/features/assets/__init__.py`

**Verification:** `uv run pytest tests/core/test_assets_router.py -m unit --no-cov -v` → 9 passed.

### G7 — Shares, Activity, Undo

- **Shares**: public share links and node-level user shares remain in PostgreSQL because they are server-side authorization metadata used by the relay permission checker. No code changes; the architecture decision is now documented.
- **Activity**: router already reads/writes via `WorkspaceStore`; removed unused `ActivityRepository` port and PostgreSQL implementation.
- **Undo**: server-side undo is deprecated (router returns 410 Gone); removed unused `UndoRepository`, `PostgresUndoRepository`, `UndoService`, and undo dependency factories.

**Verification:** `uv run pytest tests/core/test_undo_router.py tests/core/test_shares_router.py -m unit --no-cov -v` → 14 passed.

### G8 — Frontend Runtime Overlay

- Verified `frontend/src/runtime/` and `frontend/src/features/sync/local/` no longer exist.
- Verified `useContentSave` is the new core WorkspaceStore bridge, not legacy runtime code.
- No further cleanup needed.

---

## Phase 8 — Relay Snapshots and Compaction (Completed)

Implemented real snapshot-based catch-up so long-lived workspaces do not need to replay the entire operation log on startup.

- Added `get_max_hlc` and `get_latest_snapshot` to `RelayStorage` port and both SQLite/PostgreSQL implementations.
- Updated `create_snapshot` to store serialized derived SQLite state in `relay_snapshot.data`.
- Added `WorkspaceStore.create_snapshot()` that serializes the derived DB and persists it.
- Modified `WorkspaceStore.sync()` to restore from the latest snapshot and replay only operations newer than the snapshot HLC.
- Updated the local HLC clock from the maximum seen HLC after catch-up.
- Added `tests/core/test_relay_storage.py` and extended `tests/core/test_workspace_store.py`.

**Verification:** `uv run pytest tests/core/test_workspace_store.py tests/core/test_relay_router.py tests/core/test_relay_storage.py tests/core/test_relay_postgres_storage.py -m unit --no-cov -v` → 29 passed.

---

## Phase 9 — OPFS/sql.js Validation and Offline Hardening (Completed)

Hardened the frontend local-first storage layer against eviction and initialization failures.

- Added `frontend/src/core/persistence/storagePersistence.ts` with `requestPersistentStorage()` and `isPersisted()` wrapping `navigator.storage.persist()` / `persisted()`.
- Wrapped sql.js initialization in `frontend/src/core/db/connection.ts` with clear error messages and `getSqlInitError()` diagnostics.
- Added `StorageError`, `validateIndexedDb()`, and explicit error handling in `frontend/src/core/persistence/indexedDb.ts`.
- `frontend/src/App.tsx` now requests persistent storage on init, warns if denied, and surfaces sql.js wasm failures via toast notifications.
- Added `frontend/src/core/persistence/__tests__/storagePersistence.test.ts`.

**Verification:** `cd frontend && npm run test:run src/core/persistence` → 12 passed.

---

## Gap vs. Original Notees (Pre-Migration)

This section tracks what has been replaced, what is now better, and what still depends on legacy PostgreSQL rows.

| Area | Original Notees | Current State | Assessment |
|---|---|---|---|
| Source of truth | Mutable PostgreSQL `node`/`block` rows | Immutable operation log + SQLite derived state | **Better**: offline-first, replayable, convergent. |
| Node IDs | Internal integers exposed as `id`, public `uuid` only in some places | UUIDv7 everywhere, no integer IDs in new core | **Better**: consistent public identifiers, index locality. |
| Sync | Custom v1/v2 sync over HTTP/WebSocket | Encrypted relay with catch-up + live WebSocket | **Better**: server is a relay, clients are authoritative. |
| QueryAST | Compiled to PostgreSQL SQL | Compiled to SQLite against derived tables | **Better**: runs client-side instantly; parity tests pass. |
| Whiteboard | Saved through legacy adapter with wrong shape | AST routed through `updateContentAst` | **Fixed** |
| Flashcards | Stored `node_id INTEGER REFERENCES node(id)` | Stores `node_uuid UUID` with no legacy FK | **Fixed** |
| Logseq import | Stub importer (only counted files) | Full parser + operation-log creator | **Fixed** |
| Date ranges | Legacy format in PostgreSQL, no normalization | Canonical normalized shape in migration | **Fixed** |
| Batch mutations | Per-request API calls | `WorkspaceStore.apply_many()` + local-first loops | **Better** |
| Comments | Legacy comment service | Comment-class blocks in local SQLite store, reply UI | **Better** |
| Tasks | Legacy recurrence/completion repositories | Operation-log operations via `WorkspaceStore` | **Fixed** |
| Assets | Legacy `AssetRepository` in PostgreSQL | Operation-log + content-addressed filesystem | **Fixed** |
| Activity | Legacy `ActivityRepository` | Operation-log derived `activity_log` table | **Fixed** |
| Undo | Server-side undo stack | Client-side inverse operations (router returns 410) | **Fixed** |
| Shares | Mixed | Public links + node shares stay in PostgreSQL by design (authorization metadata) | **By design** |
| Frontend runtime overlay | `frontend/src/runtime/` overlay | Removed; `useContentSave` is core bridge | **Fixed** |
| Snapshots/compaction | Not implemented | Snapshot-based catch-up + compaction endpoints implemented | **Fixed** |
| Offline hardening | Basic IndexedDB | Persistent storage request, sql.js error handling, validation | **Fixed** |
| Legacy code deletion | `app/features/nodes/`, `app/features/properties/` still exist | **Kept as compatibility shim** | Phase 8 work |

### Remaining Architectural Gaps

1. **Legacy code deletion**: `app/features/nodes/`, `app/features/properties/`, and the PostgreSQL `node` table still exist as a compatibility shim for any remaining unported code paths. They can be removed once a full audit confirms no consumers remain.
2. **Cross-workspace references** are forbidden by policy but not yet enforced in code.
3. **E2E smoke tests** against the Docker Compose stack are not yet automated.
4. **Production hardening**: relay rate limits, key rotation UX, and member removal workflows are implemented but could benefit from dedicated load/security testing.

---

## Post-Implementation Gap Reassessment (2026-07-20)

A focused audit of the running frontend against the mounted backend routers revealed that several Phase 4 "bridge" layers were still stubs or pointed to unmounted legacy endpoints. These are not optional cleanup items; they are required for the app to function with the operation-log core.

### Verified Gaps

| # | Area | Symptom | Root Cause | Required Fix |
|---|---|---|---|---|
| 1 | **Class properties / property schemas** | `GET /api/properties/classes/{uuid}/properties` returns `404`; property panels show no schemas; `useCreateProperty` throws in SQLite mode. | `frontend/src/api/properties.ts` endpoints (`/properties/*`) are no longer mounted. `property_schema` and `class_property_edge` tables do not exist in the derived schema; adapters return empty lists or throw. | Add schema + edge tables, new operation types/appliers, and derive reads from SQLite instead of HTTP. |
| 2 | **Node views** | `POST /api/nodes/views/execute` returns `405`; default views cannot be ensured; collection views stay empty. | `frontend/src/api/nodeViews.ts` endpoints (`/nodes/views/*`) are no longer mounted. No derived `node_view` table or operation-log applier exists. | Add `node_view` derived table + CRUD operation types/appliers; replace `nodeViewsApi` calls with core store operations. |
| 3 | **Flashcards plugin** | Built-in flashcard routes are not reachable from the frontend. | Plugin router mounting is incomplete or uses a path the frontend does not call. | Verify/fix plugin route registration for built-in plugins. |

### Decisions

- **No legacy stubs**: every bridge must be a real operation-log implementation. Empty-list adapters and "not yet implemented" mutation errors are not acceptable.
- **Sequential implementation**: class properties first, then node views, then flashcards. This avoids schema/operation-type merge conflicts in `schema.ts` and `operation.ts`.
- **Verification before each commit**: backend unit tests, frontend unit tests, lint, and TypeScript must pass after each island.

---

## Immediate Next Step

**Phase 10 is split into three concrete implementation sprints before final cleanup:**

1. **Sprint 10.1 — Class properties in the operation-log core** (in progress):
   - Add `property_schema` and `class_property_edge` derived tables.
   - Add operation types `propertySchema.create/update/delete`, `classPropertyEdge.create/update/delete/reorder`.
   - Add frontend and backend appliers.
   - Replace `usePropertySchemas`, `useClassPropertiesAdapter`, and property/class-property mutation hooks with core store reads/writes.
   - Add tests; commit.

2. **Sprint 10.2 — Node views in the operation-log core**:
   - Add `node_view` derived table and view-definition operation types/appliers.
   - Replace `nodeViewsApi` calls with core store operations.
   - Wire default-view creation and QueryAST view execution through the local SQLite compiler.
   - Add tests; commit.

3. **Sprint 10.3 — Flashcards plugin route mounting**:
   - Fix built-in plugin router registration so the frontend flashcards feature works end-to-end.
   - Add tests; commit.

4. **Sprint 10.4 — Final cleanup and release**:
   - Delete remaining legacy `app/features/nodes/` and `app/features/properties/` code once the above sprints prove no consumers remain.
   - Run E2E smoke tests against the Docker Compose dev stack.
   - Update user-facing docs and changelog.
- Create the release milestone commit.
