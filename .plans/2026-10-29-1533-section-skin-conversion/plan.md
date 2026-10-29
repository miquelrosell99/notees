# Section skin conversion + SectionSpec registry — 2026-10-29

**Status: all six slices landed 2026-10-29** (commits `2d573c869`,
`f00f69358`, `9a890b365`, `5cbe482f2`, `e4e92ab17`, and slice 6's). Gate
green at 2545 web tests.

Approved design (owner, 2026-10-29). Two phases, six landing slices, one spec.
Approach B from the design discussion: slice per section family, each slice
lands independently (gate green + changelog), nothing half-done.

## Goal

One render target for collection-backed node sections, then formalize
section placement as data.

## Scope

The six collection-backed sections + the property References table:

- `ExtendedBySection` (classview/xtendedBySection.tsx)
- `ChildPagesSection` (page-sections/SystemSections.tsx)
- `BacklinksSection` / `UnlinkedMentionsSection` (page-sections/SystemSections.tsx)
- `ClassedNodesSection` (classview/lassedNodesSection.tsx)
- `CreatedSection` (page-sections/CreatedSection.tsx)
- Property References table (metadata/PropertyView.tsx, if cheap)

## Non-goals (explicit)

- The ~14 bespoke-content sections (Comments, VersionHistory, ActivityLog,
  Toc, Annotations, PropertyDefinitions, Templates, ParentlessRole,
  Properties*, DayPage Tasks/Dated, LocalGraphCard, GraphView rail,
  QueryNodeSection) stay on `NodeViewSection`/`Section` permanently. Their
  value is non-collection bodies the skin cannot host; they already share
  the collapsible chrome.
- No user-composable sections — query nodes + the hosted "Save as tab" flow
  already own user-defined views.
- No op-log/model/wire change. Web-only, zero GTK/Flutter lockstep.
- Phase 2 does NOT turn render closures into read/query data. Placement as
  data, not a new rendering contract (pageVariant.ts's own boundary).

## Slice 1 — skin gaps (`CollectionSection` only, nothing converts)

New props:

- `action?: ReactNode` — NodeViewSection header create-affordance passthrough.
- `count?: number` — already feeds the unfiltered gate; ALSO sets the
  NodeViewSection header badge.
- `hideHeader?: boolean` — passthrough (the block-backlink card mounts
  BacklinksSection headerless).
- `refreshKey?: string` — `useSectionData` passthrough.
- `resolveOnMount?: boolean` — the Created contract (count IS the query):
  resolution runs from mount, not first expand. `useSectionData` active =
  `resolveOnMount || expanded`.
- `onFilterChange?: (query: FilterQuery) => void` — the skin owns the
  FilterQuery; hosts observe it (the live sort-flip: ranked quick text leads
  until the user picks a sort).

The hosted-toolbar composition moves INTO the skin: it builds NodeCollection's
render-prop `toolbarContent` as:

```
(setSlot) => [NodeCollectionToolbar (viewSaver wired when hostedViews is
              controlled: {client, nodeId, sectionKey, onSaved: onSelectTab})
            → ViewChromeSlot
            → host extras (collection.toolbarContent)]
```

The owner's bar register (viewChrome.tsx) then lives in exactly one place;
hosts stop hand-composing it. Uncontrolled hostedViews → no viewSaver
(current behavior preserved). The skin's own body-top `toolbarContent` prop
(un-hosted ViewToolbar idiom, e.g. Created) stays as-is.

## Slices 2–5 — one family per slice, 1:1 behavior preservation

- **Slice 2:** ExtendedBy + ChildPages + References. Header `action`/`count`
  land here (Add child page, member counts).
- **Slice 3:** Backlinks/Unlinked — trailingAction promote/ignore,
  `refreshKey` = joined ignore list, `groupByContainingPage` groups,
  `hideHeader` for the block-backlink card; eager self-gates become
  `count` + `hideWhenEmpty`.
- **Slice 4:** ClassedNodes (hardest): dynamic modes stay host-owned (host
  renders the switcher via skin extras), unassign trailingAction, the
  openMember ancestor-walk stays a host `onNodeClick` function, tableColumns
  from live bindings, groupByProperty from the first bound select.
- **Slice 5:** Created — `resolveOnMount`, `refreshKey` = `after|before`,
  hideWhenEmpty, ViewToolbar modes (un-hosted, body top).

Every existing section test stays green UNMODIFIED — they pin the behavior.
Delete only the wiring the skin now owns. Each conversion adds one assertion
that the section composes through CollectionSection (a data-attribute hook).

## Slice 6 (phase 2) — SectionSpec registry

A `sectionRegistry` module: every page section (collection-backed AND
bespoke) declared once as `{ key, render(ctx) }`; `pageVariant.ts`'s
`VariantSectionSpec` stacks become KEY LISTS
(`["child-pages", "backlinks", "unlinked-mentions"]`); `pageVariantOf`
composes stacks from the registry. The date-page ruling (omit unlinked)
becomes plain data. Registry tests pin the stacks per variant.

## Testing

- Slice 1: new skin-level tests (each new prop, viewSaver wiring, filter
  observation, resolve-on-mount, hosted toolbar order).
- Conversion slices: existing suites green + the compose-through-skin hook
  assertion.
- Slice 6: registry tests (stacks per variant, key presence).

## Risks

ClassedNodes carries the most bespoke wiring — isolated in its own slice.
The skin grows a prop surface; each addition must have a real consumer in
slices 2–5 or it doesn't ship (YAGNI).
