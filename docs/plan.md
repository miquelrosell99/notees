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

## Phase 4 — Frontend sync/lifecycle/UX hardening
*Owner: implementer subagent `frontend-sync-ux-fixes`*

1. Make `SyncEngine.syncOnce` re-entrant safe (in-flight promise lock).
2. Debounce `registerVisibilitySync` and skip if already syncing.
3. Replace the full-screen `BackendUnavailableOverlay` with a dismissible warning banner for short outages; keep full lock only after a longer threshold.
4. Combine `OfflineBanner` with backend health state.
5. Refactor `RouteAdapter` to separate one-time init from reactive updates and avoid re-processing.
6. Make `useNodeAdapter` not-found redirect sync-aware (only redirect after sync is `synced`/`error`).
7. Improve `WorkspaceSwitcher` error handling (toast + retry, invalidate list).
8. Cap recursion / debounce `countWordsInTree`.
9. Fix new `react-hooks/exhaustive-deps` warnings introduced by recent changes.

## Phase 5 — Frontend adapter subscriptions and dead-code cleanup
*Owner: implementer subagent `frontend-adapter-cleanup`*

1. Add worker-change subscriptions to `useNodeAdapter`, `useNodeChildrenAdapter`, and `useNodesAdapter` so local mutations and incoming sync refresh the UI.
2. Remove the unused `operationQueue` IndexedDB persistence API (or wire it into the mutation path).
3. Clean up remaining TODOs in adapter hooks.

## Phase 6 — Backend sync/auth/scoping hardening
*Owner: implementer subagent `backend-auth-scope-fixes`*

1. **WebSocket authentication**: validate JWT cookie/Bearer on the WebSocket handshake; do not accept `X-Actor-Id` alone.
2. **Batch submission atomicity**: validate/permission-check in memory, then bulk insert with `ON CONFLICT DO NOTHING`; return saved ids from DB result.
3. **Public-share catch-up**: restrict catch-up to the shared node scope (`affected_node_ids @> [shared_node_id]`) or reject workspace-wide catch-up for share tokens.
4. **SQLite catch-up performance**: push the HLC filter into SQL instead of fetching the whole workspace log.
5. **Workspace restore atomicity**: wrap delete, epoch bump, and import in one transaction; validate dump schema first.
6. **Rate-limit identifiers**: derive key from authenticated user/path instead of reparsing the request body.
7. **Align `KNOWN_OP_TYPES`**: add missing frontend op types to the backend set.

## Phase 7 — WebSocket cross-process broadcast
*Owner: implementer subagent `backend-redis-broadcast`*

1. Replace the in-memory WebSocket broadcast registry with Redis pub/sub (using existing `redis_url`).
2. Keep unit-testable in-memory fallback when Redis is unavailable (e.g. single-worker dev mode).

## Phase 8 — Verification
- Run `uv run pytest tests/ -m "not slow" --no-cov` inside the backend container.
- Run `cd frontend && npm run lint && npx tsc -b --noEmit`.
- Add targeted tests for all new behavior above.
- Manual smoke test: login, select workspace, switch workspace, reload, edit a node, reload again.

## Open questions / future work
- Server-side derived-state cache for large workspaces (currently each export rebuilds SQLite).
- Add CI check that keeps frontend/backend `KNOWN_OP_TYPES` in sync.
- Performance profile workspace switch to quantify perceived freeze after these fixes.
