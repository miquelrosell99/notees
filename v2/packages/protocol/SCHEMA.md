# SCHEMA.md — Property-Schema, Class-Structure, and Typed-Link Token Spec

Status: **stub — owed-work register, normative only where marked OWED→DONE.** Companion to `v2/docs/design/01-knowledge-model.md` (normative model statement). Supersedes the retired `RELATIONS.md` (first-class relation entities were deleted 2026-09-25; see `02-model-assessment.md` §6).

> Storage truth: **the operation log is the truth; this document specifies how semantic state is expressed in ops and derived rows. Export is a projection, not a round-trip.**

## Owed work (from 02-model-assessment.md §9, plus adopted amendments)

- [ ] **Property-value semantics** — m2o/m2m node-typed values, per-value `metadata` JSON (qualifiers like `since`, `locator`), m2m tombstones.
- [ ] **Typed-link mark grammar** — word marks, free verbs vs property-schema refs, create-and-bind, orphan/broken rendering, escape-hatch pill. Minimal shape below; full grammar owed.
- [ ] **Block-level content tokens** — embed (transclusion, two-way editing), query (live query blocks rendered inside the editor), asset (image/file blocks), whiteboard. Inline marks are specced; block-level tokens are owed and are load-bearing for editor parity (§34.10).
- [ ] **RECORD, DON'T RESOLVE** *(adopted amendment, 2026-09-25)* — typed-link capture MUST record candidate target spans as an **ordered list of token IDs** in token metadata; nothing smarter. No scoring, no filtering at capture: deferring the *resolution rule* to M2 is sound, deferring the *recording* is data loss — the sentence context present at capture time is irrecoverable later. Candidates give M2 real data to design against.
- [ ] `extends` closure + binding-resolution normative statement (own → shortest extends-path → earliest HLC; cycles fail-loud).
- [ ] Configuration registry schema (`property_schema`, `class_property` rows).
- [ ] Backlink roll-up + filter-inheritance semantics (`refset(n) = own_links(n) ∪ refset(parent(n))`); fan-out-at-projection vs traversal-at-query-time decision (M1 spike).
- [ ] Typed-link target-resolution design — DEFERRED to M2 by owner decision; register only, do not spec (see 00-INDEX "Deferred").
- [ ] Typed-link UX spec (capture flows, editing contract).
- [ ] Class lifecycle/protection validation rules; promotion/lint gesture specs.
- [ ] Fixture re-encoding against this model — the blocking acceptance gate; deleted relation fixtures are replaced by typed-link-mark fixtures exercising the same acceptance scenarios (see `fixtures/typed-link-mark*.json`).

## Typed-link mark — minimal shape (OWED → full grammar above)

A typed link is a **mark on a prose word** (01-knowledge-model.md §9): nothing is inserted; the word you wrote is the annotation.

```jsonc
{
  "type": "typed_link",
  "verb": "cites",                        // free string, or { "propertySchemaId": "<uuid>" } when bound
  "text": "cites",                        // the marked word as written
  "metadata": {
    "locator": "p. 42",                   // optional token metadata (e.g. from PDF selection)
    "candidateSpans": ["tok_3", "tok_7"]  // RECORD, DON'T RESOLVE: ordered token IDs, nearest first
  }
}
```

Rules: delete the word and the mark dies with it (honest lifecycle); marks ride inside the CRDT-synchronized AST text; the pill (`node_link`) survives only as the escape hatch when there is no natural verb.
