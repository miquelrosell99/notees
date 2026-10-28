# Memorization Cards — Design Spec

Date: 2026-10-28 · Status: approved design, pre-implementation
Clients in scope: **web, GTK, Flutter** — all three ship the full feature (seeds, `card.review` applier, hub, review session).

## 1. Intent

Notees gains a spaced-repetition memorization system built on the existing object graph:

- A renamed system class, **Memorization card** (existing UUID `00000000-0000-0000-0001-000000000011`, TS key `card` unchanged), is the card carrier.
- A card **is** a note: front = the card node's content; back = **all embedded children** rendered as a read-only outline (one block or many). Non-embedded children are ordinary related pages, not part of the answer. A card with no embedded children is a front-only self-test prompt, still reviewable.
- A dedicated **Cards hub** (sidebar entry, `/cards`, embedded query builder) lists cards in buckets and starts review sessions over any filtered subset.
- A **review session** presents due + new cards from that subset with reveal + 4-grade self-rating, scheduled by **SM-2 or FSRS** (per-user selectable).

Success: a user can turn any block or page into a card from existing notes, review a due queue on any client, and have schedule state converge across devices through the op log.

## 2. Model

### 2.1 Class rename

- Display name `Card` → `Memorization card`; icon `mdiCardOutline` → `mdiCardsPlayingOutline` (final icon call at the design-system pass; the Flutter/GTK equivalents ride along).
- TS seed key stays `card` forever; the UUID is unchanged (withdrawn UUIDs are never reused, existing ones are never re-keyed).
- Live workspaces converge by a `scripts/migrate-system-names.mts`-style migration: append-only envelopes (`class.update` with new `contentAst`), dry-run first, `--apply` through `RelayStorage.ingest`, validated through zod before insert.
- Gallery description updates from "A compact summary card for an entity." to a memorization wording.
- `card` keeps its current platform posture: always-on, not locked, `parentlessRole: "block"`, no extends edges (frozen to the empty set).

### 2.2 Card family schemas (`CARD_FAMILY_SEED`)

Task-family precedent (`TASK_FAMILY_SEED` + `ensureTaskFamily` at `apps/web/src/features/classview/taskFamily.ts`): six class-bound, **unpinned** property schemas authored on demand by an `ensureCardFamily` convergent between applier-side ensure and client self-heal:

| Key | Type | Meaning |
|-----|------|---------|
| `cardDue` | `datetime` | Next due date; day-node anchored like `taskScheduled` (optional wall-clock per the amended time-of-day law). Absent = unseen ("New") card. |
| `cardReps` | `number` | Successful-repetition count |
| `cardInterval` | `number` | Current interval in days |
| `cardEase` | `number` | SM-2 ease factor |
| `cardDifficulty` | `number` | FSRS difficulty |
| `cardStability` | `number` | FSRS stability (days) |

`number` is an existing protocol property type (`packages/protocol/src/op-types.ts:397`) with no seed users yet — this family is its first.

State authority: **live schedule state lives in these property values** (ordinary LWW property ops, queryable, convergent). New schema UUIDs are minted for the family (never reused).

### 2.3 Per-user algorithm preference

Server coordination state via the existing prefs route pattern (`apps/server/src/routes-prefs.ts`): key `cards.algorithm`, values `sm2` | `fsrs`, default `fsrs`. This is coordination, not object state — it never enters the op log.

## 3. Wire: the `card.review` op

New additive op type, registered in `packages/protocol/src/op-types.ts` (`OP_PAYLOAD_SCHEMAS`, `.strict()`):

```jsonc
{
  "cardId": "<uuidv7>",            // node classed memorization card (applier-validated)
  "grade": "again" | "hard" | "good" | "easy",
  "algorithm": "sm2" | "fsrs",     // algorithm that produced stateAfter
  "stateBefore": { /* schedule state snapshot */ },
  "stateAfter":  { /* schedule state snapshot */ },
  "reviewedAt": "<hlc>",
  "sessionId": "<uuidv7>"          // groups one session's reviews
}
```

`stateBefore`/`stateAfter` carry the applicable fields of §2.2 (due/interval/ease or stability/difficulty/reps — whatever the algorithm touches).

Applier semantics (`packages/store/src/appliers.ts`): validate the target node carries the card class (fail loud otherwise — impossible states are write-time impossible); append the row to a derived `card_review` history table. **The op is history/audit only — it never writes property values.** The reviewing client writes the new schedule state as ordinary `property.set` ops in the same batch. One authority for state (properties), one authoritative history (the log) — no dual-write drift, and the history is what later FSRS parameter fitting consumes.

Fixture gate (blocking): `packages/protocol/fixtures/card-review.json` exercising the TS reference applier **and** the GTK and Flutter appliers, byte-identical, sha256-checked. Clients reject malformed payloads per envelope v3 strictness.

## 4. Algorithms

Pure-function module, no I/O: `nextState(state, grade, algorithm, now) → state'`.

- TS home: `packages/domain/src/srs.ts` (+ tests in `packages/domain/test/`).
- SM-2: canonical ease-factor/interval update; grade mapping again=1, hard=3, good=4, easy=5 internally.
- FSRS: FSRS-5 update with fixed default parameters. **Parameter fitting from `card_review` history is a designed follow-up, not v1.**
- GTK/Flutter hand-port the module against the same unit-test vectors (the fixture/vector corpus is shared; per-client test suites carry the same cases).

## 5. Cards hub

- `NavKey` `cards` + `NAV_ENTRIES` row in `apps/web/src/ui/app/Sidebar.tsx`; `NAV_PATHS` `/cards` in `routing.ts`; AppBody branch; tab title "Cards - Notees" (law 9: URL + title or neither).
- Hub shell rides `CollectionHub` with the embedded `FilterBlockBuilder`; default filter `classAny` = memorization card. Any subset (tags, properties, extends-descendants of card, links) is reviewable.
- Buckets derived client-side from `cardDue` (TaskBuckets precedent): **Due** (today or past), **New** (no `cardDue`), **Later**.
- Header action **Review now**; per-row `trailingAction` **Review** button (`NodeCollectionItem.trailingAction` precedent). Both start a session over the hub's current filtered set.
- GTK and Flutter get equivalent hub surfaces on their own navigation idioms.

## 6. Review session

- Deep-linkable surface `/cards/review` (web; GTK/Flutter equivalents), owns URL + tab title "Review - Notees".
- Queue: due-today cards (due-date order) then new cards (end of queue), drawn from the invoking subset.
- Interaction: front (card content rendered) → **Reveal** → back (embedded children outline, read-only) → grade bar **Again / Hard / Good / Easy**, keyboard 1–4.
- Each grade writes: `property.set` ops for the new schedule state + one `card.review` op, in one batch. Session-local mistakes roll back through the existing per-tab undo journal for the property ops (client convenience); the `card.review` history row is append-only and stays — it is audit trail, and the scheduler treats property state as authority, so a reverted grade simply doesn't affect the schedule.
- Progress indicator (n/total); end-of-session summary (reviewed, lapses — `again` on a card with reps > 0). Summary is client-derived, not persisted.
- After the session the hub re-derives from projections (no special refresh machinery).

## 7. Creation flows

- **From existing notes**: "Make memorization card" block/page action — class-assigns `card`; existing embedded children become the answer as-is.
- **Quick-create** in the hub ("New card"): parentless card-classed node, front = typed text, answer appended as an embedded child.
- Gallery deploy entry reuses `deploySystemClass` with updated description.

## 8. Client scope

| Client | Seeds + manifests | `card.review` applier | Hub | Review session | Release |
|--------|-------------------|----------------------|-----|----------------|---------|
| Web (`apps/web`) | yes | yes (TS reference) | yes | yes | this repo's compose stack |
| GTK (`notees-gtk`) | yes (`features.py`) | yes | yes | yes | GTK repo's own release |
| Flutter (`notees-flutter`) | yes (`system.dart`, `local_workspace_seed.dart`) | yes | yes | yes | Flutter repo's own release |
| CLI (`notees-cli`) | via pinned `vendor/notees` submodule | yes (TS) | n/a | n/a | CLI repo's own release |

Each client owns its release; the lockstep obligation is seeds, wire, fixtures, and algorithm vectors — all converging in the same slice.

## 9. Convergence, docs, slices

**Migration/convergence**

- Class rename: `migrate-system-names.mts`-style append-only pass, dry-run first (Path A).
- `CARD_FAMILY_SEED`: new schema UUIDs; applier-side ensure + client self-heal; no live-log migration needed (schemas arrive through the ensure path).

**Docs (same pass as each slice)** — `packages/protocol/SCHEMA.md` (op + family), `docs/features/memorization-cards.md` (new), `docs/feature-status.md`, seed-manifest notes for GTK/Flutter in their repos, per-slice `CHANGELOG.md` entries.

**Slices (each: gate green + changelog + push, then next)**

1. Rename + `CARD_FAMILY_SEED` + `ensureCardFamily` + convergence migration + client seed manifests.
2. `card.review` op: zod payload, TS applier + `card_review` derived table, fixtures, GTK/Flutter appliers.
3. SRS module (`packages/domain/src/srs.ts`) + shared vectors + GTK/Flutter ports.
4. Cards hub (web) + GTK hub + Flutter hub.
5. Review session UI (web, GTK, Flutter).
6. Docs sweep + feature page + feature-status.

## 10. Out of scope (v1)

Notifications/reminders · typed-recall grading · per-card algorithm override · FSRS parameter fitting · daily new-card caps · leech handling/suspension · shared/public review · CLI review commands · undo across sessions (per-tab undo journal only).

## 11. Defaults chosen (correctable)

- Default algorithm: `fsrs`.
- Icon: `mdiCardsPlayingOutline` (design-system pass confirms).
- Queue order: due first (due-date order), new cards at the end.
- Review session grading: reveal + 4-grade self-rating only.
