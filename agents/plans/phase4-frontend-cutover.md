# Phase 4: Frontend Cut-Over to Local-First SQLite Core

**Date:** 2026-07-18  
**Status:** Implementation plan — pending execution  
**Depends on:** Phase 3 (QueryAST retarget to SQLite) complete  
**Leads to:** Phase 5 (server relay hardening)

---

## Goal

Replace the authoritative TanStack Query / PostgreSQL data layer in the real Notees frontend with the local-first SQLite core (`frontend/src/core/`). At the end of Phase 4 the app must be able to:

1. Open a workspace database in the browser (sql.js in memory for the prototype slice; OPFS adapter is Phase 4 stretch goal).
2. Read and write nodes, child order, properties, and QueryAST collections through React hooks that talk to SQLite.
3. Persist pending operations locally across reloads (IndexedDB) and sync them through the encrypted relay when online.
4. Render existing UI components against the new store without a full component rewrite, using adapter hooks.
5. Stay offline-functional: create/edit nodes while offline, then converge after reconnect.

---

## What already exists (Phase 1–3)

- `frontend/src/core/store.ts` — `WorkspaceStore` class with `createNode`, `updateText`, `moveNode`, `deleteNode`, `setProperty`, `unsetProperty`, plus getters.
- `frontend/src/core/sync.ts` — `SyncEngine` with encrypted push/pull over a pluggable `Transport`.
- `frontend/src/core/db/schema.ts` — derived tables: `operation`, `node`, `node_child_order`, `property_value`, `edge`, `crdt_state`, `search_index`, `class_hierarchy`, `snapshot`, `sync_watermark`.
- `frontend/src/core/query/compileToSqlite.ts` — QueryAST → SQLite SQL compiler.
- `frontend/src/core/transport.ts` — `MemoryTransport` / `MemoryRelay` for tests.
- `frontend/src/core/crypto.ts` — `encryptEnvelope` / `decryptEnvelope` with AES-GCM.
- Tests for store, sync, and query compiler.

What is missing:
- React hooks that expose SQLite state reactively.
- Integration with the existing workspace/auth flow.
- A bridge between old feature hooks (`useNode`, `useNodes`, `useQueryAst`, etc.) and the new core.
- IndexedDB persistence for the SQLite database file and pending operations.
- Service-worker offline strategy aligned with local-first state.
- Mounting the relay router on the backend and a seed script for existing workspaces.

---

## Design decisions already taken

1. **SQLite is the primary runtime store.** TanStack Query becomes a secondary cache/loading state helper only during the transition.
2. **Operations are fine-grained at the block level.** Block insert/move/delete are operations; inline text edits go through a text CRDT (Yjs).
3. **Classes are nodes.** `kind = 'class'` nodes live alongside `page` and `block` nodes. `class_hierarchy` is derived from `class.create` / `class.update` operations.
4. **Properties are selected, not written.** Property schemas are nodes or separate records (already resolved: property schemas live as derived rows referenced by UUID; the UI presents them as a selectable catalog).
5. **UUIDv7 everywhere.** No integer IDs in the new core.
6. **Workspace-scoped SQLite databases.** One database per workspace.
7. **`node.delete` maps to a hard delete in the operation log** for this phase. Trash/archive behavior is a future enhancement; we will not preserve the old soft-delete semantics unless the user explicitly asks.
8. **Feature flag gating:** introduce `VITE_ENABLE_SQLITE_STORE`. When off, the legacy TanStack Query stack continues to run. When on, the adapter hooks route to SQLite. This lets us merge Phase 4 incrementally.

---

## Sub-Task Breakdown

### D1 — Core hooks, workspace store adapter, and IndexedDB persistence ✅ Done

**Status:** Committed as `feat(core,frontend): Phase 4 D1 core hooks, store adapter, and IndexedDB persistence` (`8a74fe71`).

**Goal:** Provide a single source of truth React layer on top of `WorkspaceStore`.

**Files to create:**
- `frontend/src/core/hooks/useWorkspaceStore.ts` — returns the active `WorkspaceStore` instance for the current workspace, creating/opening the SQLite database on demand.
- `frontend/src/core/hooks/useNode.ts` — reactive node read hook. Subscribes to SQLite `node` row for an id and returns `{ node, isLoading, error }`.
- `frontend/src/core/hooks/useNodes.ts` — batch read hook for a list of ids.
- `frontend/src/core/hooks/useChildren.ts` — reactive child-order hook for a parent id.
- `frontend/src/core/hooks/useCreateNode.ts`, `useUpdateText.ts`, `useMoveNode.ts`, `useDeleteNode.ts` — mutation hooks that call `WorkspaceStore` methods.
- `frontend/src/core/hooks/useSync.ts` — returns sync status, manual sync trigger, and last error.
- `frontend/src/core/hooks/index.ts` — barrel.
- `frontend/src/core/persistence/indexedDb.ts` — save/load SQLite `Uint8Array` to IndexedDB (`notees:workspace:<id>`).
- `frontend/src/core/persistence/operationQueue.ts` — durable queue of operations not yet confirmed by relay (used for optimistic offline support).
- `frontend/src/core/adapters/workspaceStoreAdapter.ts` — singleton registry mapping workspace id → `{ store, syncEngine, key }`.

**Files to modify:**
- `frontend/src/core/index.ts` — export new hooks and persistence helpers.
- `frontend/src/core/store.ts` — add `getOrCreateNode`, `upsertNode`, idempotent `apply`, and `onChange` listener registration for reactive hooks.
- `frontend/src/core/sync.ts` — add `syncOnce()`, `startAutoSync(intervalMs)`, `stopAutoSync()`, and event callbacks (`onOperationsPushed`, `onOperationsPulled`).
- `frontend/src/core/db/connection.ts` — ensure `openWorkspaceDatabase` can load from an IndexedDB-backed byte array.

**Verification:**
- New unit tests in `frontend/src/core/hooks/__tests__/` covering:
  - creating a node updates `useNode` subscribers.
  - moving a node updates `useChildren` subscribers for both old and new parents.
  - IndexedDB round-trip preserves database state.
  - sync engine pushes pending operations and pulls remote ones.
- `cd frontend && npm run test:run src/core/hooks && npx tsc -b --noEmit` passes.

**Results:**
- `npm run test:run src/core` → 9 files, 27 tests passed.
- `npx tsc -b --noEmit` → clean.
- `npm run lint` → clean (only pre-existing unrelated warnings).
- Backend `uv run pytest tests/core -m unit --no-cov` → 153 passed, 3 skipped.
- `uv run ruff check app/core frontend/src/core scripts/validate_migration.py` → clean.

---

### D2 — Node read/write bridge for content and editor features ✅ Done

**Status:** Committed as `feat(core,frontend): Phase 4 D2 node read/write bridge and editor content adapter` (`06626a6d`).

**Goal:** Make the existing content/editor UI work against the new core without rewriting components.

**Files to create:**
- `frontend/src/core/adapters/useNodeAdapter.ts` — drop-in replacement for legacy `useNode` data shape (`{ uuid, title, content, ... }`).
- `frontend/src/core/adapters/useNodesAdapter.ts` — drop-in replacement for legacy `useNodes`.
- `frontend/src/core/adapters/useNodeChildrenAdapter.ts` — maps `node_child_order` to the legacy child list shape.
- `frontend/src/core/adapters/useNodeMutationsAdapter.ts` — maps legacy `createNode`, `updateNode`, `deleteNode` mutations to `WorkspaceStore` operations.
- `frontend/src/core/adapters/useInlineEditorAdapter.ts` — bridges the custom inline editor to `WorkspaceStore.updateText`, handling popup keepalive invariant from `agents/frontend.md`.

**Files to modify:**
- `frontend/src/features/content/hooks/useNode.ts` (and related hooks) — when `VITE_ENABLE_SQLITE_STORE` is true, delegate to adapter hooks.
- `frontend/src/features/content/hooks/useNodes.ts` — same pattern.
- `frontend/src/features/editor/hooks/useEditor.ts` / `useSaveContent.ts` — same pattern.
- `frontend/src/features/content/components/nodes/NodeCollection.tsx` (only if required for wiring) — otherwise leave the existing unstaged modifications untouched.

**Open decisions for D2 subagent:**
- Determine whether to gate the adapter behind `featureFlagStore` or the env var.
- Confirm the legacy `Node` TypeScript shape so the adapter can return a compatible object.
- Decide whether `deleteNode` should archive first. **Decision:** hard delete for Phase 4; trash UI will be addressed later.

**Verification:**
- Unit tests for each adapter hook.
- TypeScript compilation clean.
- Manual smoke test: open a workspace, navigate to a page, edit text, see reactive update.

**Results:**
- `npm run test:run src/core/adapters` → 8 passed.
- `npx tsc -b --noEmit` → clean.
- `npm run lint` → clean (only pre-existing warnings).
- `npm run test:run src/core` → 35 passed.
- `npm run test:run src/features/content/hooks src/features/editor/hooks` → 24 passed.

---

### D3 — Properties, views, and QueryAST bridge ✅ Done

**Status:** Committed as `feat(core,frontend): Phase 4 D3 property and QueryAST bridge` (`c2fe306f`).

**Goal:** Property panels, views, and QueryAST collections read from SQLite.

**Files to create:**
- `frontend/src/core/hooks/useProperty.ts` — reactive read of a property value.
- `frontend/src/core/hooks/useProperties.ts` — reactive read of all properties for a node.
- `frontend/src/core/hooks/usePropertySchemas.ts` — returns selectable property schemas from the derived schema table.
- `frontend/src/core/hooks/useQueryAst.ts` — runs QueryAST against SQLite and returns results reactively.
- `frontend/src/core/adapters/usePropertyAdapter.ts` — legacy property hook shape.
- `frontend/src/core/adapters/useQueryAstAdapter.ts` — legacy QueryAST hook shape.

**Files to modify:**
- `frontend/src/features/properties/hooks/` — delegate to adapters when feature flag is on.
- `frontend/src/features/queries/hooks/useQueryAst.ts` — delegate to adapters.
- `frontend/src/views/` top-level views — verify they receive compatible data shapes.

**Verification:**
- `frontend/src/core/query/__tests__` expanded with hook-level tests.
- `cd frontend && npm run test:run src/core && npx tsc -b --noEmit` passes.
- Manual smoke test: open a page with properties, edit a property, open a QueryAST collection view.

**Results:**
- `npm run test:run src/core/hooks src/core/adapters` → 23 passed.
- `npx tsc -b --noEmit` → clean.
- `npm run lint` → clean (only pre-existing warnings).
- `npm run test:run src/core` → 46 passed.
- `npm run test:run src/features/properties/hooks src/features/views` → 14 passed.

---

### D4 — Service worker/PWA offline, relay router mount, backend seed script

**Goal:** Offline works end-to-end; backend relay is wired; existing workspaces can be seeded.

**Files to create:**
- `frontend/src/core/serviceWorker/offlineStrategy.ts` — instructs the service worker to serve the SPA shell and let the local SQLite store own data.
- `frontend/src/core/serviceWorker/syncOnVisibility.ts` — triggers `SyncEngine.sync()` on `visibilitychange` / online events.
- `app/relay/router.py` — FastAPI router mounting the relay HTTP/WebSocket endpoints (if not already present from Phase 1).
- `app/relay/permissions.py` — workspace/node-level authorization checks against existing `app/features/shares/` and auth.
- `app/relay/storage.py` — SQLite relay operation log storage (if not already present).
- `scripts/seed_relay_from_postgres.py` — one-time script that runs the Phase 2 migration for all workspaces and writes encrypted operation batches to the relay database.

**Files to modify:**
- `app/main.py` — mount `app/relay/router.py` under `/api/relay`.
- `frontend/vite.config.ts` / `frontend/public/sw.js` — update service worker to cache the app shell and not intercept API calls.
- `frontend/src/App.tsx` — initialize `WorkspaceStoreAdapter` and sync engine per active workspace.
- `compose.dev.yaml` — ensure relay endpoints are reachable from the frontend dev proxy.

**Verification:**
- `uv run pytest tests/relay -m unit --no-cov` passes (new + existing).
- `uv run ruff check app/relay scripts/seed_relay_from_postgres.py` clean.
- `cd frontend && npm run test:run src/core/serviceWorker` passes.
- Manual offline smoke test: create a node offline, reconnect, verify convergence via the relay.

---

## Integration and Cut-Over Flow

1. On `App.tsx` mount, detect active workspace from `useWorkspaces()`.
2. `useWorkspaceStore(workspaceId)` opens/creates SQLite DB, loads from IndexedDB if present, otherwise fetches a seed snapshot from `/api/relay/catch-up`.
3. UI hooks read from SQLite reactively; mutations write operations to SQLite.
4. `SyncEngine` auto-syncs on a cadence and on network recovery.
5. When the feature flag is off, every adapter falls back to legacy TanStack Query behavior.

---

## Snapshot Commit Policy for Phase 4

Commit after each sub-task D1–D4:
- `feat(core,frontend): Phase 4 D1 core hooks and IndexedDB persistence`
- `feat(core,frontend): Phase 4 D2 node read/write bridge`
- `feat(core,frontend): Phase 4 D3 property and QueryAST bridge`
- `feat(relay,frontend): Phase 4 D4 offline sync and relay integration`

A final Phase 4 milestone commit:
- `feat(core,relay,frontend): Phase 4 frontend cut-over complete`

---

## Open Questions to Resolve During Implementation

1. Exact legacy `Node` and `PropertyValue` TypeScript shapes for adapters.
2. Whether `frontend/src/features/sync/local/localNodeStore.ts` can be retired or must coexist during the transition.
3. Whether IndexedDB persistence should store the full SQLite file or only pending operations for the prototype slice.
4. Whether the relay should serve catch-up as a single snapshot or paginated operations.
5. Exact PWA/service-worker build pipeline: is `sw.js` generated by the PWA Vite plugin or hand-written?

---

## Verification Gate for Phase 4

Before declaring Phase 4 complete, run:

```bash
# Backend
uv run pytest tests/core tests/relay -m unit --no-cov
uv run ruff check app/core app/relay frontend/src/core scripts/seed_relay_from_postgres.py
uv run python scripts/validate_migration.py

# Frontend
cd frontend
npm run test:run src/core
npx tsc -b --noEmit
npm run lint

# Manual
# 1. Open app with VITE_ENABLE_SQLITE_STORE=true.
# 2. Navigate workspace, create/edit/move/delete nodes.
# 3. Edit properties and open a QueryAST collection.
# 4. Go offline, make changes, reconnect, verify convergence in second tab.
```

All gates must pass before moving to Phase 5.
