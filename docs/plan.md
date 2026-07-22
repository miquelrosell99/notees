# Notees Stability & Performance Stabilization Plan

## Goal
Eliminate workspace-loading freezes, infinite "Loading notees" hangs, and sync-related data bugs so the app is reliably usable. This plan addresses the findings from three parallel audits:
- `.superpowers/sdd/audit-frontend-runtime.md`
- `.superpowers/sdd/audit-backend-sync.md`
- `.superpowers/sdd/audit-critical-paths.md`

## Guiding principles
- Fix root causes, not symptoms; remove workarounds that hide failures.
- Add timeouts and error propagation so hangs become actionable errors.
- Preserve data correctness above performance.
- Verify each phase with tests before moving on.

## Phase 1 — Frontend worker/runtime hardening
*Owner: implementer subagent `frontend-runtime-fixes`*

Stop the hangs and duplicate-worker races in the local-first runtime.

1. Add per-request timeouts in `WorkspaceStoreClient.send` and terminate/re-create the worker on timeout. Add an `initSqlJs` timeout in the worker.
2. Serialize concurrent opens in `getOrCreateWorkspaceStoreClient` using a `pendingOpens` map (mirror `workspaceStoreAdapter.ts`).
3. Remove terminated clients from `clientRegistry` in `closeWorkspaceStore` / `resetWorkspaceStore`; make `getOrCreateWorkspaceStoreClient` detect and recreate dead clients.
4. Close the previous workspace in `WorkspaceStoreInitializer`'s cleanup effect when `workspaceId` changes.
5. Propagate `syncEngine.initialize()` errors to `WorkspaceStoreInitializer` so the existing error overlay and retry button work.
6. Clear `sqlInitError` on retry and add retry/backoff in `getSqlModule`.
7. Gate workspace initialization on `authVerified` so it does not start with `actorId = 'anonymous'`.

## Phase 2 — Backend sync correctness
*Owner: implementer subagent `backend-sync-fixes`*

Fix data-loss and divergence bugs in the relay / operation log.

1. **Compaction safety**: refuse to prune envelopes unless the snapshot created at `up_to_hlc` contains non-empty derived-state data. Reject `create_snapshot` uploads with empty `data` when they would cover pruned operations.
2. **Catch-up pagination**: pass both `hlc` and `after_id` to the storage layer and query `(physical, logical) > ($hlc.physical, $hlc.logical)` plus `(physical, logical, id) > (subselect for after_id)`. Return a clear error when `after_id` is missing.
3. **`restore_epoch` reliability**: only return `0` for "workspace not found" (404). Propagate genuine DB errors as 5xx/503 so clients retry instead of wiping local state.
4. (If time permits) Validate snapshot uploads: reject `up_to_hlc` ahead of `get_max_hlc` and verify snapshot bytes.

## Phase 3 — Critical UI/auth/list-view fixes
*Owner: implementer subagent `ui-critical-paths-fixes`*

Fix user-visible broken flows.

1. **Session expiry**: in `AuthenticatedShell`, check `authStatus.authenticated === false`, log out, and redirect to `/auth` before loading workspaces.
2. **`useNodesAdapter` Web Worker support**: implement `listNodes` in the worker and route the hook through `client.query('listNodes', [filters])`; remove the non-transferable `getDb` path.
3. **Early edit buffering**: queue edits in `useContentSave` when the workspace client/undo manager is not ready and flush once available.
4. Gate workspace-list queries on `authVerified` in `WorkspacePersisterSync` and `WorkspaceStoreInitializer`.
5. Disable or shorten service-worker runtime caching for `/api/*` mutable routes.

## Phase 4 — Verification
- Run `uv run pytest tests/ -m "not slow" --no-cov` inside the backend container.
- Run `cd frontend && npm run lint && npx tsc -b --noEmit`.
- Add targeted tests for compaction snapshot data, catch-up pagination with concurrent inserts, and `restore_epoch` error propagation.
- Manual smoke test: login, select workspace, switch workspace, reload, edit a node, reload again.

## Open questions / future work
- Server-side derived-state cache for large workspaces (currently each export rebuilds SQLite).
- Redis pub/sub for WebSocket broadcasts across multiple uvicorn workers.
- Replace full-screen `BackendUnavailableOverlay` with a dismissible banner for short outages.
