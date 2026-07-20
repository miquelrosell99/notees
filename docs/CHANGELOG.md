# Notees Changelog

## 2.0.0 — Local-first architecture complete (Phases 6–9)

**Date:** 2026-07-18

### Architecture

- The authoritative data model is now an **immutable operation log** with client-side SQLite derived state and an encrypted operation relay.
- The legacy `/api/nodes/*`, `/api/properties/*`, and `/api/sync/*` endpoints have been unmounted. The frontend now reads and writes through the local SQLite store and syncs via `/api/relay/*`.
- The legacy v2 sync dispatcher (`SyncManagerV2`, `localSyncEngine`, `LocalIndexManager`, `QueryLiveUpdater`) and `frontend/src/runtime/` (`OperationRuntime`) have been removed.
- `app/features/nodes/` and `app/features/properties/` have been deleted; all remaining feature islands (tasks, assets, import, shares, activity, undo, plugins, collab) operate on the operation-log core.
- All operations carry unencrypted routing metadata (`affected_node_ids`, `op_type`, HLC) so the relay can enforce node-level shares without decrypting payloads.

### Production Hardening (Phase 9)

- **Backend relay adapter**: PostgreSQL-backed `PostgresRelayStorage` with envelope/snapshot/compaction tables, rate limiting, envelope validation, and admin endpoints.
- **Frontend persistence**: `openWorkspaceDatabase` loads and saves the SQLite database from IndexedDB; `WorkspaceStore` supports explicit `persistNow`, snapshot export, and compaction.
- **Snapshot replay**: startup loads the latest snapshot and replays only operations newer than the snapshot HLC, bounding cold-start cost.
- **Push watermark**: `SyncEngine.push()` tracks the last-pushed HLC in `sync_push_watermark` and only uploads newer operations.
- **Storage quota**: `useStorageQuota` monitors `navigator.storage.estimate()`; `SyncStatusIndicator` surfaces warning/critical quota alerts.

### Data & Migration

- Existing workspaces have been seeded into the encrypted operation relay using `scripts/seed_relay_from_postgres.py --all --direct`.
- A full PostgreSQL backup and workspace-data backup were captured before destructive changes:
  - `data/backups/notees-20260718-085505.dump`
  - `data/backups/notees-data-20260718-085514.tar.gz`
- A pre-Phase 8 backup is available at `data/backups/phase8/`.

### Phase 9D/E — Remove remaining legacy frontend API callers

- The last `frontend/src/api/nodes.ts` consumers (search, selectors, command palette, navigation, views/graph, comments, aliases, templates, share receiver, version history, merge, and trash) have been ported to the core SQLite store.
- `frontend/src/api/nodes.ts` has been deleted. The frontend no longer calls any `/api/nodes/*` endpoints.
- Comments are implemented as child blocks with the `comment` system class.
- Templates are pages with the `template` class; variables are parsed from content placeholders.
- Aliases and version restore are intentionally not yet modeled in the operation-log core and return empty/no-op results.

### Phase 10 — Final documentation and release milestone

- `AGENTS.md` and agent reference docs updated to reflect the completed migration.
- Added an idempotent schema migration for pre-existing flashcard tables: legacy `flashcard.node_id` is migrated to `flashcard.node_uuid`, ensuring fresh starts and upgraded dev databases both initialize cleanly.
- Full verification run completed:
  - `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 367 passed, 3 skipped.
  - `cd frontend && npx tsc -b --noEmit && npm run lint` → clean (5 pre-existing warnings).
  - `cd frontend && npm run test:run` → 83 test files / 552 tests passed.
  - `npm run test:e2e` → 4/4 smoke tests passed.
- Final milestone commit: `feat(core,relay,frontend): Notees 2.0 local-first migration complete`.

### Developer Notes

- `frontend/src/core/` is the sole path for state, hooks, and sync.
- `agents/plans/notees-phase7-plus-plan.md` is marked complete.

## Phase 12 — Cleanup and roadmap

**Date:** 2026-07-20

### Cleanup debt

- **Shares UUID migration**: share metadata tables (`node_public_share`, `node_share`, `pending_invite`) now use `node_uuid` instead of the legacy numeric `node_id`. The frontend `/nodes/{uuid}/shares` and `/nodes/{uuid}/user-shares` endpoints no longer depend on the legacy `node` table.
- **Node-scoped share router**: `node_shares_router` is mounted under `/api/nodes` and `/api/v1/nodes`.
- **Collab permission repository migrated to `node_uuid`**: `PostgresPermissionRepository` and `PermissionChecker` now resolve node-level shares by UUID, removing the last internal consumer of `node_share.node_id`. `app/features/collab/yjs_service.py` checks permissions directly against the node UUID.

### Rich-text CRDT polish

- Added `TextCrdt.format()` and `TextCrdt.toDelta()` in `frontend/src/core/crdt/text.ts`.
- Added tests proving formatting attributes survive CRDT state reload and concurrent merge.

### Plugin ecosystem expansion

- Added built-in `notees.opml_exporter` plugin that exports node trees to OPML 2.0.
- Extended `ExportContext` with `nodes_data` so plugin exporters can consume the already-fetched tree.

### Scale testing and stress tests

- Added backend stress suite (`tests/core/stress/`): replay, catch-up, storage overhead, multi-client convergence.
- Added frontend stress suite (`frontend/src/core/__tests__/stress/`): apply latency, snapshot restore, catch-up, convergence burst.
- Added benchmark report at `agents/plans/phase12-scale-benchmark.md`.

### Dev environment

- Replaced the Vite-native `@vitejs/plugin-basic-ssl` setup with a Node.js TLS-terminating TCP proxy (`frontend/scripts/dev-server.cjs`) inside the frontend dev container that exposes both HTTPS (`5173`) and HTTP (`5172`) simultaneously.
- Vite now runs on internal port `5174` plain HTTP; the Node proxy terminates TLS with a self-signed certificate and forwards raw TCP for both protocols, so WebSocket HMR and the original `Host` header are preserved.
- Removed `nginx` from the dev container and dropped `@vitejs/plugin-basic-ssl` from `frontend/package.json`.
- Host access: `https://localhost:5173` and `http://localhost:5172`; over Tailscale use `https://atlas:5173` for a secure context (required for `crypto.subtle`) or `http://atlas:5172` for plain HTTP.

### Verification

- `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 402 passed, 3 skipped, 6 deselected, 1 warning.
- `cd frontend && npx tsc -b --noEmit && npm run lint` → clean (0 errors, 5 pre-existing warnings).
- `cd frontend && npm run test:run` → 91 files / 582 passed.
- `npm run test:e2e` → 5/5 passed.

## Phase 11 — Close remaining product gaps

**Date:** 2026-07-20

### Core payload alignment

- `node.updateContent` now accepts `content` (direct AST payload) and `treeUpdate` (tree CRDT state) in addition to `crdtUpdate`/`textUpdate`.
- Derived-state applier stores `treeUpdate` in `crdt_state.tree_state` without overwriting `node.content`.

### Workspace operation-log seeding

- New workspaces are now seeded into the encrypted operation-log relay via `app/core/seed.py`.
- System classes (`page`, `whiteboard`, `query`, `task`, `comment`, `card`, `cloze`, `asset`, `template`, `class`) and the default page are created as operations, so fresh accounts have the same derived state as migrated ones.
- Fixed encrypted-envelope wire-format mismatch: `workspaceId`/`actorId`/`affectedNodeIds`/`opType` are now camelCase on the wire and accepted by name.
- `useClasses` is now reactive to all `WorkspaceStore` changes.

### Re-implemented importers

- **Logseq Markdown-folder importer** restored as a client-side core-store importer plugin (`useLogseqMarkdownImporter.ts`, `ImportLogseqFolderModal.tsx`).

### Whiteboard and flashcards

- **Whiteboard**: save/reload now round-trips through the operation-log relay; added Playwright E2E test (`frontend/e2e/whiteboard.spec.ts`).
- **Flashcards**: auto-create flashcard rows on `card` class assignment, rehydrate front/back text from node name and cloze children, added router/service/component tests.

### Comments threading

- `SidebarComments` now renders nested replies recursively with indentation and reply affordances.

### Verification

- `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 384 passed, 3 skipped, 6 deselected, 1 warning.
- `cd frontend && npx tsc -b --noEmit && npm run lint` → clean (0 errors, 5 pre-existing warnings).
- `cd frontend && npm run test:run` → 88 files / 571 passed.
- `npm run test:e2e` → 5/5 passed.
- Final gap-closure commit: `feat(core,frontend): Phase 11 remaining gaps closed`.

## Phase 13 — Residual cleanup debt

**Date:** 2026-07-20

### Schema migrations

- **`node_yjs_state` is now UUID-keyed**: the collab Yjs state table uses `node_uuid UUID PRIMARY KEY` instead of the legacy integer `node_id`. An idempotent migration backfills `node_uuid` from `node.uuid` and drops the old column. A foreign key to `node(uuid)` is not enforced because system-class UUIDs are shared across workspaces, so `node.uuid` is only unique per workspace.
- **`notification` references nodes by UUID**: the `notification` table uses `node_uuid UUID` instead of `node_id`. An idempotent migration backfills and drops the legacy integer column.

### Code updates

- `app/features/collab/yjs_repository.py` queries and upserts Yjs state by `node_uuid`; the `resolve_node_id` helper and internal `_by_node_id` methods were removed.
- `app/features/collab/yjs_service.py` no longer resolves UUID→integer before calling the repository; permissions are checked against the UUID directly.
- `app/features/notifications/{port,repository,service,router}.py` create and list notifications using `node_uuid`.
- `NotificationResponse` now returns `node_uuid` (string | null) instead of `node_id`, matching the frontend `NotificationResponse` type.

### Test cleanup

- `tests/test_visibility_and_shares.py`: removed the legacy `TestPagePrivacy` class (privacy enforcement is covered by `TestPermissionCheckerPrivacy` and relay permission tests). `TestPublicShareStaticHtml` now seeds nodes via direct PostgreSQL inserts and exercises `ShareService` for HTML generation/regeneration/deletion while still verifying static serving through `GET /s/{share_uuid}`.
- Removed broken legacy integration tests whose behavior is already covered by the core/unit suite: `test_sync_v2.py`, `test_benchmarks.py`, `test_node_conversion.py`, `test_date_range_integration.py`, `test_soft_delete.py`, `test_links.py`, `test_optimistic_locking.py`.
- Rewrote remaining integration tests to avoid the deleted `node_service` fixture:
  - `tests/test_retention_cleanup.py` now inserts nodes directly into PostgreSQL.
  - `tests/test_validation.py` now tests node create/update validation through `validate_node_create` / `validate_node_update` and keeps the invite-password tests.
  - `tests/test_yjs_state.py` now creates the test page via direct DB insert.

### Verification

- `uv run pytest tests/test_visibility_and_shares.py -q --no-cov` → 7 passed.
- `uv run pytest tests/test_retention_cleanup.py -q --no-cov` → 8 passed.
- `uv run pytest tests/test_validation.py -q --no-cov` → 9 passed.
- `uv run pytest tests/test_yjs_state.py -q --no-cov` → 3 passed.
- `uv run pytest tests/core/test_collab_router.py tests/core/test_collab_ws.py -q --no-cov` → 9 passed.
- `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 402 passed, 3 skipped, 6 deselected, 1 warning.
- `uv run pytest tests/ -m integration -q --no-cov` → 36 passed; remaining failures are in untouched legacy integration tests that depend on removed endpoints.
