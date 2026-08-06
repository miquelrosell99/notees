# Tasks Sidebar Entry + Palette Dedup + Android Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tasks button to the desktop sidebar rail, reduce the command palette to a single "Open Tasks" command, and remove all legacy Android WebView bridge code from the frontend (the mobile app is now the native Flutter app in `miquelrosell99/notees-flutter`).

**Architecture:** The dedicated `TasksView` already exists and is routed via `mainViewType === 'tasks'` with `/tasks` URL sync. This plan (1) adds a rail button calling the existing `setMainViewType('tasks')`, (2) deletes the redundant `nav.tasks` ad-hoc palette command, keeping `view.tasks`, (3) deletes `useAndroidBridge.ts`/`useTouchContextMenu.ts` and every `window.Android` consumer so web storage is the only auth path, (4) updates docs that still describe the Kotlin WebView wrapper.

**Tech Stack:** React 19 + TypeScript, Zustand, Vitest + jsdom + Testing Library, Vite. Frontend-only; no backend changes.

## Global Constraints

- Spec: `../superpowers/specs/2026-07-15-tasks-sidebar-entry-design.md`.
- Frontend imports use path aliases (`@/...`), never relative `../../../` paths.
- Verification runs in Docker dev containers where available: `docker compose -f compose.dev.yaml exec frontend <cmd>`; the equivalent host commands (`cd frontend && ...`) are listed per task and are acceptable for vitest/tsc/lint.
- Test runner: `cd frontend && npx vitest run <file>` for a single file, `npm run test:run` for the suite. Vitest config: globals on, jsdom, setup `src/tests/setup.ts`, alias `@/` → `src/`.
- Commits follow Conventional Commits. Stage files per task explicitly (no `git add -A`).
- Out of scope (do NOT touch): mobile drawer UI, TasksView tabs/persistence, new task properties, mobile web/PWA layout, backend.

---

### Task 1: Single "Open Tasks" palette command

**Files:**
- Create: `frontend/src/features/commands/navigationCommands.test.ts`
- Modify: `frontend/src/features/commands/navigationCommands.ts` (delete `OPEN_TASKS` registration, lines 144-153; fix import line 11)
- Modify: `frontend/src/stores/commandRegistry.ts:203` (delete `OPEN_TASKS: 'nav.tasks',`)

**Interfaces:**
- Consumes: `useCommandRegistry.getState().getPaletteCommands()` / `.getCommand(id)` from `@/stores/commandRegistry`; `COMMAND_IDS.OPEN_TASKS_VIEW` (`'view.tasks'`).
- Produces: exactly one palette command labeled `Open Tasks` with id `COMMAND_IDS.OPEN_TASKS_VIEW`; `COMMAND_IDS.OPEN_TASKS` no longer exists.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/commands/navigationCommands.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { useCommandRegistry, COMMAND_IDS } from '@/stores/commandRegistry';
import '@/features/commands/navigationCommands';

describe('navigationCommands palette registrations', () => {
  it('registers exactly one "Open Tasks" command, targeting the dedicated tasks view', () => {
    const openTasks = useCommandRegistry
      .getState()
      .getPaletteCommands()
      .filter((c) => c.label === 'Open Tasks');
    expect(openTasks).toHaveLength(1);
    expect(openTasks[0]?.id).toBe(COMMAND_IDS.OPEN_TASKS_VIEW);
  });

  it('does not register the legacy ad-hoc tasks collection command', () => {
    expect(useCommandRegistry.getState().getCommand('nav.tasks')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/commands/navigationCommands.test.ts`
Expected: FAIL — first test finds 2 commands labeled "Open Tasks".

- [ ] **Step 3: Remove the duplicate command**

In `frontend/src/features/commands/navigationCommands.ts` delete this entire block:

```ts
registerCommand({
  id: COMMAND_IDS.OPEN_TASKS,
  label: 'Open Tasks',
  icon: 'mdi mdi-format-list-checkbox',
  context: 'global',
  palette: { category: 'navigation', keywords: ['task', 'todo', 'query'] },
  execute: () => {
    useNavigationStore.getState().openNodeCollection('Tasks', buildTasksQueryAST());
  },
});
```

Then change line 11 from:

```ts
import { buildTasksQueryAST, buildTodayQueryAST } from '@/utils/taskQueries';
```

to:

```ts
import { buildTodayQueryAST } from '@/utils/taskQueries';
```

(`buildTodayQueryAST` stays — it is used by the `OPEN_TODAY` command.)

In `frontend/src/stores/commandRegistry.ts` delete the line:

```ts
  OPEN_TASKS: 'nav.tasks',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/commands/navigationCommands.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check for orphaned references**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no errors (nothing else references `COMMAND_IDS.OPEN_TASKS`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/commands/navigationCommands.test.ts frontend/src/features/commands/navigationCommands.ts frontend/src/stores/commandRegistry.ts
git commit -m "fix(commands): remove duplicate Open Tasks palette command"
```

---

### Task 2: Tasks button in the sidebar rail

**Files:**
- Create: `frontend/src/features/layout/components/Sidebar/SidebarRail.test.tsx`
- Modify: `frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx` (`SidebarRail`, insert button between "Go to today" and "Pages")

**Interfaces:**
- Consumes: `useNavigationStore` (`@/stores`) — `mainViewType`, `setMainViewType`; `Button` from `@/components/ui/Button` (active state renders class `btn--active`).
- Produces: rail button with `aria-label="Tasks"` that sets `mainViewType` to `'tasks'` on click and shows active state when `mainViewType === 'tasks'`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/layout/components/Sidebar/SidebarRail.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarRail } from './NavigationSidebar';
import { useNavigationStore } from '@/stores';

vi.mock('@/features/workspace', () => ({
  WorkspaceSwitcher: () => null,
  useWorkspaceSettings: () => ({
    data: { sidebar_show_journals: true, sidebar_show_inbox: true },
  }),
  useEmptyTrash: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/features/content', () => ({
  useNodeByUuid: () => ({ data: { uuid: 'inbox-uuid' } }),
  useDailyNote: () => ({ refetch: vi.fn() }),
  PageContextMenu: () => null,
}));

vi.mock('@/features/layout/components/AccountMenu', () => ({
  AccountMenu: () => null,
}));

vi.mock('@/features/layout/components/Modals', () => ({
  GraphSettingsModal: () => null,
  UserSettingsModal: () => null,
  SystemSettingsModal: () => null,
}));

vi.mock('@/features/support', () => ({
  SupportBadge: () => null,
}));

describe('SidebarRail', () => {
  beforeEach(() => {
    useNavigationStore.setState({ mainViewType: 'pages' });
  });

  it('shows a Tasks button', () => {
    render(<SidebarRail />);
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('opens the tasks view when clicked', async () => {
    render(<SidebarRail />);
    await userEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(useNavigationStore.getState().mainViewType).toBe('tasks');
  });

  it('marks the Tasks button active while the tasks view is open', () => {
    useNavigationStore.setState({ mainViewType: 'tasks' });
    render(<SidebarRail />);
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveClass('btn--active');
  });
});
```

Note: `NavigationSidebar.tsx` also imports `./SidebarFavorites`, `./SidebarRecents`, `./SidebarPinnedPages` at module level. They are not rendered by `SidebarRail` and should import cleanly; if the test file fails at import time with an error from one of those modules, add a stub mock, e.g. `vi.mock('./SidebarFavorites', () => ({ SidebarFavorites: () => null }))`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/layout/components/Sidebar/SidebarRail.test.tsx`
Expected: FAIL — no element with role `button` and name `Tasks`.

- [ ] **Step 3: Add the rail button**

In `frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx`, inside `SidebarRail`'s `<div className="sidebar-rail__top">`, insert immediately after the "Go to today" `Button` (the one with `onClick={handleGoToToday}`) and before the "Pages" `Button`:

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

`mainViewType` and `setMainViewType` are already destructured from `useNavigationStore` in `SidebarRail` — no other changes needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/layout/components/Sidebar/SidebarRail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/layout/components/Sidebar/SidebarRail.test.tsx frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx
git commit -m "feat(layout): add Tasks button to sidebar rail"
```

---

### Task 3: Remove the legacy Android WebView bridge

**Files:**
- Create: `frontend/src/utils/auth.test.ts` (characterization test, written BEFORE the edit)
- Delete: `frontend/src/features/layout/hooks/useAndroidBridge.ts`
- Delete: `frontend/src/hooks/useTouchContextMenu.ts` (only consumer was the bridge)
- Modify: `frontend/src/features/layout/index.ts` (drop barrel export line 5)
- Modify: `frontend/src/App.tsx` (import line 23; `AppContent` lines 96-105)
- Modify: `frontend/src/features/layout/components/MobileLayout.tsx` (import line 24; effect lines 61-64)
- Modify: `frontend/src/utils/auth.ts` (remove all `window.Android` branches and `isAndroidApp()`)
- Modify: `frontend/src/hooks/useOnlineStatus.ts` (remove native events)
- Modify: `frontend/src/index.css` (remove `.android-app` block, lines 70-77)
- Modify: `frontend/src/features/layout/components/AccountMenu.tsx` (import line 19; `handleChangeServer` lines 186-189; gated block lines 278-286)
- Modify: `frontend/src/features/shares/hooks/useShareReceiver.ts` (doc comment line 2)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `frontend/src/utils/auth.ts` exports unchanged in signature — `setUserData(user: unknown): void`, `getUserData<T = unknown>(): T | null`, `clearUserData(): void`, `handleAuthFailure(): void`, `isAuthenticated(): boolean`, `getApiKey(): string | null`, `setApiKey(key: string): void`, `clearApiKey(): void` — all backed solely by `localStorage`. No module in `frontend/src` references `window.Android`, `noteesBridge`, `isAndroidApp`, `useAndroidBridge`, `useTouchContextMenu`, `reportDrawerStateToAndroid`, or the `android-app` CSS class.

- [ ] **Step 1: Write the characterization test (passes before and after the edit)**

Create `frontend/src/utils/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setUserData,
  getUserData,
  clearUserData,
  setApiKey,
  getApiKey,
  clearApiKey,
  isAuthenticated,
} from '@/utils/auth';

describe('auth storage (web storage path)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips user data through localStorage', () => {
    const user = { id: 1, email: 'a@b.c' };
    setUserData(user);
    expect(getUserData()).toEqual(user);
    expect(isAuthenticated()).toBe(true);
  });

  it('returns null for missing or corrupt user data', () => {
    expect(getUserData()).toBeNull();
    localStorage.setItem('user', '{not json');
    expect(getUserData()).toBeNull();
  });

  it('clears user data', () => {
    setUserData({ id: 1 });
    clearUserData();
    expect(getUserData()).toBeNull();
    expect(isAuthenticated()).toBe(false);
  });

  it('round-trips the API key through localStorage', () => {
    expect(getApiKey()).toBeNull();
    setApiKey('k123');
    expect(getApiKey()).toBe('k123');
    clearApiKey();
    expect(getApiKey()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the characterization test (must pass pre-edit)**

Run: `cd frontend && npx vitest run src/utils/auth.test.ts`
Expected: PASS (4 tests). This locks the browser behavior that must survive the refactor.

- [ ] **Step 3: Delete the bridge files**

```bash
rm frontend/src/features/layout/hooks/useAndroidBridge.ts
rm frontend/src/hooks/useTouchContextMenu.ts
```

- [ ] **Step 4: Remove the barrel export**

In `frontend/src/features/layout/index.ts` delete the line:

```ts
export * from './hooks/useAndroidBridge';
```

- [ ] **Step 5: Clean up App.tsx**

Change the import on line 23 from:

```ts
import { useUndoStackPersistence, useAndroidBridge, AppRoutes } from '@/features/layout';
```

to:

```ts
import { useUndoStackPersistence, AppRoutes } from '@/features/layout';
```

Change `AppContent` from:

```tsx
function AppContent() {
  // Register the Android bridge as early as possible — before auth gates — so
  // the native shell can call window.noteesBridge even while the app is loading.
  useAndroidBridge();
  // Start the backend health poller. It runs for the lifetime of the app.
  useBackendHealth();
  // Register web background sync (Periodic Background Sync + one-shot sync).
  useBackgroundSync();
  return <AppRoutes />;
}
```

to:

```tsx
function AppContent() {
  // Start the backend health poller. It runs for the lifetime of the app.
  useBackendHealth();
  // Register web background sync (Periodic Background Sync + one-shot sync).
  useBackgroundSync();
  return <AppRoutes />;
}
```

- [ ] **Step 6: Clean up MobileLayout.tsx**

Delete the import:

```ts
import { reportDrawerStateToAndroid } from '@/features/layout';
```

Delete this effect:

```tsx
  // Keep the Android native back-button handler in sync with drawer state
  useEffect(() => {
    reportDrawerStateToAndroid(drawerOpen);
  }, [drawerOpen]);
```

(All other `useEffect` imports stay — `useEffect` is still used elsewhere in the file.)

- [ ] **Step 7: Rewrite utils/auth.ts without the native branches**

Replace the full file content with:

```ts
/**
 * Centralized authentication helpers
 *
 * Access tokens are stored in an HTTPOnly cookie set by the backend, so
 * this module does not read or write the JWT to localStorage. It only
 * manages non-sensitive user data and long-lived API keys (which still require
 * localStorage so they can be sent as the X-API-Key header).
 */

const USER_KEY = 'user';
const API_KEY_KEY = 'api_key';

/**
 * Store user data in storage.
 */
export function setUserData(user: unknown): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Get stored user data.
 */
export function getUserData<T = unknown>(): T | null {
  const userStr = localStorage.getItem(USER_KEY);
  if (!userStr) return null;
  try {
    return JSON.parse(userStr) as T;
  } catch {
    return null;
  }
}

/**
 * Clear stored user data.
 */
export function clearUserData(): void {
  localStorage.removeItem(USER_KEY);
}

/**
 * Clean up client-side auth state and redirect to the login page.
 *
 * Called from the API client (after refresh fails) and from the live-sync
 * WebSocket (when the server closes the socket with an auth error).
 */
export function handleAuthFailure(): void {
  clearUserData();
  localStorage.removeItem('auth-storage');
  // Notify other tabs / listeners that this session has ended.
  try {
    localStorage.setItem('auth:logout', Date.now().toString());
  } catch {
    // Ignore storage errors (e.g., private mode).
  }
  window.dispatchEvent(new CustomEvent('auth:unauthorized'));
  if (window.location.pathname !== '/auth') {
    window.location.href = '/auth';
  }
}

/**
 * Check if user data exists. Note: this does not verify that the session is
 * still valid; call /api/auth/me to confirm authentication state.
 */
export function isAuthenticated(): boolean {
  return !!getUserData();
}

// ── API key (for device/background access) ──────────────────────────────────

/**
 * Get the API key for the current server.
 */
export function getApiKey(): string | null {
  return localStorage.getItem(API_KEY_KEY);
}

/**
 * Store an API key.
 */
export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_KEY, key);
}

/**
 * Clear the stored API key.
 */
export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_KEY);
}
```

- [ ] **Step 8: Rewrite hooks/useOnlineStatus.ts without native events**

Replace the full file content with:

```ts
/**
 * useOnlineStatus — tracks browser online/offline state.
 *
 * Uses navigator.onLine and listens to 'online' / 'offline' window events.
 *
 * Returns true when the browser believes it has network connectivity.
 */
import { useState, useEffect } from 'react';

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
```

- [ ] **Step 9: Remove the .android-app CSS block**

In `frontend/src/index.css` delete:

```css
/* On Android suppress the browser pull-to-refresh / reload gesture completely. */
.android-app,
.android-app body,
.android-app .mobile-content,
.android-app .main-content,
.android-app .mobile-drawer {
  overscroll-behavior-y: none;
}
```

- [ ] **Step 10: Clean up AccountMenu.tsx**

Delete the import:

```ts
import { isAndroidApp } from '@/features/layout/hooks/useAndroidBridge';
```

Delete the handler:

```tsx
  const handleChangeServer = () => {
    setIsOpen(false);
    window.Android?.showServerSettings();
  };
```

Delete the gated menu block:

```tsx
          {isAndroidApp() && (
            <>
              <div className="account-menu__divider" />
              <button className="account-menu__item" onClick={handleChangeServer}>
                <Icon path={"mdi mdi-server-network"} size={0.7} />
                <span>Change server</span>
              </button>
            </>
          )}
```

- [ ] **Step 11: Fix the useShareReceiver doc comment**

In `frontend/src/features/shares/hooks/useShareReceiver.ts` change line 2 from:

```ts
 * Hook that detects shared content from Android share intent or PWA share_target.
```

to:

```ts
 * Hook that detects shared content from the PWA share_target.
```

(The implementation is URL-param based and untouched — the `notees:share-received` DOM event the old bridge dispatched had no listeners and is gone with the bridge.)

- [ ] **Step 12: Verify no Android references remain**

Run: `grep -rn "window\.Android\|isAndroidApp\|noteesBridge\|android-app\|useAndroidBridge\|useTouchContextMenu\|reportDrawerStateToAndroid\|nativeOnline\|nativeOffline" frontend/src`
Expected: no output (zero matches). Note: `mdiAndroid`/`mdiAndroidStudio` icon names in `utils/mdiIconList.ts` are unrelated and intentionally kept.

- [ ] **Step 13: Run the full verification suite**

Run:
```bash
cd frontend && npx vitest run
cd frontend && npx tsc -b --noEmit
cd frontend && npm run lint
```
Expected: all tests PASS (including the Task 1, Task 2, and auth characterization tests), no type errors, no lint errors.

- [ ] **Step 14: Commit**

```bash
git add frontend/src/utils/auth.test.ts frontend/src/utils/auth.ts frontend/src/hooks/useOnlineStatus.ts frontend/src/index.css frontend/src/App.tsx frontend/src/features/layout/index.ts frontend/src/features/layout/components/MobileLayout.tsx frontend/src/features/layout/components/AccountMenu.tsx frontend/src/features/shares/hooks/useShareReceiver.ts
git rm frontend/src/features/layout/hooks/useAndroidBridge.ts frontend/src/hooks/useTouchContextMenu.ts
git commit -m "refactor(layout): remove legacy Android WebView bridge"
```

(If the files were already deleted with `rm` in Step 3, `git rm` will report them as already removed from the working tree — use `git add -u` on those two paths instead.)

---

### Task 4: Documentation sweep

**Files:**
- Modify: `AGENTS.md` (tech stack table, Mobile row)
- Modify: `plan-totp-2fa.md:88-89`
- Modify: `docs/SECURITY.md:34`

**Interfaces:**
- Consumes: nothing.
- Produces: docs that describe the Flutter native app instead of the Kotlin WebView wrapper. `../mobile-sync.md` (sqflite/FTS5 notes about the Flutter app) and `../build-and-release.md` (already points at `notees-flutter`) are verified current and need NO changes.

- [ ] **Step 1: Update the AGENTS.md tech stack row**

In `AGENTS.md` replace:

```markdown
| Mobile | Kotlin + Android SDK | 36 (minSdk 26) | WebView wrapper app |
```

with:

```markdown
| Mobile | Flutter (Dart) | — | Native mobile app, lives in `miquelrosell99/notees-flutter` |
```

- [ ] **Step 2: Update the TOTP plan reference**

In `plan-totp-2fa.md` replace:

```markdown
Works in the Kotlin WebView: QR is just an image/SVG on screen; scanning is done by the
external authenticator app, so no camera-in-WebView is needed.
```

with:

```markdown
Works in the Flutter mobile app: QR is just an image/SVG on screen; scanning is done by the
external authenticator app, so no in-app camera is needed.
```

- [ ] **Step 3: Remove the stale SECURITY.md line**

In `docs/SECURITY.md` delete the line:

```markdown
- Encrypted mobile storage via AndroidX Security `EncryptedSharedPreferences`.
```

That storage was provided by the removed WebView wrapper; the Flutter app's storage is documented in `miquelrosell99/notees-flutter`.

- [ ] **Step 4: Verify no stale wrapper references remain**

Run: `grep -rni "webview wrapper\|kotlin" AGENTS.md agents/ docs/ README.md`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md agents/plans/plan-totp-2fa.md docs/SECURITY.md
git commit -m "docs: replace Kotlin WebView wrapper references with Flutter app"
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run all frontend checks**

Run (host or inside the dev container):
```bash
cd frontend && npm run lint
cd frontend && npx tsc -b --noEmit
cd frontend && npm run test:run
```
Expected: all clean / green.

- [ ] **Step 2: Rebuild the dev stack**

Run: `docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build`
Expected: backend, frontend, PostgreSQL, Redis all start healthy (frontend on http://localhost:5173, API on http://localhost:8001).

- [ ] **Step 3: Browser click-test**

Verify in the browser:
- The rail shows the Tasks button between "Go to today" and "Pages"; clicking it opens `TasksView`; the button shows its active state; the URL is `/tasks` and reload keeps the view.
- The command palette shows exactly one "Open Tasks" result when typing "task" or "todo", and it opens the dedicated Tasks view (three tabs), not an ad-hoc collection.
- Login and logout still work (auth storage path after the bridge removal); reload keeps the session.
- Mobile viewport: drawer opens/closes normally; the rail is absent as before.
- PWA share target: opening `/?shared=true&text=hello` creates a block in the Scratchpad and opens it.
