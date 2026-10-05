# Notees v2 — Development

Contributing and hacking guide for the M1-alpha monorepo. Scope: this monorepo ( the
greenfield worktree. For the system's architecture see `architecture.md`; for model
authority see `../design/01-knowledge-model.md` and `packages/protocol/SCHEMA.md`.

**Maturity.** Commands and paths below were verified against the tree at the time of
writing. Features listed as *designed (M2/M3)* — typed-link target resolution, citations,
E2EE, plugins, multi-user auth, the interactive outliner editor — have no code; do not
write docs, tests, or UI as if they exist.

## 1. Prerequisites

- **Node 22** — `engines.node >=22` in `package.json` (host-verified: v22.x).
- **pnpm 9** — pinned via `packageManager: pnpm@9.0.0`; enable with
  `corepack enable` (Corepack ships with Node 22).
- **Toolchain** — TypeScript 5.6 strict, vitest 2, zod 3, Fastify 5, better-sqlite3 11
  (native module; prebuilt binaries are fetched on install), sql.js 1.10 (WASM).

Layout: pnpm workspaces over `packages/*` and `apps/*` (`pnpm-workspace.yaml`).
Packages export raw TypeScript (`"exports": {".": "./src/index.ts"}`) and are consumed
directly by apps and tests; only the deployables bundle (`apps/server` via
tsup, `apps/web` via vite — the CLI bundles in its own repo since 2026-10-05).

## 2. Workspace commands

Run from the repo root:

| Command | Effect |
|---|---|
| `pnpm install` | install all workspace deps |
| `pnpm test` | `pnpm -r test` — every package/app's vitest suite |
| `pnpm typecheck` | `pnpm -r typecheck` — `tsc --noEmit` everywhere |
| `pnpm -r build` | build every package that defines one (`@notees/server`, `@notees/web`). Note: the root has **no** `build` script — use `-r` |
| `pnpm --filter @notees/store test` | run one package's suite (alias `-F`) |
| `pnpm --filter @notees/server typecheck` | typecheck one package |
| `pnpm --filter @notees/server dev` | `tsx watch src/server.ts` — dev server with reload |
| `pnpm --filter @notees/web dev` | vite dev server (browser client against a running server) |
| the CLI | split into its own repo (`notees-cli`, §34.82) — `pnpm dev -- <args>` runs it from source via tsx there |

Per-package scripts (`packages/*`): `test` (vitest run), `typecheck` (tsc --noEmit). Apps
add `dev`/`build`/`start` (`apps/server`: `start` = `node dist/server.js`).

## 3. The fixture gate — blocking, at full width

The single most important process rule (`../implementation-plan.md`
fixture-gate lineage; `00-INDEX.md` amendment (b)):
**an op type is not done until its fixture validates.** Canonical fixtures live in
`packages/protocol/fixtures/` as JSON files of envelopes (or `{"envelopes": [...]}`
groups). Eight exist today:

| Fixture | Scenario it pins |
|---|---|
| `envelope-minimal.json` | smallest valid envelope |
| `object-create.json` | node creation with content/classes |
| `object-move.json` | reparent + sibling reorder (`afterId`), fractional positions |
| `property-set-lww.json` | two ops racing one property slot; higher HLC wins |
| `typed-link-mark.json` | verb mark with `locator` + `candidateSpans` (record-don't-resolve) |
| `typed-link-mark-deleted.json` | deleting the word deletes the mark (honest lifecycle) |
| `class-extends-m2m.json` | multiple inheritance closure (diamond) |
| `class-extends-cycle.json` | extends cycles must throw on apply |

The gate is enforced by `packages/protocol/test/protocol.test.ts`:

- the suite **asserts the fixture directory contains exactly these files** — a
  replaced scenario must be replaced, never silently dropped;
- every envelope must match `envelopeSchema`, carry a `KNOWN_OP_TYPES` opType, and have a
  payload validating against its `payloadSchemaFor` zod schema;
- scenario-specific assertions pin semantics (typed-link mark extraction, LWW race
  direction, no `relation.*` ops anywhere).

The store suite (`packages/store/test/store.test.ts`) replays **all** fixture envelopes
through `Store.apply` on **both** adapters, so a fixture that validates but does not
apply breaks the build. Keep the gate blocking: CI runs `pnpm test`, the protocol suite
is part of it, and the exact-file-list assertion means shrinking coverage fails loud.
When the model changes, re-encode fixtures against the new model at equal acceptance
width — that is precisely the discipline applied on 2026-09-25 when the relation
fixtures were replaced by typed-link-mark fixtures exercising the same scenarios.

**Cross-implementation parity (client lockstep).** The same canonical fixtures are
vendored byte-identical (sha256-verified) by the sibling client repos and replayed
through their appliers with the same expected outcomes: `notees-gtk`
(`tests/fixtures/v2/` + `tests/test_store_fixtures.py`, pytest) and `notees-flutter`
(`test/fixtures/v2/` + `test/v2_fixture_replay_test.dart`, flutter_test). A semantic
change is not done until all three implementations converge on the same fixture
expectations — this is the practical enforcement of "one semantics, many clients".
Update all three repos' fixture copies together (they are the same bytes).

## 4. Adding a new op type — the order matters

1. **Spec** — write the payload shape and semantics into `packages/protocol/SCHEMA.md`
   (owed-work register) or the relevant normative section. If the model itself changes,
   `../design/01-knowledge-model.md` is normative — read `00-INDEX.md` first.
2. **Payload zod schema** — add `yourOpPayload = z.object({...}).strict()` to
   `packages/protocol/src/op-types.ts` and register it in `OP_PAYLOAD_SCHEMAS`. The
   registry is the single source of truth: the relay's `validateRelayEnvelope`
   (`apps/server/src/validate.ts`) rejects unknown opTypes and invalid payloads with
   422, and the sync engine's `validateEnvelope` fails loud before applying.
3. **Applier** — implement the apply logic in `packages/store/src/appliers.ts`, including
   derived-row maintenance (edge rebuild, stats, closures) so **wipe → replay →
   identical** keeps holding. Respect the bullet-proof schema: illegal states must be
   unrepresentable or fail loud (`StoreError` subclasses), never silently guarded.
4. **Fixture** — add a fixture file to `packages/protocol/fixtures/` exercising the
   acceptance scenario; update the exact-list assertion in the protocol test.
5. **Tests** — protocol gate (auto-picks the fixture up), store suite coverage for the
   applier semantics (both adapters), and sync/server tests where the op crosses the
   wire.

Additiveness is safe by protocol policy (WIRE §3): optional fields and new op types do
not bump `PROTOCOL_VERSION`; breaking changes bump the version and the fixtures together.

## 5. Conflict semantics — cheat sheet

Implemented in `packages/store/src/appliers.ts` + `packages/sync/src/conflicts.ts`;
normative statements in `01-knowledge-model.md` §12 and `SCHEMA.md`.

| Mechanism | Where | Rule |
|---|---|---|
| Scalar fields (node name, icon, color, node_type, content, parent edge) | `node` row carries winning-op `hlc_physical`/`hlc_logical`/`actor_id` | **LWW by HLC** — `(physical, logical)` compare; the higher HLC op's value wins. `compareHlc` ties at equal HLCs |
| Property values | `property_value` per `(node_id, property_schema_id, idx)`, same winning-op columns; `property_value_tombstone` per slot | **LWW by HLC** per slot; delete wins by tombstone |
| Class membership | `class_member_set` OR-Set rows (`present` flag, per-pair HLC + actor) | **OR-Set add-wins**: concurrent adds union; remove vs add resolves LWW per `(node, class)` pair by `(hlc, actor)`; the applier recomputes `node.class_ids` from present rows |
| Collection membership | `collection_member` — same shape | Same OR-Set add-wins semantics |
| Node deletion | `is_active = 0` + `trash` row; `permanent: true` hard-deletes | Soft-delete + retention; deletes win by tombstone; subtree trashes with the node |
| Replay | `applied_envelope` (derived) + `envelope.id UNIQUE` + `INSERT OR IGNORE` (relay) | **Idempotent**: same envelope applied twice is a no-op the second time; catch-up overlap with snapshots/WS frames is harmless |
| Detection-only | `detectConflicts` in `packages/sync/src/conflicts.ts` | Kinds: `move_move`, `node_deleted`, `class_conflict`, `property_conflict`. Reported via callbacks; **never blocks apply** — the merge above is authoritative |

Two deliberate non-conflicts: concurrent text merges (the designed Yjs CRDT carrier —
whole-`contentAst` LWW until the port) and set-vs-set LWW. If user intent is ambiguous
but the data converges, it is a conflict report, not an apply failure.

## 6. Testing strategy

| Suite | Location | What it proves |
|---|---|---|
| Protocol + fixture gate | `packages/protocol/test/protocol.test.ts` | envelope/payload schemas, exact fixture set, typed-link/LWW semantics |
| Store (adapter-parametrized) | `packages/store/test/store.test.ts` | every test runs against **both** `better-sqlite3Backend` and `sqljsBackend`: bullet-proof CHECKs (a parentless block is rejected; a parented class is rejected), `MoveGuardError` on class parenting, fixture replay, LWW/OR-Set convergence, idempotent replay, **wipe → replay determinism**, FTS prefix-AND search |
| Domain | `packages/domain/test/domain.test.ts` | seeds (fixed UUIDs never drift), name derivation |
| Sync | `packages/sync/test/sync.test.ts` | two-device convergence over one in-process `MemoryRelay` (dumps compared via ordered full-database dumps), retry/backoff/quarantine, restoreEpoch wipe+park recovery, catch-up idempotency, conflict reporting |
| Server | `apps/server/test/` (`relay-batch`, `relay-catchup`, `relay-snapshot`, `relay-ws`, `objects`, `assets`, `config`, `e2e`, `helpers.ts`) | `buildServer` against a temp data dir via fastify inject — real HTTP layer, no sockets needed; helpers in `helpers.ts` |
| CLI e2e | `notees-cli` repo (split 2026-10-05, §34.82), `test/cli.test.ts` | boots the real server on an ephemeral port, drives `run()` with captured IO/stdin, asserts `--json` output and exit codes |
| Web client | `apps/web/test/` (`workspace-client.test.ts` over `MemoryTransport` + jsdom rendering tests) | the browser data path without a browser; slice-1 rendering |

Convergence is asserted by comparing serialized database dumps, not row samples — the
same standard as v1. When adding sync behavior, extend the two-device MemoryRelay test,
not a mocked-transport unit test.

Run the whole gate exactly as CI would: `pnpm install && pnpm typecheck && pnpm test`
from the repo root.

## 7. Code conventions

Verified against `tsconfig.base.json`, the package manifests, and git history:

- **Strict TypeScript everywhere** — `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` on; target ES2022, `moduleResolution: bundler`.
- **ESM only** — `"type": "module"` in every package; imports use explicit `.js`
  suffixes on relative paths.
- **camelCase on the wire** — all request/response bodies and envelope payloads are
  camelCase JSON (clean-break property of protocol v2); the database is snake_case.
- **zod for all payloads** — envelopes, op payloads, HTTP bodies, query strings. Strict
  objects (`.strict()`) so unknown fields are rejected, not ignored.
- **Positional `?` SQL parameters only** — the adapter interface supports nothing else;
  keep the store driver-agnostic (both adapters must keep passing).
- **Deterministic derived state** — no `AUTOINCREMENT` in the derived schema; derived ids
  are content hashes; every applier change must preserve wipe → replay → identical.
- **Comments explain invariants, not mechanics** — file headers cite the spec section
  they implement (e.g. "WIRE.md §1–2", "SCHEMA.md Node structure"); match that style.
- **Conventional Commits** — history shows `feat(v2/web): …`, `refactor(v2/store): …`,
  `chore(v2): …`; scope by area, imperative subject.
- **Fail loud** — unknown opTypes, newer protocol/framing versions, invalid shapes, and
  model violations (move a class, cycle `extends`) throw; they never coerce or silently
  drop. The one designed exception: unknown WS frame types are ignored (WIRE §2).

## 8. Where things are designed but not built (don't fake them)

Registered so contributors don't re-invent or mis-document them: typed-link target
resolution (M2 — candidate spans are recorded now), citations pipeline + Markdown export
(M2), annotations on assets and selective asset sync (M2), property-schema CRUD UX and
create-and-bind (M2), `notees shell` REPL (owed, cheap, not shipped), computed
properties (deferred owner decision), E2EE activation (M3 — the `{"$e": …}` slot is
already in the envelope schema), plugin runtime and event projections (M3), multi-user
auth/JWT sessions (M3), the outliner editor program (M1b–M2), TreeCrdt/fractional
reorder port (M1b — `node_child_order` exists; the editor ops around it do not).
