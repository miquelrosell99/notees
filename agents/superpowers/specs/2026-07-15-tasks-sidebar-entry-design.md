# Design: Tasks Sidebar Entry + Palette Dedup + Android Teardown

Date: 2026-07-15
Status: Approved (design), pending implementation plan

## Background

The dedicated task management view already exists and ships:

- `frontend/src/features/tasks/pages/TasksView.tsx` — three tabs (All / Today+Overdue / Future), each a QueryAST query rendered through `NodeCollection` with list/kanban/table modes.
- Routed via `mainViewType === 'tasks'` in `MainContentPane.tsx`; URL `/tasks` round-trips through `SPECIAL_VIEWS` in `features/layout/hooks/url.ts`.
- Reachable from the command palette via `COMMAND_IDS.OPEN_TASKS_VIEW` (`view.tasks`).

What is missing or wrong:

1. **No sidebar entry** — the desktop rail (`SidebarRail` in `NavigationSidebar.tsx`) has Journals, Today, Pages, Inbox, but no Tasks.
2. **Duplicate palette commands** — `OPEN_TASKS_VIEW` (`view.tasks`, opens the dedicated view) and `OPEN_TASKS` (`nav.tasks`, opens an ad-hoc `NodeCollection` with `buildTasksQueryAST()`) are both labeled "Open Tasks".
3. **Dead Android WebView bridge code** — the Android app is now the native Flutter app (`miquelrosell99/notees-flutter`); nothing in this repo should reference the old Kotlin WebView wrapper, yet `window.Android` / `window.noteesBridge` code remains in several files.

## Goals

- Add a Tasks button to the desktop sidebar rail.
- Reduce the palette to a single "Open Tasks" command targeting the dedicated view.
- Remove all Android WebView wrapper code from the frontend.
- Update docs that still describe the Kotlin WebView wrapper.

## Non-Goals

- Mobile drawer UI changes. On mobile, Tasks is reachable via the command palette — the same status quo as Journals/Pages/Today (the rail is desktop-only).
- TasksView enhancements: overdue-only tab, tab/view-mode persistence, new task properties (assignee, etc.).
- Removing the mobile web layout or PWA support (separate decision; the Flutter app covers installed clients, mobile web remains the zero-install path).
- Any backend changes.

## Design

### 1. Sidebar rail Tasks button

File: `frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx`, in `SidebarRail`'s top group (`sidebar-rail__top`), inserted between the "Go to today" button and the "Pages" button:

```tsx
<Button
  className="sidebar-rail__btn"
  variant="ghost"
  size="md"
  icon="mdi mdi-checkbox-marked-circle-outline"
  fullWidth
  active={mainViewType === 'tasks'}
  onClick={() => setMainViewType('tasks')}
  aria-label="Tasks"
  title="Tasks"
/>
```

- Icon matches the existing `view.tasks` palette command for visual consistency.
- Always visible — no `sidebar_show_tasks` workspace setting (decision: keep scope small; journals/inbox gating pattern deliberately not followed).
- No routing work needed: `setMainViewType('tasks')` and `/tasks` URL sync already exist.

### 2. Command palette dedup

- `frontend/src/features/commands/navigationCommands.ts`: delete the `registerCommand({ id: COMMAND_IDS.OPEN_TASKS, ... })` block (`nav.tasks`, ad-hoc collection). Remove `buildTasksQueryAST` from the `taskQueries` import (it becomes unused; `buildTodayQueryAST` stays for `OPEN_TODAY`).
- `frontend/src/stores/commandRegistry.ts`: delete `OPEN_TASKS: 'nav.tasks'` from `COMMAND_IDS`.
- Result: exactly one "Open Tasks" command (`view.tasks` → `setMainViewType('tasks')`).
- The ad-hoc `OPEN_TODAY` command is untouched (different semantic).
- Sweep `frontend/e2e/` and test files for `nav.tasks` / `OPEN_TASKS` references; update or remove any.

### 3. Android teardown

Delete `frontend/src/features/layout/hooks/useAndroidBridge.ts` entirely (defines `window.Android` / `window.noteesBridge` types, `isAndroidApp()`, `useAndroidBridge()`, `reportDrawerStateToAndroid()`), then remove its consumers:

- `frontend/src/features/layout/index.ts` — remove the `export * from './hooks/useAndroidBridge'` barrel line.
- `frontend/src/App.tsx` — remove the `useAndroidBridge` import, the registration call, and its comment.
- `frontend/src/features/layout/components/MobileLayout.tsx` — remove the `reportDrawerStateToAndroid` import and the effect that calls it.
- `frontend/src/utils/auth.ts` — remove `isAndroidApp()` and every `window.Android` native-storage branch (`storeUserData`/`getUserData`/`clearUserData`/`getApiKey`/`storeApiKey`/`clearApiKey`). Web storage becomes the only path; behavior in browsers is unchanged.
- `frontend/src/hooks/useOnlineStatus.ts` — remove the `nativeOnline`/`nativeOffline` listeners, handlers, and the doc-comment lines about the Android wrapper.
- `frontend/src/index.css` — remove the `.android-app` pull-to-refresh suppression block.
- `frontend/src/features/layout/components/AccountMenu.tsx` — remove the `isAndroidApp()`-gated "Change server" menu item and its divider; remove `handleChangeServer` if it becomes orphaned, plus the `isAndroidApp` import.
- `frontend/src/features/shares/hooks/useShareReceiver.ts` — the implementation is pure PWA `share_target` (URL params); only the doc comment mentions Android share intents. Fix the comment.

### 4. Documentation

- `AGENTS.md` tech stack table: replace the row `Mobile | Kotlin + Android SDK | 36 (minSdk 26) | WebView wrapper app` with a Flutter app entry referencing `miquelrosell99/notees-flutter`.
- Sweep `agents/*.md` (notably `agents/mobile-sync.md` and `agents/subsystems.md`) for Android-wrapper references and update them to match reality.

## Verification

1. `cd frontend && npm run lint`
2. `cd frontend && npx tsc -b --noEmit`
3. `cd frontend && npm run test:run`
4. Rebuild the dev stack: `docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build` (or `task dev -- --build`).
5. Browser click-test:
   - Rail shows Tasks between Today and Pages; clicking it opens TasksView; button shows active state while on the view; `/tasks` URL round-trips.
   - Command palette shows exactly one "Open Tasks" result for "task"/"todo" queries.
   - Login/logout still works (auth storage path after removing native-storage branches).
   - Mobile drawer opens/closes normally; PWA share target (`?shared=true`) still creates a scratchpad block.

## Risks

- **Auth regression**: `utils/auth.ts` is security-sensitive; the removal must keep the web-storage fallback exactly as-is. Covered by existing auth tests plus the manual login/logout check.
- **Orphaned references**: `handleChangeServer` in `AccountMenu.tsx` or e2e tests referencing `nav.tasks` could break the build; tsc and the e2e sweep catch these.
