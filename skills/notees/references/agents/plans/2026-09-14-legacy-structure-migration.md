# Migrate legacy relay data to current op format + delete legacy "page" class

## What the investigation found (evidence-backed)

**Data profile** (dev relay `relay_envelope`, 121,612 ops, all `protocol_version` 1, single workspace `3b30e070-039b-47bc-ad0d-2440a2f173c5`):

- `node.create`: 29,995 of 30,282 carry a **string** `index` (`"0.0"`, `"0.5"`, `"-1.0"` — float ranks from the pre-local-first migration, written by `app/core/migration/nodes.py:196` via `str(sequence)`).
- `node.move`: 25,442 carry string `newIndex`.
- The TS applier backfills `node_child_order` only when `typeof index === 'number'` (`frontend/src/core/derived/childOrder.ts:137-144`, `:150-175`) → **full replay reconstructs almost no child order** (code comment quantifies: 25,531 rows collapse to 76). This is why "Applying operations" wipes page structure.
- Text content is safe: `node.ts:219-261` replays legacy `content` arrays, `crdtUpdate` ASTs and current `textUpdateB64` correctly.
- The user's new cocina blocks **never reached the relay** (no block `node.create` ops since 2026-09-11; today's 11 ops are only duplicate day-page creates + re-created default views — symptoms of a client that boots from empty state every reload).
- "page" class = `00000000-0000-0000-0001-000000000002` (not in `SYSTEM_CLASS_UUIDS`, legacy leftover): 1 `class.create` (backfilled at high seq 101455), 20 `class.delete` (seq 56xxx, higher HLCs), 5,353 `class.assign`, 0 unassigns. It resurrects because `class.create` applies `INSERT OR REPLACE … active=1` with **no LWW guard** (`frontend/src/core/derived/class.ts:131-149`) and catch-up applies pages in seq order, so the backfilled create lands *after* the deletes on every full replay.
- Backend has **no CRDT library** — server-side snapshots can never materialize tree-CRDT child order (`app/core/derived/node.py:278-281` stores/ignores); correct snapshots come from clients.
- Deep-link-on-reload already has its generation-counter fix (`useRouteAdapter.ts`); landing on "today" is most likely downstream of booting into an empty/lossy DB (route lookup fails → fallback). Re-verify after the fix; don't touch it preemptively.
- Boot persistence (`8f9638f9` IndexedDB fallback) shows no structural bug on main; full-replay-every-reload points to a stale bundle or failing IndexedDB writes — needs one browser-console check (`persistence=` log line) during verification.

## Approach

Append corrective ops in current format (operation log is immutable — project rule), computed by replaying the real TS appliers against a dump of the relay log with a corrected legacy positional interpreter. Single user, so convergence is achievable with full-state tree ops + fresh HLCs.

### Step 1 — Migration replay harness (TS, new file `scripts/migrate_legacy_structure.mts` run with `frontend/node_modules/.bin/vitest` node env or plain `node` + yjs)

1. Dump the workspace's envelopes via `docker exec notees-db-dev psql … COPY (SELECT … ORDER BY physical, logical, id) TO STDOUT (FORMAT json)` (global HLC order — not seq order) to a local JSON file.
2. Replay all 121k envelopes through the real derived appliers (`frontend/src/core/derived/`) into an in-memory sql.js DB (same pattern as `frontend/src/core/derived/__tests__/`), with **one patch**: the legacy positional handler treats string `index`/`newIndex` as `parseFloat` ranks — per parent, children kept rank-sorted (ties broken by op HLC then id), inserts woven in by rank rather than used as array indices. The 245 legacy full-state `treeUpdate` ops (47 parents) merge through the real `TreeCrdt`.
3. Validation gate before writing anything: replayed `node_child_order` row count ≈ 25.5k (not 76); cocina (`67ceae9b-7b39-49d9-9f7f-715a06c1d8dc`) has its full child list; spot-check 3 known pages against expectations. Print per-parent child counts for review.

### Step 2 — Generate + apply corrective envelopes

From the replayed final DB (`crdt_state.tree_state` per parent holds the final `TreeCrdt` state):

1. **Child order**: per parent with ≥1 child, one `node.updateContent` op `{nodeId: parentId, treeUpdate: <full state as byte array>}` (legacy full-state carrier — semantically "last full state wins", handled by both appliers, and updates server `crdt_state`; fall back to `treeUpdateB64` if the JSON would exceed ~500 KB / envelope 1 MB limit). Full state (not delta) so lossy-prefix clients converge: all final items + tombstones are self-contained.
2. **"page" class removal**: for every node whose final `class_ids` contains `…0002`, one `class.unassign {nodeId, classId}` op (payload shape mirrored from `store.ts`); then one `class.delete {classId}`. Fresh HLCs win the `class_member_set` LWW (`classMembership.ts`) even on out-of-order replay.
3. Envelope construction follows `scripts/fix_legacy_selection_properties.py`: system actor `00000000-0000-0000-0000-000000000000`, uuidv7 ids, HLC physical = max(now_ms, max existing physical + i), `protocol_version` 1, correct `affected_node_ids`. Emitted as SQL `INSERT … ON CONFLICT (id) DO NOTHING`.
4. Safety: `pg_dump -t relay_envelope` backup into `data/backups/` before applying; apply to dev DB via `psql`; re-run is semantically idempotent (fix script pattern).

### Step 3 — Root-cause code fix: class resurrection (frontend)

- `frontend/src/core/derived/class.ts`: make `class.create`/`class.update`/`class.delete` LWW-guarded per class (store last applied (hlc, actorId) per class — new `class_lww` table in `frontend/src/core/db/schema.ts`, mirroring `node_field_lww`/`lww.ts`), so a stale create can never resurrect a deleted class regardless of seq-page application order.
- Regression test (Vitest, red→green): replay `class.create` (old HLC) *after* `class.delete` (new HLC) → class stays `active=0`; newer create after delete still resurrects intentionally (higher HLC wins).
- Schema/applier change → bump `CURRENT_DERIVED_STATE_VERSION`? Per gotcha, prefer targeted repair; here the corrective `class.delete` op from step 2 repairs existing persisted DBs on catch-up, so **no version bump** (document decision in commit message).

### Step 4 — Verify the original bug end-to-end (dev stack)

1. Rebuild: `docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build`.
2. In the user's browser, open console and confirm the init log line `persistence=opfs|indexeddb` (report if `memory` — that means a stale bundle) and that `[indexedDb] saved chunked` appears after edits.
3. User scenario: open cocina → all legacy children present and correctly ordered → add a block → confirm within seconds it exists in `relay_envelope` (`SELECT … WHERE payload->>'parentId' = '67ceae9b…' ORDER BY seq DESC`) → reload → block persists, boot does a small catch-up (no full "Applying operations" replay), and the URL's page stays open (no redirect to today).
4. Confirm the "page" class is gone from the class list and from all node pills.
5. Suites: `docker compose -f compose.dev.yaml exec frontend npm run lint`, `npx tsc -b --noEmit`, `npx vitest run` for core/derived tests; backend untouched except no changes.

### Step 5 — Optional follow-up (separate approval, do NOT do unprompted)

Snapshot-from-replay + prune: insert the harness-produced DB as a `relay_snapshot` row (hlc/up_to_seq = post-migration max) and prune envelopes ≤ that HLC, collapsing 121k legacy ops. Defer until step 4 has run clean for a few days.

### Step 6 — Closure

- Update `skills/notees/gotchas/index.md` + `references/gotchas.md`: (a) legacy positional payloads are string float-ranks, not numbers — full replay is lossy without migration; (b) class lifecycle ops need LWW guards because catch-up applies pages in seq order while backfilled ops carry old HLCs at high seqs.
- Copy this plan to `skills/notees/references/agents/plans/2026-09-14-legacy-structure-migration.md` per project conventions.

## Deliberately out of scope

- **Re-encoding 31k legacy `content`/`crdtUpdate` text payloads as `textUpdateB64`**: both appliers replay them correctly; zero user-visible gain, high churn/risk. (Selectable as an option below if you want full normalization anyway.)
- Server-side Python applier parity for tree order (impossible without a CRDT lib; client-uploaded snapshots are the designed path).
- The 30 s IndexedDB persist debounce window (accepted tradeoff from `8f9638f9`).

## Uncovered risk / honesty box

- Why the just-added block ops never left the browser is **not yet proven** (best theory: local DB never persists → outbox/watermark wiped before push, or stale pre-`8f9638f9` bundle). Step 4's console + relay checks will pin it down; if blocks still don't reach the relay after this work, that becomes the follow-up bug with a clean data baseline.
- If the harness replay surfaces ordering that looks wrong on spot-check (step 1.3), stop and re-review before applying corrective ops.
