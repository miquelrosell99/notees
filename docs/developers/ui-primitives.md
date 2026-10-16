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
4. **Color tokens are Material You roles, single track.** Every color is a
   `--md-sys-color-*` custom property (`primary`, `on-primary`,
   `primary-container`, `on-primary-container`, `secondary`, `tertiary`,
   `error`, the `surface`/`surface-container` family, `outline`,
   `inverse-*`, …) defined ONLY in `variables.css`. The selected accent IS
   the primary role: the `[data-accent]` blocks set just
   `--md-sys-color-primary` + `--md-sys-color-on-primary`, and
   `primary-container` / `on-primary-container` / `primary-hover` /
   `primary-pressed` / `inverse-primary` derive from them via `color-mix`
   in the theme blocks — there is no second accent track and no legacy
   color alias. New colors extend the role list in `variables.css`; they
   never appear as literals in component CSS.
5. **Popups compose `usePopupDismissal`**: one dismissal layer —
   Escape (when the keydown didn't originate inside the popup) +
   pointer-down outside — so every picker/popover/menu closes the same way.
   (`usePopupDismissal.ts` lives in the library; overlay helpers and the
   sheet gesture seam sit beside it in `overlay-hooks.ts` /
   `sheetGesture.ts`.)
6. **Adaptive values over hard-coded numbers.** When a value tracks type
   metrics or layout, write the adaptive form, never a fixed literal:
   `1lh` / `em` / `ch` / `%` for anything line- or glyph-sized, the
   spacing, radius, and motion tokens for rhythm and chrome, and
   `clamp()` / `min()` / `max()` for bounds. A hard-coded px number is a
   silent contract with today's font metrics and viewport — the moment the
   type scale or density shifts, the value lies (an empty text line
   collapsing to zero height and losing its click target is the canonical
   casualty). Fixed px is right only where the dimension is genuinely
   constant: border hairlines, icon canvases, tap-target floors. The drift
   gate (`css-token-drift.test.ts`) enforces the font-size slice of this
   rule.

## Catalog

Inputs & buttons: `Button`, `Pill`/`AddPill`, `Chip` (the single-toggle
pill — filter families, group toggles), `TextField`, `SearchField`,
`Dropdown`, `SelectTrigger`, `Checkbox`, `Radio` (the checkbox variant's
single-selection sibling — groups compose by sharing a `name`),
`ToggleSwitch`, `BooleanToggle`,
`Slider`, `ColorButton`, `SelectionButton`, `ButtonWithPanel`,
`InlineConfirmButton`, `CodeTextarea`, `FileDropZone`,
`HoverRevealButton` (the hover-reveal affordance: zero footprint at rest —
collapsed width + faded out — expanded on hover of the surrounding
`.ui-hover-reveal-group`, on keyboard focus, or while an anchored popup is
open via `aria-expanded` on the trigger; the topbar undo cluster's history
chevron and the breadcrumb trails' parent-edit chevron compose it — the
trails were the pattern's origin).

Feedback & status: `Spinner`, `LoadingScreen`/`LoadingSkeleton`,
`DataStateView`, `EmptyState`, `NotificationToast` (+ `NotificationToaster`
and `notificationStore.ts`), `Badge`, `BackendUnavailableOverlay` (the
backend-down ladder: dismissible banner → lock with a "Continue anyway"
escape → persistent banner), `InProcessStoreBanner` (the
in-process-store warning bar).

Structure & surfaces: `Card`, `Tabs`, `Modal`, `ImageModal`,
`ConfirmationModal`, `ContextMenu` (two submenu forms on one primitive —
`submenu` for custom content (the whiteboard color row) and `submenuItems`
for a native action list (the node menu's Copy › / Convert to page ›):
subitems render indented with the item styling, fire their own onClick,
then close the whole menu unless `keepOpen`, and stay out of the
arrow-key walk; the submenu opens on hover over its parent line on
pointer-fine devices — the tap stays the explicit toggle on touch — and
the chevron rides the icon-role token, never the outline border token), `Separator`, `ErrorBoundary`, `ListSortable` (+ the
`useListDragSort` hook), `FloatingButtonArray`,
`PresentationOverlay` (the fullscreen presentation host: dark
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
below readable floors. Keep new primitives inside the token system.

The 2026-10-08 design-system audit fixed that drift and extended the gate
(`css-token-drift.test.ts`, 6 checks): **(1)** every `var(--token)` names a
defined token (or the JS-scoped allowlist), **(2)** no bare color literal
outside the defining files, **(3)** no px `font-size` at all outside the
defining files (the scale is rem-token based), **(4)** no px
`border-radius` outside the defining files (the `--shape-*` scale owns
corners), **(5)** no color literal inside a `var()` fallback (a fallback
that always wins is a hardcoded color; honest fallbacks are `var()` chains
or unitless defaults like `0`/`1`), **(6)** no `em` `font-size` outside the
defining files except the allowlisted adaptive sites (`EM_FONT_SIZE_ALLOWLIST`
— heading scale source, inline code, deck density multipliers; each entry
self-checks it still uses em). The gate is CSS-only — TS canvas/paint
code stays ungated, so token resolution in canvas code (the
`views/graph/renderer/theme.ts` pattern) is a code-review duty.

The 2026-10-15 design-system audit (report in `.audits/`) closed its
findings in the same pass: the three undocumented deviations registered or
reverted (transparent "chrome on canvas" sidebar → override register;
dialogs at the 28px `--shape-sheet` radius; static page-panel shadows
removed), the loading-timing rule implemented for data views
(`DataStateView` rides `useDelayedVisible`), pressed states on the quiet
chrome controls, the touch-floor overlays, and the appearance seam unified —
`src/ui/appearance.ts` is the one resolver, the index.html pre-paint
bootstrap mirrors it, and `test/appearance-bootstrap-parity.test.ts` gates
the two against each other across a scenario matrix.
