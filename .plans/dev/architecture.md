# Notees v2 — Architecture

M1-alpha developer documentation for the greenfield rewrite. The v2 tree is a TypeScript
pnpm monorepo (`packages/` = libraries, `apps/` = deployables) living at the repo root.

**Maturity.** This document separates *implemented* (code exists in the tree, verified
against the paths cited) from *designed for M2/M3* (specified in
`../design/01-knowledge-model.md`, `packages/protocol/SCHEMA.md`, and the evolution plan
at `../implementation-plan.md`, but not present in
code). In case of disagreement between a design doc and the code, **the code wins** and the
discrepancy is flagged in [§11](#11-code-vs-design-discrepancies).

**What is shipped (2026-10-01):** the sync/storage core, the interactive outliner
editor (blocks, marks, `@`/`#`/`+` node-picker popups, slash commands), the page
layout (header identity rows, collapsed `Properties N`, linked references),
first-class tags, class ordering, the v1 icon picker, sidebar peek cards, and the
CLI. What is **not** (designed, not shipped): typed-link target resolution, the
citations pipeline, E2EE, plugins, multi-user auth. Do not document or assume
those as existing.

Sources: `../design/00-INDEX.md`, `../design/01-knowledge-model.md`,
`packages/protocol/SCHEMA.md`, `packages/protocol/WIRE.md`, and the code cited inline.

---

## 1. The system in one paragraph

Notees v2 is a local-first personal knowledge environment built around one idea: **an
append-only operation log is the only authority for semantic state**. Every mutation is an
*envelope* (a versioned, validated op with HLC causality and actor provenance). A
per-workspace **derived store** (SQLite) is computed from the log by *appliers*; it can be
wiped and rebuilt by replay, and replay is idempotent and deterministic. All user surfaces —
HTTP API, CLI, web client — read the derived store and write *only* through the envelope
pipeline. One implementation of the store/sync/query stack runs in three runtimes (server
Node, browser WASM worker, CLI) so semantics cannot drift between them.

## 2. The operation log — the sole authority

*Implemented (M1).*

- **Envelope format** — `packages/protocol/src/envelope.ts`. camelCase JSON, strict zod
  schema, mandatory `protocolVersion: 3` (absent → rejected), fields: `id` (UUIDv7),
  `workspaceId`, `actorId`, `deviceId`, optional `client` provenance claim
  (`web`, `cli`, `agent:<id>`), `hlc`, `affectedNodeIds`, `opType`, `timestamp`, `payload`.
  `seq` is deliberately **absent** from envelopes: server-assigned ordering rides on
  catch-up responses and WS frames, never inside the envelope.
- **Payloads** — `packages/protocol/src/op-types.ts`. Sixteen op types in the M1 registry:
  `object.create` / `object.update` / `object.delete`, `class.create` / `class.update` /
  `class.delete` / `class.setExtends`, `propertySchema.create` / `propertySchema.update` /
  `propertySchema.delete`, `property.set` / `property.unset`, `asset.attach` /
  `asset.detach`, `collection.member.add` / `collection.member.remove`. Each has a strict
  zod payload schema; `payloadSchemaFor(opType)` is the single lookup. There are **no
  `relation.*` ops** — relation entities were deleted from the model on 2026-09-25
  (assessment §34.9); associations are node-typed property values or typed-link marks in
  content.
- **Server log** — `apps/server/src/relay-storage.ts`. One SQLite file per server,
  `<dataDir>/relay.db`, table `envelope` with `seq INTEGER PRIMARY KEY AUTOINCREMENT`
  (the **only ordering authority**) and `id UNIQUE`, so `INSERT OR IGNORE` ingest is
  idempotent and retry-safe. Also in `relay.db`: `restore_epoch`, `snapshot`,
  `compaction_segment`, `asset`, `asset_ref` (asset metadata only — bytes are files, §8).
- **Causality** — `packages/protocol/src/hlc.ts`. Hybrid Logical Clock per device;
  `compareHlc` orders `(physical, logical)`. HLC is the LWW causality watermark and
  snapshot marker, never an ordering mechanism for catch-up. The server's clock is seeded
  from `relay.globalMaxHlc()` on boot so server-stamped HLCs never regress across restarts
  (`apps/server/src/context.ts`).
- **Replay properties** — the derived store keeps an `applied_envelope` table
  (`packages/store/src/schema.ts`); replayed ids are skipped, so re-applying a fixture, a
  catch-up page, or a whole log never double-applies. Wipe → replay converges to identical
  state, which is exactly what the store's own tests assert
  (`packages/store/test/store.test.ts`).

**Designed (M2/M3):** the M3 E2EE slot. The envelope schema already reserves
`payload = {"$e": {iv, ct}}`; the relay passes it through unvalidated and server-side
derived stores skip it (`isEncryptedPayload` checks in `workspace-store.ts`). Encryption
itself is M3 and does not exist.

## 3. The derived store — wipe, replay, identical

*Implemented (M1).*

`packages/store` is the single semantic-store implementation. Per the five storage
categories of `01-knowledge-model.md` §3, the derived schema
(`packages/store/src/schema.ts`, `SCHEMA_VERSION = 8`, DDL mirrored as `SCHEMA_SQL`; additive `PRAGMA user_version` migrations — v2 class_property LWW columns, v3 date columns, v4 FTS4→FTS5, v5 tags `tag_member_set` + `node.tag_ids`, v6 → v7 `node.class_order`, v7 → v8 the render-state model: `is_class` + `present_as_main` replace `node_type`, node table rebuilt in place) holds:

| Category | Tables (M1 schema) | Notes |
|---|---|---|
| ENTITIES | `node`, `node_child_order` | one table for every entity; child order is fractional-position strings |
| CONFIGURATION | `property_schema`, `class_property`, `class` | the `class` table carries class-only configuration keyed by the class node id; the node row stays the structural authority |
| ASSERTIONS | `property_value`, `property_value_tombstone`, `node_link`, `node_asset` | typed, LWW, tombstoned; `node_link` = per-link analytics (§5) |
| DERIVED | `edge`, `class_hierarchy`, `class_member_set`, `collection_member`, `search_index` (+`search_index_docid`), `node_stats` | applier-maintained; never authored; wipe → replay → identical |
| INFRA | `applied_envelope`, `sync_state`, `trash`, `app_meta` | idempotency, retention, client bookkeeping — never ops |

Appliers live in `packages/store/src/appliers.ts` (entry points `Store.apply` /
`Store.applyMany` in `store.ts`, one transaction per batch). The store also exposes
`getNode`, `children`, `backlinks`, `backlinksWithRollup`, `references`, `search`, `snapshot`/`restore`/`reset`
(`store.ts:87-266`).

Two replay/wipe guarantees are load-bearing and tested:

1. **Idempotency** via `applied_envelope` (above).
2. **Determinism** — edge ids are sha256 over
   `(source, type, target, verb, metadata, occurrence)` (`packages/store/src/edges.ts`), so
   derived rows are byte-identical across replays; `node_stats` is recomputed from the same
   derivation pass.

Server-side hydration (`apps/server/src/workspace-store.ts`): on first access of a
workspace, restore the newest snapshot if it covers the log tail, then replay remaining
envelopes in seq order, one at a time. An envelope that is schema-valid but not yet
applicable (e.g. a create whose parent has not arrived) is *skipped* and retried on next
boot — it never poisons the whole replay. A per-workspace promise queue serializes the
ingest+apply pair across concurrent requests.

## 4. The axes and the bullet-proof schema

*Implemented (M1) — this is the Revision 11 render-state model: `is_class` ×
`present_as_main` replace Revision 10's `node_type` enumeration (and, before it, the
soft-`kind` design).*

Identity, tree placement, render state, and domain typing are **two booleans plus one
placement CHECK**, so illegal states are unrepresentable rather than guarded
(`packages/store/src/schema.ts`, normative in `SCHEMA.md` "Node structure"):

```
is_class INTEGER NOT NULL DEFAULT 0,
present_as_main INTEGER NOT NULL DEFAULT 0,
...
-- Classes are always roots; every other node may sit anywhere in the
-- tree, parentless nodes included (they render with document chrome).
CHECK (is_class = 0 OR parent_id IS NULL)
```

- **The axes:** `is_class` (identity — classes are always roots) × `parent_id`
  (placement — placement lives *only* in the tree; a cross-page move updates nothing but
  the parent edge plus order) × `present_as_main` (render bit for parented non-class
  nodes: the parent's main-children zone + document chrome when 1, the inline body +
  block chrome when 0; unread for parentless nodes and classes) × `class_ids` (domain
  typing — whiteboard, meeting, …). "Page" and "block" are the user-facing names of the
  render states, not stored kinds.
- **Applier defaults by context:** the payload's `presentAsMain` is optional; the applier
  defaults it to true when the node is parentless, false when parented.
- **Class parenting:** classes may have non-class children (classes are containers); the
  one tree rule left — a class can never be a *child* — is the CHECK above, plus an
  applier move-guard that fails loud (`MoveGuardError`) when an op tries to parent a
  class (`packages/store/src/appliers.ts:594`).
- **Promotion/demotion** = `object.update` toggling `presentAsMain` in place, identity
  preserved (promotion stringifies the content); **declaring a class** = `class.create`
  (declaration-first).
- **View resolution = the render cascade:** `is_class` → Class View; parentless →
  document chrome (Page View; the bit is unread); otherwise `present_as_main` decides
  main-children zone vs inline body (SCHEMA.md). The M1 web UI implements a
  read-oriented Page View only (§9); Class View / Focused Block View chrome is designed,
  not shipped.

## 5. Content grammar and the edge index

*Content grammar: implemented as zod schemas (`packages/protocol/src/content-mark.ts`) and
edge derivation: implemented (`packages/store/src/edges.ts`). Roll-up/filter-inheritance:
designed, not implemented (see below).*

**Content.** A block's content is one flat token array (`contentAst: ContentToken[]`) —
`text` (with `marks`), `class_chip`, `mention`, `typed_link`, `asset_ref`, `embed_ref`,
`quote`, `query`, `whiteboard`, `external_link`, `math`, `hard_break`. Normative grammar in
`SCHEMA.md`; executable form in `content-mark.ts`. Key M1 semantics:

- `mention` stores the target id only; display resolves at render (rename-free).
- `typed_link` is a **mark on the prose word** — verb (property-schema ref or free
  string) plus `metadata{locator?, candidateSpans?}`. **Record, don't resolve:**
  `candidateSpans` is an ordered list of token ids recorded at capture; the resolution
  *rule* is deferred to M2. `target_id` is NULL in the edge index by design.
- The M1 wire carrier for content is whole-array `contentAst` on `object.create/update`.
  `contentDeltaB64` (base64 CRDT delta) is defined in the payload schema as the canonical
  carrier "once the Yjs port lands" (`op-types.ts` header) — the Yjs port and per-node
  `Y.Text` CRDT are designed, not implemented.

**Edge index.** `rebuildEdges` synchronizes three families per source node into the
derived `edge` table — never authored directly:

| type | Derived from | `target_id` | `verb` |
|---|---|---|---|
| `mention` | `mention` tokens (one edge per instance) | target node | NULL |
| `typed_link` | typed-link marks, top-level and inside quotes | **NULL** (unresolved until M2) | the verb string |
| `property` | node-typed property values (`{"nodeId": …}`) | value node | bound propertySchemaId |

Stale edges are deleted and `node_stats` (child/backlink/reference/descendant counts,
materialized) recomputed for the source and every affected target. `Store.backlinks(id)`
(`store.ts:161`) returns the direct `edge` rows pointing at a node; `references(id)` the
outgoing ones.

**`node_link` analytics.** Assertion rows keyed by the mention token's optional `linkId`
(decided 2026-09-26, SCHEMA.md): `source_id`, `target_id`, `created_at`, `updated_at`,
`click_count`, `last_navigated_at`. Anonymous mentions (no `linkId`) get no row. Granular
per-visit history (`link_visit`) is designed as a derived log with the M2 statistics work.

**Containment roll-up is implemented query-time; filter inheritance is not.**
`Store.backlinksWithRollup(id)` (reconciled 2026-09-26, §11 item 2) adds
source-side containment backlinks: direct edges on the node plus outward
links from inside its subtree (`kind: direct|containment` + subtree depth,
direct first; a block inside France linking Paris lists on both France and
Paris; the badge stays direct, so the list can exceed it). `refset` **filter
inheritance** (`refset(n) = own_links(n) ∪ refset(parent(n))` as a query
matching rule, `01` §8) remains designed, not implemented — no inherited-link
filtering exists in code.

## 6. DB adapter interface — better-sqlite3 and sql.js

*Implemented (M1).*

`packages/store/src/db.ts` defines the minimal synchronous surface the store actually
calls: `SqliteDB` (`exec`, `prepare`, `pragma`, `transaction`, optional `serialize`/
`close`), `SqliteStatement` (`run`/`get`/`all`, positional `?` params only), and the
`StoreBackend` factory (`open` / `restore(bytes)` / `reset`, plus a declared
`ftsModule`). Two adapters ship:

| Adapter | File | Runtime | Why |
|---|---|---|---|
| better-sqlite3 | `packages/store/src/adapters/better-sqlite3.ts` | server, CLI (native, file-backed) | default where Node runs; synchronous single-writer fits the per-workspace derived-DB model |
| sql.js | `packages/store/src/adapters/sqljs.ts` | browser (WASM, in-memory) | the only synchronous SQLite that runs in the browser; exported via `@notees/store/sqljs` |

**Why both:** the store package must run unchanged in the browser worker and in Node
(assessment §34.15 — the v1 dual-language tax must not recur), so all SQL goes through the
narrowest driver-agnostic interface, and the store test suite runs *every* test against
*both* adapters to keep the surface honest.

**FTS4/FTS5.** The canonical schema uses FTS5 (`search_index` virtual table). The stock
sql.js WASM build ships without FTS5, so the sql.js backend declares `ftsModule: "fts4"`
and `schemaSql("fts4")` builds the identical docid-map index with FTS4 — same MATCH
syntax, same `unicode61` tokenizer, same behavior
(`packages/store/src/schema.ts`, `db.ts`). Search itself is prefix-AND over the derived
node plaintext, ordered by node id (`store.ts:177`).

Restore is adapter-specific: better-sqlite3 has no deserialize, so restore writes a temp
file and swaps the connection (temp dir removed on close); sql.js exports/imports whole
database bytes in memory.

## 7. The sync engine

*Implemented (M1) — port of v1's SyncEngine per WIRE.md, in `packages/sync`.*

`packages/sync/src/sync-engine.ts`, `outbox.ts`, `meta.ts`, `conflicts.ts`,
`transport.ts`. Wire contract: `packages/protocol/WIRE.md`.

**Outbox (local-first write path).** `SyncEngine.enqueue` applies the envelope to the
local store *immediately* and tracks it in the outbox as `pending` until the server acks.
State machine (`outbox.ts`): `pending → in_flight → acknowledged | failed → quarantined`,
with `attemptCount`/`nextRetryAt` driving the v1 backoff schedule
(5s, 15s, 1m, 5m, 30m; exhausted → quarantined; `requeueQuarantined` for recovery). Push
chunks batches of 100 (WIRE cap is 1000) and acks whole-chunk: a 200 means every envelope
is persisted; duplicate-only chunks leave the outbox because the server omits duplicate
ids from `savedIds`. Durability note: the M1 outbox is a **session** in-memory structure —
an embedding client rehydrates by re-`enqueue`-ing from its durable op log
(`outbox.ts` header); the M1 web client holds its store in memory, so a reload re-syncs
from the server rather than from local durable state (see §9).

**Seq cursor pull.** Catch-up pages (default 1000, server clamps [1, 10000]); each page is
validated (`validateEnvelope` fails loud on unknown opTypes/newer protocol versions
*before* the transaction opens), applied in one store transaction, then the cursor
advances and persists — a crash mid-backlog resumes from the last applied page. The
cursor, the received-HLC watermark, and the restoreEpoch persist in the store's
`app_meta` table under `sync:<workspaceId>:state` (`meta.ts`); the `sync_state` table in
the schema is a repurposed local-apply watermark, not the client cursor.

**Snapshot shortcut.** If the server's snapshot HLC is newer than the received watermark,
the client restores the snapshot bytes (a serialized derived-state SQLite database, WIRE
§1 `GET /snapshot/data`), jumps its cursor to `upToSeq`, then catches up from there;
envelope-id dedupe makes the overlap harmless. Clients may also *upload* a snapshot when
theirs is newer (best-effort; failure never fails sync).

**restoreEpoch.** A per-workspace server counter; a change tells clients the server was
restored/rebuilt: park un-synced ops, wipe local state, resync from seq 0, requeue parked,
push+pull (`resyncFromEpochChange`). M1 keeps the epoch at 0 by contract, but the full
client mechanism is implemented and tested.

**Conflicts — reported, never blocking.** `detectConflicts` (`conflicts.ts`) maps the M1
op registry to four kinds: `move_move` (concurrent `object.create` with differing
`parentId` — in M1 a create on an existing node is the reparent carrier),
`node_deleted` (`object.delete` vs a mutation), `class_conflict` (concurrent creates
seeding different `classIds` — the OR-Set unions, intent is ambiguous),
`property_conflict` (`property.set` vs `property.unset` on the same slot). CRDT-merged
edits and set-vs-set LWW are deliberately *not* conflicts; the merge is authoritative.
Conflicts surface through callbacks/subscriptions; apply proceeds regardless.

**WebSocket acceleration.** `/ws/{workspaceId}` (framing version 2, versioned
independently of the envelope `protocolVersion`): server sends `hello` (restoreEpoch,
latestSeq), then `ops` frames with `seqs` (envelope id → server seq) so clients can
advance the cursor from the live stream alone; clients send `batch` frames. The socket is
an **acceleration path only** — frames buffer while a pull runs, drops are recovered by
the seq cursor on the next pull, and a `hello`/`ops` with a newer framing version fails
loud (connection closed with 1002). `SyncEngine.onRemoteBatch`/`startRealtime` are the
client hook surface; no WS *client* ships in M1.

## 8. The server and the one-write-path invariant

*Implemented (M1).*

`apps/server` is a Fastify 5 app (`src/app.ts`, version `2.0.0-m1`). Two route groups:

- **Relay API** — prefix `/api/relay/v2` (`src/routes-relay.ts`), exactly WIRE.md §1–2:
  `POST /batch`, `POST /catch-up`, `GET /snapshot`, `GET|PUT /snapshot/data`,
  `POST /compact` (single-checkpoint snapshot+prune), `GET /stats`, WS
  `/ws/:workspaceId`. Auth: `X-API-Key` header (or `Authorization: Bearer`), socket via
  `?token=` or header; constant-time compare (`src/identity.ts`).
- **Object/assets API** — prefix `/api` with an API-key preHandler
  (`src/routes-objects.ts`, `src/assets.ts`): node CRUD (`GET/POST/PATCH/DELETE
  /objects[/:id]`, plus `POST/DELETE /objects/:id/properties[...]`),
  `GET /objects/:id/backlinks`, `GET /objects/:id/effective-properties`,
  `GET /search`, **`POST /query` (arbitrary QueryAST execution)**,
  `GET/POST /property-schemas`, `GET /classes[/:id]`,
  `GET /properties/:id/values`; asset upload/download/info with magic-byte sniffing
  (jpeg/png/webp/pdf/epub/audio), size caps (50MB media / 100MB documents), and Range
  requests. Auth/account routes (`src/routes-auth.ts`, same `/api` prefix): setup,
  login/logout/me, workspaces CRUD + `GET /workspaces/:id/export.zip` (markdown zip via
  `@notees/export`: one file per page, manifest, optional assets), API-key management
  (`GET/POST/DELETE /api-keys`), `GET /nodes/:id/location`, `GET /server-info`.
  Workspace selection via `X-Workspace-Id` header, else a deterministic default
  workspace derived from the API key (`identity.ts`).
- Public, auth-free probes: `GET /healthz`, `GET /api/version`.

**The one-write-path invariant.** Every write — a relay `/batch`, a WS batch frame, an
object API mutation, an asset upload with `objectId` — becomes an envelope and flows
through a single funnel, `ServerContext.ingestBatch` (`src/context.ts`):

1. persist to the relay log **first** (`relay.db`, idempotent ingest) — the log is the
   durability boundary;
2. apply the newly-saved envelopes to the workspace's derived store
   (`WorkspaceManager.applyNow`, log-first-then-apply order from v1);
3. broadcast an `ops` frame to that workspace's WS subscribers (`src/bus.ts`).

The object/assets API does not touch the store directly: `ctx.submit` stamps a
server-side envelope via `EnvelopeFactory` (actor derived deterministically from the API
key, HLC from the server clock, `client: "api"` or `"seed"`) and pushes it through the
same funnel. This is the milestone's hard invariant: **server object/asset writes become
envelopes through the same pipeline as client ops**, so the audit trail, idempotency,
derived-state updates, and live notifications all hold for API writes too.

**Seeding.** First access to an empty workspace seeds system classes, `extends` edges,
property schemas, and inbox/scratchpad pages through the same envelope pipeline with
fixed UUIDs from `@notees/domain` (`apps/server/src/seed.ts`,
`packages/domain/src/seeds.ts`). Idempotent: seeding runs only while the workspace is
completely empty.

**Limits** (`config.ts`, WIRE §3): relay batch ≤ 1000 envelopes / ≤ 1 MB per payload;
relay ingest ≤ 30k envelopes/min/workspace; global fallback 10k req/min/IP; request body
limit 128 MB. Every failure answer uses the WIRE error envelope
(`{"error": {code, message, status}}`, stable machine codes).

**Assets** are content-addressed by sha256: bytes at
`<dataDir>/workspaces/<ws>/assets/<hash[:4]>/<hash>`, metadata rows in `relay.db`
(`asset`, `asset_ref` for dedupe refcounts). `asset.attach`/`asset.detach` ops record
node→asset assertions in the derived store (`node_asset`).

## 9. Clients

*Implemented — the web client is the full editor; GTK/Flutter are lockstep clients (see below).*

**Web** (`apps/web`). `src/core/workspace-client.ts` is the whole data path: a `Store`
over the **sql.js** backend (local derived state persisted to OPFS via a Web Worker since M1b slice 2), a `SyncEngine`
(outbox push + seq-cursor pull + snapshot shortcut), and a `Transport`
(`HttpTransport` against a relay server in the app; `MemoryTransport` over a `MemoryRelay`
in tests — both in `packages/sync/src/transport.ts`). Reads always hit the local store;
writes build envelopes (`newEnvelope`, deviceId `web`), apply optimistically via
`enqueue`, then push best-effort (`push()` awaits delivery when it must be
deterministic). `apps/web/src/ui/` is slice 1: a bootstrap screen (server URL + API key +
workspace id, remembered in localStorage), a page-list sidebar, and a PageView with block
rows and inline token rendering (`App.tsx`, `PageView.tsx`, `BlockRow.tsx`,
`InlineTokens.tsx`). Display names come from `deriveDisplayName` (`packages/domain/src/node.ts`) —
**title-is-content (2026-10-01)**: the content excerpt for EVERY node type (pages,
blocks AND classes; there is no stored `name`), date labels (`YYYYMMDD…`) formatted
`YYYY/MM(/DD)`, truncated to 80 chars. Pages/classes carry text-only content
(`stringifyContentAst`); the appliers flatten rich tokens on create and on
block→page/class promotion.

**GTK / Flutter** (sibling repos `notees-gtk`, `notees-flutter`, branches `protocol-v2`). Lockstep clients: strict payload validators + local appliers mirroring `packages/store` (same OR-Set gating, same LWW rules). Current with the TS reference as of the 2026-10-01 batch (tags + `tag.unassign`, title-is-content, `class.reorder`); both tagged `v2.0.0-m1` with CI-published releases. Any new op requires the same three-way lockstep.

**CLI** (`apps/cli`). Commander-based (`src/cli.ts`, exported `run()` for tests). Commands:
`object get|create|update|delete|list|search`, `class list`, `backlinks <id>`,
`export markdown --ids … | --linked-to <id> [--depth N|fixpoint] [--output-dir | --stdout]`
(bundle engine in `src/markdown-export.ts` — children fetched position-aware via
`GET /objects/:id/children`), `asset add|get`, `sync status`, `sync doctor`. Global flags: `--json` (stable machine
output), `--server`/`--key` (env `NOTEES_SERVER` / `NOTEES_API_KEY` as fallbacks),
`--profile`; destructive commands require `--yes` (otherwise a blast-radius preview and
exit 2 — never an interactive prompt under `--json` or non-tty). Exit codes: 0 ok,
1 domain, 2 usage, 3 auth, 4 conflict, 5 network (`src/exit-codes.ts`). Local state at
`~/.notees/state.json` (overridable via `NOTEES_STATE_FILE`) holds per-server workspace
cursors; writes are atomic (tmp + rename).

## 10. File map

| Path | Responsibility | Key entry points |
|---|---|---|
| `packages/protocol` | Wire format: HLC, envelope, op registry, content grammar; canonical fixtures | `src/index.ts` (`hlc`, `envelope`, `op-types`, `content-mark`); specs `SCHEMA.md`, `WIRE.md`; `fixtures/`; gate `test/protocol.test.ts` |
| `packages/domain` | System seeds (fixed UUIDs), node helpers | `src/index.ts` (`seeds.ts`, `node.ts` — `deriveDisplayName`, `plainTextExcerpt`) |
| `packages/store` | Derived store: schema, appliers, edge index, stats, search, adapter interface + both adapters | `src/index.ts`; `src/schema.ts` (DDL + `migrate`), `src/appliers.ts`, `src/edges.ts`, `src/db.ts`, `src/store.ts`, `src/adapters/better-sqlite3.ts`, `src/adapters/sqljs.ts` (export `@notees/store/sqljs`) |
| `packages/sync` | SyncEngine, outbox, conflicts, watermark persistence, transports | `src/index.ts`; `src/sync-engine.ts`, `src/outbox.ts`, `src/conflicts.ts`, `src/meta.ts`, `src/transport.ts` (`HttpTransport`, `MemoryTransport`, `MemoryRelay`) |
| `packages/query` | QueryAST model + SQLite compiler over the derived store (live queries) | `src/index.ts` (`ast.ts` zod model, `compiler.ts` `compile(ast)`, `execute.ts` `runQuery`/`countQuery`/`matches`); 7 condition types; deferred set in README |
| `packages/export` | Export projections over the object graph: `ExportDocument` IR + serializers (markdown/html/docx/latex package-side — options bag with per-format gating, escaping, full-closure outline, whiteboard sidecars, id8 filename policy, `linkTarget`/`assetPath` hooks, LaTeX CSL bibliography; pdf renders client-side in the web app), format registry (`SerializedExport` union), bundles + manifest v2, BibTeX/CSL | `src/index.ts`; `document.ts` (IR + context hooks), `markdown.ts`, `html.ts`, `docx.ts`, `latex.ts`, `options.ts`, `formats.ts`, `bundle.ts`, `bibtex.ts`, `csl.ts` |
| `apps/server` | Fastify relay + object/assets API; the one write path | `src/server.ts` (entry), `src/app.ts` (assembly), `src/config.ts`, `src/context.ts` (`ingestBatch`/`submit`), `src/relay-storage.ts`, `src/workspace-store.ts`, `src/routes-relay.ts`, `src/routes-objects.ts`, `src/assets.ts`, `src/seed.ts`, `src/identity.ts`, `src/validate.ts`, `src/rate-limit.ts`, `src/bus.ts` |
| `apps/cli` | `notees` command surface over the HTTP API | `src/cli.ts` (`run`), `src/client.ts`, `src/state.ts`, `src/exit-codes.ts` |
| `apps/web` | Browser client: workspace data path + outliner UI + export delivery (modal, workspace zip, PDF renderer) | `src/core/workspace-client.ts`, `src/main.tsx`, `src/ui/{App,PageView,BlockRow,InlineTokens}.tsx`, `src/ui/export-pdf/` (client-side PDF — `@react-pdf/renderer`, code-split, vendored OFL Gentium), `src/shims/` (node built-ins stubbed for the browser bundle) |
| `../design/` | Normative model docs (00-INDEX, 01-knowledge-model, 02-model-assessment) | read these before changing the model |
| `packages/protocol/fixtures` | Canonical op fixtures — the blocking gate | seven JSON files, validated by `packages/protocol/test` and replayed by the store suite |

## 11. Code vs design discrepancies

Flagged per the code-wins rule; the design docs are not wrong about intent, but the M1
code is narrower in these places:

1. ~~**`extends` is single-parent in M1.**~~ RECONCILED 2026-09-26: `class.setExtends`
   takes `parentClassIds: string[]` (replace semantics, m2m per `01` §6); direct edges
   live in `class_extends`, `class_hierarchy` is the m2m transitive closure, and cycles
   (self-parent, multi-hop) fail loud. Binding resolution (own → shortest extends-path →
   earliest HLC) remains owed work — it happens at read time in the bindings read model.
2. ~~**Backlinks are direct edges only.**~~ RECONCILED 2026-09-26:
   `Store.backlinksWithRollup(id)` rolls up at query time (the `00-INDEX`
   fan-out-vs-traversal choice resolved as traversal) with **source-side
   containment**: direct edges on the node plus outward links from inside its
   subtree (source ∈ subtree, target outside it — a block inside France
   linking Paris references France; intra-subtree links excluded), one row
   per (source, kind) annotated `kind: direct|containment` + depth, direct
   first. `backlinks(id)` and the `node_stats.backlink_count` badge stay
   DIRECT (a containment-heavy page's list can exceed its badge); `refset`
   filter inheritance (`01` §8) is still owed.
3. ~~**FTS search misses page titles.**~~ RECONCILED 2026-09-26, SUPERSEDED
   2026-10-01 (title-is-content): the indexed text is the content plaintext —
   the title lives in the content, so title search rides the same index
   (`search.ts`); the name prefix is gone with the retired column.
4. **`contentAst`, not `contentDeltaB64`, is the live carrier.** The CRDT delta field
   exists in the payload schema; the Yjs per-node `Y.Text` port does not exist yet.
5. **`class_list` read model.** SCHEMA.md describes the class listing as a derived
   `class_list` read model; M1 lists classes from the `class` registry table joined with
   `class_member_set` (`routes-objects.ts`), with the node row as structural authority.
6. **Outbox durability.** The designed local-first flow assumes a durable client op log
   re-feeding the outbox; the M1 outbox is in-memory and the browser store is in-memory
   (sql.js), so recovery after a full page reload is a server re-sync.
7. **Editor.** The Logseq-style outliner (bullets, indent/outdent reparenting via
   TreeCrdt, fractional reorder, verb-mark capture UX) is the M1b/M2 program
   (assessment §34.10); the shipped web UI is a read-oriented slice-1 shell over the
   workspace client.
8. **Property write path is schema-blind** (2026-10-02). The `property.set`
   applier never consults `property_schema` — no type/shape/cardinality/
   `targetClassFilter`/`datePrecision`/target-existence validation; all value
   conventions are UI-enforced only. Detail: implementation-plan §34.32 PG6.
9. **Multi-value properties are positional idx slots, not elements** (2026-10-02).
   LWW per (node, schema, idx) + per-slot tombstones; `unset` leaves permanent
   gaps (no reindex, readers don't assume density); the designed element-identity
   / OR-Set semantics (SCHEMA.md owed item "m2m tombstones") are not reached.
   Detail: §34.32 PG5.
10. **Broken-target property values** (2026-10-02). No referential rule: values
    referencing a deleted node survive, and the source's next `rebuildEdges`
    re-derives the edge (no target-existence check) — backlinks to nonexistent
    nodes resurrect. Detail: §34.32 PB1.
11. **Text-carrier convention is client-side only** (2026-10-02). Unset orphans
    the carrier back into the body (spec says trash, SCHEMA.md:134); `text` values
    coexist in three shapes (`{"nodeId": …}` / plain string / bare uuid) depending
    on which editor wrote them. Detail: §34.32 PB2.
12. **Spec↔wire arrears** (2026-10-02). `class_property.active` is specced
    (SCHEMA.md:122) but absent from wire+DDL; `scope` semantics are undefined in
    any design doc; `propertySchema.update` converges by relay apply-order, not
    per-field HLC (SCHEMA.md:19 follow-up). Detail: §34.32 PC3/PC4/PC5.

Items 8–12 were surfaced by the 2026-10-02 property-layer audit; like items 1–7
they are code-narrower-than-design (or design-lagging-code), none touches sync
authority — the operation log, appliers, and convergence machinery implement the
designed model as specced.
