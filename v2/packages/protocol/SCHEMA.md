# SCHEMA.md — Property-Schema, Class-Structure, and Typed-Link Token Spec

Status: **stub — owed-work register, normative only where marked OWED→DONE.** Companion to `v2/docs/design/01-knowledge-model.md` (normative model statement). Supersedes the retired `RELATIONS.md` (first-class relation entities were deleted 2026-09-25; see `02-model-assessment.md` §6).

> Storage truth: **the operation log is the truth; this document specifies how semantic state is expressed in ops and derived rows. Export is a projection, not a round-trip.**

## Owed work (from 02-model-assessment.md §9, plus adopted amendments)

- [ ] **Property-value semantics** — m2o/m2m node-typed values, per-value `metadata` JSON (qualifiers like `since`, `locator`), m2m tombstones. (The `metadata` column and `targetClassFilter` are already in the op schemas.)
- [x] **Typed-link mark grammar** — SPECCED (Content grammar below): free verbs vs property-schema refs; create-and-bind UX remains owed. Orphan/broken rendering owed.
- [x] **Content tokens** — SPECCED (Content grammar below): flat token stream; quote/query/whiteboard/asset_ref/embed_ref are tokens, not segments. **Embed rule: render the live subtree — the real child nodes, never a clone**; live updates and editing-through-the-embed then ride the standard notification/op path. Cycle guard (depth cap + visited set) is a renderer obligation. Embed two-way-editing semantics + asset display tiers remain owed.
- [ ] **Link analytics ("node links table")** — `node_link` assertion rows carry per-link: stable link UUID, `sourceId`, `targetId`, `createdAt`, `updatedAt`, `clickCount`, `lastNavigatedAt` (v1 port; ASSERTIONS category in `01` §3). Granular per-visit history (`link_visit`: link id, actor, timestamp) is a DERIVED log scheduled with M2 statistics/aging — derived means zero protocol cost.
- [ ] **Class-chip lint** — with render-only chips (below), a lint may suggest "chip present but node not classed — assign?"; suggestion only, never enforcement (design law).
- [ ] **RECORD, DON'T RESOLVE** *(adopted amendment, 2026-09-25)* — typed-link capture MUST record candidate target spans as an **ordered list of token IDs** in token metadata; nothing smarter. No scoring, no filtering at capture: deferring the *resolution rule* to M2 is sound, deferring the *recording* is data loss — the sentence context present at capture time is irrecoverable later. Candidates give M2 real data to design against.
- [ ] `extends` closure + binding-resolution normative statement (own → shortest extends-path → earliest HLC; cycles fail-loud).
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
- **Paragraph vs line break:** `hard_break` = shift+enter (soft, same paragraph); `paragraph_break` = real paragraph within the block (spacing). Enter creates a new bullet node.
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
| `whiteboard` | `layout` | shapes/strokes/viewport |
| `external_link` | `href`, `text` | |
| `math` | `expression` | KaTeX source |
| `hard_break` | — | shift+enter |
| `paragraph_break` | — | paragraph within block |

Typed-link rule: a typed link is a **mark on a prose word** (01-knowledge-model.md §9) — nothing is inserted; the word you wrote is the annotation. Delete the word and the mark dies with it; marks ride inside the CRDT-synchronized content (per-node `Y.Text` over the serialized token array — v1 port; canonical wire carrier `contentDeltaB64`, readable carrier `contentAst`). Plaintext for FTS is derived by the applier, never stored as truth. Per-field CRDTs remain a documented M3+ option if real-time collaboration ever demands finer granularity.

Storage of the token array: the block node's content serializes into its per-node CRDT; content ops (`object.create/update`) are the only write path — **no token type introduces a new op or sync primitive**.
