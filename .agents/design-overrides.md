# Design overrides — Notees

Per-project override register for the RosellRamos design system (contract:
`rosellramos-design-system` → `identity/procedure.md`). Every deviation from
the skill's defaults/foundations is recorded here; an undocumented deviation
is drift, a documented one is a decision. Newest first. Entries bind until the
rule they override changes, the review trigger fires, or the owner re-rules.

### Custom primitive layer — MIGRATED to the normalized shadcn catalog (2026-10-19)
- **Rule**: `components/sourcing.md` — the normalized shadcn catalog is the canonical component source for every fleet app; custom implementations of catalog-covered components are non-alignment unless documented (owner ruling 2026-10-19: apps are aligned, and alignment means the normalized catalog).
- **Decision**: the migration the original exception deferred is DONE, same day as the ruling — the documented-exception path is retired. The bridge layer (Tailwind wired to the tokens via `tailwind.config.ts`, the `--background`…`--ring` alias layer in `variables.css`, `components.json`) and a 20-component normalized catalog (`apps/web/src/components/ui/`, Radix underneath) ship in commits `c5ebaac1` (bridge) and `21aef837` (catalog); the six fleet primitives become thin wrappers composing the catalog in `f646dbbc` — Button, TextField, Card, ToggleSwitch, Tabs, Modal keep their full prop APIs (zero call-site churn) with their CSS retired (Tabs.css keeps the sliding-indicator register; Modal.css keeps the sheet/overlay chrome). The drift gate grew the class half (checks 8–11: palette hues, raw radii, arbitrary values/default shadows/durations, registered-mapping) and the Playwright bridge fixture (`/​__design-bridge-fixture` + `e2e/bridge-fixture.spec.ts`) proves computed behavior across themes and accent switches.
- **What stays fleet-owned** (per the sourcing table, not the catalog): shell chrome (`SidebarNav`, `ListRow`, the app Sidebar/TopBar), `SegmentedControl`, `Chip`, `EmptyState`, `ConfirmationModal` (composes the app Modal), and the app-specific registers the wrappers carry (the button variant/loading/haptics/badge register, the underline field, the dual-label switch, the sliding-indicator tabs, the bottom-sheet modal chrome). The remaining catalog-covered custom leaves (Badge, Checkbox, Radio, Input, SearchField, SelectTrigger, Dropdown, ContextMenu, Separator, Slider, Spinner, …) migrate at touch points — new work for those needs goes through the catalog, normalized.
- **Rationale**: full alignment was the owner's explicit ruling; the wrapper architecture (catalog underneath, fleet register on top, legacy marker classes where feature CSS compounds) kept 72 Button call sites and their CSS overrides working unchanged.
- **Scope**: global (component layer).
- **Ruled**: owner 2026-10-19 ("full shadcn alignment and implementation"), executed same day.
- **Review trigger**: a fleet ruling revisiting the bridge, or a wrapper that can no longer express its register on the catalog foundation.

### Export token family (`--nt-*`) is a registered, self-contained namespace
- **Rule**: `law/spec.md` §1 namespace hygiene — extensions register with a reason; a token family outside the canonical roles must be documented.
- **Decision**: `packages/export/src/html.ts` emits self-contained HTML exports carrying their own `--nt-*` token family (defined inline in the export document) — exports render identically outside the app and never read the app's runtime tokens.
- **Rationale**: an exported document is frozen at export time; referencing the app's token file would let a later re-theme rewrite history. The family lives only inside exports and is never imported into app chrome.
- **Scope**: `packages/export` (exported documents only).
- **Ruled**: 2026-10-19 audit, same-pass duty.
- **Review trigger**: the export pipeline is redesigned, or an export is found reading runtime tokens.

### Default theme is follow-system (Auto)
- **Rule**: `SKILL.md` default 1 — themes ship complete; which theme is the DEFAULT is a per-app identity decision.
- **Decision**: the no-preference default follows the OS scheme (Auto); the user's explicit choice persists per user and wins from then on.
- **Rationale**: a knowledge workspace is a day-and-night surface; forcing dark or light on first launch misreads half the user's days. The one-writer seam + pre-paint parity test (components/web-patterns.md) carry the default.
- **Scope**: global (appearance).
- **Ruled**: 2026-10-19 audit — registered as an identity axis the register was missing.
- **Review trigger**: the owner wants dark-first, or a first-paint flash finding against the bootstrap.

### Type stack — Stack A (Instrument Sans · Newsreader · JetBrains Mono)
- **Rule**: `identity/procedure.md` + `identity/palettes.md` — the type stack is a per-app identity decision, picked once and registered.
- **Decision**: Stack A — Instrument Sans for chrome/UI, Newsreader as the content serif (reading/note surfaces only), JetBrains Mono for code and data (`variables.css` `--font-family-*`).
- **Rationale**: the knowledge-workspace register (neutral grotesque chrome, editorial serif reading); chosen at build, predating v2's explicit identity axes.
- **Scope**: global (typography).
- **Ruled**: 2026-10-19 audit — registered as an identity axis the register was missing.
- **Review trigger**: brand refresh or a legibility/contrast finding against the stacks.

### Sidebar, top bar, and canvas chrome are excepted from the alignment program
- **Rule**: machinery/audit.md §0–§10 wholesale — every area × surface sweep of the skill.
- **Decision**: the owner's 100%-alignment program (2026-10-16) sweeps and fixes every surface against the skill EXCEPT three, which stay as-is and are not walked: the **sidebar** (`.nt-sidebar` — transparent over the app background, hairline-separated, drawer-below-768), the **top bar** (the app-shell TopBar, including its ≤768px crowding), and **on-canvas chrome** (whiteboard, graph, and presentation-stage surfaces and their floating controls — canvas geometry follows `components/web-patterns.md → "Canvas paint resolves tokens at runtime", not component rules).
- **Rationale**: owner ruling (2026-10-16): "I want the app to be 100% aligned with the skill (except the sidebar and top bar on canvas stuff)". These three are deliberate app identity / canvas-specific surfaces; alignment work on them is out of scope until the owner re-rules.
- **Scope**: the three named surfaces and their children only — everything else in the app is IN scope for alignment (deviations outside them are drift, documented or not).
- **Ruled**: owner 2026-10-16.
- **Review trigger**: the owner re-rules any of the three, or a new design-system audit wants a baseline of the excepted surfaces.

### The sidebar is a transparent "chrome on canvas" navigator- **Rule**: rosellramos-design-system default 3 (solid sidebar on the ground, hairline separated; the card-on-backdrop exception still keeps the sidebar solid).
- **Decision**: `.nt-sidebar` carries no surface fill (`background: transparent`) at any width — the app background hosts the chrome directly, separated from content by a hairline rule; the sidebar reveals/hides via the TopBar hamburger at every width (below 768px it becomes a fixed overlay drawer with a real surface + shadow). Related responsive ruling: the navigator is **state-driven at every width** — there is no rail morph at 1024 and no 1440-wide adaptation; sidebar adaptation is drawer-below-768 only.
- **Rationale**: the workspace canvas is the hero of a knowledge environment; a filled sidebar panel would partition the ground and compete with the content cards it navigates. Hamburger-at-every-width keeps one navigator behavior to learn.
- **Scope**: global (app shell).
- **Ruled**: owner 2026-10-09 shell design, registered 2026-10-15 after the design-system audit found the deviation undocumented.
- **Review trigger**: a fleet-wide ruling on shell layouts, or an adaptiveness finding against the missing rail.

### The night is seed-tinted
- **Rule**: rosellramos-design-system default 2 (warm near-black ground, monochrome surfaces) + law/spec.md §2 (surface neutrals are near-gray).
- **Decision**: the dark theme's background/surface/outline family derives from `--md-sys-color-primary` via `color-mix` at 4–13% (`variables.css` `[data-theme="dark"]` block) — the night wears the active seed. The monochrome preset is near-achromatic, so it still lands on untinted graphite; the light ground stays brand paper regardless of seed.
- **Rationale**: personalization is the product's identity (the accent IS the theme, Material You dynamic-color model); a neutral night would make the picker decorative.
- **Scope**: global (dark theme).
- **Ruled**: 2026-10-14, token migration slice (the tint predates it — the migration made the derivation explicit and single-track).
- **Review trigger**: an accessibility or contrast finding against tinted surfaces, or a fleet-wide ruling that dark grounds must be untinted.

### Active/selected states wear the seed's primary-container, not secondary-container
- **Rule**: law/spec.md §2 usage mapping — nav active indicator = `secondary-container`; M3 keeps primary emphasis for buttons.
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
