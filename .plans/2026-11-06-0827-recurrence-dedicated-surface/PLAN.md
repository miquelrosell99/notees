> **Paths superseded 2026-11-12 (ADR-001):** `notees-sync` + `notees-web` re-merged into `miquelrosell99/notees`; checkouts now live at `/root/projects/notees/core` (one repo, no vendor pin — adapt the commands below accordingly; `notees-web/vendor/notees` no longer exists).

# Recurrence as a dedicated Repeat property — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the implicit `metadata.repeat` recurrence model with a dedicated, class-scoped `repeat` text property (RRULE RR5 subset) surfaced deliberately on event/task pages and the event-creation modal, migrating all live data.

**Architecture:** Slice 1 lands the model in `notees-sync` (domain RR5 grammar, seed, migration script, fixture — fixture-gated). Slice 2 (notees-web, one branch with slice 3, one release train) bumps the vendor pin, rewires the calendar/task consumers off datetime metadata, removes the repeat affordance from every generic date control, and builds the deliberate surfaces (kit `RepeatControl`, panel row, modal section).

**Tech Stack:** TypeScript, pnpm 9 workspaces, vitest, better-sqlite3/sql.js, React 18, the kit component library.

**Spec:** `notees-sync/.plans/2026-11-06-0827-recurrence-dedicated-surface/DESIGN.md` (read it first; it travels with this plan).

## Global Constraints

- Two repos: `/root/projects/notees-sync` (core, authority) and `/root/projects/notees-web` (client). **Never edit `notees-web/vendor/notees`** — core changes happen in notees-sync, then the pin bumps.
- notees-sync working rules (AGENTS.md): run `git status --porcelain` + `git log --oneline -5` before writing; **per-file staging only** (never `git add -A`); Conventional Commits; CHANGELOG entries prepend under the current `## YYYY-MM-DD` heading, newest first; never reference `.plans/` from the tree; never force-push; land slices fast-forward on `main` (`fetch, rebase, merge --ff-only, push`). Another session has uncommitted work there (`apps/server/src/resolve-source*`, `CHANGELOG.md`) — **do not touch or stage those files**; do the core work in a worktree: `git -C /root/projects/notees-sync worktree add .worktrees/recurrence-core -b recurrence-core main` (the repo's own `.worktrees/<slug>` convention).
- notees-web working rules: same git discipline; ui-primitives law — new chrome is an independent kit component under `apps/web/src/components/ui/kit/` (one element per file, co-located token-only CSS, barrel-exported from `index.ts`); adaptive values (`em`/`ch`/`1lh`, spacing/motion tokens), no hard-coded px except hairlines/tap floors; **never** ad-hoc styled controls in feature code.
- Dev-condition exports: vitest reads package `src`, `tsc` reads `dist` — after changing a package's public API run `pnpm -r --workspace-concurrency=1 build` before typechecking dependents.
- Gates: notees-sync `pnpm test` (all packages) is the blocking gate; web gate is `pnpm --filter @notees/web test` + `typecheck`.
- **Fail-loud idiom**: corrupt recurrence state throws at read, never reads as plain. This is house law, not a style choice.
- Seeds law: ids are never renamed/regenerated/reused — `…0003-000000000006` (`taskRecurrence`) gets a WITHDRAWN comment and stays in the map; the new property takes the next free slot `…0003-0000000000013`.
- Fleet-agnostic artifacts: no machine names/IPs in code, tests, docs, or CHANGELOG.

## Review Focus

The five input classes most likely to bite, each pinned to an owning task's tests:

1. **A legacy grammar string surviving migration** (`daily`, `weekdays`, `weekly/2`) must fail loud at parse, never read as plain — pinned in Task 1 (parse rejection corpus) and Task 6 (migration verify step).
2. **A source node with pre-migration `metadata.repeat`** — the out-of-scope arm: migration strips + reports, the applier never sees a rejected `property.set`, the calendar never paints it — Task 6 rehearsal test.
3. **Re-picking a repeating task's `taskScheduled` date** — series follows the new anchor, Repeat property untouched, `completedOccurrences` preserved — Task 9 test pins.
4. **Invalid RepeatControl states** (interval 0, zero weekdays selected, until before anchor, monthday 0/32) — write refused client-side with `aria-invalid`, nothing reaches the log — Task 11 unit tests.
5. **A Repeat value authored as a `{nodeId}` carrier** (CLI/API path, text is a heavy type) — the read model resolves the carrier through the node's flattened content instead of misreading it as a corrupt rule — Task 9 test pin.

---

## Slice 1 — Core (notees-sync)

### Task 1: Domain RR5 grammar

**Files:**
- Modify: `packages/domain/src/recurrence.ts` (rewrite the rule grammar; keep the exception helpers)
- Test: `packages/domain/test/recurrence.test.ts` (extend)

**Interfaces:**
- Consumes: existing exports `RecurrenceSeries`, `exdatesOf`, `untilOf`, `withExdate`, `withUntil`, `completedOccurrencesOf`, `withCompletedOccurrence`, `occurrenceIsosOf`, `RECURRENCE_MAX_INTERVAL` (999), `RECURRENCE_DEFAULT_CAP` (366) — these stay, signatures of the exception helpers unchanged (metadata key names `exdates`/`until`/`completedOccurrences` are unchanged).
- Produces (Task 6, 9, 11 consume these exact names):
  - `export type RecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";`
  - `export type RecurrenceWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";`
  - `export const RECURRENCE_WEEKDAYS: readonly RecurrenceWeekday[]` (canonical order)
  - `export interface RecurrenceRule { freq: RecurrenceFreq; interval: number; byday?: readonly RecurrenceWeekday[]; bymonthday?: readonly number[]; count?: number; until?: string; }` (`until` is an inclusive ISO day `YYYY-MM-DD`; `count` counts generated occurrences, exdates do not shift it)
  - `export class RecurrenceParseError extends Error {}`
  - `export function parseRecurrenceRule(text: unknown): RecurrenceRule` — accepts **only** canonical `RRULE:` strings; throws `RecurrenceParseError` on legacy forms, unknown keys, invalid values, and `COUNT`+`UNTIL` together
  - `export function formatRecurrenceRule(rule: RecurrenceRule): string` — canonical: `RRULE:FREQ=…[;INTERVAL=n (omitted when 1)][;BYDAY=…][;BYMONTHDAY=…][;COUNT=n|;UNTIL=YYYYMMDD]`, BYDAY in `RECURRENCE_WEEKDAYS` order, BYMONTHDAY sorted ascending
  - `export function recurrenceRuleOf(value: unknown): RecurrenceRule | null` — **redefined**: takes the property VALUE (plain string, or `{nodeId}` carrier whose text is passed in already-resolved by the caller), not metadata; absent → null, malformed → throw
  - `export function recurrenceSeriesOf(rule: RecurrenceRule | null, metadata: unknown, anchorIso: string): RecurrenceSeries | null` — rule from the property value, exceptions from the value's metadata
  - `export function weekdayOfIso(iso: string): RecurrenceWeekday`
  - `export function legacyRecurrenceToRRule(grammar: string, anchorIso: string): string` — converts the retired `<freq>[/<n>]` grammar (`daily|weekly|weekdays|monthly|yearly`) to a canonical RRULE using the anchor (`weekly`→anchor weekday, `weekdays`→`BYDAY=MO,TU,WE,TH,FR`, `monthly`→anchor day-of-month); throws on unknown grammar
  - `occurrenceIsosOf(series: RecurrenceSeries, fromIso: string, toIso: string, cap?: number): string[]` — same signature, RR5 semantics (below)

RR5 expansion semantics (pin every one with a test):
- Occurrence #1 is the anchor day itself. A day `d` ≥ anchor occurs iff: (daily) `(d − anchor) % interval === 0`; (weekly) `floor((d − anchor)/7) % interval === 0` AND (`byday` ∋ `weekday(d)` if set, else `weekday(d) === weekday(anchor)`); (monthly) whole-month diff from anchor `% interval === 0` AND (`bymonthday` ∋ day-of-month(d) if set, else same day-of-month as anchor); (yearly) whole-year diff `% interval === 0` AND same month+day as anchor (a Feb 29 anchor matches only leap years — never clamp).
- Months without the BYMONTHDAY day skip that month (day 31 in February → no occurrence).
- Generated occurrences are then filtered: `exdates` removes days; `count` drops generated occurrences with index > count; `until` drops generated days > until. `exdates` do NOT shift `count` indices.
- Window iteration: test each day in `[max(anchor, fromIso), toIso]`, stop at `cap` (default `RECURRENCE_DEFAULT_CAP`).

- [ ] **Step 1: Write the failing tests** in `packages/domain/test/recurrence.test.ts`:
  - round-trip: `parseRecurrenceRule(formatRecurrenceRule(r))` deep-equals normalized `r` for a table of rules (bare weekly, interval 2 daily, BYDAY list unsorted in → canonical sorted out, BYMONTHDAY, COUNT, UNTIL);
  - expansion pins: `every 2 days` over a 10-day window; `WEEKLY;BYDAY=MO,FR`; `MONTHLY;BYMONTHDAY=3` across a Feb boundary (day 31 input never occurs); weekly with anchor Wednesday and no BYDAY (occurs Wednesdays); `COUNT=3` (exactly 3, anchor counts); `UNTIL` inclusive; exdate removal with COUNT (count does not shift); Feb 29 yearly anchor (occurs 2024, not 2023/2025);
  - rejection corpus throws `RecurrenceParseError`: `"daily"`, `"weekly/2"`, `"weekdays"`, `"RRULE:FREQ=DAILY;COUNT=3;UNTIL=20260101"`, `"RRULE:FREQ=WEEKLY;BYDAY=XX"`, `"RRULE:FREQ=HOURLY"`, `""`, `null`-shaped objects, interval 0 and 1000, `BYMONTHDAY=0`/`32`, `COUNT=0`;
  - `legacyRecurrenceToRRule`: the five legacy forms + `weekly/2`, anchors pinning weekday/day-of-month derivation; unknown grammar throws.
- [ ] **Step 2: Run, verify red**

Run: `cd /root/projects/notees-sync && pnpm --filter @notees/domain test` — Expected: new tests fail (old type has no `byday`/etc.; `parseRecurrenceRule` accepts legacy forms).

- [ ] **Step 3: Implement** the grammar in `recurrence.ts` per the Interfaces block. Keep `RecurrenceSeries` and the exception helpers byte-compatible; only the rule type, grammar regex, `recurrenceRuleOf` input, `recurrenceSeriesOf` signature, and `occurrenceIsosOf` internals change. Delete the old `GRAMMAR` regex and the `weekdays` freq.
- [ ] **Step 4: Run, verify green** — `pnpm --filter @notees/domain test` all green (old `weekdays`/legacy-form tests in the file are rewritten in Step 1 to the new corpus).
- [ ] **Step 5: Rebuild dist** — `pnpm -r --workspace-concurrency=1 build` (public API changed).
- [ ] **Step 6: Commit** — `feat(domain): RR5 recurrence grammar — RRULE subset with interval, weekdays, monthday, ends`

### Task 2: The `repeat` seed (property, bindings, scope)

**Files:**
- Modify: `packages/domain/src/seeds.ts` (`SYSTEM_PROPERTY_UUIDS` :520, WITHDRAWN comment on `taskRecurrence` :580, `SystemPropertySpec.bindTo` :818, `SYSTEM_PROPERTY_SPECS` :874, `SYSTEM_PROPERTY_DISPLAY_NAMES` :1162)
- Modify: `packages/domain/src/system-seed-envelopes.ts` (bindTo normalization + union scope, :100-160)
- Test: `packages/domain/test/domain.test.ts` (seed envelope pins; completeness test at :841 already covers the display-name map)

**Interfaces:**
- Consumes: Task 1's `formatRecurrenceRule` (not directly — no dependency).
- Produces: `SYSTEM_PROPERTY_UUIDS.repeat = "00000000-0000-0000-0003-0000000000013"`; `SYSTEM_PROPERTY_SPECS.repeat = { type: "text", bindTo: ["event", "task"] }`; `SYSTEM_PROPERTY_DISPLAY_NAMES.repeat = "Repeat"`. `SystemPropertySpec.bindTo` becomes `SystemClassName | SystemClassName[]`. Seed envelopes emit: one `propertySchema.create` (text, `scopeClassIds: [SYSTEM_CLASS_UUIDS.event, SYSTEM_CLASS_UUIDS.task]`, single-value) and one `class.property.set` binding row per bound class.

- [ ] **Step 1: Write the failing test** in `packages/domain/test/domain.test.ts`: `buildSystemSeedEnvelopes(stamp)` contains the repeat schema envelope with `scopeClassIds` exactly `[event, task]` and binding-row envelopes for both classes; a spec-level pin that `SYSTEM_PROPERTY_SPECS.taskRecurrence` no longer exists and `taskRecurrence`'s UUID map entry carries a WITHDRAWN comment (comment presence checked manually in review — assert the entry still exists).
- [ ] **Step 2: Run, verify red** — `pnpm --filter @notees/domain test`.
- [ ] **Step 3: Implement**:
  - `seeds.ts`: append `repeat: "00000000-0000-0000-0003-0000000000013"` (comment: the dedicated recurrence property, RR5 RRULE text value; supersedes the withdrawn `taskRecurrence` placeholder); mark `taskRecurrence` WITHDRAWN (keep entry, per seeds law); change `bindTo?: SystemClassName` to `bindTo?: SystemClassName | SystemClassName[]` with a doc line (multi-class bind: union scope + one binding row per class); add the spec + display-name entries.
  - `system-seed-envelopes.ts`: normalize `const classes = spec.bindTo === undefined ? [] : Array.isArray(spec.bindTo) ? spec.bindTo : [spec.bindTo]`; scope = `classes.length === 0 || spec.global === true ? null : classes.map((c) => SYSTEM_CLASS_UUIDS[c])`; binding-row loop emits per class. Existing single-class specs must produce byte-identical envelopes (no fixture churn — the protocol fixture suite replays seeds).
- [ ] **Step 4: Run, verify green** — `pnpm --filter @notees/domain test` then `pnpm --filter @notees/protocol test` (fixture file-list + envelope validation must stay green).
- [ ] **Step 5: Commit** — `feat(domain): repeat system property — text RRULE schema bound and scoped to event+task`

### Task 3: SCHEMA.md Recurrence rewrite

**Files:**
- Modify: `packages/protocol/SCHEMA.md` (`## Recurrence` :395-409; the recurrence bullet in `## Datetime` :389)

- [ ] **Step 1:** Rewrite `## Recurrence` to the normative RR5 model: the `repeat` text property (fixed id), class-scoped to event/task, value = canonical RRULE subset (list the supported keys and the canonical order), exceptions (`exdates`/`until`) and `completedOccurrences` riding the **Repeat value's** metadata, anchor = the driving date value's day, compute-on-read, fail-loud parse, and a line naming the log migration that converts legacy `metadata.repeat` values.
- [ ] **Step 2:** Update the `## Datetime` bullet: date values no longer carry recurrence metadata; a re-pick never touches the Repeat property.
- [ ] **Step 3:** Commit — `docs(protocol): SCHEMA.md Recurrence — the dedicated repeat property + RR5 grammar`

### Task 4: Store applier ensure for the task binding

**Files:**
- Modify: `packages/store/src/appliers.ts` (`ensureTaskFamilyRows` :3047; the `applyWorkspaceFeatureSet` gating :3135-3138)

- [ ] **Step 1: Write the failing test** in `packages/store/test/` (the suite covering `ensureTaskFamilyRows`; follow the existing test's shape): after `applyWorkspaceFeatureSet` with the tasks feature enabled against a store whose `class_property` lacks the repeat row, a `class_property` row exists binding `task → …0013`.
- [ ] **Step 2: Run, verify red** — `pnpm --filter @notees/store test`.
- [ ] **Step 3: Implement**: add the `INSERT OR IGNORE` binding row (repeat on task) inside `ensureTaskFamilyRows`, mirroring the adjacent rows. The event binding converges via seed envelopes (new workspaces) and the Task 6 migration (live workspaces) — the event family has no applier ensure by design (plain seeds), do not add one.
- [ ] **Step 4: Run, verify green** — `pnpm --filter @notees/store test`.
- [ ] **Step 5: Commit** — `feat(store): ensureTaskFamilyRows binds repeat on task`

### Task 5: Protocol fixture

**Files:**
- Create: `packages/protocol/fixtures/recurrence-property.json`
- Modify: `packages/protocol/test/protocol.test.ts` (the exact file list)

- [ ] **Step 1:** Read `packages/protocol/fixtures/property-schema-scope.json` and `class-property-pinned.json` first — copy the file's envelope-group shape and scenario-comment idiom. The fixture (pre-seeded repeat schema — "a system seed, no propertySchema.create needed", like `card-review.json:2`): an `event`-classed node receiving `property.set` of `RRULE:FREQ=WEEKLY;BYDAY=MO,FR` **with metadata** `{ exdates: ["2026-11-10"] }`, and a `task`-classed node receiving `RRULE:FREQ=DAILY;INTERVAL=2` with `completedOccurrences`. Only envelopes that apply cleanly — scope rejections are pinned by the existing store R3 tests, not here. Claim a UUID segment per the fixture comment convention.
- [ ] **Step 2:** Add the filename to the exact-list assertion in `packages/protocol/test/protocol.test.ts`.
- [ ] **Step 3: Run** — `pnpm --filter @notees/protocol test` (validates envelopes + file list) and `pnpm --filter @notees/store test` (replays the envelopes through both adapters) — green.
- [ ] **Step 4: Commit** — `test(protocol): recurrence-property fixture — repeat property writes ride the wire`

### Task 6: Migration script + rehearsal

**Files:**
- Create: `scripts/migrate-repeat-property.mts`
- Test: `apps/server/test/migrate-repeat-property.test.ts`

**Interfaces:**
- Consumes: Task 1 `legacyRecurrenceToRRule`, `parseRecurrenceRule`, `formatRecurrenceRule`; Task 2's fixed ids; the skeleton of `scripts/migrate-pmid-property.mts` (live-stack `--server http://localhost:8377` append path via `POST /api/admin/append`, `buildScratchStore`, `validateEnvelopes` + simulate + post-insert verify gates, dry-run default, `--apply` backs up `relay.db`; and `scripts/migrate-meeting-date-retirement.mts` for the full value-move shape).
- Produces: exported `planRepeatPropertyMigration(store)`, `buildRepeatPropertyEnvelopes(plan, stamp)` for the rehearsal; CLI `--apply [--server <url>]`.

- [ ] **Step 1: Write the failing rehearsal test** `apps/server/test/migrate-repeat-property.test.ts`, following `migrate-meeting-date-retirement.test.ts`'s four-phase shape (dry-run spawns nothing; in-process plan/envelope assertions; `--apply` + fresh-hydration verify; second `--apply` proves idempotency). Seed a pre-migration workspace through the store with: (a) an event whose datetime value carries `metadata.repeat: "weekly"` + `exdates`; (b) a task with `"weekdays"` + `completedOccurrences`; (c) a **source** with `"monthly"` (the out-of-scope arm — must be reported and stripped, with NO `property.set` of repeat for it); (d) the legacy `taskRecurrence` select schema present. Assert: (a)(b) end with a repeat property value whose text is the canonical RRULE (weekly → anchor weekday; weekdays → `BYDAY=MO,TU,WE,TH,FR`), exception metadata moved to the repeat value, datetime value metadata stripped of all four keys; (c) repeat-free, old keys stripped, node named in the report; (d) …006 schema deleted, …0013 schema created (text, both scopes) with both binding rows; idempotent second run plans nothing.
- [ ] **Step 2: Run, verify red** — `pnpm --filter @notees/server test`.
- [ ] **Step 3: Implement** `scripts/migrate-repeat-property.mts`:
  - Plan query: scan `property_value` rows whose `metadata` JSON contains a `repeat` key (SQLite JSON functions, same idiom as the meeting-date script's metadata reads); join the node's class closure to test event/task reachability (reuse the closure walk idiom from the meeting script).
  - Envelopes (one HLC clock, fresh ids, fixed ACTOR/DEVICE/CLIENT constants — copy the pmid header constants): `propertySchema.delete` …006 when present; `propertySchema.create` …0013 `{ name: "Repeat", type: "text", scopeClassIds: [event, task] }`; `class.property.set` binding rows for event and task; for each eligible node `property.set` repeat value (text = `legacyRecurrenceToRRule(old, anchorIso)`, anchor = the datetime value's own day) carrying `exdates`/`until`/`completedOccurrences` moved from the datetime metadata; `property.set` the datetime value re-committed verbatim with the four keys removed from its metadata.
  - Gates: `validateEnvelopes`, simulate-on-scratch (drop applier-rejected + report), post-insert verify on a fresh scratch replay asserting the Task 6 test's end state.
  - The scope-check consequence: repeat `property.set`s are only emitted for eligible nodes, so the applier's R3 check never fires; ineligible nodes get only the metadata-strip envelope.
- [ ] **Step 4: Run, verify green** — `pnpm --filter @notees/server test`.
- [ ] **Step 5: Commit** — `feat(scripts): migrate-repeat-property — legacy metadata.repeat converges onto the repeat property`

### Task 7: Slice-1 gate, changelog, landing

- [ ] **Step 1:** Full gate: `cd /root/projects/notees-sync && pnpm install && pnpm typecheck && pnpm test`. All green.
- [ ] **Step 2:** CHANGELOG.md under `## 2026-11-06`, newest first: `**feat(domain,store,protocol,scripts): recurrence becomes the dedicated repeat property …**` — why (implicit metadata recurrence leaked onto any date), mechanism (RR5 grammar in domain, event+task-scoped text property at …0013, taskRecurrence …006 withdrawn, ensureTaskFamilyRows binding, migration + fixture), docs (SCHEMA.md), verification (suite counts).
- [ ] **Step 3:** Land per repo law: from the main checkout — `git fetch origin && git pull --ff-only` (tree clean apart from the other session's files — never stage them), `git merge --ff-only recurrence-core`... if `main` moved, rebase the branch first: `git -C .worktrees/recurrence-core rebase main`, re-run the gate, then fast-forward merge, push, `git worktree remove .worktrees/recurrence-core && git branch -d recurrence-core`. Confirm `main` sits at `origin/main`.
- [ ] **Step 4:** GTK/Flutter lockstep note: no wire change (text property values + metadata are existing wire), so no fixture-lockstep PR is owed; domain API changes flow to the other clients at their next vendor bump. State this in the changelog entry.

## Slice 2+3 — Client (notees-web, one branch, one release train)

Work in the repo's own worktree: `git -C /root/projects/notees-web worktree add .worktrees/recurrence -b recurrence main` (check `git status --porcelain` first; the landing rule applies — main checkout must end at `origin/main`).

### Task 8: Vendor bump

- [ ] **Step 1:** After Task 7's push: `git -C /root/projects/notees-web/vendor/notees fetch origin && git -C /root/projects/notees-web/vendor/notees checkout origin/main`.
- [ ] **Step 2:** `cd /root/projects/notees-web && pnpm -r --filter "@notees/*" build && pnpm install` (lockfile tracks the submodule pointer).
- [ ] **Step 3:** `pnpm --filter @notees/web test` — expect RED in recurrence-related tests (old grammar forms now fail-loud) — that confirms the bump took; do not fix anything yet.
- [ ] **Step 4:** Commit — `chore(vendor): bump notees pin — repeat property seed + RR5 grammar`.

### Task 9: Rewire the recurrence consumers

**Files:**
- Modify: `apps/web/src/features/calendar/calendarRows.ts` (`taskRowFacts` :57, `setTaskDone` :122-146, `recurringRowsOf` :218, imports :13-28)
- Modify: `apps/web/src/features/calendar/calendarRecurrence.ts` (`recurringDateRowOf` :63-83, `deleteOccurrence` :185, `editOccurrence` :215, continuation minting :264-269)
- Modify: `apps/web/src/features/calendar/calendarViewUtils.ts` (`OpenTaskRow` :159, `partitionOpenTasks` :207, `occursOnDay` :532, `repeatLabelOf` :537)
- Create: `apps/web/src/features/calendar/repeatProperty.ts`
- Test: `apps/web/test/recurrence.test.tsx`, `apps/web/test/calendar-recurrence.test.ts`, `apps/web/test/recurrence-completion.test.tsx`

**Interfaces:**
- Consumes: vendor `@notees/domain` Task 1 exports (`parseRecurrenceRule`, `formatRecurrenceRule`, `recurrenceSeriesOf(rule, metadata, anchorIso)`, `RecurrenceRule`, `RECURRENCE_WEEKDAYS`, `weekdayOfIso`).
- Produces (Tasks 11-13 consume these exact names from `features/calendar/repeatProperty.ts`):
  - `export interface RepeatFacts { rule: RecurrenceRule; anchorIso: string; row: EffectiveProperty }`
  - `export function repeatFactsOfNode(client: AnyClient, nodeId: string): RepeatFacts | null` — the node's authored Repeat property row (schema id `SYSTEM_PROPERTY_UUIDS.repeat`); resolves the value via `repeatTextOf`, anchor = the driving datetime row's day (event family: `eventDate`; tasks: `taskScheduled` — the first authored datetime row's day, same resolution `recurringRowsOf` uses); null when no repeat value
  - `export function repeatTextOf(client: AnyClient, value: unknown): string | null` — plain string as-is; `{ nodeId }` carrier → the node's flattened text content (domain's content-stringify export); anything else → null (the caller's `parseRecurrenceRule` then throws fail-loud on non-null)
  - `export function drivingDateRow(client: AnyClient, nodeId: string): { row: PropertyRowShell; anchorIso: string } | null` — first authored datetime row with a resolvable day (the anchor source `recurringRowsOf` already uses `scheduledIsoOf`)
  - `export function repeatSummaryOf(rule: RecurrenceRule, anchorIso: string): string` — "Every 2 weeks on Mon, Fri", "Monthly on day 3", "Yearly on 29 Feb", ends suffix " · ends after 10 occurrences" / " · ends 31 Dec 2026" / " · ends never" omitted for Never
  - `export async function setRepeatRule(client, nodeId, rule: RecurrenceRule | null): Promise<void>` — rule → `client.setProperty(nodeId, repeatId, formatRecurrenceRule(rule), 0, keep existing metadata)`; null → `client.unsetProperty(nodeId, repeatId, idx)`; validation per Task 11's rules runs in the control, not here
  - `export async function setRepeatMetadata(client, nodeId, metadata): Promise<void>` — re-commit the repeat value verbatim with new exception metadata (the `withExdate`/`withUntil`/`withCompletedOccurrence` call sites' write path)

- [ ] **Step 1: Write the failing tests** (rewrite the three test files' recurrence fixtures to the new model):
  - `recurrence.test.tsx`: the event-family helper writes repeat via `client.setProperty(id, SYSTEM_PROPERTY_UUIDS.repeat, "RRULE:FREQ=WEEKLY;BYDAY=MO,FR", 0, exdateMetadata)` instead of datetime metadata; occurrences/dots/day-sections assertions unchanged. NEW pin (Review Focus 5): a repeat value authored as a `{ nodeId }` carrier (create a block whose text is a canonical RRULE, set it as the repeat value) reads as a series. NEW pin (Review Focus 3): re-pick the task's `taskScheduled` day → series follows the new anchor, repeat value and `completedOccurrences` untouched. The old `repeatPickerOption` helper and the panel-picker write test are deleted here (the panel test returns in Task 12).
  - `calendar-recurrence.test.ts`: `deleteOccurrence`/`editOccurrence` scope semantics unchanged, but assertions read/write the repeat property value + metadata (the continuation's re-minted rule is now `formatRecurrenceRule(rule)` — assert the canonical RRULE string).
  - `recurrence-completion.test.tsx`: `setTaskDone` recurring arm writes `completedOccurrences` on the repeat value's metadata; per-occurrence strike + reopen pins unchanged.
- [ ] **Step 2: Run, verify red** — `pnpm --filter @notees/web test`.
- [ ] **Step 3: Implement**:
  - `repeatProperty.ts` per the Interfaces block (the heavy-text two-pass: `getPropertyRowShells` first — a repeat row with `valueCount ≥ 1` triggers the `getEffectiveProperties` read for that node only).
  - `calendarRows.recurringRowsOf`: shells scan finds candidate nodes (authored repeat row, `valueCount ≥ 1`), then `repeatFactsOfNode` per candidate; `{ node, series: recurrenceSeriesOf(facts.rule, facts.row.metadata, facts.anchorIso), time: timeOfValue(driving value) }`; a node with a repeat value but no resolvable anchor is skipped (spec: occurs nowhere); corrupt rule/metadata still throws (fail loud).
  - `taskRowFacts`: `repeat`/`completedOccurrences` read from `repeatFactsOfNode` (null-safe: plain task → null/[]).
  - `setTaskDone` recurring arm: `withCompletedOccurrence` on the repeat row's metadata, re-committed via `setRepeatMetadata`.
  - `calendarRecurrence.ts`: `recurringDateRowOf` → `repeatFactsOfNode` (rule + anchor + metadata row); all writes target the repeat property value/metadata; the continuation re-mints via `formatRecurrenceRule` (delete the old freq/interval string minting); `copyEventNode` carries the repeat property (add `setProperty` for the repeat value + metadata to the op batch).
  - `calendarViewUtils.repeatLabelOf` → reimplemented on `repeatSummaryOf` (keep the export name — the tasks hub and calendar labels consume it).
- [ ] **Step 4: Run, verify green** — `pnpm --filter @notees/web test`.
- [ ] **Step 5: Commit** — `refactor(web): recurrence consumers read the repeat property — datetime metadata retired`

### Task 10: Remove the implicit affordance

**Files:**
- Delete: `apps/web/src/features/date-pickers/RepeatPicker.tsx`, `apps/web/src/features/date-pickers/RepeatPicker.css`
- Modify: `apps/web/src/features/date-pickers/DatePickerPopup.tsx` (props :52, :164-167, :184-185; Repeat row :694-703)
- Modify: `apps/web/src/features/date-pickers/DateSlotControl.tsx` (props :65-69; rider :112-119; passthrough :126-127)
- Modify: `apps/web/src/features/metadata/DatetimePropertyRow.tsx` (`setRepeat` :134-140; popup wiring :164-169; picker mounts :277-286 and :352-361; import :22)
- Modify: `apps/web/src/features/classview/taskFamily.ts` (drop the `taskRecurrence` seed entry :143-150)
- Test: `apps/web/test/recurrence.test.tsx` (add the regression probe)

- [ ] **Step 1: Write the failing regression probe** in `recurrence.test.tsx`: render the Properties section on a `source`-classed node carrying a `publicationDate` day value — **assert no repeat affordance exists** (no `RepeatPicker`, no element whose accessible name starts "Repeat for", the date-picker popup contains no Repeat row when opened). Also assert `taskFamily.ts`'s TASK_FAMILY_SEED no longer seeds `taskRecurrence` (the task-family test at `apps/web/test/task-family.test.ts:104-130` is updated: the seeded family includes `repeat` instead — update, don't delete).
- [ ] **Step 2: Run, verify red** — probe fails (affordance present / taskRecurrence still seeded).
- [ ] **Step 3: Implement the removals** — delete `RepeatPicker.tsx` + CSS; strip the repeat props/row/passthrough from the three date controls (delete `setRepeat` whole); drop the `taskRecurrence` entry from `TASK_FAMILY_SEED` (repeat arrives via the domain seed envelopes + `ensureTaskFamilyRows`). Grep after: `RepeatPicker|onRepeatChange|repeatLabel=` returns nothing under `apps/web/src`.
- [ ] **Step 4: Run, verify green** — `pnpm --filter @notees/web test` + `pnpm --filter @notees/web typecheck`.
- [ ] **Step 5: Commit** — `refactor(web): repeat leaves the generic date controls — recurrence is deliberate or absent`

### Task 11: RepeatControl kit component

**Files:**
- Create: `apps/web/src/components/ui/kit/RepeatControl.tsx`, `apps/web/src/components/ui/kit/RepeatControl.css`, `apps/web/src/components/ui/kit/repeatSummary.ts`
- Modify: `apps/web/src/components/ui/kit/index.ts` (barrel)
- Test: `apps/web/test/repeat-control.test.tsx`

**Interfaces:**
- Consumes: `BooleanToggle` (kit), `Dropdown` (kit, for the unit select), `@notees/domain` Task 1 types; `repeatSummaryOf` moves INTO `repeatSummary.ts` (kit) from `repeatProperty.ts` — Task 9's `calendarViewUtils.repeatLabelOf` re-exports it from there (update Task 9's import in this task).
- Produces:
  - `export interface RepeatControlProps { value: RecurrenceRule | null; anchorIso: string | null; disabled?: boolean; disabledHint?: string; onChange: (rule: RecurrenceRule | null) => void; id?: string }`
  - `export function RepeatControl(props: RepeatControlProps): JSX.Element`
  - `export function repeatSummaryOf(rule: RecurrenceRule, anchorIso: string): string` (pure, unit-pinned)
  - `export function validateRepeatDraft(draft: RecurrenceRule, anchorIso: string | null): string | null` — returns an accessible error string or null; rules: interval 1..999; `byday` non-empty when present; `bymonthday` within 1..31; `count` ≥ 1; `until` a valid day ≥ anchor (when anchor known); `count`+`until` not both set.

- [ ] **Step 1: Write the failing tests** `apps/web/test/repeat-control.test.tsx`:
  - `repeatSummaryOf` pins (the four shapes + ends variants);
  - `validateRepeatDraft` pins every Review Focus 4 case;
  - Render (RTL, the kit test idiom — copy an existing kit component test): off-state shows the toggle only; switching on reveals the panel with interval=1/unit=days defaults; changing unit to weeks shows seven chips with the anchor's weekday preselected (anchor given); unit months shows the day-of-month input prefilled from the anchor; "Ends" radio switches the end input (occurrences number vs date); summary line updates live; switching the toggle off calls `onChange(null)`; `disabled` renders the hint and fires no `onChange`.
- [ ] **Step 2: Run, verify red**.
- [ ] **Step 3: Implement** the three files. Structure: the off-state toggle row (`BooleanToggle` + "Repeat" label); the panel: interval `input[type=number]` (min 1, max 999) + unit `Dropdown` (days/weeks/months/years); `weeks` → 7 toggle chips (`aria-pressed`); `months` → `input[type=number]` 1..31; `Ends` — three radios (Never / After [n] occurrences / On [date]) with `input[type=date]` for On; a muted summary line (`repeatSummaryOf`); a "Does not repeat" text button clearing to null. Draft state converts to a `RecurrenceRule` and runs `validateRepeatDraft` before `onChange`; invalid drafts show the error in an `aria-live` region, set `aria-invalid` on the offending input, and never call `onChange`. CSS: token-only, copy the `RepeatPicker.css` idiom (`nt-repeat-*` classes), header contract comment, `.sr-only` accessible-name idiom, touch floors.
- [ ] **Step 4: Run, verify green** — test + typecheck.
- [ ] **Step 5: Barrel export** — add `RepeatControl` + `repeatSummaryOf` to `components/ui/kit/index.ts`.
- [ ] **Step 6: Commit** — `feat(web): RepeatControl kit component — deliberate recurrence authoring`

### Task 12: Properties-panel Repeat row

**Files:**
- Create: `apps/web/src/features/metadata/RepeatPropertyRow.tsx`
- Modify: `apps/web/src/features/metadata/GroupedPropertyRow.tsx` (dispatch :65-172), `apps/web/src/features/metadata/PropertiesTable.tsx` (ungrouped scalar path :218)
- Test: `apps/web/test/recurrence.test.tsx` (the panel test returns)

- [ ] **Step 1: Write the failing test** in `recurrence.test.tsx`: on an event-classed node, the Properties section renders the Repeat row (toggle off, dimmed with the from-class hint — the bound-empty virtual row); switching the toggle on writes the property (`getEffectiveProperties` shows the authored RRULE text value); the row survives the panel's ordinary chrome (right-click → Value history works; Remove from node drops the declaration); re-picking the eventDate in the datetime row does NOT touch the repeat value (rule kept).
- [ ] **Step 2: Run, verify red**.
- [ ] **Step 3: Implement** `RepeatPropertyRow.tsx`: reads `repeatFactsOfNode` + `drivingDateRow` for the anchor; renders `RepeatControl` (`anchorIso` from the driving date, `disabled` + `disabledHint: "Set a date first"` when null); `onChange` → `setRepeatRule`. Register the arm **before** the type dispatch in `GroupedPropertyRow` (`if (propertySchemaId === SYSTEM_PROPERTY_UUIDS.repeat) return <RepeatPropertyRow …>`) and in the ungrouped `ScalarPropertyValue` branch in `PropertiesTable` (same condition) — the default text row (carrier blocks) must never render for repeat.
- [ ] **Step 4: Run, verify green**.
- [ ] **Step 5: Commit** — `feat(web): Repeat row in the Properties panel — recurrence as a first-class property`

### Task 13: Event-creation modal Repeat section

**Files:**
- Modify: `apps/web/src/features/calendar/EventCreateModal.tsx` (form :210-258, `create()` :106-185, props :33-50)

- [ ] **Step 1: Write the failing test** (extend the modal's test file — find it under `apps/web/test/`, e.g. the calendar creation tests): open the modal prefilled with a day, switch Repeat on, set every-2-weeks on Mon, submit → the created event-classed node carries the eventDate value AND the repeat RRULE value; with the toggle left off, no repeat property value is authored. Also pin: the ghost's Enter-path quick create (`TimeGrid.tsx` `confirmGhost`) intentionally authors no repeat (deliberate surface — modal only).
- [ ] **Step 2: Run, verify red**.
- [ ] **Step 3: Implement**: local `const [repeat, setRepeat] = useState<RecurrenceRule | null>(null)`; render `<RepeatControl value={repeat} anchorIso={startIso} onChange={setRepeat} />` after the end-day/time row, before the hint; in `create()`, after the eventDate `setProperty`, `if (repeat !== null) await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.repeat, formatRecurrenceRule(repeat), 0);`.
- [ ] **Step 4: Run, verify green**.
- [ ] **Step 5: Commit** — `feat(web): event-creation modal authors recurrence deliberately`

### Task 14: Docs, changelog, gates, landing

- [ ] **Step 1: Docs** — `docs/features/calendar.md` (:22 "Repeating events" rewrite: Repeat panel row + modal, RR5 options, exceptions on the repeat value; :17 occurrence-scope dialog unchanged; :38 "computed, not stored" bullet updates to the property); `docs/features/properties.md` (:14 — the picker bullet loses its "a Repeat row" clause; add the Repeat-row sentence to the panel bullet list); `docs/features/tasks.md` (:15 — `completedOccurrences` rides the repeat value's metadata); `docs/README.md` (:39 blurb if it names the ⟳ picker).
- [ ] **Step 2:** `pnpm --filter @notees/web test`, `pnpm --filter @notees/web typecheck`, `pnpm --filter @notees/web build` — all green; `node scripts/check-css-tokens.mjs` if new CSS hooks were added (should be token-only — expect pass).
- [ ] **Step 3:** CHANGELOG.md under `## 2026-11-06`, newest first: `**feat(web): recurrence becomes a deliberate Repeat surface …**` — why, mechanism (consumer rewire, removals, RepeatControl, panel row, modal section, docs), verification.
- [ ] **Step 4:** Land: rebase `recurrence` onto freshest `main`, re-run gates, fast-forward merge in the main checkout, push, remove the worktree + branch (repo law — main checkout ends at `origin/main`).
- [ ] **Step 5:** Redeploy what you ship: rebuild the web image on the fleet host per the notees-operations runbook (scoped build), then the `verify-min.mjs` smoke. Coordinate with any parallel session before touching the stack.

## Self-review record

- Spec coverage: model/wire → T1-T6; surfaces → T11-T13; removals → T10; read model → T9; errors/fail-loud → T1 corpus + T9 pins; testing → per-task; docs/changelog → T3, T7, T14. Design amendments discovered while planning (taskRecurrence withdrawn for a new …0013 id — type is create-only; ineligible-node migration arm is report+strip because the applier refuses ineligible `property.set`; heavy-text two-pass read) are written back into DESIGN.md.
- Placeholder scan: no TBDs; every code step names the file, shape, and test command.
- Type consistency: `RecurrenceRule`/`RecurrenceSeries`/`RepeatFacts`/`repeatSummaryOf`/`setRepeatRule`/`setRepeatMetadata`/`validateRepeatDraft` used identically across T1, T6, T9, T11-T13.
- Review Focus: all five pinned — (1) T1 rejection corpus + T6 verify, (2) T6 rehearsal arm (c), (3) T9 test pin, (4) T11 validation tests, (5) T9 carrier pin.
