# Plan: Fix block-editing instability (lag, lost content, slow Enter, stale class pills)

Date: 2026-09-01. Status: implemented, unit-verified.

## Root causes

1. **Class pill stale until reload** — `GetNodeTreeQuery.shouldInvalidate` ignored
   `scope: 'class'` / `'property'` notifications (they carry the block id, not the root).
2. **Content disappears** — (a) concurrent fire-and-forget `saveBlock` calls per block landed
   out of order and `recordSetNodeText` is a full-text SET (last writer wins); (b) `BlockRow`
   read content from the tree projection, which `scope: 'node'` text saves never invalidate, so
   remounted editors initialized from stale text and overwrote flushed content; (c) blur→refocus
   could mount the editor before the blur flush landed.
3. **Typing lag** — every save did a main-thread `getTextState` + full Yjs deserialize, and
   `store.setNodeText` rewrote the whole document per save.
4. **Slow Enter** — `BlockList.handleEnter` awaited flushAll + getChildren + getNode round-trips
   before `createBlock`, then a full subtree re-query + re-projection rendered the row.

## Fixes (all behind tests that failed before, pass after)

- `core/store.ts`: diff-based `setNodeText` (common prefix/suffix), no-op when unchanged.
- `core/undo/UndoManager.ts`: skip no-op undo entries.
- `features/editor/hooks/useContentSave.ts`: per-block save queue; `flushAll` awaits in-flight
  saves; dropped main-thread echo-check; save errors logged.
- `features/content/components/blocks/BlockRow.tsx`: content read from live `useNode` row
  (`coreNode`) with projection fallback; `handleFocusStatic` awaits flush before focusing.
- `core/graphQueries/queries/GetNodeTreeQuery.ts`: invalidate on `class`/`property` scopes.
- `features/content/components/blocks/BlockList.tsx`: Enter resolves parent/children from the
  projected `flatNodes`; flush only kept for the split branch.

## Verification

- New/extended tests: `GetNodeTreeQuery.test.ts`, `workspaceStore.test.ts`, `useContentSave.test.ts`
  (red on HEAD, green after fix). Two `BlockRow.test.tsx` click tests updated to await the now-async
  editor mount.
- Full frontend suite: 176 files / 1144 tests green; `tsc -b --noEmit` and ESLint clean (in container).
- Dev stack serves the changes via bind mount; no rebuild category hit (no routes/schemas/sync
  mappers/build output). Browser feel-check (typing smoothness, Enter latency) left to the user.

## Residual risk

- Sub-RTT window remains: refocus within the one `getNode` round-trip after a flush completes can
  still mount the editor on the pre-notification `coreNode`. Requires click+type inside ~ms;
  previously the window was unbounded. Not closed to keep focus latency at zero.
- Records: `skills/notees/references/gotchas.md` ([editor] save serialization, [query] class/property
  invalidation) + `gotchas/index.md` entries.
