# Plan: Runtime / Sync Boundary Rewrite

## Status

**Complete.** All phases are finished. The `NodeGraphRuntime` facade has been removed and the frontend now follows the three-layer data-flow model.

## Approved architecture

```
Backend API ←→ TanStack Query (server state) ←→ SyncManager (adapter) ←→ OperationRuntime (derived state) ←→ React UI
```

- **OperationRuntime** is pure: no React, no API calls. It holds base server state + local operations and computes projection.
- **SyncManager** is the only React layer that calls API mutations. It observes OperationRuntime and dispatches operations through `useMutation` hooks.
- All cache writes go through `cacheWriter`, which wraps targeted cache updates.

## Completed work

### Phase 0 — Foundation

- `frontend/src/runtime/operation.ts` — Operation types and state machine.
- `frontend/src/runtime/operationReducer.ts` — Pure reducer applying operations to a graph.
- `frontend/src/runtime/OperationRuntime.ts` — Pure derived-state engine.
- `frontend/src/runtime/runtimeInstance.ts` — Global singleton + test replacement helper.
- `frontend/src/runtime/index.ts` — Public runtime API.
- `frontend/src/sync/cacheWriter.ts` — Targeted TanStack Query cache writes.
- Tests: `src/runtime/operationReducer.test.ts`, `src/runtime/OperationRuntime.test.ts`, `src/tests/sync/cacheWriter.test.ts`.

### Phase 1 — Sync adapter

- `frontend/src/sync/mutationMap.ts` — Operation → API request + cache update mapping.
- `frontend/src/sync/SyncManager.tsx` — Root component that consumes runtime operations and dispatches mutations.
- `frontend/src/sync/intents.ts` — Canonical adapter from `MutationIntent` to `Operation` values (now includes structural intents).
- `frontend/src/sync/index.ts` — Public sync API.
- `frontend/src/hooks/useOperationRuntime.ts` — React subscription hook.
- Tests: `src/tests/sync/mutationMap.test.ts`, `src/tests/sync/SyncManager.test.tsx`, `src/tests/sync/intents.test.ts`.

### Phase 2 — Runtime projection integration

- `frontend/src/runtime/NodeGraphRuntime.ts` was rewritten as a thin facade over `OperationRuntime` while persistence moved to `SyncManager`.

### Phase 3 — InlineEditor stability

- `InlineEditor.tsx` keeps a stable Lexical instance and updates imperatively via `SyncedContentPlugin`.

### Phase 4 — Bridge hook replacement

- `useContentSave`, `useBlockPersist`, `useStructureSync`, and `useOfflineQueue` responsibilities moved to operations + SyncManager.

### Phase 5 — Facade removal

- `frontend/src/runtime/graphHelpers.ts` — Pure graph traversal helpers (`getNode`, `getChildren`, `getSiblings`, `getDescendants`, etc.).
- `frontend/src/runtime/eventBus.ts` — Typed `RuntimeEvent` layer over `OperationRuntime` with `subscribe`, `subscribeToBlock`, `flushEvents`, and source-tagged mutation wrappers (`loadNodes`, `upsertNodes`, `removeNodes`, `applyRuntimeIntent`).
- `frontend/src/runtime/serverIdMap.ts` — Bidirectional blockId ↔ serverId mapping.
- `frontend/src/stores/editorFocusStore.ts` — Extended with `pendingFocusOffset`.
- `frontend/src/stores/undoEngine.ts` — Undo/redo stack and reverse-intent computation using the intent engine and event bus.
- All callers (hooks, components, editor plugins, drag coordinator) migrated off `getNodeGraphRuntime()`.
- `frontend/src/runtime/NodeGraphRuntime.ts` deleted.

## Verification

- `npx vitest run` — 168 tests passing.
- `npx tsc -b --noEmit` — clean.
- `npm run lint` — clean.
- `ruff check app/` — clean.

## Follow-up

- Monitor for editor echo regressions where `sourceEditorId` filtering depended on exact NodeGraphRuntime coalescing behavior.
- Add unit tests for `eventBus.ts` snapshot diffing and `serverIdMap.ts` edge cases.
- Update `AGENTS.md` to document the new runtime boundary.
