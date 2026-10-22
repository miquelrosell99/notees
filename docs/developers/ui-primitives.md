# UI primitives — the web client's component library

The web client (`apps/web`) composes **all chrome from one primitive library**:
`src/components/ui/fleet/` — one reusable element per file, co-located CSS,
exported through the `index.ts` barrel. This page is the canonical reference
for that library (extracted from AGENTS.md, 2026-10-06; the path corrected to
the fleet tree realignment, 2026-10-20); AGENTS.md carries only
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
pill — filter families, group toggles), `TextField`, `SearchField` (`md`
by default on full surfaces; `size="sm"` on compact chrome rows and
anchored picker popovers — NodeSelector, the bind-property picker, and the
template-list popup; inside an anchored picker panel the panel margin is
the horizontal padding, so the placeholder joins the result-row label
grid), `Input` (the boxed text field — the SelectTrigger register applied
to a native `<input>`; pairs with `Dropdown` in dense condition/toolbar
rows),
`Dropdown`, `SelectTrigger`, `Checkbox`, `Radio` (the checkbox variant's
single-selection sibling — groups compose by sharing a `name`),
`ToggleSwitch` (owner ruling 2026-10-21: enabling/disabling a SETTING
only — never mode/view switching; that rides the bordered
`SelectionButton`, whose container's background can sink into a
same-token panel surface and need the one-step container-token nudge),
`BooleanToggle`,
`Slider`, `ColorButton`, `SelectionButton` (owner ruling 2026-10-21: THE
control for mutually-exclusive MODE/VIEW switching — AND/OR, Blocks/Raw,
outline/cards/table — the bordered button switcher the ViewSwitcher
rides; `ToggleSwitch` is the settings idiom, not this), `ButtonWithPanel`,
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
for a native action list (the node menu's Copy › / Convert to page ›): the
submenu FLIES OUT to the side of the parent row as a second card — never
expands inline, which used to grow the menu's box and re-fit it on open —
riding flush against the menu edge (no overlap — enter-only hover needs
  no bridge), aligned to the
parent row's top, flipping left at the viewport edge, clamped vertically;
subitems fire their own onClick, then close the whole menu unless
`keepOpen`, and stay out of the arrow-key walk; the panel opens on hover
over the parent line on pointer-fine devices — the tap stays the explicit
toggle on touch — and the chevron rides the icon-role token, never the
outline border token), `Separator`, `ErrorBoundary`, `ListSortable` (+ the
`useListDragSort` hook), `FloatingButtonArray`,
`SurfaceTopBar` (the in-card top bar for full-bleed hub surfaces, owner
2026-10-22: icon + title + muted count + context + right-aligned actions,
pinned above the surface's card-border scrolling body — every hub view
composes it instead of a hand-rolled header),
`PresentationOverlay` (the fullscreen presentation host: dark
stage, auto-hiding toolbar, edge zones, Esc/focus-trap, owned keymap).

Calendar: `MonthCalendar` (the month-grid panel), the top-bar
`CalendarPopup`, and `WeekStrip` all render over the shared
`calendar/dayGrid.tsx` day grid — calendar day cells stay one
implementation.

## Drift checks

The 2026-10-19 shadcn-alignment slice (owner ruling: "full shadcn
alignment and implementation") added the catalog layer and the class half
of the gate. **The catalog** (`src/components/ui/`, 22 normalized
components — button, input, textarea, label, card, dialog, alert-dialog,
tabs, switch, checkbox, radio-group, badge, select, dropdown-menu,
popover, tooltip, separator, skeleton, scroll-area, command, spinner,
slider): shadcn new-york sources normalized to the tokens per the fleet
bridge checklist —
theme-key utilities only, fleet radii (buttons corner-full at every size
per the 2026-10-19 ruling), hover = state-layer overlay through the
`--accent` alias, focus ring from `--ring`, chrome icons on the fleet
`Icon` primitive. Tailwind is the implementation layer
(`tailwind.config.ts` maps every cited utility to a token; preflight stays
OFF, a base-layer `border-style: solid` stands in for the one preflight
fact the utilities need). The six fleet primitives (Button, TextField,
Card, Tabs, ToggleSwitch, Modal) are thin wrappers composing the catalog —
full prop APIs preserved, their CSS retired (Tabs.css keeps the
sliding-indicator register, Modal.css the sheet/overlay chrome; legacy
`btn`/`card` marker classes stay where feature CSS compounds on them).
The leaf sweep (same day, full-alignment stage) migrated the remaining
catalog-covered leaves to the same thin-wrapper architecture — Badge,
Separator, Spinner, LoadingSkeleton, Checkbox, Radio, Input, SearchField,
BooleanToggle, Slider, CodeTextarea, SelectTrigger — with their
stylesheets retired (Spinner/SearchField keep only the reduced-motion,
hit-area-floor, and wrapper-focus-ring CSS the utility layer can't
express; the tailwind config grew the registered keys they ride:
min-w/icon/sep/skeleton/shimmer/spinner-arc/slider/inset-ring/error-ring/
shape radii). **Dropdown and ContextMenu are the two composites still
custom** — documented in `.agents/design-overrides.md` with a scheduled
migration (combobox / context-menu-sub compositions), not silent drift.
New catalog-covered work composes `src/components/ui/`; the drift gate's
class
half (checks 8–11) enforces the same token discipline on class strings:
no default-palette utilities, no raw radii outside the registered family,
no arbitrary values/default shadows/default durations, and a
registered-mapping check proving every catalog utility resolves to a
config key. The bridge fixture (`/__design-bridge-fixture` +
`e2e/bridge-fixture.spec.ts`, Playwright) proves computed behavior across
themes and accent switches — token resolution, contrast, the hover
register, the focus ring, disabled dimming, `aria-busy`, dialog elevation.

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
