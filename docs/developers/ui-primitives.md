# UI primitives — the web client's component library

The web client (`apps/web`) composes **all chrome from one primitive library**:
`src/ui/components/ui/` — one reusable element per file, co-located CSS,
exported through the `index.ts` barrel. This page is the canonical reference
for that library (extracted from AGENTS.md, 2026-10-06); AGENTS.md carries only
the pointer and the law.

## The law

1. **Compose, don't clone.** No ad-hoc styled buttons, inputs, pills, or
   toggles in feature code. Need a new element? Extend the library — new
   primitive file + co-located CSS + barrel export.
2. **Token-only CSS.** Every value in library CSS resolves to a custom
   property from `src/ui/variables.css` — no hex literals, no hard-coded
   colors. (`var(--token, literal)` fallbacks must only fire when the
   custom properties are absent, e.g. tests — a fallback that always wins
   is a hard-coded color with extra steps.)
3. **Never mention legacy version names** in files, comments, or class
   names; provenance lives in git history.
4. **Popups compose `usePopupDismissal`** (§34.67): one dismissal layer —
   Escape (when the keydown didn't originate inside the popup) +
   pointer-down outside — so every picker/popover/menu closes the same way.
   (`usePopupDismissal.ts` lives in the library; overlay helpers and the
   sheet gesture seam sit beside it in `overlay-hooks.ts` /
   `sheetGesture.ts`.)

## Catalog

Inputs & buttons: `Button`, `Pill`/`AddPill`, `TextField`, `SearchField`,
`Dropdown`, `SelectTrigger`, `Checkbox`, `ToggleSwitch`, `BooleanToggle`,
`Slider`, `ColorButton`, `SelectionButton`, `ButtonWithPanel`,
`InlineConfirmButton`, `CodeTextarea`, `FileDropZone`.

Feedback & status: `Spinner`, `LoadingScreen`/`LoadingSkeleton`,
`DataStateView`, `EmptyState`, `NotificationToast` (+ `NotificationToaster`
and `notificationStore.ts`), `Badge`, `BackendUnavailableOverlay`,
`InProcessStoreBanner` (the §34.92 in-process-store warning bar).

Structure & surfaces: `Card`, `Tabs`, `Modal`, `ImageModal`,
`ConfirmationModal`, `ContextMenu`, `Separator`, `ErrorBoundary`,
`ListSortable` (+ the `useListDragSort` hook), `FloatingButtonArray`,
`PresentationOverlay` (§34.26 — the fullscreen presentation host: dark
stage, auto-hiding toolbar, edge zones, Esc/focus-trap, owned keymap).

Calendar: `MonthCalendar` (the month-grid panel), the top-bar
`CalendarPopup`, and `WeekStrip` all render over the shared
`calendar/dayGrid.tsx` day grid — calendar day cells stay one
implementation.

## Drift checks

The 2026-10-05 UI audit (Impeccable method) verified the library rule holds
across ~230 components — no ad-hoc clones found — and flagged the drift
classes to watch: undefined-token fallbacks (`var(--shadow-medium, rgba…)`
where the token doesn't exist), stray hex/rgba literals, and micro-text
below readable floors. Keep new primitives inside the token system; the
audit's M-findings are the backlog for existing drift.
