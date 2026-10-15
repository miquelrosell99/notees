# Condensed layer — stretchtext as a view transform (Nelson, 1967)

**Date:** 2026-10-15
**Status:** owner directives received (2026-10-15); planning
**Scope:** `apps/web` only — `packages/domain` (one excerpt helper), `BlockRow`
(a condensed render branch; the prose-collapse companion change), the
outliner context (a stretched set), the nodeview top bar (a layer toggle).
**No protocol, store, sync, export, or other-client work** — pure view
transforms, the collapse/prose-mode precedent (`docs/ux.md` lines 56–57).
**Workspace:** own worktree `.worktrees/condensed-mode/` (parallel-session law)

## The feature

**Condensed is a layer over the existing view modes, not a view mode**
(owner ruling 2026-10-15) — the focus-mode pattern (a display toggle), not a
fourth switcher member. When the layer is on, every block in the page body
renders as its *excerpt* (its content flattened to one line, the same
derivation that powers breadcrumbs/table cells/search rows) instead of its
full content, whichever layout mode the body wears — outline, prose, or
cards. Clicking a block's excerpt **stretches it in place** to the full
content; the affordance flips to a **back arrow** at the end of the content
that re-condenses it. Nothing is stored: the excerpt is recomputed at
render, the layer and stretch states are device-local per page, the op log
never learns any of it (semantic-state vs device-state law).

Why a layer and not a mode: view mode answers *how the tree lays out*
(bullets vs flat vs grid); condensed answers *how much of each block's own
prose shows*. The axes are independent and commute — an enum of four would
force a false choice and lock out the most Nelson-like surface of all,
condensed **over prose** (a flat page of excerpts, the 1967 screen), which
the layer gets for free.

## Companion change: prose mode honors collapse (owner ruling 2026-10-15)

Shipped today: prose mode ignores collapse — "every subtree renders and no
collapse chevron shows" (`docs/ux.md` line 57). Owner ruling: **collapse is
honored in prose mode** — chevrons still show, and a collapsed block carries
a visible indicator. This makes the two view layers (collapse, condensed)
behave consistently across modes and lands in the same slice, with its own
docs + changelog updates:

- **Collapsed subtrees hide in prose**, exactly as in outline — collapse
  state is read, not ignored; flipping back to outline shows the same folds.
- **The chevron renders in prose mode**, start-anchored at the row (prose has
  no bullet gutter to ride): hover-revealed like the outline gutter idiom,
  and **persistent at rest while the block is collapsed** — the persistent
  chevron IS the collapsed indicator, and the hidden subtree is the other
  half of the read (nothing silently hidden).
- The **fold chords** (`Ctrl+.` / `Ctrl+Alt+←/→`) now act on the honored
  state in prose too. The **v1 indent-line gesture** stays outline-only
  (prose has no indent line — indents are flattened by definition).
- Distinct from the condensed layer's chrome: the collapse chevron/indicators
  speak for **children**; the "…"/back-arrow speak for the block's **own
  prose**. A block can be collapsed and condensed at once; both marks render.

## Owner directives (2026-10-15)

1. The stretch toggle is a clickable **"…" button at the end of the excerpt**,
   which turns into a **back arrow** for re-condensing (owner ruling: the
   back arrow sits at the **end of the block's own content**, not the first
   line — the reader re-condensing has just finished reading; and the toggle
   then marks the far edge of what is shown in both states).
2. **Links badge** (owner idea): a small badge button *next to* the "…"
   button carrying the **number of links hidden inside the condensed block**;
   clicking it opens a **popup listing the linked nodes**.
3. Multi-expand vs accordion left open by the owner — **this plan recommends
   multi-expand** (§4); owner can override to single-expand before build.
4. **Condensed is a layer on top of the view, not a view mode** (owner
   ruling) — it applies to outline and prose, and to cards too: "maybe even
   card view if you ask me."
5. **Collapse is not ignored in prose mode** (owner ruling, companion change
   above): chevrons still show, with an indicator on collapsed blocks.

## 1. The excerpt — one domain helper

`deriveDisplayName` (`packages/domain/src/node.ts:140`) already flattens to
"first text runs, one line, truncated" but returns only the sliced string.
The condensed layer needs three facts, so add a sibling helper (new
`packages/domain/src/excerpt.ts`, exported from the package index):

```ts
excerptOf(ast, resolveClassName?): {
  text: string;        // flattened prose, cut at first hard_break OR budget
  truncated: boolean;  // false → block fits one line; render full row, no toggle
  cutOffset: number;   // prose offset of the cut (0 when !truncated)
}
```

- Derivation reuses the exact token rules of `fullTitleOf` (text /
  typed_link / mention count `text`, chip counts its resolved label,
  hard_break is the line cut, `quote`/`heading` recurse, `math` counts its
  expression; `asset_ref` / `embed_ref` / `query` / `whiteboard` are
  prose-less). No second flatten grammar — one coordinate system, the
  `proseFromAst` law.
- Budget: first `hard_break` **or** `DISPLAY_NAME_MAX` (80), whichever comes
  first. Same cap as dense chrome for v1; a wider budget is a one-line
  change later.
- **Prose-less blocks never condense** — a block whose excerpt is empty
  renders as itself at full size under the layer (an image block, a query
  block, a code block, a whiteboard stay untouched). Nothing silently hidden.
- A mixed block (sentence + inline image) renders its excerpt text plus a
  quiet "⊞ image" chip appended; stretching reveals the full stream.
- **Dev-condition exports law**: rebuild the domain `dist` before typechecking
  the web app.

## 2. Stretch state — the collapse-set pattern, inverted

The collapse set (`apps/web/src/ui/outliner-context.ts:282`, localStorage
`notees.collapse.v1.<rootId>`, "view state only; children stay first-class
nodes") is the exact precedent. Add a sibling in the same module:

- `notees.stretched.v1.<rootId>` — the set of block ids **stretched full**
  while the layer is on (the default under the layer is excerpted, so the
  set stores the exceptions). Same persistence shape, same inert-id pruning
  (deleted blocks are inert), same never-an-op ruling.
- `OutlinerContext` gains `stretched: ReadonlySet<string>` and
  `toggleStretched(id)` beside `collapsed`/`toggleCollapse`
  (`outliner-context.ts:200-335`), so `BlockRow` reads both the same way.
- **Editing entry:** the condensed row is chrome, not the editable — one
  click stretches (the "…" click); the stretched row is the ordinary row,
  so the second click enters edit per the standard contract. Blur
  leaves the block stretched (it re-condenses only via the back arrow or
  condense-all). No caret can ever sit inside a derived projection.

## 3. BlockRow — the condensed branch and the prose-collapse change

`apps/web/src/ui/BlockRow.tsx` gains a condensed render branch (the prose
transform at `BlockRow.tsx:115` is the structural precedent) and loses the
prose-ignores-collapse special case. The condensed branch fires only when
the hosting surface has the layer on — it is an **explicit opt-in**, not a
BlockRow default, so surfaces that must render full content (presentation
deck, embedded feeds, exports, shares, read-only twins) are untouched by
construction:

- **Layer on + not stretched + truncatable** → the excerpt row: one line,
  text-only, mentions/verbs rendered as resolved plain text (read-mode rule:
  the resting excerpt carries no pill chrome; double-click opens the target
  as everywhere in read mode). Trailing chrome, revealed with the row:
  - the **"…" button** (quiet, keyboard-focusable, `title` idiom
    "Show full content") — click stretches.
  - the **links badge** (§5) when hidden-link count > 0.
- **Layer on + stretched** → the ordinary full row **plus** the back-arrow
  affordance at the END of the block's own content (owner ruling): quiet
  icon button, `title` "Condense", click re-condenses. **End = the block's
  own content row, before its children** — children are the collapse
  chevron's concern; the stretch toggle owns only the block's own prose.
  The row is otherwise indistinguishable from the same row without the
  layer — same editor, same chrome, same gestures.
- **Layer on + (prose-less | !truncated | editing)** → ordinary full row,
  no toggle (a one-line block is its own excerpt).
- **Per hosting mode:**
  - **Outline** — the baseline: excerpt rows carry the normal bullet/
    indentation chrome; the ghost block, drag, multi-select, and the fold
    chords behave exactly as today.
  - **Prose** — the layer's most Nelson-like surface: excerpts render
    flat, bullet-less, the prose-mode transform applied *over* the
    condensed rows. Collapse is honored here too (companion change): the
    chevron start-anchors the row, hover-revealed, persistent when
    collapsed. Stretching a row grows it in place inside the flat flow.
  - **Cards** — inside a card's content row (read-only by contract),
    child blocks render condensed and stretch as **display-only growth**:
    no edit entry (the outline is the editing surface), the card grows in
    the grid and the masonry reflows. The title header and the card's
    properties/classes rows never condense — the layer owns block prose
    only. Collapse in cards' content rows keeps today's behavior (cards
    content already rides a collapse chrome — no change there).
- Children, the backlink gutter, property icons — untouched. Collapse and
  stretch stay orthogonal: fold hides the subtree, stretch reveals the
  block's own prose; both compose on the same row.
- Kit law: the "…"/back-arrow/badge and the prose chevron variant are
  composed from `ui/components/ui/` primitives (quiet icon-button +
  count-pill pattern) — token-only CSS, adaptive values; a new primitive
  file only if the catalog genuinely lacks the piece.

## 4. Multi-expand (recommended) + condense-all

**Recommendation: multi-expand**, with a condense-all reset. Reasons:

1. An accordion's layout jumps displace the text you're reading — expand
   block A, block B you were comparing against scrolls away. Scroll
   anchoring around in-place growth is fiddly; not jumping is free.
2. Comparing two passages side by side is a real reading pattern; single
   expand forbids it.
3. The collapse set is already multi — users hold that mental model for
   "which rows are open".
4. The cost multi adds over single is exactly one affordance (condense-all),
   which is worth having anyway.

Condense-all: when the layer is on and the stretched set is non-empty, the
nodeview top bar (beside the layer toggle, the quiet-ghost idiom) shows a
**condense-all** icon button that clears the set. Disabled/hidden when the
set is empty — no dead chrome.

(Owner override path: single-expand is `toggleStretched` clearing the rest of
the set on each stretch. Cheap to switch, worse to use — recommend against.)

## 5. The links badge and its popup

**What counts.** A *hidden link* is a **mention token** whose prose span
starts at or after the excerpt's `cutOffset` — computed from the same
`proseSpans` projection the editor rides (a mention straddling the cut is
visible, so it counts as visible). Typed-link marks are excluded — they are
targetless today (target resolution is the deferred design; the badge must
never imply a link the graph can't resolve). Class chips are render-only by
decree — excluded. The badge therefore names exactly one honest thing:
*"this condensed block mentions N nodes you can't see."*

**The badge.** A small quiet count pill riding beside the "…" button at the
end of the excerpt row. Renders only when count > 0 (no dead chrome).
`title` idiom: "N hidden links".

**The popup.** Clicking the badge opens a bounded popup listing the hidden
linked nodes:

- Row: the target's resolved display name; a **block** target is labeled
  with its containing page (the `@` picker convention — `Main/Blocks` rows,
  `apps/web/src/ui` picker chrome reuses rather than reinvents).
- **Click a row → open the node** (the ordinary open gesture). No navigation
  surprises: opening does not stretch the block (the list is the discovery
  surface; the "…" remains the stretch surface — one surface per action).
- Dismissal: **the one convention** (`docs/ux.md` "Popups") — Esc and
  outside-click close; pressing inside never dismisses.
- The popup is a bounded-scroll surface (pickers stay bounded by typing;
  this list has no search in v1 — a block hiding dozens of mentions is rare;
  if it happens the scroll is honest and the count is named).

## 6. Layer plumbing — toggle, persistence, scoping

- **No `ViewMode` change.** The outline/prose/cards union and the per-page
  `viewMode.nodeBlocks.<pageId>` pref are untouched — layout and detail are
  separate axes, each persisted honestly.
- **The toggle** is a quiet icon button in the nodeview top bar beside the
  view switcher (the focus-mode precedent, a display toggle): engaged state
  wears the accent highlight like every engagement surface; `title`
  idiom "Condensed". Toggling off restores the body's ordinary rendering
  and hides the per-block chrome; the stretched set is left intact (it is
  inert while the layer is off, exactly like the collapse set is inert
  where a surface ignores it).
- **Persistence:** per page, device setting `condensed.<pageId>` through
  the `viewPrefs`/`deviceSettings` seam — same device-local, never-synced
  ruling as the view modes.
- **Scoping — where the layer is offered:** the page body only. The toggle
  renders on the page body's nodeview bar; the BlockRow branch keys off an
  explicit opt-in from that surface. The presentation deck, embedded feeds
  (journal, calendar day pages), read-only list/card projections, tables,
  the classed-nodes collection, and every export/share surface render full
  content exactly as today — the layer never reaches them.
- **Cards nuance:** the cards body *is* an offered surface (the body's mode
  may be cards), so card content rows condense under the layer per §3 —
  but the toggle itself stays on the nodeview bar; there is no per-card
  condensed switch (per-card view state that could drift from the surface
  is the drift the design law refuses).

## 7. Interactions and honest edges

- **Rename/edit:** excerpts re-derive at render — an edit updates every
  resting block for free (names-are-projections law at block level).
- **Layer off → on:** the stretched set answers immediately (localStorage,
  per page) — stretching survives a layer toggle and a reload, like the
  folds do.
- **Mode switch under the layer** (outline ↔ prose ↔ cards): the layer
  stays on; each mode renders its condensed variant per §3. Switching the
  mode never clears the stretched set or the collapse set — prose now
  honors the folds (companion change), so outline → prose → outline is a
  round trip with nothing lost.
- **Collapse × condensed in prose:** both layers apply — a block can be
  folded (children hidden, persistent chevron) and condensed (own prose
  excerpted, "…" at the end) at once. Two marks, two concerns, one row.
- **Presentation mode, exports, shares, print:** all render the full tree
  through the ordinary projections — neither layer touches them (device
  view state, the presentation-mode ruling).
- **Date pages:** nothing special; the date-header contract is untouched.
- **Ghost block** stays the sole add affordance and behaves as today (it
  never condenses — it is chrome, not content).
- **Keyboard:** no new chord in v1 — the layer toggle and the "…"/back-arrow/
  badge buttons are real focusable controls (tab-reachable), per the
  honest-affordance law. A chord (e.g. reusing `Ctrl+.` to mean "toggle
  condensed visibility of the focused block" while the layer is on) is a
  designed follow-up, not v1.

## 8. Out of scope (deliberately)

- **Authored alternates** (option 2 of the stretchtext analysis — a `stretch`
  content token with N authored versions). The excerpt is always the head of
  the real content. Deferred until real usage demands alternates the excerpt
  can't serve; a wire token would trigger the fixture gate + GTK/Flutter
  lockstep, and the design law argues against predicting that usage.
- **Stretch-into-children** — collapse owns "the subtree is hidden detail";
  two expansion semantics on one tree would be drift by construction.
- **A document-wide detail dial** — per-block state composes with collapse
  and survives reloads; a dial would fight both. Condense-all is the batch
  operation, not a mode.
- **Per-card or per-section condensed switches** — the layer is one
  surface-level toggle; per-widget view state is the drift the design law
  refuses.
- Search-inside-the-badge-popup, typed links in the badge count, mobile
  shell specifics (the buttons are touch-floor-sized per the narrow-screen
  law and need nothing else).

## 9. Verification and ship

1. Own worktree `.worktrees/condensed-mode/` (`main` base, own install, own
   gate); detect parallel sessions first (`git status --porcelain`,
   `git worktree list`, `.git/index.lock`, `docker compose ps`).
2. `pnpm install && pnpm typecheck && pnpm test` — all green, blocking.
   (Domain dist rebuilt after the `excerptOf` export — dev-condition law.)
3. Manual smoke in the test workspace (`c491595f-9f94-5ade-a620-e30ed063d8d2`
   — never the personal default): a page with long blocks, mentions beyond
   the cut, image blocks, code blocks; layer on/off; stretch/re-condense/
   condense-all; badge popup open/dismiss; persistence across reload; edit
   entry and blur — then the same page in prose mode (flat excerpts, fold
   honored, chevron + persistent collapsed indicator) and cards mode
   (display-only growth, no edit entry).
4. Docs in the same pass: `docs/ux.md` (feature table → Today rows for the
   layer and the prose-collapse change; the outliner table's prose row and
   collapse row rewritten; the view-modes ruling notes the layer axis), and
   the `docs/developers/ui-primitives.md` catalog if a new kit piece lands.
5. `CHANGELOG.md` — two entries: the prose-collapse ruling change and the
   condensed layer (each: what shipped + verification).
6. Commit (per-file staging, Conventional Commits) + push; land per the
   worktree law; redeploy `notees-web` scoped + `verify-min.mjs` smoke —
   **invoke the `notees-operations` skill first** (redeploy-what-you-ship law).
