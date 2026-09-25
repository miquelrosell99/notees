# SCHEMA.md — Property-Schema, Class-Structure, and Typed-Link Token Spec

Status: **stub — owed-work register, normative only where marked OWED→DONE.** Companion to `v2/docs/design/01-knowledge-model.md` (normative model statement). Supersedes the retired `RELATIONS.md` (first-class relation entities were deleted 2026-09-25; see `02-model-assessment.md` §6).

> Storage truth: **the operation log is the truth; this document specifies how semantic state is expressed in ops and derived rows. Export is a projection, not a round-trip.**

## Owed work (from 02-model-assessment.md §9, plus adopted amendments)

- [ ] **Property-value semantics** — m2o/m2m node-typed values, per-value `metadata` JSON (qualifiers like `since`, `locator`), m2m tombstones. (The `metadata` column and `targetClassFilter` are already in the op schemas; node-backed `text` values are specced in "Node-backed text properties" below.)
- [x] **Typed-link mark grammar** — SPECCED (Content grammar below): free verbs vs property-schema refs; create-and-bind UX remains owed. Orphan/broken rendering owed.
- [x] **Content tokens** — SPECCED (Content grammar below): flat token stream; quote/query/whiteboard/asset_ref/embed_ref are tokens, not segments. **Embed rule: render the live subtree — the real child nodes, never a clone**; live updates and editing-through-the-embed then ride the standard notification/op path. Cycle guard (depth cap + visited set) is a renderer obligation. Embed two-way-editing semantics + asset display tiers remain owed.
- [ ] **Link analytics ("node links table")** — `node_link` assertion rows carry per-link: stable link UUID, `sourceId`, `targetId`, `createdAt`, `updatedAt`, `clickCount`, `lastNavigatedAt` (v1 port; ASSERTIONS category in `01` §3). Granular per-visit history (`link_visit`: link id, actor, timestamp) is a DERIVED log scheduled with M2 statistics/aging — derived means zero protocol cost.
- [ ] **Class-chip lint** — with render-only chips (below), a lint may suggest "chip present but node not classed — assign?"; suggestion only, never enforcement (design law).
- [ ] **RECORD, DON'T RESOLVE** *(adopted amendment, 2026-09-25)* — typed-link capture MUST record candidate target spans as an **ordered list of token IDs** in token metadata; nothing smarter. No scoring, no filtering at capture: deferring the *resolution rule* to M2 is sound, deferring the *recording* is data loss — the sentence context present at capture time is irrecoverable later. Candidates give M2 real data to design against.
- [ ] **Deletion/restore semantics** — node deletion trashes its subtree (v1 precedent, `01` §12 soft-delete + retention); unspecced corners: whether deleting a parent orphans children to workspace roots or trashes with it (recommend: trash the subtree — restore is whole-tree); restoring a node whose parent was permanently deleted (recommend: reparent under the containing page — nearest `is_page` ancestor, tree-derived — else workspace root); the page listing is `WHERE is_page = true` — class exclusion is structural (classes carry `is_page=false`).
- [ ] `extends` closure + binding-resolution normative statement (own → shortest extends-path → earliest HLC; cycles fail-loud).
- [ ] **Content serialization for export** — token-set→Markdown mapping table (§34.12 Tier 2): UUID filenames, frontmatter, `#tag` chips, `[[mentions]]`, `![[uuid]]` embeds, ` ```query ` blocks, whiteboard sidecars, asset manifests, workspace UUID manifest.
- [ ] **Property-schema CRUD UX + create-and-bind** — Tana-grade schema-at-capture (the sweep's make-or-break gesture); property panel, table columns, structured views.
- [ ] **Computed properties / formula language** — DEFERRED DECISION (sweep, 2026-09-25): v1 has a `computed` flag; Notion-style per-row expressions are M3+ optional, distinct from QueryAST query-time aggregations. Owner to decide; do not build silently.
- [ ] **Template instantiation** — `has-template` placement (`00-INDEX` open question; proposal: node-typed property on class nodes, instantiation clones content + children).
- [ ] Configuration registry schema (`property_schema`, `class_property` rows).
- [ ] Backlink roll-up + filter-inheritance semantics (`refset(n) = own_links(n) ∪ refset(parent(n))`); fan-out-at-projection vs traversal-at-query-time decision (M1 spike).
- [ ] Typed-link target-resolution design — DEFERRED to M2 by owner decision; register only, do not spec (see 00-INDEX "Deferred"). Design against the recorded candidateSpans.
- [ ] Typed-link UX spec (capture flows, editing contract).
- [ ] Class lifecycle/protection validation rules; promotion/lint gesture specs.
- [x] **Fixture re-encoding against this model** — DONE 2026-09-25: typed-link-mark fixtures replace the deleted relation fixtures at full acceptance width (see `fixtures/`).

## Content grammar (NORMATIVE, firmed 2026-09-25)

A block node's content is **one flat, ordered token array** (`contentAst: ContentToken[]`). There are no block-level "segments" — paragraph spacing, quotes, queries, whiteboards, assets, and embeds are all tokens in the same stream. The design law applies: nothing prohibits where a token may appear; rendering defines presentation.

Decisions recorded with the grammar:

- **Fork 2 — marks are attributes** on text runs (`marks: ["bold","italic","strike","highlight","code"]`), not nested nodes. Overlaps (a bold phrase containing a mention, a typed-link word in italics) split runs at boundaries — standard rich-text mechanism; no nesting interaction matrix.
- **Fork 3 — `class_chip` is render-only** (owner decision): inserting/deleting a chip does NOT mutate `class_ids`; it references the class node and renders its *current* name (rename once, every chip updates). Assignment is a separate gesture; a lint may suggest it. One-off wording via optional `displayText`.
- **Fork 4 — `mention` stores id only**; display resolves the target's current name at render time (auto-rename free). `text` (captured surface form) is non-authoritative; `displayText` overrides per-link ("the Republic"); broken targets render the raw id (v1 fallback rule).
- **Line breaks (owner decision, 2026-09-25):** exactly one break token — `hard_break` = shift+enter, a line jump inside a block. **Enter always creates a new node** (a new bullet); there is no paragraph concept within a block and no `paragraph_break` token.
- **Prose mode** (bullets hidden, indents flattened) is a VIEW transform, not content.

Token set (zod schemas are the executable form, `src/content-mark.ts`):

| Token | Key fields | Notes |
|---|---|---|
| `text` | `text`, `marks?` | plain runs; formatting lives here |
| `class_chip` | `classId`, `displayText?` | render-only (Fork 3) |
| `mention` | `targetNodeId`, `text`, `displayText?` | pill escape hatch (Fork 4) |
| `typed_link` | `verb`, `text`, `metadata{locator?, candidateSpans?}` | mark on the word; record-don't-resolve |
| `asset_ref` | `assetId` | renders inline (chip/preview); alone in a stream position = full-bleed |
| `embed_ref` | `nodeId` | live subtree, never a clone; renderer cycle guard |
| `quote` | `children` (inline tokens) | the only nested token |
| `query` | `queryAst`, `view?` | block-scale live query |
| `whiteboard` | `layout` | shapes/strokes/viewport. **A whiteboard node is defined by the `whiteboard` system class (what-it-is axis); this token carries its data.** Never a kind or a flag — the general rule: what-it-is always lives in class, specialized data lives in content tokens or assertion rows. Class↔token divergence is a lint suggestion, never a prohibition (design law). |
| `external_link` | `href`, `text` | |
| `math` | `expression` | KaTeX source |
| `hard_break` | — | shift+enter line jump; Enter creates a new node |

Typed-link rule: a typed link is a **mark on a prose word** (01-knowledge-model.md §9) — nothing is inserted; the word you wrote is the annotation. Delete the word and the mark dies with it; marks ride inside the CRDT-synchronized content (per-node `Y.Text` over the serialized token array — v1 port; canonical wire carrier `contentDeltaB64`, readable carrier `contentAst`). Plaintext for FTS is derived by the applier, never stored as truth. Per-field CRDTs remain a documented M3+ option if real-time collaboration ever demands finer granularity.

Storage of the token array: the block node's content serializes into its per-node CRDT; content ops (`object.create/update`) are the only write path — **no token type introduces a new op or sync primitive**.

---

## Node structure — `is_page` and class-ness (NORMATIVE, owner amendment 2026-09-25, Revision 10)

`is_page` replaces both the `kind` field and the briefly-considered `page_id` column (Revision 9 superseded). Two single-sourced axes, plus the reserved class predicate:

- **Placement lives only in the tree** (`parent_id`). A cross-page move updates nothing but the parent edge (+ order) — no cascades, no second representation of "where this block lives".
- **Page-ness lives only in `is_page`** (LWW boolean, flippable): true = the node IS a page. View chrome derives from it (true → page view; false → focused block view). Promotion/demotion = flip in place — identity, links, children preserved.
- **Children are always created `is_page=false`** (child of a page or of a block is a block). **Nested pages** = a child with `is_page` flipped true — renders as a bullet in the parent's list, opens in page view (Logseq behavior).
- **Workspace root admits only `is_page=true` nodes** (fail-loud) → every block's ancestor chain provably contains a page.
- **"Containing page of B"** = nearest ancestor with `is_page=true` — an upward walk, v1-proven: the QueryAST compiler emits it as a `WITH RECURSIVE page_ancestors` CTE. **"Content of page P"** = subtree of P (downward recursion, v1 `GetNodeTreeQuery`).
- **"Blocks inside page Y at any level"** (scoped backlinks) = subtree CTE from Y joined against the edge index — a v1 `specific_pages` scope port; read cost O(subtree), write cost zero. If ever measured too slow for a hot path, an ancestor-closure read model is a *derived* optimization (no protocol change) — build when profiled, not before.
- **Page listing** = `WHERE is_page = true` — classes carry `is_page=false`, so class exclusion from page listings is structural, not a projection rule.
- **Class-ness**: `is_class(n) := SYSTEM_CLASS_UUIDS["class"] ∈ n.class_ids` — the reserved system class is a type-of-types constant (seeded, fixed UUID, runtime-guarded), not user vocabulary. Self-referential but not viciously circular: user classes are *instances* of the system `class`; the base case is seeded. The `class` class is system-protected. **A class is a page that is classed as `class`** — the classing gesture requires `is_page=true` (fail-loud; same pattern as class-parenting rejection), and demoting a class node is rejected (classes are removed by deletion, not demotion). The list of classes is a **derived read model** (`class_list`: node_id, name, icon, member counts; applier-maintained, wipe → replay → identical) — authority stays on the node; the table is ergonomics. Derived-store membership is materialized per-row (v1 `class_member_set` shape), so `is_class(n)` and the "exclude classes from content projections" check are indexed lookups, not JSON scans.
- **View resolution = f(node):** `is_class` → **Class View** (page chrome — header, icon, color — plus property-bindings editor, `extends`/inheritance section, classed-nodes section, template slot, description shelf); else `is_page` → Page View; else → Focused Block View. Class and whiteboard views/presentations are **view-registry overrides** (v1 pattern) — one mechanism.
- **Whiteboard:** `whiteboard` system class + content token; fullscreen = `is_page` true; embedded = child of **any block** with `is_page` false; cards are its children. General rule: what-it-is lives in class, specialized data lives in tokens/assertion rows — never new kinds or flags.

## Projection-reclassification rules (NORMATIVE, 2026-09-25)

In a node's body block-list, exclude direct children that are:

1. **classed with the parent node itself** — a class's classed instances render in the classed-nodes section (the Meetings pattern), not the body; or
2. **targets of the parent's node-typed property values** — carrier blocks render in the properties panel, not the body.

Both are derived (the applier recomputes them; wipe → replay → identical), never stored flags. One mechanism, two uses. Everything else about the children — queries, backlinks, `refset` roll-up, focused view — is unaffected.

## Node-backed text properties (NORMATIVE, 2026-09-25)

- The `text` value type is **node-typed by convention**: `property.set` stores a carrier block's id; the properties panel renders an editor that writes content ops to the carrier — so property text carries the **full grammar** (mentions, class chips, typed links, embeds) and may have an **arbitrary number of children at arbitrary depth** (it is a block; the panel edits it as a mini-outliner, focused view opens it).
- Carrier blocks are **real children of the owner node** (`parent_id = owner`; containment derives from the tree — no placement fields) → containment, backlinks, `refset` roll-up, queries, and export resolution all work. The carrier's own children are ordinary blocks under the carrier; the body-exclusion rule filters only direct carriers.
- **Unset deletes the carrier** (trash + retention, consistent with node deletion). **"Promote to block" is a separate gesture** — reparent the carrier into the owner's body.
- Multi-value `text` = m2m list of carrier block ids, each with its own subtree.
