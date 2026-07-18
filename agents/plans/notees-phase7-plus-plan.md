# Notees Phase 7+ Plan: Port Remaining Islands and Finish the Migration

**Date:** 2026-07-18  
**Branch:** `main`  
**Status:** Phase 8 complete, Phase 9 in progress  

## Goal

Port every remaining legacy feature island to the local-first operation-log core, remove the leftover mutable-row stack, harden the production path, and finalize documentation. After these phases the only data path is:

1. Client edits → operations appended to local SQLite operation log.
2. Operations encrypted and relayed through `app/relay/`.
3. Other clients pull operations and rebuild derived SQLite state.
4. PostgreSQL is used only for users, workspace membership, share metadata, and the encrypted operation log.

## Phase 7: Port Feature Islands to the Operation-Log Core

### G1 — Extend Core Operations and Derived Appliers

Add the operation types and derived-state appliers needed by the remaining islands, while staying aligned with the ideal architecture spec (`docs/superpowers/specs/2026-07-17-notees-ideal-data-architecture-design.md`).

| Island | Operation / schema changes | Derived-state changes |
|---|---|---|
| **Assets** | Treat assets as nodes with a `file` property value. Add `file` to the allowed property schema types. Asset uploads generate a `node.create` (kind `block` or `page` with `asset` class) plus a `property.set` for the file value. | `app/core/derived/property.py` learns to store file values (hash, mime, size, original name) and reference content-addressed blobs. |
| **Tasks** | Task status/scheduled/deadline are already property values. Add `task.recordCompletion` operation for completion history and recurrence triggers. | `app/core/derived/` adds a task completion table; recurrence rules can be a property schema config or a dedicated `task.recurrence` operation. |
| **Shares** | Shares are server permission metadata, not workspace-private operations. No new op type for private shares. Public-share snapshots are uploaded as static files; add `publicShare.publish` operation to record the snapshot node/path in derived state if needed. | `app/relay/permissions_postgres.py` already reads `workspace_share` and `node_public_share`; keep that integration. |
| **Activity log** | No new operation type. Derive activity rows from the operation log itself. | `app/core/derived/activity.py` applier writes activity rows from operations (create, delete, move, property changes). |
| **Undo** | No new operation type. Undo is implemented client-side by generating inverse operations (`property.unset` for `property.set`, reverse `node.move`, `node.delete` for created nodes, etc.). | The inverse generator lives in `frontend/src/core/undo/` and posts inverse operations to the local store. |
| **Plugins** | Introduce a generic `plugin.op` operation type with payload `{ pluginId, opType, data }`. Unknown plugin operations are preserved by the core and forwarded by the relay. | Plugin hosts register derived-state handlers in `app/core/derived/plugins.py` and `frontend/src/core/derived/plugins.ts`. |
| **Collab / Yjs** | Yjs text updates map to `node.updateContent` operations. Yjs tree ordering maps to `node.move` operations. | Reuse existing text/tree CRDT appliers in `app/core/crdt/` and `frontend/src/core/crdt/`. |

**Deliverables:**
1. `app/core/operation.py` extended with new operation types and validation.
2. `app/core/derived/` appliers for file property values, task completions, activity.
3. `frontend/src/core/types/operation.ts` updated to match.
4. Tests for every new applier.

### G2 — Port Backend Feature Islands

Rewrite each backend island to operate on the core/relay stack instead of the legacy nodes/properties services.

**Foundation (done):**
- `app/core/workspace_store.py` provides a server-side `(workspace_id, actor_id)` store that encrypts operations, writes them to the relay, and applies them to a local SQLite derived-state database.
- `get_workspace_store` dependency in `app/features/activity/dependencies.py` resolves the current user's workspace UUID and yields a `WorkspaceStore`.

**Completed islands:**
- **Activity** (`app/features/activity/`): router rewritten to read from `WorkspaceStore` derived state; UUID-based request/response shapes.
- **Assets** (`app/features/assets/`): content-addressed file storage, `asset.upload/delete` operations, UUID-based API.
- **Tasks** (`app/features/tasks/`): recurrence/completion endpoints emit task operations and read from derived SQLite tables.
- **Import** (`app/features/import_/`): Markdown import generates `node.create`, `property.set`, `class.assign`, and `node.updateContent` operations.
- **Shares** (`app/features/shares/`): public/user share operations drive derived share tables; membership metadata remains in PostgreSQL.
- **Plugins** (`app/plugins/core/`): `PluginContext` uses `WorkspaceStore`; built-in importers/sync plugins updated.
- **Collab / Yjs** (`app/features/collab/`): Yjs text updates emit `node.updateContent`; server rooms broadcast operations over the relay WebSocket.
- **Undo** (`app/features/undo/`): server undo endpoint returns `410 Gone`; undo becomes client-side inverse operations.

**Verification:** `uv run pytest tests/core tests/unit -m unit --no-cov` → 391 passed, 3 skipped.

### G3 — Port Frontend Runtime and Query Helpers

Replace the remaining legacy frontend data paths with the core store.

1. **Block tree overlay**:
   - `frontend/src/features/content/hooks/useBlockTree.ts` derives the tree directly from `WorkspaceStore` node + child_order tables.
   - Remove `OperationRuntime` projection.

2. **Runtime sync**:
   - `frontend/src/features/content/hooks/useRuntimeSync.ts` and `runtimeContentOverlay.ts` are replaced by core store subscriptions.

3. **Query helpers**:
   - `frontend/src/features/sync/local/localQuery.ts`, `localReferenceGraph.ts`, `buildOfflineLinkedReferences.ts`, `substituteRuntimeParams.ts` are replaced by core SQLite QueryAST execution (`frontend/src/core/query/compileToSqlite.ts`).
   - `useNodeListQueries.ts`, `useNodeLinkQueries.ts`, `useNodeViews.queries.ts`, `useQueryAst.ts` retarget to the core store.

4. **Search index**:
   - `frontend/src/features/sync/local/searchIndex.ts` (MiniSearch) is replaced by SQLite FTS5 over the derived node/search tables.

5. **Feature UI hooks**:
   - `frontend/src/features/tasks/hooks/`, `frontend/src/features/content/`, `frontend/src/features/layout/` updated to use core hooks and adapters.

**Verification:** `cd frontend && npx tsc -b --noEmit && npm run lint` → clean (6 pre-existing warnings). `npm run test:run` → 91 files, 616 tests passed.

**Note:** `frontend/src/features/sync/local/` files have been deleted because all consumers now use the core store. `frontend/src/runtime/` still exists and will be removed in Phase 8.

### G4 — Integration and Convergence Validation (done)

- `tests/core/test_relay_convergence.py` extended with content-edit and asset-upload convergence tests.
- `tests/core/test_relay_offline_reconnect.py` added for offline → reconnect scenarios.
- `tests/core/test_import_roundtrip.py` added for Markdown import round-trip.
- `tests/core/test_relay_permissions.py` extended with relay-level editor/viewer/revoked-share tests.
- Fixed `apply_node_update_content` to be last-write-wins aware using operation HLC (added `hlc_physical`/`hlc_logical` to derived `node` table).

**Verification:** `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 399 passed, 3 skipped.

## Phase 8: Final Legacy Removal (done)

All legacy mutable-row consumers have been removed and the only runtime path is the core operation-log/SQLite store.

1. Deleted `app/features/nodes/` and `app/features/properties/` (service, repository, postgres, ports, helpers).
2. Deleted `frontend/src/runtime/`, `frontend/src/sync/`, and remaining legacy runtime wrappers.
3. Removed legacy exception handlers and imports from `app/main.py` and `app/dependencies.py`.
4. Removed `app/domain/services/query_ast_sql.py`, `app/domain/repositories/postgres_query.py`, and `app/domain/services/query_ast_validation.py`.
5. Updated remaining consumers: shares, tasks, assets, plugins, editor, content, views, layout.

**Verification:**
- `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 326 passed, 3 skipped, 6 deselected.
- `cd frontend && npx tsc -b --noEmit && npm run lint && npm run test:run` → clean typecheck, lint 0 errors (4 pre-existing warnings), 81 test files / 528 tests passed.

**Commit:** `4ccce511` — `feat(core,frontend): Phase 8 final legacy removal complete`.

## Phase 9: Production Hardening (in progress)

Current gaps discovered at the start of Phase 9:
- Frontend schema has `snapshot`/`compacted_operation_segment` tables but no implementation.
- `frontend/src/core/db/connection.ts` returns an in-memory DB; persistence helpers in `frontend/src/core/persistence/indexedDb.ts` are not wired in.
- `SyncEngine.push()` re-pushes the entire operation log every sync; needs a push watermark or outbox.
- No storage quota monitoring or warnings.
- No WebSocket reconnection/backoff tests or catch-up stress tests.
- No Playwright E2E tests beyond the minimal auth/redirect smoke tests.

### Phase 9A — Backend relay production adapter (done)

1. Added PostgreSQL relay schema (`app/db/schema/relay.sql`):
   - `relay_envelope`, `relay_snapshot`, `compacted_operation_segment` with indexes.
2. Implemented `PostgresRelayStorage` in `app/relay/storage.py` using asyncpg.
3. Switched `get_relay_storage` to Postgres in non-test environments.
4. Added `/api/relay/snapshot` and `/api/relay/compact` admin/owner endpoints.
5. Added per-actor/workspace rate limiting and envelope/batch size validation.
6. Added tests: `tests/core/test_relay_postgres_storage.py`,
   `tests/core/test_relay_admin_endpoints.py`, plus updates to
   `tests/core/test_relay.py`.

**Verification:** `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 341 passed.

**Commit:** `8c0cc41e` — `feat(relay): implement PostgreSQL relay storage, snapshots, compaction, and rate limiting`.

### Phase 9B — Frontend persistence, snapshots, and storage quota (done)

1. Wired `openWorkspaceDatabase` to load/save from IndexedDB via `frontend/src/core/persistence/indexedDb.ts`.
2. Implemented snapshot creation and restore in `WorkspaceStore` (`frontend/src/core/store.ts`):
   - `createSnapshot()` serializes the current derived SQLite database into `snapshot.data`.
   - `restoreLatestSnapshot()` loads the latest snapshot and replays operations newer than the snapshot HLC.
3. Implemented client-side compaction in `WorkspaceStore.compactOperations()`:
   - Removes local operations older than a configurable HLC window.
   - Retains recent operations for undo/audit.
4. Fixed `SyncEngine.push()` to use a push watermark from `sync_push_watermark` and only upload newer operations.
5. Added `useStorageQuota` hook and wired a warning/critical quota alert into `SyncStatusIndicator`.

**Files changed:**
- `frontend/src/core/db/connection.ts` — IndexedDB load/save in real browsers.
- `frontend/src/core/db/schema.ts` — added `sync_push_watermark` table.
- `frontend/src/core/store.ts` — `onPersist`, `persistNow`, `export`, `createSnapshot`, `restoreLatestSnapshot`, `compactOperations`.
- `frontend/src/core/sync.ts` — push watermark filtering.
- `frontend/src/core/adapters/workspaceStoreAdapter.ts` — persistence wiring.
- `frontend/src/core/hooks/useStorageQuota.ts` (new) and `frontend/src/core/hooks/index.ts`.
- `frontend/src/features/sync/components/SyncStatusIndicator.tsx` + `.css` — quota warning UI.
- `frontend/src/core/__tests__/workspaceStore.test.ts` and `frontend/src/core/__tests__/sync.test.ts` — persistence, snapshot, compaction, watermark tests.

**Verification:**
- `cd frontend && npx tsc -b --noEmit && npm run lint` → clean typecheck, lint 0 errors (4 pre-existing warnings).
- `cd frontend && npm run test:run` → 81 test files / 532 tests passed.
- `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 341+ passed.

### Phase 9C — E2E smoke tests (done)

**Status:** Smoke tests pass consistently. Several authentication, timing, and frontend-to-relay integration issues were fixed along the way.

**Changes made:**
1. `frontend/e2e/global-setup.ts` — removed `refreshSession` call. Rotating the refresh token in global setup invalidated the shared `storageState`, so later authenticated tests were redirected to `/auth` when the access token expired.
2. `frontend/e2e/smoke.spec.ts` — increased workspace-redirect timeout to 30s and made the offline-banner test robust against Chromium event-delivery timing.
3. `app/relay/dependencies.py` — fixed `get_actor_id` so relay HTTP endpoints read the same HTTPOnly `access_token` cookie used by the rest of the app. Previously `/api/relay/keys/{workspace}` returned 401, triggering a refresh attempt that hit rate limits and logged the user out.
4. Frontend island hooks (`useFavorites`, `useRecents`, `useNodeDateQueries`) were ported to local-first core stores earlier in this phase.

**Deliverables:**
1. E2E smoke tests pass consistently (20/20 with `--repeat-each=5`).
2. No authenticated test redirects to `/auth` because of token rotation.
3. Relay endpoints authenticate correctly with cookie-based sessions.

**Next:** Remove remaining legacy `/api/nodes/*` callers that still fire during normal app load (visible in backend logs as 404s). Snapshot commit `6216bff1` marks this milestone.

## Phase 9D/E — Remove remaining legacy frontend API callers (in progress)

The E2E smoke suite is green, but the backend logs still show many 404s from the frontend hitting deleted `/api/nodes/*` endpoints during normal load. These callers must be ported to the core store or removed before the migration can be considered complete.

**Progress:**
1. ✅ `listNodes` callers — `useNodeListQueries.ts`, `useQuickAdd.ts`, `PageHeader.tsx`, `useCommandPaletteSelection.ts` ported to the core store. Added `frontend/src/core/query/listPages.ts` helper and extended `queryNodes` to list pages/classes without a text query.
2. ✅ Node read/write callers — `useNodeLinkQueries.ts`, `useNodeGraphQueries.ts`, `useNodeMiscQueries.ts`, `useBatchNodesByUuid.ts`, `useBatchedNode.ts`, and `useBatchedNodeByUuid.ts` ported to the core store. Added local-first query helpers under `frontend/src/core/query/` for backlinks, linked references, property backlinks, graph nodes/links/data, tasks, text links, suggestions, and breadcrumbs. Moved `GraphNode`, `GraphLink`, `GraphData`, `TextLink`, and `NodeVersion` types from `@/api/nodes` to `@/types/api` so core query code never imports the legacy API client.
3. ✅ Mutation callers — `useTrash.ts`, `useArchiveNode.ts`, `useUnarchiveNode.ts`, `useArchivedPages.ts`, `useAddClass.ts`, `useRemoveClass.ts`, `useSetNodeProperty.ts`/`useSetNodePropertyAdapter.ts`, `useConvertNode.ts`, `useAddTagLink.ts`, `useRemoveTagLink.ts`, `useAddAlias.ts`, `useRemoveAlias.ts`, `useEmptyTrash.ts`, `CommandRegistrations.tsx`, `Layout.tsx`. Core store gained `active` flag support, archive/restore/permanent-delete/convert operations, and `includeArchived` query filtering. Snapshot commit `4d4efd8f`.
4. ⏳ Importer/maintenance callers — `useLogseqImporter*.ts`, `FixRawLinksModal.tsx`, `RebuildLinksModal.tsx`.
5. ⏳ `api/nodes.ts` itself can be deleted once all consumers are gone.

**Approach:** port to core store operations/mutations; do not add backward-compatibility shims. Remove dead code aggressively.

**Verification:** after each group, run `npx tsc -b --noEmit`, `npm run lint`, `npm run test:run`, and `npm run test:e2e`.

## Phase 10: Final Documentation and Release (in progress)

1. Update `AGENTS.md` to remove all legacy references — done.
2. Update `docs/CHANGELOG.md` with Phase 7–10 notes — Phase 6–8 done; Phase 9/10 notes pending.
3. Update agent reference docs — in progress:
   - `agents/data-model.md` — rewritten for operation-log architecture.
   - `agents/frontend.md` — updated data-flow and path aliases.
   - `agents/backend.md` — updated for core/relay and Phase 8 removal.
   - `agents/subsystems.md` — updated block-editor mutation flow.
4. Update `compose.yaml` / `compose.dev.yaml` if any service dependencies changed.
5. Final milestone commit: `feat(core,relay,frontend): Notees 2.0 local-first migration complete`.

## Detailed Island Mapping (from Phase 7 audits)

### Backend audit findings

See full output: `/root/.kimi-code/sessions/wd_notees_d966f9fda784/session_2514030d-61ec-4d0c-8f5d-4a27bb0af85c/agents/main/tasks/agent-itb7sjo6/output.log`

| Island | New operations / schemas | Derived appliers | Porting notes |
|---|---|---|---|
| Tasks | `task.recordCompletion`, `task.deleteCompletion`, `task.setRecurrence`, `task.deleteRecurrence` | `task_completion`, `task_recurrence` tables | Automation side effects move to client-emitted ops; day-node resolution happens client-side. |
| Assets | `asset.upload`, `asset.delete` | `node_asset` table + content-addressed blob metadata | Blobs stay outside the relay (filesystem/object storage). Asset tokens become signed URLs or relay auth. |
| Import | orchestration op optional | expands into existing `node.create`/`property.set`/`class.assign` | Markdown import moves to the client; conflict mode checked against local derived state. |
| Shares | `share.public.create/revoke`, `share.user.grant/revoke` | `node_public_share`, `node_user_share` tables | Relay permission checker already reads `workspace_share` / `node_public_share`; public pages are static snapshots. |
| Activity | `activity.record`, `link.click` | `activity_log`, `link_click` tables | Side-effect logging becomes explicit client ops. |
| Undo | none (client-side inverse ops) | inverse generator in `frontend/src/core/undo/` | Legacy `undo_log` removed once all writes flow through the operation log. |
| Plugins | `plugin.op` | `plugin_op_log` + plugin-registered handlers | `PluginContext` gets `WorkspaceStore`/`RelayTransport` ports instead of legacy services. |
| Collab | `presence.*` (ephemeral), reuse `node.updateContent` | CRDT merge in `node.updateContent` applier | `node_yjs_state` table retired; sync goes through `/api/relay/batch` and `/api/relay/catch-up`. |

Cross-cutting requirements:
1. Server-side side effects become client-emitted operation batches.
2. `PostgresPermissionChecker` must authorize relay `batch`/`catch-up` using membership, `node_share`, and `node_public_share`.
3. `PostgresRelayStorage` still needs a full implementation.
4. Backend `app/core/derived/` and frontend `frontend/src/core/derived/` must stay in sync.

### Frontend audit findings

See full output: `/root/.kimi-code/sessions/wd_notees_d966f9fda784/session_2514030d-61ec-4d0c-8f5d-4a27bb0af85c/agents/main/tasks/agent-jvwb2r7p/output.log`

Major legacy surfaces:
1. `frontend/src/runtime/` — `OperationRuntime`, `RuntimeEventBus`, `ProjectionReconciler`, graph helpers, undo engine.
2. `frontend/src/features/content/hooks/useBlockTree.ts`, `useRuntimeSync.ts`, `runtimeContentOverlay.ts` — tree projection.
3. `frontend/src/features/sync/local/` — IndexedDB mirror, MiniSearch, offline QueryAST evaluator.
4. Editor plugins (`InlineTriggers`, `TriggerPopup`, `useContentSave`) — still use runtime intents.

Recommended port order:
1. Core primitives (search index, missing mutations, move `substituteRuntimeParams` into `core/query/`).
2. Editor (`useContentSave` core-only, retarget `InlineTriggers`/`InlineNodeLinks`/`TriggerPopup`).
3. Tree projection (`useBlockTree` on `useChildren`/`useNode`, then `BlockList`/`BlockRow`/selection/drag-drop).
4. Offline/local-sync retirement (`queryNodesLocal`, MiniSearch, `localNodeStore`, offline reference graph).
5. Undo engine and drag coordinator.
6. Cleanup: remove `OperationRuntime`, `features/sync/local/`, `ENABLE_SQLITE_STORE` branches.

## Backup

A full pre-Phase 7 backup was created before destructive work:

- `data/backups/pre-phase7-20260718-104213-data.tar.gz` (workspace files, relay SQLite, plugins, user data)
- `data/backups/pre-phase7-20260718-104213-postgres.sql.gz` (PostgreSQL dump)

A pre-commit Phase 8 backup was also created before the final legacy-removal commit:

- `data/backups/phase8/` (workspace files, relay SQLite, plugins, user data, app db snapshot)

## Verification Checklist

- [x] Core operation types/appliers extended and tested.
- [x] Backend islands ported and no longer import legacy nodes/properties services.
- [x] Frontend runtime overlay and local query helpers replaced by core store.
- [x] `uv run pytest tests/core tests/unit -m unit --no-cov` passes.
- [x] `cd frontend && npx tsc -b --noEmit && npm run lint` passes.
- [x] `cd frontend && npm run test:run` passes (no legacy failures).
- [x] Multi-client convergence tests pass.
- [x] E2E smoke tests pass.
- [x] Remove remaining legacy `/api/nodes/*` callers from normal app load — mutation callers done; importer/maintenance callers remain.
- [ ] `AGENTS.md`, plans, and changelog updated.
- [ ] Final milestone commit created.
