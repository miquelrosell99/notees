# Plan: Task status badges + block property display fixes

Status: implemented and verified (tsc clean, lint 0 errors, 411/411 frontend tests pass).

## Reported issues

1. "Done" badge missing on done tasks in list view (pending badge showed); Ctrl+Enter
   status cycling appeared not to persist (node `019f4bee-a144-761f-8bea-3d83ba045740`
   had `is_task=false`, no `class_ids`, no properties in the DB).
2. Properties with values but no `icon_visibility` were not shown anywhere for blocks —
   no properties section in list-view rows or in focused block view (only pages in
   page view had one).

## Root causes

1. Task status never written:
   - `useProperties()` cached under `propertyKeys.list()` while the imperative
     resolvers (`resolveTaskStatus`, `resolveTaskStatusIds`) read
     `propertyKeys.lists()` — different hashes, so resolvers always returned
     undefined and `applyTaskStatus` silently no-oped.
   - `useTaskActions.cycleTaskStatus` decided the next state from `[node]`-memoized
     values; BlockRow doesn't subscribe to the runtime, so a mounted editor re-ran
     `openTask` on stale data.
   - `useSetNodeProperty.onSettled` didn't invalidate view query results, so list
     views never learned about new statuses.
   - The dev workspace outbox was poisoned: a permanently 409-ing op (ghost node
     `019f4c1b-559e-7e68-9440-7f06bbec0c3d`) was requeued with no attempt cap,
     blocking the whole outbox so `add_class`/`remove_class` ops never persisted.
2. `NodeView.tsx` rendered `<PropertiesSection>` only inside the
   `resolvedType === 'page'` branch; list-view `BlockRow` only rendered property
   icons for `icon_visibility` after_bullet/before_content.

## Changes (frontend only)

- `features/properties/hooks/usePropertyQueries.ts` — cache under
  `propertyKeys.lists()` (key the imperative readers use).
- `features/tasks/hooks/useTaskActions.ts` — `cycleTaskStatus` reads live runtime
  state at call time (`getOperationRuntime()`/`getNode(...).taskStatus`).
- `features/properties/hooks/useSetNodeProperty.ts` — `onSettled` also invalidates
  `nodeViewKeys.queryResults()`.
- `features/sync/SyncManagerV2.tsx` — 409 requeue path respects `MAX_RETRIES`;
  exhausted ops are failed and removed from the outbox instead of blocking it
  forever.
- `features/content/pages/NodeView.tsx` — properties + recurrence sections render
  for focused blocks too, not only pages.
- `features/properties/components/PropertiesSection.tsx` — new `onlyWithValues`
  prop filtering rows to properties present in `node.properties_uuid`.
- `features/content/components/blocks/BlockRow.tsx` (+`.css`) — inline read-only
  `PropertiesSection` (`onlyWithValues`, no hidden section, no add button) in
  list-view rows.

## Tests

- New: `useTaskActions.test.ts`, `usePropertyQueries.test.ts`,
  `SyncManagerV2.test.tsx` (409 cap), `PropertiesSection.test.tsx` (onlyWithValues).
- Updated mocks in `BlockRow.test.tsx` / `BlockList.focused.test.tsx` for the new
  `PropertiesSection` usage.

## User verification

In the browser (Vite dev server on :5173): Ctrl+Enter on a task in list view cycles
Pending → Done, the Done badge shows and survives reload; blocks with valued
properties show an inline properties section in list view and focused block view.
Note: the poisoned outbox entry for ghost node `019f4c1b-…` will be dropped after
its remaining retries with the new cap (worst case: clear site data).
