# Design overrides — Notees

Per-project override register for the RosellRamos design system (contract:
`rosellramos-design-system` → `references/overrides.md`). Every deviation from
the skill's defaults/foundations is recorded here; an undocumented deviation
is drift, a documented one is a decision. Newest first. Entries bind until the
rule they override changes, the review trigger fires, or the owner re-rules.

### Floating context menus ride the raised chrome surface, not base surface
- **Rule**: foundations — cards/sheets/dialogs ride `surface-container-low` → `-high` as the surface gets more transient; the elevation table gives popovers/menus a level-1 shadow; this app's Card zeroes every elevation level ("zero visual noise"), so floating layers carry no shadow.
- **Decision**: the context menu (and its flyout submenu) rides `--md-sys-color-sidebar-card` — the same raised chrome step the nodeview sidebars use (`surface-container-highest` in the dark theme) — instead of the base-card `surface`. The most transient surface in the app takes the top of the container ladder.
- **Rationale**: with elevation shadows banned app-wide, a floating menu over the page card had nothing to separate it — base `surface` (≈8% primary tint) over the page surface read as one wash ("menus get lost over the background color", owner 2026-10-16). With no shadow to do the work, the surface step must carry the whole separation; the owner directed the sidebar color explicitly.
- **Scope**: the context menu root and its flyout submenu only (the sole `radius="floating"` consumers). Modals ride their own scrim-backed register; pickers were not part of the ruling.
- **Ruled**: owner 2026-10-16.
- **Review trigger**: the shadow ban lifting (elevation levels regain shadows), or a contrast finding that the raised step still blends on some backdrop.

### Calendar and date-grid cells ride the panel width, not the 44px floor
- **Rule**: audit-checklist §9 — touch targets ≥44×44px on every interactive control.
- **Decision**: calendar day cells, week-strip cells, and month/year picks size from the grid that contains them (`aspect-ratio: 1` / the strip height), computing ≈36–40px in the fixed 320px side panel — no invisible overlay. The grid is the control: forcing 44px cells would overflow the panel or drop columns.
- **Rationale**: a date grid's hit geometry is inseparable from its column width; the panel itself is chrome-adjacent (a secondary surface), and each cell carries a full-date `aria-label` + `aria-pressed` for the selected day.
- **Scope**: calendar grids (calendar-grid, MonthCalendar, WeekStrip) and datepicker cells.
- **Ruled**: registered 2026-10-15 (unswept-surfaces pass) after the sweep found the density unregistered.
- **Review trigger**: a touch-usability finding on the calendar, or a layout change that widens the panel.

### The context column rides a dense type register
- **Rule**: audit-checklist §7 components — list rows primary 14px/600, secondary 12px muted.
- **Decision**: the narrow context column (Activity log, Version history, Comments, Property history) renders rows at 12px/400 primary with 10px secondary stamps — one step under the list-row spec, by design for the ~340px rail.
- **Rationale**: the row spec assumes content-width surfaces; these feeds live in the right rail beside the page card, where 14px/600 rows would wrap aggressively and crowd the content they annotate.
- **Scope**: the context-column feeds only — full-width surfaces keep the 14px/600 register.
- **Ruled**: registered 2026-10-15 (unswept-surfaces pass).
- **Review trigger**: the context column widening, or a readability finding against the dense register.

### Hover is the state-layer overlay everywhere; primary-container is selected/active only
- **Rule**: audit-checklist §6/§5 — hover feedback per the state-layer idiom; the skill's accent usage table leaves hover unspecified; the pre-ruling codebase mixed three hover fills (`hover-overlay`, `surface-container-high`, `surface-container-high/est`) and used `primary-container` as a hover fill on some rows.
- **Decision**: every hover background is `--md-sys-color-hover-overlay` (22 stylesheets, owner ruling 2026-10-15); `primary-container` appears only on selected/active chrome (the existing register entry) — never on hover. Controls that are ALREADY active keep their active fill while hovered (combined `--active, --active:hover` rules; the active identity is not washed away). Structural hover that is not a fill (e.g. the support-channel card's border raise) is unaffected.
- **Rationale**: one hover register to learn; the filled hover read as heavy mid-prose and blurred the selected/active signal.
- **Scope**: global (all `:hover` fills). Buttons' default/outline/base variants included (overlay over their transparent rest).
- **Ruled**: owner 2026-10-15 (re-audit carried-forward Notes discussion).
- **Review trigger**: an interaction finding that the overlay hover is too quiet on a specific surface.

### Inline row chrome rides a 22px tap floor, not 44px
- **Rule**: audit-checklist §9 — touch targets ≥44×44px on EVERY interactive control, via an invisible hit-area overlay where the visible control must stay compact.
- **Decision**: the editor's inline row chrome (the condensed layer's stretch/badge/condense buttons, the collapse chevron, and cousins) carries a 22px minimum with `touch-action: manipulation`, no invisible overlay. An overlay around inline prose chrome would intercept text-selection drags and neighboring glyph taps.
- **Rationale**: in-code owner idiom ("Tap-target floor (the narrow-screen law) — the row chrome idiom", app.css, 2026-10-15 condensed slice); these controls sit mid-sentence inside content rows where a 44px zone is a text-editing hazard, and each has a keyboard-equivalent or larger sibling path. Registered 2026-10-15 after the re-audit found the idiom undocumented.
- **Scope**: editor/content row chrome only — chrome controls in panels, bars, and popovers (propicon, sync dot, hover-reveal, toasts, pills) DO carry the 44px floor and are not covered by this entry.
- **Ruled**: owner in-code (condensed slice), registered 2026-10-15 (re-audit).
- **Review trigger**: a touch-usability finding against the row chrome, or a fleet ruling that no interactive control may go below 44px under any circumstances.

### The sidebar is a transparent "chrome on canvas" navigator- **Rule**: rosellramos-design-system default 3 (solid sidebar on the ground, hairline separated; the card-on-backdrop exception still keeps the sidebar solid).
- **Decision**: `.nt-sidebar` carries no surface fill (`background: transparent`) at any width — the app background hosts the chrome directly, separated from content by a hairline rule; the sidebar reveals/hides via the TopBar hamburger at every width (below 768px it becomes a fixed overlay drawer with a real surface + shadow). Related responsive ruling: the navigator is **state-driven at every width** — there is no rail morph at 1024 and no 1440-wide adaptation; sidebar adaptation is drawer-below-768 only.
- **Rationale**: the workspace canvas is the hero of a knowledge environment; a filled sidebar panel would partition the ground and compete with the content cards it navigates. Hamburger-at-every-width keeps one navigator behavior to learn.
- **Scope**: global (app shell).
- **Ruled**: owner 2026-10-09 shell design, registered 2026-10-15 after the design-system audit found the deviation undocumented.
- **Review trigger**: a fleet-wide ruling on shell layouts, or an adaptiveness finding against the missing rail.

### The night is seed-tinted
- **Rule**: rosellramos-design-system default 2 (warm near-black ground, monochrome surfaces) + foundations.md §2 (surface neutrals are near-gray).
- **Decision**: the dark theme's background/surface/outline family derives from `--md-sys-color-primary` via `color-mix` at 4–13% (`variables.css` `[data-theme="dark"]` block) — the night wears the active seed. The monochrome preset is near-achromatic, so it still lands on untinted graphite; the light ground stays brand paper regardless of seed.
- **Rationale**: personalization is the product's identity (the accent IS the theme, Material You dynamic-color model); a neutral night would make the picker decorative.
- **Scope**: global (dark theme).
- **Ruled**: 2026-10-14, token migration slice (the tint predates it — the migration made the derivation explicit and single-track).
- **Review trigger**: an accessibility or contrast finding against tinted surfaces, or a fleet-wide ruling that dark grounds must be untinted.

### Active/selected states wear the seed's primary-container, not secondary-container
- **Rule**: foundations.md §2 usage mapping — nav active indicator = `secondary-container`; M3 keeps primary emphasis for buttons.
- **Decision**: selected chrome (settings section nav, selected segmented options, selected rows) fills `--md-sys-color-primary-container` (seed-derived), with `on-primary-container` ink.
- **Rationale**: one accent hue active at a time (skill hard rule) — the fleet's "accent is the selected signal" table takes precedence over M3's quieter nav register; Notees has no secondary hue in play.
- **Scope**: global (selected/active chrome).
- **Ruled**: 2026-10-14, single-track token migration (semantic preservation of the pre-migration primary-container usage).
- **Review trigger**: an M3-conformance audit finding active chrome too loud, or the introduction of a real secondary palette.

### Accent presets are brand-specific (Margin Green, not fleet copper)
- **Rule**: rosellramos-design-system default 4 (fleet default accent = copper, brand accent may replace it).
- **Decision**: the five presets are Margin Green (brand, default), Monochrome, Brown, Teal, Blue; each sets only `--md-sys-color-primary` + `--md-sys-color-on-primary`, all other primary roles derive via `color-mix`.
- **Rationale**: brand identity — "the margin is permanent, the green is the act of adding" (brand/palette.json).
- **Scope**: global.
- **Ruled**: brand lock (palette.json `locked: true`), carried into the seed model 2026-10-14.
- **Review trigger**: brand refresh.

### Settings is a full page; the quick-tweaks modal is retired
- **Rule**: rosellramos-design-system decision table (≤5–7 simple controls may use a modal; hybrid modal+page approved).
- **Decision**: the gear / Ctrl/Cmd+, / workspace-manager entry all open the full settings page directly; the two-control quick modal was deleted (2026-10-14 slice).
- **Rationale**: the modal held only theme+accent, both duplicated on the page — no unique function, an extra surface to maintain.
- **Scope**: global (settings surface).
- **Ruled**: owner, 2026-10-14 (changelog).
- **Review trigger**: a future quick-tweak control that is NOT on the page (then re-justify the hybrid).

### Chrome register rulings (owner 2026-10-09 fleet button audit)
- **Rule**: rosellramos-design-system button registers (skilled commits eccd78e, 1a0045e, 6d437ab).
- **Decision**: modal/form footers run primary confirm + outline secondary + ghost tertiary-only (default is not a chrome register); the outline register is for state-carrying chrome only — action buttons stay borderless even in chrome; a collapsible section's scoped create affordance rides the section header's trailing action (no in-content add rows).
- **Rationale**: owner rulings from the Notees button audit, fleet-normative via the skill's own commits.
- **Scope**: components (buttons, modals, sections).
- **Ruled**: owner 2026-10-09.
- **Review trigger**: a fleet-wide register revision in the skill.
