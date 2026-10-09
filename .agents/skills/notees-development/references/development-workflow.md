# Development workflow

Canonical: `docs/developers/development.md`. Commands assume repo root, Node
22 + pnpm 9 (corepack).

## Commands

```sh
pnpm install                                   # setup
pnpm test                                      # = pnpm -r test (vitest) — the blocking gate
pnpm typecheck                                 # = pnpm -r typecheck (tsc --noEmit)
pnpm -r build                                  # build all dists (CI-equivalent gate runs all three)
pnpm --filter @notees/store test               # one package (-F alias)
pnpm --filter @notees/server dev               # tsx watch dev server
pnpm --filter @notees/web dev                  # vite dev
```

CI-equivalent gate (run before claiming done on anything non-trivial):
`pnpm install && pnpm typecheck && pnpm test`.

**Dev-condition exports:** vitest resolves `src`, tsc resolves `dist`. After
changing a package's public API: build that package's dist first, then
typecheck dependents.

**Worktrees live in `.worktrees/`** (gitignored): `git worktree add
.worktrees/<slug> -b <slug> main`. Concurrent sessions on unrelated tasks
each default to their own worktree — own branch, own `pnpm install` (shared
store makes it cheap), own gate runs — so one session's half-done slice
cannot break another's typecheck or tests; the main checkout is where slices
land, not where concurrent development happens. Dev servers are NOT
isolated: each session's dev commands take distinct ports (Vite
auto-increments). A solo session or a trivial docs-only slice may stay in
the main checkout — commit promptly. Never a random sibling folder — the
fleet host accumulates checkouts otherwise, and a forgotten sibling is
invisible to `git worktree list` hygiene.

**Landing + shared record files** (owner 2026-10-08): slices land one at a
time in the main checkout — fetch, rebase the session branch onto the
freshest main, fast-forward merge, push — promptly after the gate is green;
if main moved or `.git/index.lock` is present, another landing is in flight:
wait, re-fetch, redo the rebase. Then clean up: `git worktree remove
.worktrees/<slug>` + `git branch -d <slug>` (the safe delete only succeeds
once the slice is fully merged). `CHANGELOG.md`, `README.md`, `docs/`,
`AGENTS.md` are touched by nearly every slice: keep edits minimal and
anchored (changelog entries prepend under the current date; never reorder
existing entries) and resolve conflicts there by keeping both blocks —
never drop another slice's entry. Full rules:
`docs/developers/development.md` (Parallel sessions).

**Parallel sessions** (owner 2026-10-08; canonical:
`docs/developers/development.md`): other sessions may be working in this repo
— and against the same dev environment — concurrently. Assume it by default.

Detect: `git status --porcelain` + `git log --oneline -5` at session start,
`git worktree list` (a stale entry from a crashed session gets pruned once
confirmed dead — never a live sibling), a present `.git/index.lock`, `docker
compose ps`, plus a `.plans/` and newest-`CHANGELOG.md` skim.

Handle: never revert/stage/commit files outside your task (per-file staging
only — no `git add -A` / `git commit -a`); treat red tests in untouched files
as another session's in-flight work (report, don't fix); avoid stack-wide
commands (`compose down`, rebuilds, DB resets under `config/notees/`) without
checking; re-read files that change under you; snapshot-commit your own
verified states — uncommitted work is one rebase away from gone. Base
discipline: the `agent-repo-workflow` user skill.

**Commit and push when done** (owner 2026-10-08; canonical:
`docs/developers/development.md`): a finished slice — gate green, changelog
entry in — is committed (per-file staging, Conventional Commits) and pushed
to the current branch before the session ends. Pushing is standing
authorization in this repo; the `agent-repo-workflow` per-push confirmation
rule does not apply here. If the remote moved, integrate (`git pull --rebase`)
first — never force.

**No transient-internal-doc pointers in the tree:** code, tests, docs, and
CHANGELOG entries never reference `.plans/` proposal folders, design docs,
or other internal transient documentation — the durable text stands alone.
Internal cross-references live inside the internal docs themselves.

## The test workspace (owner 2026-10-09)

All agent work that touches a live workspace — API calls, browser probes
(with their `localStorage` seeds), CLI writes, verification data — happens
in the TEST workspace, never the personal default. Fixed uuids:

- test: `c491595f-9f94-5ade-a620-e30ed063d8d2` (the unnamed seed workspace,
  disposable)
- personal default (never touch): `3b30e070-039b-47bc-ad0d-2440a2f173c5`
  ("Notas", the owner's live data)

Browser probes seed `notees.workspaceId` with the test uuid (the
`class-probe.mjs` pattern) rather than clicking through the workspace
picker into the default. Probe objects are created in the test workspace and
deleted when the verification is done — the test workspace absorbs the mess;
"Notas" never does. Canonical: `docs/developers/development.md` (Parallel
sessions).

## The fixture gate (blocking)

Op fixtures live in `packages/protocol/fixtures/` (envelope-minimal,
object-create, object-move, property-set-lww, typed-link-mark,
typed-link-mark-deleted, class-extends-m2m, class-extends-cycle).
`packages/protocol/test/protocol.test.ts` asserts the **exact file list** —
never silently drop or rename a fixture — plus envelope schema, KNOWN_OP_TYPES,
`payloadSchemaFor` validation, and semantic pins.
`packages/store/test/store.test.ts` replays ALL fixtures through
`Store.apply` on BOTH adapters (better-sqlite3 + sql.js).

**Cross-implementation parity:** the same fixtures are vendored byte-identical
(sha256-verified) to `notees-gtk` (`tests/fixtures/wire/`, pytest) and
`notees-flutter` (`test/fixtures/wire/`, flutter_test). A semantic wire change
is not done until all three implementations converge.

## Adding an op type (order matters)

1. Spec it in `packages/protocol/SCHEMA.md`.
2. zod payload in `packages/protocol/src/op-types.ts`, registered in
   `OP_PAYLOAD_SCHEMAS` (relay `validateRelayEnvelope` rejects unknown/invalid
   with 422).
3. Applier in `packages/store/src/appliers.ts` preserving
   wipe → replay → identical.
4. Fixture + update the exact-list assertion in the protocol gate.
5. Tests: protocol gate, store on both adapters, sync/server where it crosses
   the wire.

Additive = no `PROTOCOL_VERSION` bump (WIRE.md). A breaking change bumps the
version + fixtures + all three clients together (lockstep law,
`docs/developers/releases.md`): **TS reference with fixtures → GTK + Flutter
ports and tags → live migration.**

## Conflict-semantics cheat sheet

Scalars + property values: LWW by HLC. Class/collection membership: OR-Set
add-wins (per-pair `(hlc, actor)`). Tag membership: mirrors the OR-Set but the
add tiebreak is **strictly greater** (deliberate asymmetry). Deletion:
tombstone-wins, subtree trashes. Replay is idempotent. Conflicts are
detection-only (`detectConflicts`, 4 kinds) — reported, never blocking.

## Testing strategy

Convergence is asserted by **full database dumps, not row samples** (the
sync suite runs a two-device MemoryRelay and compares ordered full dumps).
Server tests use fastify inject with `test/helpers.ts`; web tests run over
MemoryTransport + jsdom; the CLI has its own e2e suite in its repo.

## The changelog ritual (owner rule)

After shipping any slice, add an entry to `CHANGELOG.md` at the repo root —
one entry per shipped slice, newest first:

```
## YYYY-MM-DD

- type(scope): Title — <what shipped, bullets with bolded leads>.
  **Verification:** <suite counts, typecheck/build, gate runs; note unrelated
  failures honestly>.
```

- Same pass: update the docs the change touches (`docs/`, `SCHEMA.md`, the
  runbooks); a change without its record + doc updates is not done.

## Fleet-agnostic artifacts

Never hardcode machine names, IPs, or tailnet names in code, templates, docs,
or notes — write `<host>`, `<tailnet>`, `<lan-ip>`, `<tailscale-ip>`, or
"the fleet host". Concrete values live only in gitignored host-local files
(`.env`) and per-host operator config.
