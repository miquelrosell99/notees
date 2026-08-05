# Design — Reposition and quieten the Pinned Pages sidebar section

## Problem

The `Pinned` section in the left sidebar competes for attention with persistent navigation lists (`Favorites`, `Recents`) even though pins are ephemeral session shortcuts. When no pages are pinned, the section header and empty-state message still consume space and add visual noise.

## Goals

- Reduce competition between `Pinned` and the persistent sidebar lists.
- Remove the empty-state waste when no pages are pinned.
- Keep pinning/unpinning accessible without relying on a permanently visible sidebar section.

## Design

### 1. Behavior

- Move `Pinned` to the **bottom** of the sidebar's scrollable content, below `Recents` (still inside the scrollable area, as the last section).
- Default the section to **collapsed**.
- Keep the section collapsed when pins are added; users expand it manually.
- When `pinnedPages.length === 0`, render **nothing** in the sidebar — no header, no empty message.
- Add **"Pin to sidebar" / "Unpin from sidebar"** to the existing page context menu (`NodeContextMenu` / `PageContextMenu`) so pinning remains accessible even when the sidebar section is hidden.

### 2. Visual layout

- Keep the existing section header and row styling (`sidebar-section-header-row`, `sidebar-pinned-item`, etc.).
- Position `SidebarPinnedPages` as the last child of `.sidebar-content`, sitting just above the mobile footer or the bottom of the desktop panel.

### 3. Data flow / state

- No changes to `usePinnedPagesStore` — pins remain per-session and are not persisted.
- `NodeContextMenu` gains a `pin` action (page-scoped) that calls `togglePin(node.uuid)`.
- `SidebarPinnedPages` conditionally renders the whole section based on `pinnedPages.length > 0`.

### 4. Mobile

- Identical behavior inside the mobile drawer.

### 5. Accessibility

- Preserve existing keyboard handling and screen-reader labels in `SidebarPinnedPages`.
- The new context-menu item gets a clear label: `Pin to sidebar` / `Unpin from sidebar`.

## Files affected

- `frontend/src/features/layout/components/Sidebar/NavigationSidebar.tsx` — reorder sidebar children so `SidebarPinnedPages` is last.
- `frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx`:
  - Default `expanded` to `false`.
  - Early-return `null` when `pinnedPages.length === 0`.
  - Remove or hide the empty-state message.
- `frontend/src/features/content/components/nodes/NodeContextMenu.tsx` — add a `pin` case to the action switch; read `pinnedPages` from `usePinnedPagesStore` to show the correct label/icon.
- `frontend/src/features/content/components/nodes/NodeContextMenu/actions.ts` — add `'pin'` to `ActionName` and to `DEFAULT_ACTIONS` as `['pin', 'page']`.
- `frontend/src/features/content/pages/NodeView.tsx` — no changes needed if it uses `DEFAULT_ACTIONS`; verify the top-bar and right-click `PageContextMenu` calls pick up the new action.

## Out of scope

- Persisting pins across reloads.
- Drag-reordering pins.
- Pinning non-page nodes.
- Changing the visual density of individual pinned rows.

## Verification

- `docker compose -f compose.dev.yaml exec frontend npm run lint`
- `docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit`
- Manual browser check:
  - With no pins, the `Pinned` section is absent from the sidebar.
  - Right-click a page header → "Pin to sidebar" appears and adds the page.
  - The `Pinned` section appears at the bottom, collapsed.
  - Expanding it shows the pinned page; unpinning removes it and hides the section again.

## Related documents

- `agents/plans/pinned-pages-sidebar.md` — original implementation plan for the pinned-pages feature.
