# UI Audit (re-run): Notees web app vs RosellRamos design system

Date: 2026-10-15 (second pass, same day) · Scope: `apps/web/src` full
surface inventory · Method: re-audit mode per the updated checklist — §0
evidence greps, verification of every finding in
`design-system-2026-10-15.md` against HEAD, then four parallel sweeps
(areas × surfaces, the new §5 Layout & grids dedicated sweep, §8–§10).
Checklist version: skill commit `47d4fee` (Layout & grids is §5; sections
renumbered; §0 walks areas × surface inventory).

Headline: **all 13 fixes from the first report verified at HEAD — nothing
regressed**. The deeper surface sweep (including the condensed stretchtext
layer landed mid-day by a parallel session) found no Criticals and one
cluster of Warning-class items, all closed in the same pass (slice noted in
CHANGELOG). Zero hardcoded hex outside the token file, zero legacy aliases,
zero `max-width` media syntax (CSS and, after this pass, the JS matchMedia
strings), the 4 allowlisted adaptive em sites only, drift gate 6/6 and the
appearance parity test green.

## Step 0 — prior findings verification: 13/13 VERIFIED

Every claim in the first report's Resolutions section confirmed in current
code (modal `radius="xl"`, panel shadows gone, transparent sidebar +
register entry, chip state layers, DataStateView delay gate, pressed states,
focus rings, touch floors, variables.css hygiene, appearance seam + parity
test, drift-gate check 6, residual grid fixes, range-syntax media queries).
Register carries 6 entries, newest-first per the contract.

## Findings closed in this pass (all WARNING class)

### §5 Layout & grids
- [x] `CardsView.css` — card title now single-line ellipsis (the recipe's
  clamp); the metadata line was already recipe-conformant (`--font-size-sm`
  is 12px — the sweep's 14px claim was an error). Card grid otherwise
  passes: token gap, adaptive `column-width`, raised container panel,
  `break-inside: avoid`, stable lazy-render size.
- [x] Cards board / outline / table / journals / trash / GridMenu /
  CollectionHub: PASS (grid sweep evidence in the session report).
  Board's fixed 260px columns and the GridMenu `--2/3/4` variants stay as
  Notes (owner-taste / unused API).

### §2–§7 semantic drift
- [x] Label-weight 500 → 600 cluster: TextField label, toast title,
  NodeSelector selected/create rows, settings feature-row titles.
- [x] Focus-ring kills with the stale "quiet focus (owner 2026-10-09)"
  comment removed at both surviving sites (IconPickerPopup, MetadataSection
  add-property popup) — the global `--shadow-focus-ring` applies, matching
  the Dropdown ruling.
- [x] IconPickerPopup: shell 12px → 8px floating tier; hover `scale(1.12)`
  → overlay (not in the tactile map).
- [x] NodeSelector rows: `--shape-small` corners inside the 8px panel,
  `:active` pressed layer, filter-pill remove gets the invisible floor.
- [x] NotificationToast: 8px floating radius, title 600, dismiss gets the
  floor overlay + pressed state.
- [x] In-process banner dismiss, PropertyIconButton base + popover rows,
  sync dot: pressed layers; sync dot gains hover/active chrome.
- [x] JS media-query strings normalized to range syntax
  (`App.tsx`, `FilterBar.tsx`; `overlay-hooks.ts` already builds its query
  from the `--breakpoint-tablet` token).

### Condensed layer (landed mid-day by a parallel session)
- [x] Row chrome (stretch / links badge / condense): `:active` pressed
  layer; the re-condense arrow reveals permanently under `(hover: none)`.
- [x] The 22px row-chrome tap floor registered as a deviation decision
  (`.agents/design-overrides.md`) — inline prose chrome cannot carry a 44px
  zone without breaking text selection; panels/bars/popovers keep the 44px
  floor and are expressly out of the entry's scope.
- [x] CondensedLinksPopup: root `onKeyDown` Escape (the sibling-popup
  convention — keyboard users can Esc out after Tabbing in) +
  `shadow-elevation-2` sibling parity.

## Carried forward (Notes — deliberately not changed)

- [ ] **Hover-fill idiom is three-way** (`hover-overlay` vs
  `surface-container-high` vs `surface-container-highest`) and
  **accent-container as hover background** appears on a few rows
  (`SettingsPage.css` settings-link, NodeSelector create rows,
  `NodeResultItem` filter suggestions). Needs ONE owner ruling before a
  cleanup pass — the fleet default should be the overlay; the filled read
  may be deliberate Notees density.
- [ ] `CardsBoard.css` magic layout numbers (260px columns, 120px/40px
  min-heights) — owner-taste board geometry; adaptive-form candidates.
- [ ] TopBar crowding at ≤768px (back/forward + focus + condensed + layout
  + undo + calendar + dock ≈ 350px of chrome) — flagged by arithmetic only;
  needs a visual check with real content.
- [ ] Calendar title button uses accent as hover *ink* — outside the accent
  usage table's MAY column; low impact.
- [ ] Export modal's selected-format state is icon-tint only — the quietest
  possible radio-card selected signal; consider a selected border.
- [ ] Minor px literals in content renderers (code-block paddings,
  cover-card fixed widths) — the drift gate's known non-color blind spot.

## Repository Hygiene — PASS

AGENTS.md defers + names the register (7 entries after this pass); drift
gate 6/6 + parity test run live and green; no new TS hex (only the
sanctioned PDF-export/preset bridges); no native dialogs; no paywalls;
name/copyright intact; bootstrap mirrors the resolver; no fleet-specific
hostnames in code. §0 evidence greps attached above (all zero / allowlisted).

## Surfaces swept (per the §0 inventory)

Shell (TopBar incl. the new condensed switch, Sidebar, sync chrome) ·
editor/block rows + condensed chrome · collections (CardsView grid,
CardsBoard, OutlineView, TableView, ListSortable, NodeResultItem,
JournalsView, TrashHub, GridMenu, CollectionHub) · overlays (Modal,
ContextMenu, Dropdown, CalendarPopup, ConfirmationModal,
CondensedLinksPopup, IconPickerPopup, HistoryMenuPopup, NodeHoverPreview) ·
forms (TextField, NodeSelector, ColorButton, settings controls,
MetadataSection) · feedback (DataStateView, EmptyState, LoadingSkeleton,
NotificationToast, BackendUnavailableOverlay, InProcessStoreBanner) ·
content renderers (code, embeds, covers/banners, export preview).
Not swept (stated): graph/whiteboard (audited in the first pass, unchanged),
presentation mode internals, CommandPalette internals, CalendarView grids,
activity/comments sections.
