# UI Audit: Notees web app vs RosellRamos design system

Date: 2026-10-15 · Scope: `apps/web/src` (token architecture, canvas paint,
chrome/primitives, interaction, responsive, a11y, fleet hygiene) · Method:
§0 evidence greps of `references/audit-checklist.md` + four parallel
read-only sweeps, every finding re-verified against source. Follow-up to
`design-system-2026-10-08.md` (post token-migration slice; the register
`.agents/design-overrides.md` now carries 5 entries).

Headline: the color system is fully single-track and machine-gated — zero
bare color aliases, zero hex outside the token file, all canvas paint
resolves tokens via `getComputedStyle` with plain-hex canvas tokens, and the
`css-token-drift` vitest gate (5 rules, incl. fallback-firing analysis) runs
in CI. The 10-08 Critical (press-scale 0.88) and all spot-checked 10-08
warnings (skip link, unnamed ConfirmationModal, theme-blind minimap,
legacy ThemeToggle, div-role-button rows, ToggleSwitch/TextField touch
floors, px line-heights) are fixed. What remains is concentrated in three
undocumented shape/elevation deviations (all owner-commented in code, none
in the override register → drift by contract), interaction-state gaps on a
handful of primitives, and the loading-delay rule existing only for buttons.

## Resolutions (2026-10-15, same-day follow-up slice)

Every finding below shipped in one pass (changelog entry
"feat(web): the 2026-10-15 design-system audit findings closed in one
pass"):

- Critical 1 (transparent sidebar) → **registered** as a decision in
  `.agents/design-overrides.md` ("The sidebar is a transparent 'chrome on
  canvas' navigator"), together with the state-driven navigator responsive
  ruling (no rail at 1024).
- Critical 2 (12px dialog radius) → dialogs now render `radius="xl"`
  (28px `--shape-sheet`); the 12px tier keeps non-dialog floating chrome.
- Critical 3 (static panel shadows) → `box-shadow` removed from
  `.nt-page-side-panel` / `.nt-page-context`.
- Warnings → all fixed: stale `#141414` header comment; `--shape-button:
  16px` tier added; ~24 em font sizes mapped to tokens with drift-gate
  check 6 banning new ones (four adaptive sites allowlisted); DataStateView
  delay-gated; pressed states on icon buttons / sidebar rows / chips /
  sortable rows; chip selected-hover distinct + 600 labels; graph-stage and
  Dropdown focus rings restored; touch floors on propicon / sync-dot /
  hover-reveal (with `(hover: none)` fallback) + sync-pulse reduced-motion
  guard; media syntax normalized to range form, unused breakpoint tokens
  dropped; appearance seam unified behind `src/ui/appearance.ts` with the
  `appearance-bootstrap-parity` test gating both writers.
- Skill-side (rosellramos-design-system): `audit-checklist.md` §0 gains the
  em-font-size grep, the gate-forms note (vitest files are gates — don't
  conclude "no gate" from CI workflows alone), and the pre-paint-bootstrap
  seam check; §1 names the bootstrap exception; `web-patterns.md` documents
  the em-allowlist closure and the appearance-bootstrap parity pattern.

## §0 Evidence sweep

- `grep -rn -- "--color-" src/` → **zero** ✓
- bare alias grep (`var(--accent-color|primary|surface|…)` without `-md-sys-` prefix) → **zero** ✓
- hex literals in component CSS outside `variables.css` → **zero** ✓ (gate test 2 independently enforces)
- canvas paint: all 5 `fillStyle`/`strokeStyle` hits trace to `graphTheme()`
  (`views/graph/renderer/theme.ts:82-95`, `getComputedStyle` + one-hop alias
  chase + plain-hex regex gate) or direct `--graph-*` token reads; the
  `--graph-minimap-*` literals flagged 10-08 are now tokens
  (`variables.css:858-865`); accent presets set plain-hex primary
  (`#6da789` etc.) so the resolver regex holds in production ✓
- drift gate: `apps/web/test/css-token-drift.test.ts` runs under `pnpm test`
  in CI ✓ — covers undefined tokens, bare color literals, px font-size, px
  border-radius, and color-literal fallbacks. Blind spots: TS/canvas paint
  (currently clean by inspection, not by gate) and **em-based font sizes**
  (live gap, see Warnings).

## Critical (must fix)

Per the overrides contract, a deviation with an in-code owner comment but no
register entry audits as drift. Each of these is a one-line register
addition (or a revert), not a redesign.

- [ ] `apps/web/src/ui/components/Sidebar.css:15` — `.nt-sidebar` is
  `background: transparent` ("chrome on canvas" shell, owner-commented in
  the file header). Rule: solid sidebar on the ground, hairline separated;
  the card-on-backdrop exception keeps the sidebar solid too. Not in
  `.agents/design-overrides.md`. → register the transparent-navigator
  shell as a decision (it is coherent with the canvas-forward product), or
  give it a surface fill.
- [ ] `apps/web/src/ui/components/ui/Modal.tsx:269` +
  `components/ui/Card.css:63-68` — dialogs render at radius 12px
  (`--shape-extra-large`), not the 28px sheet/dialog spec; owner ruling
  2026-10-09 lives only in a CSS comment. → register the "floating chrome
  gets subtler corners" ruling (sheets are correctly 28px at `Modal.css:55,69`).
- [ ] `apps/web/src/ui/app.css:520,565` — `.nt-page-side-panel` /
  `.nt-page-context` are static panel cards carrying
  `box-shadow: var(--shadow-elevation-1)`; zero-noise rule: static cards
  shadow none, depth via surface-step + hairline. → drop the shadow (border
  + surface-step already separates) or register.

## Warnings (should fix)

### Color / tokens

- [ ] `apps/web/src/ui/variables.css:16` — header comment still claims the
  dark ground is `#161412`; the actual tint base is `#141414` (the override
  "The night is seed-tinted" implements 4–13% mixes on it, `:714-738`).
  → fix the comment.
- [ ] No 16px button-radius tier: the spec's 16/12/10px button scale ships
  as 12/10 only (`--shape-button-small: 12px`, `--shape-button-compact:
  10px`, `variables.css:336-338`). Buttons pass at 12px, but the tier is
  absent if a large-button need arises. → add `--shape-button: 16px` or
  record the deviation.
- [ ] ~20 non-token font sizes in **em** (`app.css:1625/2073/2330/2339/2358/
  2387/2427/2442/2534/2599`, `SyncDetailsModal.css:29/50/56/93/98`,
  `NodeSelector.css:149/392`, `GridMenu.css:87`, `settingsModal.css:449`).
  The drift gate blocks px font sizes only, so these bypass it. → map to the
  `--font-size-*` scale and extend gate test 3 to em literals.

### Interaction

- [ ] `apps/web/src/ui/components/ui/DataStateView.tsx:76-81` — renders
  `LoadingSkeleton` the instant `isLoading` is true; `useDelayedVisible`
  (`components/ui/useDelayedVisible.ts:11`) exists but its only consumer is
  `Button.tsx:121`. Sub-300ms fetches flash shimmer. → delay-gate skeleton
  views (300ms) per the loading-timing rule.
- [ ] Missing `:active`/pressed layer on dominant controls: `.nt-icon-btn`
  (`app.css:407-423`), `.nt-side-item` (`Sidebar.css:111-132`), `.chip`
  (`Chip.css:4-33`), `.list-sortable__item` (`ListSortable.css:18-49`) have
  hover/focus but no press treatment. → add the pressed overlay / 0.96–0.98
  scale per the tactile map.
- [ ] `apps/web/src/ui/components/ui/Chip.css:31-33` — `.chip--on:hover`
  re-declares the identical `primary-container` background as the rest
  state: selected and hovered are visually indistinguishable. → give the
  selected chip a distinct hover step.
- [ ] `apps/web/src/ui/components/ui/Chip.css:14` — chip label weight
  inherits 400; spec is 11–12px/600. → set 600 (or record).

### Accessibility

- [ ] `apps/web/src/ui/views/graph/GraphView.css:106-108` —
  `.nt-graph__stage:focus-visible { outline: none }` with a comment as the
  only "replacement" — the canvas has no visible focus indication. → add a
  token focus ring on the stage wrapper.
- [ ] `apps/web/src/ui/components/ui/Dropdown.css:127-129` — search input
  kills outline and box-shadow on focus-visible; only an
  outline→outline-variant border shift remains (low contrast). → keep the
  global `--shadow-focus-ring` treatment.

### Responsive

- [ ] No rail at 1024: the sidebar is state-toggled at every width
  (`Sidebar.css:240-256`), drawer below 768, and the only 1024 adaptation
  is hiding the right card (`PageCard.css:254`). Spec: sidebar → rail at
  1024. → either implement the rail morph or record the state-driven
  navigator as the sanctioned adaptation.
- [ ] `--breakpoint-wide: 1440px` (`variables.css:603`) is never used in any
  media query; media syntax mixes `(width <= 768px)` range and
  `(max-width: 768px)` notation. → use the token or drop it; pick one syntax.
- [ ] Touch-target floors on small chrome: `.nt-propicon` 20px
  (`components/PropertyIconButton.css:22-23`), `.nt-sync-dot` ~21px
  (`components/TopBar.css:176-181`), `HoverRevealButton` 24×24 with no
  `@media (hover: none)` fallback (`components/ui/HoverRevealButton.css:17,37`).
  → invisible hit-area overlay (the Button `::after` pattern) or record the
  desktop-density exception.

### Appearance seam

- [ ] `apps/web/index.html:42,51,61` — the pre-paint anti-FOUC bootstrap
  independently writes `data-theme`/`data-oled`/`data-accent` with its own
  duplicated theme-resolution logic, alongside the single runtime writer
  `applyAppearance()` (`components/modals/deviceSettings.ts:144-176`).
  → extract the resolution into one shared module both sites import, so the
  bootstrap can never drift from the settings writer.

## Notes (consider)

- [ ] The `--graph-*` token family (`variables.css:153-176,858-882`) is a
  controlled satellite color track (canvas plain-hex tokens, minimap
  viewport rides the seed) — legitimate per the canvas rule; keep it on the
  audit watch list so it never grows a second accent track.
- [ ] `ui/export-pdf/theme.ts:65-115` + `pdfDocument.tsx:394,397` — hardcoded
  PDF palettes by necessity (react-pdf has no stylesheet access), documented
  in-file; fine, but re-sync values if the light tokens move.
- [ ] `ui/components/ui/colorPresets.ts:30-39` / `modals/deviceSettings.ts:93-97`
  — preset hex bridges (user data + swatch previews), mirroring
  `--md-sys-color-preset-*`; acceptable, single-sourced per preset.
- [ ] Dark accent on-primary pairs: `#fff` on light Margin Green `#2e5e46`
  and Blue `#3d6a96` passes 4.5:1; brown's light on-primary is `#000` on
  `#a16b45` ✓; dark-theme on-primaries on tinted grounds pass. Consider a
  contrast assertion in CI if the picker ever opens to custom seeds.
- [ ] Font-size scale has both `--font-size-*` px-rem tokens and a parallel
  em-based ad-hoc tier (see Warnings) — consolidating would halve the
  drift surface.

## Repository Hygiene

- [ ] AGENTS.md defers visual decisions to the design-system skill, names
  the override register — PASS
- [ ] Override register exists (`.agents/design-overrides.md`, 5 entries:
  seed-tinted night, primary-container active states, brand accent presets,
  settings-as-page, chrome button registers) — PASS; the three Criticals
  above are the register's missing entries
- [ ] Token-drift gate in CI (`apps/web/test/css-token-drift.test.ts` via
  `pnpm test`, rules 1–5 incl. fallback-firing) — PASS, with the em-font-size
  blind spot noted above
- [ ] Canvas paint audit — PASS (all hits token-resolved; test-only
  fallbacks per the sanctioned pattern)
- [ ] No embedded privacy-policy documents (the Privacy card is a
  statement, `SettingsPage.tsx:762-767`), no secrets, no paywalls/subscription
  gating — PASS
- [ ] App name Title Case + `© {year} Miquel Rosell Tarragó` in About
  (`SettingsPage.tsx:744-755`) — PASS
- [ ] `dist/` gitignored (repo-global) — PASS
- [ ] Theme Light/Dark/OLED/System + 5-swatch accent picker, persisted,
  one runtime writer (`applyAppearance`), pre-paint bootstrap excepted above
  — PASS-with-note

## Verified passes (selected, since 2026-10-08)

- `--tactile-press-scale: 0.96` (`variables.css:224`); the 10-08 Critical is
  closed.
- Skip link first in shell (`App.tsx:2053`, reveal at `app.css:86-104`);
  every dialog labelled (`Modal.tsx:271-274`, `aria-labelledby` /
  `aria-label` fallback; ConfirmationModal requires `title`).
- Minimap/graph canvas fully token-driven (`--graph-minimap-dot/viewport`
  light+dark, viewport rides primary via the one-hop resolver).
- TopBar ThemeToggle delegates to `applyAppearance()` (`ThemeToggle.tsx:22`).
- Sidebar rows, NodePill render real `<button>`; ToggleSwitch and TextField
  meet the 44px floor via `max(100%, --button-min-height)` / `--height-xl`.
- EmptyState matches the recipe (muted icon `--opacity-30`, title token,
  subtitle `--opacity-60` at 40ch, single accent CTA).
- Sidebar active row = hover fill + 3px left accent bar (`Sidebar.css:136-153`);
  Card 20px hairline shadowless at all elevations; Button six variants with
  full state set + type-enforced icon-only `aria-label` + honest
  anchor-disable (`aria-disabled`, guarded click).
- Semantic M3 role families complete (primary→presentation-stage, state
  overlays 4/8/12% light, 5/8/12% dark); five accent presets each set only
  `primary`+`on-primary`, every derived role `color-mix`es from them — no
  per-preset duplication; error/warning/success fixed across presets; pure
  `#000` confined to OLED; `color-scheme` per theme.
- 432/460 border-radius hits via `var()`; the 28 non-var are `50%`/`0`
  geometric constants; zero raw-px radii, zero px line-heights.
- Live regions, focus trap + overlay-stack Escape + backdrop dismiss,
  global 2px primary focus outline, reduced-motion blanket + `useReducedMotion`
  + haptics gating — all present.
