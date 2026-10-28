# Memorization Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the memorization cards feature in the Notees monorepo — renamed `card` system class, card-family property schemas, the `card.review` wire op, SM-2/FSRS scheduling, the Cards hub with embedded query builder, and the review session — for the web client, with GTK/Flutter seed + op-applier lockstep alignment.

**Architecture:** The card class (existing UUID `…0011`) is renamed and gains six class-bound property schemas via a `CARD_FAMILY_SEED`/`ensureCardFamily` (task-family precedent). Live schedule state lives in those property values (ordinary LWW property ops); a new additive op `card.review` appends authoritative history to a derived `card_review` table. Scheduling is a pure function in `packages/domain/src/srs.ts` (`nextCardState`). The hub and review session are pure client views over the projection. GTK/Flutter align on seed manifests + the `card.review` applier in the same slices; their hub/review UI is separate follow-up plans in their own repos.

**Tech Stack:** TypeScript (Node 22, pnpm 9, vitest), React/Vite web app, zod envelope v3, better-sqlite3 + sql.js store adapters.

**Spec:** `docs/superpowers/specs/2026-10-28-memorization-cards-design.md` (read it first — this plan argues from it).

## Global Constraints

- Work happens in the worktree `/root/projects/notees/.worktrees/memorization-cards` on branch `memorization-cards`. Never build or deploy from the worktree; sibling-repo work (GTK/Flutter) happens in their own repos on their own branches.
- Blocking gate before every commit: `pnpm typecheck && pnpm test` from the worktree root, all green.
- **Dev-condition exports**: after changing a package's public API, rebuild its dist before typechecking dependents — run `pnpm -r --workspace-concurrency=1 build` (or at least build the changed package and its dependents).
- The TS seed key stays `card`; the class UUID `00000000-0000-0000-0001-000000000011` is unchanged. Withdrawn UUIDs are never reused.
- New property schema UUIDs use a fresh namespace: `00000000-0000-0000-0004-000000000001` … `-000000000006` (task family owns `…0003…`; never reuse).
- New wire keys are additive and `.strict()`; retired keys are rejected outright — no backward compatibility.
- Card-family schemas seed **unpinned** (the 2026-10-27 pinned roster is frozen: source family, meetingDate+location, taskStatus/Scheduled/Deadline).
- Fixtures: a new fixture file must be added to BOTH `packages/protocol/fixtures/` AND the name list in `packages/protocol/test/protocol.test.ts:47-92` (currently 44 names → 45).
- Store schema changes: bump `SCHEMA_VERSION` (`packages/store/src/schema.ts:31`, currently 34 → 35) with a `current < 35` delta block in `migrate()`.
- UI chrome composes from `apps/web/src/components/ui/kit/` — one element per file, co-located CSS, token-only CSS; no ad-hoc styled controls in feature code.
- Every view surface owns its URL AND its tab title (law 9) — deep-linkable pushState/popstate route plus a `tabTitle` branch.
- Fail loud: impossible states are write-time impossible (`MoveGuardError` or dedicated error, thrown, never applied).
- The changelog is the record: one `CHANGELOG.md` entry per landed slice, prepended under the current `## YYYY-MM-DD` heading, format mirroring the top entry (bold `type(scope): summary — rationale.**`, numbered rationale, `Verified:` line, nested `- **Files**:` bullet). Never record personal-workspace specifics.
- Docs are part of the change: `packages/protocol/SCHEMA.md` and user docs move in the same pass as the behavior.
- Commit style: Conventional Commits, per-file staging only (never `git add -A`), push to `memorization-cards` branch.
- The test workspace (fixed seed uuid) is the only workspace for any live probing; never touch the owner's live workspace.

## Review Focus

1. **Front-only card (no embedded children)** — reviewed like any card; reveal shows an explicit "no answer" empty state, grading still works. (Pinned in Task 9.)
2. **Unseen card (no `cardDue` value)** — first grade must initialize algorithm state from defaults (SM-2 ease 2.5; FSRS default difficulty/stability), not produce NaN/zero intervals. (Pinned in Task 5.)
3. **Algorithm switch mid-deck** — a card last reviewed under SM-2 (ease set, stability null) graded under FSRS must initialize FSRS fields from defaults and vice versa; stale fields from the other algorithm must not corrupt the result. (Pinned in Task 5.)
4. **Two devices reviewing the same card concurrently** — both `card.review` envelopes apply, both history rows land, property LWW picks a winner, no crash and no dedupe of history. (Pinned in Task 4.)
5. **Undo of a grade** — the undo journal reverts the property ops but cannot retract the append-only `card.review` row; the scheduler must treat property state as authority so the card's schedule follows the revert. (Pinned in Task 9 step; asserted by Task 5's state-authority design.)

---

### Task 1: Rename the card class + author the CARD_FAMILY_SEED schemas

**Files:**
- Modify: `packages/domain/src/seeds.ts` (display name at `:218`, gallery description at `:306`, icon at `:128`)
- Modify: `packages/domain/src/features.ts` (no change expected — verify `card` posture unchanged)
- Modify: `apps/web/src/features/classview/systemClassDeploy.ts:301` (gallery description wording)
- Test: `packages/domain/test/seeds-cards.test.ts` (new)

**Interfaces:**
- Consumes: existing `SYSTEM_PROPERTY_SPECS` shape (`{type, multi?, bindTo?, pinned?, ...}` per `seeds.ts:786-891`), `TASK_FAMILY_SEED` pattern (`seeds.ts:1205-1246`).
- Produces (later tasks rely on these exact names):
  ```ts
  // packages/domain/src/seeds.ts
  export const CARD_PROPERTY_UUIDS = {
    cardDue:        "00000000-0000-0000-0004-000000000001",
    cardReps:       "00000000-0000-0000-0004-000000000002",
    cardInterval:   "00000000-0000-0000-0004-000000000003",
    cardEase:       "00000000-0000-0000-0004-000000000004",
    cardDifficulty: "00000000-0000-0000-0004-000000000005",
    cardStability:  "00000000-0000-0000-0004-000000000006",
  } as const;
  export const CARD_FAMILY_SEED: ReadonlyArray<{
    property: keyof typeof CARD_PROPERTY_UUIDS;
    name: string;
    type: "datetime" | "number";
  }> = [
    { property: "cardDue",        name: "Card due",        type: "datetime" },
    { property: "cardReps",       name: "Card reps",       type: "number" },
    { property: "cardInterval",   name: "Card interval",   type: "number" },
    { property: "cardEase",       name: "Card ease",       type: "number" },
    { property: "cardDifficulty", name: "Card difficulty", type: "number" },
    { property: "cardStability",  name: "Card stability",  type: "number" },
  ];
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/seeds-cards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CARD_FAMILY_SEED,
  CARD_PROPERTY_UUIDS,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
} from "../src/seeds";

describe("memorization card family seeds", () => {
  it("the card class display name is Memorization card (TS key unchanged)", () => {
    expect(SYSTEM_CLASS_DISPLAY_NAMES.card).toBe("Memorization card");
    expect(SYSTEM_CLASS_UUIDS.card).toBe("00000000-0000-0000-0001-000000000011");
  });

  it("card family schemas are six, class-bound, unpinned, unique uuids", () => {
    expect(CARD_FAMILY_SEED).toHaveLength(6);
    const uuids = CARD_FAMILY_SEED.map((s) => CARD_PROPERTY_UUIDS[s.property]);
    expect(new Set(uuids).size).toBe(6);
    for (const spec of CARD_FAMILY_SEED) {
      const schema = (SYSTEM_PROPERTY_SPECS as Record<string, unknown>)[spec.property];
      expect(schema).toMatchObject({ type: spec.type, bindTo: "card" });
      expect((schema as { pinned?: boolean }).pinned ?? false).toBe(false);
    }
  });

  it("card family uuids do not collide with the task family namespace", () => {
    for (const uuid of Object.values(CARD_PROPERTY_UUIDS)) {
      expect(uuid.startsWith("00000000-0000-0000-0004-")).toBe(true);
    }
  });
});
```

(Import `SYSTEM_PROPERTY_SPECS` alongside the other imports.)

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/domain`: `pnpm exec vitest run test/seeds-cards.test.ts`
Expected: FAIL — `CARD_FAMILY_SEED` / `CARD_PROPERTY_UUIDS` are not exported; display name is still `"Card"`.

- [ ] **Step 3: Implement the seeds changes**

In `packages/domain/src/seeds.ts`:
1. `SYSTEM_CLASS_DISPLAY_NAMES` entry `card: "Card"` → `card: "Memorization card"` (`:218`).
2. Icon `mdiCardOutline` → `mdiCardsPlayingOutline` (`:128`, the card class entry).
3. Gallery description (`:306`) → `"A memorization card for spaced-repetition recall: the node's content is the prompt, its embedded children are the answer."`
4. Add `CARD_PROPERTY_UUIDS` and `CARD_FAMILY_SEED` exactly as in the Interfaces block above, placed next to `TASK_FAMILY_SEED` (`:1205-1246`). Add the six entries to `SYSTEM_PROPERTY_SPECS` (near `:557-620`) in the same shape as the task specs, each with `bindTo: "card"` and NO `pinned` key:
   ```ts
   cardDue:        { type: "datetime", bindTo: "card" },
   cardReps:       { type: "number", bindTo: "card" },
   cardInterval:   { type: "number", bindTo: "card" },
   cardEase:       { type: "number", bindTo: "card" },
   cardDifficulty: { type: "number", bindTo: "card" },
   cardStability:  { type: "number", bindTo: "card" },
   ```
5. Verify `SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK` (`:1289-1304`) still lists `card` — untouched.

In `apps/web/src/features/classview/systemClassDeploy.ts` (~`:301`): update the gallery description for the card entry to the same memorization wording.

- [ ] **Step 4: Run tests + gate**

Run from `packages/domain`: `pnpm exec vitest run test/seeds-cards.test.ts` → PASS.
Run from repo root: `pnpm -r --workspace-concurrency=1 build && pnpm typecheck && pnpm test` → all green (the rename ripples into any snapshot/assertion of the old display name — fix those expectations, they are test data, not behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/seeds.ts packages/domain/test/seeds-cards.test.ts apps/web/src/features/classview/systemClassDeploy.ts
# plus any test-expectation files the rename legitimately touched
git commit -m "feat(domain): rename card class to Memorization card, author card-family property schemas"
git push
```

---

### Task 2: Convergence migration for the rename (live workspaces)

**Files:**
- Create: `scripts/migrate-card-rename.mts`
- Test: none standalone (script is idempotent, dry-run by default — verified by a dry run against a scratch store inside the script's own `--selfcheck` mode)

**Interfaces:**
- Consumes: the header-comment contract of `scripts/migrate-system-names.mts` (`:1-40`) — read it first; this script is a specialized copy that only handles the one class.
- Produces: `scripts/migrate-card-rename.mts --apply` appends `class.update {classId: <card uuid>, contentAst: "Memorization card"}` envelopes to the relay log for every workspace whose stored card-class title differs from the manifest.

- [ ] **Step 1: Read the precedent**

Read `scripts/migrate-system-names.mts` fully. Note: how it builds a scratch store (snapshot + log tail), validates envelopes through zod before insert, computes the plan, and gates `--apply` behind `RelayStorage.ingest`.

- [ ] **Step 2: Write the specialized script**

Create `scripts/migrate-card-rename.mts`: copy the precedent's structure but restrict the plan to the single class — `const TARGET_ID = SYSTEM_CLASS_UUIDS.card; const TARGET_TITLE = SYSTEM_CLASS_DISPLAY_NAMES.card;`. For each workspace: project the log into a scratch store, read the card class node's flattened title; if it differs from `"Memorization card"`, append one envelope `class.update` with `contentAst` = the manifest title, fresh HLC, actor `system:migrate-card-rename`. Dry-run prints the plan (workspace count, before → after titles); `--apply` inserts through `RelayStorage.ingest`. Add a `--selfcheck` mode that runs the dry-run against a scratch in-memory store seeded with an old-title class node and asserts the plan contains exactly one envelope, then re-running against the migrated scratch store yields an empty plan (idempotency).

- [ ] **Step 3: Verify**

Run: `pnpm exec tsx scripts/migrate-card-rename.mts --selfcheck` → prints SELFCheck-PASS.
Run from repo root: `pnpm typecheck` → green.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-card-rename.mts
git commit -m "feat(scripts): card-rename convergence migration (dry-run default, idempotent)"
git push
```

(Running `--apply` against live workspaces is an operations action for the owner — the script ships dry-run-only in this slice.)

---

### Task 3: The `card.review` op — zod payload, catalog, fixture

**Files:**
- Modify: `packages/protocol/src/op-types.ts` (`OP_PAYLOAD_SCHEMAS` at `:833-868`)
- Modify: `packages/protocol/src/op-catalog.ts` (op listing)
- Modify: `packages/protocol/test/protocol.test.ts` (name list at `:47-92`, pins near `:137-200`)
- Create: `packages/protocol/fixtures/card-review.json`

**Interfaces:**
- Consumes: zod patterns of neighboring op payloads in `op-types.ts`.
- Produces (Task 4 implements against these exact types):
  ```ts
  // packages/protocol/src/op-types.ts
  const cardSrsStateSchema = z.object({
    due: z.string().nullable(),       // YYYY-MM-DD, null = unseen
    reps: z.number(),
    interval: z.number(),             // days
    ease: z.number().nullable(),      // sm2 ease factor; null = uninitialized
    difficulty: z.number().nullable(),// fsrs difficulty; null = uninitialized
    stability: z.number().nullable(), // fsrs stability (days); null = uninitialized
  }).strict();

  // in OP_PAYLOAD_SCHEMAS:
  "card.review": z.object({
    cardId: z.string().uuid(),
    grade: z.enum(["again", "hard", "good", "easy"]),
    algorithm: z.enum(["sm2", "fsrs"]),
    stateBefore: cardSrsStateSchema,
    stateAfter: cardSrsStateSchema,
    reviewedAt: z.string(),           // ISO 8601
    sessionId: z.string().uuid(),
  }).strict(),
  ```
  `OpType` and `KNOWN_OP_TYPES` gain `"card.review"` through the existing derivation.

- [ ] **Step 1: Write the fixture**

Create `packages/protocol/fixtures/card-review.json` — a `{"envelopes": [...]}` file with strictly ascending HLCs (the format of `fixtures/property-assign.json`; two envelopes are enough: a `class.create` for a user class is NOT needed — use `object.create` of a node, `class.create` of the card class is a system seed so the fixture uses `object.create` + `class.assign` to class the node, then two `card.review` envelopes with ascending HLCs and different `sessionId`s). Include one `"again"` grade and one `"good"` grade, with `stateBefore`/`stateAfter` showing a real transition (null-ease unseen → initialized).

- [ ] **Step 2: Write the failing test additions**

In `packages/protocol/test/protocol.test.ts`:
1. Add `"card-review.json"` to the expected name list (`:47-92`, 44 → 45 names, keep sorted order).
2. Add a pin block mirroring the `property-assign` pins (`:137-200`):
   ```ts
   describe("card-review", () => {
     const fixture = loadFixture("card-review.json");
     it("payloads parse and carry grade/algorithm/session", () => {
       const reviews = fixture.envelopes.filter((e) => e.opType === "card.review");
       expect(reviews).toHaveLength(2);
       expect(reviews[0].payload.grade).toBe("again");
       expect(reviews[1].payload.grade).toBe("good");
       expect(reviews[1].payload.stateAfter.ease).not.toBeNull();
     });
     it("rejects an unknown grade and a non-uuid session", () => {
       expect(payloadSchemaFor("card.review").safeParse({
         cardId: "00000000-0000-0000-0001-000000000011",
         grade: "great", algorithm: "sm2",
         stateBefore: { due: null, reps: 0, interval: 0, ease: null, difficulty: null, stability: null },
         stateAfter: { due: "2026-10-29", reps: 1, interval: 1, ease: 2.5, difficulty: null, stability: null },
         reviewedAt: "2026-10-28T10:00:00.000Z", sessionId: "not-a-uuid",
       }).success).toBe(false);
     });
   });
   ```
   (`loadFixture` is the file's existing helper — use whatever name it actually has; keep the style.)

- [ ] **Step 3: Run test to verify it fails**

Run from `packages/protocol`: `pnpm exec vitest run test/protocol.test.ts`
Expected: FAIL — `"card.review"` not in `KNOWN_OP_TYPES`; fixture name mismatch.

- [ ] **Step 4: Implement**

Add `cardSrsStateSchema` and the `"card.review"` entry to `OP_PAYLOAD_SCHEMAS` in `packages/protocol/src/op-types.ts` (Interfaces block verbatim), and a `card.review` row in `packages/protocol/src/op-catalog.ts` mirroring the neighboring entries (op name, summary, example payload).

- [ ] **Step 5: Run tests + gate**

Run from `packages/protocol`: `pnpm exec vitest run test/protocol.test.ts` → PASS.
Run: `pnpm -r --workspace-concurrency=1 build && pnpm typecheck && pnpm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/op-types.ts packages/protocol/src/op-catalog.ts packages/protocol/test/protocol.test.ts packages/protocol/fixtures/card-review.json
git commit -m "feat(protocol): card.review op payload, catalog entry, wire fixture"
git push
```

---

### Task 4: TS reference applier + `card_review` derived table

**Files:**
- Modify: `packages/store/src/schema.ts` (`SCHEMA_VERSION` at `:31`, `migrate()` at `:631-647`)
- Modify: `packages/store/src/appliers.ts` (dispatch at `applyEnvelope` `:3229`)
- Test: `packages/store/test/card-review.test.ts` (new)

**Interfaces:**
- Consumes: `OpPayload<"card.review">` from Task 3; applier patterns `applyClassPropertySet` (`appliers.ts:1901`), test setup from `packages/store/test/property-assign.test.ts:45-127` (the `env()` helper, `describe.each(adapters)` over `sqljsBackend` + `betterSqlite3Backend`, `seededStore()`).
- Produces:
  ```ts
  // packages/store/src/schema.ts — inside the CREATE TABLE block + SCHEMA_VERSION 34 → 35
  export const CARD_REVIEW_DDL = `
  CREATE TABLE IF NOT EXISTS card_review (
      card_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      grade TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      state_before TEXT NOT NULL,
      state_after TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      hlc_physical INTEGER NOT NULL,
      hlc_logical INTEGER NOT NULL,
      actor_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_card_review_card ON card_review(card_id, hlc_physical, hlc_logical);
  `;
  ```
  and a read seam on the store: `store.listCardReviews(cardId: string): Array<{sessionId, grade, algorithm, stateBefore, stateAfter, reviewedAt}>` (JSON-parsed `state_before`/`state_after`).

- [ ] **Step 1: Write the failing test**

Create `packages/store/test/card-review.test.ts` using the exact setup pattern of `packages/store/test/property-assign.test.ts:45-127` (`env()`, `describe.each(adapters)`, `makeStore()`, `seededStore()` seeding the card class + a node + `class.assign`). Tests:
1. `applies a card.review envelope and lists it back` — apply one `card.review`; `store.listCardReviews(cardId)` returns 1 row with parsed `stateAfter`.
2. **Review Focus 4** — `applies two concurrent reviews from different actors` — two `card.review` envelopes, different `actorId`s, HLC-ordered; both rows list back; no throw.
3. `fails loud when the target node is not classed card` — expect `() => store.apply(env("card.review", {...}, hlc)).toThrow()` (assert the error message names `card.review`).
4. `fails loud when the cardId does not exist`.
5. `migration creates the table on an old-version db` — open a store, `db.pragma("user_version = 34")` on the underlying handle if reachable (mirror how existing migration tests do it; if no precedent, skip #5 and rely on fresh-store creation).

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/store`: `pnpm exec vitest run test/card-review.test.ts`
Expected: FAIL — `card.review` unhandled by `applyEnvelope`; `listCardReviews` missing.

- [ ] **Step 3: Implement**

1. `packages/store/src/schema.ts`: bump `SCHEMA_VERSION` to 35; add the `card_review` DDL to the create block and a `if (current < 35) { /* additive: CREATE TABLE IF NOT EXISTS already re-execed above; nothing to rebuild */ }` delta comment block mirroring how prior additive versions were handled.
2. `packages/store/src/appliers.ts`:
   - `applyCardReview(db, env)`: resolve the payload; validate `cardId` resolves to a node row and that the node carries the card class membership (mirror the membership SELECT used elsewhere in this file — grep `node_class` for the exact table/columns); throw `MoveGuardError("card.review: <id> is not classed memorization card", "card.review")` otherwise; `INSERT INTO card_review ...` with `JSON.stringify` on both state snapshots; return `summary("card.review", [p.cardId], false)`. History is append-only: NO LWW gate, NO superseded path.
   - Register in `applyEnvelope`'s dispatch (`:3229`) alongside the other op types.
3. `listCardReviews` on the store class (mirror the file's other list-read methods; `JSON.parse` the state columns).

- [ ] **Step 4: Run tests + gate**

Run from `packages/store`: `pnpm exec vitest run test/card-review.test.ts` → PASS (both adapters).
Run: `pnpm -r --workspace-concurrency=1 build && pnpm typecheck && pnpm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/schema.ts packages/store/src/appliers.ts packages/store/test/card-review.test.ts
git commit -m "feat(store): card.review applier with card_review history table"
git push
```

---

### Task 5: SRS module — `packages/domain/src/srs.ts`

**Files:**
- Create: `packages/domain/src/srs.ts`
- Test: `packages/domain/test/srs.test.ts` (new)
- Modify: `packages/domain/src/index.ts` (export the new module, mirroring how `node.ts`/`seeds.ts` are exported)

**Interfaces:**
- Consumes: nothing (pure).
- Produces (Tasks 8–9 rely on these exact signatures):
  ```ts
  export type CardGrade = "again" | "hard" | "good" | "easy";
  export type SrsAlgorithm = "sm2" | "fsrs";
  export interface CardSrsState {
    due: string | null;          // YYYY-MM-DD; null = unseen
    reps: number;
    interval: number;            // days
    ease: number | null;         // sm2
    difficulty: number | null;   // fsrs
    stability: number | null;    // fsrs, days
  }
  export const UNSEEN_CARD_STATE: CardSrsState = {
    due: null, reps: 0, interval: 0, ease: null, difficulty: null, stability: null,
  };
  export function nextCardState(
    state: CardSrsState,
    grade: CardGrade,
    algorithm: SrsAlgorithm,
    todayIso: string,            // YYYY-MM-DD
  ): CardSrsState;
  export function isCardDue(state: CardSrsState, todayIso: string): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/srs.test.ts` — pin these behaviors (Review Focus 2, 3, 5):

```ts
import { describe, expect, it } from "vitest";
import { UNSEEN_CARD_STATE, isCardDue, nextCardState } from "../src/srs";

const TODAY = "2026-10-28";

describe("sm2", () => {
  it("first good: reps 1, interval 1, due tomorrow, ease 2.5", () => {
    const s = nextCardState(UNSEEN_CARD_STATE, "good", "sm2", TODAY);
    expect(s).toEqual({ due: "2026-10-29", reps: 1, interval: 1, ease: 2.5, difficulty: null, stability: null });
  });
  it("lapse resets reps and interval, floors ease at 1.3", () => {
    const reviewed = { due: "2026-10-28", reps: 5, interval: 21, ease: 1.35, difficulty: null, stability: null };
    const s = nextCardState(reviewed, "again", "sm2", TODAY);
    expect(s.reps).toBe(0); expect(s.interval).toBe(1); expect(s.ease).toBe(1.3);
  });
});

describe("fsrs", () => {
  it("first good initializes difficulty and stability, not null", () => {
    const s = nextCardState(UNSEEN_CARD_STATE, "good", "fsrs", TODAY);
    expect(s.ease).toBeNull();            // sm2 field untouched
    expect(s.difficulty).not.toBeNull();
    expect(s.stability).toBeGreaterThan(0);
    expect(s.due).toBe(TODAY);            // same-day re-view for first fsrs step
  });
  it("Review Focus 3: sm2-reviewed card graded under fsrs initializes fsrs fields, keeps ease", () => {
    const sm2 = nextCardState(UNSEEN_CARD_STATE, "good", "sm2", TODAY);
    const fsrs = nextCardState({ ...sm2, stability: null, difficulty: null }, "good", "fsrs", TODAY);
    expect(fsrs.ease).toBe(2.5);          // stale sm2 field preserved, not corrupted
    expect(fsrs.stability).not.toBeNull();
  });
});

describe("isCardDue", () => {
  it("unseen cards are due; future-dated are not", () => {
    expect(isCardDue(UNSEEN_CARD_STATE, TODAY)).toBe(true);
    expect(isCardDue({ ...UNSEEN_CARD_STATE, due: "2026-10-29" }, TODAY)).toBe(false);
    expect(isCardDue({ ...UNSEEN_CARD_STATE, due: TODAY }, TODAY)).toBe(true);
  });
});
```

Adjust the exact FSRS first-step `due` expectation to what the implementation computes (same-day for first review per FSRS-5 default parameters) — the test and implementation are written together; the invariant pinned is "no null fields after a grade" and "due is today or later, never before".

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/domain`: `pnpm exec vitest run test/srs.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `packages/domain/src/srs.ts`**

```ts
// SM-2 grade → Anki quality: again 1, hard 3, good 4, easy 5
const SM2_QUALITY: Record<CardGrade, number> = { again: 1, hard: 3, good: 4, easy: 5 };
// FSRS-5 default parameters (fixed for v1; fitting from card_review history is a follow-up)
const FSRS_W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const FSRS_RATING: Record<CardGrade, number> = { again: 1, hard: 2, good: 3, easy: 4 };
```

- SM-2: `nextEase = max(1.3, ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))`. `again` → reps 0, interval 1. Else `reps+1`; interval: reps 0→1, 1→6, else round(interval * ease). `due = today + interval` days (implement date add with UTC math to dodge DST: `new Date(Date.UTC(y, m-1, d) + interval*86400_000)` → ISO slice).
- FSRS-5: retrievability `R(t,S) = (1 + t/(9S))^{-1}`; first review (`stability == null`): `S' = FSRS_W[rating-1]` (index 0-3), `D' = clamp(FSRS_W[4] - exp(FSRS_W[5]*(1-R0)) + 1, 1, 10)` with `R0 = 1` → simplifies to `W[4] - 1 + 1 = W[4]`… implement the published first-step formulas directly (`S' = W[rating-1]`, `D' = W[4]`), do not "simplify". Subsequent: `D' = D - FSRS_W[6]*(rating-3)` clamped [1,10]; `S' = S * (1 + exp(FSRS_W[8]) * (11-D) * S^(-FSRS_W[9]) * (exp((1-R)*FSRS_W[10]) - 1))` for rating ≥ 2; for `again` use the lapse path `S' = FSRS_W[11] * D^(-FSRS_W[12]) * ((S+1)^FSRS_W[13] - 1) * exp((1-R)*FSRS_W[14])`. `again` → reps 0; else reps+1. `due = today + round(S')` days (FSRS first step: same day, interval 0). **Review Focus 3**: when `stability == null || difficulty == null`, take the first-review path regardless of `reps`, and never touch the `ease` field; SM-2 symmetrically never touches `difficulty`/`stability` and initializes `ease` to 2.5 when null.
- `isCardDue`: `due == null || due <= todayIso` (string compare on `YYYY-MM-DD` is chronological).

- [ ] **Step 4: Run tests + gate**

Run from `packages/domain`: `pnpm exec vitest run test/srs.test.ts` → PASS.
Run: `pnpm -r --workspace-concurrency=1 build && pnpm typecheck && pnpm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/srs.ts packages/domain/src/index.ts packages/domain/test/srs.test.ts
git commit -m "feat(domain): SM-2 and FSRS-5 spaced-repetition scheduler (nextCardState)"
git push
```

---

### Task 6: GTK + Flutter lockstep alignment (seed manifests + `card.review` applier)

**Files (sibling repos — do NOT touch from the main worktree directly; dispatch one subagent per repo):**
- Modify: `/root/projects/notees-gtk/src/notees_gtk/core/protocol/features.py` (card icon/display-name manifest)
- Modify: `/root/projects/notees-flutter/lib/core/constants/system.dart` + `lib/domain/services/local_workspace_seed.dart`
- Modify: GTK + Flutter op appliers/dispatch for `card.review` + their protocol constant tables
- Test: each repo's existing protocol/store suites + the byte-identical `card-review.json` fixture copied into their fixture corpus

**Interfaces:**
- Consumes: Task 1 seeds, Task 3 fixture + payload shape, Task 4 applier semantics (history-only append, card-class validation, fail loud).
- Produces: GTK and Flutter converged on the rename, the six card-family schema UUIDs/names/types, and the `card.review` wire op — verified against the same `card-review.json` bytes (sha256 must match the main repo's file).

- [ ] **Step 1: Dispatch the GTK alignment subagent**

Coder subagent in `/root/projects/notees-gtk` on a new branch `memorization-cards-lockstep`: apply the display-name rename ("Memorization card"), the icon change, the six card-family schema entries (same UUIDs verbatim), and the `card.review` applier (history table + validation) with their test-suite coverage; copy `packages/protocol/fixtures/card-review.json` from the main repo byte-identical and wire it into their fixture gate. Gate: their full test suite green. Commit + push their branch.

- [ ] **Step 2: Dispatch the Flutter alignment subagent**

Same brief against `/root/projects/notees-flutter`, branch `memorization-cards-lockstep`: `system.dart` + `local_workspace_seed.dart` manifest entries, Dart `card.review` applier + derived table, byte-identical fixture, their suite green. Commit + push.

- [ ] **Step 3: Record the lockstep check**

Verify both branches exist and their fixture sha256 matches: `sha256sum packages/protocol/fixtures/card-review.json` in all three repos — identical. Add the CHANGELOG entry for slices 1–3 (rename + family seeds + `card.review` op + fixtures + lockstep check ran) in the main repo, mirroring the top entry's format, with a `Verified:` line naming the suites.

- [ ] **Step 4: Commit (main repo)**

```bash
git add CHANGELOG.md
git commit -m "chore(release): memorization cards slices 1-3 — rename, family seeds, card.review op (GTK/Flutter lockstep checked)"
git push
```

---

### Task 7: `cards.algorithm` per-user pref (server + web seam)

**Files:**
- Modify: `apps/server/src/routes-prefs.ts` (zod patch schema `:38-46`, GET/PUT handlers `:49-65`)
- Modify: `apps/server/src/auth.ts` (`user_prefs` additive migration)
- Modify: `apps/web/src/core/workspace-client/client-server.ts:54,89` (pass-through)
- Modify: `apps/web/src/features/settings/nodePrefs.ts` (`:39-80` cached copy + broadcast)
- Test: `apps/server/test/` — extend the prefs route test (find the existing prefs test file; mirror its shape)

**Interfaces:**
- Consumes: existing prefs machinery (item 4 of the recon: `user_prefs` table, `getUserPrefs` returning `{favorites, recents, updatedAt}`).
- Produces: `cardsAlgorithm: "sm2" | "fsrs"` readable/writable through the same prefs routes; web seam exposes `getCardsAlgorithm(): Promise<"sm2"|"fsrs">` (default `"fsrs"` when unset) and `setCardsAlgorithm(a)` on the nodePrefs module.

- [ ] **Step 1: Write the failing test**

Extend the server prefs test: `PUT /me/prefs {cardsAlgorithm: "sm2"}` → `GET /me/prefs` returns `cardsAlgorithm: "sm2"`; `PUT {cardsAlgorithm: "bogus"}` → 422; `GET` for a user who never set it → `"fsrs"`.

- [ ] **Step 2: Run to verify it fails** — run the server prefs test → FAIL (unknown key rejected / not persisted).

- [ ] **Step 3: Implement** — `auth.ts`: additive migration adding `cards_algorithm TEXT NOT NULL DEFAULT 'fsrs'` to `user_prefs` and include it in `getUserPrefs`. `routes-prefs.ts`: add `cardsAlgorithm: z.enum(["sm2", "fsrs"]).optional()` to the strict patch schema, merge on PUT. Web: extend the prefs fetch/patch types and the nodePrefs cached copy (persist-through to the device-local key `notees.prefs.cardsAlgorithm`, broadcast a `notees:prefs` event mirroring the favorites pattern).

- [ ] **Step 4: Gate** — `pnpm -r --workspace-concurrency=1 build && pnpm typecheck && pnpm test` → green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes-prefs.ts apps/server/src/auth.ts apps/server/test/ apps/web/src/core/workspace-client/client-server.ts apps/web/src/features/settings/nodePrefs.ts
git commit -m "feat(server,web): cards.algorithm per-user preference (default fsrs)"
git push
```

---

### Task 8: `ensureCardFamily` (web self-heal)

**Files:**
- Create: `apps/web/src/features/classview/cardFamily.ts`
- Test: `apps/web/test/card-family.test.ts` (new)

**Interfaces:**
- Consumes: `CARD_FAMILY_SEED` + `CARD_PROPERTY_UUIDS` (Task 1), `ensureTaskFamily` structure (`apps/web/src/features/classview/taskFamily.ts:135-216`), `TaskFamilyClient` Pick-pattern (`:44-53`).
- Produces: `ensureCardFamily(client: CardFamilyClient): Promise<void>` and `cardFamilyPresent(client): boolean`; `CardFamilyClient = Pick<WorkspaceClient, "listPropertySchemas"|"getClassBindings"|"getNodeRaw"|"createPropertySchema"|"setClassProperty">`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/card-family.test.ts` with a stub client: when schemas absent, `ensureCardFamily` calls `createPropertySchema` once per `CARD_FAMILY_SEED` entry with the seed UUID/name/type and `setClassProperty` for each binding; when present, it makes no writes (idempotent). Run: `cd apps/web && pnpm exec vitest run test/card-family.test.ts` → FAIL.

- [ ] **Step 2: Implement** — mirror `ensureTaskFamily` minus the select-option restyle pass (all card schemas are scalar): read gate over `listPropertySchemas()` + `getClassBindings(SYSTEM_CLASS_UUIDS.card)`; create missing schemas at the reserved UUIDs via `client.createPropertySchema({id, name, type})` (global scope, exactly like the task family); `client.setClassProperty(cardId, uuid, {})` per schema; no pinning.

- [ ] **Step 3: Gate + commit** — root gate green; then:

```bash
git add apps/web/src/features/classview/cardFamily.ts apps/web/test/card-family.test.ts
git commit -m "feat(web): ensureCardFamily self-heal for the card-family property schemas"
git push
```

---

### Task 9: Cards hub — nav, routing, buckets, query builder, Review actions

**Files:**
- Modify: `apps/web/src/ui/app/Sidebar.tsx` (`NavKey` `:48`, `NAV_ENTRIES` `:57-72`)
- Modify: `apps/web/src/ui/app/routing.ts` (`NAV_PATHS` `:29-44`, `navFromPath`/`pathForNav` `:46-58`, `tabTitle` `:293-321`)
- Modify: `apps/web/src/ui/app/AppBody.tsx` (`:280-334` dispatch)
- Modify: `apps/web/src/ui/app/HubView.tsx` (new `cards` case next to tasks `:140-218`)
- Create: `apps/web/src/features/classview/CardBuckets.tsx` (+ co-located CSS)
- Modify: `apps/web/src/ui/app/HubSurfaces.css`
- Test: `apps/web/test/cards-routing.test.ts` (new, mirroring `calendar-routing.test.ts:184-203`)

**Interfaces:**
- Consumes: `ensureCardFamily` (Task 8), `partitionTasksIntoBuckets` pattern (`calendarViewUtils.ts:441-465`), `CollectionHub` props (recon item 5), `NodeCollectionItem.trailingAction` (`types.ts:301`), query-run machinery (`apps/web/src/ui/QueryNodeSection.tsx` + `useQueryRun` from `queryRun.ts`).
- Produces:
  - `NavKey` gains `"cards"`; `/cards` maps to it; `tabTitle` returns `"Cards - Notees"`.
  - `interface CardBuckets { due: CardBucketRow[]; fresh: CardBucketRow[]; later: CardBucketRow[] }` and `partitionCardsIntoBuckets(rows, todayIso)` in `CardBuckets.tsx`.
  - `pathForCardsReview()` = `"/cards/review"` — Task 10 routes it.
  - The review-session handoff: `startCardsSession(cardIds: string[])` in a small `apps/web/src/features/cards/sessionState.ts` — writes `{cardIds, filterSummary}` to `sessionStorage["notees.cards.session"]` and navigates to `/cards/review`. (Deep-linking `/cards/review` with no session state = all due cards — Task 10 defines that fallback.)

- [ ] **Step 1: Write the failing routing test**

Create `apps/web/test/cards-routing.test.ts` mirroring `calendar-routing.test.ts:184-203`:

```ts
it("the cards hub owns its path and tab title (law 9)", () => {
  expect(pathForNav("cards")).toBe("/cards");
  expect(navFromPath("/cards")).toBe("cards");
  expect(tabTitle({ ...base, activeNav: "cards" })).toBe("Cards - Notees");
});
```

(Use the real signatures from `routing.ts` — `tabTitle`'s base shape is the calendar test's `base` literal.)

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && pnpm exec vitest run test/cards-routing.test.ts` → FAIL.

- [ ] **Step 3: Implement nav + routing** — `NavKey` + `NAV_ENTRIES` row (`{key: "cards", label: "Cards", icon: "mdiCardsPlayingOutline"}`); `NAV_PATHS` `/cards`; `tabTitle` branch naming `"Cards - Notees"` (update the routing/title suites' exhaustive NavKey switches — wherever the compiler points). Test passes.

- [ ] **Step 4: Write the failing bucket test + implement**

In `apps/web/test/cards-routing.test.ts` (or a sibling `cards-buckets.test.ts`):

```ts
it("partitions cards into due / fresh / later from cardDue", () => {
  const rows = [
    { id: "a", due: "2026-10-27" },   // overdue → due
    { id: "b", due: "2026-10-28" },   // today → due
    { id: "c", due: null },           // unseen → fresh
    { id: "d", due: "2026-11-02" },   // future → later
  ];
  const b = partitionCardsIntoBuckets(rows, "2026-10-28");
  expect(b.due.map((r) => r.id)).toEqual(["a", "b"]);
  expect(b.fresh.map((r) => r.id)).toEqual(["c"]);
  expect(b.later.map((r) => r.id)).toEqual(["d"]);
});
```

Implement `CardBuckets.tsx` + `partitionCardsIntoBuckets` in `apps/web/src/features/classview/CardBuckets.tsx` (mirror `TaskBuckets.tsx`; read `cardDue` values via the effective property read the task rows use — `taskRowsOf` in `calendarViewUtils.ts` is the pattern; a `cardRowsOf(client, dueSchemaId, ids)` helper lives next to the partition function). Render three bucket chips with counts, Due clickable → starts a session over the due+fresh ids.

- [ ] **Step 5: Implement the HubView cards case**

In `HubView.tsx` add the `cards` branch (mirror the tasks case verbatim in structure):
- `void ensureCardFamily(client)` on entry (the tasks case calls `ensureTaskFamily` at `:112` — same spot/pattern).
- Default items: `client.getClassMembers(SYSTEM_CLASS_UUIDS.card)`.
- Embed the query builder: read `QueryNodeSection.tsx` first and reuse its run channel — host a `FilterBlockBuilder` drafting a `FilterQuery`, run through the same seam `useQueryRun` exposes, and replace the item list with the run's node ids (default = no filter = all members). Keep the draft in React state (the filter machinery is transient by design, `filterQuery.ts:42-56`).
- `prepend={<CardBuckets … onReview={…} />}`; `headerActions`: New-card button (`client.createObject({isEmbedded: false, classIds: [card]})` + open), Review-now button (`startCardsSession(currentFilteredIds)`), and an algorithm toggle (sm2/fsrs) bound to the Task 7 pref seam.
- `trailingAction`: a per-row Review button calling `startCardsSession([item.node.id])`.
- `persistKey="hub.cards"`, `modes={["table", "cards", "outline"]}`.

- [ ] **Step 6: AppBody dispatch** — add the `cards` branch rendering `HubView` (it lands in the shared-outline fallback today; give it its own branch like `tasks` so the nav key is explicit).

- [ ] **Step 7: Gate + commit**

```bash
pnpm -r --workspace-concurrency=1 build && pnpm typecheck && pnpm test   # green
git add apps/web/src/ui/app/Sidebar.tsx apps/web/src/ui/app/routing.ts apps/web/src/ui/app/AppBody.tsx apps/web/src/ui/app/HubView.tsx apps/web/src/ui/app/HubSurfaces.css apps/web/src/features/classview/CardBuckets.tsx apps/web/src/features/classview/CardBuckets.css apps/web/src/features/cards/sessionState.ts apps/web/test/cards-routing.test.ts
git commit -m "feat(web): Cards hub — nav entry, due/fresh/later buckets, query-builder subsets, review actions"
git push
```

---

### Task 10: Review session — `/cards/review`

**Files:**
- Create: `apps/web/src/features/cards/ReviewSession.tsx` (+ co-located CSS)
- Create: `apps/web/src/features/cards/reviewQueue.ts`
- Modify: `apps/web/src/ui/app/routing.ts` (review subroute — mirror how calendar owns subroutes at `:29-44`)
- Modify: `apps/web/src/ui/app/AppBody.tsx` (render the session above the hub dispatch when the review subroute matches)
- Modify: `apps/web/src/ui/app/routing.ts` `tabTitle` (`:293-321`) — `"Review - Notees"`
- Test: `apps/web/test/review-queue.test.ts` (new)

**Interfaces:**
- Consumes: `nextCardState`, `UNSEEN_CARD_STATE`, `isCardDue`, `CardSrsState` (Task 5); `listCardReviews`-equivalent client read for prior state is NOT needed — **state authority is the property values** (read `cardDue/cardReps/cardInterval/cardEase/cardDifficulty/cardStability` effective values off the node); property write path mirrored from `apps/web/src/features/classview/taskCycle.ts:109,131` (how taskStatus writes compose property ops); the op-append seam the undo journal's inverses traverse (`apps/web/src/core/undo-journal.ts`); `startCardsSession` handoff (Task 9); `ProseView` read-only rendering (recon item 8).
- Produces:
  ```ts
  // apps/web/src/features/cards/reviewQueue.ts
  export function buildReviewQueue(
    rows: ReadonlyArray<{ id: string; due: string | null }>,
    todayIso: string,
  ): string[];   // due-first (due-date asc, overdue first), then fresh; ids only
  ```

- [ ] **Step 1: Write the failing queue test**

Create `apps/web/test/review-queue.test.ts`:

```ts
it("orders due (overdue first, then due-date asc) ahead of fresh", () => {
  const q = buildReviewQueue([
    { id: "fresh1", due: null },
    { id: "dueTomorrow", due: "2026-10-29" },
    { id: "overdue", due: "2026-10-20" },
    { id: "dueToday", due: "2026-10-28" },
  ], "2026-10-28");
  expect(q).toEqual(["overdue", "dueToday", "dueTomorrow", "fresh1"]);
});
```

Run → FAIL.

- [ ] **Step 2: Implement `reviewQueue.ts`** — partition by `isCardDue`-equivalent (`due == null || due <= today`), sort due by `due` asc (nulls never in this arm), fresh keeps input order; concatenate.

- [ ] **Step 3: Write the failing session-component test**

Create `apps/web/test/review-session.test.tsx` (mirror the existing web component-test setup, e.g. `apps/web/test/calendar-routing.test.ts`'s harness or an existing `.test.tsx` like `alias-panel-worker.test.tsx` for the render scaffold):
1. Renders the front (card node content) and NOT the back before reveal.
2. Clicking Reveal renders the embedded children via the read-only path and the four grade buttons.
3. Clicking **Good** writes property values with the expected next state (assert against a stub client: `setPropertyValue`-style calls for cardReps/cardInterval/cardEase/cardDue — use the actual client method names from the taskCycle write path) AND appends exactly one `card.review` envelope whose `payload.grade === "good"`, `algorithm` = the current pref, `sessionId` shared across the session.
4. **Review Focus 1**: a card with zero embedded children renders the "No answer on this card" empty state and still grades.
5. **Review Focus 5**: after grading, invoking the undo journal path reverts the property writes (assert the stub client's property values return to pre-grade).

- [ ] **Step 4: Run to verify it fails** — FAIL (component missing).

- [ ] **Step 5: Implement `ReviewSession.tsx`**

- Route wiring: `/cards/review` subroute (mirror calendar's subroute ownership in `routing.ts`); `AppBody` renders `<ReviewSession …>` when it matches, above/before the hub dispatch; `tabTitle` → `"Review - Notees"`.
- On mount: read `sessionStorage["notees.cards.session"]`; ids present → that queue, else → all due+fresh card members (the fallback). Build rows from the client read, `buildReviewQueue` orders them.
- Card state read: pull the six effective property values into a `CardSrsState` (missing/unparseable → `UNSEEN_CARD_STATE` fields).
- Render: `SurfaceTopBar`-style header from kit components (progress `n/total`, exit button → `/cards`); front = the card node's content rendered read-only (same ProseView single-item pattern as the back); **Reveal** button flips to the back: `items = [{node: cardNode, children: embeddedChildren.map(...)}]` into `<ProseView client={client} items={items} condensed />` — **Review Focus 1**: empty children → the kit `EmptyState`-equivalent with "No answer on this card". Grade bar: four `Button`s (Again/Hard/Good/Easy, keys 1–4 via a `useEffect` keydown), labels styled from `variables.css` tokens only.
- On grade: `const next = nextCardState(state, grade, algorithm, todayIsoLocal())`; compose the property writes exactly like `taskCycle.ts` composes its status write (one batch), then append the `card.review` envelope through the same op-append seam the undo journal composes (read `undo-journal.ts` first); the property writes join the undo journal, the `card.review` op does not (per spec §6). Advance the queue; at end render the summary (reviewed count, lapses = `again` on `reps > 0`) and a Back-to-cards action.
- Algorithm: read once at session start from the Task 7 pref seam (`getCardsAlgorithm()`); it is fixed for the session's state computations (the op records which one ran).

- [ ] **Step 6: Gate + commit**

```bash
pnpm -r --workspace-concurrency=1 build && pnpm typecheck && pnpm test   # green
git add apps/web/src/features/cards/ apps/web/src/ui/app/routing.ts apps/web/src/ui/app/AppBody.tsx apps/web/test/review-queue.test.ts apps/web/test/review-session.test.tsx
git commit -m "feat(web): card review session — reveal + 4-grade flow over due queues"
git push
```

---

### Task 11: Creation flows — "Make memorization card" + quick-create polish

**Files:**
- Modify: the block/page action menu surface (find the existing "class-assign" action menu in the page-sections or editor code — grep for where `task` class-assign actions live, e.g. a context menu assigning classes)
- Modify: `apps/web/src/features/cards/` (a `makeCard.ts` helper) + the hub quick-create from Task 9 (if deferred there)
- Test: `apps/web/test/make-card.test.ts` (new)

**Interfaces:**
- Consumes: `SYSTEM_CLASS_UUIDS.card`; the existing class-assign op path used by whatever UI assigns classes to nodes today.
- Produces: `makeCard(client, nodeId): void` — class-assigns card; idempotent (assign-if-absent, mirroring OR-Set add-wins semantics so re-runs are no-ops).

- [ ] **Step 1: Write the failing test** — stub client: `makeCard` emits exactly one class-assign for the card class; calling twice emits one (idempotent).

- [ ] **Step 2: Implement** — `makeCard.ts` + the menu entry ("Make memorization card") in the same action menu that hosts other class actions, gated to non-class nodes.

- [ ] **Step 3: Gate + commit**

```bash
git add apps/web/src/features/cards/makeCard.ts apps/web/test/make-card.test.ts <the menu file>
git commit -m "feat(web): make-memorization-card action on blocks and pages"
git push
```

---

### Task 12: Docs + final sweep

**Files:**
- Modify: `packages/protocol/SCHEMA.md` — the `card.review` op (payload table, history-only semantics, `card_review` derived table)
- Modify: `packages/protocol/SCHEMA.md` — the card class section (rename, family schemas with UUIDs)
- Create: `docs/features/memorization-cards.md` — user-facing feature page (what a card is, hub, review flow, algorithm pref, keyboard shortcuts)
- Modify: `docs/feature-status.md` — cards row
- Modify: `CHANGELOG.md` — final entry covering slices 4–6 (hub, review session, creation, docs) with Verified + Files lines

- [ ] **Step 1: SCHEMA.md** — add the op and family sections in the document's existing section style.

- [ ] **Step 2: Feature docs** — `docs/features/memorization-cards.md` following the structure of a sibling feature page (read one first, e.g. `docs/features/` + tasks/queries page).

- [ ] **Step 3: feature-status.md + CHANGELOG.md** — mirror existing rows/entry format.

- [ ] **Step 4: Final gate + commit**

```bash
pnpm install && pnpm -r --workspace-concurrency=1 build && pnpm typecheck && pnpm test   # full gate, green
git add packages/protocol/SCHEMA.md docs/features/memorization-cards.md docs/feature-status.md CHANGELOG.md
git commit -m "docs: memorization cards — SCHEMA.md, feature page, feature status, changelog"
git push
```

---

### Task 13: Land the branch

- [ ] **Step 1:** In the MAIN checkout (not the worktree): `git fetch && git pull --ff-only` (coordinate — if `.git/index.lock` is present or main moved mid-landing, wait and redo).
- [ ] **Step 2:** `git merge --ff-only memorization-cards` after rebasing the branch onto freshest main if needed (`git -C .worktrees/memorization-cards rebase main`, gate again quickly).
- [ ] **Step 3:** `git push` main; confirm the main checkout sits at `origin/main` (law: landing is not done until the checkout is at origin/main — the live stack builds from the checkout).
- [ ] **Step 4:** `git worktree remove .worktrees/memorization-cards && git branch -d memorization-cards` after the merge.
- [ ] **Step 5:** Redeploy: `docker compose build web server && docker compose up -d` from the LIVE STACK folder, then the `verify-min.mjs` smoke — **invoke the `notees-operations` skill first**. (GTK/Flutter releases are their repos' own processes; not part of this landing.)

## Out of scope (deferred, by spec §10)

GTK/Flutter hub + review-session UI (their own repo plans on the `memorization-cards-lockstep` branches) · FSRS parameter fitting · typed recall · notifications · per-card algorithm override · daily new-card caps · leech handling · CLI review commands.
