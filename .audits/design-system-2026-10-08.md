# UI Audit: Notees web app vs RosellRamos design system

Date: 2026-10-08 · Scope: `apps/web/src` (UI chrome, primitives, feature views)
· Method: four parallel read-only sweeps (color drift, interaction/a11y,
component library, typography/shape/responsive/theme/hygiene) against the
checklist in `references/audit-checklist.md`. Follow-up to the 2026-10-05
library audit recorded in `docs/developers/ui-primitives.md`.

Headline: the token-only CSS law holds app-wide (zero bare color literals in
component CSS; the drift gate enforces it), no `window.confirm/alert/prompt`,
no ad-hoc control clones, theme + accent selectors fully compliant. The drift
is concentrated in four places the gate does not cover: TS/canvas paint code,
px font-size/radius literals ≥10px, semantic-HTML substitutions, and one
press-scale token.

## Critical (must fix)

- [ ] `apps/web/src/ui/variables.css:202` — `--tactile-press-scale: 0.88`
  violates the 0.96–0.98 tactile-press rule and is consumed by the shared
  Button primitive (`components/ui/Button.css:41`), so every button press
  shrinks 12% (reads as a collapse, not a press). Peer primitives use
  in-band values (Pill 0.96/0.97, Card 0.95/0.99, NodeResultItem 0.98).
  → set the token to `0.96` and move the Pill literals onto the token.

## Warnings (should fix)

### Color / paint

- [ ] `apps/web/src/ui/views/graph/minimap.ts:64,73` — hardcoded
  `rgba(140,140,150,0.55)` / `rgba(90,90,100,0.9)`; the only theme-blind
  canvas paint in the app (dark gray viewport stroke on near-black ground in
  dark mode). Sibling `renderer/theme.ts` already resolves tokens via
  `getComputedStyle` — the minimap bypasses it.
  → add `--graph-minimap-dot` / `--graph-minimap-viewport` tokens (light+dark)
  and resolve them the way `renderer/theme.ts` does.
- [ ] `apps/web/src/ui/export-pdf/theme.ts:59-107` — 27 hardcoded hexes whose
  header comment claims they "mirror variables.css light tokens" but don't
  (`#f5f3ef` vs `#f7f4ec`, `#1a1a1a` vs `#221a13`, `#5c5c5c` vs `#5c544c`…).
  → align the constants to the token values, or correct the comment to say
  the export palette is intentionally independent.

### Interaction / accessibility

- [ ] `apps/web/src/ui/SettingsPanel.tsx:159-191` — hand-rolled settings
  modal: no Escape-to-close, no focus trap, no initial focus (has
  `role="dialog"`, backdrop click, close button).
  → compose from the `Modal` primitive (trap + overlay-stack Escape for free).
- [ ] `apps/web/src/ui/components/ui/ConfirmationModal.tsx:91` — renders
  `<h3 id="modal-title">` but never passes `title` to Modal, so the dialog
  gets no `aria-labelledby` — every destructive confirm is an unnamed dialog.
  → add an `ariaLabel`/`labelledBy` path to Modal, or pass `title`.
- [ ] No skip link anywhere, despite `--z-skip-link: 99999`
  (`variables.css:407`). → add "Skip to content" as the first focusable
  element of the app shell, targeting the editor region.
- [ ] `apps/web/src/ui/components/ui/Slider.css:129-132` — `:focus-visible`
  outline only for `::-webkit-slider-thumb`; Firefox keyboard users get no
  focus indicator. → add the `::-moz-range-thumb` focus rule.
- [ ] Loading-timing rule (<300ms nothing / 300ms–2s inline spinner / >2s
  skeleton) is not implemented — no delayed-visibility logic anywhere, so
  sub-300ms actions flash spinners. → add a `useDelayedVisible(loading, 300)`
  hook for inline spinner call sites; reserve LoadingSkeleton for >2s loads.

### Components

- [ ] `apps/web/src/ui/components/Sidebar.tsx:266-267` — sidebar rows are
  `<div role="button" tabIndex={0}>` with hand-rolled keyboard handling.
  → render a real `<button className="nt-side-item">`.
- [ ] `apps/web/src/ui/components/pickers/NodePill.tsx:74-89` — same
  `<div role="button">` pattern around the Pill markup. → real `<button>`.
- [ ] `apps/web/src/ui/components/Sidebar.css:128-132` — active row is
  `surface-container-high` with no accent indicator; active and hover are
  nearly indistinguishable. Spec: hover-fill + small accent signal.
  → add a ≤3px accent left-bar to the active row (Tabs-indicator treatment).
- [ ] `apps/web/src/ui/components/ui/ToggleSwitch.css` — no 44×44 touch-target
  floor (tracks are 24/30/38px; Button solves this with
  `--button-min-height` + the icon-only `::after` overlay, ToggleSwitch has
  no equivalent). → add min-height or an invisible hit overlay.
- [ ] `apps/web/src/ui/components/ui/TextField.css:19` — default field height
  38px, below the 44px touch floor. → raise default or record the density
  exception.
- [ ] `apps/web/src/ui/ThemeToggle.tsx:14-30` — topbar toggle is a legacy
  two-state dark↔light flip: no System/OLED awareness, bypasses
  `applyAppearance()`/`resolveTheme`, never broadcasts
  `notees-settings-changed`, so `data-oled` can go stale (Settings →
  Appearance itself is fully compliant). → make it delegate to
  `applyAppearance()` + `writeDeviceSetting`, or remove it.

### Typography / shape / elevation

- [ ] ~112 magic px `font-size` literals in 12 component/feature CSS files
  (heaviest: `ui/app.css` ~90 hits incl. 12.5px and 13.5px off the token
  scale; also `Sidebar.css`, `WorkspaceSwitcher.css`, `MetadataSection.css`,
  `WorkspacesView.css`, `classview/PropertyDefinitionsSection.css`, …). The
  drift gate only blocks <10px. → map each to the `--font-size-*` scale;
  consider extending drift test #3 to all px font sizes.
- [ ] 95 px `border-radius` literals outside variables.css (~75 in app.css),
  mostly duplicating token values — pure drift; `app.css:145` uses 9px, off
  the whole scale. → replace with `--shape-*` tokens; add a drift-test rule.
- [ ] `apps/web/src/ui/app.css:166` — `.nt-tab-active` (auth screen segmented
  tab) carries `box-shadow: var(--shadow-elevation-1)` on a static surface.
  → drop the shadow; background+color already signal state.
- [ ] `apps/web/src/ui/app.css:2452` — `.nt-wb-card` (whiteboard card) lifts
  with `--shadow-elevation-1`; only the page card (`PageCard.css:42`) is the
  sanctioned floating content card. → remove, or register as a second
  sanctioned exception in variables.css.
- [ ] `var(--token, literal)` fallbacks that would fire wrong if they ever
  fired, in shared/theme-agnostic rules: `SyncDetailsModal.css:39,55`
  (`#e05252`), `SectionViewTabs.css:85` and `GraphView.css:295` (`#b3261e`),
  `TopBar.css:175,184` (dark-theme values `#29b672`/`#f28b3f` in a
  theme-agnostic rule); plus production-firing raw shadow/shape fallback
  spans (`CardsBoard.css:108`, `GraphView.css:164,202,254`, `PageCard.css:42,
  97,204`, `app.css:36,62,93,115,1168,3014,3078`). All these tokens are always
  defined. → strip the literals (keep test-only fallbacks in fixtures) or
  move fallback injection into the test harness.
- [ ] px line-heights: `Sidebar.css:341` (`16px`), `Button.css:403`
  (`var(--spacing-4)` — a spacing token as line-height). → unit-less
  line-height or a type token.

## Notes (consider)

- [ ] `apps/web/src/ui/components/ui/Button.tsx:187-201` — anchor-rendered
  Button ignores `disabled`/`loading` functionally (styling only, no
  `aria-disabled`, no click guard). → add both.
- [ ] Focus style = hover style (no accent ring) on inline-edit cells
  (`views/TableView.css:170-174,342-347`, `components/MetadataSection.css:
  249-253`) and datepicker cells (`app.css:1912-1916,1936-1940`) — a
  deliberate "clean while editing" aesthetic; decide whether it's a recorded
  exception or strengthen focus-visible.
- [ ] `EmptyState.css:25,29-34` — title at full on-surface, description full
  opacity; the spec recipe asks on-surface-variant + ~60% subtitle.
- [ ] Popovers use `--shape-medium` (6px) in many places vs the 8px
  `--shape-floating-panel` spec value (`NodePills.css:22`,
  `WorkspaceSwitcher.css:49`, `AliasesButton.css:45`, …) — token-only, but
  locks popovers 2px under spec.
- [ ] `Pill.css:184-192` / `AddPill.tsx:1-6` — comments describe a dashed
  ghost affordance; the CSS is `border: none`. → restore dashed border or fix
  the comments. Also `Button.tsx:11` JSDoc advertises nonexistent
  `confirm`/`confirmMessage` props.
- [ ] Off-lattice breakpoints: `TopBar.css:136` (700px), `Sidebar.css:203`
  (800px), `PageCard.css:225` (1100px) vs the accepted 480/768/1024/1440.
  → nudge or record as sanctioned.
- [ ] `app.css:69-78` reduced-motion blanket also freezes the spinner keyframe
  (static arc remains, still announced via `role="status"`). → consider a
  text/progress fallback under reduced motion.
- [ ] `BlockRow.tsx:435,558` — click-to-edit `<div onClick>`; keyboard edit
  entry exists via the outliner focus-request path, so no capability is lost.
- [ ] Dead focus-suppression rules on non-focusable elements
  (`Modal.css:21-23`, `PresentationOverlay.css:19`, `app.css:648-649`,
  `NodePill.css:63`, `ImageModal.css:16`) — harmless; delete or comment.
- [ ] Enforcement gaps in `test/css-token-drift.test.ts`: CSS-only (no TS
  canvas paint), font-size gate only <10px, no px border-radius rule, no
  fallback-firing analysis. → extend the gate; the minimap literals are the
  live proof of the gap.
- [ ] `SectionViewTabs.css:62-86` — a 3-button manage row that could compose
  `Button variant="ghost" size="xs"`.
- [ ] Feature-level magic layout px (non-color, so the drift test doesn't
  catch them): `Sidebar.css` (11.5px/13px/30px/6px/28px), `TopBar.css:68-70`
  (18px), `app.css:1163` (6px 10px), `Slider.css:148` (3px) — per the
  adaptive-values law these should take the adaptive/token form.
- [ ] `app.css:944-945` — page header title stays Instrument Sans where the
  DS notes Noteees renders page titles in Newsreader; conscious in-code
  decision — record it or switch.

## Repository Hygiene

- [ ] AGENTS.md defers visual decisions to the design-system skill — PASS
- [ ] No hardcoded machine names / IPs / tailnet names in `apps/web/src`,
  `deploy/`, or `docs/` (placeholders per the fleet-agnostic law) — PASS
- [ ] About copyright `© {year} Miquel Rosell Tarragó`
  (`UserSettingsModal.tsx:871`) — PASS
- [ ] App name Title Case (`index.html:13` `<title>Notees</title>`) — PASS
- [ ] No `window.confirm/alert/prompt` anywhere — PASS
- [ ] No paywalls / upsells / feature gating — PASS
- [ ] Theme: Light/Dark/OLED/System in Settings → Appearance, persisted,
      system-respecting, accent swatch row + custom accent with live
      on-accent contrast recompute — PASS (topbar ThemeToggle is the
      exception, listed above)

## Verified passes (selected)

- Zero bare color literals in 127 component stylesheets; all 27 literal
  occurrences are `var()` fallbacks with defined tokens; the drift gate
  enforces this in CI. All `color-mix()` uses reference tokens only.
- Dark-mode accent surface tints are 4–13% `color-mix` per the stated intent;
  no heavy accent-tinted chrome.
- All 33 `outline: none` sites have replacement focus styles (accent 2px
  ring, underline, or parent focus-within).
- Disabled states: dimmed ~50%, `not-allowed` cursor, stay in layout
  (Button/TextField/BooleanToggle/ContextMenu).
- Modal: 28px radius, sheet drag handle 32×4 r2 muted, scrollable, backdrop
  + Escape (overlay-stack LIFO) + focus trap with restore; ContextMenu/
  Dropdown 8px floating panel, no shadow; Card 20px hairline no shadow;
  Button 16/12px radii + all five states; Pill/Badge token-clean.
- Live regions extensive and correct (30+ `role="alert"` sites, toasts with
  pause-on-hover, sync/graph/selection announcements); `aria-label` required
  at type level for icon-only buttons; touch-target floors on Button
  (44px min-height + invisible `::after` hit overlay).
- Global reduced-motion blanket + JS-level `useReducedMotion` + haptics
  gating.
- Newsreader confined to the editor reading context; JetBrains Mono only
  code/data; no font-family literals outside the token files.
- No decorative surface gradients; the four gradient uses are the standard
  loading shimmer and functional indicators, all token-colored.
