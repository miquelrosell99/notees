# Notees Greenfield — Key Model Assessment
**Synthesis of the 2026-09-24/25 design conversation.** Status: converged. Feeds `docs/knowledge-model.md` and `packages/protocol/SCHEMA.md`.

---

## 0. How we got here

1. **Rewrite decision** — greenfield validated (Revision 4/5: narrowed M1 relations, RELATIONS.md-first, blocking fixture gate).
2. **Knowledge model** — one object graph, op log as sole authority, every interface a projection.
3. **Storage model** — five of v1's class-split rationales examined; the split was reverted (classes are nodes).
4. **Relations rethink (2026-09-25)** — the first-class *relation entity* layer itself was then replaced: associations are **node-typed properties** (Odoo-style m2o/m2m), discourse connections are **typed links as marks on prose words** (free verbs or schema refs, token metadata for locators), and both feed one derived edge index. M1's former "relations core" — the plan's highest-rated risk — was deleted entirely.
5. **Late corrections (2026-09-25)** — three: (a) typed-link **target resolution explicitly deferred** (semantic design question; no rule specced, the "nearest mention" heuristic was rejected as oversimple); (b) the editor is a **Logseq-style outliner** — bullets, each bullet a block is a node (indent/outdent reparents, reorder changes sibling order; v1's TreeCrdt + fractional-position machinery ports over); (c) links **propagate along the containment tree in both directions** — backlinks roll up to ancestors, and filter inheritance flows down recursively (`refset(n) = own_links(n) ∪ refset(parent(n))`: containment in a page counts, and a block's links pass to everything nested under it — the trigger is the link on the block, not page location).

## 1. The model in one sentence

> **One node table for every entity; attributes in properties; discourse in the content; one derived index behind every view; the operation log is the only authority; every usage prediction is a default, never a prohibition.**

## 2. The five storage categories

| Category | Members | Rule |
|---|---|---|
| **ENTITIES** — single `node` table | objects, blocks, classes, collections, asset metadata | UUIDv7 identity; addressable, linkable, annotatable, provenance |
| **CONFIGURATION** — registry | `property_schema`, class bindings (`class_property`) | typed rows, UUID-keyed, user-definable, deprecatable, description column |
| **ASSERTIONS** — rows, never nodes | `property_value` (+ `metadata` JSON), `node_link`, `node_asset` | facts *about* entities; typed, LWW, tombstoned |
| **DERIVED** — rebuildable | `edge` index (mentions + typed links + node-typed properties), `class_hierarchy` closure, effective membership, bindings read model, `search_index`, `node_stats`, backlink rollup | applier-maintained; wipe → replay → identical |
| **INFRA** — never ops | `sync_*`, `crdt_state`, `device_asset`, snapshots | client-local; semantic state only in the log |

**Entity line:** a thing is a node iff its lifecycle happens in the user's mind. Classes pass; property schemas fail. **Meta-layer test:** if uniformizing X requires a parallel attribute system, X is configuration, not an entity. v1's error was never the `property_schema` table — it was splitting *classes* out of the graph.

## 3. The three orthogonal axes

Class (`class_ids` — what it is) · parent (`parent_id` — where it lives; a tree) · kind (`page|block` — how prominent; soft, LWW, flippable; `page` is a query over content nodes). Promotion = flip kind; identity preserved. Nodes form a tree (scalar parent); classes form a DAG (`extends` is transitive, many-to-many — which is why extends is an *m2m property* and parent_id is a *field*).

## 4. Blocks are nodes — the outliner model

**The editor is Logseq-style: bullet points, and each bullet is a block is a node.** Backlinks, links, embeds, promotion — blocks get full node citizenship (the owner rejected the "blocks stay part of the page AST" approach precisely because node-ness makes promote-to-page and demote-to-block trivial). Indent/outdent reparents (`node.move` + TreeCrdt); reordering changes sibling order (fractional position strings + TreeCrdt — v1's proven machinery, ported). Long-form writing emerges from nesting bullets; a page's content is its bullet tree.

All authoring happens in blocks: prose, facts-as-blocks, discourse moves, inline links. Display defaults keep blocks quiet (aggregated backlinks, collapsed graph children, root-first search). *First-class storage, second-class display.*

## 5. Classes are nodes — the split, post-mortem

**The five v1 rationales, and their verdicts:**

| v1 justification | Verdict |
|---|---|
| "Classes are set, never linked" | Set and link are one relationship; unaddressable types made them feel different. Logseq DB / Tana converged on the same correction. |
| "Classes have no children/properties" | Falsified by templates and class-level config. Right as usage profile, wrong as prohibition. |
| "A class is a configuration object, not where content lives" | **Accepted as the norm** — with a one-shelf exception: a description. Content about instances lives in topic pages (the Meetings pattern). |
| "Nodes have parents (tree); classes have `extends` (DAG with inheritance)" | **Valid semantics — derived-layer semantics.** Closure + effective membership are applier projections; behavior preserved verbatim from v1. |
| "Split saves columns (extends vs parent_id)" | **Column economics — weakest of all.** `extends` isn't a column in greenfield (it's property values); NULL columns cost ~0 bytes in SQLite; v1 paid real complexity to save storage never consumed. |

**Settled design:** classes are nodes, tree-external (`parent_id` always NULL; `node.move` rejects class parenting, fail-loud; content projections exclude classes by default). Structure as data: `extends` = m2m node-typed property on class nodes (multiple inheritance from the start); `has-property` bindings = registry rows; `has-template` = node-typed property to an ordinary template node — brief at `../implementation-plan.md` §34.25 (2026-10-02): class-side, `multi`, apply-time clone, no wire change; owner decisions D1-D4 pending. Binding resolution: own binding → shortest extends-path → earliest HLC. Cycles fail-loud. System classes protected by validation on seeded UUIDs; class deletion never cascades; `node_alias` survives for true synonyms only.

**The alias anecdote closed the case:** v1 needed a manual alias to aggregate a class and its topic page — a workaround for the split that the unified model dissolves into a default view.

## 6. Relations → properties + prose-word marks (the 2026-09-25 rethink)

The first-class relation entity (own UUID, tombstones, relation-schema registry, seeded epistemic vocabulary, the 11-dimension RELATIONS.md spec) was **replaced**, on the owner's pushback, with three information layers over one index:

1. **Attributes** — node-typed properties (m2o/m2m, Odoo-style) + per-value `metadata` JSON for qualifiers (`since`, `locator`).
2. **Discourse connections** — **typed links as marks on the prose words you wrote**: select a word (or type it via `@`), bind a verb (property-schema ref *or free string*); token metadata carries locators. **Nothing is inserted — the word you wrote is the annotation**, so no phrase-flow break and no duplicated information. The pill survives only as the escape hatch when there is no natural verb. Lifecycle is honest: delete the word, the claim dies with it.
3. **Plain prose** — everything else, incl. facts-as-blocks and untyped mentions ("Located in <<Paris>>").

All three feed the derived `edge` index; backlinks group by verb.

**Link propagation along the containment tree — both directions:**
- **Roll-up (backlinks):** a block mentioning <<Paris>> — child of the "France" page — appears in the backlinks of **both** Paris and France.
- **Flow-down (filter inheritance):** a node matches `linked-to:X` when X ∈ its **reference set**, defined recursively — `refset(n) = own_links(n) ∪ refset(parent(n))`, transitive by construction. Containment inside page P itself counts as referencing P; a block carrying a link passes it to everything nested under it, at any depth. The trigger is the *link on the block*, not page location. *Example:* a bullet linking ACME with a nested child bullet linking Jane — `linked-to:ACME AND linked-to:Jane` returns the child, no explicit tagging. Inheritance governs **filtering, not membership**: backlinks list actual links, but the backlinks view is narrowed with facets over inherited links (Logseq-style) — Jane's backlinks filtered to `refset ∋ ACME` shows only Jane-mentions in the context of ACME, even when the ACME link lives on a parent block. Derived edges store distance so depth dilution is a ranking matter.

Properties are **optional by constraint**: no core flow depends on them; promotion gesture + lint suggestions, never inference. Property-vs-typed-link guidance: attribute-of-object → property; verb-in-a-sentence → typed link.

**Why this is right (not just simpler):** it deletes M1's highest-rated risk (a new sync primitive) — everything rides v1-proven property machinery plus one `metadata` column and AST tokens. And the seeded vocabulary objection was the design law catching us: predefined relation types were a vocabulary prediction hardened into protocol — demoted to documented conventions.

## 7. Where knowledge lives

Claims/facts as `claim`-classed objects (content = the claim in your words); provenance via `cites` typed links with locators; epistemic wiring via free-verb or bound-schema typed links (`supports`/`contradicts`/`refines`); `question`-classed objects with an open-questions query-collection. Evergreen/Zettelkasten discipline = convention enabled, never enforced.

## 8. The design law

> **Encode usage predictions as defaults, linter rules, and generated views — never as schema prohibitions.**
> **Corollary (meta-layer test):** if uniformizing X requires a parallel attribute system, X is configuration, not an entity.

v1's expired prohibitions: the `kind` CHECK; set-only classes; content-less classes. Nearly repeated: seeded epistemic relation vocabulary (caught 2026-09-25).

## 9. Confidence ledger

**High confidence:** sync core (ported, blocking acceptance gate); storage categories; unified node table with soft kind (v1 shape, hard semantics removed); class inheritance *behavior* (v1 semantics, new source of truth); property-based associations (v1 machinery + one column); two-way link propagation (semantics fixed; fan-out vs traversal is an implementation choice).

**Medium confidence:** classes-as-nodes (largest departure; lifecycle/protection rules to spec); typed-link UX (the create-and-bind gesture is the make-or-break; mark-on-word rendering unproven); the Logseq-style outliner as the *only* editor (the deliberate bet against document-mode editors — long-form writing feel untested); scale — S2 spike (blocks + classes as rows; rollup index size).

**Deferred / open questions (explicitly undecided — do not spec):**
- **Typed-link target resolution** — how a verb mark resolves its target mention(s) is a semantic design question depending on real usage consistency; the "nearest mention" heuristic was rejected as oversimple. Design with usage data (M2), without protocol breakage.
- **Class-down propagation for filtering** — should a node's classes flow down the tree like links do? Flagged, unanswered.
- **`has-template` placement** — node-typed property proposal; elaborated into the `../implementation-plan.md` §34.25 design brief (2026-10-02: class-side, `multi`, templates-as-nodes, client-side clone, no wire change). Owner confirmation of D1-D4 there is pending; until then register only.

**Untested assumption to watch:** typed-link capture friction; outliner long-form feel; S2 corpus results.

**Deleted risks:** the relation-entity op-set (formerly R1, High) — gone by design.

**Structural reason for calm:** residual uncertainty sits only in deferrable, derived, or gated places. Nothing uncertain is load-bearing for sync.

**Owed work (feeds SCHEMA.md):** property-value semantics incl. `metadata` column and m2m tombstones; typed-link mark grammar (word marks, free verbs vs schema refs, create-and-bind, orphan/broken rendering, escape-hatch pill); `extends` closure + binding-resolution normative statement; registry schema; backlink roll-up + filter-inheritance semantics (fan-out vs traversal decision); typed-link target-resolution design (deferred, register only); typed-link UX spec (capture flows, editing contract); class lifecycle/protection validation rules; promotion/lint gesture specs; UI sugar (class creation, promote/demote, topic-page generator, template instantiation); fixture re-encoding; S2 spike. `RELATIONS.md` is retired — its remaining content folds into SCHEMA.md.
