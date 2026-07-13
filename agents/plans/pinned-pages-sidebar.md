# Plan — Per-session pinned pages sidebar section

Status: implemented (pending browser verification).

## Goal

Add a non-persisted "Pinned" section below Favorites and Recents in the left sidebar, with a
pin/unpin toggle for the current page in its header, plus a favorite toggle for the current page
in the Favorites header.

## Implementation

- `frontend/src/stores/pinnedPagesStore.ts` — new Zustand store without `persist` middleware
  (per-session by construction): `pinnedPages: string[]`, `pinPage` / `unpinPage` / `togglePin`.
  Exported from `frontend/src/stores/index.ts`.
- `frontend/src/features/layout/components/Sidebar/SidebarPinnedPages.tsx` — new section
  mirroring `SidebarRecents` (collapsible, `NodeBreadcrumbs` + `NodeInline` items, context menu),
  with:
  - header row (`sidebar-section-header-row`) holding the expand button and a right-side
    pin toggle (`mdi mdi-pin` / `mdi mdi-pin-outline`), shown only when the opened node is a page
    (`mainViewType === 'node'` + `node.is_page` via `useNodeByUuid(currentNodeUuid)`);
  - per-item hover-reveal unpin button and auto-unpin on 404 (mirrors favorites' stale-item
    cleanup).
- `SidebarFavorites.tsx` — header restructured into the same row layout with a right-side star
  toggle (`mdi mdi-star` / `mdi mdi-star-outline`) wired to `useAddFavoriteMutation` /
  `useRemoveFavoriteMutation`, shown only when the opened node is a page.
- `NavigationSidebar.tsx` — renders `<SidebarPinnedPages>` after `<SidebarRecents>`, reusing
  `handleFavoriteContextMenu`.
- `NavigationSidebar.css` — new `.sidebar-section-header-row` / `.sidebar-section-action` rules;
  existing favorites/recents item selectors extended with `.sidebar-pinned-*` counterparts.
- `frontend/src/components/ui/icons.tsx` — new `PinIcon` wrapper (sprite already ships `mdi-pin`).
- `frontend/src/tests/pinnedPagesStore.test.ts` — store unit tests (idempotent pin, order,
  unpin, toggle).

## Verification

- `docker compose -f compose.dev.yaml exec frontend npm run lint`
- `docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit`
- `docker compose -f compose.dev.yaml exec frontend npm run test:run -- pinnedPagesStore`
- Browser: pin/unpin from the Pinned header, favorite toggle in the Favorites header, pins survive
  navigation but reset on reload.

## Out of scope

Persisting pins across reloads, drag-reordering pins, pinning non-page nodes.
