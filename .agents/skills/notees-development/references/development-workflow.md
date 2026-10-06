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

## The fixture gate (blocking — §3)

Op fixtures live in `packages/protocol/fixtures/` (envelope-minimal,
object-create, object-move, property-set-lww, typed-link-mark,
typed-link-mark-deleted, class-extends-m2m, class-extends-cycle).
`packages/protocol/test/protocol.test.ts` asserts the **exact file list** —
never silently drop or rename a fixture — plus envelope schema, KNOWN_OP_TYPES,
`payloadSchemaFor` validation, and semantic pins.
`packages/store/test/store.test.ts` replays ALL fixtures through
`Store.apply` on BOTH adapters (better-sqlite3 + sql.js).

**Cross-implementation parity:** the same fixtures are vendored byte-identical
(sha256-verified) to `notees-gtk` (`tests/fixtures/v2/`, pytest) and
`notees-flutter` (`test/fixtures/v2/`, flutter_test). A semantic wire change
is not done until all three implementations converge.

## Adding an op type (§4 — order matters)

1. Spec it in `packages/protocol/SCHEMA.md`.
2. zod payload in `packages/protocol/src/op-types.ts`, registered in
   `OP_PAYLOAD_SCHEMAS` (relay `validateRelayEnvelope` rejects unknown/invalid
   with 422).
3. Applier in `packages/store/src/appliers.ts` preserving
   wipe → replay → identical.
4. Fixture + update the exact-list assertion in the protocol gate.
5. Tests: protocol gate, store on both adapters, sync/server where it crosses
   the wire.

Additive = no `PROTOCOL_VERSION` bump (WIRE §3). A breaking change bumps the
version + fixtures + all three clients together (lockstep law,
`docs/developers/releases.md` §3): **TS reference with fixtures → GTK + Flutter
ports and tags → live migration.**

## Conflict-semantics cheat sheet (§5)

Scalars + property values: LWW by HLC. Class/collection membership: OR-Set
add-wins (per-pair `(hlc, actor)`). Tag membership: mirrors the OR-Set but the
add tiebreak is **strictly greater** (deliberate asymmetry). Deletion:
tombstone-wins, subtree trashes. Replay is idempotent. Conflicts are
detection-only (`detectConflicts`, 4 kinds) — reported, never blocking.

## Testing strategy (§6)

Convergence is asserted by **full database dumps, not row samples** (the
sync suite runs a two-device MemoryRelay and compares ordered full dumps).
Server tests use fastify inject with `test/helpers.ts`; web tests run over
MemoryTransport + jsdom; the CLI has its own e2e suite in its repo.

## The §34 work-record ritual (owner rule)

After shipping any slice, append an entry to `.plans/implementation-plan.md`:

```
### 34.NNN type(scope): Title (YYYY-MM-DD — STATUS)
<what shipped — bullets with bolded leads>
**Verification:** <suite counts, typecheck/build, gate runs; note unrelated
failures honestly>
**Register cross-checks:** <docs updated, SCHEMA.md/wire statement, lockstep
statement, superseded entries>
```

- Numbering: next integer above the highest used (entries are not strictly
  positional — check the tail of the file, don't assume).
- Status vocabulary: SHIPPED / SHIPPED same day / LOCKSTEP-PENDING / PENDING /
  DIAGNOSED / NOT WANTED / ARCHIVED; may carry `closes #N`, `ops-only`,
  `docs-only`, `SHIPPED vX.Y.Z`.
- Same pass: tick owed-work rows you resolved; register deviations where
  future readers will look.

## Fleet-agnostic artifacts

Never hardcode machine names, IPs, or tailnet names in code, templates, docs,
or notes — write `<host>`, `<tailnet>`, `<lan-ip>`, `<tailscale-ip>`, or
"the fleet host". Concrete values live only in gitignored host-local files
(`.env`) and per-host operator config.
