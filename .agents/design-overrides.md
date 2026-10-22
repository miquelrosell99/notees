# Design overrides — Notees

Per-project override register for the RosellRamos design system (contract:
`rosellramos-design-system` → `identity/procedure.md`). Every deviation from
the skill's defaults/foundations is recorded here; an undocumented deviation
is drift, a documented one is a decision. Newest first. Entries bind until the
rule they override changes, the review trigger fires, or the owner re-rules.

### Dialog corner register: 16px — the centered-dialog shape (supersedes the unrecorded 28px dialog rounding)
- **Rule**: `law/spec.md` shape scale + M3 provenance — dialogs/dialog-adjacent surfaces take the extra-large family (M3: 28dp dialog container); the fleet M3 deltas appendix is where app-specific shape numbers are adjudicated, and a value the law owns ships as a token or not at all.
- **Decision**: centered dialogs ride a new token **`--shape-dialog: 16px`** (tailwind `rounded-dialog` / `--radius-dialog`), NOT the sheet family's 28px. Every centered dialog surface switched: the fleet `Modal` primitive's dialog variant, the catalog `dialog` + `alert-dialog` primitives, and the command palette's own `.nt-modal` chrome. **Bottom sheets are out of scope by design** — the `modal--sheet` variant and its header/footer keep `--shape-sheet` (28px): a sheet is anchored to the viewport edge, where the rounding idiom is M3-standard and reads intentional, not bulbous. Card's `xl` radius register (also `rounded-sheet`) stays a Card-level choice.
- **Rationale**: the 28px dialog register began as a code-comment ruling (2026-10-15, "was 12px") that was never recorded in this register; at 28px the large dialog surfaces (the command palette prominent among them) read over-rounded to the owner (2026-10-22 report). The pre-2026-10-15 12px had been judged too sharp, so the ruling lands the midpoint rather than reverting.
- **Scope**: `--shape-dialog`/`--radius-dialog`/`rounded-dialog` and the four dialog surfaces above; sheets and Card `xl` untouched. The same density pass tightens the fleet `Modal` header to 12px vertical padding (spacing-3, horizontal stays spacing-4) — the 16px block read too tall for a one-line chrome row (owner follow-up, same day).
- **Ruled**: owner 2026-10-22 ("modals, in general, are too rounded — decrease that"), recorded same day.
- **Review trigger**: the owner flags the 16px as still too round/too sharp, or a fleet ruling sets an app-agnostic dialog shape.

### App.tsx stays at ~750 lines as the composition root — a recorded over-target
- **Rule**: coding-standards `modularity.md` (owner ruling 2026-10-19) — composition roots compose and wire state, they don't implement; **target ≤400 lines**, and "over target needs a recorded reason … a decision, written in the repo's decisions log/register, not an accident of momentum."
- **Decision**: `apps/web/src/ui/App.tsx` (~758 lines after the `ui/app/` split, from 2,834) stays above the 400-line composition-root target **by design**. It carries exactly the two things a composition root should carry — the view/presenting state (selection, navigation stack, focus mode, share targets) and the shell-region prop wiring — and nothing else: all logic (boot/auth flow, connection lifecycle, storage, routing, chrome hooks, the four shell regions) already lives in `src/ui/app/`. Splitting the remaining ~750 lines further (e.g. a "useShellState" grab-bag) would re-create the hook-monolith pattern the same ruling bans — a relocation, not a dissolution — while adding indirection between the regions and the state they present.
- **Rationale**: the ruling's own escape hatch ("over target needs a recorded reason") applies here; the file's two responsibilities (view state ownership + wiring) are the composition root's definition, and every further extraction candidate is either pure wiring (no behavior to test in isolation) or a state grab-bag (the anti-pattern). The success criterion from the ruling — "each unit has one reason to change" — is met at the `ui/app/` family level.
- **Scope**: `apps/web/src/ui/App.tsx` only; the ≤400-line target still applies to every other file in the repo (incl. `ui/app/` members — `useBootFlow` split 2026-10-19).
- **Ruled**: owner-directed refactor 2026-10-19 (the App.tsx split's own assessment), recorded same day.
- **Review trigger**: App.tsx crosses ~1,000 lines, a third distinct responsibility lands in it, or a real (non-grab-bag) seam emerges in its view state.

### The source tree is layer-first while the fleet tree is feature-first — SUPERSEDED: realigned in full (2026-10-19)
- **Rule**: `rosellramos-coding-standards` → `references/codebase-organizer.md` — the canonical React tree is `lib/`, `components/ui/` (truly shared primitives), and `features/<name>/` (api/components/pages/stores + index.ts); modularity.md's "feature-first, not layer-first" names the layer-first flat dump an anti-pattern.
- **Decision**: the owner ruling of the same day (full alignment, no shortcuts) supersedes the incremental move-on-touch entry below: **the realignment is DONE, one commit per cohesion cluster** (`12e29845` collection · `2bcc13c6` metadata · `32fe0250` classview+templates · `91a3720a` calendar+journals+date-pickers · `344f20df` shared pickers+icon-picker · `0d656c7a` node-menu+page-sections+block-editor · `82c5160b` workspaces · `f4e4f6a5` sharing/trash/command-palette · `d13da86e` settings/export/modals/find-in-page · `08341f6d` the primitive layer · `bbf66ecf` the shell). The clustering map: **src/ui/ = the shell + composition root only** (App.tsx, ui/app/ with the sidebar/top bar per the 2026-10-16 excepted-surfaces ruling, the block/page editors, presentation + whiteboard canvas) · **src/components/ui/ = the primitive layer** — the normalized shadcn catalog (kebab) plus `fleet/` (the PascalCase fleet chrome: Button/Card/Modal/Tabs/Dropdown/ContextMenu/…; a subdir because the two naming schemes collide by case in one flat dir, and fleet/ is the *wrapper layer* over the catalog — the bridge's documented relationship) · **src/features/<name>/ = every business component**, grouped by cohesion: collection (views + graph engine + query/filter builder + hubs), metadata (properties/classes/aliases/pills), classview (class detail + system-class families), templates, calendar (view/journals/day pages/grids/top-bar popup), date-pickers, pickers (shared node/color pickers), icon-picker, node-menu (context/link/sidebar-item menus, hover preview, breadcrumbs), page-sections (activity/comments/created/version/system/node-view sections + page banner/card/footer), block-editor, workspaces, sharing, trash, command-palette, settings, export, find-in-page, modals (the genuinely cross-feature modal library). Each feature carries an `index.ts` barrel.
- **Rationale** (historic): the deferred entry kept the layer-first tree under the existing-app adoption policy to avoid colliding with in-flight branches; the owner re-ruled full alignment, and the clustering pass landed with reviewable per-cluster diffs, the drift gate's CSS half covering the feature paths throughout (it already walked src/features; the JS-scoped owner walk and the fleet-wrapper exemption in the registered-mapping check moved with the primitives).
- **Scope**: global (source tree).
- **Ruled**: owner 2026-10-19 (full alignment, no shortcuts) — the incremental entry it superseded had been ruled the same day (folder-structure review).
- **Review trigger**: a new feature folder created (lands in features/<name> with a barrel), a feature crossing ~40 files without clustering, or a fleet ruling revisiting the canonical tree.

### ~~The source tree is layer-first while the fleet tree is feature-first~~ (historic — superseded above)
- **Rule**: `rosellramos-coding-standards` → `references/codebase-organizer.md` — the canonical React tree is `lib/`, `components/ui/` (truly shared primitives), and `features/<name>/` (api/components/pages/stores + index.ts); modularity.md's "feature-first, not layer-first" names the layer-first flat dump an anti-pattern.
- **Decision** (historic): the app's tree (`ui/components/` ~135 entries, `ui/views/`, no `features/`) was KEPT for now under the existing-app adoption policy: audit the principles (dependency direction UI → core is sound; primitives are correctly isolated post-migration), move-on-touch from here, cluster oversized flat folders as they are worked. Feature components being touched land in `features/<name>/` — the metadata section was the first.
- **Rationale** (historic): a big-bang tree migration rewrites hundreds of imports for zero user-visible value and collides with the in-flight block-grip branch; incremental realignment converges at every touch point with reviewable diffs.
- **Scope**: global (source tree).
- **Ruled**: owner 2026-10-19 (folder-structure review; exercises the documented-decision escape).
- **Review trigger**: fired the same day — the owner re-ruled full alignment and the clustering pass above superseded this entry.

### Custom primitive layer — MIGRATED to the normalized shadcn catalog (2026-10-19)
- **Rule**: `components/sourcing.md` — the normalized shadcn catalog is the canonical component source for every fleet app; custom implementations of catalog-covered components are non-alignment unless documented (owner ruling 2026-10-19: apps are aligned, and alignment means the normalized catalog).
- **Decision**: the migration the original exception deferred is DONE, same day as the ruling — the documented-exception path is retired. The bridge layer (Tailwind wired to the tokens via `tailwind.config.ts`, the `--background`…`--ring` alias layer in `variables.css`, `components.json`) and a 20-component normalized catalog (`apps/web/src/components/ui/`, Radix underneath) ship in commits `c5ebaac1` (bridge) and `21aef837` (catalog); the six fleet primitives become thin wrappers composing the catalog in `f646dbbc` — Button, TextField, Card, ToggleSwitch, Tabs, Modal keep their full prop APIs (zero call-site churn) with their CSS retired (Tabs.css keeps the sliding-indicator register; Modal.css keeps the sheet/overlay chrome). The drift gate grew the class half (checks 8–11: palette hues, raw radii, arbitrary values/default shadows/durations, registered-mapping) and the Playwright bridge fixture (`/​__design-bridge-fixture` + `e2e/bridge-fixture.spec.ts`) proves computed behavior across themes and accent switches.
- **What stays fleet-owned** (per the sourcing table, not the catalog): shell chrome (`SidebarNav`, `ListRow`, the app Sidebar/TopBar), `SegmentedControl`, `Chip`, `EmptyState`, `ConfirmationModal` (composes the app Modal), and the app-specific registers the wrappers carry (the button variant/loading/haptics/badge register, the underline field, the dual-label switch, the sliding-indicator tabs, the bottom-sheet modal chrome). The remaining catalog-covered custom leaves (Badge, Checkbox, Radio, Input, SearchField, SelectTrigger, Dropdown, ContextMenu, Separator, Slider, Spinner, …) migrate at touch points — new work for those needs goes through the catalog, normalized.
- **Leaf-migration sweep, same day (full-alignment stage)**: Badge, Separator, Spinner (a normalized registry spinner added via `npx shadcn add`), LoadingSkeleton, Checkbox, Radio, Input, SearchField, BooleanToggle, Slider (added via the CLI), CodeTextarea, and SelectTrigger all became thin wrappers over the catalog — fleet registers re-expressed as cva/utilities on token-mapped Tailwind keys, full prop APIs and marker classes preserved, their stylesheets retired (Spinner/SearchField keep only the reduced-motion/hit-floor/focus-ring CSS the utility layer can't express). **Dropdown and ContextMenu are the two remaining custom leaves**, documented below — they are composite widgets, not leaves, and their migration is a dedicated slice each.
- **Rationale**: full alignment was the owner's explicit ruling; the wrapper architecture (catalog underneath, fleet register on top, legacy marker classes where feature CSS compounds) kept 72 Button call sites and their CSS overrides working unchanged.
- **Scope**: global (component layer).
- **Ruled**: owner 2026-10-19 ("full shadcn alignment and implementation"), executed same day.
- **Review trigger**: a fleet ruling revisiting the bridge, or a wrapper that can no longer express its register on the catalog foundation.

### Dropdown and ContextMenu — MIGRATED to the catalog composites (2026-10-19)
- **Rule**: `components/sourcing.md` — Select/Combobox/Dropdown menu/Context menu come from the shadcn catalog, normalized; an app whose own layer implements a catalog-covered component is non-aligned unless documented (owner ruling 2026-10-19).
- **Decision**: the scheduled migration the deferral entry below promised, executed the same day. **Dropdown** rebuilds on the catalog combobox composition — the catalog `command` (cmdk) inside a Radix popover (`PopoverPrimitive` directly, the Modal-wrapper precedent): popper owns portal/flip positioning, the listbox/option ARIA + arrow-key walk + label-only filter are cmdk's; the fleet register (menu surface CSS, option rows, group overlines, boxed `SelectTrigger`, multi-select toggles, custom renderers) is unchanged. **ContextMenu** rebuilds on the Radix context-menu/sub composition: a hidden `Trigger` driven by a synthetic contextmenu event is the virtual anchor (the app drives menus open itself), the overlay stack stays the single Escape authority (Radix's Escape disabled), the synchronous enter-only hover seam and the submenu-first Escape are preserved, the flyout rides Radix's popper with focus-outside dismissal prevented (spawned modals must not collapse the menu), and sub-item selects fire onClick + onClose without self-unmounting (caller-controlled surfaces). Full contract notes in the components' header docs and `CHANGELOG.md` 2026-10-19.
- **Rationale**: Radix Select cannot express multi-select/search — the shadcn answer for that contract IS command+popover; the context-menu's two submenu forms map onto Sub/SubContent 1:1. Both keep the app interaction contracts the bridge checklist §9 requires, documented in the wrapper headers.
- **Scope**: `apps/web/src/ui/components/ui/Dropdown.tsx` (+ `.css`), `ContextMenu.tsx` (+ `.css`), `@radix-ui/react-context-menu` dep, the drift gate's JS-scoped allowlist (`--radix-popover-trigger-width`), the shared jsdom `scrollIntoView` stub.
- **Ruled**: full-alignment stage 2026-10-19 — commits `c91e7422` (ContextMenu) and `793836c3` (Dropdown); this entry records the migration as DONE.
- **Review trigger**: a fleet ruling revisiting the bridge, or a wrapper that can no longer express its register on the catalog foundation.

### ~~Dropdown and ContextMenu stay custom one more stage~~ — SUPERSEDED by the MIGRATED entry above (kept for the record)
- **Rule**: `components/sourcing.md` — Select/Combobox/Dropdown menu/Context menu come from the shadcn catalog, normalized; an app whose own layer implements a catalog-covered component is non-aligned unless documented (owner ruling 2026-10-19).
- **Decision** (historic): the full-alignment sweep migrated every catalog-covered LEAF the same day. `Dropdown` and `ContextMenu` stayed custom into the tree-realignment stage, documented as a decision with a scheduled migration — NOT silent non-adoption. **Dropdown** (`ui/components/ui/Dropdown.tsx`, 347 lines + 234 CSS, ~20 call sites) is a composite select widget with search, MULTI-select, option groups, custom trigger/option renderers, footer/emptyContent, and the app overlay stack's viewport-flip positioning — Radix Select expresses none of the multi-select/search contract; the shadcn answer is the `command`+`popover` combobox composition, which is a rebuild of the widget's internals (not a thin wrapper). **ContextMenu** (`ContextMenu.tsx`, 494 lines + 184 CSS, ~13 call sites) is a composite menu with TWO submenu forms (custom-content `submenu` + native-list `submenuItems`), hover-bridge flyouts, `keepOpen`, and the app overlay stack owning Escape/dismissal — the Radix context-menu/sub migration must reconcile the ONE-overlay/Escape-authority bridge rule and the submenu interaction contract.
- **Rationale** (historic): the shadcn bridge itself classifies exactly this as the marathon pattern ("the rest of a big custom layer migrates at touch points — a marathon, not a one-evening job"); a fake thin wrapper over Radix Select would silently DROP the multi-select/search contract, which is worse than a documented, scheduled migration.
- **Scope**: `apps/web/src/ui/components/ui/Dropdown.tsx`, `ContextMenu.tsx` (+ their CSS) only.
- **Ruled**: full-alignment stage 2026-10-19 — the sweep's reporting records them as the remaining gap, scheduled next.
- **Review trigger**: fired — the tree-realignment stage picked them up (ContextMenu via the Radix context-menu/sub composition, then Dropdown via the combobox composition).

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
