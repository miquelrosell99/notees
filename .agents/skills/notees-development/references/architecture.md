# Architecture (development view)

Canonical: `docs/developers/architecture.md` — read it for anything beyond this
digest. The normative model/wire spec is `packages/protocol/SCHEMA.md` (+ `WIRE.md`).

## The model in one paragraph

Append-only op log = sole authority. Envelopes are versioned, zod-strict,
camelCase JSON: `protocolVersion: 3` (mandatory), `id` (UUIDv7), `workspaceId`,
`actorId`, `deviceId`, optional `client` (`web` | `cli` | `agent:<id>`), `hlc`,
`affectedNodeIds`, `opType`, `timestamp`, `payload`. `seq` deliberately does
NOT exist in envelopes — the server's `relay.db` `envelope` table assigns it
(`INTEGER PRIMARY KEY AUTOINCREMENT`, the only ordering authority,
`INSERT OR IGNORE` ingest). HLC lives in `packages/protocol/src/hlc.ts`;
`compareHlc` orders `(physical, logical)`.

16 op types in `packages/protocol/src/op-types.ts`
(`object.*`, `class.*`, `propertySchema.*`, `property.*`, `asset.*`,
`collection.member.*`) — there is **no `relation.*`** (deleted 2026-09-25).
`payloadSchemaFor(opType)` is the single payload lookup; the relay
(`apps/server/src/validate.ts`) rejects unknown/invalid envelopes with 422.

## Derived store

`packages/store` — one TS implementation, three backends (better-sqlite3
server/CLI, sql.js browser WASM — every store test runs against **both**).
Schema in `packages/store/src/schema.ts` (derived schema **v15**); appliers in
`packages/store/src/appliers.ts`; `Store.apply`/`applyMany` = one txn per
batch. Two load-bearing guarantees: idempotency via `applied_envelope`, and
determinism — edge ids are sha256 over `(source, type, target, verb, metadata,
occurrence)`, so **wipe → replay → identical**. FTS: canonical FTS5; the
sql.js backend uses `ftsModule: "fts4"` + `schemaSql("fts4")`.

## Axes: render-state model (SCHEMA.md "Node structure")

Nodes carry two booleans + one CHECK: `is_class`, `present_as_main`,
`CHECK (is_class = 0 OR parent_id IS NULL)`. "Page"/"block" are render states,
not node kinds. **Main node vs block node** (owner 2026-10-09): a main node
renders with document chrome — `is_class = 1`, OR `parent_id IS NULL` (no
parent), OR `present_as_main = 1` (the explicit flag); a block node is a
parented non-class node with `present_as_main = 0` — inline in the parent's
body, no title/chrome. `rendersWithDocumentChrome` / `rendersAsInlineBlock`
(`packages/domain/src/node.ts`) are the two branches every surface speaks
("child pages" = main-zone children, "child blocks" = the inline zone).
**Title-is-content** (2026-10-01): no `name` on the wire — a
node's title IS its text content; pages/classes carry text-only content
(`stringifyContentAst`, `deriveDisplayName`). **Date formatting is gated**
(2026-10-08, owner ruling): only date-classed nodes format — a deterministic
year/month/day id formats from the id, a compact date-label content only with
a year/month/day class; 8-digit titles on ordinary nodes stay literal
(`fullTitleOf`, `formatDateNodeName`; the web's `dateDisplay` applies the
user's `dateFormat` setting on top).

## Node fields vs properties (boundary rule)

Platform-fixed, cardinality-1 node fundamentals that core chrome or navigation
reads or writes are **wire node fields** (`object.update`, the icon/color
precedent — `coverAssetId`/`bannerAssetId`/`aliasedNodeId` are the first
three); the derived store projects them as plain per-field columns. The
**property system is for user-extensible typed attributes** (class-bound,
multi-value, defaulted, qualified, query-filtered) — never for platform
fundamentals. Corollary: structural invariants (extends DAG, alias-chain
acyclicity) are validated at the operation level — loud failure, never
applied; render assumes them. Full reasoning:
`.plans/2026-10-06-1352-main-content-restructure/` (passes 14–15 + 22).

## Server: one write path

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

## Sync

`packages/sync`: outbox `pending → in_flight → acknowledged | failed →
quarantined`, backoff 5 s/15 s/1 m/5 m/30 m; push chunks 100; catch-up pages
default 1000 (server clamps [1,10000]); `restoreEpoch` + full client resync
implemented; WS `/ws/{workspaceId}` framing v2 (`hello` + `ops`,
acceleration-only; newer framing fails loud, close 1002).

**Conflict semantics** (cheat sheet in `docs/developers/development.md`):
scalars + property values LWW by HLC · class/collection membership OR-Set
add-wins (per-pair `(hlc, actor)`) · tag membership mirrors the OR-Set but the
add tiebreak is strictly greater (deliberate asymmetry — first-in-log-wins on
exact ties) · deletion tombstone-wins, subtree trashes · conflicts are
detected (`detectConflicts`: `move_move`, `node_deleted`, `class_conflict`,
`property_conflict`), reported, never blocking.

## Clients

- **Web** (`apps/web`): data path `src/core/workspace-client.ts` (sql.js over
  OPFS via Web Worker); writes funnel through `enqueueLocal` → session-local
  **undo journal** (`src/core/undo-journal.ts` — in-memory per tab, inverses
  compose existing ops, never on the wire).
- **CLI**: separate repo `notees-cli` (pinned `vendor/notees` submodule) —
  user-scope skill `notees-cli` covers it.
- **GTK / Flutter**: sibling repos; the **lockstep law** applies to any wire
  change (see `references/development-workflow.md`).

## Content + edges

`contentAst: ContentToken[]` (text, class_chip, mention, typed_link,
asset_ref, embed_ref, quote, query, whiteboard, external_link, math,
hard_break) — normative in SCHEMA.md, executable
`packages/protocol/src/content-mark.ts`. Edge index via `rebuildEdges`
(`packages/store/src/edges.ts`); `backlinksWithRollup(id)` is query-time
(direct + containment). Live carrier is whole-array `contentAst`;
`contentDeltaB64` is defined but the Yjs port is not implemented — don't fake
it.

## File map + status discipline

Full file map: the runbook's file-map section. Mark features "implemented"
vs "designed, not shipped" — code wins over design docs (the runbook
lists known discrepancies).
