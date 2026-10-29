# Citekey-centric display + search — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Class-level `displayTemplate` on the wire (`source` seeds `"@{{citekey}}"`, AV family + `book` opt out) rendered across web reference chrome, plus store-search fan-out so bare terms and `@`-mentions match property values (citekey/authors).

**Architecture:** One additive optional payload key on `class.create`/`class.update` (tri-state: absent = inherit, `""` = opt-out, string = template), one derived `class.display_template` column (schema v36), read-time extends-aware resolution in the store, a render-layer override at the web's single title seam (`dateDisplay.ts`), and a property-value probe inside the store's ranked FTS search. The search half ships with zero protocol change (spec mechanism amendment — see spec Decision 3).

**Tech Stack:** TypeScript (Node 22, pnpm 9), zod payload schemas, vitest, better-sqlite3 + sql.js store adapters, tsx migration scripts.

**Spec:** `.plans/2026-10-29-1400-citekey-centric-display-and-search/proposal.md` — the plan argues from it; executors read both.

## Global Constraints

- Blocking gate: `pnpm typecheck && pnpm test` from the repo root, all green, before any commit.
- Dev-condition exports: vitest reads `src`, `tsc` reads `dist` — after changing a package's public API, rebuild its dist (`pnpm --filter <pkg> build`) before typechecking dependents.
- Work happens in the worktree `.worktrees/citekey-centric` (branch `citekey-centric`); per-file staging only (never `git add -A`); Conventional Commits; CHANGELOG entry per landed slice; push is standing authorization.
- Fixture gate: a new payload key needs a canonical fixture + TS applier + GTK/Flutter lockstep in the same slice (law 10). The fixture list test pins the exact file list — adding `class-display-template.json` means editing that list in the same task.
- Wire: envelope **v3**, additive optional key only — no version bump, retired-key rules unchanged.
- Seed changes align GTK (`/root/projects/notees-gtk`) + Flutter (`/root/projects/notees-flutter`) in the same slice; read each repo's AGENTS.md before touching it. CLI picks up packages via its pinned `vendor/notees` submodule bump (recorded follow-up, not this plan).
- Migrations: Path A appended envelopes only (relay log never edited), zod-validated before insert, idempotent, DRY RUN by default, `--apply` writes + verifies against a fresh scratch store.
- Any live-workspace probe uses the test workspace `c491595f-9f94-5ade-a620-e30ed063d8d2`, never the personal "Notas" workspace.
- UI: fleet components only; adaptive values per the UI primitives law.

## Review Focus

1. **User-customized template vs migration:** a user who changed their `source` template must NOT be re-converged by the migration script — it appends only where `display_template IS NULL` (never set), never where the value merely differs from the seed target.
2. **Old-client late envelope:** a `class.update` from a pre-feature client (key absent) arriving after a template was set must preserve it (`undefined` skips the SET clause; flag-less `class.create` re-issue preserves via COALESCE) — on both store adapters, and under fixture idempotent re-apply.
3. **Template renders empty → title:** a source with unvalued citekey whose template resolves to `""`/`"@"` after trimming must render the content-flatten title, never a blank row (in pickers, backlinks, search rows).
4. **Opt-out `""` must survive the wire:** zod/JSON round-trip keeps `""` distinct from absent/null — an opted-out class (video) must not inherit after sync replay.
5. **Search probe hygiene:** the property fan-out must not match tombstoned property values, trashed (`is_active = 0`) nodes, and must dedupe nodes that also FTS-matched (FTS rank wins, single row).
6. **Multiple templated classes on one node:** first assigned class (class_ids JSON order) with a resolved template wins; documented, pinned by test.

---

### Task 0: Worktree setup

- [ ] **Step 1:** `git fetch origin && git worktree add .worktrees/citekey-centric -b citekey-centric main && cd .worktrees/citekey-centric && pnpm install`
      Expected: clean install; `pnpm test` baseline green (red files you did not touch are another session's in-flight work — report, don't fix). If `.git/index.lock` exists or main moved, wait and redo.

### Task 1: Wire + fixtures — `displayTemplate` on the class

**Files:**
- Modify: `packages/protocol/src/op-types.ts` (classCreatePayload ~218-242, classUpdatePayload ~244-261)
- Create: `packages/protocol/fixtures/class-display-template.json`
- Modify: `packages/protocol/test/protocol.test.ts:45-96` (fixture list 46 → 47)
- Modify: `packages/store/src/schema.ts` (SCHEMA_VERSION 35 → 36, `class` table DDL ~271, v35→v36 delta block after ~1484)
- Modify: `packages/store/src/appliers.ts` (`applyClassCreate` ~1565-1655, `applyClassUpdate` ~1657-1696, `upsertClassNode` stays untouched)
- Modify: `packages/store/src/store.ts` (`NodeRow`/`class` row types as applicable)
- Test: `packages/store/test/store.test.ts` (new describe next to the parentlessRole block at ~4520-4636)

**Interfaces:**
- Produces: payload key `displayTemplate: z.string().max(1024).nullish()` on both payloads (absent = inherit, `""` = opt-out, string = template; present-null clears); derived column `class.display_template TEXT` (NULL = inherit, `''` = opt-out); applier semantics `undefined → skip SET / COALESCE preserve`, `null → write NULL`, `"" → write ""`.
- Produces: store read helpers — `getClassDisplayTemplate(db, classId): string | null` (raw column) and `resolveEffectiveDisplayTemplate(db, classId): string | null` (own non-empty → own; own `""` → null with stop; NULL → walk `class_hierarchy` ancestors nearest-first, first non-NULL wins; ancestor `""` stops with null). Used by Task 4 (web render).

- [ ] **Step 1: Write the failing store tests** — new `describe("displayTemplate (class field)")` in store.test.ts, both adapters: create with template writes `class.display_template`; create absent → NULL; update presence-writes, present-null clears to NULL, `""` round-trips; flag-less re-create preserves; `resolveEffectiveDisplayTemplate` matrix — own template, own `""` opt-out beats ancestor template, absent inherits nearest ancestor with template, ancestor `""` stops inheritance; full fixture replay + idempotent re-apply.
- [ ] **Step 2: Run — expect FAIL** (column does not exist / helper undefined).
- [ ] **Step 3: Implement** — payload key (copy the `parentlessRole` declaration idiom + a contract comment citing SCHEMA.md); schema v36 delta block with the `PRAGMA table_info` guarded ALTER on `class` only (the `node` table is NOT touched — display reads go through store helpers, unlike the page-predicate `parentless_role`); applier `class.create` INSERT...ON CONFLICT with `COALESCE(excluded.display_template, class.display_template)` + `p.displayTemplate ?? null` insert value; `class.update` `if (p.displayTemplate !== undefined)` push SET (copy the parentlessRole arms at ~1678-1681).
- [ ] **Step 4: Write the fixture** `class-display-template.json` — envelope set: `class.create {displayTemplate: "@{{citekey}}"}` on a class; member `object.create`; a second class `class.setExtends` → first; `class.update {displayTemplate: ""}` on a third class extending first (opt-out stop); `class.update {displayTemplate: null}` (clear). Format per `class-parentless-role.json` (comment + envelopes array, envelope fields id/protocolVersion 3/workspaceId/actorId/deviceId/client/hlc/affectedNodeIds/opType/timestamp/payload).
- [ ] **Step 5: Update the fixture list** in protocol.test.ts (46 → 47 names, add `class-display-template.json`).
- [ ] **Step 6: Run gate** — `pnpm --filter @notees/store build && pnpm --filter @notees/protocol build && pnpm typecheck && pnpm test`. Expected: all green.
- [ ] **Step 7: Commit** `feat(protocol+store): class displayTemplate payload + derived column (schema v36)` — per-file staging.

### Task 2: Domain manifest + write-time validation

**Files:**
- Modify: `packages/domain/src/seeds.ts` (new manifest near `SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK` ~1406)
- Create: `packages/domain/src/display-template.ts` (validation + placeholder parsing)
- Modify: `packages/domain/src/index.ts` (barrel)
- Test: `packages/domain/test/domain.test.ts` (next to the parentlessRole seed pin at ~672)

**Interfaces:**
- Produces: `SYSTEM_CLASS_DISPLAY_TEMPLATES: Partial<Record<SystemClassName, string>>` — `source: "@{{citekey}}"`, opt-outs `""`: `film`, `tv_broadcast`, `audio_recording`, `radio_broadcast`, `podcast`, `video_recording`, `book`. Every other roster class absent (inherits).
- Produces: `parseDisplayTemplate(template: string): string[]` (extracts placeholder schema names, `{{…}}` trimmed) and `validateDisplayTemplate(template: string, availableSchemaNames: Set<string>): void` (throws `DisplayTemplateError` listing unknown/empty placeholders). Pure functions — the wire payload itself stays unvalidated (appliers map without validating, parentlessRole precedent); validation fires at client write time (Task 4).
- Consumes: Task 1 payload key.

- [ ] **Step 1: Write failing tests** — manifest pins verbatim (source template + the 7 opt-outs, following the `"parentlessRole block seed pins the flagged roster verbatim"` pattern at domain.test.ts:672); `parseDisplayTemplate` cases (`"@{{citekey}}"` → `["citekey"]`, `"{{authors}} ({{year}})"` → both, no placeholders → `[]`, whitespace tolerated); `validateDisplayTemplate` throws on unknown name, empty placeholder, non-string; passes on available names.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the manifest + `display-template.ts` (~60 lines, one placeholder regex, no template engine).
- [ ] **Step 4: Gate + commit** `feat(domain): displayTemplate seed manifest + placeholder validation`.

### Task 3: Seed emission + web class deploy convergence

**Files:**
- Modify: `apps/server/src/seed.ts` (`buildSeedEnvelopes` class arm ~35-57)
- Modify: `apps/web/src/features/classview/systemClassDeploy.ts` (`deploySystemClass` ~104-133)
- Modify: `apps/web/src/core/workspace-client/types.ts` (~132-136), `mappers.ts` (~29,72,119), `client-writes.ts` (~349-364), `worker-client.ts` (~805-822) — the parentlessRole plumbing shape, class-side only
- Test: server seed test (existing seed envelope test — extend), `apps/web` class-deploy test if one exists for parentlessRole (match it)

**Interfaces:**
- Produces: web client class shape gains `displayTemplate?: string | null`; `client.createClass(name, { id, icon, parentlessRole?, displayTemplate? })`; `client.updateClassDisplayTemplate(classId, template: string | null)`; worker round-trip carries the column.
- Consumes: Tasks 1-2.

- [ ] **Step 1: Write failing tests** — server seed emits `displayTemplate` on `class.create` for `source` (`"@{{citekey}}"`) and the 7 opt-outs (`""`) only; web createClass passes the option through to the payload; updateClassDisplayTemplate emits `class.update {displayTemplate}` (and `null` clear).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — seed.ts spreads `...(SYSTEM_CLASS_DISPLAY_TEMPLATES[name] !== undefined ? { displayTemplate: SYSTEM_CLASS_DISPLAY_TEMPLATES[name] } : {})`; web plumbing copies the parentlessRole arms exactly; systemClassDeploy: pass `displayTemplate` on create; converge on deploy — if the class exists and its `display_template` is NULL while the manifest has a non-empty template, emit the update (fresh-workspace convergence; existing workspaces converge by Task 4's migration, deploy-time convergence is a no-op then).
- [ ] **Step 4: Gate + commit** `feat(server+web): seed + deploy displayTemplate on system classes`.

### Task 4: Migration script `scripts/migrate-display-template.mts`

**Files:**
- Create: `scripts/migrate-display-template.mts`
- Test: scratch-store verification inside the script (`--apply` verify), plus a repo test only if migrate-seed-pins has one (match its convention; if none, the script's own verify + dry-run is the gate)

**Interfaces:**
- Consumes: Tasks 1-2 (payload key + manifest).
- Produces: CLI `pnpm --filter @notees/server exec tsx ../../scripts/migrate-display-template.mts --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]`.

- [ ] **Step 1: Implement following migrate-seed-pins.mts (413 lines) section-for-section** — targets = 8 manifest entries; plan step reads converged store rows and appends ONLY where `display_template IS NULL` (Review Focus 1 — never overwrite a user-set value, including `""`); envelopes = `class.update {classId, displayTemplate}` with shared-physical/per-envelope-logical HLC, constant actor/device/client strings; zod validation gate; `--apply` = relay backup + `ingest` + fresh-scratch-store verify asserting each target row now equals the seed value.
- [ ] **Step 2: Dry-run against the dev relay** (`--data-dir config/notees/sync`, test workspace) — expect a printed plan, no writes.
- [ ] **Step 3: Commit** `feat(scripts): displayTemplate seed convergence migration`.

### Task 5: Web render — template override at the title seam

**Files:**
- Modify: `apps/web/src/ui/dateDisplay.ts` (`TitleClient` ~168-173, `titleFromNode` ~198, opts type ~141-163)
- Modify: `apps/web/src/features/collection/propertyDisplay.ts` (`propertyDisplayText` reuse, no change expected)
- Modify: `apps/web/src/ui/PageChrome.tsx` (~263,358,405 — opt out)
- Modify: `apps/web/src/core/workspace-client/client-reads.ts` (~56-70 `getDisplayName` docstring seam)
- Test: new `apps/web/test/` test matching existing dateDisplay/title tests (check for an existing `dateDisplay` test file first; if none, create one in the established web test style)

**Interfaces:**
- Consumes: Task 1 `resolveEffectiveDisplayTemplate` (via worker read), Task 2 `parseDisplayTemplate`, web effective-properties read (`getEffectiveProperties` equivalent in client-reads-props), `propertyDisplayText` for value flattening.
- Produces: `titleOf`/`titleOfNode` opts gain `template?: "on" | "off"` (default `"on"`). Off only at PageChrome's own-header reads. Resolution rule (documented in the function docstring): for a non-date, non-class node, first class in `class_ids` order whose effective template resolves is used; placeholders → effective property values flattened via `propertyDisplayText`; fully-empty-after-trim (or template is effectively `""`) → content title.

- [ ] **Step 1: Write failing tests** — node with citekey "doe2024" + source class renders `@doe2024` via titleOf (capped budget applies); unvalued citekey → title fallback; opted-out class (video with citekey) → title; node with two classes, first templated wins; `template: "off"` returns content title; class nodes and date nodes never templated.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — in `titleFromNode` before the `fullTitleOf` call: the template branch (one helper `templatedTitleOf(client, node): string | null` in dateDisplay.ts or a sibling module); worker read exposing `resolveEffectiveDisplayTemplate`; PageChrome passes `template: "off"` at its three header reads. Mention chips/node links in BlockRow go through the same seam with the default on.
- [ ] **Step 4: Gate + commit** `feat(web): class displayTemplate renders at the title seam, header opts out`.

### Task 6: Store search fan-out — bare terms match property values

**Files:**
- Modify: `packages/store/src/search.ts` (`searchNodes` — the `client.search`/`searchPage` engine)
- Modify: `packages/store/src/store.ts` (~799-801 if the wrapper needs no change)
- Test: `packages/store/test/store.test.ts` (next to existing search tests; dual-adapter)

**Interfaces:**
- Produces: `searchNodes` results include nodes whose AUTHORED, visible `property_value` rows substring-match the term (CAST(value AS TEXT) LIKE), merged below FTS-ranked hits, deduped by node id (FTS rank wins). Tombstoned rows and `is_active = 0` nodes excluded (reuse `Compiler.visibleValuePredicate`-equivalent predicates local to store, or inline the tombstone NOT-EXISTS the compiler uses). This automatically covers CommandPalette, NodeSelector, SearchPage, and `@`-mention suggestions — all four ride `client.search`.
- Explicitly NOT changed: FTS index/schema, ranking formula for FTS hits, query AST.

- [ ] **Step 1: Write failing tests (dual adapter)** — source with citekey "doe2024" matches term "doe2024" and "doe"; authors multi-value match; a node matching both FTS and property appears once (FTS position); tombstoned property value does NOT match; trashed node does NOT match; term matching nothing still returns only FTS results (no regression).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — in `searchNodes`, after the ranked FTS select: a second select over `property_value pv JOIN node n ON n.id = pv.node_id` with the visibility/active predicates and the LIKE probe; union with `UNION`-style dedupe keyed on node id, property hits appended below FTS hits with a neutral rank. Parameterized — the term never reaches SQL as text.
- [ ] **Step 4: Gate + commit** `feat(store): search fan-out over authored property values`.

### Task 7: DSL pin + README/Deferred cleanup

**Files:**
- Test: `packages/query/test/dsl.test.ts`
- Modify: `packages/query/README.md` (Deferred list ~216-224)

**Interfaces:**
- Note: `citekey:term` and `author:term` already parse TODAY via the bare-schema shorthand (`buildPropertyCondition`, dsl.ts:429-431 → resolvePropertySchema by name). No parser change — this task pins the behavior and fixes the doc.

- [ ] **Step 1: Write failing-then-passing pin tests** — `citekey:doe2024` and `author:doe` parse to `{type:"property", schemaId: <resolved>, op:"contains", value:...}` under the dsl.test.ts resolver fixture; `citekey:="doe2024"` eq op.
- [ ] **Step 2: Run** — expect PASS without parser changes (tests are pins, not drives). If `author:` fails because the fixture resolver lacks the name, extend the fixture resolver — not the parser.
- [ ] **Step 3: README** — move the `author:`/`citekey:` lines out of Deferred with one sentence each (reachable as property-schema shorthand; dedicated fields deferred only if they ever need relation semantics).
- [ ] **Step 4: Gate + commit** `test(query): pin citekey/author property-shorthand parsing`.

### Task 8: SCHEMA.md + docs + CHANGELOG

**Files:**
- Modify: `packages/protocol/SCHEMA.md` — new normative bullet in the class-fields area (~265-269 or the `## Class properties` section ~302), the established idiom: contract, tri-state table, placeholder validation rule, "Canonical fixture `class-display-template.json`", LOCKSTEP-PENDING marker cleared in Task 10, migration pointer.
- Modify: `packages/query/README.md` (Task 7 did Deferred; add the fan-out paragraph to the search docs if search is documented there — check `docs/developers/` for the search runbook home and update it)
- Modify: `docs/` user-facing search/class docs where behavior is user-visible
- Modify: `CHANGELOG.md` — one entry under the current date heading (newest first; anchored, no reordering)

- [ ] **Step 1: Write the SCHEMA.md bullet** with the exact values from Task 1 (tri-state, `max(1024)`, fixture name, seed targets, opt-out roster).
- [ ] **Step 2: Docs sweep + CHANGELOG + gate + commit** `docs: displayTemplate contract + citekey-centric search`.

### Task 9: Source property-field UX — citekey regenerate + empty-field placeholder + input hover/focus

Added 2026-10-29 mid-flight (owner request). Three items, one web slice:

**Files:**
- Modify: `apps/web/src/features/metadata/TextPropertyRow.tsx` (the scalar-empty branch ~469-499; the citekey-row regenerate affordance)
- Modify: `apps/web/src/components/ui/kit/Input.tsx` + co-located CSS IF the searchbox trailing-button pattern and the hover/focus states belong at kit level (kit-first law: compose from `components/ui/kit/`, token-only CSS from `variables.css`, adaptive values — no hard px except hairlines/tap floors; `docs/developers/ui-primitives.md` is the runbook)
- Modify: `apps/web/src/features/sources/citekey.ts` ONLY if the pattern renderer can't be reused as-is
- Test: the existing web test covering TextPropertyRow / property rows (find it; match its style) + CHANGELOG.md entry in the same commit (own slice, own entry)

**Interfaces:**
- Consumes: `renderCitekeyPattern`, `DEFAULT_CITEKEY_PATTERN`, `CitekeyEntry` from `apps/web/src/features/sources/citekey.ts` (the existing pure citekey composition used by quick-create); the quick-create collision-scan idiom for suffixing.
- Produces: no wire/model change — the button writes through the row's existing `property.set` path (composes existing ops, undo-journal eligible).

**Behavior spec:**
1. **Regenerate button** — icon-only, circular-arrows MDI icon (match the app's existing icon idiom), rendered at the RIGHT edge INSIDE the citekey text field, the same trailing-button pattern as the searchbox clear "x". Only on the `citekey` property row of source-lineage nodes (key off class lineage like quickCreate.ts does — `collectSelfAndAncestors` vs the source system class, never a hardcoded node set). Click regenerates from the node's current metadata (authors/family + year + title tokens via `renderCitekeyPattern`), collision-suffixed against sibling sources (deterministic a/b/c, the quick-create idiom), and writes via `property.set`. Empty metadata → no-op (render disabled).
2. **Placeholder fix** — a default-sourced row whose value is the SCALAR EMPTY STRING (the citekey seed's `defaultValue: ""`) renders the SAME full-width "Type something" placeholder cell as a bound-but-empty row. Root cause (verified): `seeds.ts:835` seeds `citekey` with `defaultValue: ""` → the effective read synthesizes a default row with value `""` → TextPropertyRow takes the legacy-scalar branch (`scalarText === "" ? null`, plain-text cell, no placeholder). Authors shows the placeholder because it has no default. First edit still mints the carrier (unchanged semantics).
3. **Hover/focus states** — property text inputs get the Zotero-like treatment (owner refs: hover lightens the field background, focus draws the accent border). Apply at the kit level if kit `Input` is the shared carrier so all text fields inherit; otherwise the property-row inputs. No new design tokens without need; if a genuine deviation from the design system is introduced, record it in `.agents/design-overrides.md` (prefer none).

- [ ] **Step 1: Failing tests** — scalar-empty-default row renders the "Type something" cell (today: plain-text branch); regenerate button renders inside the citekey field for a source node, is absent on non-citekey rows and non-source nodes; click writes the pattern-rendered, collision-suffixed value through `property.set` (assert the op path the row already uses); disabled/absent when authors+title+date are all empty.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the three items per the behavior spec; CSS in the kit/property CSS with tokens.
- [ ] **Step 4: Gate + CHANGELOG + commit** `feat(web): citekey regenerate button + empty-field placeholder + input hover/focus states` (gate: `pnpm --filter @notees/web build && pnpm typecheck && pnpm test`).

### Task 10: GTK/Flutter lockstep + landing + live convergence

- [ ] **Step 1: GTK** (`/root/projects/notees-gtk`) — read its AGENTS.md; vendor `class-display-template.json` byte-identical into `tests/fixtures/wire/`; add `display_template` column (schema version bump per its convention); applier support for the payload key with the same tri-state semantics; pytest replay expectations; fixture sha256 check if it has one.
- [ ] **Step 2: Flutter** (`/root/projects/notees-flutter`) — same: `test/fixtures/wire/`, schema bump (its v38 line), Dart applier support, flutter_test replay.
- [ ] **Step 3: Clear the marker** — SCHEMA.md LOCKSTEP-PENDING → `LOCKSTEP SHIPPED <date> (TS reference + GTK schema vNN + Flutter schema vNN)`.
- [ ] **Step 4: Land the slice** — worktree gate green → fetch/rebase onto freshest main → fast-forward merge in the MAIN CHECKOUT (`git pull --ff-only` after the tree is clean — a checkout left behind origin/main silently ships stale code on the next compose build) → push → `git worktree remove .worktrees/citekey-centric` + `git branch -d citekey-centric`.
- [ ] **Step 5: Live convergence + redeploy** — invoke the `notees-operations` skill first; run the Task 4 migration `--apply` against the fleet stack's data dir (the test workspace first, then all workspaces per the owner's call); `docker compose build notees-sync notees-web && docker compose up -d` from the LIVE STACK folder; `verify-min.mjs` smoke expecting `VERIFY-PASS`.

## Self-review notes (written at plan time)

- Spec coverage: Decision 1 → Tasks 1-3; Decision 2 → Task 5; Decision 3 (amended) → Tasks 6-7; Decision 4 → Tasks 2-4; wire/fixture/lockstep → Tasks 1, 9; docs → Task 8. All covered.
- Type consistency: `displayTemplate` / `display_template` / `resolveEffectiveDisplayTemplate` / `SYSTEM_CLASS_DISPLAY_TEMPLATES` / `validateDisplayTemplate` / `parseDisplayTemplate` used consistently throughout; web client surface mirrors the parentlessRole names with `DisplayTemplate` substituted.
- Known open choice left to the implementer (bounded): the exact rank value for property hits in Task 6 (any constant below FTS ranks, pinned by the dedupe/ordering test); the module split inside dateDisplay.ts for `templatedTitleOf`.

### Task 11: UUID exact-match in the store search seam (owner request, mid-flight)

Pasting a node UUID into the picker (or any quick-search surface) must find the node. All four surfaces ride `searchNodesPage` (Task 6's seam), so one arm covers NodeSelector, CommandPalette, SearchPage, and `@`-mention suggestions.

**Files:**
- Modify: `packages/store/src/search.ts` (`searchNodesPage` — next to the Task-6 property arm)
- Modify: `packages/store/test/store.test.ts` (the search fan-out block, triple-adapter)
- Modify: `docs/features/search.md` + `CHANGELOG.md` (same-pass docs)

**Behavior spec:**
- When the trimmed term parses as a valid UUID (the UUIDv7 shape the platform mints — use the codebase's existing uuid-validation idiom), add an exact-id arm: `n.id = ?` over active nodes, merged into the same below-FTS tier as property hits, deduped by node id (FTS rank wins).
- Not substring, not prefix — exact only (YAGNI; partial fragments rarely typed deliberately).
- No FTS/index/rank changes; fully parameterized.

- [ ] **Step 1: Failing triple-adapter tests** — a node found by its full uuid via the seam; a non-uuid term gains no id-arm matches (regression: existing results unchanged); an unknown uuid returns only normal results; uuid term also works in a workspace where the node's title does NOT contain the term.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the arm in `searchNodesPage`.
- [ ] **Step 4: Gate + docs + commit** `feat(store): uuid exact-match in quick search` (gate: `pnpm --filter @notees/store build && pnpm typecheck && pnpm test`).

### Task 12: Source duplicate detection — grouping (pure layer)

**Files:**
- Create: `apps/web/src/features/sources/duplicates.ts`
- Test: `apps/web/test/sources-duplicates.test.ts` (the sources-data.test.tsx seedClient harness pattern)

**Behavior spec:**
- Pure function over the source-family row projection (the Sources-hub `SourceRow` shape from `sourcesQuery.ts`, or class members + effective properties — pick what carries title/authors/year/citekey/doi/isbn; the quick-create duplicate criteria at `quickCreate.ts:826-893` is the established matching idiom to reuse for normalization).
- Match edges: (a) IDENTIFIER equality — DOI (case-insensitive trimmed), ISBN (digits+X, uppercase), citekey (case-insensitive trimmed); (b) fuzzy key — normalized title (lowercase, diacritic-fold, punctuation stripped, whitespace collapsed) AND (publication year OR first-author family token; first author from the authors text's first segment or linkedAuthors first target familyName).
- Union-find over both edge types: sources linked transitively (A shares a DOI with B, a title with C) land in ONE group.
- Produces `groupSourceDuplicates(rows): Array<{ members: SourceRow[] }>` — only groups with ≥ 2 members, deterministic ordering (stable sort by first member id). Pure, derived, no wire/model change.

- [ ] **Step 1: Failing tests** — identifier groups (same DOI different titles; same citekey), fuzzy groups (same title+year; same title+first-author, year absent), transitive union (DOI edge + title edge → one group), non-duplicates stay ungrouped, normalization cases (case/diacritics/punctuation), determinism (input order shuffled → same output).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `duplicates.ts`.
- [ ] **Step 4: Gate + commit** `feat(web): source duplicate grouping` (gate: `pnpm --filter @notees/web build && pnpm typecheck && pnpm test`).

### Task 13: Duplicates view + merge modal in the Sources hub

**Files:**
- Modify: `apps/web/src/features/sources/SourcesHub.tsx` (a Duplicates mode — toolbar switch or facet entry; the hub is a single fixed view today, so this adds a mode, not a tab)
- Create: `apps/web/src/features/sources/SourcesDuplicates.tsx` (+ kit-composed CSS), `apps/web/src/features/modals/MergeDuplicatesModal.tsx`
- Test: `apps/web/test/sources-duplicates-view.test.tsx`, `apps/web/test/merge-duplicates-modal.test.tsx`

**Behavior spec:**
- Duplicates mode shows Task 12's groups as grouped lists: group header naming the match basis, member rows (title/authors/year/citekey/DOI via the existing sources row cells / `propertyDisplayText`), ONE "Merge" button per group. Empty state ("No duplicates") when no groups.
- Merge opens `MergeDuplicatesModal`: a DROPDOWN of the group's members as target candidates (owner requirement — not the free NodeSelector), defaulting to the first member; a dry-run summary of what merge will do (counts — the `MergePlanSummary` shape); confirm invokes the STANDARD merge flow — the same semantics as `MergeNodesModal` (`planMerge`, packages/store/src/merge.ts: losers' children/classes/properties/links/aliases move or copy-into-empty, losers go to TRASH — say so in the modal copy). Wiring: `client.mergeNodes` where the local planner is available (in-process mode, one undo batch); the server route `POST /api/objects/:id/merge {targetId}` (with `?dryRun=true` for the summary) where it is not (worker mode). Guard failures surface as an error line, modal stays open (the MergeNodesModal pattern).
- After a successful merge the duplicates view refreshes (the merged group disappears).
- UI: fleet kit components only, token-only CSS, adaptive values.

- [ ] **Step 1: Failing tests** — duplicates mode renders groups + per-group Merge; modal opens with the group's members in the target dropdown; confirm invokes the merge path (assert the ops / endpoint call for the chosen target, losers trashed); guard error shows the error line and stays open; after merge the group list refreshes.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Gate + docs (docs/features/sources or classes where the hub is documented) + CHANGELOG + commit** `feat(web): sources duplicates view + merge` (gate: `pnpm --filter @notees/web build && pnpm typecheck && pnpm test`).
