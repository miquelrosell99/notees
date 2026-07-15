# Tasks Top-Bar Popup — Design

**Date:** 2026-07-15
**Status:** Approved (design Q&A in session; user approved with "implement")
**Supersedes:** the full-page Tasks view introduced by `2026-07-15-tasks-sidebar-entry-design.md` (popup replaces it)

## Summary

Replace the full-page Tasks view (`/tasks`) with a lightweight, Google-Tasks-style
dropdown in the top bar: a circle-checkbox list of Overdue / Today / Upcoming /
Completed-today tasks, with quick-add. The task class page remains the power
surface for bulk management, kanban-by-status, and the other four statuses.

## Decisions (from design Q&A)

1. **Route fate:** `/tasks` route, `TasksView`, and its tab machinery are deleted.
   The sidebar rail Tasks button and the command-palette "Open Tasks" entry open
   the popup instead of navigating.
2. **Circle logic:** Only tasks with status **Pending** or **Doing** appear as
   open circles. Backlog / Reviewing never appear in the popup; Done/Cancelled
   are not open items. Check → `Done`; uncheck (in Completed section) → `Pending`.
3. **Sections:** Overdue / Today / Upcoming (next 7 days) / **Completed today**
   (struck through, so check-offs feel rewarding and misclicks are undoable).
4. **Quick-add:** One-line input at the top; Enter creates a task block on
   today's daily journal page, scheduled today, status Pending.
5. **Trigger badge:** Top-bar icon shows a badge with the overdue + today
   open-task count, visible without opening the popup.
6. **Container:** Top-bar dropdown mirroring the existing `CalendarPopup`
   pattern (open state in the navigation store, dropdown `Card`, shared toggle
   for all entry points). Not a sidebar panel, not a center modal.

## Architecture

- **Open state:** `isTasksPopupOpen` / `toggleTasksPopup` / `setTasksPopupOpen`
  in the modal store (`stores/modalStore.ts`), mirroring the calendar popup
  state (`isCalendarOpen` / `toggleCalendar`).
- **Trigger:** icon `Button` in `TopBar` next to the calendar button, with a
  `ButtonBadge` count = overdue + today open tasks (Pending/Doing).
- **Entry points:** rail Tasks button → `toggleTasksPopup()`; palette
  "Open Tasks" → same toggle (single palette entry, dedup preserved).
- **Deletion surface:** `TasksView.tsx`, its render branch + import in
  `MainContentPane.tsx`, the `'tasks'` entries in the URL adapter maps
  (`layout/hooks/url.ts`), the `view.tasks` palette command
  (`navigationCommands.ts`, rerouted to the popup toggle), `'tasks'` in the
  `MainViewType` union / `VIEW_LABELS` / `useDocumentTitle`, tab logic in
  `useTasks.ts` (query-AST pieces the popup reuses are kept/refactored), the
  rail button's `setMainViewType('tasks')` onClick, README/docs mentions. The
  `showGroupBy` prop added to `TasksView` in the group-by fix goes away with
  the view; the underlying `NodeCollection` group-by fix is unaffected.

## Components (new, `frontend/src/features/tasks/`)

- `TasksPopup.tsx` — dropdown `Card` anchored to the top-bar icon
  (CalendarPopup positioning). Quick-add input on top, then the four sections.
- `TasksPopupSection.tsx` — titled section with a list of rows; "Overdue" title
  in error color; empty sections hidden.
- `TaskPopupRow.tsx` — circle checkbox + title (+ small page name; date chip on
  upcoming rows). Click title → navigate to the block; popup closes.

## Data flow

- One `useTasksPopupData()` hook, four queries through the existing
  query-execute endpoint with `include_properties: true` (status data arrives
  via the include-properties fix from the badge bug). The existing AST builders
  in `utils/taskQueries.ts` only exclude Done/Cancelled
  (`notCompletedConditions()`), so the popup's queries add an explicit
  `not_equals {Backlog, Reviewing}` filter to show only Pending/Doing:
  - **Overdue:** status ∈ {Pending, Doing} ∧ scheduled < today, ordered by date asc.
  - **Today:** status ∈ {Pending, Doing} ∧ scheduled = today.
  - **Upcoming:** status ∈ {Pending, Doing} ∧ scheduled ∈ (today, today+7d],
    ordered by date asc, capped ~20 rows.
  - **Completed today:** status = Done ∧ `task_closed_date` = today, ordered by
    closed desc, capped ~10 rows (backend sets `task_closed_date` automatically
    on entering/leaving a closed status — `app/features/tasks/service.py`).
- **Badge count:** derived from the same cached queries' `total_count`
  (overdue + today) — no extra requests; queries run regardless of popup
  openness so the badge is always fresh.
- **Check/uncheck:** status writes go through the same mutation path as
  `useTaskActions` (`useSetNodeProperty` + `resolveTaskStatusIds`), with the
  optimistic runtime `taskStatus` update so block badges react instantly;
  `useSetNodeProperty.onSettled` invalidates query results for server truth.
  `useTaskActions` currently keeps `applyTaskStatus` internal — a small
  exported hook (e.g. `useSetTaskStatus(nodeUuid)`) shares the logic.
- **Quick-add:** Enter → `nodesApi.getOrCreateDaily(today)` →
  `useCreateNode({ name, parent_uuid: journalUuid, class_uuids: [taskClass] })`
  (Status=Pending comes from backend class-property defaults) → set
  `task_scheduled` = today's day UUID (`dateToDayUuid`); the new row appears in
  the Today section.
- **Row click:** `openNode(uuid)` (forces `mainViewType: 'node'`) → popup
  closes (CalendarPopup wrapper idiom).

## Error handling

- Section query failure → inline error + retry inside the popup (DataStateView
  pattern).
- Check/uncheck failure → `onSettled` refetch corrects optimistic state +
  error toast.
- Quick-add failure → error toast; input content preserved.
- Popup closes on outside click / navigation (CalendarPopup precedent) and on
  Esc — the tasks popup adds its own `keydown` handler while open
  (CalendarPopup itself lacks Esc handling).

## Recon resolutions (explored 2026-07-15, facts verified in code)

- Existing AST builders (`utils/taskQueries.ts`) already exclude Done/Cancelled
  via `notCompletedConditions()`; the popup adds `not_equals Backlog/Reviewing`.
- No "completed today" builder exists — new one-condition AST on
  `task_closed_date = getTodayDayUuid()`; the backend maintains
  `task_closed_date` on status transitions (`app/features/tasks/service.py`).
- `useTaskActions.applyTaskStatus`/`openTask` are not exported; the popup uses
  a new small exported hook sharing the same mutation logic.
- No "create task on today's journal" utility exists — compose
  `getOrCreateDaily` + `useCreateNode({ parent_uuid, class_uuids: [task] })`
  (backend defaults apply Status=Pending) + a `task_scheduled` write.
- `/tasks` is not in `AppRoutes.tsx` — it's `mainViewType`-driven via
  `layout/hooks/url.ts` + `MainContentPane.tsx`.
- CalendarPopup has no Esc handling — the tasks popup implements its own.

## Testing

- Hook tests: the four section ASTs carry the right status filters and date
  bounds; badge count derivation.
- Component tests (jsdom, `SidebarRail.test.tsx` mock patterns): sections
  render with rows; check → `applyTaskStatus('Done')` + optimistic runtime
  `taskStatus`; uncheck → 'Pending'; quick-add path; row click navigates +
  closes; badge count on the trigger.
- Existing `useTasks` / `useTaskActions` tests trimmed to the surviving API.
- Final manual browser pass after a dev-stack rebuild.
