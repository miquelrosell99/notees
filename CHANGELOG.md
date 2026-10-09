# Changelog

The record of shipped work for Notees. One entry per shipped slice, newest
first. This file — not `AGENTS.md`, not the runbooks — is where history goes;
those stay static guidance. Before implementing a change, skim this file for
recent related work. Anything before 2026-10-06 lives in git history: the
retired implementation plan and design stack are recoverable from commits
predating this file.

## 2026-10-09

- **feat(web,protocol,store): the page header gains the Capacities action
  row — quiet ghost actions above the title (Add icon / Add description /
  Add aliases) — plus the new `description` wire node field; the header icon
  element now renders ONLY when an icon is defined (own or class-contributed),
  and the empty hover placeholder is gone.** (1) The action row
  (`PageHeaderChrome`, main surface only — not embedded/preview/focus/day
  pages): "Add icon" opens the existing full icon+color picker anchored at
  the row button (at the icon element when one is defined), "Add aliases"
  opens the shared backward-write alias picker — the pick flow extracted
  from the metadata panel's AliasesRow into `AliasNodePicker.tsx` so both
  surfaces run one guard-validated write (no logic drift). (2) The
  `description` wire node field: optional nullable plain text (max 512
  chars) on `object.update` (never `object.create`), presence writes /
  present-null clears, riding the row LWW — the cover/banner/alias
  precedent; node-table column `description`, store schema v18 with an
  idempotent v17→v18 migration arm; `ClientNode` + `updateObject` carry it
  (the node-row identity stamp mixes it in). The subtitle renders under the
  title only when non-empty: "Add description" swaps in the editor
  (Enter/blur commits, Esc cancels, an empty commit clears), then the
  subtitle itself is the click-to-edit surface. The query language gains NO
  `description` predicate this slice — free-text grammar is a deliberate
  follow-up, not a silent default (SCHEMA.md says so). (3) Icon
  hide-when-none: the header icon element renders only for a DEFINED icon
  (`definedNodeIcon` — own or the first class-contributed one via the
  extends-resolved lookup); the generic `defaultIconFor` fallback (class
  shape / page document glyph) stays for lists, mentions, and everywhere
  else, and the `◈` hover placeholder + its CSS token retired. Day pages
  skip the row and the subtitle (the DayPageHeader contract). Export
  projections do not carry `description` yet (web-rendered field this
  slice). `notees-cli`'s vendored pin is NOT bumped — it picks the field up
  on its next vendor update. **Client lockstep (the fixture gate law):**
  `object-wire-fields.json` gains the set + clear envelopes, byte-identical
  in the GTK and Flutter repos — the GTK store bumps to schema v14 with the
  same idempotent additive migration (pytest 741 green) and the Flutter
  store to v28 (`flutter test` +613 green); their UIs don't render the
  subtitle yet (store+wire first, chrome follow-on). Verified: protocol
  suite green (fixture gate + the 512 cap + create-rejects specs), store
  suite green (463 — fixture replay, v18 LWW/absence/clear, v17→v18
  migration + idempotence), web typecheck green, new
  `page-header-actions` suite green (7 specs: row gating incl. day/embedded/
  preview, icon hide/show incl. the class-contributed case, description
  add/edit/clear round-trip, the header alias backward write), the
  class-view picker spec re-pointed at the row action, the node-aliases
  suite's Add-alias query tightened (`/^Add alias$/` — the header's "Add
  aliases" also matches `/Add alias/`), css-token-drift gate green.

- **fix(web): the export modal's page-size dropdown wears the app surface
  (the "blue" was the browser default button face — a kit reset gap), the
  PDF's node links are accent-colored and underlined (no grey chip), and the
  screenshot-probe workflow is recorded so it stops being rediscovered.**
  (1) `SelectTrigger` is a bare `<button>` and never reset the UA background
  — every Dropdown in the app inherited the browser's button color (grey
  headless, blue-tinted on the owner's platform); the kit now sets
  surface/on-surface. The modal also constrains the dropdown CONTAINER (the
  kit default is width:100% + flex:1 — a width on `.dropdown` alone loses),
  so the trigger is a compact content-sized control. (2) PDF mentions: grey
  pill chip retired — accent color + underline, icon drawn in the accent.
  (3) `docs/developers/ui-debugging.md` + `scripts/screenshots/probe-
  template.mjs` capture the diagnosis workflow (capture suite vs live probes,
  the login-flow auth pattern, computed-style dumps, the react-pdf/jsdom
  limits, reading exported PDFs back); the runbook is indexed from the
  developers README. Verified live with a probe against the redeployed stack
  (screenshot + computed styles: surface background, 81px trigger), web
  suite green, VERIFY-PASS.

- **feat(web): the nodeview's two sidebars — the properties panel and the
  context column — become raised cards over the main content surface.**
  Each column retired its continuous full-height vertical divider (and the
  negative-margin reach into the page padding) and now rides as its own
  card: surface fill, hairline frame, the layout-card radius, one elevation
  step above the card it sits on (`--shadow-elevation-2`), inset padding,
  stopping a step above the card bottom like the top bar. The panels
  unmount on collapse as before; only the frame changed. Docs: `docs/ux.md`
  + `docs/usage.md` describe the raised-card columns instead of the
  divider. Verified: web build green; web suites green except two reds in
  the in-flight aliases/icon-picker slice (another session's files — a CSS
  change cannot affect them); verified live with a probe against the
  redeployed stack (computed styles + screenshots, dark and light).
- **feat(web): text property values that have no content and no child blocks
  auto-unset — clearing a text property returns the slot to its empty state
  instead of lingering as an empty block or a dead cell (the unset trashes
  the orphaned carrier, recoverable from trash).** The Metadata panel's text
  row runs an auto-unset pass over its authored values on every
  store-synced render and when focus leaves the row: a carrier with empty
  text and no children, an empty scalar string, and a dead reference whose
  target node is gone all emit the ordinary `property.unset` (no op, no
  wire change — every replica converges from the log as usual). Guards: a
  carrier is skipped while focus is anywhere inside the row (an Add-pill or
  Enter just minted an empty value the user may be about to type into) and
  the caret-bearing carrier is never unmounted mid-edit; a dead ref that
  still resolves to a node which merely stopped rendering inline (promoted
  to a page) keeps its re-author recovery cell. The pass reads fresh rows
  from the client, not the (possibly stale) render props. Supersedes the
  2026-10-04 dead-carrier cell workaround in `properties-panel` — the dead
  cell no longer renders for gone targets; the panel drops to its empty
  state. Docs: SCHEMA.md "Node-backed text properties" gains the
  auto-unset lifecycle bullet; ux.md "Properties" gains the "Cleared text
  returns to empty" contract. Verified: text-property-blocks (11 specs:
  empty-carrier unset + carrier trash, content/child keeps, focus-guard
  keep-then-unset on leaving the row, scalar empty unset, dead-gone unset,
  promoted-node recovery kept, Add-pill empty survives), properties-panel
  dead-carrier specs rewritten to the new contract, properties-panel +
  block-metadata + property-owner-rulings + property-view +
>>>>>>> d61fb47c (feat(web): auto-unset text property values whose carrier has no content and no child blocks)

- **fix(web): the PDF's visual regressions from the app-chrome slice — no
  more double bullets, pills at deterministic size — and the export modal's
  settings rows look like the rest of the UI (new kit `Radio` primitive;
  layout choice moved into Options as a radio group; the page-size dropdown
  constrained to a compact control).** The inline-block row wrapper rendered
  its own bullet on top of each paragraph's row bullet (two dots per block)
  — the wrapper lost its dot (the block rows keep theirs). The class pill
  could blow up to a tall stretched box (text pinned top-left): the pill now
  has a deterministic height from the theme type metrics, centered content,
  and `alignSelf: flex-start`. The modal side: the PDF layout cards row
  retired in favor of a kit `Radio` group inside the collapsible Options
  section (alongside the page-size `Dropdown`, which the kit styled at
  width:100% — now constrained to `max-content`), one settings surface like
  every other modal; `Dropdown` gained an `ariaLabel` forward and
  `Radio`/`Radio.css` join the kit with a catalog entry in
  `ui-primitives.md`. Verified: web export suites green (50 specs incl. the
  layout-radio flow), css-token-drift gate green.

- **feat(web): the nodeview properties panel is renamed "Metadata", and the
  aliases affordance moves from the title row into the panel as its first
  section — an "Aliases:" node list (pill per alias, × clears, "+ Add alias"
  links a new one).** (1) Rename: the side-panel section header and the
  in-flow compact section read "Metadata N" now (the count still covers
  property rows only); identifiers, CSS hooks (`.nt-properties-panel`,
  `.nt-props-sidebar*`), and the palette's "Properties" search scope are
  unchanged. (2) Aliases relocation: the title-row `AliasesButton` (count
  button + popup with NAVIGATE/Add) is retired; a new `AliasesRow`
  (`MetadataSection.tsx`, exported next to TagsRow) renders at the TOP of
  both the sidebar and the in-flow section — the TagsRow composition reusing
  the shared `NodePill` + `AddPill` + `NodeSelector` primitives (NodePills
  itself stays class-scoped: its picker, color-chain resolution, and removal
  locks are class semantics). Each alias is a pill whose × clears THE
  ALIAS's own `aliasedNodeId` (the new removal path — the popup had none);
  "+ Add alias" keeps the backward write (the picked node's field becomes
  the active node, guard-validated, already-aliased nodes filtered out); the
  pill click keeps the RAW bypass (opens the alias's OWN view — the retired
  popup's NAVIGATE contract) via a new optional `onOpenPageRaw` plumbed
  through PropertiesSection/PropertiesSidebar from PageView; the row
  subscribes for freshness like the old button did. Pages only: the row
  renders null for blocks (BlockRow's hideWhenEmpty usage gains no chrome).
  `PageHeaderChrome` drops the retired `onOpenPageRaw` prop. Verified:
  node-aliases suite green (list/bypass/backward-write/filter/×-removal
  specs rewritten onto the row), properties-panel/block-metadata/pickers/
  asset-attachments/dates/property-view/asset-annotations/recurrence/
  property-owner-rulings header assertions updated to "Metadata", web
  typecheck + full suite green.

- **feat(web,export): the PDF carries the app chrome (outliner bullets, the
  row's class pills on the far right, node icons on mention chips), the
  "Show type labels" option is now "Show classes" and renders colored pills,
  text-property carrier blocks stay out of the exported body, and the PDF
  page size moved into the Options section as a dropdown.** (1) Carrier
  exclusion: the page view's body never renders property-carrier blocks
  (`getBlockTree`'s rule) — the export paths now mirror it
  (`propertyCarrierIdsOf` over authored effective rows, carrier subtree
  pruned) across the markdown bundle, the single-document IR, and the
  asset/whiteboard walkers; spec pins a text-property carrier staying out of
  the preview's body. (2) Notes-layout bullets: every block row draws the
  outliner dot (Essay/Academic stay clean typesetting — the new
  `theme.bullets` flag). (3) Class pills: the IR gains build-time
  `colorOf`/`iconOf` ctx hooks; with Show classes on, every child row (inline
  blocks recursively + child-page entries) and the header's Classes row
  render the row's own class pills — effective colors, contrast text, first
  pill + "+N" overflow — the list-view look. (4) Mention chips draw the
  node's MDI icon before its name, path data fetched from the app's own
  `mdi-sprite.svg` (zero new dependencies; name-only fallback). (5) The PDF
  page size is a kit `Dropdown` inside the collapsible Options section (the
  standalone SelectionButton chrome is gone; `Dropdown` gained an `ariaLabel`
  forward). Verified: web export suites green (bullets/pills/mention-icon
  component specs + the carrier modal spec), packages/export 236 green,
  full web suite green.

- **fix(web): fleet button audit against the state-vs-action register rule —
  state-carrying chrome goes outline, actions go borderless, modal
  secondaries unify on outline.** Audit of every button in the app against
  the owner ruling recorded in the design system (outline marks STATE-
  carrying chrome; actions stay borderless even in chrome): (1) **Fixed —
  state chrome wearing borderless**: the app top bar's two dock toggles
  (left sidebar, right cards rail) become kit `Button variant="outline"`
  with the `active` fill — they were the last state toggles outside the
  register the nodeview panel toggles already wear. (2) **Fixed — chrome
  actions wearing borders** (outline → ghost): the hub/header creates
  (New asset / New class / New page / New whiteboard), the calendar
  quick-create chips + Daily Note create, the hover-preview Pin, the
  queries hub's Edit query, the template gallery's create. (3) **Fixed —
  modal/form secondaries unified**: the filled-tonal `default` cancel/close
  flips to `outline` (workspace name/export, property history/convert, the
  property settings' close, the kit ConfirmationModal — the convention
  setter — and the create-with-UUID footer's Cancel/Create pair, ghost and
  default respectively). `default` survives only as the lone CTA on
  dead-end surfaces (error-boundary reload, data-state retry). Reviewed and
  left as-is: tool-register toggles (graph chips/families/colors, the
  floating text-format toolbar, find/replace match-case, whiteboard
  snap-to-grid, the embed view switch — each carries its own active
  convention), the boot/auth form secondaries (outline, the form register),
  and the destructive `danger`/`danger-solid` pair. The modal register is
  recorded in the `rosellramos-design-system` skill (`references/
  dos-donts.md`). Verified: `pnpm typecheck` clean for the slice; the web
  vitest suites green except the parallel session's in-flight export-pdf
  work (their uncommitted ExportPageModal/test edits — reported, not
  touched). Display-state only.

- **fix(web): class-icon bullets ride at the dot's line height — the grip no
  longer jumps ~6px when a block has a class.** The block row is
  baseline-aligned, and the grip's synthesized flex baseline rides the bottom
  edge of the bullet's first in-flow item: the 6px dot anchored 14px from the
  box top, but a class icon's ~19px SVG anchored ~6px higher, lifting the
  whole grip — bullet and class pill — against the text on class rows. A
  zero-width 6px `::before` strut on `.nt-bullet` is now the first flex item,
  anchoring both bullet kinds at the dot's geometry (the centered glyph never
  moves). Verified with a throwaway current-build sync container + vite-dev
  probe measuring bullet and pill centers against the first text line per
  row: dot Δ-1px / icon Δ-7.6px before → both Δ-1px after, pill uniform
  across row types. `pnpm test`: 1412/1413 green — the single failure
  (export-modal checkbox test) and the web typecheck errors both sit in
  the export-pdf files of a concurrently in-flight uncommitted slice,
  untouched here. Display-state only — no model/wire change.

- **feat(web): the section-scoped create affordance moves into the section
  header — a shared trailing-action slot on NodeViewSection, wired for
  Comments, Child pages, and the class view's classed nodes.** (1)
  `NodeViewSection` gains an `action` prop: the header becomes a ROW — the
  collapse toggle (accessible name: title + count) plus one icon-only
  button at the far right, a sibling, never nested. `Section` threads the
  prop through. (2) Comments' quick-add rides it (click expands a collapsed
  thread, then opens the composer); the in-content add button is gone. (3)
  The classed-nodes section's toolbar ghost button AND the collection's
  bottom add row are replaced by the ONE header action. (4) Child pages —
  always rendered on the main surface now (the hide-when-empty ruling's
  deliberate exception, superseding owner 2026-10-08: the create must be
  reachable exactly when the list is empty); its header action creates a
  child page (`parentId` + `presentAsMain`). Embedded feeds keep the old
  ruling — read-only, childless hides — via a new `embedded` prop on
  `SystemSections`. The pattern is recorded in the `rosellramos-design-system`
  skill (`references/dos-donts.md`). Verified: `pnpm typecheck`; the full
  web vitest suite (136 files, 1413 tests) green, incl. the rewritten
  system-sections / class-view contracts. Docs: `docs/ux.md` (the
  hide-when-empty paragraph), `docs/usage.md` (Child pages). Display-state
  only — no model/wire change.

- **fix(web): no search bar glows accent on focus anymore — every search
  input trades the focus ring for a quiet border shift.** The earlier
  SearchField slice dropped the component's own accent glow, but the global
  `input:focus-visible` rule still paints the accent shadow on the raw input
  inside the field — the command palette kept the green ring the owner called
  ugly. Now the input itself sets `box-shadow: none`, and the remaining raw
  search inputs get the same contract: query panel (`.nt-search-input`),
  Dropdown's search, the NodeSelector picker's focus-within container glow,
  IconPickerPopup, WorkspaceSwitcher, TriggerPopup, the DuplicatePage modal
  (which also traded its primary-tinted focus border), and the add-property
  popup. Focus feedback everywhere is the border color deepening to
  `--color-outline` (SearchField keeps its on-surface-variant shift) — no
  accent anywhere. Display-state only; web typecheck + full vitest gate
  re-run green.

- **fix(web): the single-value selection cell names its value with ONE
  compact pill (effective-colored, no subtree), multi-value object pills
  cover every resolved value, and the date cell's repeat picker stops
  overlapping the value.** The morning redraw shipped the single-value
  dropdown's content as a read-only block row — which rendered the linked
  node's WHOLE subtree (children, collapse chevrons, backlink gutter) inside
  the field; the owner asked for "a pill and that's it". The cell's content
  is now the shared `NodePill` element tinted with the linked node's
  effective color (`NodePill` renders a non-interactive label span when the
  host carries the click — the dropdown does); the multi-value branch drops
  its inline-block special case the same way, so every resolved object value
  rides one compact pill (the editable-block treatment stays the TEXT
  property row's contract, not object values'). The date cell's trailing
  repeat picker (the kit Dropdown) defaulted to `width: 100%` of the flex
  row and drew over the trigger text — inside `.nt-property-select` the
  trailing dropdown now hugs its icon (`width: auto; flex-shrink: 0`), and
  the trigger content truncates honestly. The ⟳ control itself is the
  recurrence picker (None/Daily/Weekly/Weekdays/Monthly/Yearly, written as
  the RRULE-lite `metadata.repeat` — SCHEMA.md "Recurrence"), preserved
  from the pill era. Display-state only; the web suites around the panel
  re-run green with the pill-content assertion updated. Docs:
  `docs/ux.md`'s "Single values select" bullet now says one compact pill.

- **feat(web): the panelled layout's chrome gets honest scopes — the
  nodeview top bar spans the whole card, the local graph is a lazy
  collapsed-by-default section, Comments always renders with an icon-only
  quick-add, Activity is scoped to the active node, and the properties
  sidebar is a collapsible section.** (1) The nodeview top bar moves OUT of
  the middle column to span the full card above the column split: its
  controls act on the layout's columns, so it no longer rescales when a
  panel shows or hides — each panel toggle now sits directly above the
  column it reveals, and the side panels' vertical dividers start under the
  bar instead of beside it. (2) `LocalGraphCard` rides a NodeViewSection,
  collapsed by default — the section unmounts its content while collapsed,
  so the GraphView (engine + WebGL renderer + topology reads) never mounts
  and a closed card costs nothing; the first expand mounts it. (3)
  `CommentsSection` always renders (the hide-when-empty gate is gone): an
  empty thread starts EXPANDED with the icon-only quick-add one click away,
  and deleting the last comment keeps the section with a 0 count. (4)
  `ActivityLogSection` is scoped to the ACTIVE NODE (its own Created stamp +
  an Edited stamp when updated postdates creation); the workspace-wide
  created query and pages/classes edited lists are retired — no query
  exists at all now (two node-column reads), so the lazy contract holds
  trivially. (5) `PropertiesSidebar`'s rows ride a NodeViewSection,
  expanded by default — the column names itself with a collapsible header
  and keeps its divider while collapsed. Verified: `pnpm typecheck`; the
  full web vitest suite (136 files, 1412 tests) green, incl. the rewritten
  activity-log / comments / context-column / properties-panel contracts.
  Docs: `docs/ux.md` (Activity paragraph, the layout sentence, the sidebar
  note), `docs/usage.md` (the layout sentence + the context-column item).
  Display-state only — no model/wire change, no fixtures.

- **fix(web): the single-value selection cell names its value with ONE
  compact pill (effective-colored, no subtree), multi-value object pills
  cover every resolved value, and the date cell's repeat picker stops
  overlapping the value.** The first redraw shipped the single-value
  dropdown's content as a read-only block row — which rendered the linked
  node's WHOLE subtree (children, collapse chevrons, backlink gutter) inside
  the field; the owner asked for "a pill and that's it". The cell's content
  is now the shared `NodePill` element tinted with the linked node's
  effective color (`NodePill` renders a non-interactive label span when the
  host carries the click — the dropdown does); the multi-value branch drops
  its inline-block special case the same way, so every resolved object value
  rides one compact pill (the editable-block treatment stays the TEXT
  property row's contract, not object values'). The date cell's trailing
  repeat picker (the kit Dropdown) defaulted to `width: 100%` of the flex
  row and drew over the trigger text — inside `.nt-property-select` the
  trailing dropdown now hugs its icon (`width: auto; flex-shrink: 0`), and
  the trigger content truncates honestly. The ⟳ control itself is the
  recurrence picker (None/Daily/Weekly/Weekdays/Monthly/Yearly, written as
  the RRULE-lite `metadata.repeat` — SCHEMA.md "Recurrence"), preserved
  from the pill era. Display-state only; the web suites around the panel
  re-run green with the pill-content assertion updated. Docs:
  `docs/ux.md`'s "Single values select" bullet now says one compact pill.

- **fix(web): the export modal's child outline is unconditional — the
  "Include child outline" toggle is gone — and the preview re-runs when the
  worker's cached reads land.** The reported symptom: child blocks were
  missing from the markdown preview until the toggle was unchecked and
  re-checked. Root cause was a race, not the toggle: `WorkerClient.getChildren`
  seeds its cache EMPTY and fills it async, and the preview effect never
  re-ran when the fill landed — the first preview of a fresh modal ran
  against an unpopulated children cache, and only an options change forced a
  re-run (the re-toggle "fixed" it by accident). The modal now subscribes to
  the client while open and re-runs both previews (markdown + PDF) on
  notification. And the toggle itself retired (owner ruling): child blocks
  are part of the content — they ride recursively in every export with main
  nodes excluded from the block zone by the engine's childrenOf contract, so
  a switch that hides the content's own children made no sense; the modal
  hard-codes `includeOutline: true` (the package option stays for the CLI).
  Verified: new modal spec drives the race through a stubbed client (empty
  children → notification → bullets appear, no toggle); the retired-toggle
  spec asserts the checkbox is gone and the outline survives other option
  changes; web 1396+30 green, packages/export 236 green.

- **feat(web): the properties panel's value cells redraw — single-value node
  and date properties are full-width selection dropdowns (the selected node
  rides the content area as a read-only block row, never a pill), multi-value
  node pills share the nodeview classes list's pill element tinted with the
  linked node's effective color, empty cells keep the full width with honest
  placeholders, and the sidebar separates its properties with hairlines.**
  (1) `NodePills`' pill shell is extracted into a shared `NodePill` element
  (`apps/web/src/ui/components/NodePills.tsx`) — the class pills render
  through it unchanged, and multi-value node-typed property cells now render
  their value pills through it too, colored by `effectiveNodeColor` of the
  linked node (own color, else its classes') with the same hover-reveal ×,
  label-click-opens-node, and broken-reference dashed chip. (2) Single-value
  (`multi: false`) node-typed and date properties render the new
  `PropertySelectCell` (`MetadataSection.tsx`): a full-width dropdown trigger
  whose content area shows the selected node as a READ-ONLY block row via
  `ReferenceSubtree` (date values show the date node's display name — a raw
  block row would leak the chain's compact YYYYMMDD storage label, the leak
  `dateDisplay.ts` exists to prevent); empty shows the muted "Select"
  placeholder; clicking opens the same ported pickers as before
  (NodeSelector / DatePickerPopup, now anchored at the trigger); a clear
  affordance unsets the authored slot; re-picking replaces the slot in place;
  the date repeat picker, link qualifiers, and asset annotations ride the
  cell's trailing chrome. The trigger is a `div[role=button]`, not a native
  button — the content area hosts the block row's own interactive bits,
  which a `<button>` cannot legally wrap. (3) Empty value cells keep the
  value column's full width so they read as empty fields: single-value node /
  date cells show the "Select" placeholder, and a bound-but-empty text
  property renders the full-width "Type something" placeholder input (typing
  authors the first carrier block). (4) The properties sidebar separates its
  properties with a hairline under each row (the previous "no horizontal
  rules" ruling is superseded). Multi-value rows keep their pills + "+ Add"
  affordance unchanged; the asset-typed row (Upload / Link list) is
  untouched. No model/wire change — display-state only, no fixtures. Verified
  by the web vitest suites (7 files, 82 tests around the panel re-run green;
  full gate green) including new coverage: the single-value dropdown's
  read-only block row + clear, the multi-pill effective-color tint, and the
  empty-text placeholder. Docs: `docs/ux.md`'s Properties paragraph.

- **fix(web,domain): the Highlight system class renders its icon again — the
  seed carried a name that never existed in MDI.** `SYSTEM_CLASS_ICONS.highlight`
  was `mdiFormatHighlight`; the real Material Design Icons name is
  `mdiFormatColorHighlight` (verified against the shipped sprite and the
  upstream project — `format-highlight` 404s there). Every other system class
  icon resolves; only Highlight's silently rendered nothing. Two layers:
  the seed now carries the real name (new workspaces, any future deploy),
  and the web `Icon` resolver — whose contract is already normalizing legacy
  stored values (JSON-wrapped rows, `mdi mdi-` prefixes) — gains a
  `LEGACY_ALIASES` table mapping `format-highlight` → `format-color-highlight`
  so every existing workspace's stored rows render without a log migration
  (the seed/self-heal paths are existence-checked and never rewrite an
  existing class). Verified: new `apps/web/test/icon-resolve.test.tsx` (6
  specs: camel/kebab/`mdi mdi-` forms, the alias both prefixed and bare, JSON
  unwrap, emoji passthrough, empty), domain package 74 green, `pnpm
  typecheck` green. No wire/model change — no fixtures, no lockstep.

- **fix(web): the panel/sidebar toggles get honest icons and a visible
  register — owner rulings, recorded in the design system.** The icon
  depicts WHAT the panel is: the app top bar's left sidebar and right cards
  rail wear the dock family (`mdi-dock-left` / `mdi-dock-right` — a content
  area with the panel docked at the edge, the pair one family, replacing
  today's earlier `mdi-menu` hamburger and `mdi-card-multiple-outline`
  experiments); the nodeview bar's properties toggle is a dotted list
  (`mdi-format-list-bulleted`, the panel's row-per-property shape) and its
  context toggle an info mark (`mdi-information-outline`). Both nodeview
  toggles also move from the borderless `nt-icon-btn` to the kit `Button
  variant="outline"` (size sm) — a persistent panel toggle is visible chrome,
  so the border stays; the `active` state carries the open/pressed signal
  (`aria-pressed` unchanged). The rules land in the `rosellramos-design-system`
  skill (`references/dos-donts.md`: the what-the-panel-is icon rule + the
  outline register for persistent toggles, and the rejected
  hamburger/layout-diagram/cards icons). Verified: `pnpm typecheck`; the web
  vitest panel/context suites green. Display-state only — no model/wire
  change.

- **fix(web,export): the export block zone loads child blocks recursively and
  excludes main nodes at every level — and a page parented under a block is
  hoisted into the child-page list instead of silently dropped.** Verified
  the semantics across every export path: the markdown bundle nests inline
  blocks to arbitrary depth in the page file (pinned by a package spec) with
  child pages filed separately, never as bullets; the PDF body recurses the
  inline zone with main nodes filtered per level (pinned by a component
  spec), and its end list now walks through inline blocks for main
  descendants (`childPagesOf`) so a page nested under a block still appears
  as a titled entry instead of vanishing between the zones. Verified:
  packages/export 236 tests green, web export-pdf 16 green.

- **feat(web,store): the graph view's v1 register, 1:1 — the settings
  popover, four node-sizing modes with the radius slider and link direction,
  mass accumulation in the engine, split journal visibility, multi-select
  with the reorderable selection list, ordered class colors, and
  bidirectional edges drawn as one arrow with two heads.** Owner ruling
  (law 0): a v1 port ships the ENTIRE v1 register, not a reduced subset.
  (1) **The cog settings popover** (kit ButtonWithPanel): Simulation,
  Link-count attraction, Central gravity, Mass accumulation, Node sizing
  (Uniform / Connections / Mass / Content — the v1 four), the Node radius
  slider (3–20, the v1 range), Link direction (all/incoming/outgoing, the
  connections mode), and a Visibility section — **Day / Month / Year pages**
  replace the single Journal switch (each level toggles independently; the
  shipped default keeps the chain off) plus **System pages** (the seeded
  Inbox + the withdrawn scratchpad). (2) **Node sizing rides the v1 curve**
  (`nodeRadius.ts`, pure + unit-tested): MIN 4 / MAX 18 with the v1 power
  exponents (0.7 connections/content, 0.8 mass); the store topology
  projection now carries `contentSize` (descendant blocks, stopping at
  nested main nodes) and `mass` (recursive descendant weight, cycle-safe) per
  node — one memoized walk serves both. (3) **Mass accumulation reaches the
  integrator**: `GraphEngineNode.mass`, `useMass` in the raw config, a
  mass slab, and acceleration divided by mass (heavier parents resist — a
  lone mass-9 node under identical gravity covers measurably less ground,
  the new engine test). (4) **Multi-select** (the v1 register): clicking a
  node toggles it in the selection, double-click opens (and clears), empty
  click clears; the toolbar's **Selected · N** popover lists the selection
  (kit ListSortable drag-reorder, per-row remove, Clear); the renderer
  highlights every selected node (rings + neighbor dimming, the ring buffer
  grows to a 64 cap); the search field now **adds nodes to the selection**
  (results dropdown, Enter takes the first) — the old jump-the-camera
  single-select is retired. (5) **Class colors** in the Colors popover: an
  ordered list (add any class via a searchable Dropdown, kit ColorButton per
  row, drag to reorder, remove) that paints **before** the query groups —
  precedence: class color → query group → the node's own color
  (`nodeVisuals.ts`, pure + unit-tested); new entries cycle the preset
  palette. (6) **Bidirectional relations render as one arrow with two
  heads**: the renderer's new edge plan (`planEdgeRender`, pure +
  unit-tested) dedupes reciprocal same-kind pairs into a single edge quad
  and emits a head at each end; one-direction relations keep their single
  head; property/semantic stay arrowless. (7) **The settings memo takes
  field-level deps** — pause/radius/sizing/preset changes no longer rebuild
  the whole GL stack + engine (every pref change did, before); radii and
  colors reapply live through `setNodeVisuals`. All graph prefs (incl. class
  colors) persist device-local in the existing per-surface blob — settings
  sync across devices (v1's server-side persistence) is a follow-up
  proposal. Verified: the graph + store suites green (store 459 incl. the two
  new projection specs; web graph suites incl. the new `graph-sizing` suite
  and the updated toolbar-composition spec — the residual gate reds at ship
  time were the parallel session's in-flight property-row work, untouched
  here); live-stack probe on the real 7.5k-node workspace (the settings
  register renders, search adds to the selection, zero console errors). Docs: usage.md graph section rewritten to the register.

- **fix(web): honest icons for the chrome toggles — the top bar's sidebar
  buttons and the nodeview panel toggles stop posing as layout diagrams.**
  (1) The app top bar's left-sidebar button is a plain hamburger
  (`mdi-menu`, the affordance the header doc always claimed) and its
  right-sidebar button is a stack of cards (`mdi-card-multiple-outline`) — the rail
  hosts workspace cards. (2) The nodeview top bar's properties-panel toggle
  is a properties affordance (`mdi-tune-variant`) and its context-panel
  toggle a docked-right-panel (`mdi-dock-right`); the context toggle moves
  from the bar's left cluster to the right cluster, between the blocks view
  switcher and the "…" node menu (owner: it belongs with the chrome it
  reveals). `chromeRight` splits into `chromeModes` + `chromeMenu` (NodeView
  → PageView → NodeTopbar) so NodeTopbar can interleave the toggle; the
  compact corner renders the two back to back as before. Verified: `pnpm
  typecheck`; the web vitest suite — the panel/context/modals suites (57
  tests) included, all green except the parallel session's two in-flight
  graph failures. Display-state only — no model/wire change, no fixtures.

- **feat(web): the block tree's vertical indent line is itself a collapse
  control — click the line to fold the direct children of the block it starts
  from (the v1 gesture), and the bullet stops riding low.** (1) Every
  `.nt-block-children` hairline now carries a full-height rail
  (`.nt-block-children__rail`, border + gutter only — no child content lives
  in the strip, so child clicks are never eaten); clicking it toggles the
  same session-local collapse as the chevron, hiding that node's children
  (its whole subtree) and lighting the collapsed ring on its bullet. The rail
  renders only when collapse applies (never in prose view, never in table
  projections) and hover/focus paints an accent hairline as the affordance.
  (2) The row is baseline-aligned, so the fixed 22px bullet box sat ~2px
  below the text's visual center; `.nt-bullet` gains a `translateY(-2px)`
  optical correction — measured delta went from +1px (below the line-box
  center) to −1px (on the cap-height middle). Verified with a live probe
  (`scripts/screenshots/bullet-align-probe.mjs`): playwright measures the
  dot-center vs first-line-center delta and clicks the rail against a seeded
  nested page (children containers 1 → 0, collapsed ring appears); the
  outliner/block vitest suites (95 tests) stay green. Docs: the collapse
  parenthetical in `docs/ux.md`'s outliner section. No model/wire change —
  display-state only, no fixtures.

- **feat(web,export): export downloads carry the node's name + a local
  timestamp; the PDF mirrors the page view (single-title body, inline blocks
  nested body-only, child pages as the end list); v1-migrated property values
  stop leaking raw uuids; booleans render as checkboxes; main node vs block
  node is now defined vocabulary.** (1) Every modal download name is
  `<node-name-slug>-<YYYYMMDDHHmm>.<ext>` — the export modal's single-file
  formats (markdown/html/latex/docx/pdf/json archive), the batch zip names,
  and the table view's CSV/XLSX — so repeated exports of one node never
  overwrite each other in the download folder; in-zip entry names keep the
  E3/E5 `<slug>-<id8>` conventions untouched. (2) The PDF layout restructures
  to the page view's shape: the root title renders once (the single-title
  rule — `withoutLeadingTitle` — now applies to the PDF body, which used to
  repeat the title as its first paragraph); the literal "Outline" heading and
  its divider are gone; inline BLOCK children render nested in the body with
  no title heading (block nodes carry no chrome); child PAGES form the
  separate recursive end list, each a titled entry whose body no longer
  repeats its title (`withoutLeadingTitleBlocks`, exported from
  `@notees/export`). (3) V1-migrated data rides the log with BARE uuid
  strings where v2 wants `{ nodeId }` refs (verified against the live relay:
  an imported book's "Última consulta" date) — the export IR
  (`resolvePropertyDisplay`), the PDF, and the table/cards/CSV/XLSX display
  (`propertyDisplayText`, which also learned date_range display and dropped
  its silent array-entry drop) now resolve bare strings on node-typed schemas
  (date/object/asset) through the settings-aware name resolver; the web
  resolver formats date nodes per the user's dateFormat, so the uuid leak is
  gone everywhere. (4) Property metadata qualifiers resolve at IR build time
  (`resolvedQualifiers` + `qualifierTail`) — markdown/html/latex/docx/PDF all
  render `startDate 2025-06-24`, never a raw uuid or `[object Object]`. (5)
  Booleans render as checkbox glyphs (☑/☐) in every text projection; the PDF
  draws a real vector checkbox (rect + check polyline, no font-glyph
  dependency). (6) SCHEMA.md "Node structure" + AGENTS.md + the development
  skill now define the terms: a **main node** renders with document chrome
  (`is_class = 1` OR no parent OR `present_as_main = 1`); a **block node** is
  a parented non-class node with `present_as_main = 0` — inline in the
  parent's body, no title. Verified: `packages/export` 235 tests green (16
  new leniency/single-title specs), web export-pdf/modals-overlays suites
  green (7 new structure specs), download-name assertions moved to
  `-<12-digit stamp>` regexes.

- **fix(web): one corner radius for every text button — the md/lg sizes drop
  from 16px to the shared 12px.** The 16px `--shape-button-large` token made
  big text buttons ("Resync now", dialog actions) read nearly pill-shaped
  against the rest of the chrome, while square icon-only buttons sat at
  6–12px; the two no longer looked like one family. All text-button sizes
  (base/xs/sm/md/lg) now use `--shape-button-small` (12px), icon-only sizes
  keep their per-size radii, and the now-unused `--shape-button-large` token
  is gone (its only consumers were the two md/lg rules). Verified:
  `css-token-drift` gate green, full suite green.

- **fix(web): the graph view comes back to life — warm starts stop pinning
  the map, drag reaches the physics worker again, navigation is v1's
  1:1, the hover card drops its permanent hint, and the pause button works
  in worker mode.** (1) The freeze: every cached position was handed to the
  engine as `pinned`, so the first topology rebuild (~1s in, on the
  bootstrap-change notify) froze all 7.5k nodes at their warm-start spots —
  and with drag already dead nothing could ever move again. Cached positions
  are a starting point, not a pin; only fixed-layout (circle/tree)
  coordinates pin. (2) Drag: the v2 port renamed the engine's node
  identifier to `nodeUuid`, but `EngineController` still forwarded v1's
  `nodeId` field — the worker's drag/pin handlers read `nodeUuid`, so every
  drag silently no-op'd (verified against the live bundle). The controller
  now sends `nodeUuid`; a `graph-controller` test pins both sides of the
  wire. (3) Navigation is copied from the v1 renderer 1:1: pan was inverted
  on the vertical axis (`+dy` where v1 uses `-dy`), and cursor-anchored zoom
  mirrored Y the same way (the v1 additive anchor form replaces it, with
  v1's 0.02–40 zoom range); dragging also does the v1 instant local
  `overridePosition` so the node follows the pointer before the next worker
  frame. (4) The node hover card no longer carries the always-visible
  "Click to select · double-click to open" line — that belongs in the docs,
  not on the canvas (edge hover cards unchanged). (5) The pause/resume
  toolbar button now reaches the worker's clock (it only gated the
  main-thread fallback before, so it was a no-op in every real browser);
  reduced-motion's start-paused is applied at engine creation too.
  Verified: full gate green (134 files, 1386 tests, new
  `graph-controller` suite), live-stack probe against the real 7.5k-node
  workspace (graph animates, drag/trackpad paths traced through the fixed
  wire). Docs: usage.md graph section still accurate — the fix makes its
  wording true.

- **feat(server,web): env-gated signup (the sonarly pattern) + the context
  menu drops its banner entry.** (1) `NOTEES_SIGNUP_ENABLED` (default off,
  accepts `1/true/yes/on`) opens `POST /api/auth/signup`: creates a non-admin
  account (scrypt hash, KDF record, fresh session — the `/setup` payload
  shape), rate-limited on the login limiter. Off → the route answers **404
  `not_found`**, the surface does not exist at all (sonarly's contract, not a
  403); duplicate email → 409 `conflict` (the pinned taxonomy, no new code).
  `GET /api/server-info` advertises `signupEnabled` so the client discovers
  the flag (older servers predate the field — the client treats absent as
  closed). (2) Web: a **signup phase** on the boot screen — the login
  screen's account tab shows "No account yet? Create one" only when the
  server advertises it; the signup form (email/password/confirm,
  `autoComplete="new-password"`) lands in the same workspace picker as login;
  a 404 mid-flow maps to "Signups are disabled on this server." (3) The page
  context menu no longer offers Add/Change banner — the banner row's own
  affordance is the UI (owner ruling: one surface per action); `onAddBanner`
  plumbing removed from NodeContextMenu/PageView, stale comments swept.
  Verified: server suites (new `env-gated signup` + config parse tests, 33
  auth tests green), web app-smoke (new signup affordance tests) +
  page-banner suites green, OpenAPI coverage gate green (the signup route is
  in the document). Docs in the same pass: deployment.md env table,
  .env.example, compose.yaml, usage.md (boot + scope), ux.md/usage.md banner
  lines, architecture.md account routes.

- **feat(web,query,protocol): the v1 block model 1:1 — every block is
  [type select][operator select][typed value], with the static/dynamic
  node-target mode, the edit-date family, and two more wire conditions.**
  Owner ruling (2026-10-09): the port must be 1:1 with v1, not a reduced
  subset — the law is now in the notees-development skill (law 0). (1) Block
  restructure: the TYPE column morphs the block across the twelve v1
  families (Class, Type, Placement, Content, Property, Links, Parent, Cover,
  Banner, Alias, Created, **Edited**); the OPERATOR column carries the
  per-family options — is/is not (not-wrap sugar, boolean families flip
  their bit), contains/does not contain/full-text, the nine property
  operators incl. **is set / is not set**, after/before for dates, is set /
  is not set for the wire fields; the VALUE column reuses the
  property-table inputs (numeric keyboard, node picker, placeholder
  datalist). (2) **Static/dynamic mode switch** on Links and Parent (the v1
  VALUE_MODE register): dynamic nests a full query builder under the row
  defining the TARGET SET — "links to a person node with age > 50" — backed
  by two new wire conditions, `linkedToQuery {root}` / `descendantOfQuery
  {root}`: the compiler generalizes the backlinksWithRollup and subtree CTEs
  to anchor SETS (the nested group's matches; the single-anchor forms reduce
  exactly), protocol validates the nested group in-schema (group/not/child
  schemas moved ahead of the condition union), and the web evaluates them
  through the probe channel. (3) **updatedAfter/updatedBefore** wire
  conditions (the edit-date facet; store `updated_at` + ClientNode
  `updatedAt` already existed) with compiler arms and sync evaluation. (4)
  The kit SearchField loses the accent focus glow (border shift only, owner
  review) and gains an inside-right **× clear** button while a value rides
  (the FilterBar wires it). (5) List-view chrome: the outliner BLOCK collapse
  button trades its raw Unicode triangles for the sprite chevrons
  (mdi-chevron-right/down — the glyphs read as arrows), and the group list
  gets real top padding below the hosted tabs. Verification: protocol dist
  rebuilt; query suite green (195/195 —
  dynamic-link equivalence, the owner's example shape, NULL-update law,
  dynamic-parent); web suite green (the dynamic-Links e2e drives the nested
  builder and asserts the probed AST carries the nested group verbatim);
  `docs/usage.md` §Section filters rewritten.

- **fix(web): the add-condition trigger sits in the app's quiet button
  register.** Owner review: the bordered-field treatment (fill + border)
  read too dark against the panel, and the "+" icon argued with the
  dropdown affordance — the chevron alone now signals the list, on a
  transparent ghost button like the rest of the chrome. Verification: the
  filter suites green.

- **feat(web,query,protocol): the builder's full link/parent wiring — a new
  `descendantOf` wire condition, links-to + full-text probe support in the
  transient filter, the GridMenu kit popup, and the root de-grouped.** Owner
  round (2026-10-09): (1) a **parent-is** condition was missing from the
  wire grammar entirely — `descendantOf { nodeId }` now matches rows whose
  ANCESTOR CHAIN (any depth up the parents tree, self excluded) contains the
  chosen node: additive zod condition in protocol, compiler arm reusing the
  subtree CTE (`subtree membership minus the anchor`), and a cycle-guarded
  sync walk in sectionViewResolve (so it evaluates locally, no probe). (2)
  **links to** (`linkedTo`) and content **full-text** (`fts`) join the
  builder — the two probe-path leaves now ride useSectionData's probe arm
  (one membership query per leaf through runQueryAst, intersected with the
  base rows, mirrored from useSectionViewResolution — the one-evaluation
  ruling; the last landed probe applies while typing, no flash). (3) The
  add-condition popup is the new kit **GridMenu** (a global component) with
  a `columns` prop — `"auto"` fits as many columns as the width allows —
  and the popup now spans the query-builder container's width, measured via
  ResizeObserver. (4) The add-condition trigger wears the DROPDOWN register
  (bordered field + rotating chevron) — it offers a list, it doesn't act;
  the rule is added to the rosellramos-design-system skill. (5) The root
  level is not a group: no "Empty group" count, no "No conditions in this
  group" placeholder, and the standalone **Add group** button is gone (the
  menu's All-of/Any-of entries are the group constructors). (6) Corner
  radius reduced at the token level: modals 28 → 12px and default
  cards/popups 20 → 12px (`card--radius-md` → `--shape-extra-large`; Modal
  `xl` → `md`) — page cards keep their 20px. Verification: protocol dist
  rebuilt; query suite green (133/133, four `descendantOf` cases incl.
  depth-2 chains and the anchor-exclusion); web suite green (the two new
  builder e2e — Parent-is sync, Links-to probe — plus the registry/menu
  updates); `docs/usage.md` §Section filters rewritten.

## 2026-10-08

- **fix(web): native control chrome follows the theme — the property
  settings modal, the ToggleSwitch white pill, and the table number
  spinners are dark-true.** Reproduced on a throwaway stack (playwright
  probe, verified by screenshot): the app themed via CSS variables but
  never declared `color-scheme`, so every UA-rendered control part stayed
  light under dark themes — the settings modal's inputs (its
  `__field/__label/__input` classes had no styles at all, ever), the
  ToggleSwitch root (a `<button>` showing the light UA button-face around
  the track — the "white pill"), and the number spinners in table cells.
  Three fixes: `color-scheme: light/dark` on `:root`/`[data-theme="dark"]`
  (one line kills the whole bug class — inputs, spinners, scrollbars,
  button faces), an explicit reset on `.toggle-switch` (transparent root —
  only the track is a surface), and the missing property-settings field
  chrome (label-above-control register, token inputs, focus ring). The
  modal's ToggleSwitch rows also gain real layout (the fields were inline
  labels that wrapped mid-row). Verification: throwaway-stack screenshots
  before/after (modal + number-cell zoom); web suite green.

- **fix(web): the structured panel keeps its bordered box.** Owner review on
  the in-flow redesign: the open hairline region read flatter than the rest
  of the chrome — the border + surface frame pairs with the filter search
  box in the control row. The panel is again a boxed region (border,
  `radius-md`, surface-container), still in-flow and full width; the
  builder internals stay un-carded and the add menu stays portaled.
  Verification: web suite green.

- **feat(web): the query builder is an in-flow region with flat list chrome
  — the boxed floating panel is gone (owner review).** The structured panel
  had read as a modal: a bordered floating overlay (a persistent float,
  where the app only floats transient pickers) containing a kit Card with
  header/footer bands — card-in-card. Now: the panel expands IN the layout
  between the toolbar row and the collection, full width, one hairline
  above it (in the classed-nodes toolbar the inline FilterBar renders with
  `display: contents` — control row on the flex line, panel on a wrapped
  full-width line; `ViewToolbar` wraps). Inside, the group cards are
  un-carded: the root group is a bare column (logic toggle + count on one
  quiet line), nested groups indent under a left hairline, condition rows
  are transparent list rows with a hover fill (the sidebar-row register),
  and the kit Card survives only on the transient add-menu popover — the
  one surface elevation is legal. The region change also frees the builder
  from the `42ch` search-box cap (deep nesting breathes) and deletes the
  whole overlay-clipping bug class. Verification: `pnpm typecheck` clean;
  web suite green (1377/1377).

- **fix(web): the builder's add-condition menu is unclipped and readable in
  dark mode.** Two defects in the new block query builder: the add menu
  (`ButtonWithPanel`, non-portal) rendered inside the kit group Card, whose
  `overflow: hidden` clipped it at the card edge; and the menu items had no
  explicit `color` — `<button>` UA `color: buttontext` painted the
  description text black in dark mode. The menu now portals to
  `document.body` (viewport-clamped, positioned under the trigger), the items
  carry token colors with hover/pressed/focus-visible states, and condition
  rows gained a hover border. Verification: `pnpm typecheck` clean; web suite
  green (1377/1377 — the two filter suites' menu helpers query the portaled
  panel).

- **feat(web): the filter bar's structured panel is the v1 query-builder,
  ported over the query AST — block condition rows, nested Match ALL/ANY
  groups, NOT wrappers, per-row reorder, live "N of M rows match".** The
  flat-AND FilterSpec grammar (and its one-field-per-facet panel) is gone;
  the bar's state is now a `FilterQuery` — the quick-search text plus a draft
  query-AST root group the new `FilterBlockBuilder` edits (the v1
  FilterBlocks/ConditionGroupBlock/AddFilterButton registers, adapted to the
  v2 kit: SelectionButton logic toggle, ButtonWithPanel add menu, Card group
  cards, token-only CSS — the v1 per-type accent colors are gone). The draft
  prunes into the schema-valid composed group (`filterQueryToGroup`: blank
  content values, unpicked classes/properties, blank timestamps drop; the
  text unshifts as a content-contains condition), and the one evaluation
  implementation (`sectionViewResolve`) consumes it through a new exported
  `createSectionViewMatcher` — no second evaluator. **The one-evaluation
  ruling:** property conditions now evaluate synchronously over the
  effective-values read model in `sectionViewResolve` (`getEffectiveProperties`
  joined the resolve-client surface; the scalar/ISO-date arms moved verbatim
  from the deleted filterSpec.ts), so hosted custom tabs stop probing the
  server for them — only content-fts and linkedTo remain probe-path leaves,
  and the bar's add menu deliberately does not offer them (nor linkedTo)
  because the transient layer must evaluate on every keystroke.
  `useSectionData`'s filter is now `{ group, nodeOf }`; a plan needing the
  probe channel keeps rows unfiltered and warns once, never throws. The
  offered kinds: class, type (isClass), placement (presentAsMain), content
  contains, property, created after/before, has cover, has banner, is alias,
  plus All of (AND) / Any of (OR) / Exclude (NOT) constructors; the
  FilterBarConfig facets gate the text field and the class/property/date
  kinds. Verification: `pnpm typecheck` clean; full gate green (133 files /
  1377 tests — new `filter-query.test.ts` prune + semantics battery through
  the matcher, new `filter-builder.test.tsx` e2e, `filter-layer` +
  `section-views` reworked, the CSS token-drift allowlist gained the
  `--nt-fb-depth` JS-scoped entry); `docs/usage.md` §Section filters
  rewritten.

- **fix(web): one divider, not two, above the backlinks strip — and no
  dangling line on an empty sections stack.** The hide-when-empty rulings
  left `.nt-backlinks` as the first child of `.nt-page-sections` whenever
  the Child pages section was gated off, and both containers carried their
  own top hairline — two adjacent lines read as a double divider. The
  strip's hairline now suppresses when it is the wrapper's first child (the
  wrapper's line is the separator); and `SystemSections` returns null when
  all three counts are zero, so a childless, referenceless page no longer
  renders the wrapper's hairline over nothing. The early return rides after
  every hook — the component flips between null and rendered as counts
  change, so the hook order must stay unconditional. Verification:
  `pnpm typecheck` clean; the section/layout suites green
  (system-sections, focus-mode, whiteboard-canvas, page-layouts).

- **feat(web): the hide-when-empty ruling covers every system section —
  Child pages and the backlinks strip vanish at zero, and the strip's Add
  child page affordance is gone.** Owner ruling (2026-10-08): a page with
  nothing to show shows nothing. The Child pages section now gates on
  `childPageCount > 0` alone (previously `> 0 || can-create`) — its empty
  state's **Add child page** button died with it (the `embedded` prop's only
  other use; it is gone from `SystemSections` and the two `PageView` call
  sites), while the `Section` component's `emptyText` ("No child pages.")
  stays as the honest rows-empty branch. The backlinks strip (Backlinks +
  Unlinked mentions) renders only while `backlinkCount > 0 ||
  unlinkedCount > 0` — the "both tabs always show" ruling (owner
  2026-10-06) now applies once the strip renders, and a live filter emptying
  a tab keeps the chrome (the gate reads the UNFILTERED counts). The
  always-mounted hosted-views chrome from the previous slice is unchanged —
  it governs the rendered strip, not the gate. Verification: `pnpm typecheck`
  clean; web suite green (1366/1366 — the childless-page tests rewritten for
  the gate plus two new reveal tests: first child page, first backlink);
  `docs/usage.md` + `docs/ux.md` updated.

- **feat(web): the hosted-views tab bar always shows — even on an empty
  section; the empty line rides the selected tab's body.** Three containers
  short-circuited the empty state before `NodeCollection` ever rendered, so
  the section tabs (Default + "+" + the custom views) vanished exactly when
  there was nothing to list: `CollectionSection` and the backlinks/unlinked
  strips rendered their own `nt-section-empty` div instead of the
  collection (the classed-nodes section already rendered the collection —
  unchanged, it keeps its EmptyState create affordance). `NodeCollection`
  gains an `emptyText` prop: when the collection is empty and no EmptyState
  is configured, the subtle empty line renders in the selected tab's body —
  the container's text ("No backlinks.") on the default tab, the honest
  "No matching rows." on a custom tab refined to empty. `CollectionSection`
  and `ReferenceList` now always render the collection and pass their
  `emptyText` through; the block-level backlink gutter (unhosted, no
  emptyText) is untouched. Verification: `pnpm typecheck` clean; web suite
  green (1364/1364 — two section-views tests added: tabs + empty line on an
  empty collection, "No matching rows." on a refinement-emptied custom tab);
  `docs/ux.md` updated.

- **fix(web, domain): date formatting applies only to date-classed nodes, and
  date pages format everywhere they render.** Two halves of one ruling. (1)
  Until now ANY node whose title excerpt matched the 8-digit shape was
  formatted as a date — the sidebar Recents/Favorites rows render the raw
  content tokens (so date pages showed the compact `20261008`), while Table
  view and every `deriveDisplayName`/`fullTitleOf` reader reformatted
  ordinary pages with ISO-style titles. Now the domain derivation formats
  only date NODES: a deterministic year/month/day id formats from the id
  (`dateNodeDisplayLabel`, canonical `YYYY/MM/DD` shape — the web's
  `dateDisplay` funnel keeps applying the user's `dateFormat` setting), and
  the compact-label content branch (`formatDateNodeName`) requires a
  year/month/day class in `classIds`; everything else keeps its literal
  title. The web's `isDatePageNode` drops the name-shape fallback (the
  deterministic id covers migrated date pages), so an 8-digit-titled page no
  longer lands in the palette's Date Pages pool either. (2) Sidebar
  Favorites/Recents rows render date pages through the same setting-aware
  display name as every other surface instead of the raw content tokens.
  **Verification:** new domain cases (literal 8-digit title without a date
  class; id-only formatting) and web `date-display` cases (name shape alone
  is not a date page); measured against the live sidebar Recents and the
  Pokemon class page; full monorepo gate green.

- **fix(web): the child-blocks ghost row gets real clearance before the next
  section's separator — the negative-margin cancellation is gone.** The
  2026-10-08 morning fix pulled the empty child-blocks surface up by exactly
  the ghost row's 2px bottom padding so the next section's border sat "flush"
  — flush turned out to mean the hairline touches the `+ Add block` label's
  line box, which in dark theme reads as the label sitting on (overlapping)
  the separator, on every surface (class view's Class properties, the day
  page's Created section). The `.nt-select-surface--empty` pull and its
  PageView class toggle are removed: the ghost keeps its own bottom padding,
  so empty and non-empty surfaces share one rhythm and the separator has
  genuine clearance. **Verification:** the throwaway probe stack measured the
  day page and the class page before/after (border flush against the label
  box before, ~4px clear after); full monorepo gate green.

- **feat(web): one chrome row for the classed-nodes section, icon-only
  buttons wear hover tooltips, and the table's data actions move behind a
  "…" menu.** The class page's Classed nodes section stacked its chrome
  three high: a full-width Filter bar, then the view toolbar (Add member +
  view switcher), then the tabs. The FilterBar gains an `inline` layout
  (control row joins a toolbar's flex line, capped at `42ch`; the
  structured-filters panel drops below as a floating overlay anchored to
  the bar, `z-popover`, same border/surface register — the zero-elevation
  law), and ClassedNodesSection renders it inside the ViewToolbar left of
  the now icon-only **+** (tooltip "Add member") and the view switcher.
  Icon-only no-text buttons across the chrome gain hover tooltips (native
  `title`, the codebase convention): the FilterBar's structured-filters
  toggle ("More filters") and clear ("Clear filter"), the member-row ×
  ("Remove from class"), and `Tabs.AddButton` (title defaults to its
  aria-label — the section views' add-tab "+" gets "Add custom view"). The
  table view's toolbar no longer carries three text buttons: **Export
  CSV**, **Export Excel**, and **Import table…** move into a far-right
  **…** menu (kit `Button` + `ContextMenu`, `alignRight`, at the
  view-type level next to Columns/Sort) — the view-type level over the
  global level because the exports are table-specific (they read the
  table's sorted rows and visible columns; meaningless in outline/cards).
  Selection-scoped exports stay inline by the selection count. Verification:
  `pnpm typecheck` clean; web suite green; `docs/usage.md` + `docs/ux.md`
  updated.

- **fix(web): the day-page Today flag wears the solid primary pill.** The
  flag styled itself with `--color-primary-container` (#f0f0f0 light) — on
  the near-white page card it read as no background at all. It now takes the
  calendar view's today-marker register: solid `--color-primary` pill,
  `--color-on-primary` text, `--shape-full` radius, `micro/2` padding, so the
  two Today surfaces render identically. Verification: `tsc --noEmit` clean;
  web suite green (1361/1361).

- **fix(web): the date pages' and calendar's Created section lists main nodes
  only.** The `createdAt` range query behind the Created section (day pages)
  and the calendar day view's Created tab matched every node created in the
  window — including blocks, which are inline scaffolding, not content. The
  AST now carries an "isClass OR presentAsMain" arm (the graph's main-node
  predicate — root nodes default to main at projection time, so nothing that
  should list is lost). Verification: web suite green
  (`calendar-view-utils.test.ts` extended to assert the main-nodes arm);
  `docs/usage.md` + `docs/ux.md` updated.
- **fix(web): the collapsed banner strip loses the dark bar and keeps its
  chevron — cover-card parity.** The collapsed banner rendered as a filled
  `--color-surface-container-low` band across the page card, which in dark
  mode (and pure black under OLED) read as a black bar, and its chevron was
  `opacity: 0` until hover. The cover card's collapse chevron — persistent at
  `--opacity-60`, full color on hover, transparent background — is the
  established register, so the strip now matches: transparent background, no
  hover fill (the cover arrow has none), chevron always visible at rest
  opacity. Verification: `pnpm typecheck` clean; web suite green
  (1361/1361; a pre-existing "Database closed" teardown flake in
  `journals-view.test.tsx` passes in isolation).

- **chore(web): drop the dead `.nt-hub-*` CSS and repair the screenshot
  probes.** The hub rows moved to `.outline-row` (CollectionHub restructure)
  but app.css still carried six unused `.nt-hub-list` / `.nt-hub-item` /
  `.nt-hub-item-icon` / `.nt-hub-item-label` / `.nt-hub-empty` rules; they
  are deleted. The `scripts/screenshots` probes were broken two ways: they
  seeded/typed `http://127.0.0.1:8377` as the sync URL, which the server's
  CORS allowlist (localhost origins) rejects — everything now uses
  `localhost`, matching verify-min — and `page-probe` clicked the dead
  `.nt-hub-item` selector (now `.outline-row`) with a placeholder-text
  palette assertion that could never pass (now checks the palette's search
  input). Verification: `page-probe` runs green end-to-end (opens a page,
  screenshots, Ctrl+K palette opens); drift gate 5/5; `tsc` clean.

- **feat(web): the page header title reads in Newsreader.** The brand type
  table puts the 28px H3 in the Text role (Newsreader), and the identity
  claim is "Newsreader for the words, Instrument Sans for the chrome" — the
  header title is the top of the reading experience, not chrome, so
  `.nt-title-content` rides the content face (`--font-family-content`, opsz
  auto) like the body rows. The old "stays chrome" comment (a holdover from
  the title-as-BlockRow restructure) is corrected. The design-system skill's
  tokens note ("page header titles may use the content serif") was already
  written for this. Verification: web suite green; post-deploy screenshot
  probe of a document page in both themes.

- **fix(web): the design-system audit batch — every finding from the
  RosellRamos audit ships.** The audit (`.audits/design-system-2026-10-08.md`)
  found one Critical, 18 warnings, and a notes list; all are fixed. Critical:
  `--tactile-press-scale` was 0.88 (a 12% collapse on every Button press) and
  is now 0.96, with the Pill literals moved onto the token. Warnings: the
  graph minimap's two hardcoded rgba grays now ride new
  `--graph-minimap-dot` / `--graph-minimap-viewport` tokens (the renderer
  re-resolves on theme/accent/OLED flips, not just theme); the PDF export
  palette's Notes theme now actually matches the light-token values it
  claimed to mirror (accent stays a documented neutral ink — an export
  can't know the live accent); `SettingsPanel` composes the `Modal`
  primitive (focus trap, overlay-stack Escape); `Modal` gained an `ariaLabel`
  path and `ConfirmationModal` labels its dialog (no more unnamed
  destructive confirms); a "Skip to content" link leads the shell's tab
  order to the content card; the Slider has a Firefox
  `::-moz-range-thumb` focus ring; a new `useDelayedVisible` hook implements
  the <300ms loading rule (Button's spinner waits 300ms, disabled/`aria-busy`
  stay immediate); sidebar rows are real `<button>`s with a ≤3px accent
  indicator on the active row (previously active ≈ hover); NodePill is two
  real sibling buttons (no `role="button"`, no nested button) with the
  hit-area overlay on the open button; ToggleSwitch gained the invisible
  44×44 hit overlay and TextField's default height rides the 46px token;
  the topbar `ThemeToggle` delegates to `applyAppearance()` +
  `writeDeviceSetting` (OLED/settings no longer go stale); anchor-rendered
  Buttons now honor `disabled`/`loading` (`aria-disabled`, no href, no
  click); EmptyState follows the recipe (on-surface-variant title, ~60%
  subtitle); AddPill's documented dashed affordance is restored (and its
  duplicated hover rule merged); Button's stale `confirm` JSDoc is gone;
  SectionViewTabs' manage row composes `Button` (ghost/danger, xs); the
  auth-tab and whiteboard-card shadow leaks are gone; inline-edit and
  datepicker cells get an accent focus-visible ring distinct from hover;
  dead focus-suppression rules on non-focusable backdrops are deleted; the
  Spinner has an honest "…" fallback under reduced motion. Notes: 112 px
  font sizes → the `--font-size-*` scale, 61 px radii → `--shape-*`, 17
  floating popovers → `--shape-floating-panel`, 572 stale `var(--token,
  literal)` fallbacks stripped, the three off-lattice breakpoints nudged to
  768/768/1024, out-of-band line-heights normalized, and px line-heights
  converted. The drift gate grew from 3 checks to 5: px `font-size`, px
  `border-radius`, and color literals inside `var()` fallbacks now fail the
  build (the minimap literals were the live proof the CSS-only gate had TS
  holes — canvas paint stays a review duty). Verification: `pnpm typecheck` +
  `pnpm test` green; three tests updated to the new contracts (PDF paper
  hex, real-button sidebar row, delayed spinner).

- **fix(web): the brand accent reads as a colour in settings.** The
  default accent's settings label was "Margin" — a layout word, not a colour;
  it is now "Advance Green", the brand colour name. The stored setting value
  stays `margin` (existing user settings keep working). Verification:
  `pnpm --filter @notees/web test` — 1359/1359.
- **fix(web): the monochrome accent swatch previews ink, and the CSS
  fallback accent is margin.** The settings Accent Color row rendered the
  monochrome preset as a static grey circle (`#404040`); it now carries a
  `--monochrome` modifier class fed by the theme-dependent token
  `--color-accent-swatch-monochrome` (iron ink on paper by day, paper white
  on the night ground by night), so the preview matches the preset it
  selects. The stale `ACCENT_COLOR_OPTIONS` hex follows. The light block's
  pre-attribute fallback accent also moved off the retired monochrome grey
  to the brand margin green. Verification: `pnpm --filter @notees/web test`
  — 1359/1359 incl. the css-token-drift gate (the new token lives in the
  defining file); post-deploy screenshot probe of the swatch row in both
  themes.
- **feat(web): the night is accent-tinted and monochrome is ink.** The dark
  theme no longer rides a fixed warm-brown family: every dark surface, outline
  and muted text is now `color-mix`-derived from the active accent preset at
  3–13% in OKLab over a neutral dark family, so each accent (margin, sage,
  teal, rose, navy, custom) washes the night with its own hue at low chroma —
  and the light ground stays the brand paper regardless of accent. The
  monochrome preset is no longer grey: it is iron ink `#1c1a16` on paper in
  light mode and paper white `#f4f3f1` on the night ground in dark mode (new
  `[data-theme="dark"][data-accent="monochrome"]` override), so a monochrome
  choice lands on effectively untinted graphite dark. The dark-mode accent
  baseline already rode the margin night-green roles. OLED pure-black is
  untouched. Verification: `pnpm --filter @notees/web test` + `build` green;
  four-variant screenshot probe (margin/teal/monochrome dark + monochrome
  light) against the live app confirmed the per-accent tints and the ink
  monochrome.
- **feat(web): the client aligns to the Margin Green brand — fonts, tokens,
  accent default, icons.** The web client now carries the shipped identity
  (brand submodule at `brand/`, v1.0.0): Instrument Sans (variable wght,
  self-hosted woff2 via the @fontsource packages) takes the chrome/base and
  display stacks; Newsreader (opsz + wght) carries the reading surfaces (the
  outliner's block content; the header title row stays chrome); JetBrains
  Mono stays for data. The light ground remaps to the brand's warm paper
  (`#f7f4ec`) with iron-ink neutrals from the brand scale, the dark ground to
  the warm near-black family (`#161412`); semantic, graph, and data-preset
  colors are untouched. Advance Green (`#2e5e46`, night role `#6da789`) ships
  as a new `margin` accent preset and becomes the default (the pre-paint
  bootstrap, the device-settings read, and the settings modal all agree); the
  monochrome preset and every other preset keep working. The app icon and
  favicons are the brand mark (small symbol + 16/32/48 PNGs + the green-tile
  app icon for the About surface), and `index.html` declares the
  light/dark `theme-color`. `docs/usage.md`'s appearance line follows.
  **Verification:** `pnpm -r --workspace-concurrency=1 build`, `pnpm -r
  typecheck`, and `pnpm -r test` green on the shipping tree.
- **fix(web): the empty page's ghost add-block row no longer overlaps the
  next section's separator.** On a page with no child blocks, the lone ghost
  row's bullet/label straddled the border-top of the following node-view
  section (e.g. Class properties). The empty child-blocks surface pulled
  itself up by a full `--spacing-2` (8px) while the ghost row only owns 2px
  of bottom padding, so the next section's border cut 6px into the row. The
  pull now cancels exactly the ghost's bottom padding (`--spacing-micro`):
  the section border sits flush below the ghost's content, matching the
  tight rhythm the rule was written for. **Verification:** a fixture
  replicating the empty-surface DOM against the built app CSS measured
  before/after (border 1px above the bullet bottom before; 5px clear
  after); the full monorepo gate green (132 files / 1359 web tests).
- **chore(env): `.env.example` documents the optional edge envs.** The
  `notees-edge` profile's required `NOTEES_EDGE_NAME` (and the
  `NOTEES_EDGE_HTTP` port remap) were missing from the template — any
  `docker compose` command failed interpolation without the real `.env`
  value, discovered at redeploy time. Generic `<host>.<tailnet>.ts.net`
  placeholder, per the fleet-agnostic rule; the real value lives only in
  `.env`. **Verification:** `docker compose config --quiet` clean;
  dev-only template change.
- **feat(web): the shared hub's header creation button per mode — New page /
  New whiteboard.** The collection hub's header action existed only for
  Classes ("New class"); Pages and Whiteboards had no creation affordance
  from the hub itself. `HubView`'s header action is now per-mode: Pages
  writes one main page (the command palette's New-page write) and opens it;
  Whiteboards reuses the sidebar New flow's write with the whiteboard system
  class picked (the created node lists in the hub's members); Inbox — a
  filtered view of the unclassed — deliberately offers none. New
  `hub-create-buttons` suite pins the three modes (3 tests).
  **Verification:** the hub-create-buttons suite green; the full monorepo
  gate green on the shipping tree (132 files / 1359 web tests) — landed by
  the owner's order from a sibling session's verified in-flight slice.
- **fix(web): the section views' Reset-to-default renders only when custom
  views exist.** The hosted-views chrome rendered the reset button always,
  disabled when there was nothing to reset — a permanently disabled control
  in the factory state. `SectionViewTabs` now renders it only when
  `views.length > 0` (the disabled styles go with it); the section-views
  suite's two reset assertions switch from the disabled property to
  presence/null. **Verification:** the section-views suite green; the full
  monorepo gate green on the shipping tree (132 files / 1359 web tests) —
  landed by the owner's order from a sibling session's verified in-flight
  slice.
- **docs(developers): parallel-session hardening — commit-early, landing
  collisions, dev ports, orphan worktrees, trivial-slice exemption** — five
  refinements to the concurrent-agent rules shipped earlier today, each from
  a gap the first live multi-session collision exposed: (1) uncommitted work
  is one rebase away from gone — snapshot-commit coherent files early,
  per-file, verification in the commit body; (2) the landing flow handles
  contention — main moved or `.git/index.lock` present means another landing
  is in flight: wait, re-fetch, redo the rebase; (3) worktrees don't isolate
  dev servers — concurrent sessions take distinct dev ports; (4) a stale
  `git worktree list` entry from a crashed session gets pruned once
  confirmed dead — never a live, unfamiliar sibling; (5) a solo session or a
  trivial docs-only slice may stay in the main checkout. AGENTS.md, the
  `notees-development` skill, and `development.md` updated in lockstep.
  **Verification:** docs-only guidance change; no code touched.
- **feat(query): the wire node-field predicates get their search-grammar
  spellings — `coverAsset:` / `bannerAsset:` / `aliasedNode:`.** The AST and
  the SQL compiler gained the three node-field conditions with the
  wire-fields slice, but the hand-written DSL parser had no production for
  them — `notees search "coverAsset:"` died as an unknown field (the CLI
  test had to POST the AST programmatically). `dsl.ts` now parses them
  like the other fields: bare `:` is the set/unset probe (no value, also
  before AND/OR/NOT — the `prop:` precedent), `=`/`:=` eq and `!=` neq take
  a node reference — a uuid passes through verbatim, anything else
  resolves by node NAME through the injected resolver (the `linked:`
  precedent); range/contains operators are rejected (uuid references admit
  only eq/neq/exists, and under SQL NULL semantics "is unset" reads
  `NOT coverAsset:`, never `neq`). Docs: `packages/query/README.md`'s
  grammar block. **Verification:** the dsl suite — new cases for the three
  fields (exists/eq/neq, uuid passthrough, name resolution, the boolean-
  keyword boundary, case-insensitive field names, the known-fields error
  list, bad operators) — 40/40; the query package 177/177 with dist
  rebuilt; and the page-banner suite's jsdom `URL.createObjectURL` gap
  closed (the stub the covers suite already carried — the unhandled error
  during the upload-modal test is gone, 9/9).
- **docs(developers): worktree-per-session + landing flow for concurrent
  agents** — with multiple agent sessions expected to work concurrently on
  unrelated tasks, AGENTS.md, the `notees-development` skill, and the
  `development.md` runbook now make a worktree per concurrent session the
  default (own branch off main, own install, own gate, in gitignored
  `.worktrees/<slug>/`), define the landing flow (slices land one at a time
  in the main checkout: rebase onto main, fast-forward merge, push,
  promptly), and require cleanup after landing (`git worktree remove` + safe
  `git branch -d`, so `git worktree list` stays truthful). Shared record
  files (`CHANGELOG.md`, `README.md`, `docs/`, `AGENTS.md`) get their own
  discipline: minimal anchored edits, changelog entries prepend under the
  current date, conflicts resolved by keeping both blocks — never dropping
  another slice's entry. The parallel-session detect-and-coexist rules stay,
  scoped to what worktrees don't isolate (deployed stack, dev ports,
  `config/notees/` data). **Verification:** docs-only guidance change; no
  code touched.
- **fix(web): the cover element rides the `coverAssetId` wire node field —
  the web half of the wire-fields follow-on.** The wire-fields slice made
  `coverAssetId` the authority (object.update field + the migration moved
  every stored value onto it), but the web cover chrome still read/wrote the
  retired image-typed `cover` property: a cover set through the field (the
  CLI, the API, the migration) never showed in the page header, and a
  UI-set cover wrote the dead property. `coverProperty.ts` now mirrors the
  banner exactly: `coverAssetIdOf` reads the node column, `setNodeCover` /
  `clearNodeCover` write `object.update { coverAssetId }` (present-null
  clears) + the asset class, and the retired `ensureCoverProperty` /
  `canHaveCoverOf` self-heal + schema gate are gone — the element renders
  for every document-chrome page, set or empty (the `bannerPossible`
  shape). `PageView` loses the cover self-heal effect; the card-view
  **Cover** badge (`isCoverAsset`) switches from `getLinkedReferences` to a
  new shared read, `getCoverReferences(assetId)` (WorkspaceClient SQL probe,
  the `getAssetInfo` precedent; WorkerClient + the worker dispatch carry it)
  because the wire node fields are not mined into the edge index yet — the
  backlinks roll-up follow-on owns that. The cover still auto-expands the
  card when set. Docs: `ux.md` + `usage.md` (the cover paragraphs now say
  wire node field; the stale `prop:cover:` search example is corrected to
  the `coverAsset` AST predicate). **Verification:** the covers (16) +
  deck-view suites green on the wire field, page-layouts/block-backlinks/
  query-block/verb-create-bind/focus-mode/render-cascade/card-lazy-images/
  view-modes suites green (104 tests); the full monorepo gate green (1359
  web tests across 132 files).
- **refactor(web): the kanban view mode merged into cards.** Kanban was the
  card view with a property-dimension groupBy enabled and between-column
  drag-and-drop — a separate view mode no longer earns its place. `KanbanView`
  is gone; the board now lives in `CardsBoard` (the cards view's grouped
  rendering, dispatched when the container's `groupByProperty` resolves to a
  usable select schema — the prop replaces `kanbanProperty`), the CSS classes
  renamed `kanban-*` → `board-*`, and the Tasks hub / classed-nodes section
  offer the outline/cards/table triad unconditionally (cards IS the board
  where a grouping select exists, the flat grid elsewhere). A persisted
  `viewMode.* = "kanban"` reads back as `"cards"`. Drag drops still write the
  property (`applyCardGroupDrop`, the former `applyKanbanDrop`); columns,
  windowing, covers, and selection export are unchanged. Verified: the web
  typecheck clean and the full `apps/web` suite green (1359 tests) with the
  merge in; the kanban-merge suites (`view-modes`, `windowing`,
  `selection-export`, the `page-layouts` L1 persistence block) green
  standalone.
- **feat(web): palette Properties section + the owner-mandated search order.**
  The command palette's search results now rank **Classes → Properties →
  Pages → Content**, then Date Pages and Commands (the flatten step is a
  stable sort on a mode-dependent group rank, so score order inside a group
  survives; the empty-query home keeps Recent → Random → Commands). The new
  **Properties** section fuzzy-matches the workspace's property schemas
  (`client.listPropertySchemas`, both client kinds carry it) by name, with
  the type name as keyword ("date"/"select"/… find the family) and a
  per-type mdi glyph mirroring the Class View's TYPE_GLYPHS; a pick calls the
  new `onOpenProperty` contribution point, which the App hosts as the
  existing PropertyView modal (metadata, bound classes, value carriers).
  Search-mode only, like Pages/Classes — quiet on the empty query and under
  `is_daily:`. Docs: `usage.md` (the palette paragraph's section list and
  order). **Verification:** the search-palette suite — four new tests
  (section + pick wiring, type-keyword match, the empty-query/`is_daily:`
  quiet rule, the Classes → Properties → Pages → Content rank assertion) —
  green; `apps/web` typecheck clean for the touched files.
- **feat(web): the Assets hub's cards default to cover top.** The assets
  sidebar entry's cards read as an image gallery, so the surface now passes
  a `defaultCoverLayout="cover-top"` fallback (new optional
  `NodeCollectionProps.defaultCoverLayout`, threaded through
  `CollectionHub` and honored by the cards view's
  `useCardLayoutPreference` fallback). The rule shapes ONLY the unset
  fallback: `cards.coverLayout` stays one global device-local preference —
  the moment the user picks a layout anywhere, that choice wins on every
  surface. Every other cards surface keeps the shipped "no-cover"
  default. Docs: `usage.md` (the new "The Assets hub's cover-first cards"
  section beside the Tasks-hub one). **Verification:** `apps/web`
  typecheck clean; the view-modes suite green — the cover test now asserts
  the cover-top default + the no-cover switch, and a guard test pins the
  no-cover fallback for surfaces without the prop.
- **docs(developers): commit-and-push standing rule** — AGENTS.md, the
  `notees-development` skill, and the `development.md` runbook now record
  that a finished slice (gate green, changelog entry in) is committed —
  per-file staging, Conventional Commits — and pushed to the current
  branch before the session ends. Pushing is standing authorization in
  this repo, overriding the `agent-repo-workflow` per-push confirmation;
  if the remote moved, integrate (`git pull --rebase`), never force.
  Verified: docs-only guidance change; no code touched.

## 2026-10-07

- **feat(store,server,web): the parked follow-ons batch — the alias
  resolved-target materialization, the REST wire-field projection, and the
  query-builder-guard coalescing-test stabilization.** Three small slices,
  one verification pass.
  **(1) The alias resolved-target materialization** (the documented later
  optimization, store schema v16 → v17): the derived `edge` index gains
  `resolved_target_id`, the alias-terminal of each edge's target,
  materialized BY THE APPLIER — `resolveEdgeTarget` walks `aliased_node_id`
  chains with the `resolveAlias` cycle rule (a revisit yields the starting
  id unchanged) and a deliberate liveness gate (trashed/deleted rows never
  resolve through; a missing/inactive row is its own terminal — so a
  trashed alias's edges stay inert on the alias, exactly the live-only
  semantics the recursive read gave the roll-up). Written at edge-derivation
  time (`rebuildEdges`) and re-resolved by `reresolveEdgeTargets` wherever
  chains can shift: `object.update {aliasedNodeId}` (the reverse closure —
  pointer-based, invariant under the seed's own write), `object.delete`
  (soft + permanent), `object.restore`, `class.delete`, the PB2
  orphan-carrier trash, and the family-archival feature toggles. The
  guarded migration (`PRAGMA table_info` column check + the
  ladder-gated `idx_edge_resolved_target` index, the LIST_READS_INDEX_DDL
  precedent, re-asserted on the snapshot-repair path) backfills pre-v17
  databases through the SAME walk, so a migrated database is byte-identical
  to a wipe → replay at v17. **The read switch:** `backlinksWithRollup`
  answers the alias family from the column (one indexed probe replacing the
  recursive alias-set walk + per-alias client union; `kind: "alias"` rows
  carry the raw target; the carrier filter mirrors the SCHEMA.md page
  restriction so non-page carriers still don't act as aliases; containment
  tests the resolved target — an intra-subtree link via an alias is
  content, not an outward link); `graphTopology`'s structural families read
  it too; `backlinks()` and the `node_stats` badge stay raw-direct (the
  alias page's own view + the badge contract, SCHEMA.md). No wire change
  (derived-only) — the GTK/Flutter stores carry their own derived schemas;
  their v17 follow-on (same column, same write-time semantics) is recorded
  in SCHEMA.md "Node aliases" and does not gate this slice.
  **(2) The REST `ApiObject` exposes the three wire node fields:**
  `coverAssetId` / `bannerAssetId` / `aliasedNodeId` ride `nodeToApi` on
  every object projection (get/list/children/PATCH response; null = unset,
  present-null clears exactly like `color`); the OpenAPI object reads
  document them (the PATCH body schema already carried them). The web
  client's `getLinkedReferences` consumes the store's three-family read in
  one pass — the client-side alias union dissolves into the store's `kind`
  label plus the same both-ends own-subtree exclusion.
  **(3) The query-builder-guard coalescing test is deterministic:** the
  "a synchronous notification burst costs exactly one re-run" assertion
  raced the seeding writes' floating push-ack notifications under
  parallel-suite load (a settle-phase notification landing after the
  baseline capture merged with or added to the burst's trailing run); the
  baseline is now captured after the repo-standard six-tick `flushSync`
  drain, so no notification or re-run is in flight when the burst fires.
  **Verification:** the store suites pin the materialization on BOTH
  adapters (write-time resolution, re-point/clear re-resolution, stale-LWW
  no-op, trash/restore/permanent-delete, the v16 → v17 backfill against a
  fresh v17 replay, wipe → replay byte-identity, the roll-up's
  direct/alias/containment kinds, the page-carrier restriction) — store
  457 (was 437); the server suite pins the wire-field projection (218,
  +1 for the new test); the web alias suites re-green unchanged (the
  roll-up semantics hold through the store read); the guard suite ran 3×
  green, 3× more concurrently with the full gate (the load condition that
  used to flake it). `pnpm -r build`, `pnpm typecheck`, and the full
  `pnpm test` gate green — 2,818 tests across 184 files (protocol 301,
  domain 72, export 219, store 457, sync 25, query 175, server 218,
  web 1,351).

- **feat(web): the transient filter layer — `filterable` sections filter
  their rows post-resolution/pre-windowing.** The section data contract
  (components/useSectionData.ts) gains the filter step: a `FilterSpec`
  applies to a section's resolved rows AFTER the lazy resolution, BEFORE
  the collection's windowing — windowing sees the filtered set (a windowed
  table renders the filtered window, never the first-N-then-filtered), the
  resolution cache is untouched (a spec change re-derives from the cached
  rows and re-runs no query — pinned by a spy assertion), and the eager
  count stays UNFILTERED: an active filter reads "0 of N" in the bar and
  the section never vanishes. **The FilterSpec is one grammar with the
  stored custom views** (components/filterSpec.ts): the documented flat-AND
  subset of the query AST as plain serializable data —
  `{ text?, classId?, propertyPredicates[], dateRange? }` — writing forward
  through `filterSpecToQueryAst` and reading back through
  `queryAstToFilterSpec` (an AST outside the subset reads back null, never
  a lossy default); a strict `parseFilterSpec` fails loud on unknown keys
  and bad shapes. The row predicate mirrors the compiler's scalar
  semantics over the effective-values read model: title substring,
  hierarchy-aware class membership (the class or anything extending it),
  property ops (numeric-when-numeric, the ISO-date arms matching node-typed
  values by their deterministic date id), the inclusive created window with
  `{today}`-style placeholders resolving on the run clock. **The bar
  chrome** (components/FilterBar.tsx + .css) rides each section's body top
  (the section header is a single button — no nested controls; the skin's
  CollectionSection gains the `filterable` prop + slot the same way) and
  composes kit primitives only: SearchField for text, the structured panel
  (class picker, property predicate rows, the created window with the
  placeholder datalist — the query-builder precedent) behind a toggle, the
  honest "N of M" count and a clear. **State is component state — one
  FilterSpec instance per section view/tab, lost on reload, nothing
  persisted.** Enabled on the three filterable sections: the linked-
  references (Backlinks) and unlinked-mentions tabs (per-tab instances — a
  switch never leaks a filter across) and the classed-nodes table (the
  section now resolves through the hook directly — the Section wrapper's
  load path cannot host a post-resolution step; chrome and contracts
  unchanged); every other section renders no bar. `SectionSpec.filterable?:
  boolean | FilterBarConfig` records the contract for the future stacks.
  **Verification:** `npx tsc --noEmit` clean; new suites
  `test/filter-spec.test.ts` (12) and `test/filter-layer.test.tsx` (7)
  green; the sections/windowing/class-view/view-modes/css-drift suites pass;
  the full web suite runs 1350 passed / 1 failed — the one failure is a
  shared exact tab-list assertion in `test/system-sections.test.tsx` that the
  concurrent stored-views slice's added Default tab breaks (not this slice),
  and the known query-builder-guard load flake passed both in the full run
  and isolated.
- **feat(web,server): custom views as stored tabs — every collection-backed
  section hosts custom views.** A page's backlinks, its unlinked mentions,
  and a class's classed nodes each gain a tab bar — **Default** first
  (permanent, never closable, never replaced — it renders exactly the
  factory behavior) plus custom tabs in sequence order, with a **+** that
  opens the FilterBuilderModal and persists the composed filter **verbatim**
  as the view's stored query. **Storage (the prefs channel, the
  favorites/recents ruling):** a new `section_view` table in `relay.db` —
  id, user_id, node_id, section_key (`linked-references` |
  `unlinked-mentions` | `classed-nodes`), name, sequence (dense tab order),
  query_ast (JSON, validated against the QueryAST v1 zod schema at the
  route), view_mode (nullable display pin), timestamps; `UNIQUE (user_id,
  node_id, section_key, name)`; **no `is_default`, no default rows** — the
  default view is derived-not-stored, so emptying the table restores
  factory behavior and "Reset to default" is just "delete every row of the
  section". Five REST endpoints under
  `/api/me/nodes/:nodeId/sections/:sectionKey/views` (list/create/rename/
  reorder/delete), `requireUser` auth like `/api/me/prefs` (per-user API
  keys ride as their owner; the operator key is not a user → 401), unique
  violations → 409, foreign rows → 404 (per-user scoping never leaks),
  OpenAPI-documented (the coverage gate). **Web:** the `useSectionViews`
  hook + module store (the nodePrefs precedent — one shared copy per
  section, device-local cache for offline reads; writes are optimistic with
  revert-on-failure, so offline the tabs are read-only — per-row writes
  cannot replay honestly the way full-list prefs can); `NodeCollection`
  gains the hosted-views chrome via an opt-in `hostedViews` prop
  (`SectionViewTabs`: the kit Tabs bar, the active custom tab's
  rename/reorder/delete manage row, the always-available Reset to default,
  the FilterBuilderModal "+" flow — in this host the modal's Run also
  persists, with an auto label); client plumbing on both `WorkspaceClient`
  and the `WorkerClient` RPC. **Resolution (the composition rule):** the
  section's base query produces the row set, then the stored AST refines it
  — base-column predicates (`class` hierarchy-aware, `isClass`,
  `presentAsMain`, the created window with `{today}` resolution, `content`
  contains over the flattened title text, the cover/banner/aliasedNode
  wire-field predicates) evaluate directly on the materialized rows; joined
  metadata (`property`, `content` fts, `linkedTo`) falls back to one
  `runQueryAst` membership probe per leaf intersected with the base set (the
  FilterBuilderModal's representable subset never produces these — the
  common tab evaluates wholly on the rows); the stored scope and aggregation
  are ignored (the base set IS the scope; a tab refines rows and the AST
  round-trips verbatim); sort applies with the compiler's semantics (name
  NULLs-last, id tiebreak); groups refine alongside items so grouped
  backlinks stay consistent. A custom tab's `view_mode`, when set and
  registered, overrides the container's mode. The three sections wire the
  prop: `SystemSections` (both reference tabs) and `ClassedNodesSection`.
  **Verification:** the full root gate green — server 218/218 (the new
  section-views suite pins the table, the five endpoints, the unique key,
  per-user scoping, the validation taxonomy), web 1351/1351 including the 25
  new section-views tests (resolution both paths, the store, the chrome:
  default permanent + custom additive + reset, the "+" flow persisting the
  AST verbatim, refinement on top of the base set, empty-table = factory
  behavior); `pnpm -r build` + `pnpm typecheck` clean.

- **feat(web): the rail's cards reorder by grip drag, and the hover preview
  renders the shared NodeView in preview mode.** Two registered follow-ups
  land together. **Rail card reorder:** the cards-only right rail's stack
  order becomes user-authored — each card frame's header carries a drag
  GRIP (the block-row grip precedent: a small distinct handle, so the
  reorder gesture never conflicts with the header's block-drop gesture or
  the breadcrumb clicks). The grip registers the card with the ONE
  workspace drag session as a reorder source; a card drag runs its own
  session kind — no zone measuring, no drop line, no transient expands —
  with the overlay name chip + the target header's reorder edge (a line
  above/below, the pointer's half of the header) as the feedback. At drop
  the host reports { activeCard, targetCard, edge } to the App's
  `onRailCardReorder`; the App owns the stack and its device-local
  persistence — the recents-order precedent (`notees.sidebarCards`, the
  `recordRecent` shape: a validated localStorage list, no server
  counterpart, never an op), written by one effect on every open/close/
  reorder, with ids the current workspace doesn't know filtered on
  connect. The header drop stays exactly the append-as-last-child code
  path — a block dragged onto a grip-bearing header still lands as the
  card node's last child (one new suite pins both gestures side by side).
  **The hover preview → NodeView swap:** `NodeHoverPreview`'s bespoke
  card (icon/title/excerpt/backlink-count) is deleted; the card now
  renders the shared `NodeView` in its `preview` mode — the real chrome
  and the real read-only rendering (the title row, the body capped at the
  first level), with the write machinery stepped aside on the preview
  surface: no corner menu (already), and now no banner/cover affordances,
  no properties list, no aliases/tags editors, no icon picker, no header
  context menu, no whiteboard lazy-authoring, no block multi-selection —
  plus two seam completions the swap surfaced: the page header's title row
  and block targets' `ReferenceSubtree` accept read-only (a click
  navigates, never edits — the trampoline contract), threaded from
  NodeView's `preview` prop. The behavior contract is unchanged: the same
  dwell/grace state machine, the same dismissal layer, the same
  pin-to-floating-editor promotion, the broken-mention fallback, the
  backlink count + Pin footer (now under the real view). Docs: `usage.md`
  (the preview card + the rail paragraphs) and `ux.md` (the right-rail
  paragraph, stale since the cards-only restructure) re-homed.
  **Verification:** `npx tsc --noEmit` clean for the touched surface; the
  three suites green — workspace-dnd 12 (the rail reorder suite: before/
  after reports, the reorder-edge indicator, the self-drop no-op, the
  append drop intact), rail-card-order 9 (the pure move + the
  device-local persistence round-trip), node-hover-preview 19 (the real
  chrome, the read-only title/body navigation, the block target's
  read-only focused-block chrome, pin → floating editor). The full-suite
  run at this commit also shows the in-flight hosted-views/filter work
  area red (section-views, filter-layer, system-sections, node-aliases —
  that slice is mid-implementation; this change touches none of it).

- **feat(web,server,store): the alias read-path repointing — the final
  alias-program slice.** Every node-alias read now rides the
  `aliasedNodeId` wire field (`node.aliased_node_id`), retiring the
  property-based carrier (`aliasOf` self-heal, the `aliasOfTarget` edge
  read, the properties-panel special cases) entirely.
  **The universal redirect:** `resolveAliasOpen` repoints onto
  `client.resolveAlias` (the store's cycle-safe chain walker, exposed on
  both clients — WorkspaceClient + the WorkerClient read cache with the
  conservative content-global invalidation, alias chains are not ancestor
  relations) and moves INTO the App open funnels — `openPage` and
  `openInSidebar` resolve, so every navigation surface (breadcrumbs, the
  command palette, backlink/query result rows, graph clicks, mention
  clicks, hover previews, floating editors, sidebar rows) lands on the
  terminal through the single seam; browser deep links and back/forward
  stay raw (identity-level), and the component-level wrappers dissolve
  into plain funnel calls. **Backlinks roll-up:** a new recursive store
  read `Store.aliasNodesOf` (reverse-walk over the column — every live
  node whose alias-terminal is M, chains included; the materialized
  resolved-target column stays the recorded later optimization) drives
  the linked-references `kind: "alias"` union AND the unlinked-references
  exclusion (a source linking an alias is already linked by alias).
  **Graph exclusion:** alias nodes are not vertices; edges incident to an
  alias render incident to the terminal and repointed parallels merge
  into one weighted edge; the local-scope anchor steps through to the
  terminal's neighborhood. **Server `/resolve`** folds node aliases to
  the terminal via the same walker (the `aliasOfTarget` loop retires); the
  REST `PATCH /objects/:id` body schema gains the three wire node fields
  too — it predated them (the web writes via the op log, so the gap only
  surfaced when the `/resolve` test drove the field over HTTP; the OpenAPI
  body schema follows).
  **Links keep the alias uuid** — authoring never rewrites; resolution
  happens at navigation (pinned by a test). **The aliases UI:** the main
  page's title row gains an **Aliases · N** button — the list popover
  names every alias with a NAVIGATE button that opens the alias's OWN
  view (the one deliberate bypass, via the new raw `openPageAt` funnel),
  and ADD writes THE SELECTED node's `aliasedNodeId` (the backward write
  — the picker filters already-aliased nodes and the main itself, the
  page guard validates the pick); the alias's own view carries ONE
  pseudo-property row — a node-typed **Aliased node** entry over the
  field itself, re-pointable and clearable from the alias side, rendered
  by the properties table and the properties sidebar alike.
  **Verification:** the store suites pin `aliasNodesOf` (direct + chain,
  live-only, self-excluded) and the graph exclusion (repointing, merged
  parallels, chain collapse, the local anchor); the web suite re-seeds
  the alias world onto the wire field — the roll-up (alias + chain +
  additive own-view), the redirect seam, links-keeping-the-alias-uuid,
  the unlinked exclusion, the banner, the guard, and the new UI end to
  end (list, NAVIGATE bypass, the backward ADD write with the filter, the
  pseudo-row's re-point + clear + the page gate); the server suite pins
  the `/resolve` fold over the field; the full gate green — **2,678 tests
  across 175 files** (protocol 301, domain 72, export 219, store 437,
  sync 25, query 175, server 204, web 1,245).

- **feat(web): the page banner — the `bannerAssetId` wire field's UI
  half.** A full-width collapsible banner ABOVE the header, inside the
  page card and spanning the content width; the cover card stays in the
  header row — banner and cover coexist. The banner reads the
  `bannerAssetId` node field straight off the ClientNode (the store's
  `banner_asset_id` column, the wire-fields slice's read projection) and
  writes through `object.update` — the client surface gains all three wire
  fields (`coverAssetId` / `bannerAssetId` / `aliasedNodeId`) on
  `UpdateObjectInput`, payload-mapped alongside icon/color (the worker RPC
  rides the same input through, no handler change). Collapsed to a slim
  full-width strip by default under the per-page device-local pref (the
  cover-collapse precedent: `pageBannerCollapsed.<pageId>`); expanding
  shows the fixed-height cover-fit image (the existing banner sizing
  token) or the dashed Add affordance — the AssetUploadModal with an
  image-only accept list, the landed asset node's id written to the field
  plus its asset class (explicit ops, every client converges). A banner
  landing while the strip is collapsed expands it (the cover precedent —
  the new image is the feedback); the mount is excluded, so the pref
  governs the first view. Hover reveals Collapse / Change / Remove (Remove
  clears the field present-null; the asset stays). The page context menu
  gains **Add banner** / **Change banner** — labeled by the current field
  value — riding the same host-owned modal as the empty affordance, so
  both entry points are one flow. Whiteboard pages and embedded renders
  host no banner (the cover gating precedent). **Verification:** a new
  page-banner suite pins the field round-trip (set/clear + the asset
  class), collapsed-by-default, expand → image, the per-page pref
  surviving a remount (a second page stays collapsed), the empty → upload
  → field flow with the image-only accept asserted on the file input, the
  context-menu entry and its Change label once set, and the
  whiteboard/embedded gating; the full gate green — **2,668 tests across
  175 files** (protocol 301, domain 72, export 219, store 433, sync 25,
  query 175, server 204, web 1,239).

- **feat(web): the `asset` property type's dedicated row chrome.** The
  type (the attachments schema leads it) leaves the generic object row
  behind: the row renders the linked assets as a LIST — the thumbnail
  (image bytes through the session cache; a kind icon otherwise), the
  `node_asset` original name (click downloads), and a per-item remove —
  with TWO authoring buttons: **Upload** opens the AssetUploadModal
  directly (its CAS flow creates the asset node; the property value links
  it at the next free slot) and **Link** opens the node picker scoped to
  asset-classed nodes with create disabled (the type IS the filter — a
  picker-level create could mint a non-asset, so the row offers none).
  Multi rows keep both buttons at the list's bottom; a single-value row
  renders them only while empty — replacement goes through clearing
  first. Broken targets render the dashed raw-id row (the broken-mention
  policy), never a silent void. The row renders everywhere property rows
  render (the properties table and the compact/sidebar surfaces share the
  grouped-row switch). **The upload modal grows three capabilities the
  chrome leans on:** an `accept` prop narrowing the selectable set (the
  MIME / `type/*` / `.ext` grammar), clipboard-paste capture while open
  (pick, drop, or paste ride one selection path), and client-side gates
  mirroring the server — the accept list and the media (50MB) / document
  (100MB) size caps — rejecting with a named error before anything leaves
  the machine. **Verification:** the asset-attachments suite re-seeds the
  attachments schema at its current wire shape (type `asset`, the filter
  implicit in the type) and pins the new chrome end to end — the empty
  Upload/Link buttons (no generic Add pill), the asset-scoped no-create
  picker (filtering + search + the pick writing the value), the upload
  setting the value to the fresh asset node (multipart POST + API key
  headers intact), paste filling the modal, the accept gate rejecting
  before any upload, the failed-upload error path, the multi list with the
  buttons at the bottom + thumbnail rendering, the single clear-first
  flow, item removal rewriting the list; the full gate green (2,668 tests
  across 175 files — totals above).

- **feat(protocol,store,domain): the `asset` property type — attachments
  leads the type out of `object`.** Owner ruling (M38): an asset-typed value
  is a node reference whose target must carry the ASSET class — the type IS
  the filter. **Protocol:** `propertySchema.create`'s strict type enum gains
  `"asset"`; the domain `SystemPropertySpec` union keeps pace and the seeded
  `attachments` spec (…0011) drops its now-redundant explicit
  targetClassFilter. **Fixture gate 23→24:** `property-asset-type.json`
  exercises the type through create plus a coexisting update (type rides
  create only — `propertySchema.update` deliberately carries none), with a
  strict-schema pin rejecting a bogus type. **Store:** the validation
  machinery treats `asset` as the node-ref family — `{nodeId}` shape with
  legacy bare-uuid normalization, target existence, and the IMPLICIT
  asset-class filter (explicit filters on asset schemas are ignored);
  node-typed defaults stay unsupported. **Migration:**
  `scripts/migrate-attachments-asset-type.mts` (the sibling-script
  conventions: scratch-store plan, protocol-validated envelopes, dry-run
  default) retypes live attachments rows through the `propertySchema.create`
  UPSERT — the only wire path that can change a type — carrying the stored
  row's name/scope/multi/flags verbatim (rename-safe, display/readonly/
  hideWhenEmpty preserved) while the explicit filter column retires; values
  are shape-compatible and ride untouched. Idempotent: a second run plans
  nothing. `SCHEMA.md` ("Sources as containers", PB2/PG6/PC2) updated; the
  UI half (Upload/Link buttons, the multi list) is a separate later task;
  **the GTK/Flutter ports are a separate follow-up in the clients repo** (a
  strict-enum additive — pre-batch clients reject the retype envelope, so
  the live migration run gates on them). **Verification:** the store suite
  gains an M38 block (fixture replay, implicit-filter accept/reject, the
  no-defaults rule, the upsert retype preserving values + flags) and a new
  web suite drives the migration core over the sql.js adapter; the full
  gate green — `pnpm -r --workspace-concurrency=1 build`, `pnpm typecheck`,
  `pnpm test`: **2,654 tests across 175 files** (protocol 301, domain 72,
  export 219, store 433, sync 25, query 175, server 204, web 1,225).

- **feat(protocol,store,web,domain): the seeded `class` meta class is
  retired — its members become real classes.** Owner ruling: `class` (…0001)
  withdraws from the seed manifest (the UUID never reuses, the cover-class
  comment precedent), and nodes bound to it BECOME classes. **The conversion
  capability (the (a) investigation: no wire path existed — `class.create`
  upserted the registry row but `INSERT OR IGNORE` never flipped `is_class`,
  leaving an inconsistent half-state; `object.update` has no `isClass`
  key):** `class.create` on an EXISTING node now declares it a class — the
  applier flips `is_class`, cuts a parented node to a root (parent edge +
  child-order row drop), clears the render bit, and the registry adopts the
  node's title; a payload `contentAst` still wins LWW, and absent fields
  PRESERVE on re-declaration (the upsert used to wipe icon/color with null —
  fixed, pinned). **No payload keys changed** — the schema always accepted
  the id, so this is applier semantics, documented as the deviation from
  "additive payload change"; the fixture gate applies anyway:
  **gate 22→23** with `class-convert.json` (parentless + parented
  conversions, re-declaration no-op, fresh declaration) and a store block
  asserting the derived state. **Seeds:** `SYSTEM_CLASS_UUIDS` / icons /
  display names / `SEEDED_SYSTEM_CLASSES` / the F1 always-on list lose the
  `class` entry; the `has-template` spec loses its `bindTo` (the server seed
  now emits it at global scope automatically). **The has-template
  relocation:** the family hosts on NO class — `templateFamily.ts` authors
  the schema at global scope with no binding and no class-class self-heal;
  the TemplatesSection/listClassTemplateBindings read path is unchanged
  (authored values surface through the effective-properties read with or
  without a binding — the new location IS the honest location). The other
  class-class consumers follow: `classRemoval` (journal-chain only),
  `dateChipCandidates` (date-chain exclusions only). **Migration:**
  `scripts/migrate-retire-class-class.mts` converts every bound node
  (bare-id `class.create` + `class.unassign`), retires the (class-class,
  has-template) binding row, re-scopes the schema to global through the
  create-upsert (carrying the stored row verbatim), and trashes the emptied
  class-class node (recoverable — the migrate-cover-to-asset precedent);
  idempotent, dangling memberships skipped, verified by a fresh-scratch
  replay. **The GTK/Flutter alignment is a separate follow-up in the clients
  repo** — class identity is the lockstep gate, stated in the script
  docstring, `WIRE.md`, `migrations.md`, and `releases.md`. Same-pass
  `SCHEMA.md` (the seed manifest, "Node structure", Templates). **Verification:**
  the store conversion block (both adapters), the updated template-family /
  calendar suites, the new migration web suite (4 tests), and the domain
  pins (spec shape, withdrawn …0001) all green; the full gate green
  (2,654 tests across 175 files — totals in the newest entry).

- **feat(store): write-time alias-cycle validation + the `resolveAlias`
  chain walker (M12).** The follow-on scoped in with the wire fields: an
  `object.update {aliasedNodeId}` that would close an alias cycle now fails
  loud AT THE APPLIER and is never applied — the extends-DAG precedent for
  structural invariants. The would-be chain N → T → T's target → … is walked
  before the write; a revisit of any visited node fails (`CycleError`) — the
  1-edge self-alias included — while clearing (null) skips the check and a
  stale-HLC write is dropped by the row LWW before any check. The read
  helper `Store.resolveAlias(nodeId)` walks a chain to its terminal,
  cycle-safe by construction (a revisit yields the starting id unchanged — a
  cyclic alias is no alias, the SCHEMA.md navigation ruling) with a 32-link
  depth cap. **The alias read-path repointing (`aliasOfTarget` usages, the
  universal redirect, backlinks roll-up, graph exclusion) is deliberately
  NOT this task — recorded as the next follow-on** in `SCHEMA.md` "Node
  aliases". **Verification:** a new store block on both adapters (chain set/
  resolve, self + indirect + 2-cycle rejections with nothing applied, clear
  re-opens the chain, stale-write drop, the direct-row cycle walk, the depth
  cap); the full gate green (2,654 tests across 175 files — totals in the
  newest entry).

- **feat(protocol,store,query,export): the wire node fields —
  `coverAssetId` / `bannerAssetId` / `aliasedNodeId` on `object.update`,
  superseding the retired cover/banner/aliasOf property
  assertions.** Owner ruling (the
  node-fields boundary, the icon/color precedent): platform-fixed node
  fundamentals are wire node fields, never class-bound properties.
  **Protocol:** `object.update` gains the three optional nullable fields
  (presence writes, present-null clears); `object.create` carries none.
  **Fixture gate 21→22:** `object-wire-fields.json` exercises set + clear of
  all three through `object.update`; the exact-list assertion and a semantic
  pin (non-uuid rejected; the fields rejected on `object.create`) join the
  protocol suite. **Store:** `SCHEMA_VERSION` 15→v16 — the node table gains
  `cover_asset_id` / `banner_asset_id` / `aliased_node_id` (guarded
  idempotent ALTER for existing databases); the `object.update` applier maps
  the fields (absence preserves, null clears, row LWW like icon/color) with
  no referential validation — alias-chain acyclicity and asset existence are
  read/client-layer concerns. **Query:** the AST/compiler gain the
  `coverAsset` / `bannerAsset` / `aliasedNode` predicates (eq/neq/exists
  compiling into the node-table columns; "unset" reads `not exists` under
  SQL NULL semantics). **Export:** the JSON archive node record carries the
  three fields, always present, null when unset (envelope version stays 1 —
  additive; format comment records the note). **Migration:**
  `scripts/migrate-cover-banner-alias.mts` (the `migrate-system-names`
  precedent: scratch-store plan, protocol-validated envelopes,
  `RelayStorage.ingest`, dry-run default) appends per carrier node one
  `object.update` (the latest visible assertion's target — `{nodeId}`
  canonical, bare uuid defensive, v1 `{hash}` cover data resolved through
  the CAS `node_asset` table) plus a `property.unset` per visible row
  (element remove for element-authored rows, slot unset for the legacy
  positional rows whose deterministic id is not a uuid); unresolvable values
  are skipped untouched for a fixed re-run. **Alias semantics (resolveAlias
  chains, write-time cycle validation, the universal redirect, backlinks
  roll-up, graph exclusion) are follow-on slices — this ships fields +
  appliers + fixtures + migration only;** `SCHEMA.md` ("Node structure",
  "Node aliases"), `WIRE.md`, `migrations.md`, `releases.md` (the current-wire
  line + batch table), `architecture.md` (the schema-version lines and the
  boundary rule's honest carve-out), and `development.md` (the fixture table)
  updated in the same pass. **The GTK/Flutter alignment is a separate
  follow-up in the clients repo** — the new keys are additive on a strict
  payload, so a pre-batch client rejects them and the live migration run
  gates on the ports (the lockstep law; the script's docstring states it).
  **Verification:** the full gate green — `pnpm -r
  --workspace-concurrency=1 build`, `pnpm typecheck`, `pnpm test`: 2,598
  tests across 174 files (protocol 279, domain 72, export 219, store 407,
  sync 25, query 175, server 204, web 1,217); the migration core is pinned by
  a new web suite (plan shapes, v1-hash resolution, element vs slot unsets,
  idempotence, the validate-before-insert gate) run over the sql.js adapter.

- **fix(web): system-class deployment self-heals binding rows past the
  seed-spec fallback.** The pre-existing defeat: `deploySystemClass`'s
  "already bound?" check read `getClassBindings`, which read-synthesizes the
  designed system seeds for system classes — so a workspace that had a system
  class node but no `class_property` registry rows (offline-first devices,
  pre-seed workspaces) looked fully configured through the ClassView while
  the registry-only effective-properties read (store `effective.ts`) saw
  nothing, and the deploy authored no rows at all. The binding steps
  (the spec family and the `SYSTEM_EXTRA_CLASS_BINDINGS` rows) now check the
  registry only via a new honest read, `getRegistryBindings` (own
  `class_property` rows, no extends inheritance, no fallback synthesis —
  exposed on `WorkspaceClient`, `WorkerClient`, and the worker RPC), and
  sequences continue after the own rows exactly like the server seed's
  per-class counter; the birthday class-local `eventDate` row is no longer
  masked by the inheritance visible once the event parent is deployed. The
  fallback read itself is untouched — the meetingFamily/birthday present
  gates and the calendar chip eligibility walk deliberately rely on it and
  keep working. The shared binding-row mapping is factored into
  `mapClassBindingRow` (no behavior change for `getClassBindings`).
  **Verification:** new web suite `system-class-deploy-bindings.test.ts`
  (4 tests: the pre-ruling workspace self-heals to registry rows with the
  authored values becoming bound, re-deploy is a no-op; the birthday
  class-local row materializes past inheritance; the event-root fallback
  reliance stays fallback-only after the ensure; deploy composes with the
  birthday ensure); the existing meeting/task/template-family and
  class-create-modal suites unchanged and green; the full gate green
  (2,598 tests, totals above).

- **feat(web): one workspace drag session — the host hoists every surface's
  drag, and the rail cards' headers become append-drop targets.** The
  per-surface drag context is gone: a single workspace host
  (`useWorkspaceDnd.tsx` — the `WorkspaceDndHost` provider + the
  `useWorkspaceDnd` session hook) owns the dnd-kit context, the sensors, the
  drop indicator context, the overlay name chip, and the transient
  move-error banner. In App it wraps the floating-editor host (which wraps
  the regions), so the main content card, the right rail's workspace cards,
  and the floating editor windows — they portal, but stay inside the host's
  React subtree — all join the SAME drag session. Every mounted editing
  surface registers its drag facts with the host as a zone (the measured
  root, the live positions getter, the client — `PageView` registers;
  embedded renders, rail cards, and floating windows render PageView, so
  they join automatically): at drag start the host measures every zone once
  and merges the per-zone valid-location sets (`mergeZoneCandidates` — each
  candidate tagged with its zone), pointer moves project onto the merged set
  (the proximity snap model, the muted source row, and the hierarchy-end
  disambiguation unchanged), and drops resolve against the zone under the
  pointer. Cross-zone drops are always MOVE (re-parent) — never copy/link.
  The machinery loses the DnD half (no sensors/handlers/drop state — it
  keeps the outliner, selection, find/replace, and fold chords); block rows
  are draggable only inside a workspace editing surface (the drag scope
  PageView provides — the context-presence law, now explicit). Card frames
  register their header as a droppable: dropping on a rail card's header
  moves the block as the LAST CHILD of the card's node — one code path with
  a child drop on that node — and the header renders its distinct
  active-drop state while it is the target. A collapsed card under
  drag-hover transiently expands to reveal the drop position and
  re-collapses at drag end (drag-scoped — the session holds the temporary
  set; the card's own collapse state never mutates). The cards also pass
  `globalShortcuts: false` down — the find/replace and fold chords are
  main-surface-only (they were leaking one document listener per card).
  `npx tsc --noEmit` in apps/web clean; full web suite green (the block-dnd
  suite renders inside the host now; the new workspace-dnd suite covers the
  merge helper, the header append, the transient expand, the cross-zone
  move, and the chords gate — its afterEach settles past dnd-kit's 50ms
  post-drop click suppression).

- **fix(web): the LinkEditModal is node-only — URL mode removed; external
  links navigate and are authored directly.** Owner ruling: the modal edits
  NODE links (and typed-link verbs) only. The mode toggle is Page/Block
  (verb still arrives from the typed-link flow, no toggle); the URL field,
  its state, the `external` target kind, and `writeExternalLink` are
  deleted. External links now behave like the plain hyperlinks they render
  as: a read-mode click navigates (PageView's delegated click handler and
  its `linkOpenerRef` are gone — no path opens the link editor for an
  `external_link` token), and the editor's slash "Add URL" command composes
  the `external_link` token directly at the caret through the edit-apply
  splice (a URL-looking query becomes the token; anything else falls back
  to plain prose — markdown `[label](url)` / raw-URL pasting remain the
  label-carrying paths). The node-link context menu's "Edit link…" is now
  structurally node-only too: it renders only when the target token is a
  mention (an external token never offers Edit; Remove/Delete stay). Tests:
  the modal suites open through a mention's Edit link… (the honest seam) and
  assert the Page/Block mode set; a read-mode external-link click asserts
  no modal opens; the slash flow asserts direct token authoring (plus the
  non-URL fallback); the context-menu suite gains the no-Edit-on-external
  case. Verified: `npx tsc --noEmit` in apps/web clean; the full web suite
  green.

- **fix(web): four editor-chrome corrections — external links are plain
  hyperlinks, the remaining mention renderers wire the full title, the
  link-edit modal consolidates to one anchored node picker, and sidebar rows
  track renames live.** Owner ruling: an external link reads as a hyperlink,
  never a pill — the read-mode `external_link` render swaps the
  `nt-external-link` chip class for `nt-hyperlink` (underline + link color
  only; no background/border/radius), and PageView's delegated read-mode
  click handling follows the new class (the link-edit/remove flows are
  unchanged; edit mode still shows the raw markdown). The full-title ruling's
  remaining call sites are wired: `BlockRow` (body rows and the page-title
  projection) and the sidebar favorites/recents row labels now pass
  `resolveFullTitle` next to `resolveName`, so mentions render the complete
  title there too (dense chrome — breadcrumbs — stays capped). The
  LinkEditModal's target section is ONE control now: a kit SelectTrigger
  showing the current selection whose click anchors the NodeSelector
  dropdown (portaled), a pick replacing the selection in place — the old
  pair (a display row plus an always-expanded embedded search) is gone; the
  verb mode's schema picker, the broken-link heal row, and the Esc/backdrop
  dismissal (kit Modal overlay stack + the shared popup-dismissal layer) are
  untouched. The sidebar subscribes to client notifications so a rename
  re-renders favorites/recents rows with the new name (regression test:
  rename a recents node, the row label updates). Verified: `npx tsc
  --noEmit` in apps/web clean; the web suites green (external-link class
  assertions, the modal's one-control picker flow, the live-name
  regression, and the retarget/label/broken-link flows).

- **fix(web): creating a node from the editor's @ picker always lands the
  mention — the create completion splices from a capture snapshot.** The
  picker's create row starts an ASYNC create (the promise-based default
  create, or the class-aware QuickCreateModal), and the created node can
  arrive after the popup already closed (Escape / outside press / blur while
  the create is in flight). `commitNodePick` read the live capture state and
  no-op'd, leaving the bare "@query" text in the block. The editor now keeps
  the last-open capture in a ref (the `/template` flow's `templateStageRef`
  idiom — only non-null captures refresh it, so the snapshot survives the
  close re-render) and completes the mention from the snapshot when the
  capture is gone. Cancellation/abandon is unchanged: the modal's Cancel
  authors nothing and the trigger char stays plain text with focus back on
  the block (the `closeNodePicker` contract); multi-select paths and plain
  picks are untouched. `packages/protocol/SCHEMA.md` and the
  `BlockTextEditor` header doc carry the description. Verified: `npx tsc
  --noEmit` in apps/web clean; the capture suite (18 tests, incl. a gated
  completion-after-dismissal case and the modal cancel case) plus the full
  web suite green.

- **feat(web,server): the web link extends the source class.** Owner ruling:
  a bookmarked page is a cited web source. `SYSTEM_CLASS_EXTENDS` gains
  `weblink: ["source"]` — weblink inherits the source bibliographic bindings
  (unset fields stay hidden; effective binding resolution is own-first, so
  weblink's own `url` binding wins over any inherited one — pinned by a
  two-writer test) and the sources-family feature toggle now archives
  weblinks with the family (weblink left the always-on list; the
  `systemClassAncestors` gating cascade covered by domain + web tests).
  Empty workspaces receive the edge from the server seed (generic
  extends-map emission); live workspaces materialize it idempotently through
  `ensureWeblinkExtendsSource` (the declaration-first meetingFamily
  precedent, delegation to `deploySystemClass` — re-runs are no-ops). The
  GTK/Flutter seed-convergence follow-up (non-blocking, no lockstep) now
  also covers the weblink→source extends constant. `packages/protocol/SCHEMA.md`
  (seed manifest, citations family, feature map) and
  `docs/developers/architecture.md` updated. Verified: the domain suite
  (72 tests) and the web suites (class-create-modal, properties-panel,
  protocol-batch gating) green; `npx tsc --noEmit` in apps/web clean.

- **feat(web): node links and mention chips render the COMPLETE title.**
  Owner ruling: a link must read as the page's whole title, never a
  truncation. `deriveDisplayName` keeps the 80-char cap for dense chrome
  (breadcrumbs, pickers, sidebars); the domain gains `fullTitleOf` — the
  same title-is-content derivation without the slice, date-node formatting
  intact — and `InlineTokens` mention labels (chips and linked mentions)
  prefer a new `resolveFullTitle` prop, falling back to the capped
  `resolveName` (callers not wired yet keep the old form; a token's custom
  `displayText` always wins). `fullTitleFromClient`/`fullTitleForSettings`
  mirror the displayName pair in `dateDisplay.ts`; the direct call sites
  this pass wires are EmbedView, WhiteboardCanvas, and the presentation
  deck. `packages/protocol/SCHEMA.md` (name-derivation bullet) and
  `docs/developers/architecture.md` updated. Verified: new domain tests
  (uncapped/full/date branch) and web tests (>80-char mention renders
  complete; breadcrumbs keep the capped-and-clipped form) green.

- **feat(web): the page title is a bullet-less block row — full editor powers
  in the header; a page's own content may carry link/mention tokens.** Owner
  ruling: the bespoke single-purpose title editor is replaced by the shared
  row machinery — `BlockRow` gains `variant="title"` (bullet-less, chrome-less:
  no grip/drag, collapse, property/backlink/tags chrome, children, or row
  context menu; the content wrapper is `nt-title-content`, never
  `.nt-block-content`, so body-row selectors never match the header row) and
  `BlockTextEditor` gains the matching title contract: plain Enter flushes and
  leaves edit mode (never splits, never creates a body block), Backspace/Delete
  are in-text-only (an empty title never deletes the page), no task cycle on
  Ctrl/Cmd+Enter; every other power (marks, @/#/+ captures, slash commands, the
  link modal, node-link clipboard, atomic pills) is unchanged. Display mode
  renders the content's inline tokens — external links open the link modal,
  mentions open the target — and the header title keeps the page-heading
  landmark. The store's `object.update` content path no longer flattens rich
  tokens for main-presenting nodes (classes stay text-only; create-as-main and
  block→page promotion remain the lossy, warned boundaries), so authored
  link/mention tokens in a title persist; display-name derivation still
  flattens to text — labels, breadcrumbs, and export titles are untouched.
  Day pages keep the static date header, embedded feeds keep the static title
  link, class pages keep the icon button + title row, focus mode unchanged.
  `ui/TitleEditor.tsx` deleted. Docs in the same pass: `SCHEMA.md`
  (title-is-content ruling), `AGENTS.md`, `docs/developers/architecture.md`,
  `docs/ux.md`. Client lockstep note: the GTK/Flutter appliers still flatten on
  the update path — the rich-title relaxation reaches them with the next
  lockstep batch (their fixtures and wire are unaffected). Verified: store
  suite green (401), `npx tsc --noEmit` in apps/web clean, full web suite
  green (120 files / 1204 tests).

- **fix(web): the link-edit modal composes the kit primitives — the crushed,
  overlapping mode-tab row is gone.** The modal shipped its own unscoped
  copies of the kit chrome classes (`.modal-backdrop`, `.modal`, `.btn`,
  `.selection-button` and parts) for its hand-rolled shell, and the kit's
  higher-specificity `.selection-button--sm` sizing (26px icon squares,
  icon-only by design) beat the modal's label-carrying tab buttons once the
  kit stylesheet landed in the bundle — the Page/Block/URL labels piled on
  top of each other at the top of the modal while the form below stacked
  bare. The shell now composes the kit `Modal` (backdrop, header/footer,
  Esc through the overlay stack, focus trap), the mode toggle composes the
  kit `SelectionButton` (icon tabs with tooltips and aria-labels; the field
  label beneath already names the active mode), and every action composes
  the kit `Button`; Enter still saves from anywhere inside, the embedded
  node picker keeps owning its own Enter/Escape, and the broken-link heal
  and verb create-and-bind rows are unchanged. LinkEditModal.css keeps only
  the namespaced field styles — its global copies are deleted, so kit
  buttons and selection controls elsewhere render from the kit stylesheet
  alone. A structural regression test pins the tab row, the field label,
  and the input as distinct, ordered, non-nested elements (not a pixel
  assertion), plus Esc/backdrop dismissal through the kit layer. Verified:
  `npx tsc --noEmit` in apps/web clean; `editor-popups` + `modals-overlays`
  (40 tests) and the link-modal-adjacent suites (`broken-link-create`,
  `verb-create-bind`, `node-link-gestures`, `popup-dismissal`, `pickers`,
  `template-gallery` — 97 tests) green; visual check of URL/Page/verb
  states in a headless browser harness shows a clean tab row over clearly
  separated labelled fields.

- **fix(web): sidebar popups take the shared dismissal layer; Favorites and
  Recents rows render their titles as read-only block content.** The footer's
  account popup (avatar/email + Sign out) ignored every dismissal gesture —
  the reported bug; it now composes `usePopupDismissal` (outside pointer-down +
  Escape, the profile trigger declared as an anchor so pressing it toggles
  instead of dismissing, presses inside the popup never dismiss; the popup
  root owns Escape from its own interior). The workspace switcher's
  hand-rolled outside-click effect is replaced by the same house hook with
  the trigger as anchor. The Favorites/Recents row context menu already
  dismissed correctly through the kit ContextMenu (capture-phase outside
  press + the overlay stack's Escape) — audited, now pinned by tests. Row
  labels drop the bespoke string render and compose the shared read-only
  `InlineTokens` machinery, exactly like a read-only block row: mention chips
  get the link UI (click opens the target through the alias resolution,
  right-click opens the node-link menu), the row keeps its star toggle, class
  flag, active highlight, and keyboard navigation, and the row body becomes a
  `div[role=button]` (the NodePill idiom) so the label's links are real
  buttons; Shift+click peeks the node in the right sidebar, mirroring the
  block bullet's shift idiom. `docs/usage.md` carries the user-facing
  description. Verified: `npx tsc --noEmit` in apps/web clean; the sidebar
  menu + settings-modals suites (46 tests) and the full web suite green
  (119 files / 1190 tests).

- **fix(web): the boot screen never silently re-routes; a Sync tab in User
  Settings; uploads clear the web proxy.** Owner rulings: a failed connect
  now shows the error plus an explicit "Try `<origin>` instead" suggestion —
  nothing probes or connects anywhere without a click (the silent same-host
  fallback is gone from the account AND the API-key flows). User Settings
  gains a Sync tab: the current sync server with reachability, "Disconnect &
  forget this server" (confirmed), and "Connect to a different server". The
  web nginx proxy also honors the sync server's body ceiling (128 MB —
  asset uploads died at nginx's 1 MB default with HTTP 413). Full web suite
  green (118 files / 1200+ tests), deployed via the compose build flow.

- **feat(web): the boot screen never silently re-routes — the same-host guess
  becomes an explicit suggestion; User Settings gains a Sync tab.** Owner
  ruling: a failed probe no longer auto-retries the same-origin guess. The
  error + hint stay, and a "Try \<origin\> instead" button rendered under the
  boot form is the only path to the guess — clicking it sets the field and
  probes explicitly. The probe path is extracted into a shared
  `connectTo(url)` used by the boot form and the new settings Sync tab, which
  shows the configured sync server with its reachability, offers "Connect to
  a different server", and "Disconnect & forget this server" (kit
  ConfirmationModal — it signs the user out and clears the stored server URL,
  session token, and API key). The auto-retry's now-dead boot note is removed.
  Verified: `npx tsc --noEmit` in apps/web clean; `settings-modals` +
  `app-smoke` (45 tests) and the App-rendering suites (136 tests) all green.

- **feat(web): the drag-session interaction model — the muted source row and
  the proximity-snapped drop line.** The outliner's drag feedback stops
  reshaping the page. The dragged row no longer translates with the pointer:
  it stays in place and renders muted (`.nt-block--drag-source` on the row
  root, token-only opacity plus a surface tint — no layout change), and the
  floating DragOverlay keeps only the small name chip as the preview. The
  live hit-testing gives way to a proximity snap model: at drag start the
  machinery measures the visible rows once and builds the valid-location set
  (`dropCandidatesOf` — for every visible row except the dragged subtree, a
  sibling above/below pair anchored at the row's divider at the row depth's
  gutter x, plus a child candidate anchored at the row's center at the
  child-offset x), and each pointer move projects the pointer onto the
  nearest anchor within a 24px y band (`nearestCandidate`, x distance breaks
  ties) — far from every anchor, no indicator renders. The hierarchy-end gap
  below an expanded block's last child disambiguates across three nearby
  candidates by x band: a sibling-after-parent at the parent's depth, a
  sibling-after-last-child at the child's depth, and the child slot at the
  child-offset x. The child intent's indicator bar now renders at that
  child-offset position. The line stays the indicator: `resolveMove` /
  `executeMove` / zone semantics are untouched, the event-driven path still
  resolves keyboard drags and end-of-drop guard refusals (the own-subtree
  banner included). `npx tsc --noEmit` clean; full web suite green (1221
  tests).

- **feat(web): the collection create-button flag, the fullscreen whiteboard
  container, and the graph view's reference chrome — the main-content
  restructure's view-layer recoveries.** (a) The reusable collection
  contract gains the create affordance: `showAddButton` + `onAdd` (+
  `addLabel`) on `NodeCollectionProps`, rendered as a kit button in the
  collection's empty state (the kit EmptyState's action slot) and in the
  view toolbar where one exists — only when the flag AND the callback are
  set AND the surface context allows it. Enabled in exactly two places:
  the Child pages section (renders on the main surface even when empty;
  "Add child page" creates a present-as-main child of the host page and
  opens it — the section's row-click behavior; embedded feeds stay
  read-only and hide a childless section) and the Classed nodes section
  ("Add member" in the toolbar and the empty state creates a node classed
  with the class — visible on an empty database). The `Section` primitive
  gains the opt-in `renderWhenEmpty` for containers owning their empty
  state. (b) A whiteboard page on the main surface renders the spatial
  canvas as the content card's sole content — the page chrome (the
  panelled columns, nodeview top bar, header, footer) steps aside and the
  canvas fills the card edge to edge (`.nt-page--whiteboard`; the card
  frame stays, the canvas's own border/radius/margin go). Embedded feed
  entries and in-block boards keep the bounded in-flow canvas. (c) The
  graph hub renders edge-to-edge in the content card (`.nt-graph-surface`)
  and the graph chrome re-presents to the reference graph UI: the settings
  toolbar composes from the kit (ghost icon tools, the icon-radio mode
  selectors, boolean switches, the kit search field; the edge-family chips
  stay the rendering register), the local neighborhood rides a labeled
  depth slider, and the empty surfaces carry the reference wording —
  "Nothing to graph yet" for the empty workspace, the levels hint for an
  empty neighborhood, the filtered-out state with a Reset filters
  affordance (back to the shipped defaults) on the full surface; an empty
  display renders instead of the stage, so no renderer initializes on a
  graph with nothing to draw. The WebGL renderer, physics engine, minimap,
  local-graph mode, and settings persistence are unchanged. `npx tsc
  --noEmit` clean; full web suite green (1215 tests).

## 2026-10-06

- **chore(ops): the edge's https port defaults to 8443 — :443 is not Notees's.**
  The tailnet URL is `https://<host>.<tailnet>.ts.net:8443` (name-based certs
  work on any port); `NOTEES_EDGE_HTTP` remaps it. Verified on the fleet host.
- **fix(ops): the web container proxies /api to the sync service — one
  origin for UI+API; compose carries the build contexts (no more tag
  envs).** Following the tailnet-edge migration (same day): the nginx config
  in the web image now proxies `/api/*` to `notees-sync:8377` over the
  compose network (websocket headers included), so browsers only ever talk
  to the one web origin — no CORS, no separate sync URL to configure, https
  over the optional edge wraps everything in one secure context (browser
  storage requires it). The web client's default sync URL is now simply the
  page origin (vite dev gained the same proxy). The edge's Caddyfile
  simplifies to a single proxy. App publishes return to zero-config wildcard
  defaults (the fleet host's loopback pins were serve-era only), the
  `18xxx` LAN-shadow publishes are removed, and `NOTEES_SYNC_TAG` /
  `NOTEES_WEB_TAG` are gone — compose carries the build contexts, so the
  development flow is `docker compose build && docker compose up -d` (the
  deployment always runs the local codebase; hosts that haven't built pull
  `:latest`). Verified on the fleet host: `http://atlas:8378` serves,
  `/api/version` answers same-origin through the proxy and through the
  edge, `VERIFY-PASS`.

- **fix(ops): the containers could not start — a wildcard app bind collided
  with the tailnet edge; HTTPS moved from tailscale serve to an optional Caddy
  edge.** Incident (2026-10-07): the sync/web containers sat in `Created`,
  failing to bind `0.0.0.0:8377` — tailscaled's serve held the tailnet IP on
  the same port number; the loopback pin had gone missing from the host's
  `.env`. Root fix, per the owner's direction: app publishes are now remappable
  full `ip:port` envs (`NOTEES_SYNC_HTTP`, `NOTEES_WEB_HTTP`, `*_LAN_HTTP`,
  zero-config wildcard defaults); TLS moved off `tailscale serve` into an
  optional compose **edge profile** — Caddy + the tailscale plugin, one
  published port, ts.net certs via the mounted tailscaled socket, `/api/*` →
  sync + everything else → web over the compose network so the https page is
  same-origin (browser storage requires a secure context). The web client
  guesses same-origin on https pages, same-host:8377 on plain http; a remapped
  sync port is set from the UI's server field. No-https deployments keep
  working (in-process store banner). Verified end-to-end on the fleet host:
  `VERIFY-PASS`, https name serving the web UI + API. Runbook + ops skill
  updated (deployment.md).

- **chore(web): the restructure branch meets the scrub law — era references
  removed from comments and test titles.** The branch's new files predated
  the tree-wide scrub, carrying plan-era citations, amendment and slice
  labels, and product-generation references into comments and test titles.
  All rewritten to stand alone (46 files, zero logic changes); genuine
  version identifiers (the OFL license, the wire/protocol versions, code
  ids) untouched. Transient internal-doc pointers dropped from the
  changelog and runbooks per the standing rule. Full web suite green
  (1206 tests), tsc clean.

- **refactor(web): S7a of the main-content restructure — the context column,
  the cards-only rail, Comments (M19), Activity's relocation (M18), the
  preview seam (M15).** The panelled main layout is now THREE columns —
  NodeView · properties · context. The context column (`.nt-page-context`)
  hosts, top-down: LocalGraphCard, TocSection, the Activity section, and the
  new Comments section; each panel column keeps its own device-local
  collapse, toggled from the nodeview top bar (now a toggle pair), and the
  `layout` prop stays BINARY — per-column device prefs
  (`pageSidePanelCollapsed` / `pageContextPanelCollapsed`) replace the
  recorded "third state" option (registered choice). **The references dedupe
  check (the S7 precondition):** the rail's ReferencesSection and the page's
  own Backlinks tab both rendered `getLinkedReferences` — the SAME data —
  verdict: the rail's ReferencesSection is DELETED
  (`components/sidebarSections.tsx` keeps TocSection only); the Backlinks tab
  stays the one home in the SectionStack, where the tab/filter machinery
  lands later. One home, no duplication. **M18:** `SystemSections`'s
  `withActivity` prop + branch die; ActivityLogSection renders in the
  context column (its useSectionData lazy contract rides along).
  **M19:** `components/CommentsSection.tsx` — the v1 model restored:
  comments are direct children classed `comment` (the seeded system class);
  NodeViewSection chrome ("Comments" + direct-child count), hidden when
  empty; the v1 quick-add/reply composer pair (a child block classed comment
  + the text as its content — title-is-content); rows open the comment node;
  each row carries Reply/Delete (the v1 pair); children nest in the thread
  (any child blocks, v1's recursion). Lazy per the section contract via
  useSectionData. **M15/M17:** `ui/SidebarNodeCard.tsx` is DELETED — replaced
  by `components/NodeCardFrame.tsx`, the generic `nt-sidebar-card` frame
  (breadcrumbs header + collapse/open-in-main/close; collapse is
  session-local — reorder/dismiss gestures are a registered follow-up)
  rendering NodeView (compact, no corner menu); App's rail hosts the frame
  stack exclusively. `NodeView` gains `preview?: boolean` — no corner menu,
  no global listeners, a read-only body capped at the first level
  (`maxDepth` 1, outline), no section stack; nothing renders it yet —
  swapping NodeHoverPreview's bespoke card for the seam is the registered
  follow-up. Embedded/journal/calendar surfaces, focus mode, and the class
  variant render NO context column (main-surface chrome only). jsdom test
  setup stubs `HTMLCanvasElement.getContext` → null quietly (the context
  column mounts a graph card with every page view; the graph's WebGL-missing
  path already rendered its honest empty state — the stub silences jsdom's
  per-call "Not implemented" scream). Tree-text assertions in seven existing
  suites scope to `.nt-block-tree` / their section (the TOC legitimately
  echoes short one-line blocks — the rail-era design, now in the column).
  Docs: `usage.md` + `ux.md` re-home the context widgets. **Verification:**
  the full apps/web suite green (121 files / 1206 tests — comments-section 6,
  context-column 8 new; the ReferencesSection rail test dies with the
  component per the dedupe verdict); `tsc --noEmit` clean in apps/web; the
  layout-probe selectors (`.nt-node-topbar` and children, `.nt-page-body`,
  `.nt-page-side-panel`, `.nt-nodeview-body`) unchanged.
- **feat(web): text-property rows render as locked outline collections.**
  A text property's values are node-backed carrier blocks; the row's
  bespoke mini-outliner renderer is replaced by the shared dispatcher —
  one `NodeCollection` per row, viewMode pinned to the outline mode (no
  switcher), `tree` + `editable`, each carrier one root item rendered
  through the `BlockRow` machinery. Each root row keeps its own
  per-carrier outliner context (carrier-scoped positions and collapse,
  bullet click opens the node), and the row keeps the standalone
  renderer's client subscription, so editing, navigation, and the
  carrier Enter semantics (multi registers the sibling as the next
  value; single nests a child) are unchanged. The dead-carrier-EMPTY
  cell and the legacy scalar input fallback stay as-is; the panel and
  the compact layouts both consume the row through the properties
  table, so one change covers both. Gates green: the four property/
  metadata/table web suites (48 tests) + `tsc --noEmit` clean for the

- **chore(sync): the GTK/Flutter wire corpora re-vendored to byte-identity
  (21 fixtures).** The client copies of `packages/protocol/fixtures/` had
  drifted (missing `object-restore.json`, stale `class-property-defaults.json`);
  both now sha256-match the TS reference 21/21 and their exact-list gate
  assertions were extended — the convergence signal, mirroring the protocol
  gate's exact-list law. No wire change: `object.restore` and the
  number-format schema keys already shipped in the reference; the corpus now
  pins them on all three sides. Gates green: TS (262 protocol + 401 store),
  GTK 680 passed, Flutter 578 passed.
- **chore(docs): milestone markers (M1/M2/M3/M5 labels) scrubbed from code
  comments, test titles, and package docs.** Continuation of the record-keeping
  retirement: `apps/server/src` + `apps/server/test`, `apps/server/Dockerfile`
  ("Notees v2 sync server" → "Notees sync server"), and `packages/{domain,
  store,sync,query,export,protocol}` (incl. `packages/query/README.md`,
  `SCHEMA.md`, `WIRE.md`) no longer name delivery milestones — the text stands
  without the labels ("the M1 default" → "the default", "DEFERRED to M2" →
  "DEFERRED", the M2/M3/M5 describe-blocks in the search suite renamed, …).
  Same deliberate exception as the plan retirement: `packages/protocol/fixtures/`
  stays byte-pinned (the fixture comment strings carrying an M-label are part
  of the sha256-pinned convergence corpus), and live version identifiers
  (envelope v3, `/api/relay/v2`, WS framing v2, `v2.0.0-mN` client tags) are
  untouched — only prose labels went. No logic, symbol, or assertion changes.
- **chore(docs): the plan-as-record workflow retired; `CHANGELOG.md` becomes
  the record.** Deleted `.plans/implementation-plan.md` and `.plans/design/`
  (kept `.plans/2026-10-06-1352-main-content-restructure/` as the first
  date-stamped proposal folder), stripped plan §-citations, `.plans` pointers,
  and v1/v2 history mentions from code comments, tests, and docs. `AGENTS.md`
  is now static guidance with a records index; the `notees-development` and
  `notees-operations` skills point here. Deliberate exception: the protocol
  fixtures under `packages/protocol/fixtures/` keep their metadata untouched —
  those bytes are sha256-pinned across the TS/GTK/Flutter convergence gate.
