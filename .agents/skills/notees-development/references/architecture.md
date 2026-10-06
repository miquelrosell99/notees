# Architecture (development view)

Canonical: `docs/developers/architecture.md` — read it for anything beyond this
digest. Section numbers below refer to it. The normative model/wire spec is
`packages/protocol/SCHEMA.md` (+ `WIRE.md`).

## The model in one paragraph (§1–§2)

Append-only op log = sole authority. Envelopes are versioned, zod-strict,
camelCase JSON: `protocolVersion: 3` (mandatory), `id` (UUIDv7), `workspaceId`,
`actorId`, `deviceId`, optional `client` (`web` | `cli` | `agent:<id>`), `hlc`,
`affectedNodeIds`, `opType`, `timestamp`, `payload`. `seq` deliberately does
NOT exist in envelopes — the server's `relay.db` `envelope` table assigns it
(`INTEGER PRIMARY KEY AUTOINCREMENT`, the only ordering authority,
`INSERT OR IGNORE` ingest). HLC lives in `packages/protocol/src/hlc.ts`;
`compareHlc` orders `(physical, logical)`.

16 M1 op types in `packages/protocol/src/op-types.ts`
(`object.*`, `class.*`, `propertySchema.*`, `property.*`, `asset.*`,
`collection.member.*`) — there is **no `relation.*`** (deleted 2026-09-25).
`payloadSchemaFor(opType)` is the single payload lookup; the relay
(`apps/server/src/validate.ts`) rejects unknown/invalid envelopes with 422.

## Derived store (§3)

`packages/store` — one TS implementation, three backends (better-sqlite3
server/CLI, sql.js browser WASM — every store test runs against **both**).
Schema in `packages/store/src/schema.ts` (derived schema **v15**); appliers in
`packages/store/src/appliers.ts`; `Store.apply`/`applyMany` = one txn per
batch. Two load-bearing guarantees: idempotency via `applied_envelope`, and
determinism — edge ids are sha256 over `(source, type, target, verb, metadata,
occurrence)`, so **wipe → replay → identical**. FTS: canonical FTS5; the
sql.js backend uses `ftsModule: "fts4"` + `schemaSql("fts4")`.

## Axes: render-state model (§4, SCHEMA.md "Node structure")

Nodes carry two booleans + one CHECK: `is_class`, `present_as_main`,
`CHECK (is_class = 0 OR parent_id IS NULL)`. "Page"/"block" are render states,
not node kinds. **Title-is-content** (2026-10-01): no `name` on the wire — a
node's title IS its text content; pages/classes carry text-only content
(`stringifyContentAst`, `deriveDisplayName`).

## Server: one write path (§8)

Fastify 5. Every write funnels through `ServerContext.ingestBatch`
(`apps/server/src/context.ts`): persist to relay log first → apply to derived
store → broadcast `ops` frame. Object-API writes become envelopes via
`ctx.submit`.

**Agent-first write safety** (`src/idempotency.ts`, pinned by
`src/errors.ts`): `Idempotency-Key` header replays the first 2xx (24 h
window, 409 `idempotency_replay`); `PATCH /objects/:id` honors `baseRevision`
(409 `conflict` when stale); scoped API keys enforced per route from OpenAPI
`requiredScope` (403 `scope_denied`); `GET /operations` is a paginated
relay-log read = the agent audit feed; `GET /openapi.json` self-describes
(CI `openapi-coverage` fails on route drift).

Auth: API key only (X-API-Key / Bearer / `?token=`), constant-time compare;
only `GET /healthz` and `GET /api/version` are public. No TLS in the server —
terminate in a reverse proxy. Limits: relay batch ≤1000 envelopes / ≤1 MB;
≤30 k envelopes/min/workspace; 10 k req/min/IP; body 128 MB.

## Sync (§7)

`packages/sync`: outbox `pending → in_flight → acknowledged | failed →
quarantined`, backoff 5 s/15 s/1 m/5 m/30 m; push chunks 100; catch-up pages
default 1000 (server clamps [1,10000]); `restoreEpoch` + full client resync
implemented; WS `/ws/{workspaceId}` framing v2 (`hello` + `ops`,
acceleration-only; newer framing fails loud, close 1002).

**Conflict semantics** (§5, `development.md` §5 cheat sheet): scalars +
property values LWW by HLC · class/collection membership OR-Set add-wins
(per-pair `(hlc, actor)`) · tag membership mirrors the OR-Set but the add
tiebreak is strictly greater (deliberate asymmetry — first-in-log-wins on
exact ties) · deletion tombstone-wins, subtree trashes · conflicts are
detected (`detectConflicts`: `move_move`, `node_deleted`, `class_conflict`,
`property_conflict`), reported, never blocking.

## Clients (§9)

- **Web** (`apps/web`): data path `src/core/workspace-client.ts` (sql.js over
  OPFS via Web Worker); writes funnel through `enqueueLocal` → session-local
  **undo journal** (`src/core/undo-journal.ts`, §34.64 — in-memory per tab,
  inverses compose existing ops, never on the wire).
- **CLI**: separate repo `notees-cli` (§34.82, pinned `vendor/notees`
  submodule) — user-scope skill `notees-cli` covers it.
- **GTK / Flutter**: sibling repos; the **lockstep law** applies to any wire
  change (see `references/development-workflow.md`).

## Content + edges (§5)

`contentAst: ContentToken[]` (text, class_chip, mention, typed_link,
asset_ref, embed_ref, quote, query, whiteboard, external_link, math,
hard_break) — normative in SCHEMA.md, executable
`packages/protocol/src/content-mark.ts`. Edge index via `rebuildEdges`
(`packages/store/src/edges.ts`); `backlinksWithRollup(id)` is query-time
(direct + containment). Live carrier is whole-array `contentAst`;
`contentDeltaB64` is defined but the Yjs port is not implemented — don't fake
it.

## File map + status discipline

Full file map: §10 of the runbook. Mark features "implemented (M1)" vs
"designed, not shipped" — code wins over design docs (§11 lists 13 known
discrepancies).
