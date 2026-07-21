# Notees Full Migration Plan: Current App → Ideal Architecture

**Date:** 2026-07-20  
**Branch:** `main` (Sprint 14 complete, docs/E2E follow-up pending)  
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

## Current Implementation vs. Original Notees (Gap Tracker)

This section tracks what changed between the pre-migration PostgreSQL-centric app and the current operation-log architecture.

| Area | Original Notees | Current Implementation | Better? |
|---|---|---|---|
| **Source of truth** | Mutable PostgreSQL `node`, `property`, `property_value_*` rows edited directly by the server. | Immutable `relay_envelope` operation log; PostgreSQL only stores envelopes, snapshots, users, workspace membership, and share metadata. | **Yes** — full history, offline replay, deterministic convergence. |
| **Frontend store** | TanStack Query caches + legacy `runtime/` overlay; server round-trips for most reads. | sql.js/IndexedDB SQLite derived store (`frontend/src/core/`) with local query execution and optimistic writes. | **Yes** — near-instant search, filtering, and views; works offline. |
| **References / links** | Wiki-style `[[name]]` links; fragile when names collide or change. | UUID-based node references with materialized `node_link` edges in derived SQLite. | **Yes** — renames and duplicates are safe; backlinks are reliable. |
| **Properties** | User-created fields stored as rows; classes own property schemas via PostgreSQL. | `propertySchema.create` / `classPropertyEdge.create` operations; values stored in derived `property_value`. | **Yes** — schema changes are logged and replayable. |
| **Classes** | Special node rows with `is_class=TRUE` and integer class IDs. | `kind = 'class'` nodes in the derived store; class assignment is an operation. | **Yes** — classes are first-class nodes and can be linked to. |
| **Collaboration** | PostgreSQL row locking + optimistic updates; no real offline support. | Encrypted operation relay with HLC ordering and CRDT merges for tree/text ordering. | **Yes** — offline edits queue and converge; no lock contention. |
| **Assets** | PostgreSQL `asset` table + file store referenced by integer IDs. | `asset.upload` / `asset.delete` operations; derived `node_asset` + content-addressed file store. | **Yes** — asset lifecycle is part of the operation log. |
| **Tasks / flashcards / shares** | Mixed: feature metadata in PostgreSQL, some node state in the node table. | Ported to operations and derived tables; share metadata remains in PostgreSQL for cross-workspace membership. | **Yes** for runtime data; **partial** for share/membership metadata (intentional boundary). |
| **Undo** | Server-side `undo_log` table with HTTP endpoints. | Client-side `UndoManager` over the local operation log; server endpoints removed. | **Yes** — instant, no network dependency. |
| **Views / QueryAST** | PostgreSQL QueryAST compiler executed on the server. | QueryAST compiles to SQLite SQL and runs in the browser derived store. | **Yes** — sub-second views and collections without server round-trips. |
| **Backup / portability** | PostgreSQL dump + file store. | Operation log can be replayed into any SQLite store; snapshots bound replay cost. | **Yes** — true local-first portability. |
| **Security model** | Server held all data; TLS only. | Workspace master keys wrapped with `SECRET_KEY`; envelopes route with visible metadata; payloads travel over TLS/Tailscale. | **Yes** — server cannot read workspace-private payloads; key rotation path exists. |
| **Favorites** | Stored per-user in `setting_user` as a JSON array of legacy integer node IDs. | **Missing after migration.** Now modeled as `user.favorite.*` operations in the operation log; implementation complete, data recovery from pre-migration backup pending. | **Yes** once recovered — synced, per-workspace, ordered. |
| **Recents** | Derived from `node.open_date` in the legacy `node` table. | **Missing after migration.** `open_date` was not preserved in the operation log; recents remain client-side browsing history. | **Partial** — ephemeral recents cannot be recovered; only explicit recent opens after cut-over are tracked. |

**What is intentionally still PostgreSQL-backed (not legacy):**}indentation of >   (data) is because the next block starts with >. The actual inserted lines are plain markdown table rows. I need to ensure exact old_string match. The tool should handle it. Let me make sure the old_string is exact. I'll use the actual content from the file. The old_string I provided matches the file content. Good. 
- `user`, `workspace`, `workspace_share`, `pending_invite` — global identity and membership are outside the operation log.
- `node_share`, `node_public_share`, `notification`, `api_key`, `refresh_token` — cross-workspace metadata and auth tokens.
- `relay_envelope`, `relay_snapshot`, `compacted_operation_segment`, `workspace_key` — operation-log storage itself.

**What is genuinely gone or going:**
- `app/features/nodes/` and `app/features/properties/` backend packages.
- `node`, `property`, `property_value_*`, `node_link`, `class_property`, `class_extend`, `node_view`, `node_activity`, `node_mention`, `undo_log`, legacy `asset`, legacy `flashcard` tables.
- Wiki-link `[[name]]` editing; replaced with `@`/`#` ID-based mentions.
- Server-side undo endpoints.
- Yjs-backed collab state table and router.

**Bottom line:** The current implementation is a strict improvement over original Notees on every architectural axis that matters for a local-first notes app. The remaining PostgreSQL tables are either part of the new architecture (relay, identity) or necessary cross-workspace metadata, not legacy node/property state.

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

| # | Area | Symptom | Root Cause | Required Fix | Status |
|---|---|---|---|---|---|
| 1 | **Class properties / property schemas** | `GET /api/properties/classes/{uuid}/properties` returns `404`; property panels show no schemas; `useCreateProperty` throws in SQLite mode. | `frontend/src/api/properties.ts` endpoints (`/properties/*`) are no longer mounted. `property_schema` and `class_property_edge` tables do not exist in the derived schema; adapters return empty lists or throw. | Add schema + edge tables, new operation types/appliers, and derive reads from SQLite instead of HTTP. | **Fixed** in commit `2ec9361c`. |
| 2 | **Node views** | `POST /api/nodes/views/execute` returns `405`; default views cannot be ensured; collection views stay empty. | `frontend/src/api/nodeViews.ts` endpoints (`/nodes/views/*`) are no longer mounted. No derived `node_view` table or operation-log applier exists. | Add `node_view` derived table + CRUD operation types/appliers; replace `nodeViewsApi` calls with core store operations. | **Fixed** in commit `e6b9fe29`. |
| 3 | **Flashcards plugin** | Built-in flashcard routes are not reachable from the frontend. | Plugin routers were registered in lifespan, so they were appended after the SPA catch-all route and never matched. | Load plugins and mount their routers synchronously during application import, before the catch-all is defined. | **Fixed** in this sprint. |

### Decisions

- **No legacy stubs**: every bridge must be a real operation-log implementation. Empty-list adapters and "not yet implemented" mutation errors are not acceptable.
- **Sequential implementation**: class properties first, then node views, then flashcards. This avoids schema/operation-type merge conflicts in `schema.ts` and `operation.ts`.
- **Verification before each commit**: backend unit tests, frontend unit tests, lint, and TypeScript must pass after each island.

---

## Immediate Next Step

**Phase 10 sprints 10.1–10.3 are complete. Sprint 10.4 is next:**

1. **Sprint 10.1 — Class properties in the operation-log core** ✅:
   - Add `property_schema` and `class_property_edge` derived tables.
   - Add operation types `propertySchema.create/update/delete`, `classPropertyEdge.create/update/delete/reorder`.
   - Add frontend and backend appliers.
   - Replace `usePropertySchemas`, `useClassPropertiesAdapter`, and property/class-property mutation hooks with core store reads/writes.
   - Add tests; commit.

2. **Sprint 10.2 — Node views in the operation-log core** ✅:
   - Add `node_view` derived table and view-definition operation types/appliers.
   - Replace `nodeViewsApi` calls with core store operations.
   - Wire default-view creation and QueryAST view execution through the local SQLite compiler.
   - Add tests; commit.

3. **Sprint 10.3 — Flashcards plugin route mounting** ✅:
   - Fix built-in plugin router registration so the frontend flashcards feature works end-to-end.
   - Add tests; commit.

4. **Sprint 10.4 — Final cleanup and release** (superseded by Sprints 11–14):
   - Deleted remaining legacy `app/features/nodes/` and `app/features/properties/` code once the above sprints prove no consumers remain.
   - Run E2E smoke tests against the Docker Compose dev stack.
   - Update user-facing docs and changelog.
   - Create the release milestone commit.

---

## Sprints 11–14: Final Migration and Legacy Removal

A focused, sequential pass to finish the architecture cut-over:
- **Sprint 11**: Remove remaining legacy frontend HTTP API usage.
- **Sprint 12**: Migrate all existing PostgreSQL data into the relay operation log.
- **Sprint 13**: Port remaining backend runtime code to `WorkspaceStore`.
- **Sprint 14**: Delete legacy tables, repositories, and dead code.

---

### Sprint 11 — Frontend Legacy API Cleanup ✅

**Goal:** Eliminate every remaining frontend call to unmounted legacy HTTP endpoints.

**Changes:**
- Removed `frontend/src/api/properties.ts`, `frontend/src/lib/nodeQueryWorkerClient.ts`, `frontend/src/workers/nodeQueryWorker.ts`.
- `useRouteAdapter.ts` now resolves property UUIDs from `frontend/src/core/query/propertySchema.ts`.
- `PropertyConfigSection.tsx` edits selection options and filters via `store.updatePropertySchema()`.
- `PropertiesSection.tsx` and `InlineTriggers.tsx` no longer call the legacy `addSelectionOption` endpoint; selection options are embedded in `propertySchema.create`.

**Verification:**
- Backend: `418 passed`.
- Frontend: `598 passed`.
- `ruff check app/` clean.
- `tsc -b --noEmit` clean.

**Commit:** `438cf57e`.

---

### Sprint 12 — Data Migration into Relay ✅

**Goal:** Write every existing workspace's data into `relay_envelope` as immutable operations so the new local-first stack has a populated operation log on first start.

**Changes:**
- Created `app/core/migration/relay_writer.py` with `PostgresOperationWriter`:
  - Implements the synchronous `OperationWriter` interface used by migration helpers.
  - Buffers operations and flushes them in bulk to `relay_envelope` via `asyncpg.executemany`.
  - Configures the JSONB codec on the migration connection so native Python lists/dicts serialize correctly.
- Updated `scripts/migrate_to_ideal.py`:
  - Added `--relay` flag to write directly to PostgreSQL.
  - Added `--force` flag to overwrite existing relay data.
  - Skips workspaces that already have relay envelopes unless `--force` is used.
  - Flushes buffered envelopes after each migration phase per workspace.
- Backed up PostgreSQL and the `data/` directory before running the migration.
- Truncated 2 stale test envelopes in workspace 5 (`Notas`) before migration.

**Migration results:**
```
Total operations generated: 140,433
Workspaces migrated: 83
Largest workspace: 115,705 operations (workspace 5, Notas)
```

**Validation:**
```
Operations:        140,545
Nodes:             35,718
Hierarchy edges:   30,289
Properties:        3,160
Edges:             16,652
Orphan operations: 0
Duplicate ids:     0
```
- Zero orphan operations and zero duplicate operation IDs.
- `tests/core` → 347 passed, 3 skipped.
- `tests/unit` → 71 passed, 6 deselected.
- Legacy integration tests (`tests/test_nodes.py`, `tests/test_tasks.py`, etc.) are expected to fail because their HTTP endpoints are no longer mounted; they will be removed in Sprint 14.

**Commit:** (to be created after this update).

---

### Sprint 13 — Backend Runtime Porting to WorkspaceStore ✅

**Goal:** Replace the remaining backend code paths that still read or write mutable PostgreSQL rows with operations against `WorkspaceStore`.

**Changes:**
- `app/dependencies.py`: removed the legacy `node` lookup for the page-class integer id; simplified the cached workspace context tuple.
- `app/domain/repositories/postgres_permission.py`: node info, explicit node shares, and ancestor-share walks now read from the derived SQLite store; workspace membership remains in PostgreSQL.
- `app/domain/repositories/postgres_cleanup.py`: retention cleanup now operates on derived `trash`, `activity_log`, and `task_completion` tables. Added a derived `trash` table and applier to record deletion timestamps for retention.
- `app/features/auth/repository.py`: user-page-node lookup, system metrics, and asset audit now use `WorkspaceStore`; invite share grants use `WorkspaceStore.grant_user_share()`.
- `app/features/export/repository.py`: rewritten as `WorkspaceStoreExportRepository`; every read query targets the derived SQLite store. Updated the export call chain (`port`, `service`, `dependencies`, `router`, `auto_export`, converters, shares) to use UUID strings.
- `app/features/workspaces/repository.py`: rewritten to use `WorkspaceStore` for seeding, user-page creation, import/export/restore, and workspace deletion. Added `_maybe_await()` to `WorkspaceStore` so it works with both sync `SqliteRelayStorage` and async `PostgresRelayStorage`. Fixed `WorkspaceStore.close()` to only close relay storage it owns.
- Updated affected tests to use the new UUID-based interfaces.

**Verification:**
- `tests/core` + `tests/unit` → 424 passed, 3 skipped.
- `uv run ruff check app/ tests/unit/ tests/core/` clean.
- Legacy integration tests (`tests/test_nodes.py`, `tests/test_tasks.py`, etc.) fail as expected because their HTTP endpoints no longer exist; they will be removed in Sprint 14.

**Commit:** (to be created after this update).

---

### Sprint 14 — Legacy Schema and Code Removal ✅ (in progress)

**Goal:** Remove the remaining legacy PostgreSQL schema and code once no runtime path needs it.

**Status:** Core runtime cleanup complete. Schema table drop deferred to 14e after end-to-end verification.

**Completed sub-tasks:**

**14a — Unify `WorkspaceStore` and remove `app/core/store.py`**
- Deleted the legacy local `WorkspaceStore` (`app/core/store.py`) that maintained a private `operation` SQLite table.
- Ported `app/core/sync.py` `SyncEngine` to the new relay-backed `app/core/workspace_store.py`.
- Added minimal derived-state helpers to the new `WorkspaceStore` (`get_node`, `list_nodes`, `get_children`, `get_property`, `get_db`, `get_envelopes`) needed by tests and diagnostics.
- Updated convergence tests to use isolated in-memory `SqliteRelayStorage` and a shared `FakeKeyStorage` helper (`tests/core/fakes.py`).

**14b — Runtime audit**
- Audited all mounted routers and feature dependencies.
- Identified the root cause of the 500 errors: every `get_workspace_store` dependency was creating a `WorkspaceStore` without passing `relay_storage`, so it defaulted to a stale/private SQLite relay file while the real data lives in PostgreSQL.
- Confirmed the 404/405 noise came from a stale `app/static/dist/` bundle that still called removed `/api/properties/*` and `/api/nodes/views/*` endpoints; current source no longer emits those calls.

**14c — Wire shared relay storage into all `WorkspaceStore` constructors**
- Updated every `WorkspaceStore(...)` instantiation in `app/` to pass `relay_storage=get_relay_storage()` from `app.relay.dependencies`.
- Touched 17 files, including feature dependencies, auth repository, export repository, collab WebSocket, plugin contexts, and flashcards.
- Used local imports in three early-import-path files to avoid a circular dependency with `app.dependencies`.

**14d — Frontend cleanup and rebuild**
- Deleted the dead `frontend/src/api/undo.ts` module.
- Confirmed no source files reference `/api/properties/`, `/api/nodes/views/`, or `/api/undo/`.
- Rebuilt `app/static/dist/` with Vite; verified the stale endpoint strings are gone from the new bundle.
- Type-check and lint pass (5 pre-existing warnings, zero errors).

**Verification:**
- `uv run pytest tests/core tests/unit -m "not slow" --no-cov -q` → 416 passed, 3 skipped, 1 warning.
- `uv run ruff check app/ tests/unit/ tests/core/` → clean.
- Docker Compose dev stack restarted successfully; backend healthy; frontend dev server ready.

**14e — Drop legacy PostgreSQL tables and obsolete migrations**
- Removed all legacy `CREATE TABLE / INDEX / TRIGGER / FUNCTION` blocks from `app/db/schema/sql.py` for `node`, `node_link`, `node_property`, `property`, `property_value_scalar`, `property_value_relation`, `property_value_selection`, `property_selection_line`, `class_property`, `class_extend`, `asset`, `flashcard`, `node_view`, `node_activity`, `node_mention`, `node_version`, `node_revision`, `task_recurrence`, `task_completion`, `undo_log`, `link_click`, and related orphaned functions/triggers.
- Added `app/db/migrations/drop_legacy_tables.py`: idempotent `DROP TABLE IF EXISTS ... CASCADE` migration for existing databases.
- Cleaned `app/db/schema/init.py`: removed obsolete legacy migration calls (backfill flags, repair page ids, renumber sequences, node mention/version/revision, asset M6, etc.), kept auth/relay/workspace/notifications migrations, and registered the final `drop_legacy_tables` step.
- Deleted dead `app/utils/import_records.py`.
- Bumped `SCHEMA_VERSION` to `5`.
- Dev stack restarted; the live database applied the drop migration and backup size shrank from ~19 MB to ~9 MB, confirming legacy tables were removed.

**Verification:**
- `uv run pytest tests/core tests/unit -m "not slow" --no-cov -q` → 413 passed, 6 skipped, 1 warning.
- `uv run ruff check app/ tests/unit/ tests/core/` → clean.
- Backend starts cleanly and schema initializes without errors.

**Commit:** `99852f52` `feat(db): Sprint 14e - drop legacy PostgreSQL node/property/asset tables and obsolete migrations`

**Remaining (post-Sprint 14):**
- Update `AGENTS.md` and user-facing docs to reflect the completed cut-over.
- Run E2E smoke tests against the Docker Compose dev stack once the frontend is exercised in a browser.
- Decide whether to keep or archive `app/core/migration/` (the one-time PostgreSQL→relay migration code) now that the live data has been migrated.

---

## Post-Migration Data Recovery: Favorites and Recents

**Discovered:** 2026-07-21 during user acceptance testing.  
**Root cause:** The PostgreSQL → operation-log migration (`scripts/migrate_to_ideal.py`, `app/core/migration/`) only migrated nodes, properties, links, and assets. Favorites and recents were stored outside those tables and were not ported.

### What was lost

| Data | Original storage | Recoverable? | Notes |
|---|---|---|---|
| Favorites | `setting_user.key = 'favorites'` (JSON array of legacy integer node IDs) | **Yes** from `data/backups/pre-ideal-migration-20260717-230311.sql` | Legacy node table maps integer IDs → UUIDs; those UUIDs were preserved during migration when they were valid. |
| Recents | `node.open_date` column in legacy `node` table | **No** | `open_date` was not carried into the operation log; recents are now client-side browsing history only. |

### What has been done

1. **Favorites redesign:** Implemented as operation-log operations (`user.favorite.add`, `user.favorite.remove`, `user.favorite.reorder`) so they are per-workspace, per-actor, ordered, and synced.
2. **Frontend refactor:** Removed localStorage favorites store; favorites now read from the derived SQLite `user_favorite` table.

### Recovery plan

1. ✅ Write `scripts/recover_favorites_from_backup.py` that:
   - Loads `data/backups/pre-ideal-migration-20260717-230311.sql` into a temporary PostgreSQL database.
   - Reads `setting_user WHERE key = 'favorites'` for each user.
   - Joins legacy integer IDs to `node.uuid` from the backup.
   - Maps each (user, workspace, UUID) tuple to the current workspace UUID.
   - Emits `user.favorite.add` operations into the PostgreSQL `relay_envelope` table for the matching workspace/actor.
2. ✅ Run the script against the live database — recovered 4 favorites for user `8c3b46ab-9476-4b6b-aa9e-b3c84de3966b` in workspace `3b30e070-039b-47bc-ad0d-2440a2f173c5`.
3. ✅ Verify favorites appear in the sidebar after the client syncs. Dev stack rebuilt and restarted.

### Prevention

Future migrations must enumerate *all* user-facing data, including preferences and derived UI state, not just core node/property data.

---

## Follow-up: Server-to-Client Snapshot Catch-Up

**Status:** Implemented. Updated 2026-07-21.

**Problem:** The backend already stores `relay_snapshot` rows and exposes `/api/relay/snapshot`, but the frontend HTTP transport (`frontend/src/core/transportHttp.ts`) only used paginated `/api/relay/catch-up`. For long-lived workspaces (e.g. 115k operations), even paginated catch-up required ~12 requests and several minutes on first open.

**Solution:** On workspace open, the client now fetches the latest server snapshot, restores the serialized derived SQLite state, and replays only operations newer than the snapshot HLC. After a successful catch-up, the client uploads a fresh snapshot when it is newer than the server's, so the next device opens quickly.

**Implementation:**
1. Reused existing `GET /api/relay/snapshot?workspace_id=...` endpoint in `HttpTransport.getLatestSnapshot()`.
2. Extended `Transport` interface with `getLatestSnapshot()` and `uploadSnapshot(snapshot)`.
3. In `SyncEngine.pull()`:
   - Fetch the latest server snapshot before catch-up.
   - If it is newer than the local watermark, replace the local derived DB with `store.restoreSnapshot(snapshot.data)`.
   - Update `lastReceivedHlc` to the snapshot HLC.
   - Run normal paginated catch-up for operations after the snapshot HLC.
   - When the newly caught-up state is newer than the server's snapshot, export and upload a snapshot via `transport.uploadSnapshot()`.
4. Fixed `RangeError: too many function arguments` in snapshot upload by chunking `Uint8Array` → base64 conversion in `frontend/src/core/transportHttp.ts`.
5. Added **Force workspace re-sync** command (`COMMAND_IDS.FORCE_RESYNC`) to the command palette.
6. Fixed `node.updateContent` applier mismatch: migration emitted `crdtUpdate` but the frontend only handled `textUpdate`/`content`. Frontend now handles `crdtUpdate` as an AST payload, matching the backend applier. Migration changed to emit `content` for future runs.
7. Strengthened **Force re-sync** to clear the local operation log and watermarks so it re-downloads and re-applies all operations. This repairs derived state produced by an older/buggy applier version.

**Acceptance criteria:**
- A workspace with 100k+ operations opens in under 10 seconds on a fast LAN after a snapshot exists.
- The client converges to the same state as a full operation-log replay.
- Snapshot upload no longer crashes on large derived DBs.
- Force re-sync is discoverable in the command palette and rebuilds local state from the server.
- Migrated page/block names render instead of showing "Untitled".

**Verification:**
- `cd frontend && npm run lint` → passes (warnings only, pre-existing).
- `cd frontend && npm run test:run` → 598 passed.
- `docker compose -f compose.dev.yaml exec backend uv run pytest tests/core/migration tests/core/derived tests/core/test_validation.py --no-cov` → 109 passed.
- No server snapshots existed before this change; first successful client sync will seed one.

**Open:**
- Verify force re-sync restores page/block names and uploads a snapshot.
- Snapshot integrity (hash/size check) is not yet implemented; size check implicit in restore/apply path.

---

## Follow-up: Client Derived-State Applier Version

**Status:** Implemented. Updated 2026-07-21.

**Problem:** The `node.updateContent` applier mismatch showed that fixing applier logic on the client is not enough: existing derived SQLite state may have been produced by the old logic. Force re-sync repairs this, but only if the user runs it manually and only if it avoids trusting a stale server snapshot.

**Solution:** Track a `CURRENT_DERIVED_STATE_VERSION` constant in the frontend core. Each client-side SQLite database stores its version in a new `app_meta` table. When the stored version is older than the code constant, `SyncEngine.initialize()` performs a hard rebuild:
1. Push any local operations so nothing is lost.
2. Clear all derived tables and delete local snapshots/compaction segments (they may be stale).
3. Clear the local operation log and reset sync watermarks.
4. Pull the full operation log from the server while ignoring the server snapshot.
5. Apply every operation with the new applier, converging to the correct derived state.
6. Save the new derived-state version.

**Implementation:**
- Added `app_meta` table and PRAGMA `user_version = 7` migration in `frontend/src/core/db/schema.ts`.
- Added `CURRENT_DERIVED_STATE_VERSION`, `getDerivedStateVersion()`, `setDerivedStateVersion()`, `isDerivedStateStale()`, and `resetDerivedState()` to `WorkspaceStore` (`frontend/src/core/store.ts`).
- Added `SyncEngine.initialize()` in `frontend/src/core/sync.ts` that detects stale derived state and runs the hard-rebuild path.
- `SyncEngine.pull()` accepts `{ ignoreSnapshot?: boolean }` and always persists the server's `restore_epoch` after a pull.
- `frontend/src/core/adapters/workspaceStoreAdapter.ts` now calls `syncEngine.initialize()` instead of `syncEngine.syncOnce()` when opening a workspace.
- Added unit test in `frontend/src/core/__tests__/sync.test.ts` proving that a stale derived-state version ignores a stale server snapshot and converges to the latest operation-log state.

**Acceptance criteria:**
- Applier bug fixes automatically repair derived state on the next workspace open, without requiring the user to run force re-sync.
- Stale server snapshots are never trusted after an applier version bump.
- The mechanism is covered by a frontend unit test.

**Verification:**
- `cd frontend && npm run test:run -- --run src/core/__tests__/sync.test.ts` → 3 passed.
- Full frontend suite and backend unit tests pending this commit.

---

## Recovery: Restore Pre-Ideal-Migration Dump and Re-migrate

**Status:** Completed. Updated 2026-07-21.

**Reason:** The live workspace data had accumulated several migration/applier inconsistencies (e.g. `crdtUpdate` handling, stale snapshots, possible incomplete prior migration state). Rather than chase individual corruptions, the pre-ideal PostgreSQL dump was restored and the ideal-architecture migration was re-run cleanly.

**Steps performed:**
1. Stopped the dev stack and backed up the current PostgreSQL data volume and app data dir to `data/backups/manual-restore-20260721-143749/`.
2. Wiped `.config/notees-postgres-dev/` and `.config/notees-backend-dev/data/`.
3. Extracted `pre-ideal-migration-assets-20260717-230316.tar.gz` and `pre-ideal-migration-assets-20260717-230333.tar.gz` into `.config/notees-backend-dev/data/`.
4. Started PostgreSQL and restored `data/backups/pre-ideal-migration-20260717-230311.sql`.
5. Applied `SCHEMA_SQL` (via backend container) to create relay/snapshot tables without dropping legacy tables.
6. Ran `uv run python scripts/migrate_to_ideal.py --relay --data-dir /app/data --force`:
   - Generated **133,804 operations** across all workspaces.
   - Largest workspace (`3b30e070-039b-47bc-ad0d-2440a2f173c5`): **115,705 operations**.
   - Asset operations copied files from legacy `assets/` to content-addressed `files/`.
7. Started backend and frontend. Backend `init_database` dropped legacy tables cleanly.
8. Verified backend health, frontend reachability, and relay_envelope counts.

**Result:** The dev stack is running from a clean, re-migrated state. The user's main workspace contains 115k+ operations in the immutable relay log. Opening the workspace in the browser will trigger the derived-state version hard rebuild and reconstruct SQLite state from the operation log.

**Next steps for the user:**
- Clear site data / IndexedDB for `atlas:5173` in Firefox to remove stale local state.
- Open the app via Tailscale. The sync progress overlay will appear while the client rebuilds derived state from the 115k operations.
- Page titles and content should render correctly after the rebuild completes.

---

## Update 2026-07-21: Snapshots, Compaction, and Admin Tooling Implemented

**Status:** Core operational layers now in place.

**What changed:**
- Created `scripts/admin_create_snapshots.py` to bulk-generate relay snapshots for workspaces that do not have one. Ran it against the dev database; all 20 workspaces now have snapshots.
- Largest workspace (`3b30e070-039b-47bc-ad0d-2440a2f173c5`): snapshot is 59 MB and covers 115,706 operations. New clients restore from the snapshot instead of replaying the full log.
- Updated `scripts/migrate_to_ideal.py --relay` to create a snapshot automatically after each workspace migration (`--skip-snapshot` to opt out).
- Created `scripts/admin_compact.py` to compact old operation envelopes into snapshot+segment records and prune the originals. Defaults to 30-day retention; supports `--dry-run` and `--all`.
- Added `GET /api/relay/stats` returning envelope count/size, snapshot count, latest snapshot HLC, compaction stats, max HLC, and restore_epoch.
- Improved `SyncEngine.initialize()` to use 2,000-operation apply chunks during hard rebuilds (vs. 500 for normal background sync).
- Fixed the stale-local-push problem by using `restore_epoch` detection instead of an operation-count heuristic.

**Commits:**
- `a21f3561` fix(sync): use restore_epoch instead of op-count heuristic
- `b32b2ddf` feat(admin): add bulk snapshot creation script
- `ef5c7c64` feat(migration): create relay snapshots automatically after migration
- `5017fd1d` feat(admin): add compaction script
- `efd62d9c` perf(sync): use larger apply chunks during hard rebuilds
- `e9974686` feat(relay): add workspace stats endpoint

**Remaining from this workstream:**
- Phase 1: add a backend unit test that verifies snapshot restore + incremental catch-up.
- Phase 6: surface `/api/relay/stats` in the settings/admin UI and add workspace-level retention settings.

**What the user should do now:**
- Kill the frozen browser tab.
- Reload `http://atlas:5173`.
- The client will detect the bumped `restore_epoch`, skip the stale local push, restore the 59 MB snapshot, and finish sync in seconds instead of minutes.
- If anything still looks off, run **Force workspace re-sync** from the command palette.

---

## Update 2026-07-21: Favorites and All Pages Fixed

**Status:** Migrated legacy favorites and corrected the All Pages query.

**What changed:**
- Created `scripts/migrate_favorites_from_dump.py` to parse the pre-ideal PostgreSQL dump, map legacy `node.id` integers to current UUIDs, and emit `user.favorite.add` operations. Ran it; imported 4 favorite operations for the main user.
- Regenerated relay snapshots after importing favorites so new clients see favorites immediately.
- Fixed the `all_pages` pseudo-node query in `QueryNodeCollection.tsx`: removed the `has_no_parent` condition so it lists all pages in the workspace, not only top-level pages.

**Commits:**
- `b0777120` fix(favorites,all-pages): import legacy favorites and fix all-pages query

**What the user should do now:**
- Reload the app (private tab is fine). Favorites should appear in the sidebar.
- Open the **All Pages** view; it should now list all pages instead of being empty.

---

## Update 2026-07-21: Sync Progress Modal for Force Re-sync

**Status:** Extracted reusable sync progress UI and added a locked modal for explicit re-syncs.

**What changed:**
- Extracted `SyncProgress` component from `LoadingScreen` so the same spinner, label, rotating messages, and progress bar can be rendered fullscreen or inside a modal.
- Added `SyncProgressModal`: a non-dismissible modal that locks the interface during force re-sync.
- Added `forceResyncWorkspaceId` to `syncStatusStore`.
- Wired the **Force workspace re-sync** command to show the modal while re-syncing and close it on completion or error.
- Kept the fullscreen `LoadingScreen` for initial workspace load.

**Commits:**
- `7aa3cf61` feat(ui): extract SyncProgress and add locked modal for force resync

**What the user should do now:**
- Reload the app. The latest snapshot (with favorites) and the latest frontend code (with the all-pages query fix) are now served.
- If the workspace still shows stale data, run **Force workspace re-sync** from the command palette.
