# Pinned Pages Sidebar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar `Pinned` section less noisy by collapsing it by default, hiding it when empty, and moving the pin action into the page context menu.

**Architecture:** Keep the existing `usePinnedPagesStore` (session-only) and `SidebarPinnedPages` component; change their presentation defaults. Add a page-scoped `pin` action to the shared `NodeContextMenu` so users can pin/unpin pages even when the sidebar section is hidden.

**Tech Stack:** React 19, TypeScript, Zustand, TanStack Query, Vitest, Docker Compose dev stack.

## Global Constraints

- Pins remain session-only — no persistence changes.
- Only page nodes can be pinned (`node.is_page === true`).
- Follow existing project patterns: path aliases (`@/...`), feature-first structure, no relative `../../../` imports.
- Do not use `window.confirm` / `window.alert` / `window.prompt`.
- Run lint, type-check, and existing tests before declaring done.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx` | Renders the pinned section; now defaults collapsed and returns `null` when empty. |
| `frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx` | Already renders `SidebarPinnedPages` last in the scrollable content; verify/keep that order. |
| `frontend/src/features/content/components/nodes/NodeContextMenu/actions.ts` | Declares the `'pin'` action name and includes it in `DEFAULT_ACTIONS` as page-scoped. |
| `frontend/src/features/content/components/nodes/NodeContextMenu.tsx` | Handles the `pin` action by reading `usePinnedPagesStore` and calling `togglePin`. |
| `frontend/src/features/content/pages/NodeView.tsx` | Uses `PageContextMenu` with default actions; no code change needed, only verification. |

---

### Task 1: Update SidebarPinnedPages component

**Files:**
- Modify: `frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx:113`
- Modify: `frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx:162-207`

**Interfaces:**
- Consumes: `usePinnedPagesStore.pinnedPages`, `usePinnedPagesStore.unpinPage`, `usePinnedPagesStore.togglePin`.
- Produces: `SidebarPinnedPages` now renders `null` when `pinnedPages.length === 0` and defaults `expanded` to `false`.

- [ ] **Step 1: Change default expanded state**

  In `frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx`, change:

  ```tsx
  const [expanded, setExpanded] = useState(true);
  ```

  to:

  ```tsx
  const [expanded, setExpanded] = useState(false);
  ```

- [ ] **Step 2: Add early return for empty pinned list**

  In the `SidebarPinnedPages` function body, add:

  ```tsx
  if (pinnedPages.length === 0) return null;
  ```

  Place it **after all hook calls** and just before the JSX `return`. In the final component order this means after `useNavigationStore`, `useIsMobile`, `useNodeByUuid`, the `useCallback` hooks (`closeMobileDrawer`, `handleNavigate`, `handleUnpin`, `handleTogglePinCurrent`), and the derived state `currentPageIsPinnable` / `currentPageIsPinned`. The guard appears immediately after `handleTogglePinCurrent` (around line 162) and before the `<div className="sidebar-section">` JSX return. This placement preserves React's Rules of Hooks — an early return is only safe once every hook for the render has already been invoked.

- [ ] **Step 3: Remove the unreachable empty-state branch**

  The empty-state block inside `sidebar-pinned-list` is now unreachable because the component returns `null` when empty. Replace:

  ```tsx
  {pinnedPages.length === 0 ? (
    <div className="sidebar-empty-message">
      No pinned pages. Open a page and click the pin button to keep it here for this session.
    </div>
  ) : (
    pinnedPages.map((nodeUuid) => (
      <PinnedItem ... />
    ))
  )}
  ```

  with:

  ```tsx
  {pinnedPages.map((nodeUuid) => (
    <PinnedItem
      key={nodeUuid}
      nodeUuid={nodeUuid}
      isActive={currentNodeUuid === nodeUuid && mainViewType === 'node'}
      onClick={() => handleNavigate(nodeUuid)}
      onNavigate={handleNavigate}
      onUnpin={handleUnpin}
      onContextMenu={(e) => onContextMenu(nodeUuid, e)}
    />
  ))}
  ```

- [ ] **Step 4: Run existing pinned-pages store tests**

  Run:

  ```bash
  cd frontend && npm run test:run -- pinnedPagesStore
  ```

  Expected: all existing tests pass; no store logic changed.

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx
  git commit -m "feat(sidebar): collapse pinned section by default and hide when empty"
  ```

---

### Task 2: Verify sidebar section order in NavigationSidebar

**Files:**
- Verify: `frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx:338-341`

**Interfaces:**
- Consumes: `SidebarPinnedPages` placement in `NavigationSidebar`.
- Produces: `Pinned` remains the last section in `.sidebar-content`.

- [ ] **Step 1: Confirm Pinned is rendered last**

  Open `frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx` and verify the `.sidebar-content` children are ordered:

  ```tsx
  <div className="sidebar-content">
    <SidebarFavorites onContextMenu={handleFavoriteContextMenu} />
    <SidebarRecents onContextMenu={handleRecentContextMenu} />
    <SidebarPinnedPages onContextMenu={handleFavoriteContextMenu} />
  </div>
  ```

  If `SidebarPinnedPages` is not last, move it to the end of `.sidebar-content`.

- [ ] **Step 2: Commit (only if a change was made)**

  If the order was already correct, no commit is needed for this task.

  If you moved it:

  ```bash
  git add frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx
  git commit -m "refactor(sidebar): keep pinned section at the bottom of the scrollable content"
  ```

---

### Task 3: Add pin action to NodeContextMenu

**Files:**
- Modify: `frontend/src/features/content/components/nodes/NodeContextMenu/actions.ts:1-51`
- Modify: `frontend/src/features/content/components/nodes/NodeContextMenu.tsx:1-136`
- Verify: `frontend/src/features/content/pages/NodeView.tsx:1081-1087` and `frontend/src/features/content/pages/NodeView.tsx:1504-1510`

**Interfaces:**
- Consumes: `usePinnedPagesStore.pinnedPages`, `usePinnedPagesStore.togglePin`.
- Produces: A new `'pin'` action available in page context menus via `DEFAULT_ACTIONS`.

- [ ] **Step 1: Add `'pin'` to the action name union and default list**

  In `frontend/src/features/content/components/nodes/NodeContextMenu/actions.ts`, update `ActionName`:

  ```ts
  export type ActionName =
    | 'favorite'
    | 'pin'
    | 'move-to'
    | 'convert-to-page'
    | 'convert-to-block'
    | 'toggle-header'
    | 'copy-uuid'
    | 'copy-link'
    | 'open-main-view'
    | 'copy-blocks'
    | 'paste-blocks'
    | 'open-sidebar'
    | 'local-graph'
    | 'export'
    | 'presentation'
    | 'copy-text'
    | 'share'
    | 'view-ast'
    | 'toggle-private'
    | 'add-banner'
    | 'archive'
    | 'delete';
  ```

  Add `['pin', 'page']` to `DEFAULT_ACTIONS` right after `['open-sidebar', 'both']`:

  ```ts
  export const DEFAULT_ACTIONS: ActionConfig[] = [
    ['copy-link',       'both'],
    ['open-main-view',  'both'],
    ['share',           'both'],
    ['open-sidebar',    'both'],
    ['pin',             'page'],
    ['copy-blocks',     'both'],
    ['paste-blocks',    'both'],
    ['move-to',         'both'],
    ['convert-to-page', 'block'],
    ['convert-to-block', 'page'],
    ['toggle-header',   'block'],
    ['copy-text',       'both'],
    ['export',          'both'],
    ['presentation',    'both'],
    ['view-ast',        'both'],
    ['archive',         'both'],
    ['toggle-private',  'page'],
    ['add-banner',      'page'],
    ['delete',          'both'],
  ];
  ```

- [ ] **Step 2: Import the pinned pages store in NodeContextMenu**

  In `frontend/src/features/content/components/nodes/NodeContextMenu.tsx`, add to the imports from `@/stores`:

  ```tsx
  import { useSettingsStore, usePresentationStore, useUndoStore, usePinnedPagesStore } from '@/stores';
  ```

- [ ] **Step 3: Read pin state and toggle function**

  Inside `NodeContextMenu`, after the favorites state (around line 132), add:

  ```tsx
  const pinnedPages = usePinnedPagesStore((s) => s.pinnedPages);
  const isPinned = pinnedPages.includes(node.uuid);
  const togglePin = usePinnedPagesStore((s) => s.togglePin);
  ```

- [ ] **Step 4: Add the `'pin'` switch case**

  Inside the `menuItems` switch (after the `'favorite'` case), add:

  ```tsx
  case 'pin':
    if (!node.is_page) break;
    items.push({
      id: 'pin',
      label: isPinned ? 'Unpin from sidebar' : 'Pin to sidebar',
      icon: isPinned ? 'mdi mdi-pin' : 'mdi mdi-pin-outline',
      onClick: () => {
        togglePin(node.uuid);
        onClose();
      },
    });
    break;
  ```

- [ ] **Step 5: Verify NodeView PageContextMenu uses default actions**

  In `frontend/src/features/content/pages/NodeView.tsx`, confirm the two `PageContextMenu` call sites do **not** pass a custom `actions` prop. They should look like:

  ```tsx
  <PageContextMenu
    node={node}
    anchorEl={topBarMenuBtnRef.current}
    onClose={handleCloseTopBarMenu}
  />
  ```

  and:

  ```tsx
  <PageContextMenu
    node={node}
    position={contextMenuPos}
    onClose={handleCloseContextMenu}
  />
  ```

  No code change is needed if they use defaults.

- [ ] **Step 6: Commit**

  ```bash
  git add frontend/src/features/content/components/nodes/NodeContextMenu/actions.ts
  git add frontend/src/features/content/components/nodes/NodeContextMenu.tsx
  git commit -m "feat(context-menu): add pin/unpin page action to page context menu"
  ```

---

### Task 4: Verify the change

**Files:**
- All files modified above.

- [ ] **Step 1: Run frontend lint**

  ```bash
  docker compose -f compose.dev.yaml exec frontend npm run lint
  ```

  Expected: no errors or warnings introduced by the changes.

- [ ] **Step 2: Run TypeScript type check**

  ```bash
  docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
  ```

  Expected: no type errors.

- [ ] **Step 3: Run existing frontend tests**

  ```bash
  docker compose -f compose.dev.yaml exec frontend npm run test:run -- pinnedPagesStore
  ```

  Expected: pinnedPagesStore tests pass.

- [ ] **Step 4: Manual browser verification**

  1. Rebuild and start the dev stack if needed:

     ```bash
     docker compose -f compose.dev.yaml up --build
     ```

  2. Open the app and ensure the left sidebar shows `Favorites` and `Recents` but **no** `Pinned` section when no pages are pinned.

  3. Open any page. Right-click the page header (or click the ••• menu in the top bar) and select **"Pin to sidebar"**.

  4. Confirm the `Pinned` section appears at the bottom of the sidebar, collapsed.

  5. Expand the `Pinned` section and confirm the pinned page is listed.

  6. Click the unpin button on the pinned item (or use the context menu again) and confirm the `Pinned` section disappears.

- [ ] **Step 5: Final commit if any fixes were needed**

  If lint/type-check/manual verification required any follow-up fixes, commit them with a descriptive message. Otherwise, this task has no commit.

---

## Self-Review

**1. Spec coverage:**
- Move Pinned to bottom → verified/kept in Task 2.
- Default collapsed → Task 1, Step 1.
- Hide when empty → Task 1, Step 2.
- Add pin action to context menu → Task 3.
- No persistence changes → no store modifications.
- Mobile behavior identical → no mobile-specific code needed; same components.

**2. Placeholder scan:**
- No TBD/TODO.
- No vague "add error handling" or "write tests" steps.
- All file paths are exact.

**3. Type consistency:**
- `usePinnedPagesStore` selector shape matches existing store (`s.pinnedPages`, `s.togglePin`).
- `ActionName` and `DEFAULT_ACTIONS` use the same tuple shape as existing entries.
- `NodeContextMenu` switch case uses existing `ContextMenuItem` shape.

## Execution Handoff

Plan complete and saved to `2026-08-05-pinned-pages-sidebar.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach would you like?
