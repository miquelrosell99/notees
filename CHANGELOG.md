# Changelog

The record of shipped work for Notees. One entry per shipped slice, newest
first. This file — not `AGENTS.md`, not the runbooks — is where history goes;
those stay static guidance. Before implementing a change, skim this file for
recent related work. Anything before 2026-10-06 lives in git history: the
retired implementation plan and design stack are recoverable from commits
predating this file.

## 2026-10-06

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
- **fix(web): M39 — the card cover layout gate is honored (no-cover is
  text-only again) + the v1 cards/table look recovery.**
  - `CardCover` declared the `layout` prop but never read it: cards rendered
    covers (placeholder + lazy fetch + lightbox) under the "No cover"
    layout. Now `no-cover` renders nothing AND skips the lazy fetch (no
    observation, no bytes); the JSX and the effect are both gated.
  - Cards v1 recovery (`CardsView.css`): the grid is v1's adaptive CSS
    masonry on a raised surface-container-high panel (spacing-4 pad,
    shape-large radius); cards wear the v1 chrome — blended
    outline/outline-variant border, the 20px --shape-card radius, zero
    elevation, row-based padding with no interior dividers, the cover as a
    matted slot, the select checkbox as a hover-reveal surface chip, the
    selected wash = surface-container-high + primary focus ring, and the
    cover badge moves to the top-left (v1's cover-bullet corner).
  - Table v1 recovery (`TableView.css` + the header JSX): the boxed table —
    separate borders, outline-variant outer border with shape-medium
    radius, per-cell grid hairlines, surface-variant sticky header at 600,
    spacing-2/3 cells at base font size, the row hover painting every
    cell, the selected row on the hover-overlay wash, the sticky
    select column with the row-gutter shadow, and the v1 sort register —
    direction arrows on every sorted column plus the multi-sort priority
    index.
  - Machinery untouched throughout: useWindowed paging, selection export,
    the CoverLayoutToggle preference, useLazyInView (16/9 cover slot kept
    so the pending placeholder holds its size), kanban's NodeCard reuse,
    inline editing, the tri-state header checkbox, CSV/Excel export,
    ImportTableModal, ROW_WINDOW.
  - **Verification:** the M39-targeted web suites all green — view-modes
    (28), card-lazy-images (4), table-nodes (16), selection-export (4),
    query-block (18), windowing (15), class-view (11), covers (16),
    page-layouts (25) — and the full apps/web suite (119 files / 1193
    tests) green; `tsc --noEmit` clean in apps/web.
- **refactor(web): S5 of the main-content restructure — the class variant is
  pure data; `ClassPillsList` generalizes the class pills (M9–M13).** M11:
  `components/ClassPillsList.tsx` — ONE relation-parameterized pills
  component (`query` + add/remove/reorder mutations as arguments) riding the
  existing NodePills machinery; `ClassesRow` (the page corner's instance-of)
  and `ExtendsRow` (the class corner's extends) become thin adapters over
  it, and `NodePills` stays exported for BlockRow. M13: the slot
  composition dies — new `components/pageVariant.ts` derives the page
  variant (`plain` | `date-day` | `date-period` | `class`): the
  day/month/year facts, the class corner's extends-pills relation config,
  and the class section stack (SectionSpec-shaped descriptors mounting the
  unchanged classview renderers) are DATA consumed by PageView; `ClassView`
  is deleted — class nodes render the normal page path with the class
  variant. The deleted class chrome per M9/M12: no curated icon button
  (`ClassIconButton` deleted), no color dot, no extends-cycle banner —
  the shared header icon button is the single icon+color entry, now wired
  to the picker's M10 color section (`onColorChange`). Date variants as
  data: the inline day/month/year derivation moves behind `pageVariantOf`;
  the DayPageHeader swap stays in PageHeaderChrome, section placement
  unchanged (S7's job). The store's loud extends-cycle refusal (the
  applier's CycleError) is unchanged — the rejection now lands in the
  console (no UI). Tests: the three suites importing `ClassView` plus
  windowing/class-bindings/view-modes re-point at `NodeView`; the
  cycle-banner assertion is updated to the new truth (store refuses, no
  banner); the class icon-picker test clicks the shared header icon
  button. `test/child-query.test.ts`: pre-existing type-hygiene fixes
  (explicit `Entry` shape — the `ReturnType` self-reference was circular;
  non-null index reads) so the apps/web `tsc --noEmit` gate is clean.
  tsc clean, full web suite green (119 files / 1193 tests; the 9-file
  verify list: 122 tests). Design:
  `.plans/2026-10-06-1352-main-content-restructure/`.
- **feat(web): the v1-UI recovery batch — M33 upload-modal parity + cover/
  assets-hub triggers, M35 builder re-UI, M10 picker color, M38a noCreate.**
  Four view-layer slices, no wire/model change. **M33:** the
  AssetUploadModal gains the full v1 interaction — a modal-internal
  clipboard-paste capture (`clipboardData.items`), `acceptedTypes`
  (narrows the accept list + validates with the v1 "Only … files are
  accepted." wording), the v1 size caps enforced client-side (50 MB media /
  100 MB documents, mirroring the server config), `initialFile` routed
  through the same validation, and a single-category title ("Upload
  image/audio"); the CAS upload path + preview row are unchanged. Three
  triggers now open it: the empty cover card's **Add cover** (image-only;
  the uploaded asset becomes the cover), the Assets hub's new **New asset**
  header button (uploading IS creating; the created asset opens), and the
  existing property-upload row (unchanged). The cover's **Change** path
  keeps the CoverPicker; its "Upload new cover…" row routes to the same
  modal. **M35:** QueryBuilderFields re-presents the §34.31 builder subset
  as the v1 ViewBuilder card list — scope bar, one card per condition with
  a remove (✕) back to unset, prose operator words (contains/after/before),
  the v1 "No filters — all nodes will be shown" note — chrome only: the
  AST subset, the control labels/values, and the C1 lossy-edit guard are
  untouched (co-located `QueryBuilderFields.css`; the dead `.nt-query-field`
  block leaves app.css). **M10:** IconPickerPopup gains the additive color
  section — `onColorChange` + `color` props host the kit ColorButton
  (swatch + palette + no-color) in the header; absent prop = hidden, so
  icon-only consumers are untouched; ColorButton's picker popover now stops
  pointerdown capture so a nested pick doesn't dismiss the host popup.
  **M38a:** NodeSelector `noCreate` suppresses the create-from-query
  affordance (QuickCreateModal route included) — search-without-match shows
  the honest empty state. Verification: the 8-file suite green
  (asset-upload-modal 11, covers 16, asset-attachments 10, pickers 12,
  query-builder-guard 5, queries-hub 5, query-block 18, settings-modals
  28 — 105 total), plus class-create-modal 8 (new assets-hub creation
  test), page-layouts + day-features 44, css-token-drift gate green;
  `tsc --noEmit` clean for every touched file.

- **refactor(web): S4 of the main-content restructure — the body is the
  plain collection, fed by `childQuery`.** The body's item resolution
  becomes `components/childQuery.ts` beside the SectionSpec factories: page
  mode = children as siblings; block mode (`showRoot`) = the node as the
  single root item (the M2-verified item shape — no NodeCollectionProps
  addition). `FocusedBlockView` folds into the NodeView block branch (the
  `.nt-focused-block` chrome preserved). M19's exclusion lands with it:
  comment-classed children are cut at every level (whole subtrees) — inert
  until the Comments section (S7) gives them a home. New unit coverage
  (test/child-query.test.ts); typecheck clean, 120 tests green across the
  touched surface. Design:
  `.plans/2026-10-06-1352-main-content-restructure/`.
- **refactor(web): S3b of the main-content restructure — the chrome leaves
  move to `PageChrome`.** `ui/PageChrome.tsx` extracted from PageView: the
  `NodeTopbar` (sidebar toggle + classes corner + chromeRight), the
  `PageHeaderChrome` (day-aware header: DayPageHeader branch, icon button +
  IconPickerPopup, TitleEditor / embedded link, headerActions, TagsRow, and
  the cover aside), and the `PageFooterChrome` (null when embedded/focus
  mode). PageView keeps the panelled/compact composition (the `.nt-page-body`
  grid + `.nt-nodeview-body` stack) — S7 reworks the columns; props and
  behavior unchanged, ClassView's slot composition passes through the
  extracted pieces verbatim. The Properties column names itself now (owner
  request): PropertiesSidebar renders a small muted "Properties" header row
  (icon + label + the effective count) in the nodeview top bar's register.
  Pure move + the one additive header row: tsc clean, full web suite green
  (1175 tests, one properties-panel assertion added for the header).
  Design: `.plans/2026-10-06-1352-main-content-restructure/`.
- **refactor(web): S2 of the main-content restructure — one lazy-section
  contract behind `useSectionData`.** The four hand-rolled lazy idioms
  collapse into one hook: `components/useSectionData.ts` (first-activation
  gate, version-keyed cache across switches, per-notification re-run,
  failure keeps rows; `read`/`query` strategies) + `components/
  CollectionSection.tsx` (the one skin: NodeViewSection header + body-top
  ViewToolbar + NodeCollection). `Section.tsx` is a thin wrapper over the
  hook with unchanged props; SystemSections (the backlinks tabs ride TWO
  hook instances — never a shared cache), CreatedSection, and
  ActivityLogSection converted with byte-identical exports; DayPageSections
  absorbed via Section. `SectionSpec` lands as the data-facing descriptor.
  Same-exports hard rule held — PageView didn't move. S2-surface tests
  green (~95), tsc clean. Design:
  `.plans/2026-10-06-1352-main-content-restructure/`.
- **refactor(web): S3a of the main-content restructure — the page machinery
  moves behind `usePageMachinery`.** Outliner construction, the selection
  surface, find/replace (state, shortcut listener, prose docs), the
  external-link delegation + LinkEditModal opener, the DnD wiring, and the
  fold chords — everything PageView wired by hand — moves to
  `ui/usePageMachinery.ts` and returns one bag the component consumes; the
  JSX that hosts it stays. New `globalShortcuts` option (default true;
  embedded implies false) prefigures the workspace-card surfaces. Pure move:
  typecheck clean, 102 machinery-adjacent tests green. The drag half hoists
  to the workspace host in S6. Design:
  `.plans/2026-10-06-1352-main-content-restructure/`.
- **refactor(web): S1 of the main-content restructure — the NodeView shell
  extraction.** `ui/NodeView.tsx` (the mode dispatcher + chrome-right
  cluster builder + the new `embedded` surface prop) and
  `ui/SidebarNodeCard.tsx` extracted from App.tsx; App re-exports NodeView
  for the view-routing tests. FloatingEditor windows now render the shared
  NodeView (`embedded`) instead of their own copy of the render cascade —
  the dispatch existed twice (App + FloatingEditor) since the v1 port; one
  copy remains. Pure move, no behavior change: typecheck clean, full web
  suite green (1175 tests). Design + the registered deviation
  (SidebarNodeCard deletion rides S7):
  `.plans/2026-10-06-1352-main-content-restructure/`.
