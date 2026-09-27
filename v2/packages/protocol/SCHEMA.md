# SCHEMA.md — Property-Schema, Class-Structure, and Typed-Link Token Spec

Status: **stub — owed-work register, normative only where marked OWED→DONE.** Companion to `v2/.plans/design/01-knowledge-model.md` (normative model statement). Supersedes the retired `RELATIONS.md` (first-class relation entities were deleted 2026-09-25; see `02-model-assessment.md` §6).

> Storage truth: **the operation log is the truth; this document specifies how semantic state is expressed in ops and derived rows. Export is a projection, not a round-trip.**

## Owed work (from 02-model-assessment.md §9, plus adopted amendments)

- [ ] **Property-value semantics** — m2o/m2m node-typed values, per-value `metadata` JSON (qualifiers like `since`, `locator`), m2m tombstones. (The `metadata` column and `targetClassFilter` are already in the op schemas; node-backed `text` values are specced in "Node-backed text properties" below.)
- [x] **Typed-link mark grammar** — SPECCED (Content grammar below): free verbs vs property-schema refs; create-and-bind UX remains owed. Orphan/broken rendering owed.
- [x] **Content tokens** — SPECCED (Content grammar below): flat token stream; quote/query/whiteboard/asset_ref/embed_ref are tokens, not segments. **Embed rule: render the live subtree — the real child nodes, never a clone**; live updates and editing-through-the-embed then ride the standard notification/op path. Cycle guard (depth cap + visited set) is a renderer obligation. Embed two-way-editing semantics + asset display tiers remain owed.
- [ ] **Link analytics ("node links table")** — `node_link` assertion rows carry per-link: stable link UUID, `sourceId`, `targetId`, `createdAt`, `updatedAt`, `clickCount`, `lastNavigatedAt` (v1 port; ASSERTIONS category in `01` §3). Granular per-visit history (`link_visit`: link id, actor, timestamp) is a DERIVED log scheduled with M2 statistics/aging — derived means zero protocol cost.
- [ ] **Class-chip lint** — with render-only chips (below), a lint may suggest "chip present but node not classed — assign?"; suggestion only, never enforcement (design law).
- [ ] **RECORD, DON'T RESOLVE** *(adopted amendment, 2026-09-25)* — typed-link capture MUST record candidate target spans as an **ordered list of token IDs** in token metadata; nothing smarter. No scoring, no filtering at capture: deferring the *resolution rule* to M2 is sound, deferring the *recording* is data loss — the sentence context present at capture time is irrecoverable later. Candidates give M2 real data to design against.
- [ ] **Deletion/restore semantics** — node deletion trashes its subtree (v1 precedent, `01` §12 soft-delete + retention); unspecced corners: whether deleting a parent orphans children to workspace roots or trashes with it (recommend: trash the subtree — restore is whole-tree); restoring a node whose parent was permanently deleted (recommend: reparent under the containing page — nearest `page`-type ancestor, tree-derived — else workspace root); the page listing is `WHERE node_type='page'` — class exclusion is structural (classes are `node_type='class'`).
- [x] **Unassign op** — DONE 2026-09-27: `class.unassign {objectId, classId}` is registered (op-types.ts) and ships the canonical `class-unassign.json` fixture (gate list 9→10). The applier tombstones the OR-Set pair (`class_member_set` present = 0, HLC-gated add-wins — the remove's comparator is strictly-greater, the re-issued `object.create` add carrier's greater-or-equal per the collection_member convention) and recomputes `node.class_ids`; the effective read drops the class's derived defaults automatically and authored values survive (boundBy null). Lockstep: GTK/Flutter need the same op + fixture + applier branch.
- [ ] `extends` closure + binding-resolution normative statement (own → shortest extends-path → earliest HLC; cycles fail-loud).
- [x] **Content serialization for export** — DONE 2026-09-26 as `@notees/export` (one Markdown implementation reused by CLI export, workspace snapshots, the future server endpoint, and the future UI export-on-query action — UI collects the live-query result list and calls `bundleMarkdown(nodes, ctx)`): frontmatter with per-value qualifiers, `#tag` chips, `[[mentions]]` (Fork 4 fallback), `![[uuid]]` embeds, fenced ` ```query ` / ` ```json ` blocks, `<uuid>.md` files + `notees-manifest.json`. CLI surface (§34.16.3): `notees export markdown --ids … | --linked-to <id> [--depth N|fixpoint] [--output-dir Y|--stdout]`. Deferred: markdown metacharacter escaping, child-position ordering (awaits a `/objects/:id/children` endpoint), whiteboard sidecar files.
- [x] **M1 deviation register** (documented in `v2/.plans/dev/architecture.md` §11) — known code-vs-design gaps to reconcile: `class.setExtends` WAS single-parent in M1 code vs the designed m2m multiple inheritance; **RECONCILED 2026-09-26** — payload is `{classId, parentClassIds: string[]}` with replace semantics (the array replaces the full parent set; LWW slot by envelope HLC; idempotent via `applied_envelope`), stored as `class_extends` m2m edges with the `class_hierarchy` closure rebuilt by the applier, cycles (self-parent and multi-hop) fail loud with `CycleError`; diamond resolution (own binding → shortest extends-path → earliest-authored HLC) stays read-time in the bindings read model — closure rows carry no order. Remaining known gaps: live content carrier is `contentAst` (`contentDeltaB64` awaits the Yjs port); outbox is session in-memory; `bumpRestoreEpoch` has no operator route; snapshot blobs are stored flat (one code comment wrongly says per-workspace); the setExtends winner is relay apply-order, not per-field HLC LWW (converges regardless; follow-up decision); ~~the CLI asset round-trip test is flaky under host load~~ **FIXED 2026-09-26** — the suite booted a real server per test (12×) and something in the accumulated native handles/event-loop pressure could stall a later `app.listen`; converted to one server per file (5 consecutive green runs, ~1 s suite).
- [x] **Title search in FTS** — RECONCILED 2026-09-26: the FTS row carries the stored name (`name + " " + content plaintext`, null names contribute nothing), so pages are findable by title; `object.update` name writes reindex exactly like content writes (`packages/store/src/search.ts`, `appliers.ts`).
- [x] **Direct-only backlinks** — RECONCILED 2026-09-26: `01` §8 fan-out-vs-traversal resolved as **traversal at query time** with **source-side containment** — `Store.backlinksWithRollup(id)` walks `node.parent_id` (recursive CTE) collecting the target's subtree and joins `edge` for direct edges on the target PLUS outward links (source inside the subtree, target outside it; intra-subtree links excluded as self-noise), one row per (source, kind) annotated `kind: direct|containment` + subtree depth, direct first; `backlinks(id)` and `node_stats.backlink_count` (the badge) stay DIRECT, so a containment-heavy page's list can exceed its badge. Filter inheritance (`refset` query matching) remains owed.
- [x] **`notees shell`** — DONE 2026-09-27: Node REPL (node:repl, top-level await via a vm-based async eval) over the object API (`get/list/search/classes/backlinks/props/effective/create/update/del/setProperty/upload/exportMd`), piped-stdin script mode with exit codes; the Odoo-shell equivalent (§34.16.1), documented in usage.md.
- [ ] **Property-schema CRUD UX + create-and-bind** — Tana-grade schema-at-capture (the sweep's make-or-break gesture); property panel, table columns, structured views.
- [ ] **Computed properties / formula language** — DEFERRED DECISION (sweep, 2026-09-25): v1 has a `computed` flag; Notion-style per-row expressions are M3+ optional, distinct from QueryAST query-time aggregations. Owner to decide; do not build silently.
- [ ] **Template instantiation** — `has-template` placement (`00-INDEX` open question; proposal: node-typed property on class nodes, instantiation clones content + children).
- [ ] Configuration registry schema (`property_schema`, `class_property` rows).
- [ ] Backlink roll-up + filter-inheritance semantics (`refset(n) = own_links(n) ∪ refset(parent(n))`); fan-out-at-projection vs traversal-at-query-time decision (M1 spike).
- [ ] Typed-link target-resolution design — DEFERRED to M2 by owner decision; register only, do not spec (see 00-INDEX "Deferred"). Design against the recorded candidateSpans.
- [ ] Typed-link UX spec (capture flows, editing contract).
- [ ] Class lifecycle/protection validation rules; promotion/lint gesture specs.
- [x] **Fixture re-encoding against this model** — DONE 2026-09-25: typed-link-mark fixtures replace the deleted relation fixtures at full acceptance width (see `fixtures/`).
- [x] **Name/title derivation** — DECIDED 2026-09-26: pages carry a stored `name`; blocks derive their display name from content text (first text runs, single line, truncated), with an optional stored-name override; renames never propagate (mentions render the target's current name — Fork 4). Implemented in `packages/domain` (`deriveDisplayName`).
- [x] **Mention ↔ node_link analytics join key** — DECIDED 2026-09-26: `mention` tokens carry an optional `linkId` (stable per-link instance UUID; v1 pattern) — the `node_link` assertion keys on it, giving per-instance history (created, click/access times). Tokens without `linkId` are anonymous mentions (no analytics row, or a synthetic key — store's choice).
- [x] **Collection ops reconciliation** — DECIDED 2026-09-26: collections are nodes (`object.create` + `collection` class); the registry has **no** `collection.create/update/delete` ops (parallel write path rejected); only `collection.member.add/remove` remain.
- [ ] **System seed manifest** — full port of v1 `SYSTEM_CLASS_UUIDS` / `SYSTEM_PROPERTY_UUIDS` / `SYSTEM_PAGE_UUIDS` (entity classes, `tag`/`claim`/`question`/`meeting`/`collection`/`query`, `whiteboard`, source tree, asset, annotation family; decide day/month/year for journals; Inbox + scratchpad) as `packages/domain` seeds with fixed UUIDs.
- [ ] **FTS plaintext extraction spec** — which tokens contribute text (text runs, typed-link text, mention captured text, asset original name, recursive quote children; whiteboard cards are ordinary blocks and index naturally), and how derived `text_content` is stored.
- [ ] **Protocol v2 wire spec** — port v1 `protocol/SPEC.md` structure with the §34.4 fixes: endpoint surface (batch / catch-up / snapshot / compact / stats), WS framing, error envelope, rate limits, versioning policy, fixtures. Needed before `apps/server`; envelopes and payloads are already specced here.

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
| `typed_link` | `verb`, `text`, `metadata{locator?, candidateSpans?}` | mark on the word; record-don't-resolve. **candidateSpans (web M1 interpretation, 2026-09-26):** the flat grammar has no token ids — computed on save as the `targetNodeId`s of the block's `mention` tokens, ordered nearest-first by prose distance from the mark, deduped, cap 8 |
| `asset_ref` | `assetId` | renders inline (chip/preview); alone in a stream position = full-bleed |
| `embed_ref` | `nodeId` | live subtree, never a clone; renderer cycle guard |
| `quote` | `children` (inline tokens) | the only nested token |
| `query` | `queryAst`, `view?` | block-scale live query. `view` is a free-form record; the web renderer persists `view.mode: "list" \| "table"` (list default) and renders the aggregate grid when `queryAst` carries an `aggregation` |
| `whiteboard` | `layout` | shapes/strokes/viewport + per-card geometry. **A whiteboard node is defined by the `whiteboard` system class (what-it-is axis); this token carries geometry and shapes.** Never a kind or a flag — the general rule: what-it-is always lives in class, specialized data lives in content tokens or assertion rows. Class↔token divergence is a lint suggestion, never a prohibition (design law). See "Whiteboard modeling" below. |
| `external_link` | `href`, `text` | |
| `math` | `expression` | KaTeX source |
| `hard_break` | — | shift+enter line jump; Enter creates a new node |

Typed-link rule: a typed link is a **mark on a prose word** (01-knowledge-model.md §9) — nothing is inserted; the word you wrote is the annotation. Delete the word and the mark dies with it; marks ride inside the CRDT-synchronized content (per-node `Y.Text` over the serialized token array — v1 port; canonical wire carrier `contentDeltaB64`, readable carrier `contentAst`). Plaintext for FTS is derived by the applier, never stored as truth. Per-field CRDTs remain a documented M3+ option if real-time collaboration ever demands finer granularity.

Storage of the token array: the block node's content serializes into its per-node CRDT; content ops (`object.create/update`) are the only write path — **no token type introduces a new op or sync primitive**.

## Whiteboard modeling (NORMATIVE, 2026-09-26)

- **Cards are child blocks of the whiteboard node** — full grammar (mentions, chips, typed links), backlinks, search indexing, focused view, classing. The whiteboard is a **spatial view of its subtree**: geometry (`x, y, w, h` per card) lives in the layout token **keyed by node id**; the tree holds content, the token holds geometry. The outliner can render the same children as bullets — same nodes, three views (spatial / outline / focused).
- **Shapes (rectangles, circles, connectors, freehand strokes) are layout-token-only** — pure geometry, no identity, no node overhead.
- **Rule: semantic text lives in cards, not shape labels.** A shape label is chrome; text that matters to the graph gets a card. A lint may suggest promoting a label to a card — suggestion, never prohibition.
- **Dragging a card** = a layout-token update, debounced/coalesced into content ops (no per-mousemove op spam). All writes ride `object.update` — no new sync primitive.
- **M3 collab caveat (deferred, additive):** the whole layout is one CRDT text; simultaneous drags converge at text level (fine for disjoint edits). If real-time collaboration ever makes that bite, splitting layout into its own CRDT field is an additive change — note it, don't build it now.

---

## Node structure — `node_type` (NORMATIVE, bullet-proof schema, Revision 10 final)

The three structural roles are **one enumeration, schema-enforced** — illegal states are unrepresentable, not guarded:

- `node_type ∈ {page, block, class}`, NOT NULL (the applier defaults it by context: workspace root → page, child → block). The three axes are: **`node_type`** (structural role) × **`parent_id`** (placement) × **`class_ids`** (domain typing — whiteboard, meeting, …).
- **CHECK constraints enforce placement at the database level (single-row):** a block can never be parentless (`node_type='block' ⇒ parent_id IS NOT NULL`); a class is always tree-external (`node_type='class' ⇒ parent_id IS NULL`). A parentless node is therefore always a page or a class — the "drifted block with no parent" state cannot exist. The one cross-row rule (a class may not be a **parent**) remains an applier move-guard (fail-loud) — cross-row constraints cannot be CHECKs.
- **Placement lives only in the tree:** a cross-page move updates nothing but the parent edge (+ order) — no cascades, no second representation of "where this block lives".
- **View resolution = f(node_type), full stop:** `class` → Class View (page chrome + property-bindings editor + `extends`/inheritance section + classed-nodes section + template slot + description shelf) · `page` → Page View · `block` → Focused Block View.
- **Nested pages** keep `node_type='page'` — they open in Page View and render in the parent's **dedicated Child pages section** (a blocks-list projection), *not* inline in the parent's body block list (projection rule 3 below).
- **Promotion/demotion = `UPDATE node_type` block↔page** (one op, in place, identity preserved). **Declaring a class = set `node_type='class'`** — declaration-first: users create classes, configure them (bindings, `extends`, icon, description), and use them later or never; undeclaring returns the node to an ordinary note with inert config.
- **Listings:** pages = `WHERE node_type='page'`; classes = the derived `class_list` read model keyed on `node_type='class'` (applier-maintained, wipe → replay → identical; authority on the node — explicitly NOT a stored registry: no shadow split, no new op type). The reserved system `class` node remains as hierarchy root / Classes-UI anchor, not the predicate.
- **Queries:** "containing page of B" = nearest `page`-type ancestor (v1 `page_ancestors` CTE); "blocks inside page Y at any level" = subtree CTE from Y joined against the edge index (v1 `specific_pages` scope port) — read O(subtree), write zero; an ancestor-closure read model is a *derived* optimization only if profiling demands it.
- **Whiteboard:** `whiteboard` system class + content token; fullscreen = `node_type='page'`, embedded = child of any block with `node_type='block'`; cards are its children. General rule: what-it-is lives in class, specialized data lives in tokens/assertion rows — never new kinds or flags.

## Projection-reclassification rules (NORMATIVE, 2026-09-25)

In a node's body block-list, exclude direct children that are:

1. **classed with the parent node itself** — a class's classed instances render in the classed-nodes section (the Meetings pattern), not the body;
2. **targets of the parent's node-typed property values** — carrier blocks render in the properties panel, not the body; or
3. **`node_type='page'`** — child pages render in the **dedicated Child pages section** (a blocks-list projection that opens them in Page View), not inline in the body.

All three are derived (the applier recomputes them; wipe → replay → identical), never stored flags. One mechanism, three uses. Everything else about the children — queries, backlinks, `refset` roll-up, focused view — is unaffected.

## System sections (v1 port, M1 requirement)

Predefined page sections are **named system queries** over the QueryAST runtime (v1 `autoFixSystemQuery` pattern), not bespoke UI: **linked references, unlinked references, child pages, classed nodes, extended-by** ship with fixtures like any op type, and the section registry is plugin-extensible (M3). Owed: the system-query registry, section fixtures, and the per-section projection rules above wired in.

Section specs and the lazy-loading contract:

- **Unlinked references — pages only.** Literal-text appearances of the page's name anywhere in the workspace, **excluding** blocks that already link to it (already-linked = the linked-references set). Implemented as an FTS query over the page name (v1 `unlinked_references` system query). Blocks do not get this section.
- **Linked references for blocks — right-gutter toggle.** A block with backlinks shows a button to the right of the block element containing the link count (`node_stats.backlink_count` — materialized, so the badge renders unconditionally and is exempt from the lazy-loading contract). Toggling it expands the linked-references system query scoped to that block, rendered inline beneath it; the query runs on first toggle and caches until an invalidating notification, per the contract.
- **Lazy-loading contract (all system sections):** collapsed by default, and a collapsed section executes **no query** — nothing loads until first expand (v1 `QuerySection` pattern). Count badges come only from materialized derived counts (`node_stats.backlink_count` for linked references); **unlinked references shows no eager count** — computing the count *is* the expensive query. Results cache per section until an invalidating notification lands (content/class/property edge changes).

## Class properties — bindings, defaults, aggregation (NORMATIVE, owner philosophy 2026-09-27)

Classes define **bound property schemas** (with per-binding metadata and a `defaultValue`). Nodes with the class get the defaults **applied**; nodes with several classes **aggregate** the bindings; default conflicts resolve **first-class-applied wins**; removing a class removes its bound properties **that have no authored value** (authored values always survive — design law).

- **Bindings are configuration rows** (`class_property`: sequence, required, readonly, hideWhenEmpty, defaultValue, active), authored by two ops: `class.property.set {classId, propertySchemaId, sequence?, required?, readonly?, hideWhenEmpty?, defaultValue?}` (upsert) and `class.property.unset {classId, propertySchemaId}` (remove the binding). Applier-maintained registry; binding writes are ordinary config ops (LWW on the row by HLC).
- **Defaults are a DERIVED read model — never materialized writes.** The applier does NOT create `property_value` rows for defaults. The effective value is computed at read time: `effective(node, schema, idx) = authored property_value ?? winning binding's defaultValue`. This gives convergence for free (no default-write CRDT semantics), makes cleanup free, and keeps the authored/derived boundary honest: editing a default in the UI writes an authored `property.set`, which from then on shadows the default.
- **Aggregation**: the effective bindings of a node = the union of bindings across ALL its classes. Per `(schema, idx)`, binding metadata conflicts (required/readonly/hideWhenEmpty/sequence) resolve the same way as defaults — first-class-applied wins.
- **Conflict resolution — first-class-applied wins**: among the node's classes that bind the same schema with a default, the winner is the class whose membership assignment (the OR-Set add) has the **earliest HLC**; ties break by class id. Deterministic on every replica.
- **Class removal**: an unassign simply removes the class from `class_member_set` — bound properties with **no authored value** stop being derived (nothing stored, nothing to clean: "non-value properties get removed" is automatic); properties the user **did** set keep their authored rows and remain visible (marked as unbound-by-current-classes in the panel).
- **Read surfaces** use effective values: the store exposes `getEffectiveProperties(nodeId)` (authored + derived rows, each tagged `source: "authored" | "default"` and `boundBy: classId`); the property panel renders derived defaults distinctly (dimmed) until edited; queries/tables (M2) read through the same function.
- Fixture-first: `class.property.set` ships with a canonical fixture (binding with default → node of the class reads the default; multi-class conflict → first-applied wins; unassign → derived default gone, authored value survives).

## Node-backed text properties (NORMATIVE, 2026-09-25)

- The `text` value type is **node-typed by convention**: `property.set` stores a carrier block's id; the properties panel renders an editor that writes content ops to the carrier — so property text carries the **full grammar** (mentions, class chips, typed links, embeds) and may have an **arbitrary number of children at arbitrary depth** (it is a block; the panel edits it as a mini-outliner, focused view opens it).
- Carrier blocks are **real children of the owner node** (`parent_id = owner`; containment derives from the tree — no placement fields) → containment, backlinks, `refset` roll-up, queries, and export resolution all work. The carrier's own children are ordinary blocks under the carrier; the body-exclusion rule filters only direct carriers.
- **Unset deletes the carrier** (trash + retention, consistent with node deletion). **"Promote to block" is a separate gesture** — reparent the carrier into the owner's body.
- Multi-value `text` = m2m list of carrier block ids, each with its own subtree.

## Citations — source family and authorship (NORMATIVE, FINAL owner decision 2026-09-27)

History: the owner first asked for text authors + optional links, then reversed — *"commit fully to authors as a property linked to agent-classed nodes"* (and rejected an author→person link-suggestion lint: linking stays user-configured). This section is the FINAL state.

- **`source` is the base class; subclasses extend it.** Seeded source family: `book`, `paper`, `article`, `thesis`, `document`, `movie`, `song`, `tv_series`, `conference` — all `extends: [source]`. Users may define their own source subclasses at runtime (classes are data; `extends [source]` joins the family and `class:source` queries see them via the hierarchy). Import maps entry types onto the family (unknown → `document` fallback).
- **`authors` is a node-typed multi-value property on `source`, targeting `agent`** (fixed UUID …0000-000000000012; `targetClassFilter: ["agent"]` — `person` and `organization` both extend `agent`). Full commitment: bibliography authors ARE agent nodes (backlinks, queries, the Lewis person node is just an author link). **Import find-or-creates agent nodes** for authors (exact-name match, else create a `person`); export resolves their names.
- **`linkedAuthors` is WITHDRAWN** (introduced 2026-09-27, reversed same day): UUID `00000000-0000-0000-0000-000000000025` must never be reused (v1 `locator` …0018 precedent).
- **No link-suggestion lint** (owner decision): whether/how authors map to person nodes is user configuration, not app behavior.

## Sources as containers — files, properties, notes (NORMATIVE, owner decision 2026-09-27)

A **source node is the Zotero-style container**: its files are **asset nodes** linked via the multi-value node-typed `attachments` property (seeded on `source`, fixed UUID `…0000-000000000011`, `targetClassFilter: ["asset"]`); its bibliographic data lives in the source property family (title/authors/linkedAuthors/doi/isbn/publicationDate/publisher/citekey/url); its **notes are ordinary child blocks** (full grammar, backlinks, focused view — nothing special to build). One source, many files, properties on the source, thinking in the tree. Asset nodes stay content-addressed and independently lifecycle'd; the property only links.

## Dates — year/month/day nodes, precision, ranges, link qualifiers (NORMATIVE, owner 2026-09-27)

- **A date is a node, not a string.** Date property values reference the workspace's **year / month / day node chain** (system classes `year`/`month`/`day`, deterministic UUIDs from the date — v1's `generate_day_uuid` scheme, ported to `@notees/domain`). Setting a date **auto-creates the chain** (year node, month node under it, day node under that — deterministic ids make the creates idempotent no-ops on existing nodes) and links the value: `{ "nodeId": <dayNodeId> }`. Dates thereby participate in the graph for free: backlinks on a year node list everything dated that year; journals are ordinary trees of day nodes.
- **Precision scoping**: a date property schema declares `datePrecision: "year" | "month" | "day"` (default `"day"`). year-precision links the YEAR node; month links the MONTH node. Values never claim finer granularity than the schema allows.
- **Date ranges**: the `date_range` property type (already in the type enum) has value `{ "start": <date-ref|null>, "end": <date-ref|null> }` — either side open. Precision applies to both ends.
- **Link qualifiers (dates for links)**: a node-typed property schema may set `dateQualified: true`; then each value may carry `metadata.startDate` / `metadata.endDate` (ISO date strings — node-backed date qualifiers are a possible M2 evolution; strings keep M1 simple). The properties panel renders a small range control next to qualified link chips.
- **Picker UX**: one date-selection component with **zoom levels** — a year grid, a month grid, a day grid — switching freely between them; the precision ceiling is the schema's (a year-precision property zooms months/days only to show context, committing at year). Ranges use the picker per end.
- **Storage/convergence**: values are ordinary property JSON; the chain creation rides the op log (client-emitted creates, deterministic ids); edge projection treats date refs like node-typed values (backlinks/journals).
- [x] **Protocol↔query dependency cycle** — DONE 2026-09-27: the zod AST model moved from `packages/query/src/ast.ts` to `packages/protocol/src/query-ast.ts` (the wire-adjacent home — the content grammar's `query` token embeds it, so protocol must not depend on query). `packages/query/src/ast.ts` is now a thin re-export from `@notees/protocol`, so every `import { … } from "@notees/query"` path (apps, compiler/dsl/executor) is unchanged; query runtime-depends on protocol, protocol depends on no workspace package. Both Dockerfiles dropped the explicit `for p in query protocol …` build loop — `pnpm --filter @notees/server... build` / `…web... build` rely on pnpm's topological order, and clean-tree `pnpm -r build` works with no manual ordering.
