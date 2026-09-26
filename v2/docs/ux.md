# The Notees interaction model

How Notees feels to use: the views, the outliner, the sections, the marks, the whiteboards, and the gestures. The normative specs behind each section live in [packages/protocol/SCHEMA.md](../packages/protocol/SCHEMA.md) and [.plans/design/01-knowledge-model.md](../.plans/design/01-knowledge-model.md); the ideas are in [philosophy.md](philosophy.md); what you can run today is in [usage.md](usage.md).

M1 alpha honesty, up front — every feature below is labeled:

| Feature | State |
|---|---|
| Page view with block-tree rendering | **Today** (read-mostly) |
| Content-token rendering (marks, mentions, chips, typed-link display) | **Today** (read-only) |
| Backlinks as data (API, CLI, web client) | **Today** |
| Promotion/demotion | **Today** (CLI/API; in-editor gesture designed) |
| Class view, focused block view | Designed |
| Interactive outliner: text core | **Today** (typing, Enter/shift+Enter/Backspace, Tab indent / shift+Tab outdent, Enter sibling placement) |
| System sections UI with the lazy-loading contract | Designed |
| Typed-link capture UX (create-and-bind, target resolution) | Designed |
| Whiteboards | Designed |

## Views follow node_type

View resolution is a pure function of one column — `node_type ∈ {page, block, class}` decides what you see. There is no per-node view setting that could drift from what the node is ([philosophy.md](philosophy.md) on why that matters).

- **`page` → Page View.** Header (icon, name), then the body block list, then system sections. A page's *content is its bullet tree* — there is no separate document body.
- **`block` → Focused Block View.** A block zoomed to center stage: its content, its children, its backlinks, its properties. The outliner's "zoom into a bullet" from Logseq, generalized to any node.
- **`class` → Class View.** Page chrome plus configuration: the property-bindings editor, the `extends`/inheritance section, the classed-nodes section (the members — the Meetings pattern: content *about* instances lives in topic pages; the class page shows config + members), a template slot, and a description shelf documenting the config itself.

Two placement rules complete the picture. **Nested pages keep `node_type='page'`** — a child page opens in Page View and renders in its parent's dedicated **Child pages** section, never inline in the parent's body. And class nodes are tree-external by construction: a class can never be a parent or a child, enforced by schema and by a fail-loud move-guard.

**Today:** Page View is what the web app renders — header plus the block tree (child pages intentionally filtered out of the body, per the projection rule above). Focused Block View and Class View are designed; the class catalog is inspectable today via `notees class list` and `GET /api/v1/classes` ([usage.md](usage.md)).

## The outliner

The editor is a Logseq-style outliner: bullet points, and each bullet is a block is a node. The core contract:

| Gesture | Effect |
|---|---|
| `Enter` | Creates a new node — a new bullet. Always. There is no paragraph concept inside a block. |
| `Shift+Enter` | A `hard_break` — a line jump *inside* the block. The only break token in the grammar. |
| Indent / outdent | Reparents the node (`object.move`; fractional sibling-midpoint ordering — TreeCrdt designed). The tree *is* the document structure. |
| Drag | Reorders among siblings (fractional positions + TreeCrdt — proven v1 machinery, ported). |
| Collapse / expand | View state only; children stay first-class nodes. |
| Prose mode | Bullets hidden, indents flattened — a **view transform, not content**. Flip back and nothing changed. |

Long-form writing emerges from nesting bullets, not from a document mode. That is a deliberate bet — the confident statement is: structure you got for free beats structure you typed as metadata.

Blocks are first-class storage but second-class display. Display defaults keep them quiet: backlinks aggregate mentions per containing page, the graph collapses children, search ranks root pages first with block hits nested beneath their parents, and queries default to root scope. When a bullet matters enough to stand alone, you promote it — see [Promotion and demotion](#promotion-and-demotion).

**Today:** the web app ships the interactive text core — typing with debounced saves, Enter (a new sibling placed right after the current block), Shift+Enter hard breaks, Backspace delete, and Tab / Shift+Tab reparenting via `object.move` with fractional sibling-midpoint ordering. Marks editing, typed-link/chips capture gestures, collapse, and drag reorder remain the designed editor milestone; the tree machinery the rest ports is already the machinery sync uses.

## System sections — and the lazy-loading contract

Pages come with predefined sections that are **named system queries** over the query runtime, not bespoke UI: **linked references**, **unlinked references**, **child pages**, **classed nodes**, and **extended-by**. They ship as fixtures like any op type, and the section registry becomes plugin-extensible later.

The rules, all of them load-bearing for performance:

- **Collapsed by default, and a collapsed section runs no query at all.** Nothing loads until the first expand.
- **Count badges come only from materialized counts** (`node_stats.backlink_count`) — the badge renders unconditionally and is exempt from the contract because reading it is reading a stored number, not running a query.
- **Unlinked references shows no eager count.** Computing it *is* the expensive query — it is a full-text search for the page's literal name across the workspace, excluding blocks that already link to the page. Pages only; blocks do not get this section.
- **Results cache** per section until an invalidating notification lands (a content, class, or property edge change).
- **Blocks get backlinks in place.** A block with backlinks shows a count badge in the right gutter; toggling it expands the linked-references query scoped to that block, inline beneath it — the query runs on first toggle, per the contract.

Backlinks list *actual* links — but the backlinks view can be narrowed by facets over inherited links: Jane's backlinks filtered to `refset ∋ ACME` shows only the Jane-mentions made in the context of ACME, even when the ACME link lives on a parent block (Logseq's linked-references filtering, generalized — see [philosophy.md](philosophy.md#what-we-took--and-the-wounds-that-became-our-rules)).

**Today:** backlinks are real data — `notees backlinks <id>`, `GET /api/v1/objects/:id/backlinks`, and the web client's `getBacklinks()` all read the derived edge index. The section chrome, badges, and the expand-on-first-toggle UX are designed.

## Mentions, chips, and typed links — marks on words

All three are tokens in the same flat content stream ([SCHEMA.md grammar](../packages/protocol/SCHEMA.md)), and all three obey the same rule: **nothing is inserted; the word you wrote is the annotation.**

- **Mention** — a pill. Stores the target's id plus the captured surface form; rendering resolves the *current* name, so renaming a node updates every mention for free. An optional `displayText` overrides per-link ("the Republic"). A broken target renders the raw id — never silent retargeting.
- **Class chip** — render-only, by decision. Inserting a chip does not assign the class; it references the class node and renders its current name. Assignment is a separate gesture, and a lint may suggest it ("chip present, node not classed — assign?"). Suggestion, never enforcement.
- **Typed link** — the distinctive one. You write the sentence naturally ("argument X *contradicts* argument Y"); the verb is a **mark on the word**, with an optional target and token metadata such as a locator. Rendering is a subtle colored underline with a hover card, plus a global "show types" overlay (off by default in reading mode). Lifecycle is honest: delete the word and the mark dies with it — the graph stops claiming what the sentence no longer claims. The verb is a property-schema reference *or a bare free string*; when the verb you want doesn't exist yet, **create-and-bind** makes the schema at capture time (the Tana lesson: schema-at-capture or the feature dies in setup). The adorned mention pill survives only as the escape hatch for when there is no natural verb ("see <<Y>>").

**Record, don't resolve.** Capture records candidate target spans as an ordered list of token IDs in the token metadata — nothing smarter, no scoring, no filtering. The sentence context present at capture is irrecoverable later, so deferring the *resolution rule* is sound design while deferring the *recording* would be data loss. Target resolution lands in M2, designed against real captured data.

Citations are the canonical dogfood: a `cites` verb with the locator auto-filled from the current PDF selection, grouped backlinks by verb, bibliography views — the M2 research environment.

**Today:** the grammar is specced and fixture-tested, and the web renderer displays all three token types (resolved names, underlined verbs) read-only. The capture UX — selection binding, `@`-insert, create-and-bind, locator autofill — is designed.

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
