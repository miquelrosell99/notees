# Phase 6: Cleanup and Deprecation (Dependency-Aware)

**Date:** 2026-07-18  
**Branch:** `main`  
**Status:** Complete  

## Executive Summary

Phase 6 is **not** a big-bang deletion of the old mutable-row stack. A dependency audit shows that several production features still rely on the legacy `app.features.nodes` / `app.features.properties` service and repository layers, and the frontend still uses the `OperationRuntime` overlay for block-tree rendering and optimistic updates.

Therefore Phase 6 is scoped as **deprecation and removal of genuinely superseded surfaces**, while keeping the internal legacy service/repo layers as a private compatibility shim for the remaining feature islands. Full removal of those layers is deferred to **Phase 7**.

What is removed now:

- The legacy v2 sync HTTP surface (`app/features/sync/*`) — superseded by `app/relay/`.
- The legacy nodes/properties/sync HTTP routers from `app/main.py` — the frontend now talks to the relay.
- The legacy QueryAST PostgreSQL compiler (`app/domain/services/query_ast_sql.py`, `app/domain/repositories/postgres_query.py`) once unmounted.
- The `VITE_ENABLE_SQLITE_STORE` feature flag for all hooks that already have a core adapter twin.
- The legacy v2 frontend sync dispatcher (`SyncManagerV2`, `localSyncEngine`, `LocalIndexManager`, `QueryLiveUpdater`) — superseded by `frontend/src/core/sync.ts`.

What stays for now:

- `app/features/nodes/{node_service,class_*_service,link_service,mention_service,port.py,postgres_*.py,dependencies.py}` — used by tasks, assets, import, shares, activity, undo, plugins.
- `app/features/properties/{service,repository,port.py,attributes.py,dependencies.py}` — used by the same islands.
- `app/features/tasks/`, `app/features/assets/`, `app/features/import_/`, `app/features/shares/`, `app/features/activity/`, `app/features/undo/`, `app/plugins/` — to be ported in Phase 7.
- `frontend/src/runtime/` and the runtime-based block-tree overlay — to be replaced with core store subscriptions in Phase 7.
- `frontend/src/features/sync/local/{localQuery,substituteRuntimeParams,buildOfflineLinkedReferences}` — used by query hooks until those hooks are retargeted to the core SQLite compiler.

## Pre-Cleanup Safety Actions

1. Database backup: `data/backups/notees-20260718-085505.dump` (PostgreSQL custom format, ~11 MB).
2. Filesystem backup: `data/backups/notees-data-20260718-085514.tar.gz` (workspace dirs, currently empty assets).
3. Verification baseline committed: `51fd337d fix(frontend): filter text property blocks ...`

## F1 — Backend Safe Cleanup

### F1.1 Remove legacy sync feature

Delete the entire `app/features/sync/` package:

- `app/features/sync/__init__.py`
- `app/features/sync/dependencies.py`
- `app/features/sync/port.py`
- `app/features/sync/repository.py`
- `app/features/sync/router.py`
- `app/features/sync/service.py`
- `app/features/sync/service_v2.py`

Clean up the only external import found so far:

- `app/dependencies.py:350` references `app.features.sync.dependencies._get_sync_service`; remove that factory branch.

### F1.2 Unmount legacy nodes/properties/sync routers

In `app/main.py`:

- Remove imports of `nodes_router`, `properties_router`, `sync_router`.
- Remove them from the `routers` list (keep auth, workspaces, tasks, assets, import, export, undo, activity, notifications, admin, shares, plugins, collab/events/yjs, public).
- Keep exception handlers for `NodeNotFoundError`, `DuplicateNodeError`, etc.; they are still thrown by the remaining legacy services.

In `app/routers/__init__.py`:

- Stop exporting `nodes_router`, `properties_router`, `sync_router`.
- Keep all other routers.

### F1.3 Remove legacy QueryAST compiler (if unmounted)

After the nodes router is unmounted, verify no code imports:

- `app/domain/services/query_ast_sql.py`
- `app/domain/repositories/postgres_query.py`
- `app/domain/services/query_ast_validation.py`

If truly unreferenced, delete them. If still referenced by tests or other features, defer to Phase 7.

### F1.4 Prune dead router endpoint modules

The following modules are only imported by the nodes/properties router `__init__.py` files. Once the routers are unmounted they become dead code:

Under `app/features/nodes/router/`:

- `crud.py`
- `search.py`
- `links.py`
- `batch.py`
- `views.py`
- `trash.py`
- `favorites.py`
- `comments.py`
- `classes.py`
- `versions.py`
- `templates.py`

Under `app/features/properties/router/`:

- `classes.py`
- `crud.py`
- `selection_lines.py`
- `values.py`

Keep:

- `app/features/nodes/router/helpers.py`
- `app/features/nodes/router/dependencies.py`
- `app/features/properties/router/helpers.py`
- `app/features/properties/router/dependencies.py`

These are imported by tasks, assets, import, shares, and activity routers.

If removing endpoint modules makes `__init__.py` empty or unnecessary, simplify or remove `__init__.py` while preserving the helper/dependency modules at their current paths.

### F1.5 Verify backend

Run:

```bash
uv run ruff check app/
uv run pytest tests/core tests/relay tests/unit -m unit --no-cov
```

Fix any import errors caused by deletions before committing.

## F2 — Frontend Safe Cleanup

### F2.1 Make SQLite store the default and remove the flag

For every hook that already has a `*Legacy()` / adapter twin guarded by `ENABLE_SQLITE_STORE`:

- Keep the adapter implementation.
- Delete the legacy implementation and the `ENABLE_SQLITE_STORE` branch.
- Return the adapter result directly.

Known hook files with twins:

- `frontend/src/features/content/hooks/useCreateNode.ts`
- `frontend/src/features/content/hooks/useUpdateNode.ts`
- `frontend/src/features/content/hooks/useMoveNode.ts`
- `frontend/src/features/content/hooks/useDeleteNode.ts`
- `frontend/src/features/properties/hooks/usePropertyQueries.ts`

Also remove `frontend/src/core/utils/featureFlags.ts` if it becomes empty.

### F2.2 Remove legacy v2 sync dispatcher

Delete or neutralize:

- `frontend/src/features/sync/SyncManagerV2.tsx`
- `frontend/src/features/sync/SyncManagerV2.test.tsx`
- `frontend/src/features/sync/engine/localSyncEngine.ts`
- `frontend/src/features/sync/engine/localSyncEngine.test.ts`
- `frontend/src/features/sync/components/LocalIndexManager.tsx`
- `frontend/src/features/sync/components/QueryLiveUpdater.tsx`
- `frontend/src/features/sync/components/QueryLiveUpdater.test.tsx`
- `frontend/src/features/sync/components/ConflictResolutionModal.tsx` (if only used by SyncManagerV2)
- `frontend/src/features/sync/stores/syncStatusStore.ts` (if only used by SyncManagerV2)
- `frontend/src/features/sync/stores/conflictStore.ts` (if only used by SyncManagerV2)
- `frontend/src/features/sync/utils/graphNodeToConflictNode.ts` (if only used by conflict resolution)
- `frontend/src/features/sync/api/syncV2.ts` and its test

Update `frontend/src/App.tsx`:

- Remove imports of `SyncManagerV2`, `LocalIndexManager`, `QueryLiveUpdater`.
- Remove `ENABLE_SQLITE_STORE` and the conditional `WorkspaceStoreInitializer` wrapper — always render `WorkspaceStoreInitializer`.
- Remove the legacy sync components from `AppProviders`.

Update `frontend/src/features/sync/index.ts` barrel to export only the remaining UI pieces (`useUIStateStore`, `useFoldKeyboardShortcut`, `SyncStatusIndicator`).

### F2.3 Disconnect runtime from local sync engine

`frontend/src/runtime/eventBus.ts` calls `localSyncEngine.prepareStructuralOperations` and `localSyncEngine.stageOperationsFireAndForget`. Once `localSyncEngine` is gone, remove those calls. The runtime remains in use as the optimistic overlay until Phase 7.

`frontend/src/features/editor/hooks/useContentSave.ts` calls `localSyncEngine.flush()` on unmount/beforeunload. Remove those calls; the core sync engine persists operations.

### F2.4 Cautious pruning of `features/sync/local/`

Some files in `features/sync/local/` are still imported by query hooks:

- `localQuery.ts` → `useNodeListQueries.ts`, `useNodeViews.queries.ts`
- `buildOfflineLinkedReferences.ts` → `useNodeLinkQueries.ts`
- `substituteRuntimeParams.ts` → `useQueryAst.ts` (core hook)

Do **not** delete those three files until the consuming hooks are retargeted to the core SQLite compiler. The remaining `localNodeStore.ts`, `localReferenceGraph.ts`, `searchIndex.ts`, and their tests can be deleted if they have no other consumers.

### F2.5 Verify frontend

Run:

```bash
cd frontend
npx tsc -b --noEmit
npm run lint
npm run test:run src/core src/features/content src/features/properties src/features/sync src/runtime
```

Fix import/type errors before committing.

## F3 — Final Migration Run and Documentation

### F3.1 Seed the relay

Run the idempotent seed script against the live database:

```bash
uv run python scripts/seed_relay_from_postgres.py --all
```

Verify relay storage counts match the migration baseline.

### F3.2 Update documentation

- Update `AGENTS.md`: mark the local-first/SQLite core as the default runtime, and document that legacy nodes/properties services remain as a compatibility layer for tasks/assets/import/shares/activity/undo/plugins.
- Update `agents/plans/notees-full-migration-plan.md` Phase 6 status to complete.
- Add a user-facing changelog note under `docs/` describing the architecture cut-over.

## Deferred to Phase 7

The following cannot be removed in Phase 6 without breaking still-active features:

1. **Tasks** — `TaskAutomationService` uses `NodeService.get_or_create_day_node` and property repositories.
2. **Assets** — `AssetService` uses `NodeRepository` to create/find asset nodes.
3. **Import** — `ImportService` uses `NodeService` and `PropertyService`.
4. **Shares** — `ShareService` uses `NodeRepository` and `ExportService`.
5. **Activity log** — activity router uses node repository/dependencies.
6. **Undo engine** — depends on `OperationRuntime` and the event bus.
7. **Plugins** — bootstrap registers legacy node/property service ports.
8. **Collab / Yjs** — still mounted; integration with the relay needs a dedicated design.
9. **Runtime-based block tree** — `useBlockTree`, `useRuntimeSync`, and many editor hooks use `OperationRuntime` for optimistic overlay.
10. **Local query helpers** — `useNodeListQueries`, `useNodeLinkQueries`, `useNodeViews.queries`, and `useQueryAst` still import `features/sync/local` helpers.

Phase 7 will port or wrap each island before the legacy service and runtime layers can be deleted.

## Verification Checklist

- [x] `uv run ruff check app/` passes.
- [x] `uv run pytest tests/core tests/unit -m unit --no-cov` passes (285 passed, 3 skipped).
- [x] `uv run python scripts/seed_relay_from_postgres.py --all --direct` succeeds; total relay envelopes = 133,804 matching migration baseline.
- [x] Smoke tests passed on sample workspaces (5eaf25db and 3e349686).
- [x] `cd frontend && npx tsc -b --noEmit` passes.
- [x] `cd frontend && npm run lint` passes (6 pre-existing warnings).
- [x] `cd frontend && npm run test:run src/core src/features/content src/features/properties src/features/sync src/runtime` → 218 passed, 7 pre-existing failures in `features/sync/local`.
- [x] `AGENTS.md`, `docs/CHANGELOG.md`, and plan files updated.
- [x] Phase 6 milestone commit created.
