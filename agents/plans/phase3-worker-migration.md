# Phase 3 Plan — Move sql.js and sync apply to a Web Worker

## Goal

Make the browser UI responsive for large workspaces by moving all heavy SQLite work (mutations, queries, sync apply) off the main thread into a dedicated Web Worker. The worker becomes the sole owner of the sql.js `Database`; the main thread communicates with it exclusively through the async `IWorkspaceStoreClient` interface.

## Current state

- `frontend/src/core/worker/workspaceWorker.ts` owns a `WorkspaceStore` inside the worker and handles `init`, `export`, `mutate`, `query`, `close`.
- `frontend/src/core/worker/WorkspaceStoreClient.ts` provides:
  - `WorkerStoreClient` for real browsers.
  - `InlineStoreClient` for jsdom/tests that shares a synchronous `WorkspaceStore`.
- `frontend/src/core/worker/workerProtocol.ts` defines messages and the `IWorkspaceStoreClient` interface.
- Some hooks/adapters are already migrated to `useWorkspaceStoreClient` (`useNode`, `useChildren`, `useSetProperty`, `useUnsetProperty`, node CRUD adapters, `useNodeChildrenAdapter`).
- `WorkspaceStoreInitializer` still opens a synchronous store via `getOrCreateWorkspaceStore` and runs sync apply on the main thread.
- Legacy callers still use `useWorkspaceStore` / the synchronous `WorkspaceStore` registry.
- Migrated callers in a real browser currently see a separate worker database; the migration is intentionally "big bang" in the browser (all callers must move before it works there).

## Target architecture

- The worker is the only place `WorkspaceStore` methods are invoked.
- Main-thread code calls `client.mutate(method, args)` and `client.query(method, args)`.
- Special query helpers (`queryNodes`, `executeQuery`, `projectNode`, plus new ones) live in the worker and are reached by name.
- Sync applies operations in the worker; the main-thread `SyncEngine` handles transport and progress callbacks.
- Persistence stays on the main thread: the worker exports the database on request and the main thread writes it to IndexedDB.

## Global constraints

- Keep `npm run lint` and `npx tsc -b --noEmit` clean (no new errors; pre-existing warnings are OK).
- Keep `npm run test:run` green.
- Preserve existing hook/adapter public signatures so callers do not change.
- Every new worker query helper must also be handled in `InlineStoreClient.query` so the jsdom test shim keeps sharing the same synchronous store.
- Do not disable the Web Worker path; the migration stays "big bang" in the browser.

## Task 1 — Migrate remaining core hooks/adapters

Files to update:

- `frontend/src/core/hooks/useClasses.ts`
  - Switch to `useWorkspaceStoreClient`.
  - Query with `client.query('queryNodes', [{ isClass: true, projectionDepth: 0 }])`.
- `frontend/src/core/hooks/useProperties.ts`
  - Add worker helper `getNodeProperties(nodeId)` that returns `Record<string, unknown[]>`.
  - Switch to `useWorkspaceStoreClient` and query that helper.
- `frontend/src/core/hooks/usePropertySchemas.ts`
  - Add worker helper `getPropertySchemas()` that returns `Property[]`.
  - Switch to `useWorkspaceStoreClient` and query that helper.
- `frontend/src/core/adapters/usePropertiesAdapter.ts`
  - Migrate to `useWorkspaceStoreClient` / `client.query`.
- `frontend/src/core/adapters/useClassPropertiesAdapter.ts`
  - Migrate to `useWorkspaceStoreClient` / `client.query`.

For each helper added to the worker, also handle it in `InlineStoreClient.query`.

## Task 2 — Replace `updateText` callback mutation

- `updateText` currently takes a callback `(text) => { ... }`.
- Callbacks are not structured-clonable and cannot cross the worker boundary.
- Add serializable operations to `WorkspaceStore` (e.g. `setNodeText(nodeId, plainText)`, `deleteTextRange`, `insertText`) and expose them as worker mutations.
- Update `useCreateNodeAdapter` and any other callers that currently pass an `updateText` callback.

## Task 3 — Migrate UndoManager to the worker

- `frontend/src/core/undo/UndoManager.ts` currently takes a synchronous `WorkspaceStore`.
- Move it into the workspace Web Worker so it operates on the worker-owned store.
- Each worker instance holds one `UndoManager` alongside its `WorkspaceStore`.
- The main thread uses a thin async facade (`UndoManagerClient` / `useUndoManager`) that forwards record/undo/redo operations through `IWorkspaceStoreClient.mutate`/`query`.
- Add serializable recording methods (e.g. `recordSetNodeText`) for paths that cross the worker boundary.
- Update callers (`undoStore.ts`, `workspaceStoreAdapter.ts`, hooks, tests) to `await` the async facade.

## Task 4 — Migrate SyncEngine apply to the worker

Goal: keep transport/network orchestration on the main thread, but move all heavy SQLite work (restore snapshot, apply operation envelopes, export snapshot, watermark reads/writes, operation-log queries) into the worker.

Implementation approach:

1. Add worker mutation/query helpers (real worker in `workspaceWorker.ts` and inline shim in `WorkspaceStoreClient.ts`):
   - `applyMany(ops)` → applies operations and returns count.
   - `startBatch()` / `endBatch()` → batch notification boundaries.
   - `restoreSnapshot(data)` → restores a server snapshot into the worker DB.
   - `exportSnapshot(hlc)` → returns `{ hlc: Hlc, data: Uint8Array }` from the worker DB.
   - `clearOperationLog()` → clears the local operation log.
   - `resetDerivedState()` → resets derived tables.
   - `isDerivedStateStale()` → boolean.
   - `loadWatermarks()` → `{ received: Hlc, pushed: Hlc, restoreEpoch: number }`.
   - `saveWatermark(kind, hlc)` → void.
   - `saveRestoreEpoch(epoch)` → void.
   - `queryOperationLog(afterHlc, limit)` → `OperationRow[]` (the rows SyncEngine.push reads).
   - `getWorkspaceId()` / `getActorId()` if still needed.

2. Refactor `frontend/src/core/sync.ts`:
   - Change constructor to accept `IWorkspaceStoreClient` instead of `WorkspaceStore`.
   - Make all store-touching methods async and call the worker helpers above.
   - Remove all direct `this.store.getDb()` SQLite access; use worker queries/mutations instead.
   - Keep transport usage, callbacks, and progress reporting on the main thread.
   - Remove `yieldToMain` chunking inside `pull()` (the worker can apply in one go without blocking the UI).

3. Update `frontend/src/core/adapters/workspaceStoreAdapter.ts`:
   - Create/return an `IWorkspaceStoreClient` via `getOrCreateWorkspaceStoreClient`.
   - Create `SyncEngine` with the client instead of the sync store.
   - Remove the synchronous store registry or keep it only for test callers.
   - Persist the DB via `client.export()` + IndexedDB after sync completes.

4. Update tests:
   - `frontend/src/core/__tests__/sync.test.ts` and `frontend/src/core/__tests__/stress/sync.stress.test.ts` must create an inline `IWorkspaceStoreClient` from the test `WorkspaceStore` and pass it to `SyncEngine`.
   - The inline test client already exists in `WorkspaceStoreClient.ts` via `createWorkspaceStoreClient()` in jsdom, but tests that use a specific store should initialize it with `{ store }`.

5. Verify: type-check, lint, and the sync-related tests pass.

## Task 5 — Persistence and lifecycle

- `WorkspaceStoreInitializer` should use `getOrCreateWorkspaceStoreClient` instead of `getOrCreateWorkspaceStore`.
- Remove the synchronous store registry or mark it test-only.
- IndexedDB save should happen after worker init and after sync completes, using `client.export()`.
- On workspace close / actor change, close the worker client and delete persisted DB when needed.

## Task 6 — Cleanup and verification

- Remove remaining direct `WorkspaceStore` imports from production UI code.
- Update `frontend/src/core/index.ts` exports if needed.
- Run `npm run lint`, `npx tsc -b --noEmit`, `npm run test:run`.
- Manual browser test with a workspace large enough to have previously frozen.

## Interface contract

`IWorkspaceStoreClient` methods:

- `init(workspaceId, actorId, options?)`
- `export(): Promise<Uint8Array>`
- `mutate<T>(method, args): Promise<T>`
- `query<T>(method, args): Promise<T>`
- `subscribe(nodeId | null, callback): () => void`
- `close(): void`

Worker-supported query/mutation names (extend as needed):

- Existing: `getNode`, `getChildren`, `queryNodes`, `executeQuery`, `projectNode`, `createNode`, `updateNode`, `deleteNode`, `moveNode`, etc.
- New: `getNodeProperties`, `getPropertySchemas`, `setNodeText`, `applyMany`, `syncPull`, `syncInitialize`, `forceResync`.

## Verification

- `cd frontend && npx tsc -b --noEmit` passes.
- `cd frontend && npm run lint` passes (no new errors).
- `cd frontend && npm run test:run` passes all tests.
- Browser smoke test: open a workspace, create/edit/delete nodes, switch workspaces, reload — no freeze, no infinite "Loading notees".

## Risks

- Large API surface still using synchronous `WorkspaceStore`; missed callers will break in the browser once the worker becomes primary.
- `updateText` callback replacement changes text editing behavior if not carefully mapped.
- UndoManager async rewrite can introduce race conditions with rapid undo/redo.
- SyncEngine split across threads adds message-passing complexity; tests with the inline shim may not catch worker-only serialization bugs.
