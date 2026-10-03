# The Notees interaction model

How Notees feels to use: the views, the outliner, the sections, the marks, the whiteboards, the decks, and the gestures. The normative specs behind each section live in [packages/protocol/SCHEMA.md](../packages/protocol/SCHEMA.md) and [.plans/design/01-knowledge-model.md](../.plans/design/01-knowledge-model.md); the ideas are in [philosophy.md](philosophy.md); what you can run today is in [usage.md](usage.md).

M1 alpha honesty, up front — every feature below is labeled:

| Feature | State |
|---|---|
| Page view with block-tree rendering | **Today** (interactive: edit, reorder, collapse) |
| Content-token rendering (marks, mentions, chips, typed-link display) | **Today** (marks editing + capture gestures ship; see the outliner section) |
| Backlinks as data (API, CLI, web client) | **Today** (direct + source-side containment roll-up with "in <page>" context) |
| Promotion/demotion | **Today** (CLI/API; in-editor gesture designed) |
| Class view, focused block view | Class View **Today** (a class page is a page: editable body + extends pills, instances table, property definitions, template cards); focused block view Designed (a block opens by zooming its page today) |
| Interactive outliner: text core | **Today** (typing, Enter/shift+Enter/Backspace, Tab indent / shift+Tab outdent, Enter sibling placement) |
| Outliner: marks editing, collapse, prose mode, drag reorder | **Today** |
| System sections UI with the lazy-loading contract | **Today** (page-level: linked references, unlinked references, child pages; classed-nodes section ships in Class View); block-level gutter toggle Designed |
| Capture gestures: `@` mentions, `#` tags, `+` classes, verb-on-selection | **Today** (free-string verbs; bound-schema verbs + target resolution Designed) |
| Embeds (live subtree transclusion) | **Today** (read-only projection, cycle-guarded) |
| Whiteboards (spatial canvas) | **Today** (pan/zoom, cards as child blocks, shapes/strokes, embedded mode) |
| Citations: source family, BibTeX/CSL round-trip | **Today** (`notees import/export bibtex`; text authors + explicit `linkedAuthors` person links) |
| Sources as containers (files via `attachments`, notes as child blocks) | **Today** (picker + upload in the properties panel) |
| Class-property defaults (derived read model, first-applied-wins) | **Today** (bindings editor + effective-properties API) |
| Export (pages, nodes, workspaces) | **Today** (Markdown/HTML/Word/LaTeX serializers + in-browser PDF with three layouts and A4/Letter; per-format options, live preview for Markdown+PDF, single files and batch/asset zips, full-workspace zip with manifest) |

## Views follow the render state

View resolution is a pure function of two booleans and one edge — `is_class` (identity) × `parent_id` (placement) × `present_as_main` (render bit) decides what you see. There is no per-node view setting that could drift from what the node is ([philosophy.md](philosophy.md) on why that matters).

- **`page` → Page View.** A node presents as a page when it has no parent or when its render bit is set: header (icon, title), then the body block list, then system sections. A page's *content is its bullet tree* — there is no separate document body.
- **`block` → inline body, zoomable to Focused Block View.** A parented node with the render bit unset renders inline in its parent's body with block chrome; zoomed to center stage it is its content, its children, its backlinks, its properties — the outliner's "zoom into a bullet" from Logseq, generalized to any node.
- **`class` → Class View.** A node marked as a class (always a root) gets the **page view itself** — same chrome, same editable bullet-tree body (classes are containers and can hold child blocks) — plus class-relevant sections: the **extends** pills pinned to the card's top-left corner (the parent classes, picked from a class-only selector; cycles fail loud), the **classed nodes** table (the members — one column per property definition, table by default, outline/cards/kanban switchable; the class page's centerpiece, the Capacities/Tana lesson: instances are the page), the **property definitions** editor (one row per binding — drag to reorder, flag toggles for required/readonly/hide-when-empty, a config panel per row; expanded while empty, then collapsed like the page's Properties section), and the **templates** cards (bound instantiation templates, §-below). The class's color and curated icon live in the header (one dot opens the picker; the swatch strip is gone). Below the body, the standard system sections plus **Extended by** (the subclasses, transitive — a backlink-class read). There is no separate description shelf: title-is-content means the class's title IS its description.

Two placement rules complete the picture. **Nested pages have the render bit set** — a child page opens in Page View and renders in its parent's dedicated **Child pages** (main-children) zone, never inline in the parent's body. And class nodes are always roots by construction — `is_class` implies no parent, enforced by a schema CHECK and a fail-loud move-guard. Classes may themselves have non-class children; the one tree rule left is that a class can never be a child.

Icons are *effective*, never required. A node displays its own icon when one is set; otherwise the first assigned class's icon (in class order, inherited through the class's `extends` chain); otherwise a display-time default — a shape glyph for classes, a document glyph for pages. The default is read-side only: nothing is written to the node until you pick an icon, and inline blocks stay iconless (their chrome is the bullet dot).

**Today:** the web app renders Page View (interactive) and Class View (view resolution is the `is_class`/`parent_id`/`present_as_main` cascade); a block is reached by zooming its page, and the class catalog is inspectable via `notees class list` and `GET /api/classes` ([usage.md](usage.md)). Focused Block View as a standalone chrome remains designed.

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
| Prose mode | Bullets hidden, indents flattened — a **view transform, not content**. Collapse state is ignored, not cleared: every subtree renders and no collapse chevron shows; flip back and nothing changed. |
| `Ctrl/Cmd+C` with no selection | Copies that block's node link (`<origin>/<uuid>`) — same in a page title. With a text selection, the browser's text copy runs as usual. |
| `Ctrl/Cmd+V` holding a node link | Pastes the link as a **mention** at the caret (in a title: as the target's display text) instead of raw text; any other clipboard text pastes normally. Both directions toast a confirmation. |
| `@` with a selection | The selection survives: the node picker opens **with the selected text as its search query**, and confirming (or creating) replaces the selection with the link. `Ctrl/Cmd+Enter` on a row inserts the link with the selected text kept as a custom label; Esc hands the selection back untouched. |
| Right-click a node link | A context menu: **Open** / **Open in sidebar**, **Edit link…** (retarget the link, set or edit an optional custom label), **Remove link** (unlink, keeping the text — or the custom label when one is set), **Delete link** (removes the link from the block entirely). |

Long-form writing emerges from nesting bullets, not from a document mode. That is a deliberate bet — the confident statement is: structure you got for free beats structure you typed as metadata.

Blocks are first-class storage but second-class display. Display defaults keep them quiet: backlinks aggregate mentions per containing page, the graph collapses children, search ranks root pages first with block hits nested beneath their parents, and queries default to root scope. When a bullet matters enough to stand alone, you promote it — see [Promotion and demotion](#promotion-and-demotion).

**Today:** the web app ships the full outliner interaction set — the text core (typing with debounced saves, the editable filling the row so clicking anywhere places the caret, Enter placing a new sibling right after the current block, Shift+Enter hard breaks, Backspace delete, Tab / Shift+Tab reparenting via `object.move` with fractional sibling-midpoint ordering), **marks editing** (structural edits preserve untouched runs; selection toolbar + Ctrl/Cmd+B/I/Shift+X + `**`-wrap), **node-link clipboard** (Ctrl/Cmd+C on a block or page title with no selection copies `<origin>/<uuid>`; pasting that link — or a bare uuid — splices a mention at the caret, both with a toast confirmation), **link authoring from selection** (typing `@` over selected text opens the picker with that text as the query; the pick replaces the selection, Ctrl/Cmd+Enter keeps it as a custom label), **node-link context menu** (right-click a link: edit destination + custom label, remove the link keeping the text, or delete it outright), **collapse** (chevron per block, session-local), **prose mode** (a pure view transform: bullets hidden, indents flattened; collapse state ignored — every subtree renders and no chevron shows, the session collapse set untouched for the return to outline), and **drag reorder** (dnd-kit, deep-drop to reparent, guard-railed against cycles and CHECK violations). Still designed: editing-through-embeds, the tablet shell ([.plans/implementation-plan.md](../.plans/implementation-plan.md) §34.16.4), and bound-schema verbs.

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

- **Mention** — a pill. Stores the target's id plus the captured surface form; rendering resolves the *current* name, so renaming a node updates every mention for free. An optional `displayText` overrides per-link ("the Republic"). A broken target renders the raw id — never silent retargeting. In the editor the pill is an **atom** — one caret unit with the read-mode underline look: arrows select it when the caret reaches it (selected = primary-colored text on a faint primary tint inside a focus-ring outline), clicking it selects (a second click hands the caret back, double-click opens), Backspace/Delete deletes it whole (selected or adjacent), right-click edits/unlinks/deletes it in every view mode.
- **Class chip** — render-only, by decision. Inserting a chip does not assign the class; it references the class node and renders its current name. Assignment is a separate gesture, and a lint may suggest it ("chip present, node not classed — assign?"). Suggestion, never enforcement.
- **Typed link** — the distinctive one. You write the sentence naturally ("argument X *contradicts* argument Y"); the verb is a **mark on the word**, with an optional target and token metadata such as a locator. Rendering is a subtle colored underline with a hover card, plus a global "show types" overlay (off by default in reading mode). Lifecycle is honest: delete the word and the mark dies with it — the graph stops claiming what the sentence no longer claims. The verb is a property-schema reference *or a bare free string*; when the verb you want doesn't exist yet, **create-and-bind** makes the schema at capture time (the Tana lesson: schema-at-capture or the feature dies in setup). The adorned mention pill survives only as the escape hatch for when there is no natural verb ("see <<Y>>").

**Record, don't resolve.** Capture records candidate target spans as an ordered list — implemented as the `targetNodeId`s of the block's mention tokens, nearest-first by prose distance from the mark, capped at 8 (the flat grammar has no token ids; this interpretation is recorded in SCHEMA.md). No scoring, no filtering. Target resolution lands in M2, designed against real captured data.

Citations are the canonical dogfood: a `cites` verb with the locator auto-filled from the current PDF selection, grouped backlinks by verb, bibliography views — the M2 research environment.

**Today:** the capture gestures ship in the web editor — `@` opens the node picker (mentions) with the caret already in its search field, scoped by **Main/Blocks tabs**: Main (the default) searches pages, classes, and other document-chrome nodes; Blocks narrows the same search to inline child blocks. Typed dates offer **"Link to daily page: …"** (or "Create …" when the journal page doesn't exist yet). `#` opens tag vocabulary (**Enter assigns the tag-class to the node, creating it if missing; Shift+Enter inserts a render-only chip inline**), `+` picks existing classes with the same assign/insert split, and a selection + Cmd/Ctrl+K (or the toolbar verb button) binds a free-string verb with an optional locator. Rendering resolves names everywhere. Still designed: bound-schema verbs with create-and-bind, locator autofill from PDF selections, M2 target resolution.

## Templates — class-bound instantiation

A template is a node, not a new kind: the `template` class says "this node's subtree is a reusable body". Binding is a property edge (the class's **Templates** cards); instantiation is a client-side clone over ordinary single-node ops — the copy is stamped with a `generated-from` provenance link, and provenance is one-way: editing a copy never writes back, and unbinding never touches copies. The create surfaces stay unfiltered (the D1 amendment: one class-filtered picker — the class's own template bind — instead of filter plumbing everywhere); template *choice* happens at the moment of creation, Capacities-style.

**Today:** binding/unbinding ships on the class page (template cards), and instantiation rides the object-create flows that offer a bound template (calendar quick-create among them). Designed: `/template` slash instantiation, `{{…}}` variable substitution at apply time, apply-to-existing (§34.25 T3/T4).

## Whiteboards — spatial views of subtrees

A whiteboard is a node classed `whiteboard`; the `whiteboard` content token carries its geometry. The model, precisely:

- **Cards are child blocks.** Full content grammar, backlinks, search indexing, focused view, classing — a card is a block that happens to have `x, y, w, h`. The tree holds content; the token holds geometry, keyed by node id.
- **Shapes are geometry only.** Rectangles, circles, connectors, freehand strokes — layout-token data with no identity and no node overhead.
- **Semantic text lives in cards, not shape labels.** A label is chrome; text that matters to the graph gets a card. A lint may suggest promoting a label to a card — the design law's usual enforcement.
- **Dragging a card is a layout update** — debounced and coalesced into ordinary content ops. No per-mousemove op spam, no new sync primitive.
- **One node, three views.** The same children render spatially (the whiteboard), as an outline (the outliner), or focused (Focused Block View) — because they are the same nodes.

A whiteboard can live fullscreen (a parentless node) or embedded as an inline child of any block. Its cards index into search and the graph naturally — no separate "whiteboard content" that search can't see.

**Today:** the `whiteboard` class is seeded in the catalog, the token is part of the normative grammar, and the web renderer shows a labeled placeholder where a whiteboard will render. The spatial canvas is designed.

## Promotion and demotion

A bullet's prominence is soft state — one op flips it, and identity is preserved completely.

- **Block → page:** a bullet that outgrew its parent becomes a page in place. Same node, same id, every link intact; recents, search ranking, and the link dropdown pick it up automatically because they rank pages first — no re-filing, no copy.
- **Page → block:** demote a page back into the flow of another note; same in-place flip.
- **Declare a class:** create the node with the class identity (`notees object create --isClass` — a `class.create` op under the hood). The node becomes a root, leaves the content tree, and gains the Class View and configuration. Declaration-first: create classes, configure them, use them later or never.

The canonical story: a `meeting`-classed bullet in a daily note sits quietly for months. When it starts to matter, promote it — set its render bit (`--presentAsMain`), optionally nest it under the company page. Same node, same id, all links intact.

**Today:** the flip is real and works from the CLI and object API (`notees object update <id> --presentAsMain` — see [usage.md](usage.md#a-real-session)). The in-editor gesture, recents/dropdown re-ranking, and the class-declaration flow are designed.

## Presentation mode — the note is the deck

There is no slide editor and no slide objects: a presentation is a pure read of one page's subtree, split into slides by the same tree that holds the content (structure is the slide boundary — the content grammar has no heading or divider token, and needs none).

- **Slide 0 is the title slide** — the page's own text content, centered, with its icon and effective color.
- **Every page-zone child is a section slide.** A child in the parent's main-children zone (the Pages section — the render bit set) opens a slide: its own text is the slide title, its children are the slide body, nested blocks included.
- **Body children chunk into intro slides.** A run of inline-body children becomes one or more intro slides, closed greedily by a character budget and a block cap — short slides read large, dense slides compact, and a slide that still overflows scrolls inside itself instead of spilling off the stage.
- **A trailing image block pulls aside.** When the last body block of a slide is an image (an `asset` reference and nothing else), the slide splits — text left, image right; an image alone centers at full size.
- **Embeds expand into the stream.** An embedded page's children splice into the deck as slides after the slide that references them — the live-subtree embed rule is untouched; expansion adds slides, replaces nothing.
- **Read-only but live.** The deck re-renders through the ordinary notify path as the note changes; nothing in a deck writes, and following a link exits the deck and opens the target. Session view-state only — the remembered slide index never touches the log, the store, or a device setting; it dies with the page session.
- **Gestures:** the "…" node menu → **Present**, the page header's context menu → **Present**, or Ctrl/Cmd+Alt+Enter (Ctrl+Alt+Enter — Capacities' Ctrl+Alt+P collides with the add-property chord). Arrows, Space, PageUp/PageDown navigate; the screen edges click through; Esc exits; a floating toolbar (previous, counter, next, exit) fades when the pointer rests and returns on any activity.

The overlay host is a UI-kit primitive (`PresentationOverlay`), sized for a second consumer — whiteboard fullscreen — later.

**Today:** the deck builder, slide renderer, overlay, entry points, and session resume ship in the web app (§34.26 P1–P8). Desktop-class surfaces only; a phone deck is deliberately out of scope (the mobile client is capture-first). Speaker notes and deck export stay parked — page Markdown export already covers "get the content out".

## Exporting

Export is a projection of the graph into files — one-way by design (the log is the truth), engineered to preserve as much as possible.

- **The node is the export root.** A page (or a block, or several selected nodes) exports as Markdown with YAML frontmatter: the title derived from its content, its classes and properties (per-value qualifiers preserved). Its block tree becomes nested bullets in child order; child pages become their own files. Nothing is lost silently: cycles and depth cuts render as visible `[[uuid]]` references, rich text is Markdown-escaped, whiteboard layouts ride along as sidecar JSON inside zips.
- **The dialog is honest about scope.** Every format delivers real bytes: Markdown, HTML, Word, LaTeX, and PDF (three layouts — Notes, Essay, Academic — on A4/Letter, rendered in the browser with a bundled open-license font; the heavy renderer loads only when you first ask for it). Markdown and PDF preview live as you toggle options; the others state plainly that preview is a Markdown/PDF affair.
- **Zips keep the graph contained.** Multi-file exports rewrite cross-page references to relative links (`[title](<file>.md)`) and name files `<title-slug>-<id8>.md` — human-readable, still identity-anchored (the id8 is a hash of the node id). An optional assets folder carries the bytes behind `asset` references as `assets/<name>-<hash8>.<ext>`. A manifest maps every file back to its node id.
- **The workspace exports whole.** One zip: every top-level and child page as its own file, the same conventions, plus everything assets. The same projection is available headless — CLI `notees export markdown`, the shell's `exportMd`, and `GET /api/workspaces/:id/export.zip`.

---

Where to next: [usage.md](usage.md) for running all of this, [philosophy.md](philosophy.md) for why it is built this way, [README.md](../README.md) for the front door.
