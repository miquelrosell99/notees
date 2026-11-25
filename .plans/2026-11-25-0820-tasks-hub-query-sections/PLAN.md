# Tasks hub: query sections + generic group-by (proposal)

Owner direction (2026-11-25): the two dedicated task views (Buckets, Review)
go away. Outline view already has what tasks need — give it real grouping
(group by Status in the tasks context) and give the table view the same
group-by (one table per group). Grouping by a selection property orders
groups by the option order and SHOWS EMPTY OPTIONS. Buckets stop being a
view: the tasks hub's default surface becomes several stacked QUERY
sections — Overdue is a query (outline view by default), Unscheduled
another query section, etc. Review becomes a query section too.

Owner rulings (2026-11-25, this session): remove Buckets + Review · hub
default = stacked query sections · group-by is GENERIC — **any property
type except text** (owner: "grouping should be applicable to any property
type, right? Except text properties"), PLUS pseudo-properties (page,
created, edited, class) — the outline's containing-page grouping and the
cards board's kanban columns already exist; this generalizes them ·
**date-typed groupings carry a zoom submenu (year / month / week / day)**
· Review becomes a query section.

## What exists today (audit, 2026-11-25)

- `NodeCollectionProps.groups`/`ungroupedItems` — collapsible named groups,
  consumed ONLY by the outline view (`OutlineView.tsx` GroupedFlat); wired
  only by CollectionSection/SystemSections via `groupByContainingPage`.
- Cards board: `groupByProperty` (select schema) → columns in
  `schema.options` order + trailing "None" (`CardsBoard.tsx:297-300`).
- Table view: no grouping at all.
- Buckets/Review: registered collection views (`bucketsView.tsx`,
  `reviewView.tsx`) with hard-coded derivations
  (`partitionTasksIntoBuckets` — driving day = earliest of
  Scheduled/Deadline; `groupSlippedTasksByDay`).
- Query AST: property conditions eq/neq/contains/exists/gt/gte/lt/lte/
  between/within + AND/OR groups + group-level not-wrap + `{today}`-style
  compile-time placeholders (`packages/query/src/placeholders.ts`).
  **Every bucket/Review set is expressible as a stored QueryAST** — no
  protocol change, no fixture gate:
  - Overdue: open AND (scheduled < {today} OR deadline < {today})
  - Today: (s == {today} OR d == {today}) AND NOT (s < {today} OR d < {today})
  - Upcoming: (s exists OR d exists) AND NOT (s <= {today} OR d <= {today})
  - Unscheduled: NOT s exists AND NOT d exists
  - Completed: status ∈ {Done, Cancelled}
  - Review: open AND NOT repeat exists AND (s < {today} OR d < {today})
  (open = NOT (status eq Done OR status eq Cancelled); the derived-Pending
  default rides `includeDefaults`.)
- The outline view renders NO done checkbox for tasks — the buckets rows
  own the checkbox + one-tap postpone. Removing Buckets without replacing
  the checkbox is a regression (see Slice 2).

## Slice 1 — Generic group-by for outline + table

**Groupable axes** (the wire's property-type registry is `text, number,
boolean, datetime, email, select, multi_select, object, image, asset` —
`op-types.ts:426-461`; text is the ONE excluded type):

- **select / multi_select** — groups in `schema.options` order, **empty
  options included**, trailing "No <label>" group for valueless items
  (the cards board's None precedent).
- **boolean** — two enumerable groups (true/false), both always shown,
  valueless items in the trailing "No <label>" group.
- **datetime** (and the created/edited pseudo-properties) — grouped by
  **zoom level: year / month / week (ISO) / day**, picked in a SUBMENU of
  the Group-by picker; groups chronological (oldest first), only
  non-empty groups (dates aren't enumerable), valueless items in the
  trailing "No <label>" group. The zoom choice persists with the
  group-by selection.
- **number** — one group per exact value, numeric order.
- **email** — one group per exact value, alphabetical.
- **object / asset / image** (node references) — one group per referenced
  node, alphabetical by target display name.
- **Pseudo-properties**: **page** (containing page — the existing
  `groupByContainingPage`, joining the picker as a first-class axis),
  **parent** (the immediate parent node — the page axis's finer-grained
  sibling), **tag** (tag membership — `tagIds` is graph state distinct
  from classIds), **created**, **edited** (both datetime → the zoom
  submenu applies), **class** (one group per class the node carries).
  (Favorites are deliberately EXCLUDED: nodePrefs per-user coordination
  state, not graph state.)
- **Multi-value rule** (`multi: true` schemas, multi_select, class): an
  item appears in EVERY group it has a value for (the Notion-style
  truth rule — group counts can exceed the item count; documented).
- Group order: select/boolean = option/enum order; number = numeric;
  date = chronological; node/text-ish = alphabetical; the "No <label>"
  group always trails.

**Implementation**:

- **Shared grouping helper** (`features/collection/grouping.ts`): a
  `GroupBySpec` (`{ kind: "property", schemaId, zoom? } | { kind: "page" |
  "created" | "edited" | "class", zoom? }`) + `groupsForSpec(client,
  items, spec)` → `CollectionGroup[]` implementing the rules above.
  Cards board refactors onto the same helper (behavior-preserving:
  select grouping stays option-ordered + None).
- **Outline view** consumes the group-by spec: derives groups via the
  helper and renders through the existing GroupedFlat collapsible-section
  machinery (empty select groups render their header + zero rows). The
  explicit `groups` prop (containing-page grouping) keeps winning when
  both are present.
- **Table view** consumes the group-by spec: one `<table>` per group with
  a group header (label + count); empty select groups render the header
  with an honest empty line. Sort/column machinery unchanged per table.
- **Group-by picker**: a "Group by" dropdown in the collection chrome
  (next to the view switcher) listing the pseudo-properties + every
  groupable property carried by the item set + "None", with a **search
  box at the top of the popup** filtering entries by name (keyboard-
  navigable, the picker's standard typeahead idiom); date-typed entries
  open the **zoom submenu** (year/month/week/day). Choice + zoom persist
  device-locally per surface (the `useViewModePreference` pattern —
  never an op). Hosts may pass a default (the tasks hub defaults to
  Status).
- Docs: `docs/features/` collection/views page + CHANGELOG.

## Slice 2 — Tasks hub: stacked query sections replace Buckets/Review

- **New registered view `taskSections`** (the bucketsView registry-seam
  precedent) becomes the tasks hub's DEFAULT mode: stacked live-query
  sections — **Overdue, Today, Upcoming, Unscheduled, Completed, Review**
  — each section defined by a QueryAST (the table above), executed through
  `useQueryRun` and intersected with the hub's filtered item set (the
  filter toolbar keeps narrowing every section, the buckets precedent).
  `{today}` placeholders re-resolve per compile; sections recompile on
  client notify + day rollover.
- **Each section** = header (name + count, collapsible, device-local) +
  its own NodeCollection with its own persist keys: view switcher
  (outline/table/cards), **default outline**, **default group-by
  Status** (Slice 1's picker, per-section persistence).
- **Task rows keep their gestures**: outline rows for task-classed nodes
  gain the done checkbox (the shared `setTaskDone` write — Done/Cancelled
  stamps Closed, the reopen shadow-write, one undo entry) and the
  hover-revealed Push-to-tomorrow action where eligible
  (`taskPostponeTargetOf`). This lands as task row chrome in the outline
  view, so EVERY outline surface (hub sections, plain outline mode, day
  pages) gains it coherently.
- **Deletions**: `bucketsView.tsx`, `reviewView.tsx`, `TaskBuckets.tsx`,
  `TaskReview.tsx` + CSS + their modes in HubView; audit other consumers
  first (the day page's task rows — keep whatever it uses). The
  `partitionTasksIntoBuckets`/`groupSlippedTasksByDay` derivations retire
  with their tests, replaced by section-AST specs.
- Persisted-mode migration: a stored `hub.tasks` = "buckets"/"review"
  sanitizes to the new default (the existing `sanitizeViewMode` fallback).
- Docs: `docs/features/tasks.md` rewrite of the hub section (buckets →
  query sections; grouping), CHANGELOG.

## Slice 3 — Multi-level sorting (outline + cards; the table has it)

Owner direction (2026-11-25): priority (and any field) should be obtainable
via SORTING — a multi-level sort with a popup selecting the sort FIELDS,
each with its mode (asc/desc) and its PRIORITY ORDER (first priority, then
scheduled date, then page, …). Applies to outline, table, and cards. The
table already has the machinery (the multi-column SortSpec list + the Sort
panel's priority reorder) — this slice generalizes it.

- **Shared sort model** (`features/collection/sorting.ts`):
  `SortFieldSpec = { field, direction: "asc" | "desc" }` over
  `SortField = name | created | edited | page | parent | { property,
  schemaId }` (every non-text property — the group-by axes minus zoom).
  `sortValueOf(client, item, field)`: name = the title (case-insensitive,
  the Name A–Z ruling); created/edited = the timestamps; page/parent = the
  target's title; select = the OPTION INDEX (schema order — Priority desc
  reads Urgent first); datetime = the value's day; number = numeric;
  boolean/email/node-refs = the scalar / target title. Empty values sink
  LAST (the table's contract). `compareBySortSpecs` = the stable
  multi-level comparator (the table's compareRows generalized).
- **The popup**: one shared Sort panel (the table's SortPanel idiom
  extracted): the active levels in priority order (direction toggle,
  move up/down, remove) + an add-field row. Replaces the outline's
  single-mode SortMenuButton and the cards' sort toggle; the table keeps
  its column-keyed panel (already multi-sort).
- **State**: session-local per surface (the table sort's existing
  contract); the container's `defaultSortMode` stays the un-picked default
  ("dates-first"/"alphabetical" map to their legacy comparators ONLY while
  the user has picked nothing — the ranked-search latch precedent), so no
  existing surface default changes.
- **Grouping interaction**: groups keep their semantic order (option
  order, chronological); the sort applies WITHIN every group (the table's
  grouped rendering already does this).
- Docs: views.md (the sort button section becomes the multi-sort ruling),
  tasks.md (priority via sorting), CHANGELOG.

## Per-slice discipline

Worktree per slice (`.worktrees/<slug>`), scoped gate in the loop, full
root gate pre-landing, CHANGELOG in the same pass, per-file staging,
Conventional Commits, land on main (fetch/rebase/ff), redeploy the web
image + verify-min smoke via the notees-operations skill, watch the
publish run to completion.

## Open risks / decisions taken

- **Today/Upcoming AST shape** is the fiddliest (presence arms); pinned by
  dedicated specs before the hub rewires.
- **Postpone in sections**: kept via the outline-row hover action (same
  eligibility helper); the Review section's bulk "Push to today" retires
  with the Review view — the per-row postpone + the date pill cover it
  (flagged to the owner; restoring a bulk gesture would be its own slice).
- No protocol/store/seed change in either slice → no fixture gate, no
  client lockstep; sibling-client check recorded in each changelog entry
  (GTK/Flutter hub lanes unaffected — they consume ordinary property
  state).
