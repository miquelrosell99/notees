# The Notees interaction model

How Notees feels to use: the views, the outliner, the sections, the marks, the whiteboards, and the gestures. The normative specs behind each section live in [packages/protocol/SCHEMA.md](../packages/protocol/SCHEMA.md) and [.plans/design/01-knowledge-model.md](../.plans/design/01-knowledge-model.md); the ideas are in [philosophy.md](philosophy.md); what you can run today is in [usage.md](usage.md).

M1 alpha honesty, up front — every feature below is labeled:

| Feature | State |
|---|---|
| Page view with block-tree rendering | **Today** (interactive: edit, reorder, collapse) |
| Content-token rendering (marks, mentions, chips, typed-link display) | **Today** (marks editing + capture gestures ship; see the outliner section) |
| Backlinks as data (API, CLI, web client) | **Today** (direct + source-side containment roll-up with "in <page>" context) |
| Promotion/demotion | **Today** (CLI/API; in-editor gesture designed) |
| Class view, focused block view | Class View **Today** (editable property bindings with defaults); focused block view Designed (a block opens by zooming its page today) |
| Interactive outliner: text core | **Today** (typing, Enter/shift+Enter/Backspace, Tab indent / shift+Tab outdent, Enter sibling placement) |
| Outliner: marks editing, collapse, prose mode, drag reorder | **Today** |
| System sections UI with the lazy-loading contract | **Today** (page-level: linked references, unlinked references, child pages; classed-nodes section ships in Class View); block-level gutter toggle Designed |
| Capture gestures: `@` mentions, `#` tags, `+` classes, verb-on-selection | **Today** (free-string verbs; bound-schema verbs + target resolution Designed) |
| Embeds (live subtree transclusion) | **Today** (read-only projection, cycle-guarded) |
| Whiteboards (spatial canvas) | **Today** (pan/zoom, cards as child blocks, shapes/strokes, embedded mode) |
| Citations: source family, BibTeX/CSL round-trip | **Today** (`notees import/export bibtex`; text authors + explicit `linkedAuthors` person links) |
| Sources as containers (files via `attachments`, notes as child blocks) | **Today** (picker + upload in the properties panel) |
| Class-property defaults (derived read model, first-applied-wins) | **Today** (bindings editor + effective-properties API) |

## Views follow node_type

View resolution is a pure function of one column — `node_type ∈ {page, block, class}` decides what you see. There is no per-node view setting that could drift from what the node is ([philosophy.md](philosophy.md) on why that matters).

- **`page` → Page View.** Header (icon, name), then the body block list, then system sections. A page's *content is its bullet tree* — there is no separate document body.
- **`block` → Focused Block View.** A block zoomed to center stage: its content, its children, its backlinks, its properties. The outliner's "zoom into a bullet" from Logseq, generalized to any node.
- **`class` → Class View.** Page chrome plus configuration: the property-bindings editor, the `extends`/inheritance section, the classed-nodes section (the members — the Meetings pattern: content *about* instances lives in topic pages; the class page shows config + members), a template slot, and a description shelf documenting the config itself.

Two placement rules complete the picture. **Nested pages keep `node_type='page'`** — a child page opens in Page View and renders in its parent's dedicated **Child pages** section, never inline in the parent's body. And class nodes are tree-external by construction: a class can never be a parent or a child, enforced by schema and by a fail-loud move-guard.

**Today:** the web app renders Page View (interactive) and Class View (view resolution is `f(node_type)`); a block is reached by zooming its page, and the class catalog is inspectable via `notees class list` and `GET /api/v1/classes` ([usage.md](usage.md)). Focused Block View as a standalone chrome remains designed.

## The outliner

The editor is a Logseq-style outliner: bullet points, and each bullet is a block is a node. The core contract:

| Gesture | Effect |
|---|---|
| `Enter` mid-text | **Splits the block at the caret** — the head stays, the tail moves to a new sibling right after. |
| `Enter` at the start | A new empty block **before** this one. |
| `Enter` at the end | A sibling after — unless the block has children, in which case the new block becomes their **first child**. |
| `Shift+Enter` | A `hard_break` — a line jump *inside* the block. The only break token in the grammar. |
| `Backspace` at the start of text | **Merges this block into the previous one** (previous sibling, or the parent when this is an only child — otherwise nothing). The unflushed draft rides along. |
| `Backspace` on an empty block with children | The children are **promoted** into the block's place, then the block is deleted. |
| `Delete` at the end | Merges a childless next sibling into this block. |
| Indent / outdent | `Tab` indents under the previous sibling; `Shift+Tab` outdents to the grandparent right after its parent. The outdent **behavior setting** (Settings → Editor) chooses Direct (only the block moves) or Logical (default — subsequent siblings follow under the outdented block, preserving category grouping). |
| Drag | Reorders among siblings (fractional positions + TreeCrdt — proven v1 machinery, ported). |
| Collapse / expand | View state only; children stay first-class nodes. |
| Prose mode | Bullets hidden, indents flattened — a **view transform, not content**. Flip back and nothing changed. |
| `Ctrl/Cmd+C` with no selection | Copies that block's node link (`<origin>/<uuid>`) — same in a page title. With a text selection, the browser's text copy runs as usual. |
| `Ctrl/Cmd+V` holding a node link | Pastes the link as a **mention** at the caret (in a title: as the target's display text) instead of raw text; any other clipboard text pastes normally. Both directions toast a confirmation. |
| `@` with a selection | The selection survives: the node picker opens **with the selected text as its search query**, and confirming (or creating) replaces the selection with the link. `Ctrl/Cmd+Enter` on a row inserts the link with the selected text kept as a custom label; Esc hands the selection back untouched. |
| Right-click a node link | A context menu: **Open** / **Open in sidebar**, **Edit link…** (retarget the link, set or edit an optional custom label), **Remove link** (unlink, keeping the text — or the custom label when one is set), **Delete link** (removes the link from the block entirely). |

Long-form writing emerges from nesting bullets, not from a document mode. That is a deliberate bet — the confident statement is: structure you got for free beats structure you typed as metadata.

Blocks are first-class storage but second-class display. Display defaults keep them quiet: backlinks aggregate mentions per containing page, the graph collapses children, search ranks root pages first with block hits nested beneath their parents, and queries default to root scope. When a bullet matters enough to stand alone, you promote it — see [Promotion and demotion](#promotion-and-demotion).

**Today:** the web app ships the full outliner interaction set — the text core (typing with debounced saves, Enter placing a new sibling right after the current block, Shift+Enter hard breaks, Backspace delete, Tab / Shift+Tab reparenting via `object.move` with fractional sibling-midpoint ordering), **marks editing** (structural edits preserve untouched runs; selection toolbar + Ctrl/Cmd+B/I/Shift+X + `**`-wrap), **node-link clipboard** (Ctrl/Cmd+C on a block or page title with no selection copies `<origin>/<uuid>`; pasting that link — or a bare uuid — splices a mention at the caret, both with a toast confirmation), **link authoring from selection** (typing `@` over selected text opens the picker with that text as the query; the pick replaces the selection, Ctrl/Cmd+Enter keeps it as a custom label), **node-link context menu** (right-click a link: edit destination + custom label, remove the link keeping the text, or delete it outright), **collapse** (chevron per block, session-local), **prose mode** (a pure view transform: bullets hidden, indents flattened), and **drag reorder** (dnd-kit, deep-drop to reparent, guard-railed against cycles and CHECK violations). Still designed: editing-through-embeds, the tablet shell ([.plans/2026-09-24-object-graph-pim-evolution/assessment.md](../.plans/2026-09-24-object-graph-pim-evolution/assessment.md) §34.16.4), and bound-schema verbs.

## System sections — and the lazy-loading contract

Pages come with predefined sections that are **named system queries** over the query runtime, not bespoke UI: **linked references**, **unlinked references**, **child pages**, **classed nodes**, and **extended-by**. They ship as fixtures like any op type, and the section registry becomes plugin-extensible later.

The rules, all of them load-bearing for performance:

- **Collapsed by default, and a collapsed section runs no query at all.** Nothing loads until the first expand.
- **Count badges come only from materialized counts** (`node_stats.backlink_count`) — the badge renders unconditionally and is exempt from the contract because reading it is reading a stored number, not running a query.
- **Unlinked references shows no eager count.** Computing it *is* the expensive query — it is a full-text search for the page's literal name across the workspace, excluding blocks that already link to the page. Pages only; blocks do not get this section.
- **Results cache** per section until an invalidating notification lands (a content, class, or property edge change).
- **Blocks get backlinks in place.** A block with backlinks shows a count badge in the right gutter; toggling it expands the linked-references query scoped to that block, inline beneath it — the query runs on first toggle, per the contract.

Backlinks list *actual* links — but the backlinks view can be narrowed by facets over inherited links: Jane's backlinks filtered to `refset ∋ ACME` shows only the Jane-mentions made in the context of ACME, even when the ACME link lives on a parent block (Logseq's linked-references filtering, generalized — see [philosophy.md](philosophy.md#what-we-took--and-the-wounds-that-became-our-rules)).

**Today:** the page-level sections ship in the web client — linked references (badge from the materialized `node_stats.backlink_count`), unlinked references (pages only, no eager count: an FTS over the page's name excluding already-linked sources), and child pages. All are collapsed by default and run no query until first expand; an expanded section re-runs its query when a notification lands and caches until then. The block-level right-gutter backlink toggle is designed (it arrives with the focused-block surface), and the classed-nodes section ships with the Class View.

## Mentions, chips, and typed links — marks on words

All three are tokens in the same flat content stream ([SCHEMA.md grammar](../packages/protocol/SCHEMA.md)), and all three obey the same rule: **nothing is inserted; the word you wrote is the annotation.**

- **Mention** — a pill. Stores the target's id plus the captured surface form; rendering resolves the *current* name, so renaming a node updates every mention for free. An optional `displayText` overrides per-link ("the Republic"). A broken target renders the raw id — never silent retargeting. In the editor the pill is an **atom** — one caret unit with the read-mode underline look: arrows select it when the caret reaches it, Backspace/Delete deletes it whole (selected or adjacent), right-click edits/unlinks/deletes it in every view mode.
- **Class chip** — render-only, by decision. Inserting a chip does not assign the class; it references the class node and renders its current name. Assignment is a separate gesture, and a lint may suggest it ("chip present, node not classed — assign?"). Suggestion, never enforcement.
- **Typed link** — the distinctive one. You write the sentence naturally ("argument X *contradicts* argument Y"); the verb is a **mark on the word**, with an optional target and token metadata such as a locator. Rendering is a subtle colored underline with a hover card, plus a global "show types" overlay (off by default in reading mode). Lifecycle is honest: delete the word and the mark dies with it — the graph stops claiming what the sentence no longer claims. The verb is a property-schema reference *or a bare free string*; when the verb you want doesn't exist yet, **create-and-bind** makes the schema at capture time (the Tana lesson: schema-at-capture or the feature dies in setup). The adorned mention pill survives only as the escape hatch for when there is no natural verb ("see <<Y>>").

**Record, don't resolve.** Capture records candidate target spans as an ordered list — implemented as the `targetNodeId`s of the block's mention tokens, nearest-first by prose distance from the mark, capped at 8 (the flat grammar has no token ids; this interpretation is recorded in SCHEMA.md). No scoring, no filtering. Target resolution lands in M2, designed against real captured data.

Citations are the canonical dogfood: a `cites` verb with the locator auto-filled from the current PDF selection, grouped backlinks by verb, bibliography views — the M2 research environment.

**Today:** the capture gestures ship in the web editor — `@` opens the node picker (mentions), `#` opens tag vocabulary (**Enter assigns the tag-class to the node, creating it if missing; Shift+Enter inserts a render-only chip inline**), `+` picks existing classes with the same assign/insert split, and a selection + Cmd/Ctrl+K (or the toolbar verb button) binds a free-string verb with an optional locator. Rendering resolves names everywhere. Still designed: bound-schema verbs with create-and-bind, locator autofill from PDF selections, M2 target resolution.

## Whiteboards — spatial views of subtrees

A whiteboard is a node classed `whiteboard`; the `whiteboard` content token carries its geometry. The model, precisely:

- **Cards are child blocks.** Full content grammar, backlinks, search indexing, focused view, classing — a card is a block that happens to have `x, y, w, h`. The tree holds content; the token holds geometry, keyed by node id.
- **Shapes are geometry only.** Rectangles, circles, connectors, freehand strokes — layout-token data with no identity and no node overhead.
- **Semantic text lives in cards, not shape labels.** A label is chrome; text that matters to the graph gets a card. A lint may suggest promoting a label to a card — the design law's usual enforcement.
- **Dragging a card is a layout update** — debounced and coalesced into ordinary content ops. No per-mousemove op spam, no new sync primitive.
- **One node, three views.** The same children render spatially (the whiteboard), as an outline (the outliner), or focused (Focused Block View) — because they are the same nodes.

A whiteboard can live fullscreen (`node_type='page'`) or embedded as a child block of any block. Its cards index into search and the graph naturally — no separate "whiteboard content" that search can't see.

**Today:** the `whiteboard` class is seeded in the catalog, the token is part of the normative grammar, and the web renderer shows a labeled placeholder where a whiteboard will render. The spatial canvas is designed.

## Promotion and demotion

A bullet's prominence is soft state — one op flips it, and identity is preserved completely.

- **Block → page:** a bullet that outgrew its parent becomes a page in place. Same node, same id, every link intact; recents, search ranking, and the link dropdown pick it up automatically because they rank pages first — no re-filing, no copy.
- **Page → block:** demote a page back into the flow of another note; same in-place flip.
- **Declare a class:** set `node_type='class'` on a node. It leaves the content tree (tree-external by schema), gains the Class View and configuration; undeclaring returns it to an ordinary note with inert config. Declaration-first: create classes, configure them, use them later or never.

The canonical story: a `meeting`-classed bullet in a daily note sits quietly for months. When it starts to matter, promote it — flip `node_type` to `page`, optionally nest it under the company page. Same node, same id, all links intact.

**Today:** the flip is real and works from the CLI and object API (`notees object update <id> --nodeType page` — verified in [usage.md](usage.md#a-real-session)). The in-editor gesture, recents/dropdown re-ranking, and the class-declaration flow are designed.

---

Where to next: [usage.md](usage.md) for running all of this, [philosophy.md](philosophy.md) for why it is built this way, [README.md](../README.md) for the front door.
