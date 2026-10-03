# Notees → Local-First Personal Information Environment
## Evidence-Based Feasibility Assessment & Evolution Blueprint

Date: 2026-09-24 · Status: the ongoing implementation plan (moved to `.plans/implementation-plan.md` 2026-10-02; formerly `.plans/2026-09-24-object-graph-pim-evolution/assessment.md`) · Evidence base: full-repo inspection (backend, frontend, protocol, plugins, tests, deployment, docs) on `main` @ Notees 3.0.0

**Standing process rules (owner):** (1) **Inspect the archive first.** Every task mines the retired implementation at git tag **`v1-archive`** for reference and inspiration before designing — its editor, export service (`app/features/export/` — server-rendered markdown/html/pdf/text/json), views, pickers, and workflows were daily-driven for months and are the cheapest source of proven design. A task that never looked at the archive is not done; record what was mined in the task's work-record entry. (2) The docs-in-same-pass rule (AGENTS.md) and the per-task gate (`pnpm -r build` + `pnpm test` green) stand as recorded elsewhere. *(Rule 1 recorded 2026-10-03 — the §34.24 export phase below predates it: v1's export service was not consulted for H1/P1/D1/L1, which were benchmarked against Capacities instead; the archive's PDF/HTML renderers remain available as a comparison pass.)*


Revision 11 — **the render-state model: `node_type` → (`is_class`, `present_as_main`), envelope v3 (owner, 2026-10-02).** The `node_type ∈ {page, block, class}` enumeration (Revision 10) is replaced by two booleans: `is_class` — the only identity marker, classes always roots (`CHECK (is_class = 0 OR parent_id IS NULL)`) — and `present_as_main` — a render bit read only by the third branch of the cascade: `is_class → ClassView; parentless → document chrome (bit unread); else bit → parent's main-children zone + document chrome when zoomed, or inline body + block chrome` (the "hide from body" gloss: one partition bit for every parent type). Moves never write the bit; parentless-with-bit-set is benign by construction. Ops: `object.create`/`object.update` drop `nodeType`, gain optional `presentAsMain`; promotion/demotion = the toggle; class declaration stays `class.create`. Envelope `protocolVersion` bumps to **3**, accept only 3. **No backward compatibility (owner directive 2026-10-02, sole user):** no legacy `nodeType` key in any payload schema — strict rejection — and no replay-compat code in any applier. Instead, a **one-time migration** (`scripts/migrate-node-type.mts`) rewrites the stored relay log in place: `nodeType` → `presentAsMain` on `object.create`/`object.update` payloads (class-valued occurrences convert to `class.create` envelopes), `protocol_version` 2→3 on every row, `nodeType` conditions inside embedded query-token ASTs remapped to the boolean conditions, stale snapshots deleted, server-side derived stores rebuilt from the migrated log, `restore_epoch` bumped so every client wipes and re-syncs clean. Backup before run; `--dry-run` reports occurrences first. **Classes become containers (spec I4):** class nodes may have non-class children (R1 for class parents); guard = "no class under a class"; projection rule 1 deleted (spec §10 — self-tagged class children are ordinary body blocks). Query language: `nodeType` condition/sort/aggregation → boolean `isClass`/`presentAsMain`. Normative detail in SCHEMA.md; work record §34.23.

Revision 10 — **`kind` → `node_type`, the bullet-proof schema (Revision 9's `page_id` and the boolean-flag variant superseded same-session)**, plus class definition and Class View (owner, 2026-09-25): one enumeration `node_type ∈ {page, block, class}`, NOT NULL, with database CHECKs so illegal states are unrepresentable (a block can never be parentless; a class is always tree-external). Placement lives only in the tree (cross-page moves update nothing but the parent edge — no cascades); the three axes are node_type × parent_id × class_ids; promotion/demotion = flip block↔page in place; declaring a class = set `node_type='class'` (declaration-first). "Containing page" = nearest page-type ancestor (v1 `page_ancestors` CTE); "inside page Y at any level" = subtree CTE (v1 `specific_pages` port) — closure read model only if profiling demands. Class listing = derived `class_list` read model — explicitly NOT a stored registry (no shadow split, no new op type). **View resolution = f(node_type): class → Class View (page chrome + bindings/extends/classed-nodes panels) → page → Page View → block → Focused Block View.** Child pages render in a dedicated Child pages section (projection rule), and system sections (linked references, child pages, classed nodes, …) are named system queries — v1 port. Normative detail in SCHEMA.md; §34.14 rewritten.

Revision 9 — owner amendments recorded (2026-09-25): **`kind` is replaced by `page_id`** (NULL = the node is a page; blocks inherit it at create/move; the workspace root admits only pages, fail-loud; promotion/demotion = clear/set `page_id` in place; the move cascade stops at nested pages; applier-maintained, never authored). This supersedes the settled "soft kind" axis — recorded in `00-INDEX` amendments, which win over `01` §4 until `01` is revised. Also recorded: whiteboard = system class + content token (embeddable under any block; cards are its children); projection-reclassification rules (class-instances → members section, property-carriers → properties panel); node-backed text properties (carrier blocks with arbitrary subtrees; unset deletes; promote is a separate gesture). Normative detail in SCHEMA.md; see §34.14.

Revision 8 — answers the editor-parity question (2026-09-25): the editor reimplementation is planned scope (M1 core outliner, M2 polish), parity with Logseq/Tana/Notion/Capacities is feasible with **no architectural modification** — all named features are projections over existing primitives, most ported from v1; the single load-bearing addition is block-level content tokens (embed/query/asset/whiteboard), added to SCHEMA.md owed work. Named parity scope recorded in new §34.10.

Revision 7 — **model re-convergence adopted (2026-09-25).** The owner–architect design session re-converged the knowledge model; the design stack is imported at `v2/.plans/design/` (`00-INDEX.md` normative index, `01` normative model, `02` decision history, `03` paradigm validation). Material deltas vs this plan: first-class relation **entities** deleted (replaced by node-typed properties + typed-link word marks + one derived edge index — `01` §8), classes re-merged into the node table (`01` §6), Logseq-style outliner as the editor, soft page/block kind. **Precedence rule (recorded in both `00-INDEX.md` and here): `01` is normative for the model; this plan is normative for process, milestones, and gates.** Adopted amendments: record-don't-resolve (typed-link capture records ordered candidate-span token IDs; resolution rule deferred to M2 — SCHEMA.md owed work), and fixture-gate parity (deleted relation fixtures replaced by typed-link-mark fixtures exercising the same acceptance scenarios). Scaffold reworked accordingly (`packages/protocol`: `relation.*` ops, the 0004 seed block, and RELATIONS.md removed; SCHEMA.md created). See §34.9.

Revision 6 — records a forward constraint from the third review: seeded relation schemas MUST use stable, fixed UUIDs in seed data (ported precedent: `SYSTEM_CLASS_UUIDS` in `app/domain/entities/constants.py`), because relation rows, fixtures, and the old-data migration all bake `relation_schema_id` in; seed-id drift silently breaks them. **Superseded 2026-09-25: relation entities and the seed vocabulary were deleted entirely (see Revision 7); the constraint survives only as precedent for how system classes keep their fixed UUIDs.**

Revision 5 — closes a residual gap from the third review: M1 ships the `relation_schema` **table + hardcoded system seed set** (`authored-by`, `cites`, `related-to`, … from §14) so typed relations work from day one, while `relationSchema.create/update/delete` ops and dimension-7 schema-evolution semantics are deferred to M2 (§14, §34.6).

Revision 4 — incorporates second review: M1 relations scope narrowed to identity + create/delete + tombstone + LWW properties (position/ordering merge and `relation_path` query conditions deferred to M2); the Relation Semantics Specification promoted from "deliverable before coding" to **the first file of the new repo** (`packages/protocol/RELATIONS.md`, fixtures-first); the plain-text AST editor fallback **pre-committed as plan**, not failure; the old-data migration script moved to month 1–2 as the data-model acceptance test; M1 timeline marked provisional (exit criteria are the plan); and the ported fixture/convergence corpus reaffirmed as a **blocking, non-negotiable M1 gate** (§34.6, §34.7).

---

## 1. Executive Summary

**Decision (2026-09-24, owner-confirmed): GREENFIELD REWRITE — see §34 for the activated plan.** The original recommendation of this assessment was *evolve*; it is retained below as the evidence base and as the considered alternative (§28, §33). The decision changed because the decisive fact changed: Notees is pre-adoption and the owner is its only user, which removes the user-migration, data-compatibility, and multi-client-coordination costs that carried the evolve argument. Everything else in this assessment stands — most importantly the finding that the target architecture is a **completion of the architecture Notees already has**, which is precisely why a greenfield reimplementation of it is a sound bet rather than a gamble.

Notees today is not a conventional note app with a server database. It is already a **local-first, operation-log-synchronized object graph**:

- The authoritative store is an immutable **operation log** (`relay_envelope` in PostgreSQL, `app/db/schema/relay.sql:18-30`) replayed into **per-workspace derived SQLite databases** — server-side (`data/relay/derived/<uuid>.db`, `app/core/workspace_store.py:76`) and client-side (wa-sqlite/OPFS in a Web Worker, `frontend/src/core/db/schema.ts`).
- The data model is already a **typed, polymorphic object graph**: nodes with UUIDv7 identity, a class system with inheritance (`class`, `class_hierarchy` transitive closure), typed property schemas (`property_schema`, `class_property_edge`), LWW+CRDT conflict semantics, typed edges (`edge`), stable link instances (`node_link`), saved-query views (`node_view`), and 22+ system classes including `book`, `paper`, `person`, `organization`, `source`, `collection`, `highlight` (`app/domain/entities/constants.py:117-152`).
- Sync is already **operation-based with HLC causality, server-assigned seq cursors, snapshots, compaction, WebSocket acceleration, and opt-in E2EE** (`protocol/SPEC.md`), with **three clients already speaking the protocol** (React web in this repo; Flutter and GTK in sibling repos).
- A **plugin system already exists** with manifests, permissions, importers/exporters/sync sources/views (`app/plugins/core/`), and 10 shipped plugins including BibTeX import, Zotero sync, EPUB metadata, OPDS, and flashcards.
- An **agent-facing REST API already exists** (`/api/agents/v1`, `app/features/agents/router.py`) authenticated by scoped API keys.

The target architecture in the brief is therefore **not a redesign — it is a completion**. The gaps are specific and enumerable:

1. **No first-class relation operations.** Edges are derived from content (`rebuildEdgesForNode`), not created as semantic, typed, property-bearing operations. There are no `relation.create/delete` op types.
2. **No general-purpose machine API.** REST coverage of the object model is limited to the 9-endpoint agents API; there is no object/relation/collection/asset/annotation CRUD, no query endpoint, no semantic operations.
3. **No CLI.**
4. **No annotation model** (page/coordinates/quote targeting an asset) — a `highlight` class exists but nothing consumes it structurally.
5. **No citation architecture** beyond a `citekey` property: no `cites` relation with locators, no CSL/BibTeX/CSL-JSON export (deliberately dropped earlier, `docs/plans/2026-08-23-source-hierarchy-attachments/prd.md:308`).
6. **Search covers node text only** (FTS4), not properties-as-text, asset metadata, citation fields, or extracted document text.
7. **Asset sync is all-or-nothing**; no selective materialization/pinning.
8. **Plugin execution is in-process Python/TS** with manifest-level but not runtime-enforced isolation.
9. **No events/webhooks** for integrations (op listeners are in-process and global).

Each of these is **additive on top of an operation log that was explicitly designed to absorb new op types** (`protocol/SPEC.md` §3: "Adding a new op type is an additive change and does not bump the protocol version"). Nothing in the target vision requires replacing the storage engine, the sync protocol, the conflict semantics, or the client architecture.

The rewrite question was treated as a **formal option, not a dismissed strawman** — and the owner has now exercised it. §34 sets out the activated greenfield plan: TypeScript everywhere, a clean break on protocol encoding with the proven sync semantics preserved as invariants, the content AST retained, and staged milestones M1→M2→M3. Its starting position is unusually strong for a rewrite: the greenfield design converges on the same core architecture Notees already has, and the most battle-tested half of the current system (the TypeScript client core — SyncEngine, derived appliers, QueryAST compiler, E2EE) ports almost verbatim into the new shared core.

---

## 2. Product Target

A **personal information environment** in which everything meaningful — notes, books, papers, people, organizations, concepts, projects, documents, websites, datasets, files, annotations, citations, collections — is a first-class object in one object graph:

- Objects have stable UUID identities, classes (extensible), typed properties, typed relations, content, assets, tags, and collection memberships.
- All interfaces (library, folders, collections, graph, timeline, table, bibliography, search) are **projections** of the same model — never separate stores.
- Local-first: every client holds a complete, queryable replica; the server is a sync relay, not a prerequisite for work.
- The machine API and CLI are first-class product surfaces, designed for AI/coding agents with explicit safety rails.
- Plugins extend the system through a controlled, permissioned contract built on the public API.
- Scholarly research (sources, authors, citations, bibliographies) is ordinary object-graph usage, not a separate subsystem.

What the target is **not**: an AI assistant, a generic productivity/journaling/task/inventory/media app. Features must reinforce the object-graph/research/archive model.

---

## 3. Current Repository Architecture

### 3.1 Repository layout

```
app/                    FastAPI backend (Python 3.12, feature-first hexagonal)
  core/                 Operation model, HLC clock, derived-state appliers, QueryAST→SQL, seed, migration framework
    derived/            Server-side op appliers → per-workspace SQLite (app/core/derived/schema.py)
    query_ast/          Canonical QueryAST v1 model + SQLite compiler (backend copy)
    migration/          PG→op-log migration framework (used by scripts/migrate_to_ideal.py)
  db/                   PostgreSQL schema (app/db/schema/sql.py + relay.sql), idempotent init, 5 named migrations
  domain/               Entities, ports, permission checker, citekey + query-language services
  features/             auth, workspaces, assets, shares, tasks, export, import_, activity, collab, notifications, undo, admin, agents
  infrastructure/       PostgreSQL repositories, Redis pub/sub, email, push, export renderers
  plugins/              Plugin runtime (core/) + 10 builtin plugins (builtin/) + external stub (external/)
  relay/                Sync relay: models, storage adapters, service, router, websocket, broadcast, permissions
  routers/plugins.py    Plugin management REST API
frontend/               React 19 + Vite + TS strict (the local-first client)
  src/core/             THE data path: worker-owned SQLite (wa-sqlite/OPFS), appliers, GraphQuery layer, sync engine, E2EE, CRDT
  src/features/         content, editor, properties, queries, views, assets, shares, tasks, sync, collab, layout, …
  src/plugins/          Frontend plugin runtime (core/) + builtin plugin UIs
protocol/               SPEC.md (wire protocol source of truth) + machine-readable fixtures
tests/                  949 pytest functions (~100 files): relay, derived, migration, query, plugins, API
scripts/                18 operational/migration scripts (no user-facing CLI)
prototypes/notees-ideal-arch/   Bun+TS prototype of this architecture (historical blueprint, already ported)
data/                   Runtime state: relay/, workspaces/<uuid>/assets/, plugins/, backups/, exports/, static-shares/
docs/                   User docs (api.md, plugins.md, architecture.md, …) + plans/
compose.yaml / compose.dev.yaml / Dockerfile{,.dev,.web} / Taskfile.yml / .github/workflows/
```

### 3.2 Runtime architecture (actual, confirmed)

```
Browser (React SPA, PWA)
  │  reads: worker-owned wa-sqlite (OPFS) via GraphQuery layer
  │  writes: local op apply → sync_outbox → push
  ▼
Web Worker ── WorkspaceStore (derived SQLite, appliers, CRDT state)
  ▼
SyncEngine ── HTTP POST /api/relay/batch · /catch-up · /snapshot · WS /api/relay/ws/{ws}
  ▼
FastAPI (uvicorn)
  ├── RelayService → PostgresRelayStorage (relay_envelope, relay_snapshot, segments)
  ├── WorkspaceStore (server-side participant, same appliers) → data/relay/derived/<uuid>.db
  ├── Feature REST (auth, workspaces, assets, shares, export/import, tasks, agents, plugins…)
  └── PluginManager (in-process plugins, mounted routers)
  ▼
PostgreSQL (relay log + users/workspaces/shares/settings/api_keys) · Redis (WS fan-out) · filesystem (assets, exports, backups)
```

Sibling repos (not here): `notees-flutter` (mobile), `notees-gtk` (desktop) — both mirror `protocol/SPEC.md` client-side.

### 3.3 Architectural boundaries that actually exist

- **The operation envelope is the only write path** for graph data. There is deliberately **no REST CRUD for nodes** (`docs/api.md` states this; confirmed by inspection — the only REST write path is the agents API, which itself emits operations).
- **Derived SQLite is a rebuildable projection** on both server and client; `restore_epoch` forces client wipes after server restores.
- **The relay does not interpret payloads** (except E2EE `$e` skip rules); semantic validation lives in `app/core/validation.py` (required fields per op type) and appliers.
- **Trust boundary is workspace membership**; per-node routing metadata is client-supplied and explicitly best-effort (`protocol/SPEC.md` §9).
- **Duplicated semantics**: the derived appliers + QueryAST compiler exist twice (Python `app/core/derived/`, `app/core/query_ast/compiler.py`; TypeScript `frontend/src/core/derived/`, `frontend/src/core/query/compileToSqlite.ts`), kept in parity by convention, fixtures (`tests/test_relay_protocol_fixtures.py`, `tests/core/test_system_uuid_parity.py`), and a seed-parity contract (`app/core/seed.py` ↔ `frontend/src/core/seed.ts`). This is the single largest structural tax in the codebase and matters for every future op type.

---

## 4. Current Data Model

### 4.1 PostgreSQL (server state) — `app/db/schema/`

| Table | Purpose | Key columns |
|---|---|---|
| `user` | accounts | `uuid`, email, bcrypt hash, TOTP (encrypted), `role` |
| `user_backup_code`, `user_device_token` | 2FA recovery, FCM push | hashes/tokens |
| `workspace` | tenant root | `uuid`, `restore_epoch`, `sync_protocol_version` |
| `workspace_share` | membership + 5 can_* flags | unique (workspace,user) |
| `node_share` / `node_public_share` | node-level grants / public links | logical `node_uuid` refs into derived state |
| `pending_invite`, `notification` | invites, in-app notifications | |
| `setting_user/workspace/system` | JSONB settings | key-value |
| `api_key` | agent credentials | `key_hash`, `scopes` JSONB, `key_prefix`, `last_4` |
| `refresh_token` | rotating refresh tokens w/ reuse detection | `family_id`, `replaced_by` |
| `relay_envelope` | **the operation log** | `id` PK, workspace, actor, HLC, `affected_node_ids` JSONB (GIN), `op_type`, `payload` JSONB, `protocol_version`, `seq BIGINT IDENTITY` (server cursor) |
| `relay_snapshot` | serialized derived DB blobs | `data BYTEA`, `up_to_seq`, `state_hash` |
| `compacted_operation_segment` | compaction bookkeeping | from/to HLC, snapshot ref |
| `workspace_encryption_key`, `user_public_key`, `workspace_member_key` | E2EE key wrapping | wrapped keys |

Migrations: idempotent SQL blocks + `schema_meta`-tracked Python `run()` modules (`app/db/migrations/` — 5 exist, incl. `drop_legacy_tables.py` which removed the 28 pre-op-log tables). No Alembic.

### 4.2 Derived SQLite (per workspace, server and client) — `app/core/derived/schema.py`, `frontend/src/core/db/schema.ts` (client at user_version v22)

Core graph:

| Table | Role | Conflict semantics |
|---|---|---|
| `node` | objects; `kind CHECK(kind IN ('page','block'))`, `class_ids` JSON, `parent_id`, `content` JSON AST, `active` (soft delete), `icon/color`, created/updated by/at, HLC cols | fields LWW via `node_field_lww`; content CRDT |
| `node_child_order` | tree ordering | fractional `position` strings + TreeCrdt |
| `class`, `class_hierarchy` | classes + transitive closure of `extends` | `class_lww` LWW |
| `property_schema`, `class_property_edge` | typed property definitions + class↔property binding (sequence, defaults, required/readonly/hide_when_empty) | schema CRUD ops |
| `property_value` (+ `property_value_tombstone`) | typed values `(node_id, property_schema_id, idx)` | LWW by HLC + tombstones |
| `class_member_set` | OR-Set class membership (v20) | add-wins |
| `edge` | graph edges `type` (+ optional `property_schema_id`, `metadata` JSON) | **derived from content**, see §4.4 |
| `node_link` | stable link instances (`id` = link UUID referenced by AST pills; `target_id`; click_count) | healed/derived |
| `crdt_state` | per-node Yjs text state, per-parent Yjs tree state | CRDT |
| `search_index` | FTS4 virtual table over node plaintext (+ docid map) | derived |
| `node_stats` | materialized child/backlink/reference/descendant counts | derived |
| `node_view` | saved query views per node: `view_type`, `view_mode` (10 modes), `query_ast`, sort/group/shown_properties | CRUD ops |
| `node_asset` | asset binding: `(node_id, asset_hash, mime_type, size, original_name)` | asset ops |
| `operation`, `snapshot`, `compacted_operation_segment` | local op log mirror + snapshot cache | — |
| `sync_watermark` (incl. `cursor_seq`, `restore_epoch`), `sync_push_watermark`, `sync_outbox`, `recovery_operation` | sync state, retry/quarantine, parked ops | — |
| `node_version` | one row per content op (revision history, restorable) | — |
| `activity_log`, `link_click`, `user_favorite`, `node_alias`, `plugin_op_log` | activity, counters, favorites, aliases, plugin op preservation | — |
| `task_completion`, `task_recurrence` | task metadata | — |
| `node_public_share`, `node_user_share` | share projections | share ops |
| `flashcard` (server), `trash` (server) | SM-2 flashcards; soft-delete retention | plugin ops / delete ops |

Client-only extras vs server: `node_field_lww`, `class_member_set`, `class_lww`, `node_version`, `recovery_operation`. Server-only: `flashcard`, `trash`.

### 4.3 Object identity

- All public identity is **UUIDv7** (`uuid_extensions.uuid7()` backend, `uuidv7` npm frontend) — index-locality-friendly, stable, independent of title/path/collection.
- Legacy: `user`/`workspace` tables also carry internal `SERIAL id`; rule (project-rules) forbids exposing them.
- `node_link` pills carry **two** UUIDs: the stable link-instance id and the target node id (`link_id = targetUuid:linkUuid`, recovery metadata only).

### 4.4 Edges, links, and why "relations" don't exist yet

`edge(source_id, target_id, type, property_schema_id, metadata)` rows are **rebuilt from content**, not authored: `rebuildEdgesForNode()` (`app/core/derived/edge.py`) parses `node_link` pills / `[[wiki-links]]` out of the content AST and diffs the edge set. Consequences:

- The only edge type in production use is `reference`.
- There is **no op type to create/delete a semantic edge** — `KNOWN_OP_TYPES` (`app/core/operation.py:17-78`) has 45 types, none named `relation.*`.
- Property-typed relations exist as **property values of type `node`** (`PropertyValueRelation`, `app/domain/entities/property.py`) — i.e., "authored-by" today would be a `person`-typed property schema, not an edge. The `edge.property_schema_id` column exists to project such property relations into the graph (used by graph views/backlinks), but the authoring surface is the property system.
- Relation metadata (locator, prefix/suffix, validity period, provenance) has **no storage**.

### 4.5 Classes, properties, schemas

- 22 system classes (`app/domain/entities/constants.py:117-152`): structural (`class`, `year/month/day`, `query`, `code`, `whiteboard`, `table`, `template`, `comment`, `cloze`, admonitions), domain (`source`, `book`, `paper`, `article`, `thesis`, `document`, `movie`, `weblink`, `agent`, `person`, `organization`, `collection`, `highlight`, `asset`, `card`, `task`, `quote`).
- `SYSTEM_CLASS_EXTENDS`: book/paper/article/thesis/document/movie → `source`; person/organization → `agent`.
- ~30 system property schemas incl. task fields, source metadata (`authors`, `isbn`, `doi`, `publication_date`, `publisher`, `citekey`, `cover`, `attachments`), all `bindTo: "source"` etc.
- Property types (`app/domain/entities/property.py`): integer, float, boolean, url, email, date_range, node, text, image, date, selection (+ multi). Validation rules, options, class filters, computed fields exist in the schema.
- Users can create classes/properties at runtime (`class.create`, `propertySchema.create` ops) — **classes are already extensible**; there is no class-level "schema version" concept because the op log *is* the schema history.

### 4.6 Content model

- AST v1 (`frontend/src/types/ast.ts`): blocks `paragraph|heading|whiteboard|query`; inline `text|hard_break|code|math|node_link|broken_link|date_range|marks|external_link`. Stored as a JSON string in `node.content`.
- CRDT: one `Y.Text` per node (the Yjs plaintext *is* the serialized AST — unwrapped via `unwrapCrdtContentAst`), one `Y.Array` per parent for child order (`frontend/src/core/crdt/`).
- Editor: **custom contentEditable** (`frontend/src/features/editor/custom/`), not ProseMirror/Slate/Lexical; slash commands, floating toolbar, inline node-link pills, KaTeX.

### 4.7 Tags

**Tags are class assignments.** `useAddTag` → `manager.assignClass(nodeUuid, tagUuid)` (`frontend/src/features/content/hooks/useAddTag.ts:10-13`); a tag is a node classed `tag` (also a page). QueryAST `tag` conditions compile to `class_ids` membership (`compileToSqlite.ts:716-741`). Legacy `Node.tag_ids` and the import path's "no tag association table" comment (`app/features/import_/service.py:169-198`) mark the transition as incomplete but directionally settled.

### 4.8 Collections and views

Three mechanisms:
1. **`node_view`** — saved QueryAST + presentation per node; 10 view modes (list, document, table, kanban, gantt, calendar, chart, pivot, graph, timeline); system view types (`linked_references`, `child_pages`, `classed_nodes`, …) auto-fixed by `autoFixSystemQuery`.
2. **`collection` system class + `CollectionView`** — class-driven chrome; members = sources nested under or linking to the collection (used heavily by the Library plugin).
3. **Folders** = `parent_id` adjacency (no separate primitive; the tree is the folder).

### 4.9 Bibliography model (current)

- Source tree: `source` ← `book|paper|article|thesis|document|movie|weblink`; agents: `agent` ← `person|organization`.
- Bibliographic fields are **system property schemas** (`authors` (relation to agent nodes), `isbn`, `doi`, `publication_date`, `publisher`, `citekey`, `cover`, `attachments`).
- `citekey` is a **property**, generated by pattern (`app/domain/services/citekey.py`, Better-BibTeX-style tokens, collision suffixes) — correctly **not** an identity.
- BibTeX import (`notees.bibtex`) upserts by citekey, maps entry types to classes, find-or-creates `person` nodes (`app/plugins/core/agents.py`).
- Zotero sync (`notees.zotero`) maps item types→classes, creators→agents, fills citekeys.
- Library plugin (`notees.library`, disabled by default): ISBN/DOI lookup via Open Library/Crossref, PDF inspect, Work→Edition grouping UI.
- **Missing**: CSL/CSL-JSON, RIS, BibTeX *export*, citation relations with locators, citation rendering. (Auto-export of `.bib`/CSL-JSON was explicitly cut from the source-hierarchy PRD as "a future dedicated Word/citation plugin".)

### 4.10 Assets

- Upload (`app/features/assets/`): MIME allowlist, magic-byte sniffing, 50 MB media / 100 MB doc caps → **content-addressed store** `data/workspaces/<uuid>/assets/<hash[:4]>/<sha256>.<ext>` with dedup + refcount (`.asset_refs.db`); thumbnail (800×600 WebP, Pillow); asset node gets the `asset` system class; `asset.upload` op syncs metadata (`node_asset`).
- Download: `GET /assets/{uuid}` with Range support, gated by JWT or 15-min single-asset tokens.
- `data/users/`, EPUB metadata handler (`notees.epub`), OPDS catalog (`notees.opds`) exist.

---

## 5. Current User Workflows

- **Write**: block editor → debounced save (`useContentSave`, 150 ms) → `node.updateContent` op (AST + Yjs delta) → local apply → outbox → push. Presence (focus/typing) over relay WS; conflicts detected post-pull (`syncConflicts.ts`: move_move, node_deleted, class_conflict, property_conflict) and surfaced in `ConflictResolutionModal`. Undo/redo is client-side inverse ops (`UndoManager`).
- **Organize**: tree via `node.move` (TreeCrdt + position strings); tags via class assign; collections via `collection` class or saved-query `node_view`; favorites (`user.favorite.*`); templates.
- **Query**: QueryAST builder UI → `compileToSqlite` → SQLite in worker; views render via the views registry; system sections (linked references etc.) lazy-load.
- **Search**: CommandPalette → `searchNodes` FTS4 + TF-IDF scoring (`matchinfo`), prefix-AND, class/tag filters (`#tag`).
- **Research**: Library plugin lookup by ISBN/DOI → source nodes; BibTeX import; Zotero pull; EPUB metadata; OPDS reading; PDF inspect; flashcards from `card`-classed nodes (SM-2).
- **Share/collaborate**: workspace roles; node public links (static HTML + password); per-user node shares; E2EE opt-in per workspace.
- **Admin**: users/metrics/settings, plugin management, asset audit, backups (pg_dump schedule), retention cleanup.

---

## 6. Current API

### 6.1 Relay (sync protocol) — `/api/relay` (documented in `protocol/SPEC.md`, `docs/api.md`)

`POST /batch` · `POST /catch-up` · `GET /snapshot` · `GET|PUT /snapshot/data` · `POST /compact` · `GET /stats` · `GET /ws/{workspace_id}` (WS) · E2EE key endpoints (`GET|PUT /encryption-key`, `GET|PUT /user-public-key`, `PUT /encryption-key/members`, `DELETE /encryption-key/members/{ws}/{user}`). Auth: JWT cookie/bearer; actor from credentials only. Idempotent ingest (`ON CONFLICT DO NOTHING`); seq-based catch-up; `restore_epoch` wipe semantics.

### 6.2 Feature REST — mounted under **both** `/api` and `/api/v1` (`app/main.py:560-580`)

Auth (register/login/refresh/2FA TOTP/backup codes/api-keys/device-token/me/settings/change-password/invites), Workspaces (CRUD, members, settings, classes, export/import/restore, sync-protocol-version), Tasks (recurrence, completions), Export (jobs; markdown/html/pdf/text/json + plugin formats; render-pdf; auto-export), Import (markdown w/ frontmatter), Assets (upload/token/download/thumbnail/info/list/delete), Activity (node log, link clicks), Collab (SSE — **dormant**, no publishers), Undo (**410 stubs**), Shares (public/user, inbox, public read), Notifications, Admin (users/metrics/settings/asset audit), Plugins (management + importer/exporter registry).

### 6.3 Agents API — `/api/agents/v1` (machine-facing, API-key auth, 60 req/min)

`GET /workspaces`, `GET /workspaces/{uuid}`, `GET /workspaces/{uuid}/nodes?q=`, `GET …/nodes/{uuid}`, `GET …/nodes/{uuid}/references`, `GET …/nodes/{uuid}/activity`, `POST …/nodes`, `PATCH …/nodes/{uuid}`, `POST …/nodes/{uuid}/properties`, `POST …/nodes/{uuid}/notes`. Writes go through `WorkspaceStore` (i.e., emit operations). **Classification: keep and massively extend** — this is the seed of the target machine API.

### 6.4 API-key auth

`X-API-Key` (`nk_…`), bcrypt-hashed, scopes JSONB (`read`/`write`/`admin`), expiry, revocation, `last_used_at` (`app/dependencies.py`, `RequireScope`). Change-password revokes all keys. **This is the agent credential system the target needs — it already exists.**

### 6.5 Endpoint classification (summary)

- **Keep**: relay API; auth; workspaces; assets; shares; export/import; tasks; activity; notifications; admin; plugins.
- **Extend**: agents API (→ full object API); workspaces export/import (→ BibTeX/CSL projections); search (→ unified endpoint).
- **Deprecate/remove**: `/undo/*` (already 410); SSE `/events/workspace` (dormant — replace with real event system); `node_shares` dual mounting inconsistency (`/api` vs `/api/v1` relay asymmetry).

---

## 7. Current CLI

**Does not exist.** No console script (`pyproject.toml` has no `[project.scripts]`); `scripts/*.py` are host-side admin/migration one-offs (18 scripts: compact, snapshots, promote-admin, 2FA reset, migration suite). Target: a first-class `notees` CLI consuming the public API (§17).

---

## 8. Current Extension Architecture

**Exists and is real** (details §19 baseline): manifest (`app/plugins/core/manifest.py`) with id/name/version/permissions/backend+frontend entrypoints/contributes (settings, commands, slashCommands, importers, exportFormats, views, sidebarItems); `PluginContext` port-factories + data helpers (`ensure_class`, `find_or_create_node_by_name`, `upsert_page_by_external_id`, `emit_op`, …); 10 permissions (`read_nodes`, `write_nodes`, `read/write_properties`, `read/write_assets`, `background_sync`, `export`, `import`, `router`, `settings`); registry + lifecycle (install zip/git, enable/disable, unload purges modules/routes); `plugin.op` sync ops with per-plugin derived projections (flashcards) or `plugin_op_log` preservation; op listeners and class side effects (in-process hooks); frontend plugin runtime with UI registries + view primitives.

**Gaps**: in-process trust model (a plugin *is* server code); permissions checked at registration time, not as runtime capability enforcement on every data call; no per-plugin event subscriptions; no out-of-process/RPC/WASM option; no webhook-style egress; frontend plugins equally in-process.

---

## 9. Current Storage and Asset Architecture

- **Server**: PostgreSQL = relay log + identity/shares/settings; per-workspace derived SQLite files = queryable state (rebuildable); `data/workspaces/<uuid>/assets/` = content-addressed blobs + refcount DB + thumbnails; `data/exports/`, `data/static-shares/`, `data/backups/` (pg_dump custom format, hourly, retention 50), `data/plugins/`.
- **Client**: OPFS-hosted SQLite per workspace (fallback: in-memory + IndexedDB snapshots; fails loud with neither); multi-tab leader election (`tabLeadership.ts`) with BroadcastChannel RPC; local-mode ("Continue locally") runs with **zero API calls** (e2e-tested).
- **Backups/restore**: pg_dump schedule; workspace restore bumps `restore_epoch`, prunes envelopes/snapshots/derived DB — clients wipe and resync. Snapshots are client- or server-produced serialized SQLite (`conn.serialize()`), max 5/workspace, compaction segments exempt.

---

## 10. Current Search Architecture

- FTS4 (`unicode61`) over `node` plaintext only (`search_index`), docid-mapped; TF-IDF scoring via `matchinfo('pcx')` for top-100 candidates; prefix-AND queries; class/tag/metadata filters via QueryAST (`frontend/src/core/query/search.ts`).
- QueryAST content conditions: LIKE contains/starts/ends/equals + FTS; **regex explicitly unsupported**.
- **Not indexed**: property values as text, asset filenames/metadata, citation fields, extracted PDF/EPUB text, relation targets' titles.
- Server-side search: only via agents API `q` param (title/content LIKE) and the QueryAST compiler used by export_profiles.

---

## 11. Current Bibliography Architecture

Covered in §4.9. Summary: source/agent class trees + system property schemas + citekey service + BibTeX import + Zotero sync + identifier lookup + EPUB/OPDS/PDF tooling. **No export formats (BibTeX/CSL/RIS), no citation relations, no rendering pipeline.** Authors are already reused `person` nodes — the target's "authors as Person objects" is satisfied.

---

## 12. Feasibility Assessment

| Target capability | Feasible on current architecture? | Basis |
|---|---|---|
| Arbitrary object classes | **Yes — exists** | runtime class CRUD ops, inheritance closure, system+user classes |
| Class schemas / typed properties / validation | **Yes — exists** | `property_schema` (types, options, rules), `class_property_edge` |
| Stable UUID identity | **Yes — exists** | UUIDv7 everywhere; citekey/title not identity |
| First-class typed relations with properties | **Yes — additive** | new `relation.create/delete` op types + `relation` derived table; edge table precedent |
| Tags vs relations separation | **Yes — exists** | tags=class assignments; relations will be edges |
| Collections as projections (saved queries) | **Yes — exists** | `node_view` + QueryAST; needs genericization beyond per-node views |
| Multiple views | **Yes — exists (10 modes)** | views registry; add folder/gallery/bibliography modes |
| Object/asset separation | **Yes — exists** | asset nodes + content-addressed files + `node_asset` |
| Annotations as objects | **Yes — additive** | `highlight` class exists; needs annotation op/type + asset anchoring |
| Citations with locators | **Yes — additive** | relation properties + citekey property exist |
| BibTeX/BibLaTeX/CSL-JSON/RIS round-trip | **Yes — additive** | import exists; export via plugin exporters; cite-model mapping needed |
| Unified search | **Yes — additive** | extend FTS pipeline to property/asset/citation indexes |
| Local-first offline ops | **Yes — exists** | op log + outbox + local mode proven |
| Sync semantics (op-based, HLC, conflicts) | **Yes — exists, mature** | SPEC §1-9, convergence tests |
| Selective asset sync | **Partially — additive** | asset tokens/Range exist; needs per-device availability state (device-local, not ops — §24) |
| Complete machine API | **Partially — extend agents API** | infra (API keys, scopes, WorkspaceStore emitters) exists |
| Full CLI | **Yes — new client of the API** | no blockers |
| AI-agent safety (scopes, audit, dry-run) | **Partially** | scopes exist; audit/dry-run/transaction semantics to add |
| Sandboxed plugins | **Partially — needs new runtime** | manifest/permissions exist; execution isolation doesn't |
| Event system for plugins/integrations | **Additive** | op listeners exist in-process; need durable subscription + webhooks |
| 100k+ objects / 100k+ relations scale | **Yes with work** | SQLite + FTS + recursive CTEs adequate; see §30 |

**Nothing on the target list is structurally blocked by the current architecture.** The two heaviest lifts are (a) first-class relations (touches op set, both appliers, query compilers, UI) and (b) the out-of-process plugin runtime.

---

## 13. Detailed Gap Analysis

| Area | Current implementation | Desired architecture | Gap | Complexity | Migration strategy | Risk |
|---|---|---|---|---|---|---|
| Object model | `node` page/block + classes | arbitrary classes as objects | kind dichotomy is presentation, not storage; need object-shaped UX/API over same tables | M | none (reinterpretation) | Low |
| Object identity | UUIDv7 | same | none | — | — | — |
| Classes/schemas | exists w/ inheritance | same + composition? | decide composition vs inheritance-only (keep inheritance) | S | — | Low |
| Notes as objects | pages/blocks classed `note` | notes linkable via relations | needs relation ops | M | — | Low |
| Relations | derived `edge` rows (type=`reference`); node-typed properties | first-class typed, property-bearing, ordered, provenance-carrying relations | **no `relation.*` ops, no relation table, no UI, dual compilers** | **L** | new ops + derived `relation` table; backfill `authored-by`-style relations from node-typed properties | **High** (op-set change touches 3 client repos) |
| Tags | class assignments | same, formalized | legacy `tag_ids` cleanup; import path gap | S | migration to strip legacy fields | Low |
| Collections | `node_view` per-node + `collection` class | workspace-level saved-query collections, nested, membership rules | generalize `node_view` scope beyond node_id; collection membership = query OR explicit set | M | keep both; add explicit-membership collection type | Medium |
| Views | 10 modes | + folder, gallery, bibliography, map | new view modes in registry | S-M | — | Low |
| Assets | content-addressed, refcounted, thumbnails | same + selective sync | per-device availability state (device-local, not ops — §24) | M | client `device_asset` cache + pin preferences via settings | Medium |
| Filesystem | CAS under `data/workspaces/<uuid>/assets` | same | none | — | — | — |
| Search | FTS4 node text | unified index: titles, props, content, tags, relation targets, filenames, citation fields, extracted text | new index sources + ranking + QueryAST operators | **L** | rebuild indexes from op log (derived) | Medium |
| Annotations | `highlight` class unused structurally | annotation objects anchored to asset+page+coords+quote, linkable to notes | new class set + anchoring props + editor/PDF UX | **L** | new ops; PDF text-layer spike | Medium-High |
| Bibliography | source tree + props + citekey | same + export projections | exporters (BibTeX/BibLaTeX/CSL-JSON/RIS) | M | mapping table class↔entry-type | Low-Medium |
| Citations | citekey property only | `cites` relation w/ locator/prefix/suffix/position; "where used" backlinks | relation props + citation index + render pipeline | M-L | relation migration | Medium |
| Word/LaTeX integration | none | plugin-based (future) | depends on export formats + citation model | L | defer to plugin | Low (deferred) |
| API | agents API (9 ep) + relay + feature REST | complete versioned object API + semantic ops | **major extension** | **L** | extend agents API → `/api/v1/object` surface | Medium |
| CLI | none | full CLI w/ JSON output, exit codes | new client | M | consume public API | Low |
| Agent access | API keys + scopes | + audit log, dry-run, transactions, mutation IDs | additive | M | — | Low |
| Plugin system | in-process, manifest perms | + out-of-process RPC runtime, per-call enforcement, events | **new runtime** | **L** | dual runtime (in-proc + subprocess host) | High |
| Events | op listeners (in-proc, global) | durable event log + plugin subscriptions + webhooks | additive | M-L | build on op log | Medium |
| Local persistence | OPFS SQLite, local mode | same | none | — | — | — |
| Offline | full via op log | same | none | — | — | — |
| Sync | seq+HLC, snapshots, E2EE | same | none | — | — | — |
| Conflict resolution | detect + modal; CRDT text; LWW fields | same + relation conflict rules | add relation/property-merge rules | M | — | Medium |
| Asset sync | full-library only | on-demand, pinned, eviction, resumable | device asset policies + Range resume exists | M-L | new ops + client cache | Medium |
| Mobile/desktop | sibling repos (Flutter/GTK) | same + maybe Tauri later | protocol changes must land in 3 repos | M | protocol discipline | Medium |
| Import/export | md/json/zip/html/pdf/text/opml; bibtex/logseq in | + bibtex/csl/ris out | exporter plugins | M | — | Low |
| Security | JWT+refresh rotation+TOTP+API keys+scopes | + agent audit, plugin isolation | additive | M | — | Medium |
| Auditability | actor_id on ops; activity_log | mutation audit trail queryable via API | expose + extend | S-M | — | Low |
| Backups | pg_dump + snapshots + op log | same + documented restore drills | process | S | — | Low |
| Migrations | schema_meta + op-log-native evolution | same | none | — | — | — |
| CI/CD | release + audit only; no test CI | test/lint/typecheck CI gates | new workflow | S | — | Low |

---

## 14. Target Domain Model

> **Superseded in its relation-entity parts (Revision 7, 2026-09-25).** The model is now normative in `v2/.plans/design/01-knowledge-model.md`: relation **entities** were deleted — associations are node-typed properties (m2o/m2m) or typed-link marks on prose words, both feeding one derived edge index; classes are nodes in the single `node` table; kind is a soft column. The Relation Semantics Specification (`RELATIONS.md`) is retired; its surviving content folds into `packages/protocol/SCHEMA.md`. What remains valid below: UUIDv7 identity rules, asset/annotation object modeling, and the semantic-vs-device-state rule. The seed-UUID constraint (Revision 6) survives only as precedent for system-class UUIDs.

**Decision: keep the current node/class/property/relation-on-edge relational model. Do not introduce a graph database.** The op log + derived SQLite already implements the target's conceptual `Node` uniformly:

```
Object (node)                     id UUIDv7 PK, kind(page|block — presentation only)
├── Class[] (class_member_set)    system + user classes, single inheritance
├── Properties (property_value)   typed schemas, multi-values, validation
├── Content (node.content)        AST v1 (extend: citation, annotation-ref inline nodes)
├── Relations (relation)          NEW: first-class typed edges
├── Assets (node_asset → CAS)     content-addressed files, independent lifecycle
├── Tags (class assignments)      unchanged
├── Collections (node_view/collection) saved-query or explicit membership
└── Metadata                      created/updated by/at per field; op-log provenance
```

**Relations (new).** Physical design: new op types `relation.create`, `relation.delete`, `relation.update` (payload: `relationId`, `sourceId`, `relationType` (schema id), `targetId`, `properties` (JSON: locator/prefix/suffix/position/startDate/endDate…), `ordering`). Derived tables (both appliers):

```sql
relation(id PK, workspace_id, source_id, relation_schema_id, target_id,
         properties JSON, position TEXT, created_at, created_by,
         hlc_physical, hlc_logical, actor_id)          -- LWW on properties/update
relation_tombstone(id PK, deleted hlc/actor)            -- delete convergence
relation_schema(id PK, name, source_class_filter, target_class_filter,
                properties_schema JSON, inverse_name, active)  -- extends class system
```

- Relation types are **schemas** (extensible like classes), registered via `relationSchema.create` ops, seeded with a system set: `authored-by`, `published-by`, `edition-of`, `cites`, `related-to`, `has-asset`, `annotates`, `member-of`, `about`, `mentions`. **Seeded relation schemas MUST use stable, fixed UUIDs in the seed data — never names or generated ids.** Relation rows reference `relation_schema_id`, and both the canonical fixtures and the old-data migration script bake those ids in; if a seed id ever drifts, every fixture and the migration silently breaks. Precedent to port: system classes in `app/domain/entities/constants.py` (`SYSTEM_CLASS_UUIDS`), which uses fixed `00000000-0000-0000-…` UUIDs for exactly this reason.
- The existing `edge` table remains the **derived projection** used for backlinks/graph/counts; `relation` rows project into `edge` with `type='relation'` (keeping `node_stats`, backlinks, and graph views working unchanged).
- Node-typed **properties remain** for simple "single-valued attribute" cases; relations win for multi-valued, metadata-bearing, navigable semantics. The `authored-by` example becomes a relation when it carries `startDate`, else a property — the schema declares which.
- Inverse traversal: `relation_schema.inverse_name` + `edge` projection gives backlinks for free.

**Relation Semantics Specification (promoted — review challenge A; the first file of the greenfield repo, `packages/protocol/RELATIONS.md`, fixtures-first; §34.6).** "Additive to storage" does not mean "small architecturally." Relations touch identity, deletion, concurrency, permissions, queries, and UI, and must be specified before implementation. The spec defines, per dimension (M1 implements dimensions 1–5 and 8–9, plus the `relation_schema` table + hardcoded system seed set described below — the storage prerequisite for typed relations on day one; dimensions 6 (ordering), 7 (schema-evolution semantics), and 10's `relation_path` conditions are specified now but implemented in M2 — §34.6):

1. **Identity**: relation id = UUIDv7 assigned at creation; immutable `(source, schema, target)` triple.
2. **Deletion**: `relation.delete` → tombstone; re-creation of an identical triple after delete creates a **new** id (no resurrection ambiguity).
3. **Concurrent creation**: same triple created twice → dedupe rule (keep lowest op id; both converge to one row).
4. **Concurrent delete/update**: delete wins over property update (tombstone dominates); surfaced as `relation_conflict` in the existing conflict modal.
5. **Property updates**: LWW per property key by HLC (same rule as `property_value`).
6. **Ordering**: `position` strings scoped per `(source, schema)`; concurrent reorders → LWW on the ordered set with position-string merge (same semantics as `node_child_order`).
7. **Schema evolution**: deleting a relation schema with live relations → relations remain, rendered as raw type name (never cascade-delete user data); schema recreation with same name does not re-bind.
8. **Permissions**: relation writes require write access to **source**; target-side checks best-effort (consistent with SPEC §9 trust model).
9. **Inverse/backlink projection**: `edge` rows maintained for both directions; `node_stats` extension or query-time counts.
10. **Query/UI/compiler**: new QueryAST conditions (`relation`, `relation_path`) specified against the same AST in both compiler implementations.
11. **Interaction with citations/annotations**: `cites`/`annotates` are relation schemas, not special cases — no separate sync semantics.

**Semantic state vs device state (review challenge C — architectural rule).** The shared op log carries **semantic state only** (objects, relations, properties, content, asset metadata). **Device state** (asset cached/pinned, last-viewed, local thumbnails, local search index, UI layout) is never expressed as operations and never synchronized through the log; it lives in client-local tables and, where cross-device portability is genuinely wanted (e.g., "pin on all my devices"), in ordinary user settings (which have their own existing sync path via `setting_user`). This rule is binding for Phase 6 (§24) and all future op-type proposals.

**Identity**: unchanged (UUIDv7). Citation keys, titles, filenames remain attributes, never identity.

**Assets**: unchanged CAS; add per-device availability (§24).

**Annotations**: class family `annotation` (extends `note`) + system property schemas: `annotation_target_asset` (node ref), `annotation_page` (int), `annotation_rect` (JSON), `annotation_quote` (text), `annotation_color`; inline AST node type `annotation_ref`. Annotations are objects → relations/tags/collections apply.

**Citations**: relation schema `cites` (source: note/document-ish classes; target: `source` descendants) with properties `locator`, `prefix`, `suffix`, `position`. Rendering resolves `cites` → target's bibliographic properties → CSL-JSON → citeproc output (plugin).

**Provenance**: every op already carries `actor_id`, HLC, `timestamp`; op id = mutation id. Add `client`/`device` claims to the envelope (optional field, additive per SPEC §7) for `modifiedBy = agent:<id>` style audit.

---

## 15. Target Storage Architecture

Unchanged in essence; concretized:

- **PostgreSQL**: relay log (unchanged), identity/shares/settings/api_keys (unchanged). No new server tables required for relations/annotations/citations — they live in the op log.
- **Derived SQLite (server + client)**: add `relation`, `relation_tombstone`, `relation_schema`, `annotation` indexes (`annotation_target_asset`), extended FTS sources (§20), `device_asset` cache table (client). Schema version bump + `derived_state_version` bump forces rebuild-from-log on both tiers (mechanism exists: `isDerivedStateStale`, `CURRENT_DERIVED_STATE_VERSION`).
- **Filesystem/CAS**: unchanged; thumbnails; extracted-text sidecars (`<hash>.txt`) feeding search (§20).
- **Why relational remains sufficient**: the graph is adjacency-list + closure tables on SQLite; recursive CTEs already power tree/path queries at production scale in-client; 100k objects is small for SQLite (§30). A graph DB would forfeit the op-log rebuild, snapshots, and single-file portability that make local-first work.

---

## 16. Target API

**Style decision: versioned REST (`/api/v1`) + the existing relay protocol, with semantic endpoints.** No GraphQL (the QueryAST already provides a structured query language with a compiled implementation — GraphQL adds machinery without adding capability). RPC-over-WS already exists for sync; the public API stays request/response.

> **AB2 reconciliation (2026-10-03):** the endpoint sketch below is written in `/api/v1` — those are *design-time names*. The deployed surface is deliberately unversioned `/api/*` (no path versioning), and §34.33 AG4 now publishes its contract at `GET /api/openapi.json`. Path/version-header versioning stays parked behind the AG8 owner decision; the semantic sketch (endpoints, cross-cutting design) stands as written.

**Layers:**

1. **Relay protocol** (unchanged): op submission/catch-up — the *sync* API for Notees clients.
2. **Object API** (evolve the agents API into `/api/v1` object surface): the *direct manipulation* API for agents, CLI, integrations. Works on the server-side `WorkspaceStore` (emits operations → same log → syncs to all clients). This is the key insight: **the machine API writes operations, so API mutations and offline client mutations share one convergence path.**
3. **Semantic operations** (on top of 2): `POST /objects/{id}/relations`, `POST /collections/{id}/members`, `POST /assets/{id}/attach`, `POST /annotations`, `POST /citations`, `POST /search`, `POST /export` (format projections).

**Endpoint sketch (v1):**

```
# Objects
GET    /api/v1/objects/{id}                     # full object: props, classes, content
POST   /api/v1/objects                          # {class, name, content?, properties?}
PATCH  /api/v1/objects/{id}                     # name/content/icon/color (expected_rev optional)
DELETE /api/v1/objects/{id}                     # → trash (soft); ?permanent=true w/ confirm
GET    /api/v1/objects                          # list w/ filter[class], filter[tag], q, sort, page[cursor]
POST   /api/v1/search                           # QueryAST JSON or search string → ids + facets
# Classes & schemas
GET/POST /api/v1/classes · GET/PATCH/DELETE /api/v1/classes/{id}
GET/POST /api/v1/property-schemas · PATCH/DELETE …
GET/POST /api/v1/relation-schemas · PATCH/DELETE …
# Relations
GET    /api/v1/objects/{id}/relations?direction=out|in|both&type=
POST   /api/v1/relations                        # {source, type, target, properties?, position?}
PATCH  /api/v1/relations/{id}                   # properties only
DELETE /api/v1/relations/{id}
GET    /api/v1/objects/{id}/backlinks
# Collections & views
GET/POST /api/v1/collections · GET/PATCH/DELETE /api/v1/collections/{id}
POST   /api/v1/collections/{id}/members         # explicit membership add
DELETE /api/v1/collections/{id}/members/{objectId}
# Assets
POST   /api/v1/assets                           # multipart upload (CAS, dedup) → asset node
GET    /api/v1/assets/{id} · GET /api/v1/assets/{id}/content (Range)
POST   /api/v1/objects/{id}/assets              # attach existing asset to object
DELETE /api/v1/assets/{id}
# Annotations & citations
GET/POST /api/v1/annotations · PATCH/DELETE /api/v1/annotations/{id}
GET    /api/v1/objects/{id}/citations           # outgoing cites w/ locators
POST   /api/v1/citations                        # {document, work, locator?, prefix?, suffix?}
# Export/import (projections)
POST   /api/v1/exports                          # {format: bibtex|biblatex|csl-json|ris|markdown|json, query|ids}
POST   /api/v1/imports                          # format-dispatched (plugin importers)
# Meta
GET    /api/v1/operations?since=                # audit feed (actor, op, ts)
POST   /api/v1/transactions                     # atomic multi-mutation batch (single envelope batch, all-or-nothing validation)
```

**Cross-cutting design:**

- **Auth**: existing API keys (`X-API-Key`) with scopes; add granular scopes (`objects.read`, `objects.write`, `relations.write`, `assets.write`, `delete`, `admin`). JWT for first-party clients. (Scope names in §26.)
- **IDs**: UUIDv7 in paths; internal numeric ids never exposed (existing rule).
- **Errors**: existing envelope `{"error":{code,message,status}}`; add stable machine codes (`not_found`, `conflict`, `validation_failed`, `scope_denied`, `idempotency_replay`).
- **Pagination**: cursor-based (`page[after]`), consistent with relay catch-up style.
- **Idempotency**: `Idempotency-Key` header → op-id dedupe (relay already dedupes by envelope id; the API maps key→envelope id).
- **Concurrency**: mutations carry `base_revision` (optional) → 409 on mismatch; otherwise last-writer-wins per field semantics of the op log.
- **Deletion**: soft-delete default (`node.delete` → trash, 30-day retention), `?permanent=true` requires `delete` scope + `confirm` token; relations/annotations tombstoned; assets refcounted (file removed at 0 refs).
- **Versioning**: `/api/v1` frozen additive-only; breaking changes → `/api/v2` alongside. Relay protocol keeps its own `PROTOCOL_VERSION` discipline (SPEC §7).
- **Rate limits**: per-key buckets (existing `PerKeyBucketFactory`), documented per endpoint class.
- **Webhooks/events**: `POST /api/v1/webhook-endpoints` (§19/§23).

---

## 17. Target CLI

**New first-class client** (`notees`, Python to live beside the backend, or standalone — decision in §32 spike S7; consumes only the public HTTP API, never the DB):

```
notees object get <uuid> [--json] [--properties] [--content]
notees object create --class Book --name "…" [--property k=v]… [--json | --stdin]
notees object update <uuid> [--name …] [--property k=v]… [--content-file f]
notees object delete <uuid> [--permanent --yes]
notees object list [--class …] [--tag …] [--query 'class:Book AND year:<1950'] [--limit N] [--cursor …]
notees search "kuhn paradigm" [--json] [--class …]
notees relation create --source <id> --type authored-by --target <id> [--property k=v]…
notees relation list --object <id> [--direction in|out|both] [--type …]
notees relation delete <relation-id>
notees class list|create|schema …        # class & property-schema CRUD
notees collection create|list|add|remove|members …
notees asset add <file> [--attach <object-id>] [--json]
notees asset get <uuid> [--output f] · notees asset list [--missing-content]
notees tag add <object> <tag> · notees tag remove …
notees annotate <asset-id> --page 42 --quote "…" [--rect json] [--note <object-id>]
notees cite <document-id> --work <source-id> [--locator p.12] [--prefix …] [--suffix …]
notees export --format bibtex --query 'class:paper' --output refs.bib
notees import --format bibtex refs.bib [--dry-run]
notees sync status [--watch] · notees sync push|pull (for local-mode workspaces)
notees doctor                            # auth, server reachability, version compat
```

**Agent-ergonomics contract (hard requirements):** every command supports `--json` (stable schema, versioned); deterministic exit codes (0 ok, 1 domain error, 2 usage, 3 auth, 4 conflict, 5 network); no interactive prompts when `--yes`/`--json`/stdin-non-tty; destructive commands require `--yes` or fail with a preview of the blast radius (`--dry-run` prints the operations that *would* be emitted); stdin/stdout streaming for bulk ops; IDs printed on create (capture-friendly); global `--profile` (server URL + token) so agents use scoped keys, never user passwords.

---

## 18. AI/Coding Agent Interface

- **Credentials**: per-agent API keys with least-privilege scopes; keys are nameable/revocable/expiring (exists). Add `agent:<name>` key naming convention; every API mutation records `actor_id` = key owner and `client` claim (§14 provenance) → audit feed `GET /api/v1/operations`.
- **Safety rails**:
  - `--dry-run` on CLI and `dry_run: true` on API mutations → returns the exact operations that would be emitted, without persisting.
  - Soft-delete default; permanent delete behind `delete` scope + confirmation token.
  - Transactions (semantics precisely defined — review challenge B): `POST /api/v1/transactions` emits a mutation list as **one relay batch of N envelopes**. Guarantees: *atomic validation* (either every mutation validates — schemas, permissions, idempotency keys — and all N envelopes are appended, or none is); *causal grouping* (one batch, consecutive HLC ordering, applied consecutively on every replica); *no distributed-transaction semantics* (after acceptance each envelope converges independently under normal per-op rules; compensation is achieved by emitting inverse operations, never by unwinding history). "Transaction" here means *atomic admission*, matching the append-only log.
  - Idempotency keys for safe retries.
  - Read-only scope viable: `objects.read relations.read assets.read search` covers inspection workflows.
- **Discoverability**: `GET /api/v1/meta` → API version, op-type registry, class registry, relation schemas, feature flags; CLI `notees doctor` + self-describing `--help` per command. This lets an external agent learn the object model without DB access.
- **No direct DB access** is ever required: the Object API + relay catch-up expose everything the UI sees.

---

## 19. Target Plugin Architecture

**Decision: evolve the existing manifest system; add an out-of-process runtime as a second execution mode. Do not replace the in-process runtime (builtins depend on it; trust level differs).**

```
Manifest v2 = current v1 fields +
  api_version: 2
  runtime: "inprocess" | "subprocess"     # new
  permissions: [...current 10…, "relations.read", "relations.write",
                "annotations", "citations", "events.subscribe", "network"]
  contributes: + eventSubscriptions: [{event, handler}]
                relationSchemas: [...], objectClasses: [...]
```

- **Execution models**:
  1. *In-process* (current): kept for builtins and trusted local plugins. Permissions become **runtime-enforced capabilities**: the `WorkspaceStore` port handed to a plugin is wrapped by a permission-checking proxy (each emitter call checks the manifest permission set). This closes the current registration-time-only gap.
  2. *Subprocess (new)*: plugin = any-language process speaking JSON-RPC over stdio (or local socket). Host process (part of the server, and later the desktop client) brokers the **same public API surface** the CLI uses — plugins are API clients with an embedded token, not library code. This satisfies "plugin authors need not use Python" and gives OS-level isolation.
- **Contract**: plugins declare id/name/version/permissions/api_version/contributes (as today). Subprocess plugins receive: `{api_endpoint, token, workspace_id, event_stream}` at spawn.
- **Events (new, durable — review challenge D)**: strict separation of concepts — the **operation log is the authoritative mutation history**; the **event system is a delivery mechanism derived from it**. Nothing is ever written "as an event" into the log, and event consumers can never mutate state except by emitting ordinary operations. `object.created/updated/deleted`, `relation.created/deleted`, `asset.attached/removed`, `collection.updated`, `annotation.*`, `sync.completed` are **derived event projections** of op types (a small, versioned mapping table). Delivery: (a) in-process op listeners (existing, upgraded to typed events with per-plugin filtering), (b) webhook egress (`POST` to registered endpoints with HMAC signature, retry w/ backoff, at-least-once, event ids = op ids for idempotent consumers), (c) subprocess plugins get a filtered stream. Core behavior never depends on plugin success (listeners already swallow+log failures; webhook failures dead-letter). Event schema is versioned independently of op payloads, so payload evolution never breaks consumers.
- **Lifecycle**: install (zip/git/local, exists), enable/disable (exists), **trust prompt on first enable showing requested permissions** (new), update (exists for git), uninstall (exists). Distribution stays local/private — **no marketplace**; signed packages deferred until a registry exists.
- **Versioning**: `api_version` negotiated at spawn/load; additive-only within v2; the plugin host refuses `api_version` newer than itself (fail-loud, mirroring protocol discipline).

---

## 20. Target Search Architecture

Keep SQLite FTS (upgrade path FTS4→FTS5 where the driver allows — wa-sqlite vendored build currently FTS4; spike S5). Unified index build in the derived appliers:

| Source | Index target | Trigger |
|---|---|---|
| node name | `search_index` (existing) | node ops |
| node content text | `search_index` (existing) | content ops |
| property values (text-ish types: text, url, email, selection labels, numbers as text) | `search_index` (tagged rows or parallel `property_fts`) | property ops |
| class names / tag names | `search_index` | class ops |
| relation target titles + relation type names | `relation_fts` or join at query time | relation ops |
| asset original_name + mime + extracted text sidecar | `asset_fts` | asset ops + extraction jobs |
| citation fields (citekey, doi, isbn, authors via relation, title) | covered by property rows above | — |

Query semantics: existing text DSL (`app/domain/services/query_language.py`) extended: `text:`, `class:`, `tag:`, `prop:<name>:`, `author:`, `year:<`, `collection:`, `asset:`, `citekey:` — compiled by the **same** QueryAST compiler (both languages), so CLI/API/UI share one grammar. Ranking: keep TF-IDF for content; add field boosts (name^3 > properties > content). Extracted document text: background extraction pipeline (pypdf exists; EPUB via `notees.epub`) writing sidecars + `asset_fts`, **never** blocking sync.

---

## 21. Target Citation Architecture

- **Model**: `cites` relation schema (§14). Documents = any classed node; works = `source` descendants. `citationKey` stays a `citekey` property (exists).
- **Interchange projections** (exporter plugins, not core storage):
  - **CSL-JSON** as the canonical interchange object: map `source` tree + bibliographic property schemas → CSL types (`book`, `article-journal`, `thesis`, `paper-conference`…); agents via `authored-by` relations → `author` arrays (family/given split from person node name — spike S4 validates real-world data quality).
  - **BibTeX/BibLaTeX export** from CSL-JSON via a citeproc library (new dependency, e.g. `citeproc-py` — evaluate; else write a focused serializer: the BibTeX import mapping already defines the inverse).
  - **RIS export**: trivial mapping from CSL-JSON.
- **Round-trip guarantee**: BibTeX import → object graph → BibTeX export must be field-stable for the mapped subset (test fixture with real `.bib` samples — extends `tests/unit/plugins/builtin/bibtex`).
- **Rendering**: citation render pipeline = `cites` relations of a document → CSL-JSON → citeproc with a CSL style (start: `chicago-author-date`, `apa`) → HTML/Markdown/Pandoc-ready output; powers (a) bibliography sections in exports (exists as export options), (b) future Word/LaTeX plugins, (c) "where is this source used?" via relation backlinks (free from `edge` projection).
- **Citation counts**: `node_stats` extension or query-time aggregation over `relation` (cheap with `idx_relation_target`).

---

## 22. Target Local-First Architecture

Already the architecture. Target-state deltas:

- Web: unchanged (OPFS worker store, leader-tab model, local mode).
- Desktop/mobile: sibling clients already speak the protocol; they gain the same new op types (relation/annotation) — protocol additions are additive, no version bump, but all three repos must ship support (SPEC §3 rule).
- New client-side tables (relation, annotation indexes, device asset cache) ride the existing `derived_state_version` rebuild mechanism.
- **Offline capability is already total** for graph ops; the remaining offline gap is asset *bytes* (§24).

---

## 23. Target Synchronization Architecture

**Keep the existing model — it already implements the target's requirements:**

- Operation-based sync with idempotent ingest (op-id dedupe), server-assigned `seq` ordering, HLC causality metadata, per-device clocks.
- Conflict semantics: Yjs CRDT for text/tree; per-field LWW (HLC); OR-Set for class membership; explicit conflict detection (`move_move`, `node_deleted`, `class_conflict`, `property_conflict`) + user-facing resolution modal. **Add**: `relation_conflict` (concurrent update of same relation's properties → LWW on properties; concurrent delete/update → surface), `annotation_conflict` (treat like property LWW).
- New op types (`relation.*`, `annotation.*`) are additive per SPEC §3; rollout = backend + web + Flutter + GTK in lockstep (the repo already operates this way — see GTK protocol commits). Device-local concerns (asset pinning, cache state) are deliberately **not** op types (§14 semantic/device rule, §24).
- No CRDT expansion is warranted: relations/annotations are scalar-ish data where LWW + tombstones + explicit conflicts are the right semantics (this matches the "no CRDT-everywhere" judgment in the rewrite opinion — the current system already made that call).

---

## 24. Target Asset Synchronization

- **Metadata** (`node_asset`, asset nodes) syncs via the op log today.
- **Bytes** today: full library on every client; download via asset tokens + Range.
- Target: per-device availability policies. **Decision (review challenge C, resolved per §14's semantic/device rule): pinning is device-local state, NOT an operation.** The op log is shared semantic state; "keep this PDF offline on my phone" is a preference of one device, not collaborative knowledge. Therefore:
  - Client-side table `device_asset(asset_hash PK, state: pinned|cached|evictable, last_access, bytes)` — local only, never synced.
  - Cross-device pinning *preferences* ("pin books everywhere") are ordinary user settings (`setting_user`, existing sync path), which client policy engines read on each device. **No `asset.pin` op types are introduced** — this removes the shared-log/device-state mixing risk entirely and keeps Phase 6 client-side + server-download only.
  - Client policy engine: pin rules (class=book → pin cover+epub; PDFs on-demand), LRU eviction of `evictable` under a byte budget, resumable Range downloads (exists server-side), checksum verify on download (CAS hash = integrity).
  - Server-side: no change (bytes already served on demand with auth); optional `GET /api/v1/assets?content_state=missing` for reconciliation.
- This is additive; no migration.

---

## 25. Target Client Architecture

- **Web**: primary; gains object-first UX (object detail pages, relation editors, annotation layers, bibliography views) as **new projections over the same worker store** — no new data path. Views registry gains folder/gallery/bibliography modes.
- **Desktop**: GTK client (sibling) continues; gains new op-type support per release train. (A Tauri client is *not* justified: it would be a third desktop implementation of an already-served surface.)
- **Mobile**: Flutter client continues; benefits most from selective asset sync (§24).
- **Editor**: keep the custom editor + AST (it is the sync payload and supports atomic `node_link`/`annotation_ref`/`citation_ref` pills natively — the exact "references as real entities" property the rewrite opinion wants from Tiptap, already achieved). ProseMirror migration is **not** recommended (high churn, no new capability; revisit only if the editor blocks annotation UX).

---

## 26. Security Architecture

- **AuthN**: unchanged (bcrypt, JWT rotation, TOTP, API keys).
- **AuthZ**: workspace roles (exists) + node shares (exists) + **scope expansion** for the object API: `objects.read`, `objects.write`, `objects.delete`, `relations.read`, `relations.write`, `assets.read`, `assets.write`, `annotations`, `citations`, `collections.write`, `search`, `export`, `admin`. API keys carry a scope subset; `RequireScope`-style enforcement at the router (exists) + capability proxy for plugins (new, §19).
- **Agent safety**: audit feed (op log is the audit log; expose read API), dry-run, transactions, idempotency (§18).
- **Plugin isolation**: in-process = trusted (admin-installed only, as today); subprocess = capability-brokered, least-privilege by manifest; network permission explicit; no filesystem permission in v2 (file access only via asset API) — *tightens* the current model where in-process plugins implicitly have host FS access.
- **Asset access**: asset tokens (exist) + share scoping (exists); Range downloads authenticated.
- **Sync authorization**: unchanged (workspace membership is the boundary; SPEC §9).
- **Backups**: pg_dump schedule (exists) + snapshot/compaction (exists) + documented restore drill (new runbook); E2EE recovery via passphrase blob (exists).

---

## 27. Migration Strategy (current → target)

The op log is forward-compatible: **new op types and new derived tables require no data migration of existing content** — old workspaces simply never emitted `relation.*` ops. Required migrations are therefore few and mechanical:

1. **Schema**: add derived tables (`relation*`, annotation indexes, `device_asset`); bump derived-state version → automatic rebuild from op log on server and clients (mechanism exists).
2. **Relation backfill** (optional, user-triggered per workspace): node-typed properties declared as relations in class schemas → emit `relation.create` ops; keep the property as the authoring surface until cutover, then hide it (schema flag), never delete data.
3. **Tag formalization**: finish stripping legacy `tag_ids` (migration precedent: `strip_page_class_from_class_ids.py` — same pattern: rewrite derived DB + emit corrective ops).
4. **Bibliography**: no migration; BibTeX re-import is idempotent by citekey (exists).
5. **Search**: index rebuild from op log (derived); extraction sidecars backfilled by background jobs.
6. **Asset availability**: default policy `cached` with existing full libraries treated as pinned-once; no file moves.
7. **Rollback**: every migration is op-log-additive; rollback = redeploy previous version (old appliers ignore unknown op types — they must be verified to *skip*, not crash: add a conformance test).
8. **Verification**: extend `scripts/validate_migration.py`-style reconciliation (derived counts, orphan ops) with relation/annotation invariants; backup before enabling (existing scheduler).

---

## 28. Phased Implementation Plan

> **Superseded as the active plan by the greenfield decision (§34, Revision 3).** Retained as the considered evolution alternative — its phase ordering, hard-gate protocol discipline, fixtures-first rule, and Relation Semantics Specification are carried into the greenfield milestones unchanged in spirit.

Sequencing principle: **protocol and storage first, then API, then CLI, then UX, then plugin runtime** — each phase lands additive, independently releasable, and leaves the app fully working.

### Phase 0 — Foundations & hygiene (**hard gate** — no op-set changes before this is complete)
- Objective: make protocol evolution safe. Once `relation.*` / `annotation.*` exist, the blast radius is backend + web + Flutter + GTK; protocol testing stops being hygiene and becomes **architecture protection**.
- Work:
  - CI workflow running ruff + mypy + pytest + vitest + typecheck on every PR (none exists today — the release workflow currently pushes images without running tests).
  - Fix `scripts/admin_compact.py` signature bug (`key_storage` kwarg, confirmed broken); delete stale `koreader` pyc dir; remove the dead SSE/collab_pubsub path (no publishers) in favor of the §19 event system; update stale docs (`docs/plugins.md` builtin list, `docs/CHANGELOG.md` bibliography omission, `sql.py` VERSION comment).
  - **Elevate protocol fixtures to first-class artifacts**: every op type (existing and future) has canonical envelopes in `protocol/fixtures/` with fixtures asserting *identical derived state* across backend appliers, web appliers, and (via the sibling repos' CI) Flutter/GTK appliers. Fixtures are written **before or with** the implementation of any new op type; an op type without fixtures is not done.
  - **Compatibility matrix** (documented in `protocol/SPEC.md`, tested in CI): old client + new server, new client + old server, new client + new server — each cell has explicit, tested behavior (old clients must *skip* unknown op types without crashing; new clients fail loud only on newer `protocolVersion`).
- Exit criteria: green blocking CI on PR (lint, typecheck, unit, convergence, fixtures, compatibility matrix); repo lint-clean; no dormant endpoints.
- Risk: Low. Effort: S.

### Phase 1 — Relations core (the pivotal phase)
- **Entry criterion (review challenge A): the Relation Semantics Specification (`protocol/RELATIONS.md`, §14) is written and reviewed — including canonical fixtures — before any implementation code.** Relations are additive to storage but not small: identity, deletion, concurrency, inverse traversal, ordering, schema evolution, permissions, backlinks, queries, UI, citations, and annotations all depend on these decisions.
- Objective: first-class typed relations end-to-end through the op log.
- DB: `relation`, `relation_tombstone`, `relation_schema` in both derived schemas; `edge` projection includes `type='relation'`.
- API: relation-schema CRUD (extend agents API first for dogfooding).
- Protocol: `relationSchema.create/update/delete`, `relation.create/update/delete` op types; `KNOWN_OP_TYPES` + `REQUIRED_PAYLOAD_FIELDS`; **fixtures in `protocol/fixtures/`**; Flutter/GTK notified (spec additive).
- Clients: TS appliers + compiler conditions (`relation`, `relation_path`); relation section UI on object pages (out/in, add/remove); QueryAST builder support.
- Migration: none (additive). Optional property→relation backfill tool (script + UI action).
- Tests: applier parity (both languages), convergence (relation LWW/tombstone), compiler parity, fixtures conformance, e2e add-relation flow.
- Exit criteria: two offline clients create conflicting relations → converge; backlinks show relations; 100k-relation seed query p95 < 100 ms (§30 budget).
- Risk: **High** (op-set change, 3 client repos) — mitigated by additive-only rule + fixtures.

### Phase 2 — Object API + agent hardening
- Objective: the complete machine API.
- Work: promote agents API → `/api/v1` object surface (§16); granular scopes; `Idempotency-Key`; `base_revision` conflicts; transactions endpoint; `GET /api/v1/meta` (self-describing registry); audit feed endpoint; OpenAPI published as the contract (FastAPI gives it; freeze with a diff-check CI gate).
- CLI: **deliver `notees` CLI v1** (object/relation/collection/asset/tag/search/export/import/doctor; JSON everywhere; dry-run; exit codes) — Python package shipped in the server image + standalone.
- Tests: API contract tests (schemathesis or equivalent), CLI golden-output tests, scope-enforcement matrix, idempotency/conflict tests.
- Exit criteria: an external agent can run the §18 workflow using only docs + API; CLI/API parity checklist green.
- Risk: Medium.

### Phase 3 — Search unification
- Objective: §20 index sources + grammar.
- Work: property/class/relation/asset/citation FTS; field-boosted ranking; query-language operators; extracted-text pipeline (pypdf + EPUB) with sidecars; FTS5 evaluation spike (S5).
- Tests: index-rebuild determinism, ranking fixtures, perf on 100k-object synthetic corpus.
- Risk: Medium (index bloat in browser storage — measure; mitigation: per-source opt-out settings).

### Phase 4 — Bibliography & citations
- Objective: round-trip scholarly interchange + citation relations.
- Work: CSL-JSON mapping (source tree ↔ CSL), BibTeX/BibLaTeX/RIS exporters (plugin), `cites` relation schema + citation endpoints + CLI, citeproc rendering pipeline, bibliography/gallery view modes, round-trip fixture tests.
- Depends on: Phase 1 (relations), Phase 2 (API).
- Risk: Medium (real-world BibTeX dialects — spike S4).

### Phase 5 — Annotations
- Objective: annotation objects on assets.
- Work: `annotation` class family + property schemas; `annotation_ref` AST node; PDF page/rect anchoring (spike S6: text-layer coordinate mapping); annotation layer UI (list + click-to-scroll); annotation API/CLI; `annotates`/`supports` relations.
- Risk: Medium-High (PDF UX is the hard part, not the model).

### Phase 6 — Selective asset sync
- Objective: §24 per-device pinning/caching/eviction.
- Work: client-local `device_asset` cache manager (pinned/cached/evictable, LRU eviction, resumable downloads — §24); pin-rule policy UI; cross-device pin *preferences* via ordinary user settings. **No new op types** — device state stays out of the shared log.
- Risk: Medium.

### Phase 7 — Plugin runtime v2 + events
- Objective: §19 subprocess runtime, capability proxy, event projections, webhooks.
- Work: permission-enforcing `WorkspaceStore` proxy; JSON-RPC subprocess host; event projection table + subscription registry; webhook egress w/ retries; trust prompt UI.
- Risk: High (isolation correctness) — spike S3 first.

### Phase 8 — Collections generalization + view expansion
- Objective: workspace-level collections (saved-query + explicit membership), folder/gallery views, object-first library UX.
- Risk: Low-Medium.

Ongoing: protocol docs (`protocol/SPEC.md`), `docs/api.md`, `docs/plugins.md`, `skills/notees/` updates per change; GTK/Flutter release-train coordination.

---

## 29. Testing Strategy

- **Unit**: appliers (both languages, parity fixtures), compilers, citekey/CSL mappings, CLI command handlers (golden JSON).
- **Integration/convergence**: extend `tests/core/test_relay_convergence.py` + `test_relay_offline_reconnect.py` with relation/annotation/asset-pin scenarios; **property-based invariants** (new; the rewrite opinion's suggestion is apt): op-log replay determinism, relation tombstone convergence, commute of independent-property mutations.
- **Protocol conformance**: `protocol/fixtures/` extended per new op type (fixtures are first-class artifacts, written with the implementation — Phase 0); both storage adapters; fail-loud version rules; **compatibility matrix** (old/new client × old/new server) tested in CI; cross-applier derived-state equality asserted from the same fixtures.
- **Migration**: reconciliation reports (`app/core/migration/validation.py`) extended with new-table invariants; rollback drill test.
- **API contract**: OpenAPI diff gate in CI (breaking change fails the build); schemathesis fuzz on `/api/v1`.
- **CLI**: golden stdout/stderr + exit codes per command; dry-run asserts zero mutations.
- **Plugin**: manifest validation, capability-proxy denial tests (permission matrix), subprocess host lifecycle, webhook retry/dead-letter.
- **Client**: vitest for appliers/queries; Playwright e2e expanded from 3 specs to cover: offline create→online converge, relation editing, citation insertion, asset pin/unpin.
- **CI**: make all of the above blocking (today: nothing runs in CI).

---

## 30. Performance Strategy

Targets: 100k objects, 100k+ relations, millions of content fragments, 10k+ assets, hundreds of GB, multiple clients.

- **SQLite scale**: 100k nodes/edges is routine; recursive CTEs already used for trees/paths. Indexes: `relation(source_id, schema)`, `relation(target_id, schema)` mirror `edge` indexes; closure table for `relation_path` conditions if path queries emerge (else recursive CTE with depth cap).
- **Sync bandwidth**: envelopes are JSON; relations/annotations are small; snapshots bound catch-up cost; compaction exists. Initial sync = snapshot + tail (exists).
- **Client storage**: OPFS quota is the binding constraint — measure with synthetic 100k corpus (spike S2); mitigations: snapshot-first hydration, per-source FTS opt-outs, asset bytes out of SQLite (already).
- **Search**: FTS index size ~1× text size; ranking bounded to top-100 matchinfo scoring (exists); property/asset FTS adds ~30–50% index growth (measure in S2).
- **Asset transfer**: Range + CAS verify; pinning avoids re-download; eviction keeps mobile storage bounded.
- **Known bottlenecks to fix en route**: `LOCAL_QUERY_RESULT_LIMIT = 500` caps; no virtualization in several list views (block tree has it); `HydrateLinkedReferencesQuery` per-id projection; in-memory export/job registries (single-process).

---

## 31. Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Op-set change (relations) diverges across 3 client repos | **High** | additive-only rule, fixtures, release-train coordination, fail-loud version checks |
| R2 | Dual applier/compiler drift (Python↔TS) | **High** | parity test suite (exists, extend), codegen evaluation (spike S1) |
| R3 | Plugin subprocess isolation bugs → data exposure | **High** | capability broker, permission-proxy denial tests, trust prompts, no FS permission |
| R4 | Browser storage exhaustion at scale | Medium-High | S2 measurement, opt-outs, snapshot-first |
| R5 | Annotation PDF anchoring UX quality | Medium | spike S6 before committing Phase 5 |
| R6 | CSL/BibTeX real-world dialect breakage | Medium | round-trip fixtures, permissive import (exists), export-from-canonical-CSL only |
| R7 | Scope creep into excluded features (AI assistants etc.) | Medium | phase gates; review board = this document |
| R8 | In-memory job registries (export/plugin install) break multi-worker | Medium | move to DB-backed jobs during Phase 2 |
| R9 | Legacy tag/property transitional states confuse migration | Low-Medium | finish formalization migrations; reconciliation tooling exists |
| R10 | No CI today → regressions ship | Medium | Phase 0 |

---

## 32. Technical Spikes (before committing the corresponding phase)

| Spike | Question | Feeds |
|---|---|---|
| S1 | Can op payloads/applier tables be **code-generated** from one schema definition (`protocol/`), replacing hand-kept Python↔TS parity? | R2, all protocol work |
| S2 | Synthetic 100k-object/100k-relation corpus: OPFS size, query p95, FTS index growth, snapshot restore time, catch-up bandwidth | §30, R4 |
| S3 | Subprocess plugin host: JSON-RPC capability broker prototype; measure call overhead; threat-model | Phase 7, R3 |
| S4 | BibTeX round-trip on 50 real-world `.bib` files (dialects, Unicode, nested braces) → CSL-JSON stability report | Phase 4, R6 |
| S5 | FTS5 vs FTS4 under wa-sqlite: index size, `matchinfo` availability, ranking quality | Phase 3 |
| S6 | PDF annotation anchoring: text-layer coordinate extraction stability across viewers/scans; quote-reanchor-on-edit strategy | Phase 5, R5 |
| S7 | CLI implementation language/packaging (Python in-repo vs standalone binary) against agent-ergonomics contract | Phase 2 |
| S8 | Relation conflict semantics: formalize LWW/tombstone rules; property-based convergence harness | Phase 1, R1 |

---

## 33. Final Recommendation (original — superseded by the greenfield decision, §34)

> **Revision 3:** the recommendation below was written under the assumption that Notees had users and deployments to protect. The owner confirmed on 2026-09-24 that Notees is pre-adoption with a single user, and chose the greenfield track. This section is retained unchanged as the decision record's counter-argument — the evidence it cites is what the greenfield plan must respect (ported semantics, ported test corpus, no reinvention of solved problems).

**Evolve. Specifically:**

- **Keep** (they are the target architecture already): the operation log + relay protocol, HLC/seq sync, snapshots/compaction/E2EE, derived SQLite on both tiers, the class/property/tag/collection model, content-addressed assets, the auth/API-key foundation, the plugin manifest system, all three clients, the migration/reconciliation tooling.
- **Refactor/complete** (additive, in phase order): relations as first-class ops → complete object API + CLI → unified search → bibliography/citation round-trip → annotations → selective asset sync → plugin runtime v2 + events → collections/views generalization.
- **Replace** (small, surgical): dead SSE collab path with the real event system; in-memory job registries with DB-backed ones; the broken `admin_compact.py`; stale docs.
- **Do not do now**: a full rewrite; a graph database; CRDT expansion beyond text/tree; a plugin marketplace; a ProseMirror editor migration; a Tauri client. Each is either already-solved here or buys nothing the op-log architecture doesn't already provide. The rewrite proposal's *specific* good ideas — CLI-first, out-of-process plugins, contract codegen, FTS5, selective assets — are adopted as spikes/phases above. The rewrite itself is kept as a **formal tracked option**: §34 defines the greenfield track, shows it converges on the same core architecture, and pre-registers the activation triggers (dual-applier drift unmanageable + codegen spike failure; repeated cross-client protocol failures; maintenance cost of transitional states exceeding reimplementation cost; a checkpoint review after Phase 1 lands). Those triggers are not met today.
- **First implementation milestone (start Phase 1 immediately after Phase 0):** first-class relations through the operation log, dogfooded via the extended agents API — because relations are the load-bearing concept for citations, annotations, collections, and the entire scholarly model, and every later phase depends on them.

---

## 34. The Greenfield Rewrite — Activated Plan (Decision Record, 2026-09-24)

### 34.1 Decision and locked choices

The owner decided to pursue the **full greenfield rewrite** over the evolution track (§28). The decisive context: Notees is **pre-adoption and the owner is its only user**, which removes the user-migration, data-compatibility, and multi-client-coordination costs that carried the original evolve recommendation. The greenfield architecture review independently converged on the same core architecture Notees already has — so this rewrite is a **reimplementation with corrected priorities**, not an architecture change. That is what makes it a sound bet rather than a gamble.

Locked decisions (owner-confirmed 2026-09-24):

| # | Decision | Choice |
|---|---|---|
| D1 | Track | **Greenfield rewrite.** New codebase; current repo enters maintenance mode and remains the owner's daily driver until M1 reaches parity for their usage. |
| D2 | Stack | **TypeScript everywhere** (pnpm monorepo). Rationale in §34.2. |
| D3 | Protocol | **Clean break on encoding; preserved semantics.** Wire format redesigned; sync correctness invariants carried over untouched (§34.4). |
| D4 | Content model | **AST retained.** The content AST (with atomic `node_link` / future `annotation_ref` / `citation_ref`) remains the content + sync payload. Editor *implementation* deferred: port the existing custom editor initially; Tiptap/ProseMirror stays a future swap behind the same AST interface. |
| D5 | Scope | **Staged milestones M1 → M2 → M3** (§34.6). Architecture prepares for later milestones (envelope encryption slot, plugin-host interface) without building them early. |

### 34.2 Stack evaluation record (D2)

| Criterion | TypeScript (chosen) | Rust | Python + TS |
|---|---|---|---|
| Reuse of battle-tested code | **High** — the current system's best half is already TS (`frontend/src/core/`: SyncEngine, appliers, QueryAST compiler, E2EE, HLC clock) and ports nearly verbatim | None — full re-derivation of CRDT/sync behavior | Partial — backend only |
| Dual-implementation tax (audit's #1 defect) | **Eliminated** — one implementation runs in Node and browser | Kept (Rust core + TS web), or wasm friction | Kept — the problem the rewrite exists to fix |
| AI-agent iteration velocity | **Highest** (largest training corpus, no compile-cycle penalty) | Lower (compile-error churn, smaller corpus) | High |
| Web client | TS regardless | TS regardless (+wasm bridge cost) | TS |
| Performance headroom | Ample at target scale (SQLite is the bottleneck in any language) | Highest — **not needed** at 100k objects, single user | Ample |
| Plugin/extension ecosystem (M3) | Rich (npm), subprocess host in any language | Thinnest | Rich |

Rust's advantages are real but answer a performance/correctness problem this product does not have; the binding constraint is solo iteration velocity with AI-authored code, plus maximal reuse of the proven TS core. Python split preserves the exact structural defect that motivated the clean slate.

### 34.3 Monorepo layout

```
notees/
├── apps/
│   ├── server/          # Node 22 + Fastify 5: relay (HTTP/WS), object API v1, auth, asset CAS
│   ├── web/             # React 19 + Vite SPA — descendant of the current frontend, slimmed
│   └── cli/             # `notees` CLI — typed api-client only, never DB access
├── packages/
│   ├── domain/          # object/class/property/relation model, validation, citekey logic (pure TS, zero IO)
│   ├── protocol/        # op envelopes v2, op-type registry, zod codecs, HLC, canonical fixtures
│   ├── store/           # derived-store: SQLite schema+migrations, op appliers; adapters:
│   │                    #   better-sqlite3 (server/CLI) and wa-sqlite/OPFS (browser worker)
│   ├── sync/            # SyncEngine: outbox, push/pull, seq cursor, conflict detection (port of sync.ts)
│   ├── query/           # QueryAST v2 model + SQLite compiler (port of compileToSqlite.ts)
│   ├── search/          # FTS index build + ranking over the derived store
│   ├── editor/          # content AST, serialization, (ported) custom inline editor
│   ├── api-client/      # typed client for the object API (used by CLI, web, future plugins)
│   └── plugin-sdk/      # M3: manifest, capability client, event stream types
└── tooling/             # shared tsconfig, eslint, vitest, changesets
```

Key structural property: **`packages/store` + `packages/sync` + `packages/query` are the single implementation of the derived-state and sync semantics**, executed in three runtimes (server Node, browser worker, CLI). The current repo's hand-kept Python↔TS parity problem cannot recur by construction.

Server persistence: **SQLite by default** (relay log + per-workspace derived DBs, single-file, trivially backed up — the greenfield review's "the user's primary database belongs to them"), with a PostgreSQL relay adapter as a documented later option for multi-user hosting. Auth for M1: **single-user API-key model** (the owner); multi-user (registration, invites, roles, shares) is pre-adoption scope landing in M3.

### 34.4 Protocol v2 — clean break on encoding, preserved semantics

**Clean break — what gets fixed** (warts catalogued in the audit):

1. One casing convention end-to-end (camelCase on the wire; no envelope-vs-body split).
2. One content carrier: the CRDT delta is canonical; plaintext mirrors are derived server-side (in TS-everywhere the server has the same Yjs stack — the dual `content` + `textUpdateB64` carriers of v1 exist only because Python servers couldn't merge).
3. Ordering made single-purpose: server-assigned `seq` is the only ordering authority; HLC is documented purely as causality metadata (v1 carried both without saying this clearly).
4. Envelope gains first-class `deviceId` and `client` claims (agent/CLI provenance from day one) and an **encryption slot** (`payload` MAY be `{"$e": …}` ciphertext from M3 — the slot exists from M1 so E2EE never requires a protocol break).
5. Op-type registry is namespaced by domain: `object.*`, `class.*`, `propertySchema.*`, `property.set/unset`, `collection.*`, `asset.*` — plus content ops carrying typed-link marks. **There are no `relation.*` ops** (Revision 7): associations are node-typed property values or typed-link word marks in content; the derived edge index is built by appliers, never by a relation op type. No seeded relation vocabulary (design law).
6. Snapshots/compaction redesigned as a simple "derived-state checkpoint" download/upload with seq watermark — one flow, not three endpoints with divergent auth.

**Preserved semantics — the correctness invariants** (these are why the current system works; they are design law for v2):

- Idempotent ingest: op-id dedupe, retry-safe submission.
- Server-assigned total ordering per relay; catch-up is `seq > cursor` paging; live WS is an acceleration path only.
- Conflict model: LWW (HLC) for scalar fields; OR-Set add-wins for set membership; CRDT (Yjs) **only** for collaborative text/tree; relations = identified object + tombstone + LWW properties; explicit conflict detection + user surfacing for the rest. No CRDT-everywhere.
- Tombstones for deletions; restore-epoch wipe semantics after server restores.
- Trust model: workspace membership is the security boundary; client-supplied routing metadata is best-effort.

**Fixtures-first discipline (kept from the §28 hard gate, now cheap):** every op type ships with canonical fixtures asserting identical derived state — and because there is one TS implementation, the "cross-implementation equality" test is the same code run under Node and the browser, not two hand-synced ports. The v1 fixture corpus is re-encoded to v2 as the seed of the acceptance suite.

### 34.5 What carries over from the current repository (brownfield assets)

| Asset | Source | Use in greenfield |
|---|---|---|
| SyncEngine, WorkspaceStore, derived appliers, HLC clock, QueryAST compiler, E2EE, seed logic | `frontend/src/core/` (TS) | Ported into `packages/sync`, `store`, `query` — the starting core, already proven |
| Protocol fixtures + convergence/offline-reconnect/restore-epoch test scenarios | `protocol/fixtures/`, `tests/core/` | Re-encoded to v2; the acceptance specification |
| Content AST + custom editor | `frontend/src/types/ast.ts`, `features/editor/` | Retained as data model and initial editor (D4) |
| System classes / property schemas / class hierarchy seed data | `app/domain/entities/constants.py`, `frontend/src/core/seed.ts` | Ported to `packages/domain` seeds |
| Sync semantics knowledge | `protocol/SPEC.md` | Rewritten as protocol v2 spec with the invariant list of §34.4 |
| Domain documentation | this assessment §§3–13 | The domain spec for the new implementation |
| User data | old workspace export (JSON dump) | **One-off migration script to v2 ops, built in month 1–2 of M1** (§34.6) — sole user, so this is a script, not a product feature; it doubles as the data-model acceptance test |

Explicitly **not** carried: the Python backend, the page/block node-kind doctrine (replaced by relation-first object modeling), per-node `node_view` (replaced by workspace-level collections), the plugin system implementation (redesigned in M3 around a capability broker), the custom auth stack (M1 single-user keys; multi-user in M3).

### 34.6 Milestones

**M1 — "the core is the product"** (timeline: **provisional** — the 3–5 month figure is a hope, not a plan; every greenfield rewrite runs long, and "AI-driven" accelerates boilerplate but not semantic decisions. **The exit criteria are the plan.**) — *scope per the 2026-09-25 model (`01` §16): M1 adds columns, tokens, and an editor; no new sync primitive.*
- **First artifact (before any other code):** `packages/protocol/SCHEMA.md` — the property-schema, class-structure, and typed-link token spec (owed-work register), including the record-don't-resolve rule for candidate target spans. (`RELATIONS.md` was retired when relation entities were deleted — Revision 7.)
- Scope: `protocol` (v2 + fixtures); `domain` (single `node` table with `node_type ∈ {page, block, class}` — schema-CHECKed, no `kind` column, placement only in `parent_id`; classes declared via `node_type='class'`; `extends` as m2m node-typed property + derived closure; property registry + m2o/m2m values with per-value `metadata`); `store`, `sync`, `query`, `search` (unified FTS); **edge index with backlink roll-up and `refset` filter inheritance**; typed-link verb marks (record-don't-resolve; resolution deferred); `apps/server` (relay + object API v1 + CAS assets); `apps/web` (Logseq-style outliner editor — bullets, TreeCrdt reparent/reorder ported); `apps/cli` (object/property/collection/asset/search surface with the §17 agent contract, adjusted per Revision 7: no relation endpoints — edges are derived read-only).
- **Editor: fallback redefined by the 2026-09-25 model.** The outliner authors two of the three information layers, so the old "plain-text AST" fallback is void — the fallback shape is now "**outliner without verb marks**" (marks defer; blocks and properties still carry M1). The editor carries ported v1 machinery (TreeCrdt, fractional positions, op envelope), so the risk is integration and polish, not research — but M1's schedule risk relocated here from relations, and the carried-risk list owns it (`00-INDEX`).
- **Migration script: built in month 1–2, not at the end.** Written against the owner's real workspace export, it is the acceptance test that the new data model *understands the old one* — exposing data-model mistakes while they are cheap, instead of becoming a gate that can fail catastrophically late. Same logic as fixtures-first.
- **Exit criteria (blocking, non-negotiable):** the ported fixture + convergence corpus (re-encoded to v2) is green — *this gate must never degrade to nice-to-have, or the rewrite becomes exactly what §33 warned against: re-deriving solved problems with less certainty than the original*; the migration script imports the owner's real data with a reconciliation report (counts, orphans, spot-checks); the owner uses M1 daily.

**M2 — "research environment"** (timeline: provisional, same rule as M1)
Scope: typed-link target resolution (designed against the recorded candidate spans — record-don't-resolve pays off here); citations pipeline (verb marks + locators + CSL-JSON/BibTeX/RIS round-trip, spike S4 first); annotations on assets (spike S6); selective asset sync (device-local state per the semantic/device rule); workspace-level collections + folder/gallery/bibliography views; full editor polish; multi-user auth foundation (registration, roles).
Exit criteria: BibTeX round-trip stable on the owner's real library; PDF annotation usable.

**M3 — "trust & extension"** (timeline: provisional, same rule as M1)
Scope: E2EE (envelope encryption slot activated; port `e2ee.ts` semantics), plugin runtime (capability broker, subprocess host, manifest v2 — informed by the current `app/plugins/core` design), event projections + webhooks, mobile/desktop client evaluation.
Exit criteria: an untrusted third-party plugin runs in a subprocess with scoped capabilities; an E2EE workspace round-trips between two devices; **adoption-readiness review** (multi-user hardening, backups, docs) before any second user.

### 34.7 Greenfield-specific risks

| Risk | Mitigation |
|---|---|
| Re-deriving sync invariants incorrectly | Ported fixture/convergence corpus as acceptance gate; §34.4 invariant list is design law; M1 exit requires the old test scenarios green |
| Solo stall / never shipping | M1 is small and daily-usable; M-gates are hard scope boundaries; the old app remains the daily driver throughout |
| Scope creep back into "everything at once" | D5 staged milestones; anything not in the current M is a written proposal, not code |
| Editor port drags | Fallback redefined by the 2026-09-25 model (§34.6): "outliner without verb marks"; the editor carries ported v1 machinery (TreeCrdt, fractional positions), so the risk is integration/polish, not research — but M1's schedule risk now lives here and in the edge index |
| Fixture/convergence gate erodes to nice-to-have | **Non-negotiable M1 exit criterion** (§34.6): if the corpus isn't green, M1 isn't done — and per Revision 7 the gate must not shrink: the deleted relation fixtures were replaced by typed-link-mark fixtures exercising the same acceptance scenarios (typed association with locator; mark dies with its word; concurrent-write convergence via property LWW) |
| Second-user adoption before M3 hardening | M3 ends with an explicit adoption-readiness review; until then the product is single-user by design |

### 34.8 Status of the current repository

Maintenance mode: it remains the owner's daily driver and the reference implementation of the semantics being ported. It receives no new features. It is retired when M1's migration script has imported the owner's data and M1 has been daily-driven for a soak period (suggest: 4 weeks). The repository is never deleted — it is the semantic reference and the test-corpus donor.

### 34.9 Model re-convergence (2026-09-25)

After the greenfield decision, a two-day owner–architect design session re-converged the *knowledge model* (the plan's substrate decisions were untouched). The converged design stack is imported into the repository at `v2/.plans/design/`:

- **`00-INDEX.md`** — normativity index: settled constraints, deferred items, risks, and the **precedence rule**: `01-knowledge-model.md` is normative for the model; this plan is normative for process, milestones, and gates.
- **`01-knowledge-model.md`** — the model: one node table for every entity; five storage categories (entities / configuration registry / assertions / derived / infra); three orthogonal axes (class, parent, `node_type`); classes-as-nodes with `extends` as m2m node-typed property; the outliner block model; three information layers over one edge index; the design law (predictions become defaults/lints/views, never prohibitions); milestone tiers.
- **`02-model-assessment.md`** — decision history: the v1 class-split post-mortem; the 2026-09-25 relations rethink (relation entities deleted); confidence ledger; owed-work list.
- **`03-paradigm-assessment.md`** — external validation vs Obsidian / Logseq 2.0 DB / Capacities / Tana (verified 2026-09-25), the five bets no competitor makes, wounds→rules, and the feature matrix/copy-list for frontend planning.

**Material deltas vs this plan (assessed and accepted 2026-09-25):**

1. **Relation entities deleted.** The plan's pivotal Phase-1/RELATIONS.md work is replaced by three information layers — node-typed properties (m2o/m2m, v1-proven machinery + one `metadata` column), typed-link marks on prose words (verb = schema ref or free string; nothing inserted), plain prose — feeding one derived edge index. This deletes the plan's highest-rated risk (a new sync primitive touching everything downstream) by construction. Coverage was verified: every seeded relation schema from §14 maps to a new-model home (`authored-by`/`published-by`/`edition-of` → node-typed properties; `cites` → typed-link verb with locator metadata; `mentions`/`about`/`related-to` → prose mentions; `has-asset` → asset assertions; `annotates` → annotation objects; `member-of` → collection membership). No use case orphaned.
2. **Seeded relation vocabulary deleted.** The ten fixed-UUID relation schemas were a usage prediction hardened into protocol — the design law caught it; epistemic vocabulary is documented convention, not protocol seeds.
3. **Classes re-merged into the node table** (v1's split reverted after post-mortem; Logseq DB's separate class layer externally rhymes with our reverted mistake).
4. **Editor: Logseq-style outliner**, bullets as blocks as nodes; TreeCrdt + fractional positions ported. The plan's plain-text fallback is redefined as "outliner without verb marks" (§34.6).
5. **Soft page/block kind — superseded before implementation by the `is_page` amendment** (Revision 10, §34.14): `kind`, and the briefly-considered `page_id` column, were replaced by a single boolean.

**Adopted amendments (recorded in `00-INDEX.md` and `packages/protocol/SCHEMA.md`):** record-don't-resolve — typed-link capture records candidate target spans as an ordered token-ID list (no scoring/filtering at capture; resolution rule deferred to M2 against real capture data); fixture-gate parity — the deleted relation fixtures were replaced by typed-link-mark fixtures exercising the same acceptance scenarios, keeping the blocking gate at full width.

**Scaffold state:** `packages/protocol` re-aligned (RELATIONS.md, `seeds.ts`, `relation.*` ops, and relation fixtures removed; SCHEMA.md created with the owed-work register; typed-link mark grammar + contentAst carrier added; 23 tests green). The sync/derived-store port, migration script, and remaining M1 scope proceed against this model.

### 34.10 Editor parity target (named scope, scheduled — not architecture)

Owner question (2026-09-25): can the editor reach parity with Logseq/Tana/Notion/Capacities in responsiveness, modularity, drag-and-drop, multi-instanced sidebar cards, live queries as in-editor blocks, and asset rendering? **Assessment: yes — no architectural modification required.** Every item is a projection over primitives the model already has (no new op type, sync primitive, or storage category); most exist in v1 and port. Recorded here so parity is scheduled scope, not a later renegotiation.

| Feature | Stage | Basis |
|---|---|---|
| Outliner core (bullets, indent/outdent reparent, collapse) | M1 | `01` §5; port v1 `BlockList` + collapse state |
| Core editing mechanics (slash commands, markdown autoformat, find/replace, keyboard nav, undo/redo) | M1 | All v1 ports (`InlineTriggers`, `convertMarkdownInAST`, `BlockFindReplacePlugin`, `UndoManager`) — the unglamorous 80%, scheduled so it isn't assumed |
| Responsiveness / virtualization | M1 (non-negotiable) | Port v1 `@tanstack/react-virtual` + GraphQuery incremental invalidation |
| Reorder/reparent convergence | M1 | TreeCrdt + fractional positions (v1 machinery) |
| Drag & drop (blocks, cross-tree) | M1 port → M2 Notion-grade polish | v1 dnd-kit block DnD; feel polish is effort, not research |
| Live query blocks in the editor | M1–M2 | Port v1 `QueryNodeCollection`/`QuerySection`; `query` class is first-class in the model |
| Asset/image rendering in the editor | M1–M2 | Port v1 `AssetImage` + `node_asset` + asset tokens |
| Multi-instanced sidebar cards | M2 | Extend v1 `sidebarCardRegistry` to N GraphQuery subscriptions |
| Zoom into bullet / focused mode | M1 (design confirmed 2026-09-25) | **View type is a function of `node_type`, not a UI mode switch:** `class` → **Class View** (page chrome — header, icon, color — plus property-bindings editor, `extends`/inheritance section, classed-nodes section, template slot, description shelf); `page` → **Page View**; `block` → **Focused Block View** (the block as root of a block list, no header). A page nested under a page renders in the parent's **dedicated Child pages section** (a blocks-list projection) and opens in Page View — it never appears inline in the parent body (projection rule 3). Promotion/demotion = flipping `node_type` block↔page, identity preserved. Class/whiteboard views are view-registry overrides (one mechanism) |
| Hover → floating editable node view | M2 | Floating popup (`@floating-ui/dom` ports from v1) mounts a mini block-tree editor on its own store subscription — same mechanism as multi-instance cards; edits write the normal op path |
| Embeds with live updates + two-way editing | M2–M3 | Embed block token (SCHEMA.md owed work) rendering the **live subtree, never a clone** — then live updates and embedded editing are the standard notification/op path; needs a cycle guard (depth cap + visited set) |
| Long-form writing feel | carried risk | Deliberate bet against document-mode editors; checkpoint per `00-INDEX` known risks |

**Plan deltas:** none structural. The one load-bearing addition is block-level content tokens (embed/query/asset/whiteboard) in the content grammar — owed work in `SCHEMA.md`, scheduled before the M2 items that depend on them. The plan's package layout already isolates this: `packages/editor` owns the AST + editor; `packages/store`/`packages/query` serve every projection uniformly.

### 34.11 Competitive sweep verdict (2026-09-25)

Full sweep of the agreed model — data model, editor, properties, parenting, inheritance — against Obsidian, Logseq 2.0 DB, Capacities, and Tana (verified states per `v2/.plans/design/03-paradigm-assessment.md`). Verdicts are model-capability verdicts; maturity/ecosystem deficits are execution gaps, expected for a greenfield, and are listed separately.

| Axis | Verdict |
|---|---|
| Data model | **≥ all four.** Wins: block identity (Obsidian is file-granular), typed discourse verbs (nobody has them), unified edge index, agent surface from day one, local-first + E2EE slot, classes-as-nodes (Logseq DB kept classes separate — our v1 mistake, reverted). Losses: file-editability (traded for semantic fidelity; export-first-class compensates), Datalog expressiveness (deliberate trade — QueryAST→SQL is agent-readable), Tana's schema-at-capture maturity (create-and-bind is owed work). |
| Editor | **Parity = port-and-polish program, not research.** Virtualization, DnD, slash commands, markdown autoformat, find/replace, undo, keyboard nav, in-editor queries, asset rendering, collapse — all v1 ports (§34.10). Named gaps: zoom into bullet (owed), embeds/transclusion (the one genuinely new build), Notion-grade DnD feel (M2). Flashcards/SR exists in v1 as a plugin — M3 plugin candidate. |
| Properties | **≥ all four.** Typed registry with 11 value types incl. m2o/m2m + `targetClassFilter`; per-value `metadata` qualifiers (`since`, `locator`) — unique; multi-value, options, required/readonly/hide-when-empty, per-binding defaults, validation rules, QueryAST `prop:` conditions + aggregations. Gaps registered: property-schema CRUD UX (owed); computed/formula language = **deferred owner decision** (not a silent gap). |
| Parenting | **≥ all four.** Blocks as first-class tree citizens (Capacities has no block model), forest of roots (Tana enforces a single tree), `node_type` with schema-enforced placement and identity-preserving promotion (unique), TreeCrdt drag-reparent, and the unique `refset` propagation — backlink roll-up + inherited-link filtering (Logseq's linked-references filter generalized tree-recursively). |
| Inheritance | **> all four — outright differentiator.** None of the four has class inheritance with property-binding resolution. Ours: multiple inheritance from M1, `extends` as m2m node-typed property, derived closure, effective membership = own ∪ ancestors, deterministic binding resolution, fail-loud cycles. Owed: normative closure/binding statement (SCHEMA.md). |

**Conscious divergences (rejections, not gaps):** Datalog; curated type catalogs (design law); bundled AI features (scope-excluded — agent surface is our answer); files-as-truth; mobile/collab (M-tier; the substrate already supports both).

**Sweep outcome:** no model-level retreat is required to reach parity-or-better on any axis. The gap register from this sweep (property CRUD UX, create-and-bind, formula-language decision, template instantiation, zoom, embeds) is recorded in `SCHEMA.md` owed work and §34.10 — the sweep's purpose was to ensure nothing a competitor ships is silently absent from our schedule. Template instantiation graduated from this list into a full design brief: **§34.25**. Presentation mode (Capacities, verified 2026-10-02) likewise: **§34.26**.

### 34.12 Workspace export — Obsidian-gap closure (owner decision, 2026-09-25)

The Obsidian file-editability gap is closed by commitment, not by trade: **users can export full workspace snapshots with maximum data preservation.** Two tiers, one doctrine:

- **Doctrine:** export is a projection, one-way by design (the log is truth — Logseq's "Markdown is not a backup" wound). But the projection is engineered to be *as round-trippable as possible*, and the export surface is a first-class product feature (`notees export`, API endpoint, UI action) — never an afterthought. Interop conventions are borrowed from Obsidian/Logseq where they exist; they are conventions, not protocol (design law).

- **Tier 1 — JSON archive (M1, backup grade).** Full-fidelity workspace dump: all ops-replayable state, schemas, and assets, in one restorable artifact. Ports v1's dump export; this is the disaster-recovery and migration format (and the acceptance harness for the migration script).

- **Tier 2 — Markdown interop projection (M2, citation pipeline milestone).** Deliberate mapping of the content grammar to text:
  - pages → one file per page, **filename = node UUID** (v1 auto-export precedent: rename-free, maximum preservation, grep-friendly);
  - block tree → nested Markdown bullets (outliner → Markdown is structurally natural);
  - properties → YAML frontmatter (pages) / inline property lines (blocks); per-value qualifiers (`since`, `locator`) preserved;
  - class chips → `#classname`; mentions → `[[name]]`; **embeds → `![[uuid]]`** (Obsidian's own embed syntax — interop for free);
  - typed links → verb-marked text with locator preserved (Logseq `verb::` convention or bold-verb; decided in the export spec);
  - queries → fenced ` ```query ` blocks carrying the QueryAST; whiteboards → sidecar JSON + file link; assets → `files/` directory + manifest;
  - a workspace-level **UUID manifest** (exported name ↔ UUID ↔ type) recovers identity for any re-import.
  - *Export spec owed work* in SCHEMA.md: the token-set→Markdown serialization table.

Exit criterion: an exported workspace re-imports (M2 round-trip harness, extending v1's `test_import_roundtrip` idea) with a reconciliation report — same discipline as the migration script.

**Amendment (owner, 2026-10-02) — Capacities-style export redesign, work record §34.24.** This tier's shipped-shape decisions are revised where §34.24 conflicts: filenames become human-readable `<title-slug>-<uuid8>.md` (uuid-suffixed, not uuid-only — identity preserved via suffix + manifest); links inside multi-file/zipped exports are rewritten to relative local `.md` links ("graph fully contained" — single-file exports keep the `[[name]]`/`![[uuid]]` conventions above); the asset directory is `assets/`; the single concatenated `GET /export` route is **replaced** by `GET /api/workspaces/:id/export.zip` (one file per top-level page + child pages, optional assets, properties frontmatter wired — the current route's `properties: []` drop is closed, not carried over). Tier-2 doctrine (projection, not backup; interop conventions, not protocol) is unchanged.

### 34.13 Workspace tenancy design (decided 2026-09-25)

**Workspaces remain a separate table; they are NOT nodes.** Every node carries a `workspace_id` column; `parent_id IS NULL` means top level *within the workspace*. The workspace-as-parent-node alternative was rejected on four grounds:

1. **Tenancy is infra, not semantics** — workspaces bound sync routing, E2EE key scope, shares, snapshots, and per-workspace derived DBs (the design stack's INFRA category: "never ops"). A workspace node would either drag auth/tenancy into the semantic graph or have to be replicated into every store scoped to it.
2. **Propagation pollution** — with `refset(n) = own_links(n) ∪ refset(parent(n))`, every node would inherit the workspace root's links; containment-as-reference would make the entire workspace reference anything the root references.
3. **Mega-fan-out** — every top-level node's parent edge funnels through one root node; every tree traversal and child-list query pays the concentration cost.
4. **The benefit is already had** — "the workspace contains all its nodes" is exactly `workspace_id = X`; "top level" is exactly `parent_id IS NULL`. No physical node is needed for either semantics.

Rationale bonus: every derived query filters by workspace (`WHERE workspace_id = ?` on all derived tables) — a direct column beats a recursive tree join on every query for zero model gain.

### 34.14 `node_type` — the bullet-proof schema (owner amendment, Revision 10 final, 2026-09-25)

Replaces the `kind` field and the same-session `page_id` column and boolean-flag experiments (Revisions 9–10 history). Full normative detail in SCHEMA.md ("Node structure"); summary:

**One enumeration, schema-enforced — illegal states are unrepresentable, not guarded:**
- `node_type ∈ {page, block, class}`, NOT NULL (applier defaults by context: workspace root → page, child → block). The three axes: **`node_type`** (structural role) × **`parent_id`** (placement) × **`class_ids`** (domain typing).
- **Database CHECKs (single-row):** a block can never be parentless; a class is always tree-external. A parentless node is always a page or a class — the owner's drift scenario ("block with no parent and no flag") cannot exist in the schema. The one cross-row rule (a class may not be a parent) stays an applier move-guard (fail-loud).
- Placement lives only in the tree — cross-page moves update nothing but the parent edge (+ order): no cascades, no second representation.
- **Declaring a class = set `node_type='class'`** — declaration-first (create classes, configure them, use them later or never; undeclaring leaves inert config, design law over prohibition). Class listing = derived `class_list` read model, explicitly NOT a stored registry (shadow split + new op type — rejected). The reserved system `class` node remains as hierarchy root / Classes-UI anchor.
- **Queries:** "containing page of B" = nearest `page`-type ancestor (v1 `page_ancestors` CTE); "blocks inside page Y at any level" = subtree CTE joined to the edge index (v1 `specific_pages` port) — read O(subtree), write zero; an ancestor-closure read model only if profiling demands it.
- **View resolution = f(node_type), full stop:** `class` → Class View (page chrome + property-bindings editor + `extends`/inheritance section + classed-nodes section + template slot + description shelf) · `page` → Page View · `block` → Focused Block View. Class/whiteboard presentations are view-registry overrides — one mechanism, no new sync primitive.
- **Child pages** keep `node_type='page'` and render in the parent's **dedicated Child pages section** (a blocks-list projection opening them in Page View) — NOT inline in the parent body. Projection-reclassification rule 3; the full set (class-instances → members section, property-carriers → properties panel, child-pages → child-pages section) is one derived mechanism. **System sections** (linked references, unlinked references, child pages, classed nodes, extended-by) are named system queries over the QueryAST runtime (v1 `autoFixSystemQuery` port) with fixtures; plugin-extensible in M3.
- **Whiteboard:** `whiteboard` system class + content token; fullscreen = `node_type='page'`, embedded = child of any block with `node_type='block'`. **Cards are child blocks** (full grammar/search/backlinks — the whiteboard is a spatial view of its subtree, geometry keyed by node id in the layout token); **shapes are layout-token-only**; semantic text lives in cards, not shape labels; drag = debounced layout ops via `object.update`. General rule: what-it-is lives in class, specialized data in tokens/assertion rows — never new kinds or flags.

### 34.15 Implementation readiness audit (2026-09-26) — backend-first, clients in lockstep

Full audit of plan + design stack + SCHEMA.md + protocol package across tech stack, language, modelling, and implementation. **Verdict: READY to start the backend.** The model survived the audit — every amendment from the design sessions is consistently recorded across all four artifacts (plan, SCHEMA.md, 00-INDEX, code), and the fixture gate is green (23/23). Six reconciliation items were found and registered in SCHEMA.md owed work; none block scaffolding `protocol`/`domain`/`store`, three (name derivation, mention↔node_link key, collection reconciliation) must close before the store's appliers finish, one (protocol v2 wire spec) before `apps/server` serves traffic.

**Stack — pinned, no open language questions:** TypeScript everywhere · Node 22 (host-verified) · pnpm 9 monorepo · Fastify 5 + `@fastify/websocket` + pino (server) · **better-sqlite3** per deployment (synchronous single-writer; per-workspace derived DBs as separate files; PostgreSQL adapter deferred as a documented option) · zod (validation) · yjs (text/tree CRDT) · vitest · CLI packaged with **tsup** (closes spike S7). `packages/` layout per §34.3; the single-implementation store/sync/query packages run in three runtimes (server Node, browser worker, CLI) — the v1 dual-language tax cannot recur.

**Sequencing (refined by owner): backend first, frontend second.**
- **M1a — backend core:** `protocol` (v2 wire spec owed work) → `domain` (seed manifest, name derivation) → `store` (derived schema + appliers + CHECK constraints; reconciliation items 1–3) → `sync` (v1 SyncEngine port) → `server` (relay + object API + CAS assets) → `cli`. Exit = the blocking fixture/convergence gate green + CLI exercising the object surface.
- **M1b — web editor core** (outliner, marks, system sections, lazy-loading contract), then **M2 — frontend amazing**: editor polish, live queries, whiteboards (card/shape model per SCHEMA.md), asset management, bibliography/library — with backend features (citations pipeline, annotations) continuing in parallel.
- **Client repos in lockstep (owner directive):** `notees-flutter` and `notees-gtk` are cloned alongside the main repo (sibling folder, one branch per rewrite phase); their protocol layers are updated to v2 as the backend lands — the clean break means v1 clients do NOT speak to a v2 server, so compatibility is achieved by updating the clients, not by v2 backward-compat. The blocking fixture gate extends across the three repos (each client's CI validates the same canonical fixtures). The old Python backend stays the daily driver until M1b soaks (§34.8).

**Feature-centric clients (recorded options, not commitments):** the architecture supports dedicated thin clients over the public API — e.g., a **quick-notes/recorder Flutter app** (capture-only: create blocks/pages with audio attachments via `asset.attach`) and a **library/bibliography-centric manager** (GTK or web: source CRUD, citekey management, CSL/BibTeX projections, reading-state properties). Neither requires core changes — they are clients of the same object API and protocol; decide after M2 when the API surface has earned external consumers.

**Repo structure (DECIDED by owner 2026-09-26, superseding the monorepo recommendation above):** split into `notees-sync` (sync/object server), `notees-web` (web client), plus the existing `notees-gtk` and `notees-flutter`; all four compose together in the `notees` compose project. Enabler: the shared packages (`@notees/protocol|domain|store|sync`) become a **published SDK** — the pre-registered trigger ("published SDK needed for M3 plugins / third-party clients") is invoked now. The packages' source of truth + fixture gate stays in the main repo, which publishes them; split repos consume published versions. Publish order per slice; public npmjs access requires an owner npm token (asked).

### 34.16 Owner requests (2026-09-26): ORM shell, Python SDK option, recursive Markdown export

**1. `notees shell` — the Odoo-shell equivalent (accepted, M1-cheap).** The v1 backend was Python partly for REPL ergonomics; the v2 answer is a **Node REPL with the real packages preloaded** (`node:repl` + an open `@notees/store` + the query/search surface + domain helpers): interactive `store.query/search/backlinks` over live workspace state, arbitrary logic, identical semantics to the app because it *links the same code* — no bridge, no duplicated query semantics. Ship as `notees shell` in the CLI (loads config, opens the server's data dir read-only or via the API).

**2. Python SDK — registered option, NOT an in-process bridge (assessed).** A Python *client library* over the public HTTP API is feasible and serves the Jupyter/pandas-over-your-graph research workflow — but it is an **M2+ option, kept deliberately thin and untyped** (dict-level API, no mirrored pydantic schema) to avoid a third schema definition to keep in sync. Rejected: an in-process Python bridge into the server (would reintroduce a dual-implementation tax the rewrite exists to eliminate). Decision point: after M2, if notebook workflows materialize.

**3. Query-driven recursive Markdown export (accepted, M2).** `notees export markdown --linked-to <id> [--depth N|fixpoint] --output-dir Y` (+ query selectors): start set = pages matching the selector (edge-index closure, e.g. everything linking to X), export each via the shared Markdown renderer (**one implementation** — `packages/export`, the owed serialization package, reused by CLI export, workspace snapshots, and the future server endpoint), recurse through links/embeds/child-pages with a **visited-set cycle guard** and depth default, writing `<uuid>.md` (rename-free, §34.12) plus the UUID manifest into Y. Canned closure patterns live in the CLI; arbitrary logic lives in the shell (§34.16.1) — that division keeps the CLI surface small.

**4. Device-class shells (owner direction 2026-09-26; constraint effective now, tablet shell deferred to M2).** The web app targets one shared core (data path, queries, sections, token renderer) with **two interaction shells: `desktop | tablet`** — one component switch, not two apps. Desktop keeps hover, right-click, gutter toggles, drag-and-drop; tablet (big-touch reading/editing; the phone stays the Flutter capture client) gets a bottom toolbar instead of context menus, long-press selection, swipe actions, large targets, and no hover-dependent chrome. **Binding constraint on the shared core, effective immediately:** no feature may *require* hover — hover previews/gutter toggles/hover cards are progressive enhancement and must have a tap-visible alternative (hover-only triggers are a prohibition on touch users — the design law applies to interaction as well as schema).

**5. CLI agent-ergonomics pass (owner-asked follow-up to the live class migrations, 2026-10-03; SHIPPED — code + tests + docs; deploy pending).** Running the fuente→source / class-remap migrations through the M1 CLI exposed four friction points, all fixed in one pass: (a) the client-side API-key shape gate (`/^nk_…{32,40}$/`) rejected credentials the server accepts (session tokens) — removed; the credential is sent verbatim and the server's 401 maps to exit 3. (b) The CLI never sent `x-workspace-id`, silently addressing the server default — new global `--workspace <name|id>` (env `NOTEES_WORKSPACE`): uuids pass through on any credential; names resolve via `/api/workspaces` (per-profile cache in the CLI state file) and need an account credential. (c) No REST surface for class membership — `PUT/DELETE /api/objects/:id/classes/:classId` over the two EXISTING carriers (re-issued `object.create` OR-Set add + `class.unassign`), idempotent both directions, class nodes rejected (identity is the `is_class` bit); no new op types → no fixture/lockstep gate. CLI: `notees class assign|unassign <objectId> <class uuid|title>`. (d) Graph maintenance needed hand-built envelopes — the shell grew `makeOp`/`submitOp`/`submitOps` (envelope-v3 stamped via `@notees/protocol`, actor derived from the credential, workspace from `--workspace`). Same pass, one read-model fix the migrations surfaced: class routes (`/api/classes` list+detail, members, object `classes` embed) derive titles from the class node's content — the registry `name` is a write-side cache that pre-title-is-content rows never backfilled, so user-class titles were blank in the API (SCHEMA.md "Name/title derivation" amended; CLI/web class-name resolution rides the same derived list). Evidence: server objects suite 18/18 incl. new membership + derivation cases; CLI suite 43/43 incl. workspace-resolution, assign/unassign, credential-shape, submitOp cases; full gate green 2026-10-03 (1099 tests). **Owed:** deploy (rebuild the `notees-sync`/`notees-web` images — the running stack predates this pass).

**Addendum 2026-10-03 (same day) — the deferred ergonomics batch SHIPPED** (the migrations minted+revoked three throwaway API keys for want of these): ① `notees auth login|logout|status` — login mints a dedicated CLI API key stored per profile+server in the state file (mode 0600); credential resolution becomes `--key` > `NOTEES_API_KEY` > stored, so scripts stop carrying secrets; required one server change — **API-key self-revocation** (`DELETE /api/api-keys/:id` accepts the key itself when `id` is its own row; other keys stay session-only), `resolveApiKey` now returns the key id. ② Compact fixed-width tables for human-mode `class list` / `object list` (JSON contract untouched). ③ `notees class remap <from> <to> [--dry-run|--yes]` — the bulk membership verb behind the day's migrations (members move via the REST surface, extends remap rides one envelope batch, emptied class stays; preview + `--yes` like destructive commands). ④ `object list --all` follows the cursor to exhaustion. ⑤ Op discovery: `OP_CATALOG`/`describeOp` in `@notees/protocol` (per-op description, example payload, affected-node shape), surfaced as `notees ops [opType]` and shell `ops()`/`opHelp()` — the `submitOp` learning curve disappears. Evidence: protocol catalog import-verified after a dist rebuild (dev-condition rule); server auth suite 25/25 incl. self-revocation; CLI suite 49/49 incl. stored-credential round-trip, remap dry-run/preview/execute, `--all`, ops; full gate green 2026-10-03 (1126 tests). Docs pass landed with it (usage.md auth/tables/remap/--all/ops rows, SCHEMA.md catalog + REST-surface rows). **Owed: still deploy** — one image rebuild covers both this batch and the base pass.

### 34.17 UI recovery directive (owner, 2026-09-30)

The rewrite's web UI was rebuilt as a minimal shell and dropped the previous UI's design language and chrome features. Decisions:

1. **Full, faithful port of the pre-rewrite UI is the baseline** — its actual components and CSS transferred into the v2 web app (rewired to the v2 client; all v2 logic preserved), as one direct pass. Necessary adjustments happen AFTER the port lands, not instead of it. The Capacities-style layout (floating content card, chrome on the background canvas) remains a candidate adjustment, deferred to the post-port pass.
2. **Naming rule (permanent): no "v1" mentions in UI files** — no v1-prefixed directories, class names, identifiers, or comments anywhere in apps/web (provenance lives in git history, not in code). Applies to all future UI work.
3. **Recovery scope, in order**: app chrome + layout, breadcrumbs, metadata section, system sections (linked references / child pages / unlinked references), command palette; then editor chrome visuals; other view modes (graph, kanban, covers/display modes) in later passes. Owner explicitly does not want page tabs in the topbar.
4. **Chrome features the plan must now carry** (were unplanned, now scheduled by this directive): breadcrumbs, metadata section, system sections, command palette. The editor-mechanics list in §34.10 stands unchanged.

### 34.18 Pending UI register (owner, 2026-09-30 — full port directive)

The pre-rewrite UI is being transferred wholesale (components + CSS, adapted to the v2 client) for every feature v2 implements. This register tracks what remains pending after each port pass.

**Ported / in progress (this pass):** app chrome (topbar, sidebar sections, workspace switcher, command palette), floating content card, breadcrumbs, metadata section, system sections (linked/unlinked references, child pages), section chrome.

**Pending (scheduled, in priority order):**
1. Editor chrome: slash/trigger popup, floating toolbar, find & replace, link-edit modal, markdown autoformat, undo/redo — §34.10 M1 mechanics, visual transfer from the archive.
2. Metadata pickers: class/tag/alias selector popups (search + create + color), date picker popup, property editor controls (select/multi-select/boolean/date).
3. Modals for existing features: export page, duplicate page, create-page-with-uuid, quick-add, workspace rename.
4. UI primitives kit: Button/Dropdown/Modal/Confirmation/ContextMenu/Badge/EmptyState/Toast as shared components (reused by everything above).
5. Overlays: backend-unavailable, notification toast wiring, empty/loading skeletons.
6. Right-sidebar cards + hover floating node view (§34.10 M2), embeds with live updates.
7. Covers/banners + card display modes (no-cover / cover-left / cover-right / cover-top).
8. Views over the query engine: table/kanban/calendar/chart/gantt/pivot, graph view (needs its own portability decision), document view (deliberate bet against — §34.10).
9. Surfaces: journals/tasks pages, import modals, shares UI, notification center, plugin UI, mobile layout.
10. Accent-color variants (sage/teal/rose/navy) + icon picker.

Rule: items land in the order above unless the owner re-prioritizes; each port pass must end with the deployed stack verified by screenshots in both themes.

### 34.19 UI/UX parity register — full v1 inventory vs v2 (2026-09-30, deep audit)

Supersedes §34.18 (its items fold in here with real scope). Source of truth for "what v1 had": three-area inventory of the archived frontend (content/views/editor; shell/navigation/queries/whiteboard; integrations/properties/workspace), evidence-cited. Goal the owner set: **v2 ends up equivalent to v1 in UI, UX, and features.** Status legend: ✅ ported · 🟡 partial (listed gap) · ❌ missing · ⛔ no v2 backend (port UI inert or build backend first).

**P0 — core daily UX (highest value per day; no backend blockers):**
| Feature (v1 evidence) | Status | Gap |
|---|---|---|
| Undo/redo (Ctrl+Z/Y, history menu w/ jump-to, `undoStore`) | ❌ | Biggest single UX hole; needs op-inverse log (client-side undo journal over the op log) |
| Back/Forward nav (`navigationHistoryStore` + History API) | ❌ | We have URL sync but no in-app history buttons |
| Block multi-selection (box select, Shift+arrows, Ctrl+A/C/X/V, delete) (`useBlockSelection`) | ❌ | Selection store + clipboard internal format |
| Ghost trailing block ("click to create") at list end | ❌ | We have a separate "+ Add a block" affordance |
| Block move via Alt+Shift+↑/↓; fold via Ctrl+. or Alt+←/→ | ❌ | Keyboard map entries |
| Keyboard map breadth: Ctrl+N new page, Ctrl+Shift+T today, Ctrl+, settings, Ctrl+\ sidebar, Ctrl+Alt+P add property, Ctrl+F find (`keyboardStore`) | 🟡 | Only palette/quick-add/find exist; **presentation mode shipped Ctrl/Cmd+Alt+Enter 2026-10-03 (§34.26 P6)** — Capacities' Ctrl+Alt+P was NOT taken: it collides with this row's reserved add-property chord (and the browser private-window binding); Ctrl+Alt+Enter is free |
| Floating toolbar: underline + math (KaTeX) marks | 🟡 | bold/italic/strike/highlight/code only |
| Slash commands: v1 had ~17 (embed, table, code, whiteboard, comment, template, date, image/audio/file, link variants) | 🟡 | 5 exist; port rest as AST shapes allow |
| SuggestionPopup details: multi-select checkbox mode, `daily:`/filter prefixes, NL date parsing (`parseDate`) | 🟡 | **NL date-page insert shipped 2026-10-02** — `@feb 14` parses and offers "Go to/Create daily page", ensure-chain + pick in one gesture (`NodeSelector.tsx:300-334`); owed: multi-select checkbox mode, `daily:`/filter prefixes, `[[` date-page trigger → §34.28 #9 |
| Link pills: LinkEditModal Page/Block modes, NodeLinkContextMenu (open-in-sidebar, unlink-keep-text, broken-link fix), Shift+click → sidebar | ✅ | **Shipped 2026-10-02 (§34.22)**: LinkEditModal Page/Block modes fully wired (retarget + custom label); atom pills in the editor (arrow-select, atomic delete); node-link context menu in EVERY view mode (edit + read, one app-level host); `@`-over-selection prefill + Ctrl/Cmd+Enter custom-label pick (2026-10-01). Owed: broken-link "create page with UUID" fix row |
| Breadcrumbs: hover chevron reassign-parent, right-click edit/remove parent, "+ Add parent", property crumbs | 🟡 | Nav-only crumbs |
| Metadata rows: Aliases (pages), per-node color, non-removable-class rules | 🟡 | Classes/tags done; aliases missing → detail **§34.32 PG10** (register contradiction — design deemed aliases obsolete, v1-parity wants them back; owner decision) |
| Page footer: word count, Created/Updated date buttons → day pages | ❌ | Cheap, high polish → §34.27 L4 |
| Unlinked mentions: Promote → real link, Ignore dismiss | 🟡 | Section exists, flat |
| Topbar right: Undo/Redo, Back/Forward, Calendar popup, Tasks popup, Scratchpad, Focus mode (Ctrl+Shift+F), LiveSyncIndicator (`MainContentTopbar`/`TopBar`) | 🟡 | **Calendar popup shipped** (2026-09-30, faithful port: days/months/years zoom, has-note dots, ensure-chain+open on pick); calendar breadth owed (week strip/agenda, ranged objects invisible — §34.28 #11); the rest still pending per-owner |
| Sidebar: icon rail + panel (v1 two-panel), Pinned section, drag-reorder favorites, SidebarTools footer (Archived, Trash, SupportBadge) | 🟡 | Single panel; no rail/pinned/reorder |
| Command palette: filter prefixes (`class:` `uuid:` `is_page:` `is_daily:`), sections (Recently Accessed/Created, Random, Commands, Date Pages, Blocks, Properties), "+ Add page", quick-add ⌘↵ | 🟡 | Basic pages/classes/actions — detail §34.30 |
| View modes for query results: kanban + document + table polish (v1 has 10 modes; kanban dnd mutates properties) | 🟡 | **2026-10-01/02: view-mode system shipped (§34.21)** — registry + switcher + reusable `NodeCollection` (flags: tree/editable/readOnly/pagesOnly/maxDepth/renderItem/trailingAction/tableColumns/kanbanProperty…); child-blocks triad outline/prose/cards (prose = the `nt-prose` editable transform); v1 table port (classed nodes default, per-column sort, windowing, bool/select inline); **kanban board (2026-10-02): property-dimension columns from a select schema's options + None, drag-drop writes the property**; tasks hub (pages+blocks, table default); assets hub (cards default); pages/classes outline; child pages + linked/unlinked references through the outline view (references grouped by containing page via groupBy). Still owed (post-V12): gantt/calendar/chart/pivot/timeline (cross-ref §34.31 V7), graph (§34.21 future register + §34.31 V8), kanban card-order persistence, multi-value cell editing, bulk actions over the table selection, saved views per section (detail **§34.31 V1**) |
| JournalsView: reverse-chron feed, inline editing, load-more | ✅ | **Shipped beyond parity** (2026-09-30): today-centered continuous scroll of live page views (windowed ±8, sentinel-grown both directions, reload re-centers); header click opens page view; default boot view; `/journal` route. Daily-page sections on day pages still pending (full day-page aggregation scope → §34.28 #4) |
| Calendar day view (Capacities-style Day view; no v1 equivalent) | ✅ | **Shipped 2026-10-02** (`/calendar` hub, cross-ref §34.28): sidebar entry after Journal (device setting `sidebarShowCalendar` + Workspace Settings toggle) — day header (weekday, Today marker, local date per dateFormat, ISO week, prev/next/Today), quick-create chips for classes with date-typed bindings (#10), filter tabs (All/Daily note/Tasks/Dated/Created), daily-note embed via `<PageView embedded>` + create-in-place, open tasks in Overdue/Scheduled groups from ONE query + client-side partition (#4b; done-toggle = the hub's `property.set` option write), general date references from the day node's backlink set (#4a), created-today range query (#4c), `MonthCalendar` month grid sharing `CalendarDayGrid`/`useCalendarMode` with the top-bar popup (#3 extraction). Ships #2 (`ensureTaskFamily`). Owed per §34.28: day-page branch in PageView (#4), day-page/journal date bar (#7), range-aware dots (#11), `{date}` template pairing (§34.25 D4). **Addendum 2026-10-02**: the quick-create chip list is user-configurable per workspace — Workspace Settings → Calendar Quick-Create (per-class toggles over the shared eligibility rule; device-local `calendarQuickCreateClasses.<workspaceId>` setting, null = follow defaults = the eligible system classes i.e. Task; cross-device preference sync stays §34.29 #8) |
| TasksPopup: Overdue/Today/Upcoming/Unscheduled/Completed sections, recurrence picker, completion history | 🟡 | **Tasks hub shipped 2026-10-02** (`App.tsx:1418-1445` — `/tasks` CollectionHub over task-class members, pages AND blocks, table default with task property columns + kanban by status); owed: bucketed Overdue/Today/Upcoming/Unscheduled/Completed view, recurrence picker (engine absent → §34.28 #6), completion history; fresh workspaces silently drop Scheduled/Deadline columns (bug → §34.28 #2) |
| Daily-page sections: Scheduled/Overdue tasks on day pages | ❌ | §34.28 #4(b) — no model work needed (day-node backlink set + date query arms already exist) |
| TrashView (restore/permanent delete/empty trash/batch) + ArchivedPagesView | ❌ | **API + CLI restore shipped (§34.38)** — `POST /objects/:id/restore`, `object list --trashed`, `object restore <id>…`; the **web TrashView UI itself stays unbuilt** |
| Templates: `{{variables}}`, TemplateGallery, slash instantiate, TemplateVariableDialog | ❌ | Template class exists; no machinery — design brief **§34.25** (2026-10-02, Capacities comparison); implementation pending (T1–T6 there) |
| PresentationModal (children as slides) | ✅ | **Shipped 2026-10-03 (§34.26 P1–P8)** — `PresentationOverlay` kit primitive + pure deck builder + `DeckView` slide renderer in the web app: tree-heuristic slide split (title → intro/section slides by the `present_as_main` partition, density chunking, trailing-image pull, embed expansion), read-only-but-live, session-only resume, entry points: "…" menu / header menu / Ctrl+Alt+Enter (Capacities' Ctrl+Alt+P collides with the add-property chord). v1 source `frontend/src/features/content/components/PresentationModal.tsx` @ `v1-archive` |

**P1 — research/library (owner's domain; some backend needed):**
| Library plugin: 3-pane manager, collection tree, Work→Edition grouping, Add-by-identifier (ISBN/DOI), PDF drop → metadata resolve (`plugins/builtin/library`) | ❌ | The v1 crown jewel for sources; needs resolver backend |
| Property controls: url/email/number/integer/image renderers; PropertyCreateModal (icon, type grid, scope, multi, options editor, allowed classes, default) | 🟡 | text/number/bool/date/select/node exist → detail **§34.32 PG2** (schema CRUD surface) + **PG14** (zombie types) |
| ClassPropertiesEditor: drag-reorder, tri-state required/readOnly/hideWhenEmpty, DefaultValueEditor | 🟡 | Bindings editor basic → detail **§34.32 PC1/PC2** (readonly/required contract, defaultValue typing) |
| PropertyView (dedicated property page + population query) | ❌ | → detail **§34.32 PG12** |
| PropertyReferencesSection (relation-property references above linked refs) | ❌ | Needs relation properties (M2) → detail **§34.32 PG12** |
| ActivityLog section (Created/Edited/Moved/… per node, relative time) | 🟡 | Ops exist; projection+UI missing |
| Page banner/cover images (drag-drop, collapse, persisted) | ❌ | Needs image property + AST banner slot → §34.27 (existing `cover` property + header slot, D2); the `image` type is currently a zombie (no shape/editor) — evidence **§34.32 PG14** |
| View modes focus/zen; card layouts (no-cover/cover-top/left/right) | ❌ | Display-mode switcher was in topbar → §34.27 L1+L6 (persistence + card layouts); focus/zen parked there |
| Saved views per section: ViewTabs (dnd order, rename/dup/default/delete), QueryEditModal, group-by, multi-sort toolbar | ❌ | Query blocks single-view — detail **§34.31 V1** |
| Text query language (`content:"x" AND create_date >= {this_week}`, `{today}` placeholders) + FilterBuilderModal + "Save as view" | 🟡 | **DSL shipped** (`@notees/query` `parseQueryLanguage` + CLI/SearchBox/server paths — §34.30 shipped record); owed: `{today}`-style editor-relative placeholders, FilterBuilderModal, "Save as view" — detail **§34.31 V2** |
| Quick-create modals (Source: authors/year/DOI; Agent: given/family split) | ❌ | Pickers create plain pages |
| NodeCollectionView (temporary ad-hoc queries) + global graph/timeline pseudo-pages | ❌ | — ad-hoc queries: detail **§34.31 V4**; graph stays `:1167` |
| AssetUploadModal (drag-drop, categories, preview) | 🟡 | Upload exists via property picker |

**P2 — power/social/infra:**
| GraphView (WebGL force-directed, settings sidebar, color groups, local graph, minimap) | ❌ | Biggest single component in v1 |
| Gantt/Calendar/Chart/Pivot/Timeline views | ❌ | Timeline+DatePropertiesPanel sizable |
| RightSidebarCards (shift+click cards, local-graph card) + context sections (TOC/Comments/Activity/Versions) | 🟡 | Empty panel placeholder exists → §34.27 L3 (TOC + references sections) |
| Scratchpad (transient blocks, send-all) | ❌ | — |
| Whiteboard full toolset (15 shapes, pen/highlighter/eraser widths, connectors, cards, context menu, minimap, grid/snap) | 🟡 | Basic canvas + cards |
| Import (Markdown/Logseq folder/data JSON) + workspace export (dump/md/txt/AST, assets) + auto-export | ⛔/🟡 | Workspace **Markdown export shipped** (card actions menu → Export, full-workspace .md via @notees/export; 2026-09-30); per-node/AST/asset exports + import + auto-export still backend-less |
| Flashcards (SM-2 study mode, stats, editor) | ⛔ | Plugin runtime (M3) |
| Shares (per-node public links, Shares Inbox, public view) | ⛔ | Needs backend |
| Presence (block avatars/locks/typing) + ConflictResolutionModal (3-way diff) + LiveSyncIndicator | ⛔/🟡 | Needs WS presence protocol |
| 2FA (TOTP enrollment, backup codes) + Onboarding/Enrollment/InviteAccept views | ⛔ | M3 |
| API keys with scopes (Read/Write/Admin checkboxes) | 🟡 | Scopes shipped server-side (§34.33 AG3 ✅ 2026-10-03, `api_key.scopes` + per-route enforcement); the in-app Read/Write/Admin checkbox UI is still owed here |
| Plugin manager UI (git/ZIP install, settings rendering) | ⛔ | M3 |
| MobileLayout (drawer + References bottom sheet + FAB) | 🟡 | Basic responsive only |
| Shortcuts cheatsheet, SupportBadge | 🟡 | About tab exists |

Execution rule: same transfer discipline as §34.17 — components + CSS verbatim from the archive, rewired to the v2 client; no paraphrase. Order within a tier is owner's call; the table is the backlog.

### 34.20 Shipped since the §34.19 audit (2026-10-01 batch, commits `90a6095e`..`abcc62ec`)

- **@/#/+ node-picker popups** (the v1 `NodeSelector` experience: own search field, caret anchor, create-from-query, date suggestions) replacing the inline capture list; `+` assigns classes, `#` assigns tags, `@` links pages/blocks.
- **Note layout**: class pills pinned to the content card's top-left corner; tags row under the title (pill chrome, alphabetical, effectiveColor); all property fields in a collapsed **Properties N** badge-count section; Linked references collapsed by default; Child pages renders the read-only blocks list (recursive, pages-only) and starts expanded.
- **Sidebar peek cards**: shift+click a block bullet → independent right-sidebar card (card-within-card surfaces, breadcrumbs-as-title with right-anchored clipping + lead "…"); arrow opens in main view; last card close closes the panel.
- **Title-is-content landed** (owner decision): the node `name` field is retired — titles ARE node content (pages/blocks/classes). Protocol payloads carry `contentAst`; pages/classes are text-only (stringify on promotion); live data migrated (`scripts/migrate-title-is-content.mts`, 1,278 nodes). See SCHEMA.md "Name/title derivation" for the full reversal record.
- **First-class tags + class order**: `tag.unassign` + `tagIds` carrier (schema v6); `class.reorder` display ordering (schema v7); sortable class pills with "+N" overflow popup.
- **v1 icon system**: `Icon` resolver (camelCase/kebab/JSON/emoji) + three-tab `IconPickerPopup` (All/Emojis/Icons, 7,447 sprite icons, recents); click the page icon to change it.
- **Deletion**: reusable danger `ConfirmationModal` (never a raw uuid, never inline); post-delete navigation to parent → default view.
- **Workspace landing URL** honors the default-view preference; **Recents** records on every open surface (sidebar refreshes live).
- **Property table interactions**: click a label → PropertySettingsModal (rename/date precision/select options); right-click → v1 menu (Open / Empty / Remove from node).
- **Bullet v1 tactile UI** (bolder dot, hover grow + accent, collapse ring); hover effects moved off blocks/sections (arrow-only for sections).
- **GTK/Flutter lockstep shipped** (`protocol-v2` branches, tags `v2.0.0-m1`, CI releases published: Flutter signed APK; GTK Arch package + wheel + sdist).
- §34.19 rows this clears/promotes: RightSidebarCards 🟡→✅ (peek cards shipped; TOC/Comments/Activity still missing); NodeSelector capture ✅; PropertyCreateModal 🟡 (settings modal shipped; create-flow parity partial); Recents/favorites live refresh ✅.

GTK/Flutter remain the owed lockstep for every future op.

### 34.21 Node view modes — work record (owner directive 2026-10-01, in progress)

Owner directive: port v1's node view-mode system (baseline: archive tag `v1-archive`, `frontend/src/features/views/` + `NodeCollection`/`NodeCollectionToolbar`) into the v2 web app, aligned with the v2 client. Scope decided with the owner:

- **Triad for the child blocks section**: outline / prose-flat / cards (first-level blocks as cards, child blocks inside). Plus a full re-implementation of **v1's table view** (default for classed-nodes sections).
- **Views are reusable across scenarios with flags** (v1 `NodeCollectionProps` philosophy): child blocks, child pages, linked/unlinked references, classed nodes, pages/classes lists, tasks, assets.
- **View switcher UI** (v1 `SelectionButton` strip + "…" overflow) ported.
- **Tasks view** = any node (page or block) classed `task` (`SYSTEM_CLASS_UUIDS.task`): table default, switchable to cards + outline.
- **Assets** left-sidebar entry (nodes classed `asset`): cards default, switchable to table.
- Pages list / Classes list use outline. **Graph view: future work — recorded here, not built** (needs its own portability decision per §34.18; v1's WebGL/SGE renderer is the reference).

**Modelling decisions (owner-approved 2026-10-01):**

1. **Core abstraction** — `apps/web/src/ui/views/`: view registry (`registerView`/`getViewDefinition`/`getViewModeOptions`, v1-pattern slimmed) + `NodeCollection` dispatcher + one component per mode. Input shape `NodeCollectionItem = { node: ClientNode; children?: NodeCollectionItem[] }` unifies tree contexts (child blocks/pages, references) and flat lists (classed nodes, tasks, assets, hubs). Flag subset ported: `editable`, `readOnly`, `pagesOnly`, `maxDepth`, `showBreadcrumbs`, `renderItem` escape hatch, `onNodeClick`/`onNodeShiftClick`, `tableColumns`, `empty`.
2. **Prose view** = v2's existing `nt-prose` display transform (editable, flattened chrome) — NOT a v1 `DocumentView` clone. Collapse-agnostic (owner refinement 2026-10-02): prose IGNORES session collapse state — `ProseView` passes `BlockRow` `ignoreCollapse`, every subtree renders, no chevron mounts; the collapse set is untouched, so outline restores hidden subtrees on return.
3. **Table cells**: read-only for text/number/date/node in this pass; **boolean + select inline-editable** via `client.setProperty` (task checkbox flows). Full inline editing = owed work.
4. **Child-blocks switcher placement**: slim right-aligned bar above the block tree (context-local; works in embedded/journal pages).
5. **No persistence**: view modes are session state (`useState`), reset on every load/reload — for nodes, system sections, hubs, everything. No device settings, no ops (zero protocol change → no GTK/Flutter lockstep owed for this feature).
6. M1 scope cuts (owed work, register-acknowledged): card cover layouts (§34.18 item 7), multi-column sort configurator (M1 = per-column header sort cycling), table property-column selector panel (default columns derived per surface: class bindings for classed nodes; task schemas for tasks), row checkboxes/selection, grouping (v1 groupBy), kanban/gantt/calendar/chart/pivot, query-block view-toggle alignment with the registry.
7. Naming rule applies: no archive-version names in code; mode ids are `outline | prose | cards | table`.

**Task list** (status updated as work lands; all tasks gate on `pnpm test` green):

- [x] **V1 Scaffold** — registry, types, `NodeCollection` dispatcher, `ViewSwitcher` (over the kit `SelectionButton` with `maxVisibleOptions` overflow) + `ViewToolbar`, token-only CSS. → `apps/web/src/ui/views/`
- [x] **V2 Views (tree paths)** — OutlineView (reuses `BlockRow` machinery, editable/read-only), ProseView (`nt-prose` wrapper), CardsView (first-level blocks as cards, children inside).
- [x] **V3 Child-blocks triad** — PageView wires the three modes behind the switcher bar; default outline.
- [x] **V4 Flat views + hubs** — flat outline rows + flat cards; Pages/Classes hubs via outline; Tasks hub (`/tasks`) with table default (task property columns: status/priority/scheduled/deadline/created).
- [x] **V5 TableView** — v1 port: Name/Classes/Created + property columns, per-column sort cycling, row windowing ("Show more"), bool/select inline editing, row click opens node, shift+click peeks.
- [x] **V6 Classed nodes** — ClassView section defaults to table (columns from class bindings), switcher with outline/cards; outline mode keeps the `class.unassign` action.
- [x] **V7 Assets hub** — sidebar entry + `/assets` route; card default, table switch. (Image thumbnails NOT shipped — owed work, see the future register.)
- [x] **V8 System sections through OutlineView** — child pages reuse the view. **Follow-up shipped (2026-10-01, second pass):** groupBy capability + references adoption — `CollectionGroup` (`types.ts`), `groupByContainingPage` (`grouping.ts`), collapsible grouped rendering in OutlineView (chevron toggle + header click opens the page); linked AND unlinked references now render through `NodeCollection` with `groups` + `renderItem` (breadcrumbs + editable `ReferenceSubtree` rows preserved), replacing the bespoke `ReferenceList` chrome (its dead CSS went with it). Tests: 3 new groupBy specs in `view-modes.test.tsx`; all 10 pre-existing system-section specs pass unchanged.
- [x] **V9 Tests** — `apps/web/test/view-modes.test.tsx` (8 tests): registry, triad over PageView, classed-nodes table columns, tasks hub (pages+blocks, sort cycling), assets hub; `class-view.test.tsx` updated for the table default.
- [x] **V11 Kanban (property-dimension groupBy)** — `KanbanView` registered (`apps/web/src/ui/views/KanbanView.tsx`): columns seeded from the options of the container's `kanbanProperty` (single-select schema) + a "None" column (empty/unknown values); cards reuse the flat `NodeCard`; dragging a card onto a column writes the property via `setProperty` (drop on "None" clears via `unsetProperty` — `applyKanbanDrop`, extracted for direct tests); empty columns render as drop targets; counts in headers. Offered by the tasks hub (status schema with the fixed seed id, else any select property a task actually carries — migrated workspaces) and by classed nodes (first bound select-with-options property); hidden when no usable schema exists. Session-local, like every mode. Tests: 3 specs (column grouping + drop write + clear, mode gating, classed-nodes availability).
- [x] **V12 View polish batch (2026-10-02)** — the §34.21 future register cleared in one pass:
  - **Kanban**: multi-select grouping (a card rides every column whose option it carries; drops merge values, None clears), collapsible columns (session), within-column card reorder (session order — persisting card order needs an order property, still owed), cover-layout toggle on the board.
  - **Table**: multi-column sort configurator (Sort panel: add/remove/direction/priority; header click stays the quick single sort); property-column selector panel (built-ins toggle + any workspace property as an extra column, session); full inline cell editing — text/url/email, number/integer, boolean, select, date (native date input → `ensureDateChain` → day-node reference), node (anchored NodeSelector pick); row checkboxes with a tri-state header box (`selectable`, session selection; bulk actions over the selection are a separate future feature).
  - **Cards**: cover layouts (no-cover / cover-top / cover-left / cover-right, the v1 placements) via a session toggle; imagery from the `cover` property or the node's own asset bytes, fetched once per asset through the new `client.getAssetDataUrl` (cached data URLs) — this also ships **asset card thumbnails**.
  - **Query-block alignment**: the query token's results render through `NodeCollection` (outline/table) with the registry `ViewSwitcher`; the token's `view: { mode }` record remains the persistence mechanism; the aggregate grid keeps its own table. `OutlinerReader` gained `listPropertySchemas` for the seam.
  - Tests: +9 specs in `view-modes.test.tsx` (multi-sort composition, column selector, text/number/date/node cell commits, selection, kanban multi/collapse, covers); `query-block.test.tsx` updated to the registry DOM (24 specs green).
- [x] **V10 Gate** — `pnpm -r build` + `pnpm test` green (web 322, cli 34, packages); §34.19 view-mode row updated below. (2026-10-02 note: the kanban re-run gates green in the view-mode scope — 67/67 across the 7 affected suites; the repo-wide web suite at that moment carried 12 failures in the parallel editor-session's files `outliner editor` / `node-link-gestures` / `marks-editing`, unrelated to this work and fixed on their branch. V12 re-gate 2026-10-02: full suite green — protocol 106, domain 21, export 31, store 147, sync 13, query 151, server 104, web 369, cli 34.)

**Shipped state (2026-10-01).** Mode ids `outline | prose | cards | table`; registry + `NodeCollection` dispatcher in `apps/web/src/ui/views/`; `CollectionHub` (`ui/components/CollectionHub.tsx`) is the hub shell (header + switcher + collection); switcher = `ViewToolbar`/`ViewSwitcher` over the kit `SelectionButton`. Defaults per owner rule: child blocks outline, classed nodes table, tasks table, assets cards, pages/classes outline. Table columns: class bindings for classed nodes; existing task schemas (authored on demand) for tasks; Name/Classes/Created otherwise. Session-only state everywhere (owner decision) — no persistence keys added. **Deployed 2026-10-01 via plain `docker compose`** (web image rebuilt with the new UI, `docker compose up -d`; Komodo untouched) — smoke `scripts/screenshots/verify-min.mjs` → VERIFY-PASS (boot 9s, sync idle, UI search hit, zero console errors; the new Assets nav entry visible in the shell).

**Future register (owed work, not this pass):** graph view (needs its own portability decision per §34.18 — v1's WebGL/SGE renderer is the reference; registry slot reserved); gantt/calendar/chart/pivot (+ timeline); kanban card-order persistence (needs a designated order property — within-column reorder currently session-only); multi-value property inline editing (multi text/select/date cells stay read-only); bulk actions over the table selection (delete/export of selected rows); saved views per section (ViewTabs, per §34.19 P1); per-surface view-mode persistence IF the owner reverses the session-only decision (device settings mechanism exists). Views-register detail for the saved-views/graph/gallery rows: **§34.31**; query-builder depth + shell-results detail: §34.30 M9/M10.

### 34.22 v1-level editor core — work record (owner directive 2026-10-01/02, in progress)

Owner directive (folding three messages): (1) node-link context menu in **every** view mode, not only edit mode; (2) edit mode renders node links as **atomic pills** — visually identical to read mode, single caret unit: arrow navigation selects the pill when the caret reaches it, Backspace/Delete with the pill selected (or with the caret adjacent) deletes the whole link; (3) context menus for the **sidebar recents and favorites** lists; (4) v1's Enter/Backspace/Delete/Tab block semantics (Roam/Logseq feel) plus v1's **treeEditMode** setting (direct vs logical outdent). Reference behaviors verified against the archive: `BlockList.tsx` (Enter split/first-child, merge guard `canMergeInHierarchy`, Delete-merge), `InlineNodeLinks.tsx` (pill click/dblclick/arrow-select/atomic delete, Enter-on-selected opens), `settingsStore.ts` (`treeEditMode`, default `logical`), `NodeContextMenu.tsx` (sidebar lists share the unified node menu).

**Owner decisions (2026-10-01):** port v1's conservative merge guard (same-parent childless, or only-child into its parent); Backspace on an empty block with children **promotes the children then deletes** (Roam/Logseq; v1 no-ops); Enter at start → **new empty block before**; `treeEditMode` default **logical**; wire extended now (see W1) rather than approximating.

**Modelling decisions:**
1. **Atomic pills are real DOM, not overlays** — the contentEditable holds interleaved text nodes and `contenteditable="false"` pill elements, mirroring the archived editor. Prose offsets stay the single coordinate system (a pill contributes its captured `text` length); only the DOM⇄prose mapping (`editor/selection.ts`), the DOM build, and caret placement change. All capture/mark/splice machinery is untouched.
2. **Wire extension W1 — `beforeId`.** "Place before" is impossible with `afterId`-only (fractional midpoints stay above the current minimum — provable), and both move payloads are `.strict()`. So `object.move`/`object.create` gain an optional `beforeId` (exactly one of before/after; defensive append when the anchor is not a current sibling). This is an additive payload field — the GTK/Flutter clients' strict schemas **reject envelopes carrying it until patched** (lockstep, see task W2).
3. **No new op types** beyond the W1 payload field; merges/promotions/splits compose from `object.update` + `object.move` + `object.delete`.
4. **treeEditMode is a device setting** (`notees.settings.treeEditMode`, default `logical`) via `deviceSettings.ts` — never an op (device state is never an op).
5. Read-only menu = one `NodeLinkMenuHost` (module-level opener, single mount at the app shell) + an `InlineTokens` mention-contextmenu prop; edit mode reuses the same host for identical items.
6. Sidebar lists compose the existing `ContextMenu` primitive with a small dedicated menu (Open / Open in sidebar / Copy link / favorites toggle / Remove from recents / Export… / Delete).

**Task list** (status updated as work lands; all tasks gate on `pnpm test` green):

- [x] **W1 beforeId wire** — `object.move`/`object.create` payloads (op-types.ts), store allocator branch (`midpoint("", first)` for before-first), client surface (`createObject`/`moveObject` + OutlinerClient), fixture `object-move-before.json` + store assertion, SCHEMA.md payload docs.
- [x] **W2 lockstep brief** — the exact additive branch GTK/Flutter must port (payload field + allocator midpoint-below-first + fallback), recorded here for the sibling repos.
- [x] **E1 atoms (DOM)** — editable DOM build (text runs + pill elements, quote-children included), DOM⇄prose mapping for element children, caret placement at pill boundaries, external-edit rehydrate.
- [x] **E2 atoms (interaction)** — v1 pill semantics: first click selects, second click caret by half, dblclick opens, arrows select/advance, Backspace/Delete atomic (selected + adjacent), Enter opens target, other keys clear the visual selection.
- [x] **E3 read-only menu** — `NodeLinkMenuHost` + `InlineTokens` wiring across block trees/embeds/references/query results/journals; same item set as edit mode.
- [x] **E4 sidebar menus** — recents + favorites rows.
- [x] **E5 outliner keys** — Enter split/middle, Enter-before (W1), Enter-with-children → first child (W1), Backspace merge with v1 guard, empty+children promote-delete, Delete-end merge, Tab indent.
- [x] **E6 treeEditMode** — logical outdent (reparent subsequent siblings), direct mode (status quo), UserSettingsModal → Editor toggle (SelectionButton, v1 labels).
- [x] **E7 tests** — atoms (render/keyboard/delete), read-only menu, sidebar menus, Enter/merge/promote/outdent matrix, setting toggle.
- [x] **E8 gate** — `pnpm -r build` + `pnpm test` green; §34.19 row 1131 (Link pills) updated; this section's shipped state written.

**Lockstep brief (W2) — owed to `notees-gtk@protocol-v2` + `notees-flutter@protocol-v2`:** add optional `beforeId: uuid` to the `object.move` payload (and `object.create` alongside the existing optional `afterId`) — additive, `.strict()`-visible. Applier: when `beforeId` is a current sibling of `parentId`, allocate the fractional position between the previous sibling's position and `beforeId`'s (no previous sibling → midpoint between the empty string and `beforeId`'s position, i.e. one slot below the first child); when `beforeId` is absent or not a sibling, fall back to the existing afterId-then-append path. If both before/after were ever present, afterId wins (web never sends both). Until this lands, m1 clients reject beforeId envelopes — do not mix old clients with a web client emitting beforeId.

**Shipped state (2026-10-02).** All tasks landed; the gate is green (`pnpm -r build` + `pnpm test`: protocol 106, domain 21, export 31, store 147, sync 13, query 151, server 104, web 360, cli 34). What exists now, beyond the task list:

- **Atom pills** (`editor/editable-dom.ts` + `BlockTextEditor`): the editable DOM holds interleaved text runs and `contenteditable="false"` pill elements; prose offsets stay the single coordinate system (a pill contributes its captured text length). DOM⇄prose mapping (`editor/selection.ts`) maps any position inside a pill to a boundary — at-content-end maps to the pill's end. Pill selection state is a validated `data-atom-key` (cleared on input; stale keys never act). Quote-nested mentions render as pills but are keyboard-inert (top-level-only, because a prose range inside a quote cannot be spliced structurally — same cut as the read-only menu, recorded here).
- **v1 pill gestures**: first click selects (mousedown blocks caret placement; the click owns selection so the same gesture can't read as a second click), second click clears and places the caret by half natively, double-click opens, arrows select/advance across consecutive pills, Backspace/Delete atomic (selected or adjacent), Enter opens, any other key clears the flash.
- **Outliner keys**: Enter split/start-before/first-child, guarded merges, promote-children delete — all composed from existing ops + W1's `beforeId` (Enter-before and first-child are now single `object.create` calls, no create-then-move).
- **`beforeId` (W1) is a wire change**: m1 GTK/Flutter strict schemas reject these envelopes until the W2 brief lands — do not run old clients against a web client emitting beforeId. Lockstep tags are the owed gate for "counts as done" per the owner's law.
- New tests: `editor-atoms.test.tsx` (12), `outliner-keys.test.tsx` (10), `sidebar-menus.test.tsx` (6), read-mode menu block in `node-link-gestures.test.tsx` (+4), store `beforeId` fixture test, protocol fixture-count 11.
- Sidebar row menus live in `SidebarItemMenu.tsx`; delete confirmation lives in `Sidebar` (a modal inside the menu would unmount with it).

**Lockstep shipped (2026-10-02).** W2 is done: `notees-gtk` and `notees-flutter` both carry the `beforeId` port (payloads, allocator branch with the below-first midpoint, applier plumbing, `object-move-before.json` fixture + replay/allocator tests) — committed, pushed to `main`, and released as **`v2.0.0-m2`** on both repos (GTK: GitHub Release with sdist + wheel + Arch package; Flutter: production-signed APK GitHub Release). CI green on both (GTK 427 passed / ruff / mypy; Flutter analyze clean / 379 passed). One flake note: GTK's realtime websocket test failed once on a close-code race unrelated to this change; re-run passed. The web client remains the only writer of `beforeId` ops (no client call site needs to send it yet) — receiving is what the lockstep guarantees.

**Signing identity note (2026-10-02).** The Flutter m2 tag release initially failed: the repo had NO signing secrets (m1's keystore material was no longer set). Per owner decision a NEW production keystore was generated (PKCS12, RSA-4096, 20-year cert, alias `notees`) and installed as the four `ANDROID_*` repo secrets. Consequence: **m2+ APKs carry a new signing identity — the m1-signed APK cannot be updated over in place** (owner accepted; m1 was never deployed to a device). Keystore material + passwords are stored host-local at `/root/notees-flutter-release.p12` + `/root/notees-flutter-signing.txt` (mode 600) — owner should copy them to durable secret storage.

**Resolution (2026-10-02, same day).** The first two tag-release attempts failed (secrets missing; then a distinct key password that the single-password PKCS12 keystore rejects). With `ANDROID_KEY_PASSWORD` aligned to the keystore password, the release job passed and the Flutter **`v2.0.0-m2` GitHub Release published the production-signed APK** (`notees-android-1.0.0+1.apk` + `.sha256`). GTK `v2.0.0-m2` published sdist + wheel + Arch package. Three-way lockstep for `beforeId` is now complete and released.

**Flutter setup-fix + web hardening (2026-10-02).** Root cause of "app won't connect": the app's server-setup ping used `/api/health`, but the sync server's health route is `/healthz` — 8377 answered 404 on a *healthy* server and blocked setup, while 8378 only "passed" because the web container's SPA fallback answers every path with index.html + 200. Fixes: (1) Flutter `pingServer` → `/healthz` + setup hint now shows the sync port (`http://<host>:8377`) — released as `notees-flutter v2.0.0-m3` (production-signed APK); (2) the web container's nginx returns 404 for `/api/*` instead of the index.html fallback (fails loud on misconfiguration) — rebuilt into `notees-web:latest` and redeployed (verified: `:8378/api/*` → 404, SPA + `:8377/healthz` → 200).

**v1-free API surface + m2 release (2026-10-02).** Owner directive: no v1 namespace in the v2 product. The entire REST API moved `/api/v1/*` → `/api/*` (server routes, web client, CLI, migration scripts, docs; relay stays `/api/relay/v2`). The Flutter client needed no change — its account calls were already written against `/api`. Server 104 / web / CLI 34 tests green; both images rebuilt and the host redeployed on pinned tags. The public tag `v2.0.0-m2` was created by the parallel session on an older commit and force-moved to the rename commit per owner instruction; the [GitHub Release](https://github.com/miquelrosell99/notees/releases/tag/v2.0.0-m2) publishes it. ghcr push still blocked (read-only login — parked decision stands); images tagged `2.0.0-m2` exist on the host and `.env` pins the compose deploy to them.

**Flutter v2-contract alignment (2026-10-02, `notees-flutter v2.0.0-m4`).** The login path carried v1-era shapes the strict v2 server rejects: `remember_me` in the login body (422 "unrecognized key"), `access_token` instead of the server's `token`, `/workspaces/:id/switch` POST (404), and the workspaces list read as `{items:[{uuid,…}]}` instead of `{workspaces:[{id,name}]}`. All batch-aligned; analyze clean, 379 tests green; signed APK released. **Known drift not in the login path (schedule later):** account register (`/auth/register` — v2 has `/setup` with different fields and only while `setupRequired`), 2FA verify (`/auth/2fa/verify` — absent in v2), shares and notifications endpoints (absent in v2).

**`notees-flutter v2.0.0-m5` (2026-10-02).** `User.fromJson` required v1 keys (`uuid`, `role`, `is_active`) that the v2 user object (`{id, email, displayName, name, surnames, avatarUrl, isAdmin}`) doesn't send — login crashed with "type Null is not a subtype of type String". v2 keys are now primary with legacy fallbacks; relay WS auth (`?token=`) verified against WIRE.md/server, so sync connects after login.

**Flutter mobile IA (2026-10-02, `notees-flutter v2.0.0-m8`).** Owner directive: mobile = quick reference + quick input; organization/classification stays on the web app. Reference sweep (Notion mobile home sections, Capacities' today-first daily note) shaped the IA. The Inbox tab became a **Home** tab: four glanceable sections — Today (daily-note card, Capacities-style), Favorites, Recent, Inbox (latest captures) — each skipped when empty, best-effort fetches, one scroll. Tabs are now Home / Tasks / Journal / Library + Search popup + capture FAB. Shared `NodeActions`/`SectionHeader` extracted; dashboard screen and the dead home-page setting deleted. m6 (effective icon/color), m7 (search popup + library restructure + breadcrumb rule) preceded it. Known v1-surface drift stands (register/2FA/shares/notifications).

### 34.23 Render-state model — `node_type` → (`is_class`, `present_as_main`) (owner directive 2026-10-02, in progress)

Owner directive: adopt the render-state model assessed 2026-10-02 (spec: `node_type` enum out; `is_class` + `present_as_main` in; envelope v3; classes become containers per spec I4; extends-ord deferred). Full decision text: **Revision 11** above; semantic rules, legacy-replay map, and migration shapes are normative there and in SCHEMA.md.

**Owner decisions (2026-10-02):** (1) envelope **`protocolVersion: 3`, accept only 3 — and NO backward compatibility** (owner directive, sole user): payload schemas reject the retired `nodeType` key outright, appliers carry no replay-compat code, and migration is a **one-time in-place rewrite of the stored relay log** (`scripts/migrate-node-type.mts`): `nodeType` → `presentAsMain` on object payloads (class-valued occurrences convert to `class.create` envelopes), `protocol_version` 2→3 on all rows, query-token AST conditions remapped, snapshots deleted, server-side derived stores rebuilt, `restore_epoch` bumped (every client wipes + re-syncs). Backup + `--dry-run` first. (2) **Classes are containers** — class nodes may have non-class children; guard = "no class under a class"; projection rule 1 deleted per spec §10. (3) **`class_extends.ord` deferred** — registered owed work, own lockstep round later. (4) **Deploy** — rebuild images, `docker compose up -d`, `verify-min.mjs` smoke after gates.

**Task list** (status updated as work lands; all tasks gate on `pnpm -r build` + `pnpm test` green):

- [x] **M1 protocol** — op-types.ts: `object.create`/`object.update` drop `nodeType` outright (strict rejection — no legacy key), gain optional `presentAsMain`; `PROTOCOL_VERSION = 3` (envelope.ts); query-ast.ts `nodeType` condition/sort/aggregation → boolean `isClass`/`presentAsMain`; fixtures: 6 files re-encoded (count stays 11, no legacy fixture) + rejection test pinning that a `nodeType` payload key fails validation.
- [x] **M2 store** — schema v8 (`node`, `present_as_main` columns + fresh DDL; v7→v8 migration rebuilds the node table with the class/page/block backfill — derived stores only, everything is rebuilt from the migrated log anyway); NO legacy applier map; appliers: create/update/move, class-under-class guard, flatten gate (`is_class OR present_as_main=1` ⇒ text-only; demotion does not un-flatten; create default `presentAsMain ?? (parentless ? 1 : 0)`); store.ts read surfaces (classes hub, main-children, backlinks filter, containing-node walk); errors.ts CHECK docs.
- [x] **M3 packages** — domain cascade helpers (`rendersWithDocumentChrome`); query compiler/dsl/README; export frontmatter/heading/manifest; sync snapshot paths verified riding `migrate()`.
- [x] **M4 gate** — packages green (protocol/domain/export/store/sync/query).
- [x] **M5 server+cli** — routes-objects API shape (`isClass`/`presentAsMain`), version literals → 3 everywhere, seed.ts, auth markdown-export filter; CLI `--presentAsMain`/`--isClass` surface + markdown-export mapping + shell.
- [x] **M5b one-time migration script** — `scripts/migrate-node-type.mts` (template: `migrate-title-is-content.mts`): `--dry-run` occurrence report, then in-place relay-log rewrite (object.create/update `nodeType`→`presentAsMain`; class-valued occurrences → `class.create` envelopes; `protocol_version` 2→3 all rows; query-token AST `nodeType` conditions/sorts/aggregations remapped), stale snapshots deleted, server-side derived stores rebuilt from the migrated log, `restore_epoch` bumped; backup before run. Run happens at deploy time (stack stopped). **Ran at deploy 2026-10-02** (VERIFY-PASS on the migrated stack; fresh snapshot seeded manually afterward — see the deploy addendum at the end of §34.32). Ticked in the §34.33 pass.
- [x] **M6 web** — render cascade (`App.tsx NodeView`); body = `present_as_main=0` + carrier exclusion; Child pages section → main-children (`present_as_main=1`); ClassView body + main-children (R1 for class parents; rule-1 code deleted); "Move to Pages / Move to content" intents + zone-aware drops (`block-dnd.ts`); query-builder conditions; labels/pickers/type chips; containing-node walk.
- [x] **M7 gate** — full monorepo green + web build.
- [x] **M8 GTK lockstep** — payloads/store/appliers/migration v7/UI cascade/fixtures re-port per the sweep checklist (no legacy-replay anything — strict rejection like the reference); tag **`v2.0.0-m3`** (CI publishes wheel/sdist/archpkg).
- [x] **M9 Flutter lockstep** — payloads/appliers/model/repository/migration v20/UI split per the sweep checklist (strict rejection like the reference); tag **`v2.0.0-m9`** (CI signs + publishes APK). Note: `lib/data/models/user.dart` dirty with unrelated auth WIP — leave uncommitted; do not tag over it without owner ok. *(Hold lifted 2026-10-02 — in progress.)*
- [x] **M10 docs+release+deploy** — SCHEMA.md normative rewrite + extends-ord owed entry; AGENTS.md (lead, invariants, lockstep row); this section's shipped state; query README; dev docs; user docs keep "pages/blocks" as render-state vocabulary; monorepo tag `v2.0.0-m3`; rebuild images; run the M5b migration against the stopped stack; `docker compose up -d`; `verify-min.mjs` → VERIFY-PASS.

**Explicit non-goals (this pass):** extends `ord`; extended mentions (`extra_content`); delete/orphan-to-inbox; `node_references` table (mentions stay content tokens); un-flatten on demotion; **backward compatibility of any kind** — no legacy payload keys, no replay-compat applier code, no vestigial columns; the stored log is rewritten once by M5b and everything re-syncs from it (owner directive, sole user).

**Flutter m9–m10 (2026-10-02).** m9: journal calendar Today shortcut + Sunday-label fix (the picker pre-existed), Home SafeArea/header inset fix, and the sonarly-style screenshot harness (`integration_test/screenshots_test.dart` driving the real app on a serverless sync engine with seeded nodes + `scripts/screenshots/run.sh`; runs headless via `flutter-tester`, PNGs on a real device/emulator). m10: **the grey box root cause** — `_buildRow`'s DragTarget builder captured the `content` local *by reference*; by build time it pointed at the DragTarget itself → infinitely deep widget tree → stack overflow → ErrorWidget across the whole block body (data-independent, that's why every content page was grey). Fixed with a pre-wrap final capture + up-front token parsing with an inline placeholder + cycle guards + unknown-token degradation. Also: Library became the browse hub (All pages/classes/journals, Archive, Trash) so Home vs Library no longer duplicate (owner confusion); device-local recents record on open (server order was `write_date DESC` — reads never surfaced) merged ahead of the server list; effective icon in the editor header + child-pages rows. 406 tests green; harness asserts the editor body actually renders.

### 34.24 Capacities-style export redesign — work record (owner directive 2026-10-02; Phase 1 SHIPPED 2026-10-03 — E1–E8 below, Phase 2/3 formats pending)

Owner directive (2026-10-02, assessment session): redesign node export to match Capacities — formats, layouts, and export modal — per the owner-provided Capacities export-modal screenshot and the [Capacities export docs](https://docs.capacities.io/reference/export); extend the same model to workspace export (every top-level page as its own file inside a zip, assets optional). This section is the handoff brief: it supersedes the export portions of §34.12 where they conflict (amendment recorded there), folds three SCHEMA.md owed-work deferrals into planned work, and sequences behind the §34.23 render-state migration (the `ExportNode` shape is mid-revision in the working tree — see Phase 0).

**Owner decisions (2026-10-02, this session):**
1. **PDF = direct `.pdf` download** (not browser print). Approved deps: **`@react-pdf/renderer`** (client-side render; bundle an OFL serif font for the typeset layouts — first real web-bundle deps alongside `fflate` + `docx`), **`fflate`**, **`docx`**. Server-side headless Chromium explicitly ruled out (sync-image bloat).
2. **Workspace export scope:** pages only — top-level pages AND their child pages, each its own file. Blocks are never standalone export roots (they live inside their page's file). Classes/tags are not exported as files.
3. **`GET /api/workspaces/:id/export` is REPLACED** by the zip endpoint (not kept alongside).
4. From the Capacities comparison (adopted): **human-readable filenames** — pages `<title-slug>-<uuid8>.md`, assets `<name>-<hash8>.<ext>` (identity stays in the uuid suffix + manifest, honoring "titles/paths are attributes, never identity"); **relative local links between exported files** (mention/embed/typed-link targets rewritten to `(<file>.md)` inside zips — "graph fully contained"); single-file exports keep today's `[[name]]`/`![[uuid]]` wikilink style.

**Current state (survey 2026-10-02, file refs for the implementing agent):**
- `packages/export` — pure Markdown-only engine (`nodeToMarkdown`/`bundleMarkdown`/`renderContent`, `src/markdown.ts:231-315`); BibTeX/CSL for sources (`bibtex.ts`, `csl.ts`). **No options parameter on any call.** Assets referenced by id only (`![asset](<uuid>)`, `markdown.ts:215`); no bytes ever bundled. `ExportNode` dirty-tree shape: `{id, isClass, presentAsMain, parentId, contentAst, classIds, properties}` (§34.23 M3 owns the cascade; consumers `apps/cli/src/markdown-export.ts:47-64`, `apps/server/src/routes-auth.ts:389-396`, `apps/web/src/ui/components/modals/exportSubtree.ts:41`, `apps/web/src/ui/QueryBlockView.tsx:277` migrate there).
- Web modal `apps/web/src/ui/components/modals/ExportPageModal.tsx` (715 lines) — registry-driven tabs (`registerExportFormats.ts` lists markdown/html/pdf/text/json; all but markdown honest-stubbed `:99-102`); gear-panel options (`:268-578`) of which **only `includeChildPages` reaches an engine**; QR button permanently stubbed; textarea preview; **batch download exports only the first node** (`:225-227`). `ExportPageTrigger.tsx` defined but unused (dead code). Triggers: `NodeContextMenu.tsx:131-138`, `PageView.tsx:442-459`, `NodeMenuButton.tsx:68-85`.
- Server `GET /api/workspaces/:id/export` (`apps/server/src/routes-auth.ts:382-440`) — one concatenated `.md`, **`properties: []` (dropped)**, no assets, no options.
- CLI `notees export markdown` (`apps/cli/src/cli.ts:914-939`) — loose `<uuid>.md` + manifest to a dir; no assets flag; default `--depth 3` truncates silently; child order = id order (documented deviation, `markdown-export.ts:204-226`).
- Assets: per-asset authenticated `GET /api/assets/:id` (`apps/server/src/assets.ts:183`, Range-capable); client `fetchAssetBlob` (`apps/web/src/core/workspace-client.ts:478-487`); `asset_ref` content token (`packages/protocol/src/content-mark.ts:105-110`); **no batch endpoint, no zip library anywhere in the workspace**.
- No store roots query — `listPages()` (`workspace-client.ts:711-720`) returns all pages incl. nested; consumers filter `parentId === null` by hand (`Sidebar.tsx:199-203`, `App.tsx:1403-1404`).

**Gap register (disposition per item; "missing" = no answer today, "change" = exists but must change):**

| # | Gap | Kind | Disposition |
|---|---|---|---|
| 1 | PDF export engine | missing | Phase 2 (`@react-pdf/renderer`) |
| 2 | Word `.docx` | missing | Phase 3 (`docx`; skip legacy `.doc`) |
| 3 | LaTeX | missing | Phase 3 (template serializer; reuse `bibtex.ts`/`csl.ts` source mapping) |
| 4 | HTML serializer | missing | Phase 2 (render base for layouts/docx) |
| 5 | Layout templates (Notes/Essay/Academic) + A4/Letter | missing | Phase 2 (render themes; LaTeX gets article/two-column class variants) |
| 6 | Engine options model | missing | Phase 1 (options bag on every serializer) |
| 7 | Asset bundling (bytes, human-readable names, relative refs) | missing | Phase 1 (workspace zip + node-level include-assets) |
| 8 | Zip capability | missing | Phase 1 (`fflate`; server streams, client zips node exports) |
| 9 | Workspace zip-of-pages export | missing | Phase 1 (replaces `GET /export`) |
| 10 | Store roots query (`parent_id IS NULL`) | missing | Phase 1 (additive read surface in `packages/store`) |
| 11 | Relative link rewriting between exported files | missing | Phase 1 (zip exports) |
| 12 | Batch node export (multi-node → zip) | missing | Phase 1 (modal `nodeUuids` batch actually zips) |
| 13 | CSV export for query/tag/class views | missing | **Parked** (later; cheap via `packages/query`) |
| 14 | Selection-scoped export (table/list selected rows) | missing | **Parked** (pairs with §34.21 selection bulk actions) |
| 15 | Scheduled/automated export | missing | **Parked** (self-hosted fit: server cron → zips in `./config/notees/`; needs no protocol) |
| 16 | Modal rebuild (format/layout cards, collapsible options, right-aligned Export) | change | Phase 1 |
| 17 | `exportFormatRegistry.ts` metadata-only | change | Phase 1 (add `availability` + per-format options schema; modal renders from data) |
| 18 | `ExportPageTrigger.tsx` dead code | change | Phase 1 (wire or delete) |
| 19 | Markdown engine: no options, no escaping, depth cap 24 + silent truncation, id-order children, whiteboard/query human-opaque | change | Phase 1 (options + escaping + full-closure default + position order); SCHEMA.md owed-work closures |
| 20 | Server export route: single file, properties dropped | change | Phase 1 (replaced by zip; properties wired) |
| 21 | Manifest uuid-keyed only | change | Phase 1 (uuid↔human-readable-path map) |
| 22 | Per-asset N+1 fetch | change | Phase 1 client (concurrency-limited fetcher); batch endpoint only if profiling demands |

**Modelling decisions:**
1. **Engine shape** — one `ExportDocument` IR (title, blocks, properties with schema names, children tree, asset refs) built per node subtree; per-format serializers consume the IR. Typed options bag: `{ includeEmbedded, includeOutline, hideEmptyProperties (default ON), showTypeLabels, pageFormat: "a4"|"letter", includeAssets }`, gated per format (outline: pdf/docx/html only; pageFormat: pdf only; includeAssets: markdown/zip only).
2. **PDF** — `@react-pdf/renderer` client-side, three layout themes as component variants (Notes = app styling w/ colors+embeds, Essay = single-column typeset, Academic = two-column numbered headings); A4/Letter = page-size prop; assets as data URLs. Direct download via existing `downloadBlob` pattern.
3. **Modal** — Capacities structure from kit primitives only (`Card` format/layout cards, `Checkbox` option rows, `SelectionButton` A4/Letter, `Modal` + right-aligned `Button` Export): format cards (unavailable formats render disabled, not stub-message tabs), layout cards only for layout-aware formats, collapsible Options, keep Markdown live preview (+ PDF viewer preview if cheap). Delete QR stub, dead presets, and settings that reach no engine. `docs/` screenshot-level parity is NOT required — Capacities is the interaction reference, RosellRamos tokens are the skin.
4. **Workspace zip (server-side)** — `GET /api/workspaces/:id/export.zip?includeAssets=0|1` (replaces `GET /export`): `fflate` streaming zip; enumerator = new store roots query + descendant pages (blocks stay in their page's file); one `<title-slug>-<uuid8>.md` per page; `assets/<name>-<hash8>.<ext>` folder when included (CAS read is local disk — no N+1 server-side); mention/embed/typed-link targets rewritten to relative `.md` links; `notees-manifest.json` maps uuid ↔ path/type/display name; properties frontmatter wired (closes the `properties: []` gap). De-dupe filenames; slug fallback to uuid8 for empty/duplicate titles.
5. **Node-level include-assets** — modal option for Markdown: client walks subtree AST for `asset_ref` tokens + asset-class nodes (`getAssetInfo` by node id), fetches bytes concurrency-limited via `fetchAssetBlob`, zips via `fflate`, rewrites refs to `assets/…` relative paths. Multi-node batch always zips (single node stays plain-file download unless assets included).
6. **No protocol/wire change → no GTK/Flutter lockstep owed** (export is derived read-only output). Sole API addition: position-aware `GET /objects/:id/children` (closes the id-order deviation + SCHEMA.md deferral; additive REST, not wire).
7. **Docs are part of the change** (owner rule): each phase ships `docs/usage.md` + `docs/ux.md`, `packages/protocol/SCHEMA.md` (incl. closing the three export deferrals at SCHEMA.md:18 and the new formats/options spec), AGENTS.md lead (`packages/export` line) when formats land, and `.plans/dev/` updates — in the same pass as the code.

**Task list** (status updated as work lands; every task gates on `pnpm -r build` + `pnpm test` green):

- [ ] **Phase 0 — prerequisite gate** — §34.23 landed through M4 (export package + consumers on the `isClass`/`presentAsMain` shape); working tree clean of the half-migrated `ExportNode`. Do not start Phase 1 on the dirty shape.
- [x] **E1 IR + options model** — DONE 2026-10-02: `ExportDocument` IR (`packages/export/src/document.ts` — blocks/spans, resolved properties + classNames, outline tree, assetRefs, whiteboard listing); typed options bag + gated catalog (`options.ts`); package-side format registry (`formats.ts`) — markdown implemented, html/pdf/docx/latex registered unavailable with their landing-task reasons; `nodeToMarkdown`/`bundleMarkdown` take the optional bag (defaults = hardened E2 behavior). Web registry delegation is E3.
- [x] **E2 Markdown hardening** — DONE 2026-10-02/03: metacharacter escaping (closes SCHEMA.md deferral 1: inline specials, line-start block constructs, mention/verb/locator/link-text contexts, fence lengthening; emitted conventions stay raw); full-closure default (MAX_CHILD_DEPTH silent truncation retired; cycle + explicit `maxDepth` cuts render as visible `![[uuid]]` bullets); options hideEmptyProperties (default ON) / showTypeLabels (`classNames:` frontmatter line) / includeEmbedded (ctx.nodeOf inlining, cycle-guarded) / includeOutline; whiteboard sidecar files when bundling (closes deferral 3: `<uuid>.whiteboard.json` + file link; inline fenced json stays the single-file default); slug filename policy + manifest `path`; position-aware child order via new `GET /objects/:id/children` endpoint (closes deferral 2 — route returns `fullObject` projections over the store's position-ordered `children()`, active-only, 404 on missing parent; CLI `buildMarkdownBundle` now BFS-fetches children per exported tree — strictly fewer API calls than the old workspace-wide scan — with bullet order = child position; web was already position-ordered through the store). Server +2 specs, CLI +2 specs, full gate green (1086 tests).
- [x] **E3 Web registry + modal rebuild** — DONE 2026-10-03: web registry (`registerExportFormats.ts`) delegates to the package catalog — `WebExportFormatDefinition` = id/label/icon/availability (verbatim from `@notees/export`)/mimeType/extension/`options: WebExportOptionSpec[]`; adding a format = one package definition + one `WEB_DELIVERY` row. Old mutable-map registry and the text/json stubs deleted; `ExportPageTrigger.tsx` dead code deleted (triggers live in NodeContextMenu/PageView/NodeMenuButton). Modal rebuilt per modelling decision 3 (~715→~330 lines, kit primitives only): format `Card`s in a radiogroup (markdown selectable; html/pdf/docx/latex `aria-disabled` cards showing the registry reason — no stub tabs), collapsible Options section (disclosure + `Checkbox` rows driven by `format.options`, package defaults), read-only live markdown preview, right-aligned Export; QR/presets/gear-panel deleted. Batch fixed: multi-node export collects every root's subtree via `exportSubtreeBundle` (slug policy + sidecar whiteboards) → `zipExportBundle` (`zipSync`, collision de-dupe with manifest kept in agreement, manifest v2, `downloadBlob` as `<first-title-slug>.zip`); single node stays one `.md`. `fflate` web dep. Modal specs rewritten (6: preview, disabled reasons, options reach the engine, single .md blob, batch zip verified via unzipSync). Gate green (1113 tests). Deviations recorded: jsdom `Blob.arrayBuffer` missing (specs use FileReader); aria-disabled asserted by attribute.
- [x] **E4 Store roots query** — DONE 2026-10-03: `Store.roots(workspaceId)` (`packages/store/src/store.ts:214` — active non-class parentless rows, `ORDER BY COALESCE(name, id), id` matching `listPages`); seam on both clients (`WorkspaceClient.roots`, `WorkerClient.roots` + worker-core dispatch; `OutlinerReader` gains `roots()`). Consumers: the real hand-rolled filter was `App.tsx` HubView (Pages/Inbox hubs) — now `client.roots().filter(!asset)` (date-chain day/month nodes no longer leak into the Pages grid; subpages stay reachable via parent Pages zones). The §34.24 premise "Sidebar.tsx:199-203" was stale — that line is the favorites/recents byId pool, never a roots listing; switching it would drop favorited subpages from the sidebar (a UX regression), so it deliberately stays on `listPages()`. Store +2 (both adapters), web +5 specs, full gate green (1102 tests).
- [x] **E5 Server workspace zip** — DONE 2026-10-03: `GET /api/workspaces/:id/export.zip?includeAssets=0|1` (old `/export` deleted — verified 404; strict query schema, 422 otherwise). Enumeration = `store.roots` + cycle-guarded main-zone DFS (blocks never standalone; classes never exported); one `<title-slug>-<uuid8>.md` per page (`assignExportPaths` — uuid8 fallback, deterministic de-dupe; `reassignExportPaths` keeps bundle files/manifest/links agreeing under collisions); properties frontmatter wired via the exported `fullObject` projection (closes the `properties: []` gap); `notees-manifest.json` v2 (`type: "page"|"class"` added); whiteboard sidecars ride in the zip (E2 naming); `includeAssets=1` walks page+inline closures for `asset_ref` ids → `assets/<name>-<hash8>.<ext>` CAS bytes (missing bytes keep the raw uuid ref). Relative-link rewriting: `ExportContext` gains `linkTarget` (mention spans carry `linkPath`; embed blocks carry `{name,path}` — inlined embeds keep precedence) and `assetPath` (asset blocks) hooks, resolved at IR build time; typed links carry no resolved target (record-don't-resolve) — nothing to rewrite, recorded in the context doc comment. Web `exportWorkspace` re-pointed at the zip (E6 polishes the UI). `fflate ^0.8.2` server dep. Export +7 specs (incl. an `assetRefs` subtree-coverage fix — child-stream accumulators were previously dropped), server +3 zip round-trip specs (unzipSync: file set, slugs, manifest, relative mention link, frontmatter, collisions, assets). Full gate green (1111 tests). Follow-ups: cover/image-property assets in zip exports; pre-existing non-gate `tsc` nits in apps/web (calendar-view-utils test) and apps/cli (bootServer `loginPerMinute`) — both clean in git, outside the blocking gate.
- [x] **E6 Workspace export UI** — DONE 2026-10-03: `WorkspaceExportModal.tsx` (new, kit-composed: `Modal` + `Checkbox` "Include asset files" default-off + format note + Cancel/right-aligned Export `Button` with built-in loading spinner; presentational `{isOpen, onClose, workspaceName, isLoading?, error?, onExport(includeAssets)}` per the `WorkspaceNameModal` convention; in-modal `role="alert"` error line, replacing the old list-level error hijack). `exportWorkspace` gains `options` and always sends `?includeAssets=0|1`. `WorkspacesView` card-menu Export opens the modal; success downloads + closes. +3 specs (URL param, busy state via held fetch, in-modal error).
- [x] **E7 Node-level include-assets zip** — DONE 2026-10-03: additive `fetchAssetBytes(assetId): Promise<Blob>` on both clients (engine holds the client, not REST config); `collectSubtreeAssetRefIds` (typed scan over root + inline descendants + child-page subtrees, mirroring the E5 server walk); `fetchSubtreeAssets` (inline order-preserving 4-way concurrency pool, no new dep; unfetchable assets keep the raw uuid ref, export never fatal); `assets/<original-name-slug>-<hash8>.<ext>` naming — the content hash is already in the local `node_asset` row, so the E5 server convention is mirrored exactly (~15 lines duplicated web-side with a pointer comment — candidate for a shared package helper); `zipExportBundle(bundle, assets?)` + the package `assetPath` hook threads relative ref rewriting (preview keeps uuid refs per the single-file convention). Modal: `includeAssets` rides the registry option mechanism (`UI_OPTION_KEYS`), markdown-only, default off; enabled export = zip delivery (`<slug>.zip`), batch scans every root. +3 specs (zip + rewritten ref + bytes, 404-asset fallback, batch scan); the 6 pre-existing modal specs are the option-off regression cover. Gate green (1119 tests).
- [x] **E8 Phase-1 docs + gate** — DONE 2026-10-03: usage.md "Exporting" section (node modal, workspace zip, CLI) + `export.zip` API-table row; ux.md "Exporting" section + feature-table row; SCHEMA.md:19 zip conventions + options bag (normative); AGENTS.md `packages/export` lead; architecture.md routes/CLI/file-map; shipped state below. Gate: `pnpm -r build` + `pnpm test` green (1119 tests).
- [x] **H1 HTML serializer** — DONE 2026-10-03 (commits b632f050; predates the archive-inspection standing rule — benchmarked on the Capacities reference, v1's `app/features/export/` renderers not mined): `renderExportDocumentToHtml` (`packages/export/src/html.ts`) — complete standalone document (doctype/head/embedded token-mirroring `--nt-*` stylesheet with `@media print` rules, zero external resources), properties `<dl>` (hideEmpty/showTypeLabels), all span/block mappings with full HTML escaping, outline nested lists, layout body-classes (essay serif / academic two-column via CSS columns). Options bag gains `layout` (pdf/docx/html/latex, default notes). html flips available package-side; +33 specs.
- [x] **P1 PDF direct download** — DONE 2026-10-03 (commit df7a2f0e; Capacities-benchmarked, archive not mined): `@react-pdf/renderer` 4.9 web-side only (package stays pure — web registry marks pdf available with `delivery: "client-pdf"`; the package skeleton remains, reason reworded by this docs pass). **Gentium v7** (SIL OFL, four static TTFs + OFL.txt vendored at `apps/web/src/assets/fonts/` — no runtime CDN). Three layout themes (Notes = app-token palette, Essay = single-column typeset, Academic = two-column numbered headings), A4/Letter via `pageFormat`, assets as data URLs via `getAssetDataUrl` (4-way pool), iframe live preview, batch = zip of per-root PDFs. **Bundle discipline verified**: pdf engine = 1.24 MB async chunk (`renderPdf-*.js`) loaded only on first PDF export; main chunk +8.4 kB; fonts are static assets referenced solely by that chunk. +17 specs incl. a real-renderer suite (real TTFs validate fontkit parsing). Gate green (1233 tests).
- [x] **P2 Phase-2 docs + gate** — DONE 2026-10-03 (this pass): ux.md PDF/layout/preview lines; SCHEMA.md format table; H1/P1 entries + shipped state here; gate green.
- [x] **D1 Word `.docx`** — DONE 2026-10-03 (commit 6fa63362; predates the archive rule): `renderExportDocumentToDocx` (`docx.ts`, `docx ^9.8.1` — isomorphic) — Title heading under the chrome predicate, properties as borderless table, custom Quote style, outline bullets with depth, layouts via docDefaults font (notes Calibri / essay·academic Georgia), A4 fixed, `pageFormat` deliberately unconsumed (pdf-gated, spec-pinned). Registry `serialize` widened to `SerializedExport = string | Uint8Array | Promise<…>` (additive). Specs unzip the package via fflate and assert document.xml/styles.xml structure. +29 specs.
- [x] **L1 LaTeX** — DONE 2026-10-03 (commit 2c0d2c4a; predates the archive rule): `renderExportDocumentToLatex` — single-pass `escapeLatex` (kernel macros; a sequential-replace draft re-escaped `\textbackslash{}`'s braces — the goldens caught it), ulem `[normalem]` (bare ulem redefines `\emph`), xcolor `\colorbox` highlight mirroring the HTML token, math verbatim in `$…$`, outline `itemize` with visible cuts, academic = `twocolumn` class variant (decision 5 — LaTeX has no Notes/Essay theme). Sources collect via the exact csl.ts `sourceClassOf` predicate → `thebibliography` with citekey-or-id keys, only when ≥1 source. IR children gain resolved title/classIds/properties (additive). 23 golden exact-equality specs. No LaTeX engine on the host — compilability rests on review (kernel/standard packages only); a compile smoke-test remains a follow-up.
- [x] **P3 Phase-3 docs + gate** — DONE 2026-10-03 (this pass): usage/ux export sections (four file formats + PDF layouts), SCHEMA.md formats/options, AGENTS.md leads, architecture.md file-map, shipped state below; full gate green. (LaTeX/Word layout parity note: layouts apply as template variants, not CSS.)

**Parked register (recorded, not this work):** CSV view export; selection-scoped export; scheduled/automated export (server cron → `./config/notees/`); batch asset endpoint (only if client N+1 proves slow); workspace **PDF** bundle (zip is markdown+assets only — PDF stays a per-node format); JSON archive Tier-1 backup export (§34.12, separate track); re-import round-trip harness for the new zip layout (§34.12 exit criterion still owed — pairs naturally with E5 when built).

**Explicit non-goals:** legacy `.doc`; server-side PDF rendering; exporting classes/tags as standalone files; block-roots in workspace export; any protocol/wire change or client lockstep; parity with Capacities' automated-export scheduling (parked, not refused).

**Shipped state (2026-10-03) — Phase 1 complete (E1–E8), gate green (1119 tests).** All Phase-1 tasks landed: the `ExportDocument` IR + options bag + package format registry (`packages/export`); Markdown hardening (escaping, full closure, sidecars, slug/uuid filename policy, position-aware child order via `GET /api/objects/:id/children`); the web registry + `ExportPageModal` rebuild (data-driven format cards with disabled-reasons, options checkboxes, live preview, batch → zip; dead trigger/registry deleted); `Store.roots` + both client seams (Pages/Inbox hubs use it); the server workspace zip (`GET /api/workspaces/:id/export.zip?includeAssets=0|1`, old `/export` deleted — slug filenames, manifest v2, properties frontmatter wired, relative link rewriting via the `linkTarget`/`assetPath` context hooks, optional CAS assets folder); the workspace export modal (include-assets toggle, busy + error states); node-level include-assets zips (concurrency-limited client fetch, `assets/<name>-<hash8>.<ext>`, relative ref rewriting). Docs in the same pass: `docs/usage.md` (Exporting section + API table row), `docs/ux.md` (Exporting section + feature-table row), `SCHEMA.md:19` (zip conventions + options bag, normative), `AGENTS.md` (`packages/export` lead), `.plans/dev/architecture.md` (routes/CLI/file-map). Deploy is the owner's step (rebuild images + compose up + `verify-min.mjs`); no wire change → no GTK/Flutter lockstep owed. New follow-ups registered: cover/image-property assets in zip exports (E5/E7 scan `asset_ref` tokens only); the shared package helper for the duplicated asset-zip-naming rules (web/server); the zip re-import round-trip harness stays parked (pairs with the §34.12 exit criterion). H1/P1/D1/L1 (HTML/PDF/Word/LaTeX) landed 2026-10-03 — **§34.24 is complete end-to-end (Phases 1–3)**. The format set: markdown/html/docx/latex serialize package-side over the `ExportDocument` IR (escaping-correct, layout-aware via the `layout` option); pdf renders client-side in the web app (`apps/web/src/ui/export-pdf/`, code-split, local OFL Gentium) behind the registry's `delivery: "client-pdf"` seam. The web modal delivers every format (single file or batch zip) with live preview (markdown + pdf). All tasks pre-date the archive-inspection standing rule (recorded at the top of this plan) — they were benchmarked against Capacities; a v1-comparison pass against `v1-archive`'s `app/features/export/` remains available as inspiration follow-up. Follow-ups carried forward: cover/image-property assets in zip scans; shared asset-zip-naming helper; LaTeX compile smoke-test (no engine on the host); PDF preview renders on debounce (fine at self-hosted scale). Next scheduled per the registers: §34.25 templates (owner decisions D1–D4 first). **Gate addendum (same day, later run):** the tree later accumulated a parallel session's in-flight CLI work (auth/class-remap commands + specs, uncommitted) whose two newest specs fail deterministically against their own hardcoded fixture workspace (relay ingest 404 / auth logout exit 3) — outside §34.24's scope (all export/server/store/web suites and the 8 CLI markdown specs green; full suite green at 1119 tests when Phase 1 completed). The parallel session owns those failures. **Live-verification addendum (2026-10-03, deploy of m5):** the post-deploy `export.zip` check against the owner's real workspace exposed a filename defect — every page rendered `<slug>-00000000.md`, because the "uuid8" suffix was `id.slice(0, 8)` and v1-derived deterministic ids (date chains `00000000-0000-0000-00bb-YYYY…`, fixed system seeds) zero-run at the front; the old prefix also collided for ids sharing 8 chars. Fixed: the suffix is now an FNV-1a hash of the full id (pure, dependency-free, works in the browser bundle) — `exportFileName` (`packages/export/src/bundle.ts`), specs re-pinned to shape assertions (hash-value-coupled expectations retired; the crafted-collision zip spec became a `reassignExportPaths` unit spec — the de-dupe machinery is now defensive-only, unreachable through the zip route). Also observed (working-as-specified, owner call): the workspace zip includes the full year/month/day chain as page files (5,657 files on the real workspace) — exclude date-chain/system-seed roots from the zip enumerator if unwanted. Deployed as 2.0.0-m5 — images built locally (ghcr push remains blocked: read-only host token, fresh `permission_denied` evidence), `.env` pins at m5, stack healthy, `verify-min.mjs` VERIFY-PASS, live `export.zip` verified.

### 34.25 Templates — design brief & work record (Capacities comparison, 2026-10-02, PENDING — scheduled behind §34.23, after §34.24)

Comparison of Capacities' template system ([reference docs](https://docs.capacities.io/reference/templates), verified 2026-10-02) against Notees, and the implementation handoff. This section is the source of truth for templates: it supersedes the one-line proposals in `01-knowledge-model.md` §6, `02-model-assessment.md` §5/§9, and the `00-INDEX` deferred item 3 (all updated to point here), and collapses the SCHEMA.md:25 owed-work open question ("`has-template` placement") into concrete decision points **D1-D4** (owner to confirm before code).

**Capacities model (the reference):** a template = prefilled properties + blocks bound to exactly one object type (daily notes, pages, custom types), edited as a blank canvas with the full block editor; applied four ways — bottom-of-empty-object picker, `+ New`, `Cmd/Ctrl+U` + name, `/name` slash in a page (create + apply in one shot); referenced objects (tags, select values, links) are **linked, never duplicated**; `{date:...}` variables in titles substitute at apply time.

**Archive mining (standing rule, 2026-10-03 — `v1-archive`, full report in session):** v1 shipped templates as ordinary pages carrying the `template` class (UUID `…0001-000000000013`, icon `mdiFileDocumentOutline` — v2's seed icon slot matches), with `{{name}}` static + `<%name%>` dynamic variables substituted **client-side at instantiate**, a main-view TemplateGallery ("New template" → classed page; row menu "Use template"), a `/template` slash flow that reopens the class-filtered node picker, and a variable dialog (editable static rows + readonly computed dynamic rows — a UX split worth porting). v1's gaps the v2 brief already closes: **no subtree cloning** (multi-block templates collapsed into one block — the decisive argument for the T1 clone engine), append-at-end ordering (v2's `beforeId` m2 is the fix), silent-empty missing variables, UTC `today` bug, whole-AST string substitution, no class binding / apply-to-existing / duplicate. **Brief correction:** the "(v1 `Cmd/Ctrl+U` analog)" attribution is wrong — v1 had no such binding (its only Ctrl+U is underline); the keyboard gesture is Capacities-derived, new in v2. **Ports adopted:** dual-regex+Set-dedup extraction, the static/dynamic dialog split, the slash boundary rule + class-filtered picker-reopen pattern, the strip-the-marker-class rule (instance classIds = template's minus `template`), local-date `today`.

**Current state (survey 2026-10-02, file refs for the implementing agent):**
- `template` system class exists as a bare seed — `packages/domain/src/seeds.ts:24` (icon `:66`), seeded into every workspace via `SEEDED_SYSTEM_CLASSES` (`seeds.ts:221` → `apps/server/src/seed.ts:26-42`). No ops, no client API, no UI anywhere (all other "template" hits are grid-template CSS / regex noise).
- Proposal on record: `has-template` node-typed property on class nodes → template node; instantiation clones content + children (`01-knowledge-model.md:69`; `02-model-assessment.md:52,94`; `00-INDEX:44`; `SCHEMA.md:25`). Owner never confirmed; cardinality, direction, and clone semantics were unspecified until this brief.
- Wire primitives all present — nothing to add for the recommended path: `object.create` single-node with `contentAst` + `parentId` + `afterId`/`beforeId` (`packages/protocol/src/op-types.ts:18-55`; `beforeId` = the m2 sibling-placement extension, fixture `object-move-before.json`); `propertySchema.create` with `multi` (`op-types.ts:236`) and `targetClassFilter` (`:240`); `property.set` ordered multi-values via `idx` (`:266-275`); `class.property.set` per-binding `defaultValue` (`:194-204`); class/tag OR-Set membership by re-issued `object.create` (`apps/web/src/core/workspace-client.ts:1434-1447`).
- Content model: flat `contentAst` token stream; the blocks tree lives in `parent_id` edges; pages/classes text-only (flatten gate, `packages/store/src/appliers.ts:267-272`). Embed rule: "RENDER THE LIVE SUBTREE, NEVER A CLONE" (`packages/protocol/src/content-mark.ts:112-116`) — load-bearing for A3/D3 below.
- Multi-write composition precedents: `createAnnotation` (`workspace-client.ts:364-395` — the shape to generalize); CLI BibTeX import (`apps/cli/src/cli.ts:576-627`, specs `packages/export/src/csl.ts:340-372`); v1 migration batch pushes (`scripts/migrate-v1/migrate.py:321-338,470-471`).
- No clone/duplicate engine exists; `DuplicatePageModal` is same-name page-create conflict resolution, not duplication (`apps/web/src/ui/components/modals/DuplicatePageModal.tsx`).
- UI: Class View "template slot" is designed chrome only (`docs/ux.md:30`); nothing in `apps/web/src/ui/views/`. Parity row: §34.19 P0 (Templates: `{{variables}}`, TemplateGallery, slash instantiate, TemplateVariableDialog — all ❌); slash instantiation folds into the §34.19 slash-commands row (`:1133`).

**Gap register** (A = missing, B = exists but must change; dispositions reference the task list below):

| # | Gap | Kind | Disposition |
|---|---|---|---|
| A1 | Instantiation pipeline (read template subtree → clone → compose ops) | missing | T1–T2 |
| A2 | `has-template` system property — new fixed UUID in `SYSTEM_PROPERTY_UUIDS` (`seeds.ts:114-144`), seeded `propertySchema` (`type: "object"`, `multi`, `targetClassFilter` → template class) | missing | T2 — data-seed level, additive, no fixture gate |
| A3 | Link-vs-clone semantics per reference — `typed_link`/`mention`/`class_chip` keep their target; tags re-issued (OR-Set add-wins); node-typed property values copy the reference; `asset_ref` re-points at the same CAS asset; `embed_ref` → D3 | missing (spec) | T2 — written into SCHEMA.md **before** code |
| A4 | Apply-to-existing-object (Capacities' bottom-of-empty-object prefill; merge without duplicating blocks a partial earlier apply already created) | missing | T4 |
| A5 | Variables — apply-time string substitution inside text tokens (title-is-content: there is no title field, variables live in content tokens). Live/reevaluating tokens rejected (new token type = lockstep cost) | missing | T4 |
| A6 | Invocation surfaces — TemplateGallery, `/name` slash instantiate, keyboard create-with-template (v1 `Cmd/Ctrl+U` analog) | missing | T3 |
| A7 | Class View template slot UI (`docs/ux.md:30`) | missing | T3 |
| A8 | Atomicity — a 50-block template = 50 envelopes; interrupted sync = half-instantiated object; UUIDv7-only identity rules out deterministic child ids, so a naive re-apply duplicates | missing | Measured follow-up T5 only; wire subtree op = separate owner decision (lockstep cost) |
| B1 | `object.create` single-node | change (eventually) | Hold — client composition first (T1); subtree op last resort (T5) |
| B2 | `defaultValue` on class bindings overlaps template property prefill — precedence undefined | change (spec) | D2 decision; spec in SCHEMA.md; T2 |
| B3 | `template` seed class — relation direction, gallery-facing bindings (icon/color conventions) | change (design) | D1 decision; T2 |
| B4 | `DuplicatePageModal` misnomer — shares the clone engine once it exists | change | T1 builds the engine; T4 resolves the modal (rename or real duplicate gesture) |
| B5 | `createAnnotation` composition pattern | change (generalize) | T1: shared `instantiateTemplate`/`cloneSubtree` client primitive |
| B6 | Ordered multi-envelope batches exist only in the migration push | change (verify) | Spike inside T5: does SyncEngine expose ordered-batch application? If yes, A8 narrows with no wire change |
| B7 | `beforeId` placement (m2) | none needed | T1 uses it to reproduce child order deterministically on every replay |
| B8 | Docs-in-same-pass rule (owner) | standing | Every task ships SCHEMA.md + `docs/ux.md` + `docs/usage.md` + this section's state |

**Owner decision points (confirm before code; recommendations recorded):**
- **D1 — relation direction & cardinality.** Recommendation: `has-template` lives on the **class** node (Capacities' "templates belong to one object type"), `multi: true` — Capacities allows N templates per type and the wire already supports it. **AMENDED by owner 2026-10-03 (T3 pause):** direction confirmed — the class-level `has-template` assignment stays ("assigned to a class at the class level, so any node that gets that class gets that template applied"). Two additions: (a) **provenance** — generated nodes carry a `generatedFrom` reference to their template (single node-typed property on the generated node; o2m from the template's view via the edge index, so a template page can list "generated with this template" through its property-reference backlinks — stored instance-side rather than an unbounded m2m list on the template to avoid write contention); written on every instantiation path (create-with-template, class-assign apply, gallery Use, slash); the generic duplicate gesture does NOT write it. (b) **Manual use** — templates are usable from anywhere via the slash entry's flat list of ALL templates (no class filter), instantiated at the caret; the class-filtered picker remains only for the Class View binding gesture. Templates are plain nodes classed `template`; class binding is optional (unbound templates = manual-use only).
- **D2 — `defaultValue` vs template precedence.** Recommendation: the template wins per-property; `defaultValue` fills only properties the template leaves unset. Both are per-class configuration; precedence documented in SCHEMA.md.
- **D3 — `embed_ref` on clone.** Recommendation: carry the same live embed (link semantics) — consistent with the embed rule's "never a clone"; deep-cloning the embedded subtree becomes a v2 option only if users ask.
- **D4 — daily-note templates.** Capacities ships them; Notees has formatted date labels but no daily-note object type. Parked (see parked register), not in this scope.

**Modelling decisions (for the implementing agent):**
1. **Templates are ordinary nodes** — instances of the seeded `template` class, edited with the real outliner. This beats Capacities' blank canvas: fully editable, linkable, taggable, findable in the graph. Instantiation reads the template's subtree and composes ops client-side; **no new op type**.
2. **One shared clone engine** — depth-first subtree walk; copy `contentAst`; fresh UUIDv7 per node; `parentId` + `beforeId`/`afterId` anchored so every backend's replay converges to identical trees; references per A3. Lives beside `createAnnotation` in `workspace-client.ts`; also powers a real duplicate-subtree gesture (B4).
3. **Variables are apply-time substitution** inside text tokens before ops are written — zero wire impact. Pick one syntax in T4 (`{{date:...}}` proposed; Capacities uses `{date:...}` — choose deliberately, prose-collision weighed).
4. **No protocol/wire change in T1–T4** → no fixture gate, no GTK/Flutter lockstep owed. Caveat: GTK/Flutter seed convergence (the new `has-template` UUID) is a follow-up data alignment — additive seeds do not break existing clients.
5. **UI composes from `apps/web/src/ui/components/ui/` only** (AGENTS.md rule) — gallery, picker, and variable dialog from Modal/Card/Dropdown/SearchField primitives; token-only CSS.

**Task list** (status updated as work lands; every phase gates on `pnpm -r build` + `pnpm test` green; all PENDING — scheduled behind §34.23 like §34.24, since `object.create`'s shape is mid-revision there):

- [x] **T0 comparison & design brief** — DONE 2026-10-02: Capacities reference compared; this section written; cross-refs updated (`00-INDEX:44`, `01:69`, `02:52,94`, `SCHEMA.md:25`, §34.19 row, §34.11 sweep outcome).
- [ ] **T1 clone engine** — shared `instantiateTemplate`/`cloneSubtree` primitive in the web client (B5 generalization; A3 rules implemented here); `beforeId`-anchored ordering; unit tests over a synthetic template subtree (nested blocks, every token kind, tag/class/property references, embed).
- [ ] **T2 `has-template` seed + instantiate-at-create** — new fixed UUID in `SYSTEM_PROPERTY_UUIDS`; seeded property schema + binding (D1 shape); `createObject` flow: class picked → template(s) offered → instantiation composes clone-engine ops; SCHEMA.md gains the A3 link-vs-clone spec + D2 precedence (docs-in-same-pass, B8).
- [ ] **T3 surfaces** — Class View template slot (`docs/ux.md:30` chrome) + TemplateGallery (primitives-only, A6/A7) + slash instantiate (folds into §34.19 `:1133` scope) + keyboard create-with-template.
- [ ] **T4 variables + apply-to-existing + duplicate gesture** — apply-time variable substitution + TemplateVariableDialog (A5); bottom-of-empty-object template picker with merge semantics (A4: skip blocks already present from a partial apply — track an applied-template marker); real duplicate-subtree UI reusing the clone engine (B4 resolution).
- [ ] **T5 atomicity follow-up (only if partial application bites in practice)** — spike B6 (ordered-batch application in SyncEngine); if insufficient, draft the subtree-op proposal **with its fixture-gate + GTK/Flutter lockstep cost attached** (§34.23 M8/M9 pattern) — a separate owner decision, never silent.
- [ ] **T6 docs + gate** — SCHEMA.md (instantiation OWED→DONE, variables syntax, D2 precedence), `docs/usage.md` + `docs/ux.md` template sections, AGENTS.md if behavior text changes, `.plans/dev/architecture.md` paragraph, this section's shipped state; `pnpm -r build` + `pnpm test` + `verify-min.mjs` smoke.

**Parked register (recorded, not this work):** daily-note templates (D4 — needs a daily-note object-type decision of its own); template import from files (export is one-way by doctrine, §34.12 — no markdown→nodes importer exists; the gallery is the sharing mechanism); wire-level subtree op (T5 last resort); live/reevaluating variables (rejected — token type + lockstep cost); cross-workspace template sharing (rides the M-tier E2EE/export slot).

**Explicit non-goals:** any op-type/wire addition in T1–T4; deterministic (non-UUIDv7) clone ids; a separate template node kind (template = ordinary node + class instance, per the design law); a Capacities-style per-type templates settings page (templates live in the graph and in Class View, not a settings screen).

### 34.26 Presentation mode — design brief & work record (Capacities comparison, 2026-10-02, PENDING — scheduled behind §34.23)

Comparison of Capacities' presentation mode ([reference docs](https://docs.capacities.io/reference/presentation-mode), verified 2026-10-02) against Notees, and the implementation handoff. This section is the source of truth for presentation mode: it upgrades the one-line parity row `§34.19:1149` (`PresentationModal (children as slides)` ❌) into a full design brief and records the disposition of every gap found in the comparison. No model/wire/grammar question is opened here — the whole feature is web-view-layer.

**Capacities model (the reference, in beta):** the note is the source — no slide editor. Headings (H1–H4) split the note into slides; a horizontal divider (`---`) forces a break without a heading. Auto layout rules: first slide = centered object title + icon; a slide's leading heading becomes its title; heading-only slides render as centered section titles; a trailing image block is pulled aside (text left, image right; image-only → centered full size); short slides get large text, dense slides normal size (auto-fallback on overflow); body left-aligned at reading width. During presentation: read-only but live — toggle lists flippable without mutating the note, numbered lists continue across slides, embedded pages expand into the deck, clicking a link exits and navigates. Navigation: fullscreen overlay; arrows/space/PageUp/PageDown; Esc; screen-edge clicks; auto-hiding floating toolbar with slide counter. Per-object resume (last slide index remembered). Desktop + tablet only (not phone). Free plan shows a Capacities-logo watermark (Pro/Believer removes it). Roadmap-only: speaker notes, export, sharing.

**v1 reference (the port source):** `frontend/src/features/content/components/PresentationModal.tsx` @ archive tag `v1-archive` (186 lines, evidence per the §34.19 audit): each child node = one slide (deleted/comment children filtered); slide title = node display name; body = read-only `BlockList` of the child's nested children up to the linked-references collapse level; ←/→ keys + on-screen buttons; Esc via the global overlay stack; focus trap; fullscreen toggle. v2 port is a re-implementation, not a file port — the v2 client has no overlay stack / settings store of that shape.

**Current state (survey 2026-10-02, file refs for the implementing agent):**
- No presentation surface anywhere in v2 (web grep: no presentation/slide/deck view). Parity row: §34.19:1149 ❌; v1 had it (above).
- Content grammar has **no heading and no divider token** (`packages/protocol/SCHEMA.md:55-68` — the full normative token list). Structure lives in the block tree, not the document — Capacities' slide-splitting convention (headings + `---`) has nothing to attach to.
- Kit primitives (`apps/web/src/ui/components/ui/` + `index.ts` barrel): `Modal`, `ImageModal`, `ConfirmationModal` exist; **no fullscreen overlay primitive** (no auto-hiding toolbar, no edge zones). Whiteboard fullscreen is designed chrome (`docs/ux.md:104`) — a second future consumer.
- View-mode system (§34.21, `apps/web/src/ui/views/`): registry + `NodeCollection` + modes `outline | prose | cards | table | kanban` — all **collection-oriented** (flags: `readOnly`, `maxDepth`, `renderItem`, `tableColumns`, `kanbanProperty`…). No document-deck mode; no registry slot taken.
- Read-only render paths exist: embeds render the live subtree read-only (`SCHEMA.md:62` embed rule; `docs/ux.md:18` — read-only projection, cycle-guarded); prose mode is a pure view transform (`docs/ux.md:52`, `nt-prose`); `OutlinerReader` is the read seam (§34.21 V12).
- Title-is-content: no `name` field; pages/classes carry text-only content; display names derive from content (`packages/domain`). Node `icon`/`color` exist on the object surface.
- View state is session-local everywhere (collapse; §34.21's session-only owner decision, `:1240`); device settings ride `deviceSettings.ts` (§34.22 E6 pattern). **Never an op** (design law).
- Keyboard map is thin (§34.19:1131 🟡 — palette/quick-add/find only); no input-context layering.
- §34.23 (in flight) replaces `node_type` with (`is_class`, `present_as_main`); post-M6 the Child pages section renders `present_as_main=1` main-children (`:1314`). That partition is the natural section-slide boundary (B8 below).

**Gap register** (A = missing, B = exists but must change/extend; dispositions reference the task list):

| # | Gap | Kind | Disposition |
|---|---|---|---|
| A1 | Deck renderer / presentation view | missing | P2–P4 (parity row §34.19:1149) |
| A2 | Slide-splitting primitive (no heading/divider tokens — SCHEMA.md:55-68) | missing | P2 tree heuristic; grammar token rejected (D1) |
| A3 | Fullscreen overlay primitive (auto-hiding toolbar, counter, edge zones) | missing | P1 — kit component + barrel export; second consumer: whiteboard fullscreen |
| A4 | Presentation input context (arrows/space/PageUp/PageDown/Esc owned by the overlay) | missing | P6 (broader keymap row §34.19:1131 stays open) |
| A5 | Per-object resume state (last slide index) | missing | P7 — session-local, never an op |
| A6 | Deck layout heuristics (title slide, section-title slide, trailing-image side-pull, density text sizing) | missing | P4 |
| A7 | Embed expansion into the deck (embedded node's children become slides) | missing | P5 — renderer-context change; embed rule unchanged (SCHEMA.md:62) |
| A8 | Speaker notes / deck export / deck sharing | **not gaps** | Capacities roadmap-only → parked register |

| # | Existing surface | Change | Disposition |
|---|---|---|---|
| B1 | Content grammar without headings | avoid the change | D1: heuristic over the tree instead of tokens (token = fixtures + three-client lockstep + migration — AGENTS.md invariant) |
| B2 | Title-is-content + domain display-name derivation | format only | P4 title slide renders the node's own text content + icon/color; no derivation change |
| B3 | §34.21 view registry + `NodeCollection` | extend-by-reuse, not membership | D2: decks stay out of the registry (document view, not collection); slide body reuses prose/read-only machinery |
| B4 | Prose mode (`nt-prose` transform) | consume read-only | P3 slide body |
| B5 | Embed read-only projection / `OutlinerReader` | run over the page tree | P3 |
| B6 | `Modal`/`ImageModal` kit primitives | build on top | P1 per the UI-primitives law (new primitive file + barrel export, token-only CSS) |
| B7 | Session view-state (collapse pattern) | same slot pattern | P7 slide index |
| B8 | §34.23 `present_as_main` main-children (in flight) | lands free | P2: main-children = section slides post-M6; pre-migration fallback = top-level children. **Why this section schedules behind §34.23** |
| B9 | `InlineTokens` + token renderers (whiteboard/query/asset/embed) | reuse as-is | P3 — decks render what PageView renders; no placeholder regression |
| B10 | UI primitives law + token-only CSS | standing | P1/P4 compliance; no ad-hoc deck chrome |

**Owner decision points (confirm before code; recommendations recorded):**
- **D1 — explicit slide-break marker.** Recommendation: **none in v1 of the feature.** Capacities needs `---` because structure lives in a flat document; Notees structure is the tree — top-level children are the breaks. A marker means a new token (fixtures, GTK/Flutter lockstep, migration) or string-convention hack. Revisit only with demonstrated demand.
- **D2 — deck inside the §34.21 registry or standalone overlay.** Recommendation: **standalone `PresentationOverlay`** (below) — decks are document views over one page's subtree; `NodeCollection` flags describe collections. A `deck` registry slot stays reserved for collections that ever want it; no commitment now.
- **D3 — slide-index persistence.** Recommendation: **session-only**, per the owner's §34.21 session-only decision (`:1240`). Any later reversal rides the device-settings mechanism (`deviceSettings.ts`) — never the op log.

**Modelling decisions (for the implementing agent):**
1. **The note is the source** (Capacities' own rule, adopted): no slide editor, no slide objects, no deck entity. A presentation is a pure read of one page's subtree — the view is derived, exactly like every other view (`view resolution = f(node_type)`).
2. **Slide-split = tree heuristic, zero wire impact.** v1 heuristic: the page's own text content renders as the title slide; each top-level child (post-§34.23: each `present_as_main=1` main-child) = one section slide — the child's own content is the slide title, its children are the slide body (this is v1's children-as-slides, one level deep, matching the archived `PresentationModal`); body children before the first section (post-migration: `present_as_main=0` children) form intro slides chunked by a density rule. Long-form content emerges from nesting, per the outliner bet — no new structure typed as metadata.
3. **Read-only but live**, like Capacities: collapse/expansion inside a deck is session view-state and never mutates; links click through (exit + navigate, same as Capacities).
4. **All chrome composes from the kit** (AGENTS.md law): the overlay is a new `ui/components/ui/` primitive + barrel export; every color/space value resolves to a `variables.css` custom property.
5. **Device state, never an op** (design law): slide index, toolbar visibility — session-local; nothing enters the log.
6. **No SCHEMA.md change**: no token, op, or payload is added. If D1 is ever reversed (a break marker token), that reversal pays the full fixture + lockstep + migration cost up front — recorded here so it is never silent.

**Task list** (status updated as work lands; every task gates on `pnpm -r build` + `pnpm test` green; all PENDING — scheduled behind §34.23 like §34.24/§34.25, because P2's section-slide mapping reads `present_as_main`; P1/P6 are migration-independent if the owner re-sequences):

- [x] **P0 comparison & design brief** — DONE 2026-10-02: Capacities reference compared; v1 `PresentationModal` source recovered from the archive tag; this section written; cross-refs updated (§34.19 row `:1149`, §34.11 sweep outcome, `design/00-INDEX` deferred list).
- [x] **P1 `PresentationOverlay` kit primitive** — DONE 2026-10-03 (this pass): `apps/web/src/ui/components/ui/PresentationOverlay.tsx` (+ `.css`, barrel export): fullscreen host portal on a dark stage (new `--color-presentation-stage` / `--color-on-presentation-stage[-muted]` tokens in all three themes), auto-hiding floating toolbar (prev / counter / next / exit — fades after `PRESENTATION_CHROME_HIDE_MS` = 2.6 s of pointer/keyboard idle, cursor hides with it), always-live 20% edge click zones, Esc via the overlay stack (LIFO, like Modal), Tab focus trap, and the presentation keymap owned by the overlay (→/↓/Space/PageDown next, ←/↑/PageUp prev, clamped at the ends). `index`/`count`/`onIndexChange` are optional — a chromeless second consumer (whiteboard fullscreen) keeps Esc/focus-trap/auto-hide without a slide stream. Tests: render/portal/counter, Esc, keymap incl. clamping, edge zones, focus trap, auto-hide (fake timers) — `test/presentation-overlay.test.tsx`.
- [x] **P2 deck builder** — DONE 2026-10-03 (this pass): pure module `apps/web/src/ui/presentation/deck.ts` (no React): `buildDeck(root, resolve)` → title slide + one section slide per `present_as_main=1` top-level child + density-chunked intro slides for `present_as_main=0` runs (greedy: 500-char budget / 5-block cap, exported constants); layout heuristics (`standard` / trailing-image `split` / lone-image `image-full` — a "image block" is exactly one `asset_ref` token) and density tiers (`sparse` ≤280 chars / `dense` ≥1000) computed builder-side so the view stays dumb. Unit tests over synthetic trees (`test/deck-builder.test.ts`): empty/text-only page, flat children, deep nesting, mixed runs, chunk budgets, image layouts, density.
- [x] **P3 DeckView slide renderer** — DONE 2026-10-03 (this pass): `apps/web/src/ui/presentation/DeckView.tsx` (+ `deck.css`, token-only, stage-colored): slides resolve node ids LIVE from the client (re-render on notify — the deck is read-only but live per modelling decision 3); body = the embed read-only projection idiom (`InlineTokens` + `EmbedView` + `QueryBlockView` + embedded `WhiteboardCanvas` — decks render what PageView renders, no placeholder regression) inside a full `OutlinerContext` (the §34.21 V12 read seam) with an `EmbedBoundary` seeded at the page id; two chrome kinds (centered title slide / left-aligned body at reading width, section-title row for sections). Link click-through = exit + navigate (the Capacities contract). **Reading the top level:** `getBlockTree` is inline-body-only post-Revision-11, so the deck's top-level input merges `getChildren` (true child order) filtered by membership in the two zone reads (`getBlockTree(id, 1)` / `getChildPages(id)`) — that also excludes property-value carrier blocks exactly as the block tree does.
- [x] **P4 layout heuristics** — DONE 2026-10-03 (this pass): title slide renders the node's own text (display-name derivation, title-is-content) + effective icon/color; trailing-image side-pull and image-only centering per the builder's layout outcome (image bytes via the session-cached `assetImageUrl`, non-image assets render the honest placeholder); density sizing via `nt-deck-slide--sparse|normal|dense` (1.5em / 1em / 0.875em relative body text, dense scrolls inside the slide — the overflow guard).
- [x] **P5 embed expansion** — DONE 2026-10-03 (this pass): `embed_ref` targets in a slide's blocks (quote children included) splice the target's children's slides into the stream right after the referencing slide, partitioned by the same section/intro rule; nested embeds expand depth-first; the visited set (seeded with the deck root) is the cycle guard — an embed of the root or an already-expanded target adds nothing (broken targets skip). Renderer-context change only — the embed rule (SCHEMA.md:62) and its cycle guard are untouched (the slide body still renders the live embed box).
- [x] **P6 input layer + entry points** — DONE 2026-10-03 (this pass): the keymap context is owned by `PresentationOverlay` (active only while open). **Chord: Ctrl/Cmd+Alt+Enter** — Capacities' Ctrl+Alt+P collides with §34.19's reserved "add property" chord (`:1138`) and the browser's private-window binding; Ctrl+Alt+Enter is free in both the plan's keymap row and the tree (recorded at §34.19 `:1138` and in App.tsx). Entry points: the "…" node menu (`NodeMenuButton`) and the page header context menu both gain **Present** (`NodeContextMenu` takes an optional `onPresent`; `PageView`/`NodeView` thread it; App owns `presentingId` and mounts `DeckView` at the top level). The global chord presents the open page when it renders document chrome (and never steals from form fields).
- [x] **P7 resume state** — DONE 2026-10-03 (this pass): `apps/web/src/ui/presentation/presentationSession.ts` — module-memory Map<objectId, slideIndex> (D3 session-only, the collapse-slot pattern): remembered on every move, on exit, and on unmount (the cleanup reads the ref at cleanup time — a mount-time capture would clobber the index with 0); `pagehide` ends the session (the map dies with the page). Nothing persisted, nothing on the wire. Verified by the reopen-resumes spec.
- [x] **P8 parity row + docs + gate** — DONE 2026-10-03 (this pass): §34.19 `:1157` ❌→✅ (this row); `docs/ux.md` presentation-mode section (heuristic, gestures, read-only-live contract); `docs/usage.md` "Presenting a page" section (entry points, gestures, session resume); `.plans/dev/architecture.md` view-layer paragraph; this section's shipped state below. Gate: `pnpm --filter @notees/web typecheck` clean; web suite **55 files / 522 tests green** (490 pre-existing + 32 new); whiteboard suite untouched and green. No wire change → no fixture gate, no GTK/Flutter lockstep owed (Revision 11 clients are unaffected).

**Shipped state (2026-10-03) — §34.26 P1–P8 complete, web-only, gate green (522 tests).** Presentation mode is live in the web app: any page decks itself from the "…" menu, the header context menu, or Ctrl/Cmd+Alt+Enter; slides derive from the tree (title → intro/section slides by the `present_as_main` partition, density-chunked intro runs, trailing-image pull, embed expansion with cycle guard); the overlay owns Esc/arrows/space/PageUp/PageDown/edge-clicks and an auto-hiding toolbar; decks are read-only but live; resume is session-memory only. Deviations from the brief, recorded: (1) the chord is **Ctrl/Cmd+Alt+Enter**, not Capacities' Ctrl+Alt+P — the latter collides with §34.19's add-property reservation (the brief anticipated the collision; Enter is the genuinely free chord); (2) intro slides apply to every inline-body **run** (not only the run before the first section) — the P2 test list's "intro + sections mixed" case; same rule, zero content lost; (3) the deck reads the top level via `getChildren` + zone-membership (true child order across both render zones, property carriers excluded) because `getBlockTree` is inline-body-only post-Revision-11; (4) no Browser Fullscreen API in this pass — the overlay is a fixed host at `--z-10000` over the app (a `requestFullscreen` upgrade remains available for a later polish pass). Whiteboard in-place fullscreen (`nt-wb-fullscreen`) untouched; `PresentationOverlay` is sized for it as the second consumer. New tests: `deck-builder.test.ts` (13), `presentation-overlay.test.tsx` (11), `deck-view.test.tsx` (8, incl. entry point + embed expansion + resume). No SCHEMA.md change (no token/op/payload added — modelling decision 6 holds).

**Parked register (recorded, not this work):** speaker notes; deck/slide export (page Markdown export already exists; a "deck" PDF layout would ride §34.24's engine if ever wanted); presentation sharing (self-hosted answer = screen-share the browser tab); phone/tablet deck support (Capacities excludes phone too; the Flutter mobile IA is quick-reference-first per m8 — decks stay a web-app surface); explicit slide-break marker (D1 reversal — pays fixture + lockstep + migration); `deck` as a registry collection mode (D2); per-slide builds (animations, timers) — Capacities ships none.

**Explicit non-goals:** any op-type/wire/grammar addition; heading/divider tokens; a slide editor or slide objects (the note is the source); watermark/plan-tier gating (inapplicable — self-hosted, no tiers); a separate phone-client presentation mode; speaker notes; PDF/slide export in this pass.

### 34.27 Page layouts — design brief & work record (Capacities comparison, 2026-10-02, PENDING — scheduled behind §34.23)

Comparison of Capacities' page-layout system ([reference docs](https://docs.capacities.io/reference/page-layouts), verified 2026-10-02) against Notees, and the implementation handoff. This section is the source of truth for page layouts: it consolidates the scattered parity rows (§34.18 item 7; §34.19 banner ❌ `:1156`, focus/zen + card layouts ❌ `:1157`, right-sidebar context sections 🟡 `:1167`, footer ❌ `:1136`) into one design brief and records the disposition of every gap found in the comparison. Scheduled behind §34.23 because the render cascade and PageView composition are mid-revision there (M6/M7) — L1–L4 are migration-independent if the owner re-sequences (same pattern as §34.26's P1/P6).

**Capacities model (the reference):** page layouts exist only for custom object types, configured in object-type settings > Configuration > Page, applying to every instance of the type. Four layouts: **Standard** — neutral default; adds a **wide mode** (full width, for dashboards/multi-column) settable as the type default and toggleable per content. **Index card** — short-form/draft content; the design visually constrains content length; properties + a small preview image are collapsible. **Profile** — people/companies; circular preview image + a separate property section on the left. **Encyclopedia** — overview layout: table of contents, backlink navigation, structural overview, high information density.

**Current state (survey 2026-10-02, file refs for the implementing agent):**
- One chrome for every node — `PageView.tsx:298-462`: classes corner pills (`:304-308`) → header (icon picker + `TitleEditor` + `TagsRow`, `:317-375`) → `PropertiesSection` collapsed by default (`MetadataSection.tsx:1498`) → view toolbar + block tree, or `WhiteboardCanvas` in place of the tree when the page carries a whiteboard token (`:383-384`) → `SystemSections` (child pages expanded; linked/unlinked references collapsed, `SystemSections.tsx:89-163`).
- Fixed geometry: `.nt-page { max-width: 46rem }` (`apps/web/src/ui/app.css:391`) inside the centered `PageCard` (`min(960px, 100% − 48px)`, `apps/web/src/ui/components/PageCard.tsx`). No width control at any level.
- Title-is-content: the `<h1>` IS the content — `TitleEditor.tsx:59-71` commits `contentAst` as a single text token; no name field, hence no independent title styling.
- Class influence is data-only: property bindings, effective icon (`iconFor.ts:9` — own icon wins, else first class with an icon), effective color. No presentation/layout role for classes.
- View modes (outline/prose/cards/table/kanban) are session-local by decision (§34.23 item 5; `PageView.tsx:100-104`) — reset on every reload, for nodes, hubs, and system sections.
- Covers are half-built: the `cover` system property (`SYSTEM_PROPERTY_UUIDS.cover`, `packages/domain/src/seeds.ts`) resolves to an asset node (`views/assetThumbs.ts:31-39`) and Cards views consume it (`views/CardsView.tsx:143-163`, session toggle, four placements `views/types.ts:48`) — but the page view has no banner, `--page-cover-height` is unused (`variables.css:442`), and the registry itself records "covers are owed chrome" (`views/types.ts:168`).
- Right sidebar shipped peek cards (§34.20; `SidebarNodeCard`, `App.tsx:278`) but no context sections — and no TOC anywhere: the grammar has no heading token (`SCHEMA.md:55-68`), so a TOC must derive from the block tree (same heuristic as §34.26 P2).
- Breadcrumbs are nav-only (`App.tsx:1180-1184`); v1 edit gestures owed (§34.19:1134 🟡). Unlinked references render flat, no promote/ignore (§34.19:1137 🟡). No page footer (§34.19:1136 ❌).
- Prereqs already shipped: view-mode system (§34.21), peek cards (§34.20), header icon picker (`IconPickerPopup`), `deviceSettings.ts` as the durable client-state seam (§34.22 E6 pattern).

**Gap register** (A = missing, B = exists but must change; dispositions reference the task list):

| # | Gap | Kind | Disposition |
|---|---|---|---|
| A1 | Page cover/banner on the page view | missing | L2 — existing `cover` property + header slot (D2); no new token |
| A2 | Wide mode / width control (46rem fixed) | missing | L5+L6 — `wide` as a layout enum value (D1) |
| A3 | Per-class page layouts (the Capacities core concept) | missing | L5 — class-bound select property (D1); GTK/Flutter alignment = seed convergence only (property values are existing wire machinery) |
| A4 | Table of contents | missing | L3 — tree-derived (D4), right-sidebar context section |
| A5 | Profile-style property rail / multi-column page geometry | missing | L6 — layout branch, depends on A3 |
| A6 | Index-card-style content-length constraint | missing | **Not adopted** (D3) — parked |
| A7 | Presentation persistence (view modes/cover toggle reset every reload) | missing | L1 — `deviceSettings.ts`, zero protocol (closes §34.23 item 5) |
| A8 | Page footer (word count, Created/Updated → day pages) | missing | L4 (§34.19:1136) |
| B1 | Properties collapsed by default for every page regardless of class | change | L6 — default/placement follows the effective layout |
| B2 | Backlinks collapsed at card bottom | change | L3+L6 — encyclopedia rail: persistent right-side references (pairs with §34.19:1167) |
| B3 | Card cover-layout toggle session-local | change | L1 — persist via device settings alongside the §34.18-item-7 card display modes |
| B4 | Icon fallback chain defines no per-class look | change (contingent) | L5 — class-bound layout carries icon/cover defaults for its instances (Capacities type-settings parity) |
| B5 | Breadcrumbs nav-only | change | L4 — v1 gestures (reassign/edit/add-parent, §34.19:1134) |
| B6 | Unlinked references flat | change | L4 — promote-to-link + ignore (§34.19:1137) |

**Owner decision points (confirm before code; recommendations recorded):**
- **D1 — where layout lives.** Capacities: a per-type setting with per-content override. Notees pages carry **multiple classes**, so "the class's layout" needs a conflict rule. Recommendation: a **select property bound by the class** (system-seeded, values `standard` / `wide` / `profile` / `encyclopedia`), per-instance override = the property set on the page itself; multi-class conflict resolves **first-class-applied wins** (the existing binding-conflict rule, SCHEMA.md class-properties section). Semantic → op log → converges across devices; GTK/Flutter alignment is additive seed convergence + optional chrome read (§34.25 modelling decision 4 precedent — breaks nothing). Alternative: client-side per-class settings (no lockstep, doesn't sync) — owner picks.
- **D2 — banner slot.** Recommendation: **header chrome above the title**, fed by the existing `cover` property → asset node. The §34.19 row's "AST banner slot" wording predates title-is-content; a banner token would pay fixtures + lockstep + migration for zero gain over the property. The profile layout's circular crop is CSS, not data.
- **D3 — index-card content-length constraint.** Recommendation: **do not adopt.** Title-is-content says a page IS its content; a layout that constrains length contradicts it. The visual differentiation an index card provides comes free from icon + cover + color + narrower width — adopt the look, not the constraint.
- **D4 — TOC source.** Recommendation: **tree-derived** (top-level children; post-§34.23 the `present_as_main=1` main-children, with pre-migration fallback), NOT heading tokens — the grammar has no headings (SCHEMA.md:55-68) and adding them pays fixtures + lockstep + migration (same call as §34.26 D1).

**Modelling decisions (for the implementing agent):**
1. **Two-state split, per the design law:** the layout *choice* is semantic state (property value → op → lockstep alignment per D1); layout *state* (expanded/collapsed, cover toggle, TOC scroll) is device state (`deviceSettings.ts`, never an op — §34.26 D3 precedent).
2. **One branch point in PageView:** the effective layout value maps to a chrome config (`{ width, properties: { placement, defaultExpanded }, cover: { present, crop }, rail: [sections] }`) consumed by the existing composition — no per-layout component forks in the first pass; new geometry (profile rail) is a CSS-grid variant of the same nodes.
3. **No new token, op, or payload field:** covers ride the existing `cover` property; layouts ride existing property-value machinery. L5's only data cost is one new `SYSTEM_PROPERTY_UUIDS` entry (additive, §34.25 A2 pattern).
4. **TOC and references render as right-sidebar context sections** on top of the shipped peek-card panel (§34.20) — the rail is chrome; the collapsed-at-bottom `SystemSections` stay as the small-viewport fallback.
5. **UI composes from the kit** (AGENTS.md law); every new visual value resolves to a `variables.css` token — the unused `--page-cover-height` (`variables.css:442`) is the banner's starting budget.
6. **Docs are part of the change** (owner rule): every task ships `docs/usage.md` + `docs/ux.md` + SCHEMA.md (if L5 lands) + this section's state in the same pass.

**Task list** (status updated as work lands; every task gates on `pnpm -r build` + `pnpm test` green):

- [x] **L0 comparison & design brief** — DONE 2026-10-02: Capacities reference compared; this section written; cross-refs updated (§34.18 item 7, §34.19 rows `:1136,:1156,:1157,:1167`, SCHEMA.md owed work, `design/00-INDEX` deferred list).
- [ ] **L1 presentation persistence** — persist view modes + card cover-layout toggle per node/hub in `deviceSettings.ts` (session → durable client-local); zero protocol → no lockstep; closes §34.23 item 5. Migration-independent.
- [ ] **L2 page banner** — cover above the title in the page header from the `cover` property (D2): image, collapse gesture, `--page-cover-height` budget, token-only CSS; sane defaults for whiteboard pages and date pages (no cover). Closes §34.18 item 7 (page half) + §34.19:1156.
- [ ] **L3 right-sidebar context sections** — `TocSection` (tree-derived per D4, active-entry highlight) + `ReferencesSection` (linked refs promoted from the bottom section into the rail when the panel is open); lazy-load per the system-section contract (SCHEMA.md system sections). Closes the TOC half of §34.19:1167.
- [ ] **L4 small chrome parity** — page footer (word count, Created/Updated buttons → day pages); breadcrumb edit gestures (hover reassign, right-click edit/remove, "+ Add parent"); unlinked-reference promote/ignore. Closes §34.19 `:1134,:1136,:1137`.
- [ ] **L5 layout property** — D1 confirmed; `page-layout` select property seeded (`SYSTEM_PROPERTY_UUIDS`, additive), bindings-editor exposure, effective-value read + conflict rule documented in SCHEMA.md **before** code; GTK/Flutter seed-alignment brief (no payload change → no fixture gate); class-bound icon/cover defaults (B4) ride the same binding row.
- [ ] **L6 layout branches in PageView** — chrome-config map (modelling decision 2): `wide` (full width within the card), `profile` (left property rail, properties default-expanded, circular cover crop), `encyclopedia` (TOC + references rail persistent); `standard` = today's chrome. Closes §34.19:1157's card-layout persistence half via L1.
- [ ] **L7 docs + gate** — `docs/ux.md` page-layout section + `docs/usage.md`; SCHEMA.md layout-property spec (if L5 landed); AGENTS.md parked-decisions row if D1 chooses semantic; `.plans/dev/architecture.md` view-layer paragraph; this section's shipped state; `scripts/screenshots/verify-min.mjs` smoke.

**Parked register (recorded, not this work):** index-card length constraint (D3); saved views per section / ViewTabs (§34.19:1158 — own brief, pairs with query-block view persistence); focus/zen mode (§34.19:1138/:1157 — a display toggle, not a layout; own gesture when picked up); gallery view mode; graph view (§34.21 future register); kanban card-order property (§34.23 register); multi-column content inside a page (Capacities' wide-mode use case — the whiteboard already serves spatial layout; revisit only with demand).

**Explicit non-goals:** any content-token/grammar addition (banner, heading, divider); per-page free-form width sliders (widths come from the layout enum); layout *state* as ops; phone-client layouts (Flutter IA is reference-first per m8); a Capacities-style object-type settings screen (layout binds in the existing class properties editor, not a new settings surface).

### 34.28 Dates & daily notes — gap-analysis register (2026-10-02, fully verified)

A fully-verified gap analysis of the dates/daily-notes feature area — the dates model (year/month/day chains, precision, ranges, link qualifiers), daily pages, journals, task-scheduling surfaces, and the calendar — recorded so a later implementation pass can pick up every item. Every claim was re-verified against the tree on 2026-10-02 (file:line evidence throughout; grep-confirmation where a negative is asserted). Item numbers are stable and cross-referenced from the §34.19 rows; where an existing register row already names an item, this section carries the detail and the row keeps the headline (no double-listing — cross-checks at the bottom).

**Model layer: COMPLETE — nothing below needs model work unless marked.** Date-node ids + chain creation (`packages/domain/src/dates.ts`), edge projection with date-chain ancestor fan-out (`packages/store/src/edges.ts:96-130` — a day ref implies the month/year edges; a `date_range` end does likewise), date-aware query arms (`packages/query/src/compiler.ts:480-606` — eq/contains match the referenced period, comparison ops order by the id's date payload), and the `date_precision`/`date_qualified` schema backfill (`packages/store/src/schema.ts:466-477`) are all shipped. Aggregation items are read-model/UI-only; the "no model work" notes below are real cost reductions, not optimism.

**Shipped-state confirmations (✅ 2026-10-02)** — verified against the registers so nothing is double-listed:

- **Tasks hub** — `/tasks` CollectionHub over `getClassMembers(SYSTEM_CLASS_UUIDS.task)` (pages AND blocks, owner rule), table default with status/priority/scheduled/deadline columns + kanban grouped by status (`App.tsx:1418-1445`; columns `:1328-1350`); the §34.19 TasksPopup row is updated ❌→🟡 above.
- **Calendar day view** — the Capacities-style Day view behind the sidebar's Calendar entry (`/calendar`), shipped 2026-10-02: day header (local date per the dateFormat setting, ISO week, prev/next/Today), daily-note embed via `<PageView embedded>` (+ create-in-place via `ensureDateChain`), open tasks in Scheduled/Overdue groups (one `runQueryAst` query — class:task AND taskScheduled exists AND negated-eq arms per closed status, never `neq` — partitioned client-side; the checkbox done-toggle is the tasks hub's exact write: `property.set` of the status option id, no `taskClosedDate` anywhere in the hub either), general date references from the day node's existing backlink set (tasks, date-chain nodes, the daily note excluded), created-today via `createdAfter`/`createdBefore` over local-midnight-derived UTC bounds, quick-create chips per date-bound class (#10 above), and the `MonthCalendar` month grid in the right column — `ui/calendar/`'s shared `CalendarDayGrid` + `useCalendarMode` now back both the top-bar popup and the panel (#3's extraction done; the pickers/ family and the dead `DatePicker.tsx` stay separately owed). Ships #2 (`ensureTaskFamily`) and #10; cross-notes on #4/#7/#11 below. New files: `apps/web/src/ui/components/CalendarView.tsx` (+ `.css`), `calendarViewUtils.ts`, `taskFamily.ts`, `ui/calendar/dayGrid.tsx` (+ `calendar-grid.css`), `ui/calendar/MonthCalendar.tsx` (+ `.css`); wired in `Sidebar.tsx` (NavKey + `sidebarShowCalendar` device setting + `WorkspaceSettingsModal` toggle), `App.tsx` (`NAV_PATHS` `/calendar`, mount ternary, tasks-hub `ensureTaskFamily`).
- **@-picker NL date insert** — `parseDate` on the picker query; `@feb 14` offers "Go to/Create daily page" and ensure-chains + picks in one gesture (`NodeSelector.tsx:300-334`); the §34.19 SuggestionPopup row is updated above.
- **`dateQualified` link qualifiers fully wired in web** — ClassView bindings checkbox (`ClassView.tsx:433-447`); per-chip start/end range control persisting as `metadata.startDate`/`endDate` (`MetadataSection.tsx:212-213,337-349,690-694`).
- **`markedDates` in the date picker** — has-note day marks collected from existing day pages (`collectMarkedDates`, `MetadataSection.tsx:118-133`, wired at `:446,:534,:577,:683`).
- **Store backfill** — `property_schema.date_precision`/`date_qualified` v3→v4 migration (`packages/store/src/schema.ts:466-477`).
- **Flutter Home Today card + Journal tab** — m8, already recorded §34.22 `:1298` (not re-claimed here); the mobile parity gaps are #18 below.

**Verified bugs (pending):**

| # | Bug | Evidence | Fix direction |
|---|---|---|---|
| 1 | UTC "today" when defaulting a new date property | `MetadataSection.tsx:1074` defaults via `new Date().toISOString().slice(0, 10)` (UTC); every other today-path uses local midnight (`todayIsoLocal` `JournalsView.tsx:29-35`, `todayIsoDate` `QuickAddModal.tsx:30-34`) | Extract the shared local-midnight helper into one module and use it at `:1074` — wrong day near midnight |
| 2 | Task property schemas never authored in v2 — **SHIPPED 2026-10-02** | Reserved UUIDs `taskStatus`/`taskDeadline`/`taskScheduled`/`taskPriority`/`taskClosedDate`/`taskRecurrence` (`seeds.ts:138-143`) exist as constants + v1-migration mappings only (`scripts/migrate-v1/migrate.py:154-156`); nothing in v2 creates them, so a fresh workspace's tasks hub silently drops the Scheduled/Deadline columns (`App.tsx:1328-1350` filters missing schemas) and shows Name+Created only | Executed as the register's sanctioned fix: `ensureTaskFamily` (`apps/web/src/ui/components/taskFamily.ts`) authors the six schemas at the reserved ids + the task-class bindings idempotently, called on first tasks-hub open (`App.tsx` HubView) and first Calendar open (CalendarView); a no-op when present (option ids are authored fresh per workspace — labels stay canonical, ids resolved from the schema at query time). Also self-heals the task class node at its reserved id when the workspace was never seeded (offline-first devices — else `getClassBindings` can't see the bindings and every open would re-author them); `createClass`/`createPropertySchema` grew the caller-chosen-id option the object.create already had (no new ops) |
| 3 | Dead `DatePicker.tsx`; two calendar component families | `apps/web/src/ui/DatePicker.tsx` (272 lines) has zero imports — superseded by `pickers/DatePickerPopup.tsx` + `pickers/CalendarPopup.tsx`; the top-bar `components/ui/CalendarPopup.tsx` is a second, parallel family | Delete `ui/DatePicker.tsx` (or fold anything still unique into the pickers family) and consolidate the two calendar families |

**Missing features (pending)** — read-model/UI-only unless marked:

| # | Item | Evidence | Approach |
|---|---|---|---|
| 4 | Day-page aggregations — no day-class branch in PageView | (a) "Dated this day": the day node's EXISTING backlink set — date refs already fan out to the day node in the edge index (`edges.ts:96-130`), so this is a backlinks render, zero model work; (b) Scheduled/Overdue task section (named in §34.19 `:1146`); (c) "Created today": a `createdAt` range query only — the date-aware arms exist (`compiler.ts:480-606`), no model work | One day-branch in PageView composing the three as named system-query sections (SCHEMA.md system-sections contract: collapsed by default, no eager queries). **Cross-note 2026-10-02**: the Calendar day view (§34.19 row, shipped) delivers the three aggregations — daily-note embed, scheduled/overdue tasks, created-today — plus general date references, on a dedicated surface; the day-page branch in PageView remains owed |
| 5 | Bucketed tasks surface | Zero bucket logic anywhere in `apps/web` (grep-verified: no Overdue/Upcoming/Unscheduled) | Overdue/Today/Upcoming/Unscheduled/Completed computed from `taskScheduled`/`taskDeadline` + closed state; a hub section or view mode over the existing tasks-hub members |
| 6 | Recurrence engine | Fully absent — only the UUID constant (`seeds.ts:143`); v1 migrated it as a plain select (`migrate.py:154-156`); nothing executes it | Spec decision first: materialized next occurrence (op) vs compute-on-read; then engine + picker (§34.19 TasksPopup row) |
| 7 | Prev/next day navigation | Zero `prevDay`/`nextDay` hits; no date bar on day pages or the journal feed; the top-bar calendar popup is the only day-to-day path | Date bar on day pages + journal header — ±1 day over the deterministic day-node id (ensure-chain is idempotent). **Cross-note 2026-10-02**: prev/next day ships inside the Calendar day view (±1 over the local ISO date); the day-page/journal date bar remains owed |
| 8 | Open-today keyboard shortcut | None exists; §34.19 `:1131` 🟡 is accurate (Ctrl+Shift+T is free in the keydown map) | Keymap entry → local-midnight today + ensureDateChain + open |
| 9 | Slash `date` command | Only 5 slash commands exist (`TriggerPopup.tsx:33-39` — text/quote/checkbox/hard_break/url) | The @-picker already covers NL date insert (shipped above), so this is discoverability/parity: `/date` surfacing the same suggestion; pairs with the pending `daily:` suggestion prefix (§34.19 `:1134`) |
| 10 | Class quick-create from calendar — **SHIPPED 2026-10-02** | A calendar pick only ensures the chain + opens the day page (`App.tsx:1202-1205`); no way to create e.g. a meeting-classed page with its date property pre-set to the picked day | Executed as the Calendar day view's quick-create chips (`CalendarView.tsx` + `dateChipCandidates` in `calendarViewUtils.ts`): one chip per class with a date-typed binding (task prefers `taskScheduled`; year/month/day/class system classes excluded), click → create object of that class + `setDateProperty` to the selected day + open. The `{date}` template placeholder pairing §34.25 D4 remains owed. **Addendum 2026-10-02 (same-day follow-up): the chip list is user-configurable per workspace** — Workspace Settings → "Calendar Quick-Create" enumerates the eligible classes (same shared `dateChipCandidates` rule) with per-class toggles; stored device-local under `notees.settings.calendarQuickCreateClasses.<workspaceId>` (`string[] | null`; null/absent = follow defaults = current eligibility — on a fresh workspace that means the system Task class; explicit lists intersect with current eligibility so stale ids silently drop). Reset to defaults clears the key. Helpers + hook in `apps/web/src/ui/components/calendarQuickCreateSettings.ts`. Cross-device preference sync remains §34.29 #8 territory — no server store built |
| 11 | Calendar breadth | Month-grid drill-down only; no week strip/agenda/objects-under-days; `hasNote` is day-node-existence-only (`App.tsx:1201`) so date-RANGED objects are invisible; `date_range` renders in the property panel only (`MetadataSection.tsx:553+`) — no calendar span, no day-page range list | Extend calendar marks to range overlap (the fan-out already projects range ends; a date query answers "objects overlapping this day"); week strip + agenda under the month grid. **Cross-note 2026-10-02**: unchanged by the shipped Calendar day view — the view's month-grid dots remain day-existence-only (has-note), same treatment as the top-bar popup |
| 12 | Command palette date affordances | No `is_daily:` prefix, no Date Pages section (`CommandPalette.tsx`); only raw YYYYMMDD keyword matching (`:131`, `rawDateKeywordOf`) | Add the prefix + section (§34.19 `:1142` names these — this row carries the detail); consider formatted-date keywords ("feb 14") alongside raw |
| 13 | CLI today/journal command | Absent from `apps/cli/src/cli.ts` (tree: object/class/asset/sync/shell/export, `:824-994`) | Cheap: `notees today` = ensureDateChain(today) + open or append-capture; `notees journal` = day pages reverse-chron |
| 14 | Page footer | Word count + Created/Updated buttons → day pages | §34.19 `:1138` ❌ still accurate — scheduled as §34.27 L4; cross-ref only, not re-planned here |
| 15 | Reviewed state on day pages | Absent | NO protocol change needed — a boolean property on the `day` class suffices; optional calendar-color + unreviewed-queue UX on top |
| 16 | Query-result calendar/gantt view mode | §34.19 `:1143` + the §34.21 future register name these | Cross-ref only; the calendar mode will want #11's breadth |
| 17 | Inbound capture integrations appending to today's note (LOW priority — hygiene) | Nothing exists | CLI quick-capture (`notees object create --parent <dayNode>`) is the nearest current path; mail/webhook ingestion is an integration decision, not scheduled |
| 18 | Mobile depth | Flutter m8 shipped the Home Today card + Journal tab (§34.22 `:1298`) | Pickers/precision/ranges on mobile are UNVERIFIED → pending parity check against the web surfaces above |

**Exists but should change (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| 19 | BibTeX import writes `publicationDate` as a plain string | `cli.ts:710-712` — graph-inert: no year-node backlink, and the query date arm won't match a bare string; CSL export mirrors it (`csl.ts:220-225` regexes the year out of the string) | Resolve to the year node at import time (chain-create is idempotent via `ensureDateChain`); export reads the ref back through the chain |
| 20 | Shallow task conversion | `/checkbox` assigns the task class and creates NO properties (`BlockTextEditor.tsx:631-641`) | With #2 fixed: conversion also authors status (open) at minimum; scheduled/deadline stay user-set |
| 21 | Range editing UX (LOW priority) | Two stacked single-date pickers, one per end (`MetadataSection.tsx:671-684`) | Shift-click-to-set-end within one picker session |

**Decisions:**

- **Time-of-day is a deliberate non-goal** — restated as a decision in the SCHEMA.md owed-work register (entry added 2026-10-02): whole-day precision, datetimes rejected at the parse boundary (`dates.ts:45-59`), local-midnight boundaries, no tz handling. Anything wanting times needs a model-law change first (normative amendment + three-client lockstep), never a silent client extension.

**Register cross-checks (no double-listing):** §34.19 `:1131` keyboard map 🟡 (#8 stays accurate) · `:1133` slash commands 🟡 (#9 detail here) · `:1138` page footer ❌ → §34.27 L4 (#14) · `:1142` command palette 🟡 (#12 detail here) · `:1143` view modes 🟡 (#16) · `:1144`/`:1146` journals rows (#4) · Calendar day view row in §34.19 P0 (ships #2/#10 here; #4's aggregations surface, #7's prev/next, #11's dots note — headlines stay in this register) · `:1179` MobileLayout 🟡 (#18 web side) · §34.21 future register (#16) · §34.22 m8 paragraph (#18 mobile side) · §34.25 D4 daily-note templates (parked — the `{date}` placeholder pairing with shipped #10 remains owed) · §34.28-own shipped confirmations above (#2, #10).

### 34.29 Navigation — Capacities comparison & gap-analysis register (2026-10-02, fully verified; implementation pending)

A fully-verified gap analysis of the **navigation** feature area, benchmarked against [Capacities' navigation reference](https://docs.capacities.io/reference/navigation) (fetched 2026-10-02) plus a sweep of Notees' adjacent navigation mechanics (sidebar, palette/search, breadcrumbs, recents/favorites, peek cards, deep links, date navigation). Every claim was verified against the tree on 2026-10-02 (file:line evidence throughout; the two load-bearing negatives — no graph surface behind the "Graph View" setting, no live importer of `SearchBox` — were grep-confirmed). Item numbers are stable and cross-referenced from other registers; where an existing register row already names an item, this section carries the detail and the row keeps the headline (no double-listing — cross-checks at the bottom).

**Display-mode mapping (the Capacities doc's core):**

| Capacities mode | Notees equivalent | Verdict |
|---|---|---|
| Full-page view | Main content area — `NodeView` routes by node type (`App.tsx:219-269`: class → ClassView, block → FocusedBlockView, else PageView); every surface funnels through `openPage(id)` (`App.tsx:430-434`, state + `pushState` + recents) | Parity |
| Preview modal (editable, arrow-key skimming through collections without context switch) | None — quick-look is sidebar-peek-only | Gap #4 |
| Side panel (one or more objects beside main content, work simultaneously) | Right-sidebar **peek cards** — `SidebarNodeCard` renders the full `NodeView` (`App.tsx:278-335`), so content is fully editable; stack most-recent-first; header IS the right-anchored breadcrumb trail; links inside navigate the main view; "Open in main view" + close buttons | Parity (keyboard gap #5, history gap #11) |
| Tabs with own state | None — single `selectedPageId` | Gap #6 |
| Space switcher | `WorkspaceSwitcher` — full tenancy isolation per §34.13 (separate derived DB, reconnect on switch); stronger isolation but heavier than Capacities' in-account spaces | Gap #7 |

**Verified parity (✅ 2026-10-02 — confirmed so nothing below re-plans it):**

- **Peek cards ship the side-panel mode fully** — editable full node views in the right sidebar, stacked, with breadcrumb headers (evidence above).
- **Breadcrumbs** — parent-chain walk with cycle guard + ellipsis collapse beyond 4 crumbs + right-anchored variant for peek cards (`components/Breadcrumbs.tsx`, topbar center `App.tsx:1180-1184`). Crumb *editing* (reassign/add parent) stays owed at §34.19 `:1136`.
- **Deep links** — `/<uuid>` scheme (`nodeLink.ts:11`); pasting a node link or bare uuid into an editor splices a mention instead of text (docs/ux.md:53-54); node context menu carries Copy link.
- **Recents on every open + live sidebar refresh** (§34.20 shipped record; `Sidebar.tsx:62-74`, 12-entry cap).
- **Cmd/Ctrl+K palette, Ctrl/Cmd+Shift+N quick-add, top-bar calendar popup, deterministic date chain** (`CommandPalette.tsx:105`, `App.tsx:506-521`, `App.tsx:1200-1212`) — the date-side gaps are §34.28's, cross-checked below.

**Verified bugs (pending):**

| # | Bug | Evidence | Fix direction |
|---|---|---|---|
| 1 | Dead **"Graph View"** landing option | `UserSettingsModal.tsx:504` offers `value="graph"`; `App.tsx:462` explicitly falls back to Pages (no graph surface exists); `variables.css:112` still carries "Graph View" theme tokens | Remove the option + tokens, or implement the view — that choice belongs to the graph-view rows (§34.19 `:1167` ❌ P2, §34.21 future register: v1 WebGL/SGE renderer is the reference, portability decision first). Until one of those lands, the setting lies |
| 2 | **SearchBox orphaned** — FTS + query DSL unreachable from the shell | `SearchBox.tsx:69` exported; no importer in `apps/web/src` (grep-verified; only its test `search-box.test.tsx` + a `SearchField` doc-comment mention it); the sidebar search icon opens the palette instead | Wire it into the shell (palette content group or sidebar field) or delete it. The FTS engine (`packages/store/src/search.ts`, `search_index` FTS5 / FTS4 fallback `schema.ts:31-38`) and the DSL (`class:`/`prop:`/`type:`/`linked:` via `@notees/query`) currently have NO live UI path — only the CLI (`object search`, `apps/server/src/routes-objects.ts:600-609`) — detail §34.30 M1 (fix shapes post-§34.23: `type:` prefix → `isClass:`/`presentAsMain:`) |
| 3 | ~~Stale CLI surface docs~~ **✅ 2026-10-03 — the register row was itself stale**: `search` and `backlinks` are top-level commands in the code (`apps/cli/src/cli.ts` `program.command("search")` / `program.command("backlinks")`) and usage.md documents them top-level (`docs/usage.md:114,123`) — verified matching in the §34.16.5 pass, no change needed | `apps/cli/src/cli.ts` (top-level `search <query>`, `backlinks <id>`) vs `docs/usage.md` (same) | None — closed as verified |

**Missing features (pending)** — read-model/UI-only, zero protocol work, unless marked:

| # | Item | Evidence | Approach |
|---|---|---|---|
| 4 | **Preview modal** (Capacities display mode) | No modal preview anywhere; quick-look is the sidebar peek only (`App.tsx:278`) | Owner product decision FIRST: add a modal variant (peek-in-modal reusing `NodeView`) or reject the pattern explicitly and record the rejection here. Capacities' value: arrow-key skimming through a collection without leaving context — Notees gets most of that from peek cards (#5 makes it keyboard-reachable), so rejection is a defensible outcome |
| 5 | **Peek keyboard navigation** | Zero keydown handling in `SidebarNodeCard` (`App.tsx:278-335`); opened only by shift+click (`BlockRow.tsx:158-166`); no shortcut closes the top card | Arrow-key cycling across the open peek stack, Esc closes the topmost card, a focus model for card bodies. Cheap, self-contained, no model work |
| 6 | **Tabs with independent state** | Single `selectedPageId` (`App.tsx:430-434`); no tab strip exists anywhere | Capacities-style tab strip, each tab own nav state. Default session-only (per the §34.21 decision-5 philosophy: view state is session state) unless the owner rules otherwise. Chrome work only, zero protocol |
| 7 | **Lightweight spaces/collections within a workspace** | `WorkspaceSwitcher` switches whole derived DBs (heavyweight reconnect); no mid-level organizational grouping exists | Spec decision FIRST, and do NOT conflate with §34.13 tenancy (per-workspace isolation is decided law). Capacities spaces are organizational scopes inside one account; a Notees equivalent could be class-scoped filtered hubs or a future grouping concept — owner decision before any build |
| 8 | **Cross-device favorites/recents** | Both device-local `localStorage` (`notees.favorites`, `notees.recents`; `Sidebar.tsx:62-74,187-197`); a second device starts empty | Decision FIRST: syncing collides with the design law "device state is never an op". If favorites should follow the user, they must become user-preference semantics (server-stored, like display settings) — that is a protocol/product ruling, not a code change. Until ruled, the device-local ship (§34.20) stands |
| 9 | **Sidebar hierarchical browsing** | Sidebar is flat: 7 hub rows + favorites + recents (`Sidebar.tsx:30-40` NAV_ENTRIES); no class/tag tree, no page tree, no containment browsing despite the graph model | Read-model only: e.g. an expandable Classes tree (class → members) or a Browse section over page parentage. Keep the headline with §34.19 `:1141` (rail/pinned/reorder) — this row adds the tree concept |
| 10 | **Content-level search in the palette** | Palette fuzzy-matches page/class **titles** from in-memory lists (`CommandPalette.tsx:45-70`); block content (title-less) is unreachable; the FTS index exists but has no shell path (bug #2) | Fold FTS hits into Cmd+K as a second result group (title matches first, content matches after), or wire SearchBox as the shell search. Title-is-content makes page-title matching mostly sufficient — the real hole is **block** content and **property values** — detail §34.30 M4/M5 |

**Exists but should change (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| 11 | Peek state invisible to history/URL | `pushState`/`popstate` track the main view only (`App.tsx:430-434,467-492`); peek open/close is not history-addressable and unrecoverable on reload | Either encode the peek stack in the URL (`?peek=id,id`) or accept session-only and record that here. LOW priority — polish, not a gap |
| 12 | Unlinked references are pages-only | Computed in `SystemSections.tsx` for pages only (docs/ux.md:72); blocks get none | Extend the unlinked-mention computation to block titles. The Promote/Ignore *actions* stay tracked at §34.19 `:1139` — cross-ref only, not re-planned here |

**Decisions (needed from the owner before implementation):**

- **#4 preview modal** — build the third display mode or reject it with a recorded ruling (peek cards + #5 may make it redundant).
- **#7 spaces** — organizational grouping inside a workspace is unmodelled; anything here must respect the §34.13 tenancy decision (spaces ≠ workspaces).
- **#8 favorites sync** — requires re-classifying favorites as user-preference semantics; silent client-side sync would violate the op-log law.
- **#6 tabs persistence** — default proposal: session-only, matching the §34.21 view-mode ruling.

**Register cross-checks (no double-listing):** §34.19 `:1127` Back/Forward in-app history ❌ + `:1140` topbar Back/Forward buttons (in-app history stays THERE — #11 is only peek-state-in-URL, a different item) · `:1131` keyboard map 🟡 (#5 adds the peek entries) · `:1136` breadcrumbs 🟡 (crumb editing stays there) · `:1141` sidebar 🟡 (#9 detail here) · `:1142` command palette 🟡 (#10 detail here; its "Recently Accessed" section covers a recents view — do not add another) · `:1163` NodeCollectionView + global graph pseudo-pages ❌ (untouched) · `:1167` GraphView ❌ P2 (bug #1 must NOT implement graph — it removes or wires the dead option only) · `:1169` RightSidebarCards 🟡 → §34.27 L3 (TOC/references sections in the panel — adjacent to, but not part of, #4/#5) · `:1180` Shortcuts cheatsheet 🟡 (discoverability home for #5's new keys) · §34.13 workspace tenancy (#7 must respect it) · §34.21 future register (graph portability decision owns #1's "implement" branch) · §34.28 #7 prev/next day navigation (already scheduled there — this register makes no date-nav claims) · §34.28 #12 palette date affordances (detail of `:1142`, cross-ref'd).

### 34.30 Search & command palette — Capacities comparison & gap-analysis register (2026-10-02, fully verified; implementation pending)

A fully-verified gap analysis of the **search & command palette** feature area, benchmarked against the [Capacities Search & Command Palette reference](https://docs.capacities.io/reference/search) (fetched 2026-10-02; Capacities Search 2.0, launched 2025-01 — one unified intent-ranked engine reused across palette, linking search, tag pickers, and dashboards). Every claim was verified against the tree on 2026-10-02 (file:line evidence throughout; load-bearing negatives grep-confirmed — SearchBox has zero importers; no whole-word or replace-all anywhere). Two §34.19 rows in this area were re-verified rather than assumed: `:1131` "Ctrl+F find" — SHIPPED (`FindReplaceWidget`, Ctrl/Cmd+**Shift**+F; polish owed at C4) · `:1142` command palette — accurate 🟡, detail here. Item numbers are stable and cross-referenced from other registers; where an existing register row already names an item, this section carries the detail and the row keeps the headline (cross-checks at the bottom).

**Cost frame: everything in this register is derived state or client chrome — zero op-log, zero protocol, zero lockstep round.** FTS ranking, snippets, index content, palette wiring, find polish: all rebuildable by `reindexAllSearch`, or pure `apps/web` UI. The one hard constraint is the FTS4 (sql.js) fallback: every MATCH-syntax or ranking feature must work on FTS4 too (`packages/store/src/search.ts:40-49` documents the intersection constraint — bare `rank` orders on both backends, `bm25()` is FTS5-only, `snippet()` exists on both).

**Shipped-state confirmations (✅ 2026-10-02):**

- **FTS core** — FTS5 `search_index` + `search_index_docid` rowid map (`packages/store/src/schema.ts:31-32,298-311`), FTS4 fallback DDL for sql.js (`schema.ts:38-39`), cross-backend snapshot repair `isSearchIndexQueryable`/`dropSearchIndex`/`reindexAllSearch` (`packages/store/src/search.ts:73-122`, restore path `store.ts:366-405`).
- **Indexed text** — title-is-content plaintext + asset original names + recursive quote children (`packages/store/src/content.ts:25-53`); blocks ARE in the index (object appliers reindex on create/update/delete); class reindex appliers (`appliers.ts:738,770`) SHIPPED with the §34.23 render-state migration — classes are FTS-visible now.
- **Render-state migration shapes landed in code (✅ re-verified 2026-10-02, evening)** — envelope v3 (`packages/protocol/src/envelope.ts:25`), SearchBox already emits `isClass`/`presentAsMain` conditions + cheatsheet (`SearchBox.tsx:6,30-31,65-76,155`), so the stale-shape bug originally logged here as B1 was caught and fixed by the migration itself (dropped from the bug table). The §34.23 GTK/Flutter lockstep rows remain open but block nothing in this register — everything here is derived state or web chrome.
- **Find & replace widget** (page view) — live search while typing, case-sensitive toggle, replace row behind chevron / Ctrl/Cmd+H, Enter cycles matches, block-level highlight + scroll-into-view (`apps/web/src/ui/editor-popups/FindReplaceWidget.tsx`, wired `PageView.tsx:128-133`).
- **Command palette** — Ctrl/Cmd+K capture-phase toggle (`CommandPalette.tsx:104-115`), ordered-subsequence fuzzy scorer (word-start +3, consecutive +2, shorter-target tiebreak, `:45-70`), pages/classes/actions groups with full keyboard nav, raw-date keywords so compact dates find date pages (`rawDateKeywordOf`, `dateDisplay.ts:122-129`).
- **Structured query layer** (the Notees strength vs Capacities Pro) — QueryAST + SQLite compiler (`packages/query`), query DSL, embedded query tokens with builder popover + view switcher + Markdown export (`QueryBlockView.tsx:605-716`), aggregate ASTs (`runAggregateAst`), CLI dual path (`apps/cli/src/cli.ts:893-910` — plain text → `/api/search`, DSL → `parseQueryLanguage` → `/api/query`; DSL errors exit 2, never degrade), server `/api/search` + `/api/query` (`apps/server/src/routes-objects.ts:600-635,645+`), `--isClass`/`--presentAsMain` filters (post-§34.23 shape).
- **Recents + date-aware query arms** — recents recorded on every open (device-local + `notees:recents` broadcast, `App.tsx:428-433`, `Sidebar.tsx:57-90`); structured date filtering via the date-aware compiler arms (`compiler.ts:480-606`).

**Verified bugs (pending):**

| # | Bug | Evidence | Fix direction |
|---|---|---|---|
| B1 | Stale "classes invisible to FTS" comment | `NodeSelector.tsx:336-340` — contradicted by the shipped class reindex appliers (`appliers.ts:738,770`) | Delete when M4 lands, after verifying classes actually surface in results |
| B2 | Palette chrome violates the UI-primitives law | `CommandPalette.tsx:242` raw `<input>`, plain `<button>` rows — AGENTS.md "UI primitives (always)" mandates composition from `ui/components/ui` (`SearchField` exists and its doc-comment already names SearchBox as a consumer) | Compose from SearchField + library list/button primitives as part of M4/M6; loading/empty states come free |

**Missing features (pending)** — all derived-state/UI; no protocol work unless marked:

| # | Item | Evidence | Approach |
|---|---|---|---|
| M1 | Shell search-results view | SearchBox (`apps/web/src/ui/SearchBox.tsx:69`, FTS + query-DSL field with inline errors + grammar cheatsheet, fully tested, already on the §34.23 `isClass`/`presentAsMain` shapes) has ZERO importers (grep-verified); the sidebar magnify button opens the palette (`Sidebar.tsx:304-312`); FTS + DSL have no live UI path — headline stays §34.29 #2 | Mount SearchBox in the sidebar with a results panel (hydrate via `client.search`); only useful after M2+M3+M5 land — sequence M2→M3→M5→M1 |
| M2 | ~~FTS relevance ranking~~ **✅ DONE 2026-10-03 (§34.45)** — `ORDER BY rank` + recency: FTS5 orders by the hidden rank column in SQL; the stock sql.js FTS4 has no rank column (verified), so that module scores matchinfo('x') hit counts in JS — both tiebreak by `updated_at` DESC then id, and the module is detected from the database (a cross-backend snapshot can park an FTS4 index inside better-sqlite3). Title-weight column still pending (DDL, sequenced last per the register) | `store.ts:341-354` — `ORDER BY d.node_id LIMIT ?`, no rank, no recency, no title preference; Capacities' exact > related > recency is exactly what this forecloses | `ORDER BY rank` (hidden column, works FTS4+FTS5) + recency tiebreak from node timestamps; optional title column weight (title-is-content: a first-block column — DDL change, must ride the cross-backend rebuild path `search.ts:60-122`) |
| M3 | ~~Snippet/highlight extraction~~ **✅ DONE 2026-10-03 (§34.45)** — `searchSnippet` in `packages/store` excerpts the densest query-term cluster with char-accurate match spans; computed in JS over the derived plaintext because the stock sql.js FTS4 `snippet()` emits its column index into the output (verified) — byte-identical on both modules, no MATCH query needed | `SearchHit = { nodeId }` only (`store.ts:60-62`); callers rehydrate whole nodes — no match context for any results UI; `snippet()`/`offsets()` exist on FTS4+FTS5 | Snippet helper in `packages/store` returning excerpt + match spans; consumed by M1/M4 |
| M4 | Palette content group | Palette items are pages+classes+actions only (`CommandPalette.tsx:117-141`); FTS is never called from the palette; blocks unreachable, no snippets — headline stays §34.29 #10 | Debounced `client.search` alongside the fuzzy pass; "Content" group after title matches with M3 snippets; block hits labeled by containing page (M8) |
| M5 | ~~Property values in the FTS index~~ **✅ DONE 2026-10-03 (§34.45)** — `extractSearchPlaintext` folds text-ish property values into the row (text carrier content, scalar strings, select labels, numbers); `property.set`/`property.unset` reindex the owner; `reindexAllSearch` rebuilds | `extractSearchPlaintext` indexes content plaintext + asset names + quote children ONLY (`content.ts:25-53`); Capacities searches property *values* (names excluded); QueryAST property conditions exist but are exact structured filters, not search | Append effective text-ish property values in `extractSearchPlaintext`; derived index — `reindexAllSearch` rebuilds, zero protocol impact |
| M6 | Palette sections & actions breadth | §34.19 `:1142` names: Recently Accessed/Created, Random, Commands, Date Pages, Blocks, Properties sections; filter prefixes (`class:` `uuid:` `is_page:` `is_daily:`); "+ Add page"; quick-add ⌘↵. Today: 3 hardcoded actions (New page / Toggle theme / Sign out) | Section registry + action contribution point; recents section reads the existing device-local record (`App.tsx:428-433`) — no sync, honoring the §34.29 #8 device-state ruling; typed creation `/class/title` (Capacities `@/person/Ada` pattern); paste-to-import. Date affordances stay §34.28 #12 |
| M7 | Linking-search create flow + type refine | `@`-mention candidates = pages+classes+FTS union filtered client-side by display-name substring — **citation corrected 2026-10-02 (§34.34 BB2): the `outliner-context.ts:194-208` capture path is dead code (zero consumers); the live candidate path is `NodeSelector.tsx:341-358` (unfiltered FTS `client.search`, "all" mode) + class reindex appliers `packages/store/src/appliers.ts:736-738,770`**; no create fallback, no type prefilter | Reroute candidates through M2-ranked search; add the create row + class refine (NodeSelector already has page/class modes + class filters, `NodeSelector.tsx:341-374`) |
| M8 | Block-linking picker | Blocks are FTS-indexed but there is no `((`-style picker and no containing-page label on block hits (Capacities shows the containing object name) | Extend M4's content group + NodeSelector with a block mode; containing-page breadcrumbs already computed by `views/grouping.ts:12` |
| M9 | Query builder depth | Builder writes flat-AND ASTs with ONE group-by dimension + ONE measure, reads back only the first of each (documented M1 limitation, `QueryBlockView.tsx:605-716`); no OR/NOT | OR/NOT condition groups, multi-dimension group-by, multi-measure — extends the existing AST; check `packages/query` model capacity first |
| M10 | Extended-search shell parity | Capacities extended search (Pro): full-page results, type/tag filters, objects-only/blocks-only, limit, group-by-type, save-as-query | Query tokens already cover "save"; the delta is shell-side — grouping + type scoping + limit controls in the M1 results view; reuse the §34.21 `NodeCollection` view-mode machinery to render |
| M11 | OS-global search | Capacities: Raycast integration (Pro). Notees: `notees search` CLI + API are the stand-in | Not scheduled — record as accepted divergence (CLI/API are the machine surface) |
| M12 | Manual reindex control | Repair is automatic on cross-backend snapshot restore only (`store.ts:386-399`); no user-facing recalculate (Capacities: Settings > Offline & Sync) | Settings action → `reindexAllSearch`; cheap once M6's action registry exists |

**Exists but should change (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| C1 | `buildMatchQuery` expressiveness | AND-only prefix terms (`search.ts:51-58`): `11607-1` → `11607* AND 1*` matches any doc containing both ANYWHERE; no phrase/OR/negation. The conservative builder is deliberate (cross-backend query-language intersection, `:40-49`) — extend, don't replace | Quoted `"phrases"` (valid FTS syntax on FTS4+FTS5); keep the bare-token default. M2's ranking also stops the false-positive set being presented unordered |
| C2 | Date pages findable via the palette only | `rawDateKeywordOf` keyword trick (`dateDisplay.ts:122-129`); the FTS index carries the FORMATTED label, so `notees search 20261002` finds nothing | Index a canonical `YYYY-MM-DD` token in date pages' search text (derived, rebuildable) or accept the asymmetry — owner call, LOW |
| C3 | Mention candidates unscored | `outliner-context.ts:194-208` — substring filter over display names after an FTS union; no ranking, duplicates the fuzzy logic | Reroute through M2-ranked search; small once M2 lands (pairs with M7) |
| C4 | Find & replace polish gaps | No Ctrl/Cmd+F capture (left to browser default; capture precedent at `CommandPalette.tsx:104-115`); no whole-word (Capacities has match-case AND whole-word); no replace-all; PageView-only (Capacities covers side panel/reader); range-level match selection dropped vs the archived widget — block-row highlight only (regression recorded in the file header, `FindReplaceWidget.tsx:14-17`) | Whole-word + replace-all in `block-find-replace.ts`; shortcut capture is an owner product call (overriding browser find); side-panel coverage rides the peek cards |
| C5 | Search limits hard, no cursor | Store `limit = 50` (`store.ts:342`); server default 50 / cap 500 (`routes-objects.ts:600-635`); no OFFSET/cursor anywhere | Add cursor to `Store.search` + `/api/search` alongside M1 |
| C6 | CLI `linked:` resolver kludge | Name→id prefetch through `/api/search` exact-name matches (`cli.ts:280-313`) | Proper name→id resolution endpoint (or resolver API) — small server addition |

**Decisions / non-goals (recorded 2026-10-02):**

- **Semantic search — NON-GOAL.** Capacities' semantic mode is a server-side Pro feature with no faithful equivalent under the privacy-first/local-first law; search modes (Auto/Exact/Semantic) are therefore not planned. Revisit only as on-device embeddings over the derived index, and only by explicit owner opt-in.
- **Ctrl/Cmd+F capture — owner call** (C4): default proposal YES for the app shell (the widget is strictly richer than browser find: replace, block highlight), matching Capacities.
- **Title column weight (M2 option B)** — multi-column FTS DDL must ride the cross-backend rebuild path; sequence after plain `rank` + recency proves out.
- **No SCHEMA.md amendment required** — nothing here touches the op log, the wire, or the node model; all derived state rebuilds from the log (the law that makes this register cheap). Implementation surface: `packages/store`, `apps/web`, `apps/server`, `apps/cli` only.

**Register cross-checks (no double-listing):** §34.19 `:1131` keyboard map 🟡 — accurate as written (palette/quick-add/find are the three shipped hotkeys; C4 carries the owed find polish) · `:1142` command palette 🟡 (M4/M6/M7 carry the detail) · §34.29 #2 SearchBox orphaned (headline stays; M1 detail here) · §34.29 #10 palette content search (headline stays; M4/M5 detail here) · §34.28 #12 palette date affordances (stays there; M6 references it) · §34.23 render-state migration — code LANDED 2026-10-02 (envelope v3 `envelope.ts:25`; SearchBox already migrated); its own task-list checkboxes were still unchecked at verification time (§34.23's bookkeeping, not this register's); the GTK/Flutter lockstep rows there remain open and do not block anything here · §34.29 #8 favorites/recents sync ruling (M6's recents section uses the device-local record — no conflict) · SCHEMA.md owed-work register (no entry needed — see decisions) · **§34.31** (views register — its V2 save-as-view rides the builder M9 builds and the results view M1 hosts; §34.31 C1 is the DSL↔AST coverage gap, distinct from this register's C1 FTS-match syntax).

**Sequencing:** UNBLOCKED as of 2026-10-02 (the §34.23 code this register was written against has landed). Suggested order: **M2→M3→M5** (store core, one branch) → **M1+M4+M6+M7+M8** (shell wave, fixes B1–B2 en route) → **C1–C6** mop-up → **M9/M10/M12** follow-ups. C4 shortcut capture needs the owner call first.

**Shipped state (2026-10-02).** Revision 11 is live end-to-end: monorepo tag **`v2.0.0-m3`** (six commits: protocol!, store!, query+export!, server+cli!+migration script, web!, docs); `pnpm -r build` + `pnpm test` green at the tag (protocol 108, domain 23, store 155, query 153, export 32, sync 13, server 107, web 378, cli 34). **GTK `v2.0.0-m3`** released (439 tests; wheel/sdist/archpkg; live-server e2e vs the TS reference). **One-time migration executed** against the live relay: 167,050 envelopes bumped to v3, 30,611 payloads rewritten (5,827 page→`presentAsMain:true`, 24,363 block→`false`, 145 class→`class.create`, 276 legacy `name`→text-token), 24 snapshots dropped, 10 derived DBs rebuilt from the migrated log, `restore_epoch` bumped ×4 workspaces; backup `relay.db.bak-20261002-131221`. Host redeployed on plain compose with images tagged `2.0.0-m3` (`.env` pins updated; ghcr push still blocked — host-local images); `/api/version` reports `protocolVersion: 3`; healthz + web serving verified; `verify-min.mjs` smoke pending the admin password (owner). Flutter lockstep (`v2.0.0-m9`) in progress at the time of writing. Corner-menu `NodeMenuButton` feature (parallel session's WIP) shipped inside the web commit.

**Flutter lockstep addendum (2026-10-02).** Released as **`notees-flutter v2.0.0-m11`** — m9/m10 already existed as owner-pushed app-fix releases with published signed APKs, so the lockstep took the next free number (annotated tag explains why). 419 tests green, `flutter analyze` clean; `user.dart` WIP left pristine and unstaged; fixtures re-vendored byte-verbatim; new coverage: placement-default bit, promotion stringify, demotion no-unflatten, class children of a class legal, class-with-parent move rejected, block-to-root legal, strict `nodeType` rejection, v19→v20 migration, snapshot-emit columns. Three-way Revision 11 lockstep is complete: TS reference + GTK m3 + Flutter m11.

### 34.31 Views (saved views, link views, data views) — Capacities comparison & gap-analysis register (2026-10-02, fully verified; implementation pending)

A fully-verified gap analysis of the **views** feature area, benchmarked against [Capacities' Views reference](https://docs.capacities.io/reference/views) (fetched 2026-10-02). Capacities uses "views" as an umbrella for three things — **object views** (how one object renders when linked elsewhere: inline / link block / small card / wide card / embed / page, with a per-object-type default), **data views** (how a group of objects renders: table / gallery / wall / list / embed, hosted on object types, queries, collections, and tags), and a **graph view** (local links around one object, side panel, no full-space graph). Verified against the tree on 2026-10-02 (post-Revision-11 code; file:line evidence throughout; load-bearing negatives grep-confirmed — no `view`/`saved_search` table in the derived schema, zero `type: "query"` token constructors outside tests, no importer of `SearchBox`). Item numbers are stable and cross-referenced from other registers; where an existing row already names an item, this section carries the detail and the row keeps the headline (cross-checks at the bottom). **All table rows below are PENDING; shipped items are the ✅ confirmations above the tables.**

**Taxonomy mapping (the Capacities doc's core):**

| Capacities concept | Notees equivalent | Verdict |
|---|---|---|
| Object views + per-type default link view | Links are typed marks with ONE rendering; no per-class link/card presentation, no card-style link blocks | Gap **V5** (unregistered until now) |
| Data view — table | `TableView` (§34.21): inline editing, multi-column sort, column panel, windowing | Parity-plus |
| Data view — list | OutlineView mode | Parity |
| Data view — gallery / wall (small-card customization) | `CardsView` + cover layouts (§34.21 V12, session-only); no gallery/wall mode, no per-class card config | Gap **V6** |
| Data view — embed | Query token embedded in page content | Parity (different mechanism, same job) |
| Graph view (local, side panel) | None | Gap V8 — cross-ref only (§34.19 `:1167`, §34.21 future register, §34.29 #1) |
| Views hosted on query / collection / tag | Query blocks host ASTs (shipped); collections are explicit-membership nodes, NOT query-backed (`op-types.ts:307-320`); no tag-hosted data view | Gap **V9** |
| Mobile gating (phone = list only; tablet = no graph) | Responsive web, no gating | Accepted divergence — no action |

**Shipped-state confirmations (✅ 2026-10-02 — verified so nothing below re-plans it):**

- **View-mode system** — §34.21 record stands: registry/`NodeCollection`/`ViewSwitcher`, modes `outline|prose|cards|kanban|table`, hubs (tasks/assets/pages/classes/inbox/whiteboards), V12 polish (multi-sort, column panel, full inline editing, kanban multi-select/collapse/session-reorder, cover layouts + asset thumbnails). Headline stays §34.19 `:1143`; not re-listed here.
- **Query blocks as the saved-view vehicle** — token schema `content-mark.ts:133-139` (`{type:"query", queryAst, view?}`; AST union keeps foreign/newer ASTs applicable); rendered through `NodeCollection` + registry switcher (list/table), aggregate grid for aggregation ASTs, Markdown export, invalid-AST placeholder; live re-run + 200 cap (`QueryBlockView.tsx:72,419,424,552,611,622`); persisted view contract `view: { mode: "list"|"table" }` (`QueryBlockView.tsx:16,100,396`). Because the token IS content, a saved query rides the op log — synced, local-first, no new op type.
- **Query engine is the comparative strength** — QueryAST: arbitrary nested AND/OR/NOT groups, 8 property operators, 4 scopes, multi-sort, group-by aggregations (count/countDistinct/sum/avg/min/max); text DSL (`packages/query`); server `/api/query`, worker RPC, CLI dual path (§34.30 shipped record). Capacities documents nothing equivalent on this page.
- **Saved grouping exists as collection nodes** — `collection.member.add/remove` ops + `collection_member` table; seeded `collection` class.

**Verified bugs (pending):**

| # | Bug | Evidence | Fix direction |
|---|---|---|---|
| B1 | **Query blocks have no creation gesture in the web UI** — the shipped feature is unreachable for users | Slash commands are text/quote/checkbox/hard_break/url only (`TriggerPopup.tsx:34-38`); grep-verified zero `type: "query"` constructors in `apps/web/src` outside tests — tokens enter only via API/CLI `contentAst` writes | `/query` slash command (pairs with §34.28 #9 slash breadth — headline stays §34.19 `:1133`) inserting a token + opening the builder popover; cheap, unblocks V1/V2 |
| B2 | **Docs drift on the web app** — violates the owner docs rule | `docs/usage.md:174` "deliberately read-mostly"; `:178` "asset/embed/query/whiteboard tokens render as labeled placeholders" (all false post-§34.22); the API table omits `POST /api/query`; zero user-facing docs for query blocks/views anywhere in `docs/` | Rewrite the usage.md web-app section + document query blocks (what the token is, the builder, list/table toggle, export); CLI command nesting stays §34.29 #3 |
| B3 | **Dead `query` seeds** — system class + property schema nothing binds | `seeds.ts:18` (`SYSTEM_CLASS_UUIDS.query`), `:120` (`_queryAst` property-schema UUID), `:215` (seeded); no v2 code connects either to the query token — §34.28 #2 analog (reserved UUIDs without authors) | Wire: auto-assign the `query` class to query tokens → a "Queries" hub (also gives V1/V2 their natural host), or prune the seeds. Owner call, LOW cost either way |

**Missing features (pending)** — derived-state/client chrome unless marked; zero op-log/protocol work except V3's schema-doc note:

| # | Item | Evidence | Approach |
|---|---|---|---|
| V1 | **Saved views per section — ViewTabs** (dnd order, rename/dup/default/delete, per-section saved filters/sorts/mode) | No view/saved-search entity anywhere (21 derived tables, none for views); no protocol op; headline stays §34.19 `:1160` | Host = query tokens + formalized view record (V3); ViewTabs = chrome listing a section's query tokens. Everything syncs through the existing content mechanism — no new op |
| V2 | **"Save as view" flow + FilterBuilderModal + editor-relative placeholders** | Builder popover only (flat AND, first aggregation dimension/measure, no sort UI — §34.30 M9 carries the depth gap); no save flow exists; `{today}`-style placeholders unbuilt (`currentNodeId` compile option reserved, no caller) | FilterBuilderModal = full AST editor (pairs with M9); save = write a query token (+ ViewTab). Wire `currentNodeId` (C4) for "this page"-relative saved views |
| V3 | **Formalize the token `view` record** — prerequisite for V1/V2/V6 | `view: z.record(z.unknown()).optional()` (`content-mark.ts:137`) — loose where the AST is strict; only `{mode}` ever written | Versioned schema (mode, columns, sort, groupBy, pageSize) inside the already-optional record — additive, no client lockstep; **SCHEMA.md update required when implemented** |
| V4 | **NodeCollectionView — ad-hoc queries + a queries surface** | No temporary-query surface exists; headline stays §34.19 `:1163` | Shell surface running an AST through `NodeCollection` with V1 ViewTabs; reuses §34.30 M1's results panel work; B3's Queries hub is the persistent-home variant |
| V5 | **Object/link views per class** — Capacities' entire first category: inline vs block link, small/wide card, embed, per-class default | Unregistered until this audit. Notees links are typed marks with one rendering; no per-class link presentation. Title-is-content means cards derive from the content excerpt (domain display-name derivation already does this — no `name` to show) | Owner decision FIRST (below): where per-class link-view config lives. Then: block-link card renderers + a class setting. Distinct from §34.27 page layouts (page chrome, not link chrome) |
| V6 | **Gallery/wall modes + per-class small-card customization** | CardsView covers exist but are per-surface session state (§34.21 V12); no gallery/wall registry modes; Phase-8 "folder/gallery views" is the headline (`:757-758`) | Registry modes are mechanical once V3 config exists; card customization = V3 record + V5 per-class config |
| V7 | Calendar/gantt/chart/pivot/timeline view modes | — | **CROSS-REF ONLY** — §34.19 `:1168`, §34.21 future register, §34.28 #16 (calendar mode); not re-planned here |
| V8 | Graph view | — | **CROSS-REF ONLY** — §34.19 `:1167`, §34.21 future register (portability decision first), §34.29 #1 (dead "Graph View" landing option must not implement graph). Capacities datum: local per-object graph in the side panel matches Notees' peek/right-sidebar architecture |
| V9 | **Query-backed collections** (membership rules, not just explicit membership) | Collections are membership nodes with dedicated ops (`op-types.ts:307-320`); no rule-backed membership; Phase-8 "saved-query + explicit membership" is the headline (`:757-758`) | Recommend DERIVED membership (rule re-evaluated on read — derived state, no ops, honors the op-log law); owner confirms before build |
| V10 | Kanban card-order persistence | — | **CROSS-REF ONLY** — §34.21 future register (needs a designated order property) |
| V11 | Multi-value inline editing + bulk actions over table selection | — | **CROSS-REF ONLY** — §34.21 future register |
| V12 | Per-surface view-mode persistence | — | **CROSS-REF ONLY** — §34.21 decision 5 + future register; owner ruling needed (below) |
| V13 | **Per-class/per-surface default view type** — today defaults are hardcoded per hub (tasks→table, assets→cards, `App.tsx` hub wiring) | No config mechanism exists | Rides V1/V5: once view config is a formalized record, defaults become config rather than code |

**Exists but should change (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| C1 | **Builder read-back silently overwrites richer ASTs** — the data-loss facet of the builder gap | The popover reads back scope/class/text + the FIRST aggregation dimension/measure only; or-roots, nested groups, `Not`, extra dimensions load as defaults and a single Apply clobbers them (`QueryBlockView.tsx` builder; §34.30 M9 is the depth gap — this row is the hazard) | Even before M9: if the AST uses constructs the builder can't represent, render a read-only summary + "edit anyway" warning instead of editable defaults that overwrite |
| C2 | **Live re-run on every client notification + hard 200-row cap** | `client.subscribe(() => setVersion(v+1))` re-executes the query on ANY envelope while mounted (`QueryBlockView.tsx:419,424`); `QUERY_RESULT_CAP = 200` with "N more" text and no way past it (`:72,622`) | Coalesce re-runs by store version (skip when the last-run version is current); keep the cap as the RENDER window and add load-more pagination over the full result set |
| C3 | **DSL ↔ AST coverage gap** — the text language can't express the AST | DSL fields: class/type/text/linked/property only (`packages/query/src/dsl.ts`); AST also has `createdAfter`/`createdBefore`, multi-sort, aggregations, scopes — none reachable from text | Register the boundary in dsl.ts docs; date conditions first (cheap, pairs with §34.28). Distinct from §34.30 C1 (FTS MATCH syntax) |
| C4 | **`currentNodeId` compile option reserved but unused** | Option exists in the compiler; no caller passes it | Wire it for V2's editor-relative placeholders, or delete the option — don't carry dead surface |

**Decisions (needed from the owner before implementation):**

- **V12/V3 persistence ruling** — reversal of §34.21 decision 5 (session-only view modes)? Proposal: persist view config ONLY where it is already content (query tokens via V3), keep hub/section chrome session-only. Synced per-token config is local-first-lawful; per-surface chrome persistence would need the device-settings mechanism.
- **V5 link-view config home** — per-class binding (synced, all clients see it) vs device settings. Also the card design question under title-is-content (excerpt-based cards; no name field).
- **V9 membership semantics** — derived (re-evaluated on read, zero ops) vs materialized membership ops. Derived is recommended and consistent with the derived-state law.
- **V6 card-customization scope** — per-class config vs per-surface session state (follows the V12 ruling).

**Cost frame:** like §34.30, this is nearly all derived state + `apps/web` chrome — no op-log, no protocol, no GTK/Flutter lockstep. The one protocol-package touch is V3 (tightening inside an already-optional loose record — SCHEMA.md doc update owed when it lands, additive per the law).

**Sequencing:** UNBLOCKED as of 2026-10-02. Suggested order: **B1+B2** (discoverability + the docs rule, near-zero cost) → **V3** (formalized record — prerequisite) → **V1+V2** (ViewTabs + save-as-view on content tokens) + FilterBuilderModal (with §34.30 M9) → **B3** (wire or prune, with the V4 host decision) → **V4+V13** → **V5/V6** (the owner-decision gate) → **V9**. Cross-ref rows follow their home registers, not this one.

**Register cross-checks (no double-listing):** §34.19 `:1133` slash breadth 🟡 (B1 detail here) · `:1143` view-modes row (updated post-V12 above; V1/V7/V8 pointers) · `:1160` saved views ❌ (V1 detail here) · `:1161` query language 🟡 (V2 detail here) · `:1163` NodeCollectionView ❌ (V4 detail here) · `:1167` GraphView ❌ P2 + `:1168` gantt/calendar/chart/pivot ❌ (untouched — V7/V8 cross-ref only) · §34.21 decision 5 + future register (V10–V12 cross-ref; pointers added) · §34.28 #9 slash `date` (pairs with B1) + #16 query-result calendar (V7) · §34.29 #1 dead graph landing option (V8 must NOT implement graph) + #2 SearchBox orphaned (headline stays; §34.30 M1 sequence) + #3 stale CLI docs (B2 is the web-app side) · §34.30 M1/M9/M10 (V2/V4 ride them; pointers added both ways) · Phase 8 `:757-758` (V6/V9 headlines) · SCHEMA.md (V3 entry owed when implemented; nothing needed now).

### 34.32 Properties — Capacities comparison & gap-analysis register (2026-10-02, fully verified; implementation pending)

A fully-verified gap analysis of the **properties** feature area — property schemas, values, bindings/defaults, the properties panel, structured views over properties, and the capture-time schema gesture — benchmarked against [Capacities' Properties reference](https://docs.capacities.io/reference/properties) and [Object Properties](https://docs.capacities.io/reference/object-properties) (fetched 2026-10-02), plus a full internal audit of the property layer (store appliers, effective read model, edge projection, query compiler, web panel, CLI/server surfaces, seeds, export). Re-verified against the tree on 2026-10-02 **after** the Revision-11 conversion (zero `nodeType` references remain in `apps/web` — nothing below is migration-blocked). File:line evidence throughout; load-bearing negatives grep-confirmed (no `propertySchema.delete` call site in `apps/web`, no `active` column on `class_property`, no `extends`/`closure` reference in `effective.ts`, no `property_schema` read in the `property.set` applier path). Item numbers are stable and cross-referenced from the other registers; where an existing row already names an item, this section carries the detail and the row keeps the headline (cross-checks at the bottom). **All table rows below are PENDING; shipped items are the ✅ confirmations above the tables.**

**Shipped-state confirmations (✅ 2026-10-02)** — verified so nothing below re-plans it:

- **Effective-properties read model** — `authored ?? winning-binding defaultValue`, first-class-applied-wins (OR-Set add HLC ascending, ties by class id), defaults never materialized, rows tagged `source: "authored" | "default"` + `boundBy` (null = unbound-but-authored) — `packages/store/src/effective.ts:117-234`, store exposure `store.ts:337-339`; the panel renders defaults dimmed + the unbound hint (`apps/web/src/ui/components/MetadataSection.tsx:265-278, 1438-1441`).
- **Per-value metadata (qualifiers) round-trips end-to-end** — the applier persists it (`packages/store/src/appliers.ts:1150, 1161`), the effective read returns it (`effective.ts:206`), and the panel writes `startDate`/`endDate` for `dateQualified` bindings (`MetadataSection.tsx:337-350, 690-733`). The wire comment still says "owed work, column reserved" (`packages/protocol/src/op-types.ts:272`) — doc lag, → PC8.
- **Node-typed values + date refs are graph citizens** — they project into the edge index (`type='property'`, verb = schema id) with month/year ancestor fan-out for date refs (`packages/store/src/edges.ts:96-130`): "backlinks on a year node" is real, and it is what journals/calendar views ride.
- **Panel editors** for object (`NodeSelector` constrained by `targetClassFilter`, asset upload/download/annotation buttons), date (zoom-picker + NL parsing, `apps/web/src/ui/pickers/DatePickerPopup.tsx:128-150, 273-290`), `date_range`, select, boolean (`MetadataSection.tsx:1232-1378`).
- **Bindings editor (Class View)** — `apps/web/src/ui/ClassView.tsx:332-472` (sequence, flags, raw-text default, add/remove binding, date-schema patch).
- **Structured-view beachhead** — `TableView` (inline editing incl. property columns, per-column sort, any-schema column panel, `apps/web/src/ui/views/TableView.tsx:61-120, 442-458`), Kanban drag-to-column writes the select property (`KanbanView.tsx:76-85`); containers: classed-nodes + tasks hub.

**Verified bugs (pending):**

| # | Bug | Evidence | Fix direction |
|---|---|---|---|
| PB1 | **Broken-target property values resurrect edges.** Deleting a node removes `edge` rows touching its subtree, but other nodes' `property_value` rows referencing the deleted target survive — and the source's next `rebuildEdges` re-derives the edge (shape-based, no target-existence check), so backlinks to a nonexistent node reappear | `edges.ts:104-145`, `appliers.ts:544-549` | Owner rule first (below): keep-value + render-broken (the mention policy, SCHEMA.md:49) vs cascade-clear. Then make edge rebuild and the panel consistent with the rule — the current transient resurrection is the worst of both |
| PB2 | ~~**Text-carrier orphans + three coexisting value shapes.**~~ **✅ DONE 2026-10-03 (§34.45)** — the `property.set` applier enforces one-shape-per-type (text = string-or-`{nodeId}`, date/object = node ref, date_range = `{start,end}`; legacy bare uuids normalize; mismatch fails loud); `property.unset` of a node-backed text value trashes the carrier (trash + retention, exclusivity/parentage-guarded); `promotePropertyCarrier` composes unset + `object.restore` at the client level. Evidence trail below kept for history | `MetadataSection.tsx:236-238` (unlink = unset only), `:1063-1071` | Implement unset-deletes-carrier (trash + retention) + the "promote to block" reparent gesture (both specced, SCHEMA.md:134); normalize the value shape at the write path (rides PG6 validation); one-shape-per-type invariant |
| PB3 | ~~**Body-exclusion rule (projection rule 2) has a depth bug**~~ **✅ DONE 2026-10-03 (§34.45)** — `getBlockTree` computes the carrier set per subtree root; an excluded carrier's subtree is pruned with it | `apps/web/src/core/workspace-client.ts:1000-1034` | Compute the exclusion set per subtree root (per rendered node), not once per page |
| PB4 | ~~**Multi-value idx gaps never heal**~~ **✅ DONE 2026-10-03 (§34.45, documented gap-tolerance)** — `property.unset` deletes the row but never reindexes; the panel appends at `max(existing idx)+1`, so gaps persist permanently and qualifiers stay keyed to stale positions | `appliers.ts:1177-1210`, `MetadataSection.tsx:221` | Real fix = PG5 (element identity). Until then: documented gap-tolerance in readers (already true — reads don't assume density) — now a normative SCHEMA.md statement ("Node-backed text properties") |

**Missing features (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| PG1 | **Schema-at-capture / create-and-bind** (the M2 make-or-break gesture; SCHEMA.md:23 headline, §34.10 `:1010`) | The only creation surface is `AddPropertyRow` — hardcoded `type: "text"`, binds to no class, initializes an authored value (`MetadataSection.tsx:1041-1109`); typed-link verbs are free-string only — bound-schema verbs render but can't be authored (`apps/web/src/ui/VerbPopover.tsx:2-18`) | Tana-grade flow: type choice + class binding at creation, verb-schema create-and-bind at capture, PropertyCreateModal (§34.19 `:1151`). Design-heavy; schedule as its own pass after the correctness batch |
| PG2 | **Property-schema CRUD surface** | No delete UI — zero `propertySchema.delete` call sites in `apps/web`; no creation UI for `type`/`multi`/`scope`/`targetClassFilter`; both immutable post-creation in wire and UI (`op-types.ts:250-260`) | PropertyCreateModal + settings additions; decide type immutability (PG3) before building the type grid |
| PG3 | **No property-type conversion** (Capacities: change-with-conversion, original kept for review) | Delete+recreate reactivates the same UUID via upsert (`appliers.ts:1047-1051, 1097-1105`) while wrong-shape authored values survive | Owner decision (below): conversion machinery vs blessed delete+recreate with orphan cleanup |
| PG4 | ~~**`extends`-aware binding resolution**~~ **✅ DONE 2026-10-03 (§34.45)** — the diamond rule (own → shortest extends-path → earliest class-assignment HLC, SCHEMA.md:17) is implemented read-time in `effective.ts` via a shortest-path walk over `class_extends`; subclasses inherit ancestors' bindings + metadata (`boundBy` = the ancestor row) | `effective.ts:142-145` (no `extends`/`closure` reference in the file); architecture.md §11 item 1 carries the headline | Walk `class_hierarchy` (the closure table already exists) at read time with the designed ordering; pure read-model work — unblocks the citations promise that runtime `source` subclasses inherit `authors`/`attachments` (SCHEMA.md:141) |
| PG5 | **Multi-value element identity + OR-Set** (the "m2m tombstones" owed item, SCHEMA.md:9) | Positional idx slots, LWW per (node, schema, idx), per-slot tombstones only (`appliers.ts:1114-1210`); no per-element UUID; reorder costs N slot writes; qualifier attachment rides position | Per-element value UUID + OR-Set add-wins remove (the class/tag-membership pattern, `appliers.ts:280-301`). **Wire-affecting → canonical fixtures + three-client lockstep per law**; schedule with PC4/PC6 in one protocol batch |
| PG6 | **The write path is schema-blind** — the `property.set` applier never reads `property_schema`: no type/shape check, no `multi` cardinality, no `scope`, no `targetClassFilter`, no `datePrecision`, no target-existence | `appliers.ts:1114-1175`; server passes through (`apps/server/src/routes-objects.ts:411-433`); `targetClassFilter` is picker-side only (`MetadataSection.tsx:140-153`) | Apply-time fail-loud validation in the store (integrity, not a design-law conflict — type validation is not a usage prediction). Fixtures for the reject cases; CLI/agent writes become safe |
| PG7 | **Server routes for config ops** — `propertySchema.update`/`delete` + `class.property.set/unset` are envelope-only | Only `POST /property-schemas` exists (`routes-objects.ts:507`); the CLI can't manage schemas/bindings; the shell has `setProperty` but no unset (`apps/cli/src/shell.ts:154-179`) | Add the routes (the create-route pattern exists); shell `unsetProperty` + schema helpers; CLI command group if the owner wants it |
| PG8 | **Query-compiler property holes** — `date_range` values are unmatchable (`json_extract(value,'$.nodeId')` is NULL for `{start,end}`, so no op matches a range); no predicates over `metadata` qualifiers; no "target is of class X" predicate; no contains-any/all for multi-values; no property-based sort | `packages/query/src/compiler.ts:492-606`, `packages/protocol/src/query-ast.ts:144` | Range overlap/containment arms using the deterministic id payload; class-of-target via an edge-table join; multi via `IN`/group-by-having; sort by extending `SortField`. Do after PG5 (semantics settle) |
| PG9 | **Query-result tables have no property columns** — fixed columns only; properties reachable solely as aggregation dims/measures; multi-value cells read-only everywhere | `apps/web/src/ui/QueryBlockView.tsx:72-76, 124-126, 678-702`; `TableView.tsx:330` | Rides §34.31 V1–V3: once the token `view` record is formalized, query tables get the same column panel as TableView |
| PG10 | **Aliases — an unresolved register contradiction.** The v2 post-mortem deemed `node_alias` obsolete (`02-model-assessment.md:52-54`); the v1-parity register still lists "Aliases (pages) 🟡 missing" (§34.19 `:1135`); unlinked references are exact-title FTS only | `apps/web/src/core/workspace-client.ts:1276-1288` (display-name FTS minus backlink sources) | Owner decision (below): seeded multi-value `alias` text schema + alias-aware unlinked-mentions FTS (design-law compatible), or amend `:1135` to drop aliases |
| PG11 | **Template instantiation** — `has-template` placement + clone machinery | `00-INDEX.md:44` (owner not explicit); the template class is seeded, no machinery | §34.25 owns templates — this row is the property-side dependency (template node + instantiation writes property values per binding). Cross-ref only, not re-planned |
| PG12 | **PropertyView + PropertyReferencesSection** | §34.19 `:1153-1154` ❌ | Dedicated property page (schema config + population query over `GET /properties/:id/values`, `routes-objects.ts:756-776`) and a references section above linked refs |
| PG13 | **Version-history / restore surface** — the log contains full property history; nothing exposes it; `bumpRestoreEpoch` has no operator route | SCHEMA.md:19 | Cheap: `notees object history` + per-property value history from the op log; restore = counter-op. Owner decision whether the panel gets it too |
| PG14 | **Zombie types + seed drift.** `image`: in the wire enum, no value shape/editor/renderer — scalar-input fallback; page banner/cover rides it (§34.19 `:1156`). `multi_select`: no dispatch anywhere (only a header comment, `apps/web/src/ui/pickers/SelectionPropertyControl.tsx:3`). `url`/`email`: no link/`mailto:` rendering. Dead seeds: `tags`, `showHierarchy`, `usedIn`, `banner`, `_queryAst`, `description`, `_whiteboardData`, `taskClosedDate`, `taskRecurrence` (only the v1 migrator references them); 5 admonition classes UUID'd+iconed but unseeded; `SystemPropertySpec.type` (`packages/domain/src/seeds.ts:150-157`) lacks `date_range`/`multi_select`/`image` that the wire enum has (`op-types.ts:223-235`); 24 UUID keys vs 13 live specs (`seeds.ts:114-188`) | grep-verified | Prune or wire each zombie explicitly (owner call per seed — the UUID manifest must not outrun the spec manifest); build the `image` renderer with §34.27 D2's banner slot; route `multi_select` to the selection control; `mailto:`/`tel:` rendering with the url/email renderers |
| PG15 | **Export polish** — `date_range` and multi-select values render as raw JSON in Markdown frontmatter; CSL `publicationDate` exports year-only; `container-title`/`volume`/`issue`/`page` are import-only | `packages/export/src/markdown.ts:109-128`, `csl.ts:220-225, 241-247` | Frontmatter branches per type (ranges as `start`/`end`, selects as labels); CSL field-mapping completion |
| PG16 | **Select option colors** — options are `{id, label}` only; kanban columns/table chips/cards scan worse than the tag/class `effectiveColor` precedent | `op-types.ts:238` | Optional `color` on options; render through the token palette |
| PG17 | **Qualifier control inconsistency** — the start/end qualifier UI uses native date inputs instead of the zoom picker used everywhere else | `MetadataSection.tsx:709-731` vs `DatePickerPopup.tsx:273-290` | Reuse the picker per end (pairs with §34.28 #21) |

**Exists but should change (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| PC1 | ~~**`readonly`/`required` contract undefined beyond chrome**~~ **✅ DONE 2026-10-03 (§34.45, SCHEMA.md statement)** — `readonly` only disables the boolean editor; every other editor ignores it; `required` does nothing (no lint, no indicator) | `MetadataSection.tsx:866-874` | Define the render-level convention (readonly dims editors; required = empty-state highlight + lint suggestion — enforcement is client-honor by design law) and apply it uniformly; SCHEMA.md statement owed |
| PC2 | ~~**`defaultValue` is untyped and unvalidated**~~ **✅ DONE 2026-10-03 (§34.45)** — `z.unknown()` on the wire, raw-text editor, malformed defaults derive silently; node-typed defaults are arguably meaningless | `op-types.ts:202`, `ClassView.tsx:363-378` | Type the default per schema type in the editor; validate at read in `effective.ts` (a wrong-typed default yields no default) |
| PC3 | **`scope: global\|class\|object` is on the wire + DDL but defined nowhere** — no design doc states what it does, and the owed PropertyCreateModal plans a user choice for it | `op-types.ts:237`, `packages/store/src/schema.ts:171`; §34.19 `:1151` | Owner call: write the semantics (who may bind what) or cut the field — the binding mechanism already expresses "class-scoped" naturally |
| PC4 | **`class_property.active` specced, never built** — SCHEMA.md:122 lists it in the binding row; the wire payload and the table lack it (soft-delete exists only on `property_schema`) | `op-types.ts:194-204`, `schema.ts:193-205` | Reconcile: amend SCHEMA.md to drop it, or add it to wire+applier (soft-unbind without losing the row). If added → lockstep batch with PG5 |
| PC5 | **`propertySchema.update` converges by relay apply-order, not per-field HLC** — the recorded follow-up decision | SCHEMA.md:19 | Decide before a second writer exists; per-field LWW slots matching `class.property.set`'s patch semantics |
| PC6 | **Date qualifiers are ISO strings in a dates-are-nodes world** — they can't join the year/month/day chain, can't use the date query arms, and have no precision model; SCHEMA.md:155 itself flags node-backed qualifiers as the M2 evolution | `MetadataSection.tsx:337-350`; SCHEMA.md:155 | Schedule the move to date-node refs **before qualifier data accrues** (migration cost grows); wire-affecting (value `metadata` shape) → lockstep batch with PG5/PC4 |
| PC7 | **Boolean empty-vs-false semantics unpinned** — whether `exists` treats `false` as a value is unspecified; Capacities' rule ("unchecked counts as a value, empty filters don't treat it as empty") is the sane default | `compiler.ts:492-606` (property ops over `json_extract`) | Pin in the QueryAST docs + compiler: `false` is a value; only absent is empty. Fixture it |
| PC8 | **Doc-lag batch (docs-are-part-of-the-change arrears)** — `op-types.ts:272` still calls per-value metadata "owed work, column reserved" though it ships; SCHEMA.md:9 is unchecked though metadata round-trips; SCHEMA.md:37 unchecked though seeds exist; `docs/ux.md` still describes the Rev-10 `node_type` view cascade (Rev 11 landed 2026-10-02; AGENTS.md updated, ux.md not) | grep-verified | One docs pass: tick SCHEMA.md:9 (metadata part; element identity stays open under PG5), tick :37 with the PG14 caveats, fix the wire comment, rewrite the ux.md view-cascade paragraph |

**Decisions (needed from the owner before implementation):**

- **PG10 aliases** — adopt (seeded `alias` schema + alias-aware unlinked references) or amend §34.19 `:1135` to drop. The registers currently contradict each other.
- **PG3 type conversion** — build conversion machinery (Capacities-style, keep-original-for-review) or bless delete+recreate and define value-orphan cleanup.
- **PG5/PC4/PC6 protocol batch** — one lockstep batch (element-identity multi-values, binding `active`, node-backed qualifiers) with fixtures first, per the new-op law. Approve the batch before scheduling.
- **PG6 validation posture** — confirm apply-time fail-loud validation (recommended; integrity, not prohibition).
- **PB1 broken-target rule** — keep-value + render-broken (the mention policy) vs cascade-clear. Keep-value matches SCHEMA.md:49 and the identity law.
- **PC3 scope** — define or cut.
- **PG16 option colors** — cosmetic; adopt or defer.
- **Computed/formula properties** (SCHEMA.md:24) — the standing deferred decision is unchanged by this audit; query-time aggregations already ship (`compiler.ts:222-304`).

**Cost frame:** PB1–PB4 + PG4 + PC1/PC2 + PG6 are store/web correctness — no wire change, unblocked now. PG5/PC4/PC6 are wire-affecting → canonical fixtures + GTK/Flutter lockstep. PG7 is server/CLI routes. PG1/PG2/PG9 are web chrome — PG1 is the design-heavy one (the Tana gesture) and should be its own pass. PG14 is mostly deletions + seed tidying.

**Sequencing (suggested):**
1. **Store correctness batch** (no protocol change, unblocked): PB1–PB4, PG4, PG6, PC1, PC2 + the SCHEMA.md tick-ups in PC8.
2. **Protocol batch** (owner decisions + fixtures + three-client lockstep): PG5, PC4, PC6.
3. **Surface batch**: PG7 (routes/CLI) → PG2 + PG1 (schema CRUD then create-and-bind) → PG9 (rides §34.31 V1–V3).
4. **Hygiene batch**: PG14, PG15, PG16, PG17, rest of PC8.

**Register cross-checks (no double-listing):** §34.19 `:1135` aliases 🟡 (PG10 detail) · `:1146` TasksPopup task columns (the task-family bug stays §34.28 #2; PG14 carries the seed-drift evidence) · `:1151` Property controls 🟡 (PG2/PG14 detail) · `:1152` ClassPropertiesEditor 🟡 (PC1/PC2 detail) · `:1153`/`:1154` PropertyView/PropertyReferencesSection ❌ (PG12) · `:1156` banner/cover ❌ (PG14 image zombie) · §34.28 #2 (task schemas — headline stays), #19 (BibTeX date string — headline stays), #21 (range editing pairs with PG17) · §34.31 V1–V3 (PG9 rides; V3 is the prerequisite), B1 (/query slash — pairs with PG1's capture pass) · §34.21 future register (multi-value cell editing = PG9; calendar/gantt = cross-ref only) · §34.25 templates (PG11 dependency) · §34.10 `:1010`/`:1016` (PG1 headline) · SCHEMA.md `:9`/`:17`/`:19`/`:23`/`:24`/`:25`/`:26`/`:122`/`:155` · architecture.md §11 items 1 (PG4 headline) and 2 (`refset` — untouched by this audit).

**Deploy addendum (2026-10-02, evening).** `verify-min.mjs` → **VERIFY-PASS** on the migrated stack: API search hit renders with the new shape (`isClass:false, presentAsMain:true`), boot+settle 10.5 s via a fresh profile, footer "Sync: idle", UI search hit, zero console errors. Two operational findings from the cutover: (1) with snapshots absent, the server-side full replay of ~166k envelopes took ~35 min at ~70 envelopes/s with the event loop blocked (HTTP unresponsive — healthz timed out until the cursor reached the tail); a fresh snapshot was seeded manually from the rebuilt derived store (SQLite online backup → `snapshot` row + blob, up_to_seq 166,546) and clients now snapshot-restore in seconds. (2) The server does not snapshot autonomously — snapshot creation is client-driven (`maybeUploadSnapshot`); both findings registered in SCHEMA.md owed work (replay batching/event-loop yield; snapshot-after-rebuild autonomy). Smoke evidence: the run renders the owner's real journal/tasks/classes on the new model.

### 34.33 Public developer API — Capacities API 2.0 comparison & gap-analysis register (2026-10-02, fully verified; implementation pending)

A fully-verified viability assessment of the **public developer API** program, benchmarked against [Capacities API 2.0](https://developers.capacities.io/api/overview) ([launch release 67](https://capacities.io/whats-new/release-67), 2026-07-08; the [API Beta](https://docs.capacities.io/developer/api) was discontinued 2026-09-01) with Notion, Anytype, SiYuan, and the no-first-party-API trio (Obsidian/Logseq/Heptabase) as secondary references (all fetched 2026-10-02), plus a full internal audit of the machine surface (`apps/server` routes/auth, `apps/cli`, `packages/*` publish metadata) and of the plans that govern it (§16, §19, §26, §29, §34.3, §34.6, §34.16.2, `.plans/dev/sdk-publishing.md`). Benchmark shape: Capacities — per-space bearer tokens with `api:read`/`api:write` scopes, `X-Capacities-Api-Version` header, per-endpoint rate limits with a `RateLimit` header, documented LWW concurrency + `cap_*` error codes, an official TS SDK (`@capacities/api`), an interactive OpenAPI reference doubling as a playground, and an in-app developer-settings surface exposing stable IDs. Notion — same shape (version header, OAuth/integration tokens, granular capability grants, published OpenAPI, official SDKs). Anytype — local middleware API (gRPC, plus a JSON API added in app settings) with community MCP servers on top. SiYuan — open-source self-host with a full kernel HTTP API, but 2026 auth CVEs ([CVE-2026-73056](https://cvefeed.io/vuln/detail/CVE-2026-73056) API-token brute-force, [CVE-2026-32767](https://www.endorlabs.com/vulnerability/cve-2026-32767) search-API auth bypass → arbitrary SQL) — the cautionary tale for exactly Notees' deployment shape. Obsidian/Logseq/Heptabase — in-process plugin APIs only, no first-party public REST. Market direction: PKM APIs are becoming **agent surfaces** (Capacities 2.0's launch framing, Anytype MCP) — Notees' stated agent-first positioning is aligned with where the field is moving. File:line evidence throughout; load-bearing negatives grep-confirmed (zero OpenAPI/swagger files in the repo, no scope field on API keys, no idempotency/conflict handling on routes, `.audits/` contains only a stub README). Item numbers are stable and cross-referenced from the other registers. **The 2026-10-03 stability + agent-safety batch shipped every row annotated ✅ below (see the work record at §34.33.1); rows without the annotation stay pending.** Nothing in this register is wire-affecting.

**Shipped-state confirmations (✅ 2026-10-02)** — verified so nothing below re-plans it:

- **The machine surface is real and coherent (M1).** HTTP Object API under `/api` (Fastify 5; `src/app.ts:114-151`): object CRUD + per-node properties + backlinks + effective-properties + search + property-schemas + classes + `/properties/:id/values` (`src/routes-objects.ts:231-776`), CAS assets (`src/assets.ts:100,183,213`), auth/account routes incl. API-key management (`src/routes-auth.ts:160-493`). User-facing quick reference: `docs/usage.md:181-212`.
- **`POST /query` — arbitrary QueryAST execution** (`routes-objects.ts:645-700`). Capacities, Notion, and Anytype expose fixed endpoints only; a compiled query language over the API is a genuine differentiator.
- **One-write-path invariant** — every API write is an envelope through the same pipeline as relay `/batch` (`routes-objects.ts:2-6`): the machine API is a first-class op producer, not a thin layer over a separate internal path (the Capacities/Notion shape). Convergence comes free for every integration.
- **Parameterized AST→SQL** (`packages/query` compiler) — `POST /query` cannot become SiYuan's CVE-2026-32767 by construction; the audit entry is still owed (AG11).
- **Relay API** `/api/relay/v2` (batch/catch-up/snapshot/compact/stats/WS) per WIRE.md §1–2; versioning culture WIRE.md §3 (additive-doesn't-bump, fail-loud on newer) — the policy AG8 should extend to the HTTP surface.
- **Auth** — operator API key (`nk_`+32, unrestricted machine path) + per-user API keys (`nk_`+40, sha256 at rest, name-only) + sessions `nt_`; the machine API accepts any authenticated principal (`src/app.ts:138-143`, `src/auth.ts:154-167,201`).
- **CLI agent contract** — `--json`, exit codes 0–5, `--yes`, profiles, `shell` REPL, markdown/bibtex round-trips over `X-API-Key` (`apps/cli/src/cli.ts:5-12`, `client.ts:1-5`).
- **Six publish-ready packages** — `@notees/protocol|domain|store|sync|query|export` v`0.1.0-m1`, tsup `dist` exports, `files`, `publishConfig`, AGPL-3.0; `pnpm release` wired at root. Unpublished (AG1).
- **Revision 11 / envelope v3 SHIPPED** (§34.23 M1–M10 ✅ + the deploy addendum above: VERIFY-PASS on the migrated stack; AGENTS.md lockstep row GTK `v2.0.0-m3` / Flutter `v2.0.0-m11`). The API shape (`isClass`/`presentAsMain`) is stable on the deployed stack — the "surface mid-mutation" caveat from the original assessment is closed.
- **Doc fixes done in this pass (2026-10-02)** — §34.23 M5b checkbox ticked (the migration ran at deploy per the addendum above); `architecture.md` object-API paragraph rewritten (prefix `/api` + full endpoint list; was stale `/api/v1` since commit `f1888e0a` and missing `POST /query`, properties, effective-properties, api-keys).

**Verified bugs (pending):**

| # | Bug | Evidence | Fix direction |
|---|---|---|---|
| AB1 | ~~README:19 claims "scoped API keys"~~ **✅ shipped 2026-10-03 (AG3 server side)** — README:19 now reads "Scoped API keys (server-enforced read/write scopes today; in-app checkboxes §34.19)" | `README.md:19` vs `apps/server/src/auth.ts:154-167` (no scope field) | Server scopes landed (AG3 below); the in-app checkbox UI stays owed at §34.19 `:1175` |
| AB2 | ~~§16 endpoint sketch is `/api/v1`-prefixed~~ **✅ reconciled 2026-10-03** — §16 now carries a reconciliation note: the sketch's `/api/v1` labels are design-time names; the deployed surface is deliberately unversioned `/api/*` (AG8 path versioning remains owner-gated) | §16 `:467-506` vs `src/app.ts:114-151` | Closed by note; full versioning policy still rides the AG8 owner decision |
| AB3 | **`POST /api/objects` taken-id 409 is unreachable — the actual duplicate-id behavior is a 201 no-op (first write wins)** — the route throws 409 only when `outcome.savedIds` is empty, but the server stamps a fresh envelope id per POST (`envelope-factory.ts`), so the relay always saves; `applyObjectCreate`'s `alreadyExists` branch then leaves the tree untouched and the route answers 201 with the ORIGINAL object | Found 2026-10-03 while pinning create semantics (`test/developer-api.test.ts`, "keeps create idempotent on a taken id"); the route/schema comments claim "a taken id fails loud with 409" | Owner call: (a) accept the idempotent no-op as the contract (update the route comment — test already pins it), or (b) make taken-id 409 real (pre-submit existence check; safe for known clients — CLI never re-POSTs a taken id). The v1-parity intent ("A taken id fails loud") suggests (b), but it is a wire-visible change and was left out of the additive-only batch |

**Missing features (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| AG1 | **Published SDK** — the distribution unblock; repo split and Python SDK sit behind it | Publish metadata ready on all six packages; blocked on an npmjs token (GitHub Packages rejects `@notees/*`); fallback rename documented | Owner obtains npmjs token (or approves the `@miquelrosell99/notees-*` rename) → `pnpm release`; flow in `.plans/dev/sdk-publishing.md:54-75` |
| AG2 | **`packages/api-client`** — typed client for the object API (CLI, web, future plugins) | Planned §34.3 `:884`; only the CLI's private `ApiClient` exists (`apps/cli/src/client.ts:1-5`) | Extract from the CLI client; publish with AG1 |
| AG3 | ~~Scoped API keys + enforcement~~ **✅ shipped server side 2026-10-03** — optional `scopes` on key records (additive `api_key.scopes` column, NULL = unrestricted), `POST /api-keys` accepts the list, per-route enforcement from the OpenAPI table (`x-required-scope` = middleware source of truth), scoped keys rejected on the relay surface with 403 `scope_denied`; §26 granular names, Capacities-coarse alternative not taken (owner granularity decision absorbed by shipping the recommended set) | Keys are name-only (`auth.ts:154-167`); no per-route scope check; UI checkboxes owed (§34.19 `:1175`) | Server half done; the §34.19 `:1175` Read/Write/Admin checkbox UI remains web work |
| AG4 | ~~OpenAPI 3.1 contract + CI diff gate~~ **✅ shipped 2026-10-03** — `src/openapi.ts` builds the document from a route table (every route incl. relay, pinned `x-error-codes` taxonomy, `x-rate-limits`, `x-api-key-scopes`, `x-revision-checks`, `x-idempotency-key`); served at `GET /api/openapi.json`; CI job `openapi-coverage` runs the route-coverage + taxonomy tests (both-directions table↔app check — no checksum brittleness) | Zero openapi/swagger files in the repo; §16 pins "OpenAPI published as the contract"; §29 wants the diff gate | Shipped; the interactive-reference/playground precedent rides the same artifact later |
| AG5 | ~~Agent-safety endpoints~~ **✅ partial (the asked-for half) shipped 2026-10-03** — `Idempotency-Key` replay on mutating JSON routes (24h window, 409 `idempotency_replay` on key collision, multipart excluded by CAS), `baseRevision` 409 guard on `PATCH /objects/:id` only (the one natural per-node revision — documented honestly for the rest), `GET /api/meta`, `GET /api/operations` (paginated relay-log feed); **NOT built:** `POST /transactions` (registered below for a future slice) | Designed §16 `:503-516`; nothing implemented | Additive Fastify routes; relay already dedupes by envelope id — the API maps key→envelope id (§16 `:514`) |
| AG6 | **Webhooks / event stream** | §16 `:519`, §19, §34.6 M3; v2 post-mortem: "no events/webhooks for integrations" | M3 scope: event projections + `POST /webhook-endpoints`; schedule with AG7 |
| AG7 | **Plugin runtime** (capability broker, subprocess host, manifest v2) | §34.6 M3 exit criteria; §19: plugins are "API clients with an embedded token" on this same surface | M3 program — own plan when scheduled |
| AG8 | **HTTP API versioning/stability policy** — the strategic gap | §16 `:517` promises frozen additive-only + `/api/v2` alongside; reality: unversioned `/api/*` + the no-backward-compatibility owner directive (§34.23) — irreconcilable with external consumers | Owner decision (below). Recommend a Capacities/Notion-style version header on `/api/*` + the WIRE.md §3 culture (additive-doesn't-bump, fail-loud) — no path versioning. **Must land before AG1 publishes: publishing freezes the surface** |
| AG9 | **Python SDK** — thin dict-level client over the public HTTP API | §34.16.2 registered option; in-process bridge explicitly rejected there | After AG1 + AG4 (the OpenAPI spec can generate the client skeleton) |
| AG10 | ~~Per-endpoint-class rate limits, documented~~ **✅ documented 2026-10-03** — the three real limiters (global 10k req/min/IP, relay batch 30k envelopes/min/workspace, login 10/min/IP + lockout) pinned in the OpenAPI `x-rate-limits` extension; per-endpoint-class tightening stays registered | Per-key buckets designed (§16 `:518`); the app ships a global 10k req/min per-IP fallback (`src/app.ts:3`) | Document + tighten per route class when AG4 lands — documentation half done; tightening still registered |
| AG11 | **API-surface security audit** — auth paths, `/query` compiler, key handling | `.audits/` is a stub README; SiYuan's 2026 CVEs show self-hosted single-user kernels get attacked anyway | Targeted audit before any consumer beyond owner/agents; the parameterized-query posture is already ✅ above |
| AG12 | **`GET /objects/:id/children`** — child-position ordering endpoint | SCHEMA.md `:18` owed work (SCHEMA owns the semantics; cross-ref only) | Additive route when the ordering work is scheduled |

**Exists but should change (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| AC1 | ~~Developer-docs home~~ **✅ closed 2026-10-03** — decision recorded: the OpenAPI artifact at `/api/openapi.json` IS the developer surface (per AG4), `docs/usage.md`'s quick reference carries the human quick-ref (extended with the agent-safety notes); no separate developer page — `docs/` stays user-facing-only per AGENTS.md | `docs/usage.md:181-212` is user usage, not developer reference | Closed by decision; revisit only if external consumers ask for narrative docs beyond the spec |
| AC2 | ~~Error-code stability pass~~ **✅ pinned 2026-10-03** — `ERROR_TAXONOMY` in `src/errors.ts` (code → status (+documented aliases 400/416 for `validation_failed`) → description) is the pin; `test/error-taxonomy.test.ts` fails on drift between union ↔ taxonomy ↔ emissions scanned from `src/` ↔ the OpenAPI `x-error-codes`; the §16 designed set is complete — `scope_denied` (AG3) and `idempotency_replay` (AG5) added and exercised | §16 `:512`; no inventory of what routes actually emit | Inventory + pin with AG4 — done; the missing codes landed with AG3/AG5 |
| AC3 | ~~In-app developer affordances~~ **✅ closed 2026-10-03** — confirmed, nothing to build: identity is UUIDv7 everywhere by design law (the Capacities stable-ID badge pattern is subsumed), and the new self-description endpoints (`/api/meta`, `/api/openapi.json`) give agents the machine surface without UI | Capacities exposes space/structure/property IDs in-app; Notees already surfaces UUIDv7 everywhere by identity law | Closed — confirmed no build |

**Decisions (needed from the owner before implementation):**

- **AG8 versioning policy** — version header (recommended; matches WIRE.md §3 and the Capacities/Notion precedent) vs §16 path versioning vs status-quo no-backcompat (compatible only with "no external consumers ever"). Gates AG1.
- **Scope granularity** — ✅ absorbed 2026-10-03: AG3 shipped the recommended §26 granular set (`objects.read`/`objects.write`/`objects.delete`/`relations.read`/`relations.write`/`assets.read`/`assets.write`/`annotations`/`citations`/`collections.write`/`search`/`export`/`admin`); the names without endpoints today are reserved vocabulary (documented in the OpenAPI `x-api-key-scopes`), the §34.19 `:1175` UI checkboxes were already spec'd on it. Capacities-coarse (`api:read`/`api:write`) not taken.
- **npm scope** — wait for an npmjs token vs approve the `@miquelrosell99/notees-*` rename (`.plans/dev/sdk-publishing.md:54-63`).
- **M3 confirmation** — webhooks (AG6) + plugin runtime (AG7) still M3, behind the SDK publish?
- **Python SDK (AG9)** — schedule now or keep registered?
- **AG11 audit scope** — full external-style audit vs targeted pass (auth + `/query` + key handling); recommend targeted for a single-user self-host.

**Cost frame:** AG4/AG5/AG10/AG12 + AB2 are additive Fastify work and docs — unblocked now. AG3 is server + web auth work. AG8 is a policy decision plus thin middleware. AG1 is a token plus `pnpm release`; AG2 rides it; AG9 rides AG1+AG4. AG6/AG7 are the M3 program (own plan). **No fixtures and no three-client lockstep are required anywhere in this register** — the cheapest register in the §34.28–§34.35 series to execute; the only true blocker is the AG8 policy decision (and the npm token for the distribution batch).

**Sequencing (suggested):**
1. **Owner decisions** (AG8, scopes, npm scope, M3 confirmation, AG9, AG11 scope).
2. **Stability batch** (unblocked, additive): AG8 middleware + policy note, AG4 OpenAPI skeleton + `/api/openapi.json`, `GET /api/meta`, AC2 error-code pin, AB2 §16 reconciliation, AB1 README wording, AC1/AC3 closure.
3. **Agent-safety batch**: AG5 (idempotency/conflict/transactions/operations), AG3 (scopes + enforcement + §34.19 `:1175` UI), AG10, AG12.
4. **Distribution batch**: npm token (or rename) → AG1 release → AG2 `api-client` extraction → repo split unparked → AG9 Python SDK.
5. **M3 program** (own planning when scheduled): AG6 + AG7.
6. **AG11** audit before any consumer beyond owner/agents.

**Register cross-checks (no double-listing):** §34.19 `:1175` (scopes headline stays; AG3 carries detail — the §34.19 row now notes the server half shipped) · §16 (target design; AG4/AG5/AB2 detail here) · §26 (scope names) · §19 (plugins = API clients with embedded token — AG7 rides) · §34.6 (M3 exit criteria) · §34.3 `:884-885` (api-client/plugin-sdk packages) · §34.16.2 (Python SDK) · §29 (OpenAPI diff gate — realized as route coverage, not checksums) · `.plans/dev/sdk-publishing.md` (AG1) · SCHEMA.md `:18` (AG12 cross-ref only) · §34.23 (Revision 11 shipped; M5b ticked in this pass) · `architecture.md` object-API paragraph (made current in the 2026-10-03 batch) · **work record: §34.33.1**.

### 34.33.1 Work record — stability + agent-safety batch (2026-10-03)

Shipped the unblocked additive half of the §34.33 register (owner-gated AG8 versioning policy and AG11 audit scope NOT touched — they stay pending owner decisions; AG12 was already shipped before this batch and remains out of scope here).

- **AG4 OpenAPI contract** — `apps/server/src/openapi.ts` builds the 3.1 document from a hand-maintained route table covering the full surface (56 operations: probes, meta, account, workspaces, objects, properties, search/query, classes, assets, relay incl. the WS endpoint flagged `x-webSocket`); cross-cutting facts as top-level extensions: `x-error-codes` (the AC2 taxonomy), `x-rate-limits` (AG10: 10k req/min/IP global, 30k envelopes/min/workspace relay batches, 10 logins/min/IP + 5-failures lockout — the "60 req/min agents limit" from the batch brief does not exist; these three are the real limiters), `x-api-key-scopes`, `x-revision-checks`, `x-idempotency-key`. Served at `GET /api/openapi.json` (`no-store`). CI job `openapi-coverage` (`.github/workflows/ci.yml`) runs `test/openapi-coverage.test.ts` + `test/error-taxonomy.test.ts` — a both-directions route-coverage check (registered ⊆ documented and documented ⊆ registered), chosen over a checksum for robustness.
- **`GET /api/meta`** — auth-free self-description (version, wire protocol 3, ws framing 2, default workspace id — a fixed system uuid, safe to expose, setupRequired). `apps/server/src/routes-meta.ts`.
- **AC2 error taxonomy** — `ERROR_TAXONOMY` in `errors.ts` pins code → status (+aliases 400/416 for `validation_failed`, both pre-existing emissions kept additive) → description; `scope_denied` and `idempotency_replay` added and behaviorally exercised; `test/error-taxonomy.test.ts` scans `src/` for `new AppError(n, "code")` / `errorBody(n, "code")` emissions and fails on any union ↔ taxonomy ↔ status ↔ OpenAPI drift.
- **AG5 agent safety** — `apps/server/src/idempotency.ts`: `Idempotency-Key` replay on the object/assets group (auth + scope checks run BEFORE the replay, so a replay needs the caller's credentials; 24h in-memory window; same-request replay returns the original status+body with `x-idempotency-replay: true`; key reuse with a different request → 409 `idempotency_replay`; 4xx never cached; multipart excluded — CAS dedupes bytes). `baseRevision` guard on `PATCH /objects/:id` only: the node row's `(hlc_physical, hlc_logical)` is the one natural per-node revision (bumped by object.update/move; property slots carry per-slot LWW, creates/deletes have no meaningful base — documented in `x-revision-checks` rather than faked). `GET /api/operations` — paginated relay-log read (cursor shape = catch-up; read membership + `objects.read` scope). NOT built: `POST /transactions` (registered for a future slice).
- **AG3 scoped API keys (server half)** — additive `api_key.scopes` column (NULL = unrestricted; pre-scopes rows migrate as-is); `POST /api-keys` accepts the validated list; enforcement per route from the OpenAPI table's `requiredScope` (one source of truth for doc + middleware — `buildRouteScopeMap`/`enforceRouteScope` in `scopes.ts`); scoped keys rejected on the whole relay surface (HTTP + WS preHandler) with 403 `scope_denied`; account routes unchanged (session-only; key self-revocation intact). The §34.19 `:1175` Read/Write/Admin checkbox UI stays owed web work.
- **AB1/AB2/AC1/AC3** — README:19 wording now matches reality; §16 carries the AB2 reconciliation note; AC1 closed by decision (the OpenAPI artifact IS the developer surface, `docs/usage.md` quick-ref extended); AC3 confirmed-nothing-to-build.
- **AB3 (new verified bug, owner call registered)** — the `POST /api/objects` taken-id 409 branch is unreachable: the server stamps a fresh envelope id per POST, the relay always saves, and `applyObjectCreate`'s alreadyExists branch answers 201 with the original object (first write wins; pinned by test). Fix direction (a) accept as contract or (b) make 409 real — deferred to the owner; see the AB3 row.
- **Docs same pass** — `docs/usage.md` quick reference (new endpoints, agent-safety paragraph, scoped-key paragraph, rate-limit pointer), `docs/usage.md` scope section, `.plans/dev/architecture.md` (route groups + middleware + version string), README:19.
- **Verification** — `pnpm vitest run` in `apps/server`: **141 tests green** (116 pre-existing + 25 new: 5 coverage, 4 taxonomy, 16 developer-api behavior); `pnpm typecheck` clean. No wire change (HTTP-layer only; op payloads untouched — `baseRevision` is stripped before the protocol schema), so no fixtures/lockstep per the register's cost frame. POST /transactions, the §34.19 `:1175` UI, and per-endpoint-class rate-limit tightening remain registered; AG8/AG11 remain owner-gated pending.

### 34.34 Blocks & rich content — Capacities comparison & gap-analysis register (2026-10-02, fully verified; implementation pending)

A fully-verified gap analysis of the **blocks** feature area — the content-token grammar, block chrome, collapse behavior, slash-command set, embed/transclusion, assets-as-content, and layout — benchmarked against [Capacities' Blocks reference](https://docs.capacities.io/reference/blocks) (fetched 2026-10-02), plus a full internal audit of the token layer, editor keyboard contract, dnd intent model, and whiteboard/query/embed renderers. Every claim passed a 20-point verification pass against the tree on 2026-10-02 **after** Revision 11 landed (file:line evidence throughout; load-bearing negatives grep-confirmed — no `language`/`mermaid` reference in `packages/` or `apps/web`, no ordered-list rendering, no editable content grid, no `asset_ref` renderer, zero consumers of the `capture` search surface). Two claims from the preliminary comparison discussion were **corrected by verification** and this register records the verified truth: classes ARE mentionable today (FTS-based, `NodeSelector.tsx:341-358` + class reindex appliers `appliers.ts:736-738,770`), and `asset_ref` does NOT render inline/full-bleed (placeholder box only). Item numbers are stable and cross-referenced from the other registers; where an existing row already names an item, this section carries the detail and the row keeps the headline (cross-checks at the bottom).

**Architectural frame (why the gap list looks the way it does):** Capacities blocks are a *property of an object* with an explicit block-type catalog (text-with-interfaces, highlight, code, math, table, two-column, group, horizontal rule, object block); Notees blocks are *nodes* — same table, same ops, UUIDv7 identity — with a flat 12-token grammar and "types" emerging from classes + tokens + views (`task` = seeded class on an ordinary block, `whiteboard`/`query` = tokens, table = a view mode). Every Capacities "block type" decomposes into (a) a content token, (b) a class, or (c) a view — which is why most rows below are cheap. The catalog of what that decomposition costs per feature is the register.

**Shipped-state confirmations (✅ 2026-10-02)** — verified so nothing below re-plans it:

- **Block-as-node identity** — "page" and "block" are render states (`is_class` + `present_as_main`, SCHEMA.md Revision 11); promotion/demotion is one in-place `object.update {presentAsMain}` op (`packages/store/src/appliers.ts:461-469`).
- **The 12-token grammar** — `text` (marks: bold/italic/strike/highlight/code, `content-mark.ts:23`), `mention`, `class_chip`, `typed_link`, `external_link`, `math` (4096 cap, `:94-99`), `hard_break`, `quote` (the only nested token), `asset_ref`, `embed_ref`, `query`, `whiteboard` — the discriminated union at `packages/protocol/src/content-mark.ts:177-190`; inline subset `:167-175`.
- **Per-block classes/tags/properties** — ClassPills column, Tags row, collapsible Properties section per block (`apps/web/src/ui/BlockRow.tsx:221-252`); node-backed text property carriers are real child blocks. Capacities blocks carry no typed data; Notees blocks are first-class property carriers.
- **Keyboard contract** — Enter splits (tail → new sibling, `beforeId` at start), Shift+Enter `hard_break`, Backspace-at-start merge, Tab/Shift+Tab indent via `object.move` (`apps/web/src/ui/BlockTextEditor.tsx:62-108`).
- **Live transclusion embeds** — `embed_ref` renders the real child subtree, never a clone; cycle guard `EMBED_MAX_DEPTH = 5` + visited set seeded with the page id (`apps/web/src/ui/EmbedView.tsx:1-15,28,42-48`).
- **Whiteboard = spatial view of a subtree** — per-card geometry (`x,y,w,h`) in the `whiteboard` token's `layout.cards` keyed by node id; shapes/strokes identity-free (`apps/web/src/ui/whiteboard-layout.ts:13-19,40-44`).
- **Query blocks** — live QueryAST embed with list/table/aggregate view modes (`QueryBlockView.tsx`); blocks are FTS-indexed (§34.30 shipped record); `mention` tokens store id-only and resolve at render.
- **Classes are mentionable today** — `@` renders `NodeSelector searchMode="all"` (`BlockTextEditor.tsx:1422-1437`) whose candidates come from unfiltered `client.search()` over the FTS index that class appliers maintain (`NodeSelector.tsx:341-358`, `appliers.ts:736-738,770`).

**Verified bugs (pending):**

| # | Bug | Evidence | Fix direction |
|---|---|---|---|
| BB1 | **`asset_ref` renders as a placeholder box — the SCHEMA.md:61 inline/full-bleed rule is unimplemented in the UI.** Assets store fine (CAS `asset.attach`, `node_asset` table, `assetRefTokenSchema` `content-mark.ts:105-110`) but the web renderer draws a `Placeholder` and no `renderAsset` callback exists anywhere (grep-verified; only a fallback resolver at `workspace-client.ts:900`) | `apps/web/src/ui/InlineTokens.tsx:218-219` | Build the asset renderer (inline + full-bleed variants per SCHEMA.md:61, ImageModal lightbox rides the primitive library); pairs with §34.32 PG14's `image` zombie work and B9 below |
| BB2 | **Dead `capture` search surface** — `capture.searchNodes` and its candidate-shaping code have zero consumers (grep-verified); §34.30 M7's fix-direction cites this dead code | `apps/web/src/core/outliner-context.ts:135-144,186-211` | Delete the dead module (or wire it deliberately); **fix §34.30 M7's citation** → live path is `NodeSelector.tsx:341-358` + `appliers.ts:736-738` |
| BB3 | **Stale comments misstating reality** — `NodeSelector.tsx:336-340` claims class appliers don't reindex (false: `appliers.ts:736-738,770`); `BlockTextEditor.tsx:27-28` header + `:1430` placeholder say "pages and blocks" (the live path mentions classes too) | grep-verified against current behavior | Rides the §34.32 PC8 doc-lag batch — behavior is correct, docs lie |

**Missing features (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| B1 | **Persisted toggle/collapse** | Collapse is session-local React state, never persisted, no op, no wire field (`outliner-context.ts:123-128,161-169`; consumed `BlockRow.tsx:146-160`; prose view ignores it `:61-66,85`). Capacities persists per block | Owner decision FIRST: (a) keep session-only — design-law-clean ("device state is never an op"), zero cost; (b) semantic flag — syncs everywhere, every collapse is an op; (c) presentation channel outside the log — first crack in "every SQLite is a projection of the log". Default proposal (a); (b)/(c) need an owner ruling + SCHEMA.md amendment |
| B2 | **List rendering styles** (numbered/alphabetical/roman) | Grep `roman\|numeral\|orderedList\|listStyle\|<ol` → only CSS `list-style: none` resets; the tree renders as an outliner with no style variants | Render concern + small per-block metadata (a `list` mark or flag on the text token); numbering computed across siblings at render. Zero protocol cost if kept render-side; pairs with §34.19 `:1130` fold-keyboard rows when B1 lands |
| B3 | **Block-level code** (language metadata, Mermaid, copy/download) | `code` is an inline mark only (`content-mark.ts:23`); no `language` field anywhere in `packages/` or `apps/web`; `mermaid` appears only in `.plans/design` | New `code_block` token (`{language, text}`) added to the union as a **promotion survivor** alongside `whiteboard`/`query` (`node.ts:108-111` — otherwise promotion stringifies a code block to plain text); editing surface composes the existing `CodeTextarea` primitive; Mermaid is an optional render dependency — owner ruling under the privacy-first law (bundle locally, no CDN) |
| B4 | **Free-form tables** | No editable content grid exists — the only `role="grid"` is the DatePicker calendar (`DatePicker.tsx:245`); tables are read-model views only (query-block table mode, `TableView`/`KanbanView` over class members; cell editing is property-level bool/select, never block content) | **Recommended: rows-as-blocks table view** — a view over a block's children where columns are the children's typed properties (ingredients all ship: per-block properties, fractional ordering, the §34.21 `NodeCollection` view machinery). Tables become queryable/classable/embeddable for free — Capacities grids are not. Free-form cell-grid token = the alternative, and the most invasive addition in this register (nested grid inside a flat token array) — owner picks |
| B5 | **Layout blocks: horizontal rule, group, columns** | No `hr`/divider/group/column token (`content-mark.ts:177-190`); grouping is only tree nesting | `hr` = trivial token. **Group** = a parent block rendered boxed via a render flag (the `present_as_main` bit pattern one level down) + Ctrl+G multi-select — needs §34.19 `:1128` block selection first. **Columns** = layout token on a parent + a column-intent extension of the dnd deep-zone model (`block-dnd.ts:56,92` is the precedent); whiteboard already proves layout-as-token works |
| B6 | **Highlight blocks / import pipeline** (Readwise/Kindle/web highlights) | No importer exists; no highlight class or source-attribution convention | **No new primitive needed** — a highlight is a `quote` token + a seeded `highlight` class + source properties (author/url/locators). The gap is the importer (server/CLI integration) and the metadata convention; rides the §34.19 `:1172` import-backend decision. Clearest demonstration that classes+properties subsume Capacities' block-type catalog |
| B7 | **KaTeX math rendering** | The `math` token stores formulae (`content-mark.ts:94-99`) but renders as a plain `<code>` — "Slice 1: no KaTeX" (`InlineTokens.tsx:207-215`) | Add the KaTeX render path in `InlineTokens` (bundle the fonts/css locally — same dependency ruling as B3). Distinct from §34.19 `:1132`'s owed toolbar math *mark* (authoring gesture — stays there) |
| B8 | **Intermediate reference views (cards)** | Two-point spectrum only: `mention` (inline, resolve-at-render) ↔ `embed_ref` (full live transclusion, `EmbedView.tsx`); no "small card" / "wide card" between them (Capacities: inline / small card / wide card / embed) | A `view` field on the `embed_ref` token + card renderers; low model cost, medium UI cost. Lockstep only if the token schema changes |
| B9 | **Media-object convention** (Capacities' "image object with a NOTES section") | Assets attach to any node (CAS, `asset.attach`), but there is no "asset page" class or creation flow — media has no coherent gallery/search home | Seed an asset-page class + asset-picker creation gesture; pairs with BB1 (renderer) and §34.32 PG14 (`image` type zombie). A media page = content `asset_ref` token + class + notes body — pure assembly, no new wire |

**Exists but should change (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| BC1 | **Collaborative-text carrier is a designed hole** | `object.update` accepts `contentDeltaB64` on the wire but the applier throws `UnsupportedCarrierError` until the Yjs port (`appliers.ts:438-444`) | Two online clients editing the same block resolve by whole-content LWW — the last writer wins the entire token array. The Yjs (`Y.Text` over serialized tokens) port is the designed fix and is the **largest correctness item in this register**. Tree ordering is likewise interim (fractional indexing; concurrent `object.move` converges by arrival, `move_move` intent loss flagged by `conflicts.ts`) |
| BC2 | **Block-level backlink gutter unimplemented** | Spec'd at SCHEMA.md:117 (right-gutter toggle over `node_stats.backlink_count`); no implementation in `BlockRow.tsx` (280-line read — no backlink element); `getBacklinkCount` plumbing exists with no block-row caller (`workspace-client.ts:1299-1302`); backlinks render only at page bottom (`PageView.tsx:397,433`) | Owed work, not a redesign: gutter toggle + lazy backlink section per block, riding the existing `edge` index and `backlinks()` |
| BC3 | **Query-result hard cap of 200** | `QUERY_RESULT_CAP = 200` (`QueryBlockView.tsx:72`), applied `:88`, "N more" line `:622-623` | Virtualize or paginate ("show more") instead of the hard cap; pairs with §34.30 C5's store/server cursor work |
| BC4 | **Promotion stringification can surprise** | Block→page promotion silently flattens rich inline tokens to one text run (`appliers.ts:461-469` → `stringifyContentAst` `node.ts:104-116`; survivors `:108-111`) — losing `typed_link`/`asset_ref` tokens is a data-shape change users won't predict | Cheap guard: UI confirmation naming what will flatten when promoting a block carrying rich tokens. Extending the survivor set is a deliberate-law change — owner ruling only if it bites in practice |
| BC5 | **Slash-command breadth: 5 vs v1's ~17** | `TriggerPopup.tsx:33-39` — text / quote / checkbox / hard_break / url only; §34.19 `:1133` 🟡 names the full v1 set | Port the rest as tokens allow: `code` (B3), `hr`/`table` (B5/B4), `image` (BB1), `date` (§34.28 #9 carries the detail — cross-ref only), `embed`/`whiteboard` already exist as tokens but lack slash entries |

**Decisions (needed from the owner before implementation):**

- **B1 collapse persistence** — (a) session-only / (b) semantic flag / (c) off-log presentation channel. Default proposal (a); (b) and (c) each need a recorded ruling (and (b) a SCHEMA.md amendment + lockstep).
- **B3/B7 render dependencies** — KaTeX and Mermaid under the privacy-first law: bundle locally (proposed) or reject. One ruling covers both.
- **B4 tables** — rows-as-blocks view (recommended) vs free-form grid token.
- **B6 highlights** — which import sources (Readwise API / local file / browser clipper) and whether the `highlight` class is seeded or user-authored.
- **B8/B9** — adopt card views and the asset-page convention, or record rejections.
- **BC4 survivor set** — keep text-only promotion law as-is (proposed) vs let more tokens survive.

**Non-goals / deliberate asymmetries (recorded, not gaps):**

- **Headings (H1–H4)** — absent by the title-is-content law (owner decision 2026-10-01); tree zoom replaces heading navigation. Capacities' hierarchy interface has no faithful home; reopening requires an owner amendment + three-client lockstep.
- **Block-type catalog** — task/whiteboard/query/highlight all decompose into class+token+view; this register's rows confirm the pattern works rather than refute it. No catalog is planned.
- **Named "blocks properties"** (Capacities custom-object feature) — exists in stronger form as node-backed text property carriers: real child blocks with full grammar and arbitrary depth (§34.32 PB2 carries the carrier-value-shape cleanup).
- **Per-block emoji/icon** — `object.update` already carries `icon`/`color` per node; the missing piece is only a per-block UI gesture, foldable into B5's group styling pass if wanted.

**Cost frame:** BB1–BB3 + BC2–BC5 are store/web work — no wire change, unblocked now. Token additions (B3 `code_block`, B5 `hr`+group flag, B1 if ruled semantic, B8 `view` field) are wire-affecting → canonical fixtures + GTK/Flutter lockstep per law (schedule as ONE protocol batch). B4 rows-as-blocks, B7 render path, B9 are view/UI assembly. B6 is a server/CLI integration.

**Sequencing (suggested):**
1. **Bug/doc batch** (unblocked, cheap): BB1 asset renderer, BB2 dead-code deletion + §34.30 M7 citation fix, BB3 comment fixes (via §34.32 PC8), BC2 backlink gutter, BC4 promotion guard, `hr` slash entry (BC5).
2. **Protocol batch** (owner rulings on B1/B3/B7-deps/B8 → fixtures → three-client lockstep): `code_block`, `hr`, optional collapse flag, `embed_ref.view`.
3. **View-assembly batch**: B4 rows-as-blocks tables, BC3 cap removal, B9 asset pages, B5 group (after §34.19 `:1128` selection ships), B7 KaTeX render.
4. **Integration batch**: B6 highlight importer, B5 columns (dnd extension), B2 list styles.

**Register cross-checks (no double-listing):** §34.19 `:1128` block multi-selection ❌ (prerequisite for B5 Ctrl+G — headline stays) · `:1129` ghost trailing block ❌ (untouched) · `:1130` fold via Ctrl+. ❌ (B1 pairs) · `:1131` keyboard map 🟡 · `:1132` floating toolbar underline+math 🟡 (B7 is math *rendering*; the toolbar math *mark* stays there) · `:1133` slash commands 🟡 (BC5 detail) · `:1139` unlinked mentions 🟡 (untouched) · `:1143` view modes 🟡 (B4/B8 ride the `NodeCollection` machinery) · `:1148` templates ❌ → §34.25 (untouched) · `:1171` whiteboard toolset 🟡 (untouched) · `:1172` import ⛔/🟡 (B6 rides its backend decision) · §34.28 #9 slash `date` (headline stays; BC5 references) · §34.30 M4/M8 block content search (untouched), **M7 citation correction (BB2 carries it)**, C5 cursor (BC3 pairs) · §34.31 V-rows (B4/B8 ride the view registry) · §34.32 PB3 body-exclusion depth bug (nested carriers — adjacent block rendering, stays there), PG14 image zombie (BB1/B9 detail), PC8 doc-lag batch (BB3 rides) · SCHEMA.md `:61` (asset render rule — BB1 implements it), `:117` (block backlinks — BC2 implements it).

### 34.35 Feature toggles — per-workspace feature system over system classes (owner idea 2026-10-02 — design proposal, pending owner review; unscheduled)

**The idea (owner, 2026-10-02):** workspace settings get a **Features** section of per-workspace toggles — task management, read-it-later, journals, and similar. Each toggle maps to **system-defined classes** (the seeded fixed-UUID vocabulary, `packages/domain/src/seeds.ts:12-50`): toggling a feature archives/unarchives its classes (`class.active` / `node.is_active` in the derived store). Keeping these features system-defined rather than user-authored classes is the load-bearing decision: the class stays the anchor for feature logic — task recurrence and the status workflow bind to the `task` class's property schemas (`taskRecurrence`, `taskStatus`, …, `seeds.ts:138-143,195-206`), the journal date chain to `day`/`month`/`year`, the capture queue to `weblink` + `highlight` — and the toggle itself is a derived projection of workspace state, not UI-code branching.

**Capacities reference (docs fetched 2026-10-02)** — the pattern is exactly theirs:

- **Task management is opt-in**: "Task management in Capacities is opt-in… If you… don't want to see tasks in Capacities, you can hide all task management features in the Task Management settings" ([Task Management](https://docs.capacities.io/reference/task-management)). The feature gets a settings home (`Settings > Task Management > Status Customization` — reorder/add statuses, colors, icons) *because* the Task type is built-in: the settings write to the type. Basic object types are "built into the app, we can give them a tailored design and functionality" ([Object types](https://docs.capacities.io/reference/content-types)).
- **Daily notes**: the Reviewed-day workflow — "If you do not want this workflow, turn it off in Daily Note settings"; per-type calendar visibility lives in the object type's own settings ([Dates and daily notes](https://docs.capacities.io/reference/dates-and-daily-notes)).
- Creation surfaces gate on the flag: "Create a Task (if tasks are enabled…)" ([Mobile](https://docs.capacities.io/reference/mobile)).

Mapping: Capacities "built-in type" → Notees system class (fixed UUID); "feature flag" → workspace feature state (below); "feature settings section" → the managed class's own property schemas + class chrome — the same machinery, no new settings surface.

**Verified current-state constraints (file:line, 2026-10-02):**

1. **No `class.restore` exists, and `class.delete` is lossy — the toggle must NOT ride it.** `class.delete` (`packages/store/src/appliers.ts:774-787`) tombstones *every* `class_member_set` row for the class, recomputes all affected nodes' `class_ids`, and deactivates registry row + class node. Re-issuing `class.create` revives the registry row (`ON CONFLICT … active = 1`, `appliers.ts:723-728`) but the node insert is `INSERT OR IGNORE` and its update path never touches `is_active` (`appliers.ts:658-703`) — an archived class node stays archived, and the tombstoned memberships are gone either way. Feature archival must therefore be a **separate, membership-preserving path**: flip `class.active` + the class node's `is_active`, never touch `class_member_set`, never write a `trash` row.
2. **The existing flags already read correctly for "archived class".** The `class` registry has its own archive column (`active`, written at `appliers.ts:723,777`, read filtered at `:875`); FTS/member queries filter `node.is_active = 1` (`packages/store/src/store.ts:246,349`; `search.ts:118`). A feature-off class disappears from pickers, @-mention search, and its class hub, while **instances keep their `class_ids`** and stay in the graph — Capacities' "hide the feature, keep the objects" semantics for free.
3. **No `workspace.*` op family** (`packages/protocol/src/op-types.ts:325-337`) — workspace-level semantic state has no wire home. Per the design law (semantic state only; device state is never an op — §34 invariants) a synced per-workspace toggle **must** be a new op: additive `workspace.feature.set {feature, enabled}`, LWW by HLC on `(workspace_id, feature)`. A new op means canonical fixtures + GTK (`v2.0.0-m3`+) / Flutter (`v2.0.0-m11`+) lockstep before it counts as done (AGENTS.md parked decisions).
4. **The UI home exists**: `WorkspaceSettingsModal` (tabs general/shortcuts; rename is a server PATCH; date format and sidebar toggles are device-local `notees.settings.*` — `apps/web/src/ui/components/modals/WorkspaceSettingsModal.tsx:1-11,96-100`). A synced toggle cannot be a device setting — the same workspace on two devices must agree — so the Features tab issues the op through the normal client op path.
5. **The enable path closes existing owed work**: the six task property schemas (`taskStatus`/`taskDeadline`/`taskScheduled`/`taskPriority`/`taskClosedDate`/`taskRecurrence`, `seeds.ts:138-143`; option sets `seeds.ts:195-206`) exist only as reserved UUIDs — register row "Task property schemas never authored in v2" (§34.22 `:1622`). Enabling `tasks` is the natural idempotent authoring point: ensure the `task` class + the six schemas + their bindings (fixed UUIDs; the property appliers already upsert idempotently, `appliers.ts:1045-1051`). Existing workspaces converge the same way — the enable op arrives, the seed-ensure runs in the applier; no special migration and no server-seed change.

**Proposed design:**

- **Feature map** — a system enum in `packages/domain` (fixed feature ids, not UUIDs; these are protocol vocabulary, not nodes), each entry = list of system-class UUIDs + an `ensure` spec of property schemas to author on enable. Proposed initial set (owner confirms): `tasks` → `task` (+ task property family) · `journals` → `day`,`month`,`year` · `readItLater` → `weblink`,`highlight` · `library` → `source` family (`book`,`paper`,`article`,`thesis`,`document`,`movie`,`song`,`tv_series`,`conference`) · `people` → `agent`,`person`,`organization` · `collections` → `collection`. Always-on structural classes are not toggleable: `class`,`asset`,`query`,`code`,`card`,`template`,`comment`,`table`,`cloze`, and the admonition set (`note`,`tip`,`info`,`warning`,`danger`,`success`,`quote`). Flagged interaction: `whiteboard` is both a class and a content token (§34.34's promotion survivor) — embedded whiteboards in existing content must render even with the class off, so it stays always-on in v1 of this system.
- **Store** — new derived `workspace_feature (workspace_id, feature, enabled, hlc…)` table. The applier applies LWW per key (a later toggle always wins, whatever the arrival order, via the op's HLC), then performs the derived flag flips on the mapped classes — idempotent and membership-preserving per constraint 1.
- **Toggle off is never deletion.** Instances remain queryable in the graph; class surfaces (class hub, picker entries, creation gestures, slash entries, palette actions, feature chrome such as the tasks hub and journal section) gate on the feature table + `class.active`. The disable gesture confirms with "N existing objects keep their data" when the feature has instances.
- **System-class delete interaction** — a user-driven `class.delete` of a feature-managed system class is either (a) routed to the toggle (the Features setting becomes the single archive path for managed classes) or (b) rejected with "managed by Features". Proposal: (a); owner call.
- **Defaults** — all features ON, matching today's always-seeded reality (`SEEDED_SYSTEM_CLASSES`, `seeds.ts:209-242`; server seed `apps/server/src/seed.ts`); an empty `workspace_feature` table means "all enabled" → zero migration for existing workspaces. (Capacities defaults tasks to opt-in-but-discoverable; Notees classes are already seeded active everywhere, so default ON preserves current behavior. Owner call.)
- **Per-feature settings** (Capacities' Status Customization analog) need no new machinery: they are edits to the managed class's property schemas — status options are the `taskStatus` select's options, reorder is `class.reorder` on the property bindings. The "system-defined" payoff, recorded.

**Work sketch (when scheduled):** ① protocol — op schema + fixtures for the three-client corpus, batched with the other pending wire items (§34.34's protocol batch); ② store — `workspace_feature` table + applier + membership-preserving class flag flips + task-family seed-ensure; ③ web — WorkspaceSettingsModal Features tab (existing `BooleanToggle` primitive) + read-surface gating (pickers/search already filter the flags; add feature gates to chrome); ④ docs pass per the owner rule (SCHEMA.md system-classes section, `docs/usage.md` settings section, this plan's registers). Small-to-medium slice: one op, one table, UI assembly.

**Decisions needed from the owner:**

| # | Decision | Proposal |
|---|---|---|
| F1 | Initial feature set + always-on list | As proposed above |
| F2 | Default state per feature | All ON; empty table = enabled |
| F3 | Disable-with-instances semantics | Hide surfaces, keep data (Capacities parity) |
| F4 | Managed-class delete routing | Route `class.delete` on managed classes to the toggle |
| F5 | Lockstep batching | Fold `workspace.feature.set` into §34.34's pending protocol batch |

**Register cross-checks (no double-listing):** §34.22 `:1622` task-family row (this section's enable path closes it — headline stays there) · §34.28 dates & daily notes (the `journals` toggle is the future home of journal visibility settings; cross-ref only) · §34.34 B6 highlight importer (rides `readItLater`; untouched) · §34.19 `:1147` ArchivedPagesView ❌ (feature-off classes are a different surface from user-archived pages — when that view is built it must not list feature-archived classes; noted here so the distinction survives) · SCHEMA.md system-classes section (normative home of the feature map once approved) · AGENTS.md parked decisions (the lockstep law applies to `workspace.feature.set`).

### 34.36 Meeting system — meeting system class + calendar integration (owner request 2026-10-03 — design proposal, pending owner review; unscheduled)

Registered from the live-workspace class migrations (2026-10-03): "Notas" carries two hand-rolled meeting-ish user classes (`reunión`, 52 members; `evento`, 27) because the seed catalog has no event/meeting concept — `conference` is a bibliography source (source family, `seeds.ts:104`), and `task` is the only workflow-flavored system class. The docs already teach the workaround (calendar quick-create's example is a *user-defined* "Meeting" class with a date property, `docs/usage.md:187`) — evidence the catalog is incomplete here.

**Design proposal:**

- **System class `meeting`** — next free fixed UUID `00000000-0000-0000-0001-000000000039` (append-only rule, `seeds.ts:6-10`); icon proposal `mdiAccountGroup`/`mdiCalendarClock` (owner picks); seeded like the task class (class node + registry row). Standalone — it does NOT extend `source` or `agent` (an attended meeting is neither a bibliography entry nor a person).
- **Property family** — the minimum useful meeting shape rides the existing date model: `meetingDate` (date, whole-day per the §34.28 time-of-day non-goal — start/end clock times are deliberately out of scope; a datetime would have to amend that law first), with optional text `location`/`agenda` as owner calls. The class becomes quick-create eligible automatically (any class with a date property, `docs/usage.md:187`), landing on the calendar like the task example.
- **Feature-toggle home** — if §34.35 is approved, `meetings` → `meeting` is the natural feature-map entry (the enable op authors class + schemas + bindings idempotently; existing workspaces converge from the log, no migration). If §34.35 is rejected, plain seeding applies.
- **Existing-workspace remap (optional, owner call)** — Notas' `reunión`/`evento` members move to `meeting` via the established membership ops (the OR-Set assign/unassign pattern — `object.create` re-issue + `class.unassign` — run for fuente→source on 2026-10-02/03); authored property values survive unassign; extends edges remap via `class.setExtends` (replace semantics). Empty user classes stay unless the owner deletes them.
- **Wire/lockstep** — a seeded class alone is zero protocol cost (no new op type → no fixture gate): seeds ride the op log and every replica converges; GTK/Flutter constants get the new `SYSTEM_CLASS_UUIDS` entry as a non-blocking seed-convergence follow-up (§34.25 precedent). Folded into §34.35 instead, the `workspace.feature.set` lockstep batch carries it.

| M1 | Class + UUID + icon | Proposal above | Owner confirms the three values |
| M2 | Property family (date/location/agenda) | Date-only is the law-compliant default (§34.28 whole-day precision) | Owner picks the family before scheduling |
| M3 | §34.35 toggle vs plain seed | Feature map vs always-on | Fold into §34.35's owner review |
| M4 | Notas remap scope | `reunión`/`evento` (79 members total) | Optional one-shot op batch; same ops as the fuente work |
| M5 | Docs pass | SCHEMA.md system-classes section, `docs/usage.md` quick-create example, AGENTS.md catalog line if seeded | With the implementation, per the owner rule |

**Cost frame:** seeds + (optionally) the §34.35 enable spec are additive `packages/domain` work; web/CLI surfaces pick the class up through the generic class machinery (pickers, quick-create, query) — no dedicated UI. The remap is a one-shot op batch. Cheapest as one slice batched with whichever of §34.35 / §34.34's protocol batch lands first.

**Register cross-checks (no double-listing):** §34.35 (M3 folds `meetings` into the feature map; the F-table owns toggle mechanics) · §34.28 dates (whole-day law — M2 cannot offer clock times without amending it; cross-ref only) · §34.22 `:1622` task-family row (the `meetings` enable op mirrors the `tasks` ensure path if §34.35 ships) · §34.25 templates (untouched) · SCHEMA.md `:42` (time-of-day non-goal restated — M2 stays compliant) + the system-classes section (normative home of the new seed) · `docs/usage.md:187` quick-create row (rewrites from "user-defined Meeting example" to the system class when shipped).

### 34.37 Node picker — focus fix, Main/Blocks scope tabs, link wording (owner request 2026-10-03 — SHIPPED same day)

Owner request, three parts: (a) the cursor must move into the node picker's search bar when the popup opens (it stayed in the edited block, so typed queries landed in the block); (b) the picker gets two tabs — **Main** (top-level nodes or children marked present-as-main) and **Blocks** (inline child blocks), Main the default, each tab scoping the search; (c) the typed-date suggestion said "Go to daily page: Today" — navigation wording for what is actually a link gesture; reworded to "Link to daily page: …" (create variant unchanged).

**Archive mining (standing rule 1):** v1's `SuggestionPopup` (`frontend/src/features/content/components/nodes/SuggestionPopup.tsx` @ `v1-archive`) deliberately did **not** autofocus — its `useFocusTrap` ran `autoFocus: false` because the v1 popup had no search field: the query was typed inline after the trigger and the block itself was the search field. v2's popup owns its search input (`updateCapture`: "the query lives in the popup's input"), so focus must move — the bug was v2-specific, nothing to port. Two v1 details did inform the design: v1's link popup ordered results "pages first, then blocks" (the scoping the tabs make explicit), and v1's date row showed the bare date-node name for existing pages with "Create daily: …" for missing ones — no "Go to" anywhere; v2's "Go to" was a wording regression, now aligned to the link semantics.

**Root cause of (a), verified live:** the anchored popup renders `visibility: hidden` until `useViewportPosition` measures it, and the focus `useEffect` (deps `[isPickerOpen]`, unchanged for anchored popups) fired `searchInputRef.current.focus()` while the panel was still hidden — Chromium refuses programmatic focus inside a hidden subtree (proven with a minimal probe; manual focus once visible stuck, ruling out a focus thief). Fix: the effect is keyed on `position !== null` — set by the positioning layout effect — so focus runs only after the visible commit (`NodeSelector.tsx` focus effect). Reproduced against the deployed stack with Playwright (caret stayed in the block, query text landed in the block text) and re-verified fixed on a fresh build: `PICKER-VERIFY-PASS`.

**Shipped:** `NodeSelector.tsx` — new opt-in `scopeTabs` prop rendering Main/Blocks tabs above the search input (the `Tabs` primitive, ghost variant; the active tab's `Tabs.Panel` hosts the results so `aria-controls` resolves); Main scope = `isClass || rendersWithDocumentChrome` (classes stay mentionable, §34.34's confirmed behavior), Blocks scope = `rendersAsInlineBlock` — exhaustive over non-class nodes; tab click re-pages results and refocuses the search input. Only the editor's `@` mention picker passes `scopeTabs` (`BlockTextEditor.tsx`): the `#`/`+` pickers have fixed narrow scopes, and `LinkEditModal`'s block mode (searchMode `all` + `canAdd` inline-filter) would break under tabs. Date suggestion reworded to "Link to daily page: …" / "Create daily page: …", and its existing-page check is now read live each render (was frozen in a `[parsedDate, client]` memo — the label went stale if the journal chain appeared under an open picker). Also fixed the two stale comments BB3 flagged in the touched files (the "class appliers don't reindex" claim — they do, `appliers.ts:736,770` — and the editor header's "pages and blocks only, no classes"). Test infra: `ResizeObserver` stub moved into the shared `test/setup.ts` (Tabs.List needs it; every future picker test would otherwise re-hit the four-file copy-paste stub).

**Verification:** `pnpm -r build` green; `pnpm test` green (1264 tests across 8 workspaces); new coverage in `capture.test.tsx` (tabs scope/filter/default/refocus, picking a block from the Blocks tab, classes mentionable from Main, "Link to"/"Create" date wording incl. the live-existence flip); Playwright verify against a fresh `dist` build pointed at the live sync server (focus in input, tabs present, "Link to daily page: October 3, 2026" row, Blocks scope switch). Probe cleanup note: the live-verify probes typed test text into one live journal block — restored via the object API (content back to "GMI Dental Implantology, S.L", verified).

**Docs (same pass):** `docs/ux.md` capture-gestures row (picker focus + tabs + "Link to" wording). No SCHEMA.md/AGENTS.md change — UI-only, no wire/model delta.

**Register cross-checks (no double-listing):** §34.34 BB3 (the two NodeSelector/BlockTextEditor stale comments it flags are fixed here; the remaining BB3 item — `BlockTextEditor.tsx:1430` placeholder wording — stays with §34.32 PC8) · §34.34's "classes are mentionable" confirmation (tabs keep classes discoverable in Main) · §34.19 `:1141` SuggestionPopup row (the `[[` date-page trigger owed item is untouched; the `@` date row now reads "Link to") · §34.28 dates (no wire change; the suggestion label is UI copy).

### 34.38 Node restore — `object.restore` op, trash/children API filters, CLI bulk + property verbs (owner request 2026-10-03 — SHIPPED same day)

Owner request ("implement all"), five items from the CLI-tooling session's wishlist, two of which required wire work: **(1) restore** closes SCHEMA.md's long-standing "Deletion/restore semantics" owed item (the trash existed since M1 with no resurrection path — `:1155`'s TrashView row listed "Store has trash; no UI"; the API/CLI had none either), and **(2) property authoring** makes the CLI the object/property/search surface AGENTS.md already claims it is.

**Archive mining (standing rule 1):** v1 (`app/features/nodes/` @ `v1-archive`) trashed nodes with a `deleted_at` column and resurrected via a `restore_node` service path that re-parented orphans to the workspace root — the same whole-tree instinct. Nothing to port op-wise (v1 had no op log); its one durable lesson (restore reparents when the parent is unrecoverable) is preserved in the applier's corner branch.

**Shipped:**

- **Protocol** — new additive op `object.restore {objectId}` (op-types.ts + catalog entry; canonical `object-restore.json` fixture, gate list 11→12). Semantics per the SCHEMA.md item's own recommendations: whole-tree restore — the subtree that rode the root's trash event reactivates; a descendant with its OWN trash row was trashed independently and stays trashed (its subtree rides with it). LWW vs `object.delete` = log order (single global relay log ⇒ convergent, no merge metadata). Corner: parent row missing → reparent to workspace root; present-but-inactive parent left alone (heals when the parent restores). The "nearest parentless-or-main-presenting ancestor" recommendation collapsed on inspection: the derived schema's enforced `parent_id` FK makes the dangling state unrepresentable (FK-off/legacy data only), so the walk has nothing to walk.
- **Store** — `applyObjectRestore` (subtree minus independently-trashed branches via own-trash-row ancestor walk; consumes the root's trash row; `rebuildNodeStats`), wired into the APPLIERS map. Covered on both backends: whole-tree round-trip, independent-trash exclusion, later child-restore, the dangling-parent corner (FK pragma-off simulation), and fail-loud on permanently deleted ids.
- **Server** — `POST /api/objects/:id/restore` (404 surfaces the applier's not_found); list filters `?parent=<uuid>` and `?trashed=true` (the latter swaps the active-only clause — trash scans without one `children` call per node).
- **CLI** — `notees object restore <id>…`; `notees object list --trashed|--parent <id>`; `notees object property set|delete <id> <schema uuid|name> <value> [--idx N]` (value parses as JSON when possible, else string — the bibtex importer's internal helpers promoted to first-class commands); `notees object get --ids <uuid…>` multi-read; `notees object create --icon/--color` (create+update composition — the `object.create` payload carries no appearance fields); `notees export markdown --class <id|title>` (members seed the bundle; mutually exclusive with `--ids`/`--linked-to`).

**Verification:** `pnpm test` green repo-wide at the entry (protocol 116 incl. the 12-fixture gate, store 167 on both backends, cli 63 incl. new e2e for restore/trash-list/property/list-parent/export-class/multi-get/icon-color); `pnpm -r build` + `pnpm -r typecheck` green.

**Docs (same pass):** SCHEMA.md owed item ticked with the full semantics + lockstep note; `.plans/dev/architecture.md` §11 register (restore lockstep owed) + CLI inventory; `docs/usage.md` (restore/trash section, property commands, `--parent`/`--class`/`--ids` flags); README feature line. No AGENTS.md delta beyond the standing plan-update rule the owner added with this request.

**Register cross-checks (no double-listing):** SCHEMA.md `:16` (this entry implements it — the checkbox moves there) · plan `:1155` TrashView row (API + CLI restore now exist; the **web TrashView UI stays ❌** — this entry does not build it) · §34.32 PB2 (unset-deletes-carrier — adjacent trash semantics, untouched) · §34.34's pending protocol batch (restore shipped on its own; `workspace.feature.set` remains the batch's payload) · lockstep law (AGENTS.md parked decisions): **GTK/Flutter lockstep SHIPPED same day** — `notees-gtk` v2.0.0-m4 (`1a6143d`) and `notees-flutter` v2.0.0-m14 (`181a96e`) both implement `object.restore` with the four-semantics coverage (whole-tree, independent-trash exclusion, dangling-parent reparent, fail-loud on permanent delete); Flutter gained the `trash_root` table (app DB v21) as its trash-tracking home, GTK mirrors the TS `trash` table it already had. CI releases published from the tags; envelope v3 unchanged.

**Lockstep addendum (owner "proceed with GTK/Flutter lockstep", 2026-10-03 — SHIPPED same day):** both sibling repos implemented `object.restore` and released — GTK `v2.0.0-m4` (payload + registry + `_apply_object_restore` in `store.py`, suite 442 passed) and Flutter `v2.0.0-m14` (builder + strict validator + `_applyRestore`, `trash_root` table via app-DB v21 migration — the cache-based store had no trash tracking, so the lockstep added it rather than approximating the semantics; suite 451 passed). Tags pushed; CI release workflows published the artifacts. The three-way lockstep for `object.restore` is complete (contra the "LOCKSTEP OWED" note recorded in SCHEMA.md earlier today — both clients now carry the op).

**Addenda (same session, owner follow-ups 2026-10-03):**

1. **Date pages are main nodes — never Blocks-tab entries.** The Blocks scope matches `rendersAsInlineBlock` (parented, bit unset); the journal chain nests (year root → month → day), so an unbitted chain node would render inline and land in Blocks. Verified state: v2's `ensureDateChain` (`workspace-client.ts:1743-1776`) already authors `presentAsMain: true` on every new chain node — the only chain-creation path in this repo — and both live workspaces are clean (987 date nodes, all bitted; the second workspace has none). Deliverables anyway, per owner: **`scripts/migrate-date-pages-main.mts`** — scans every workspace's derived DB for active date-shape ids (`…00bb-YYYY…` year / `…00aa-YYYYMM…` month / `…00dd-YYYYMMDD…` day, the deterministic `dates.ts` shapes) with `present_as_main = 0` and appends `object.update {presentAsMain: true}` envelopes through the relay `/batch` ingest (immutable log untouched, every replica converges; the `migrate-mention-texts.mts` pattern verbatim). Ran against the live server: `done: 0/0 date nodes fixed` — idempotent no-op confirmed. Existential risk that motivates it: sibling clients (GTK/Flutter) carry their own chain-ensure code — an older build creating a parented chain node without the bit is exactly what this repairs. Invariant pinned in `dates.test.tsx` (chain-structure test asserts `presentAsMain` on year/month/day).
2. **Typecheck debt cleared ("fix them either way").** `pnpm -r typecheck` was red on the T1/T2 clone-engine commit + calendar tests (the build+test gate never runs tsc, so it slipped in): `clone.ts:325` (`exactOptionalPropertyTypes` — `SubtreeCloneOptions.afterId/beforeId` now `string | undefined`, matching codebase convention), `clone-engine.test.ts` (~35 errors — all from `found[0]`/`rootSets[N]` indexing without non-null assertions, which also collapsed the `CloneOp` discriminated-union narrowing; four `!` fix the lot), `calendar-view-utils.test.ts:174-175` (test stub type dropped the `name` field the real `dateChipCandidates` binding type accepts). `pnpm -r typecheck` is now green repo-wide (0 errors) — recorded so the next agent keeps it green.

**Deploy addendum (owner "deploy", 2026-10-03):** host-built images per the AGENTS.md path — `docker build` × 2 (repo-root context) → `ghcr.io/miquelrosell99/notees-{sync,web}:latest`, then `NOTEES_SYNC_TAG=latest NOTEES_WEB_TAG=latest docker compose up -d` (the host shell exports `NOTEES_*_TAG=2.0.0-m5` pins, so the override is load-bearing — without it compose resurrects the published m5 images over the local build; the published m5 tags themselves are untouched, and no git tag was pushed, so ghcr CI published nothing). Both containers healthy; `scripts/screenshots/verify-min.mjs` **VERIFY-PASS** (clean boot, footer "Sync: idle", UI search hit, zero console errors). The deployed build carries this session's picker work + the uncommitted in-flight templates work (green under build/test/typecheck at deploy time). **Follow-up (owner):** the `NOTEES_{SYNC,WEB}_TAG=2.0.0-m5` pins were deleted from the stack `.env` (their only source — nothing under /etc/komodo carries them) so compose's `:-latest` default governs; plain `docker compose up -d` now tracks the local build. Trade-off recorded: `docker compose pull` will now fetch ghcr's CI-published `:latest` too (it moves on every `v*` tag push), which can shadow a locally-built unreleased image — the pins existed to prevent exactly that surprise swap.

### 34.39 Editor atom pill — v1 selected look (owner request 2026-10-03 — SHIPPED same day)

Owner request ("i want v1 look … implement the full editor alignment"): the selected node-link pill in the block editor must look like v1's — reaching it with the caret (or clicking it in edit mode) selects it **with an outline**, and clicking toggles selection rather than navigating. Functionally v2 was already at parity — §34.22 E1/E2 shipped the full v1 gesture set (first click selects with caret placement blocked, second click places the caret before/after by half, arrows select when the caret reaches a boundary, dblclick/Enter open, Backspace/Delete atomic, any other key clears the flash) — so the delta was purely visual: v2's selected state was a `--color-primary-container` background fill, v1's is primary text on an 8% primary tint inside a focus ring.

**Archive mining (standing rule):** v1's `frontend/src/styles/inline-link.css:60-68` @ `v1-archive` — `.inline-link-wrapper--selected .inline-link-inner`: `color: var(--color-primary)`, primary underline color, `background: color-mix(in srgb, var(--color-primary) 8%, transparent)`, `--shape-extra-small` radius, `padding: 0 var(--spacing-micro)` paired with `margin: 0 calc(var(--spacing-micro) * -1)` (the tint and ring extend a micro beyond the text without shifting the line's layout), `box-shadow: var(--shadow-focus-ring-primary)`. Ported near-verbatim; the only adaptation is structural — v1's style targeted an inner span inside a wrapper, v2's pill is a single `span.nt-atom` (the underline lives on `border-bottom` rather than v1's `text-decoration`, so selection recolors that border). The pad pair was carried over on day one and dropped the same day — see the fix below.

**Shipped:** `apps/web/src/ui/app.css` `.nt-atom--selected` (+ its `:hover` guard) — primary text, 8% primary tint, `--shape-extra-small` radius, primary focus-ring outline; the dashed underline hides on selection so the ring reads as one clean shape. Base and hover chrome untouched: the edit pill keeps mirroring the read-mode link look (the §34.22 "visually identical to read mode" invariant), and the selection state has no read-mode counterpart. Token-only per the UI law — every value resolves to `apps/web/src/ui/variables.css` (`--color-primary`, `--shape-extra-small`, `--shadow-focus-ring-primary`; the 8% mix uses the same `color-mix` pattern the token file itself uses). No TypeScript/test changes — selection state, gestures, and the `nt-atom--selected` class contract are unchanged. Two same-day owner-report follow-ups:

1. **Layout-jump fix** ("on highlight via caret, the node link jumps line", with a screenshot of a date pill fragmenting "2026/10/0|4" across lines): the pad pair carried over from v1 (`padding: 0 var(--spacing-micro)` + negative margin) made the selected pill +4px wider; on a tight line the delta found the `/` break opportunity inside the pill text and re-wrapped it exactly on selection. The selected state is now layout-neutral — no padding/margin (ring, tint, radius, colors affect paint only), so selection can never change wrapping.
2. **Underline hidden** ("hide the underline when a node link is selected"): `border-bottom-color: transparent` on the selected state (v1 recolored its `text-decoration` instead — the owner prefers it gone; owner call wins over archive fidelity).

**Verification:** `pnpm test` green repo-wide (one mid-session gate run showed 4 transient failures in `workspace-client.test.ts`'s icon tests while the parallel templates session was saving files mid-run — immediate re-run clean at 483/483 web, not reproducible); live probe `scripts/screenshots/pill-select-probe.mjs` against the deployed build — **PILL-PROBE-PASS** (ring present, primary text color via rgb-normalized compare, underline transparent, first click selects without navigating, ArrowRight clears the selection, row-fill click keeps focus with the caret after the pill); the probe's scratch fixture is trashed on exit. `verify-min.mjs` VERIFY-PASS after each deploy.

**Deploy addendum (owner "commit, push and deploy", 2026-10-03):** three host-built `notees-web:latest` deploys in this slice (v1 look → wrap fix → underline-hidden, the last also carrying §34.40's row fill), each `docker compose up -d` per the §34.38 follow-up (the TAG pins are gone from the stack env, so compose tracks the local build). The first deploy also carried the parallel session's uncommitted templates T3 work, per that session's own addendum precedent (green under build/test at deploy time). No git tag pushed — ghcr CI published nothing; the owner's read-only docker login untouched.

**Docs (same pass):** `docs/ux.md` mention row — the pill's selected look named (primary text on a faint primary tint inside a focus-ring outline). No SCHEMA.md delta (chrome-only, no wire/model touch); no AGENTS.md delta.

**Register cross-checks (no double-listing):** §34.22 E2/shipped-state (this amends only the pill's selected style; the gesture record stands) · §34.19 `:1142` Link pills row (✅ stands — arrow-select/atomic delete already shipped; this closes its visual delta) · §34.34 blocks register (untouched — no block-content delta) · SCHEMA.md owed-work register (no entry needed — no normative change).

### 34.41 Editor rows span side to side (owner request 2026-10-03 — SHIPPED same day)

Owner request: "block rows should span side to side in their container, not adapt to the block content."

**Archive mining (standing rule):** v1's `.custom-inline-editor` (`frontend/src/features/editor/custom/components/CustomInlineEditor.css` @ `v1-archive`) is `flex: 1` — the editable fills the block's content column. v2's `.nt-block-text` was `display: inline-block`, hugging its text: in edit mode, clicking the empty right side of a row landed outside the contentEditable → blur → the block dropped out of edit instead of placing the caret. (The row chrome itself already spanned — `.nt-block-content` is `flex: 1`; only the editable element hugged.)

**Shipped:** `apps/web/src/ui/app.css` — `.nt-block-text { display: block }` plus `.nt-editor-root { display: block }` (the wrapper was `inline`, which would split anonymous boxes around its now-block child). Clicking anywhere on an editing row now places the caret at the nearest position, matching the archived editor's contract. The live probe asserts it: the editor's width equals the content column's width, a click at the right edge keeps focus, and the caret lands after the pill.

**Verification:** `pnpm test` green (web 483); the row-fill assertions ride `pill-select-probe.mjs` (**PILL-PROBE-PASS** on the deployed build).

**Docs (same pass):** `docs/ux.md` outliner text-core row — one clause (the editable fills the row; clicking anywhere places the caret). No SCHEMA.md/AGENTS.md delta — chrome-only.

**Register cross-checks (no double-listing):** §34.22 E1 (the editable-DOM record — a display-mode amendment, gestures untouched) · §34.19 `:1128` block multi-selection ❌ (untouched) · §34.34 blocks & rich content (untouched).

### 34.40 Effective icons — display-time defaults (owner request 2026-10-03 — SHIPPED same day)

Owner request: "implement a default icon (display time, not stored) in effectiveIcon for classes that have no icon set. Same for main nodes/pages, use a page icon for example." The effective-icon chain (own icon → first class's chain icon, class order, extends-walked) previously ended in `null`, so iconless classes/pages rendered no glyph anywhere.

**Shipped:**

- **Domain** — new `packages/domain/src/icons.ts`: `DEFAULT_CLASS_ICON` (`mdi-shape-outline`), `DEFAULT_PAGE_ICON` (`mdi-file-document-outline` — the same glyph choices the command palette already used as its ad-hoc fallbacks), and `defaultIconFor(node)`, the render-state-aware tail of every effective-icon chain: class nodes → class glyph, document-chrome nodes → page glyph, **inline blocks → null** (their chrome is the bullet dot — a default there would erase the page/block distinction the render cascade exists to make).
- **Store (pre-existing bug the feature forced to surface)** — `upsertClassNode` (`appliers.ts:711`) routed create-time `icon`/`color` through its LWW-gated UPDATE, which can never fire for the creating envelope's own HLC (the in-code comment already knew this about `content` — content rode the INSERT directly, icon/color did not). So `class.create` with an icon wrote the glyph to the `class` registry row but left the **node row** `icon NULL` — and every effective-icon read (node rows) missed it. Every seeded system class (all carry `SYSTEM_CLASS_ICONS`) was iconless in node-row-derived surfaces. Fix: the INSERT now carries `icon`/`color` exactly like `content`. Pure projection fix — no payload change, no fixture gate.
- **Web core** — `WorkspaceClient.effectiveClassIcon` = raw extends-chain walk (`classIconInChain`, extracted private) ?? `DEFAULT_CLASS_ICON`; `effectiveNodeIcon` = own icon ?? first class's *raw* chain icon ?? `defaultIconFor(node)` — the class default deliberately does NOT leak into nodes (an iconless classed page renders the page glyph, not the class glyph; class identity already shows in the class pills). Signature widened with the three render facts (`isClass`/`presentAsMain`/`parentId`); the worker proxy (`worker-client.ts`) and dispatch (`worker-core.ts`) forward them.
- **Web UI** — `iconFor.nodeIcon` (the UI twin of the resolver: PageView header, Sidebar rows, Outline/Cards/Table items, BlockRow bullets) applies the same `defaultIconFor` tail, so all surfaces agree. `ClassPills` (pill + sortable popup row) switched from raw `cls.icon` to `client.effectiveClassIcon(classId)` — the class glyph shows even when none is authored. ClassView's icon-picker button keeps its `mdi-dots-grid` neutral placeholder (it signals "no icon set" for editing, not display). Link/mention picker rows (`NodeResultItem`/`NodePill`) keep raw own-icon display — chooser rows where a default per row is noise, not identity.
- **Tests** — domain: `defaultIconFor` cascade + constant shape (5 tests). Web (`workspace-client.test.ts`, node env, in-process client): class default + not-stored assertion, own-icon precedence, extends inheritance + multi-hop chain, node chain in class order, page defaults across both document-chrome branches, no class-default leak into iconless classed pages, block → null, class node → class default, `nodeIcon` helper parity (8 tests). 12/12 file-green.

**Verification:** store 167/167 both backends; web 483/483 across 51 files; domain 30/30. `pnpm -r build` + `pnpm -r typecheck` green at the entry.

**Docs (same pass):** `docs/ux.md` §Views — the effective-icon chain + display-time-default paragraph. No SCHEMA.md delta (the `icon` field semantics are unchanged; defaults are read-side, nothing normative moves). No AGENTS.md delta (no wire/op/model touch).

**Projection-healing note (existing live data):** class node rows created before the `upsertClassNode` fix keep `icon NULL` in existing derived DBs (browser worker DBs sync incrementally and do not re-apply old envelopes). Effect until healed: those classes show the new *default* glyph instead of their authored one. Healing paths: the server projection replays its relay log at boot (`workspace-store.ts` hydration — the deploy restarts it), and any fresh/healed client re-fetches the log through the fixed applier. Cosmetic lag, converges by replay; no data migration needed (the log was always correct).

**Register cross-checks (no double-listing):** §34.34 blocks register (untouched — no block-content delta; block bullets still dot by the `nodeIcon` null tail) · B4 row `:1581` ("icon fallback chain defines no per-class look" — still true: defaults are generic, per-class bound defaults remain B4's separate proposal) · `:1559` class-influence line (updated behavior, same data-only invariant — nothing persisted) · command palette defaults (now redundant but harmless duplicates of the domain constants — palette items construct their own rows; left as-is) · lockstep law (AGENTS.md parked decisions): **no new op, no wire change → no three-way gate**; sibling clients' own effective-icon code should mirror the defaults (their repos, non-blocking observation) · SCHEMA.md owed-work register (no entry needed — no normative change).

### 34.42 Data color preset palette — refresh, new presets, class-view unification (owner request 2026-10-03 — SHIPPED same day)

Owner request ("suggest a better color presets palette, they look bad. and add presets for missing colors, like yellow, light blue/teal, etc", screenshot of the class view header swatch row). Two problems: **(1)** ClassView carried its own hardcoded 7-hex palette (`ClassView.tsx` `CLASS_COLORS` — raw `#b42318`…`#475467`, the muted row in the screenshot), diverged from the shared data-level preset system (`ui/components/ui/colorPresets.ts` + `variables.css` `--color-preset-*`) that every other picker uses, and showed no yellow/teal; **(2)** the shared values themselves were muddy. No archive mining owed — v1 had no equivalent preset table (its colors were freeform).

**Shipped (web):**

- **`variables.css`** — the 8 `--color-preset-*` values re-tuned brighter with perceptually even lightness and full hue spacing (single set serves light warm-paper AND dark themes — presets are deliberately NOT theme-overridden): red `#e34d45`, orange `#ed822b`, yellow `#f3b816`, green `#30a66f`, teal `#27a59c`, blue `#4072e7`, purple `#9662da`, pink `#de4996`. Two new tokens: `--color-preset-sky` `#20a9e9` (the requested light blue) and `--color-preset-gray` `#8c857d` (warm neutral, replaces the legacy class row's slate).
- **`colorPresets.ts`** — `PRESET_CSS_VARS` / `PRESET_COLOR_ENTRIES` / `PRESET_VAR_NAMES` gain sky + gray: 10 presets in hue order (red, orange, yellow, green, teal, sky, blue, purple, pink, gray). Every picker mapping the shared entries (node picker palette, ColorButton picker, pill context-menu swatch row) picks the additions up automatically.
- **`ClassView.tsx`** — the class header swatch row renders `PRESET_COLOR_ENTRIES` and stores `var(--color-preset-*)` references like every other picker; the ad-hoc raw-hex `CLASS_COLORS` is deleted. `LEGACY_CLASS_COLOR_TO_VAR` maps the 7 old raw hexes to their successor presets so existing colored classes keep the right swatch highlighted; clicking re-stores the var reference. Legacy raw-hex data still renders (`resolveCssColor` passes plain hex through; contrast math unchanged).
- **`ColorButton.css`** — picker grid `repeat(8, 1fr)` → `repeat(5, 1fr)` (tidy 2×5 for ten presets).
- **`nodeColors.ts`** — order comment updated. **`pickers.test.tsx`** — swatch-count assertion 9 → 11 (no-color + 10 presets).

**Client follow-up (owner "implement in gtk and flutter too??"):** presentation-layer alignment, not a wire change — stored colors remain opaque strings, so no op/fixture/three-way protocol gate per the lockstep law.

- **Flutter** (`notees-clients/notees-flutter`) — `lib/core/utils/color_presets.dart` `entries` replaced with the web hex values verbatim (the muted mobile-only palette `#c55a55`… was drift) + `Sky`/`Gray` added; labels double as the `var(--color-preset-<name>)` lookup key in `tryResolve`, so the web's "Light blue" tooltip is labeled `Sky` there. All mobile pickers (node edit modal, quick capture sheet) map `ColorPresets.entries` → ten swatches automatically. Verified: `flutter analyze` clean, `flutter test` 451/451.
- **GTK** (`notees-clients/notees-gtk`) — **no change**: the GTK client round-trips node/class `color` as an opaque store string and has no color rendering or picker UI, so old and new preset values (including `var(--color-preset-sky)`) flow through untouched.

**Verification:** web 483/483 across 51 files (includes the ClassView-rendering suites: class-view, view-modes, class-bindings, render-cascade); `apps/web` `tsc --noEmit` 0 errors; `pnpm test` repo-wide green at the entry. Palette candidates were previewed rendered on both theme backgrounds (playwright swatch sheet) before settling the values; the scratch preview script was deleted.

**Docs (same pass):** no `docs/` delta (user docs never enumerated the palette); no SCHEMA.md delta (colors are opaque client data, not normative wire); no AGENTS.md delta.

**Deploy note:** not deployed in this slice (uncommitted parallel-session work in the tree would ride along; owner calls deploy).

**Register cross-checks (no double-listing):** §34.40 (untouched — icon chain only) · §34.19 `:1144` metadata row (per-node color ✅ stands; this changes the palette, not the feature) · §34.34 blocks register (untouched) · lockstep law (AGENTS.md parked decisions): no new op, no wire change → sibling releases not required; pre-refresh Flutter builds resolve known var names only (`sky`/`gray` stored by an updated web build render uncolored on an old mobile build until it updates — cosmetic, converges on update).
### 34.43 Color wire grammar — token | #hex | null-clear, three-way lockstep, live-log migration (owner directive 2026-10-03 — SHIPPED same day)

Owner directive ("proceed with the best implementation everywhere, no matter the cost. migrate as needed"), following the §34.42 palette refresh and the schema question it raised. The first v3 color encoding stored CSS variable references (`var(--color-preset-red)`) — a web-ism on the wire that drifted between clients (mobile stored resolved hexes from its own muted table, the class view stored raw hexes from a third palette). The §34.43 grammar replaces it: node/class `color` is ONE string field carrying a **preset token** (`red orange yellow green teal sky blue purple pink gray` — set normative in the protocol, order a client concern), a custom **`#RRGGBB`** hex, or **`null` to clear**. `object.update` gains the clear (the UI's "No color" was a protocol no-op until now — `ClassPills.tsx` carried the admission comment); `class.update`'s documented "null clears" is now schema-legal too. Concrete hex never rides the wire — it lives client-side (web `variables.css`, Flutter `ColorPresets`), so themes remap without touching data. **Archive mining:** none owed — v1 had no preset table (freeform colors only).

**Shipped (this repo):**

- **Protocol** — new `src/colors.ts` (`COLOR_PRESET_TOKENS`, `colorValueSchema`, `isColorValue`); `object.update`/`class.create`/`class.update` `color` now `colorValueSchema.nullish()`; the retired `var(--color-preset-*)` encoding is **rejected outright** (fixture test proves it); op-catalog descriptions updated. **13th canonical fixture `object-color.json`** (token → hex → null-clear on object.update; class.create token → class.update clear; id block 500-511 — the f-block collided with existing fixtures, caught by the store's shared-replay gate) + gate list 12→13.
- **Store** — appliers already pushed `null` through (`if (p.color !== undefined)`); only an `exactOptionalPropertyTypes` widen on `upsertClassNode` (`color?: string | null | undefined`) + two semantic tests (fixture-driven: node token/hex/clear; class token on BOTH node + registry rows then clear on both).
- **Web** — `colorPresets.ts` rework: entries emit **tokens**; render bridges `cssColorFor` (token → `var(--color-preset-*)` for style props), `resolveCssColor` (token → concrete hex via `PRESET_HEX` for contrast/canvas), `canonicalColor` (retired var() folds to its token — render tolerance until a client re-syncs); every render boundary converted (ClassView swatches + legacy raw-hex highlight map now maps to tokens, ColorPickerRow, ColorButton, ClassPills pill + **no-color now writes null**, MetadataSection tag pills, InlineTokens underlines, NodeIcon JSON colors, PageCard accent); `UpdateObjectInput.color: string | null`. New `test/color-presets.test.ts` — **PRESET_HEX ↔ variables.css parity guard** (fails on drift; escapes the jsdom fs shim via `process.getBuiltinModule`) + grammar tests. `pickers.test.tsx` stores `"red"` now.
- **Server** — `updateBodySchema.color` mirrored the old freeform string (would have 422'd every clear) → `colorValueSchema.nullish()`; PATCH re-validates through `objectUpdatePayload` (already strict).
- **CLI** — `--color` help documents the grammar; `--color none` sends the clear; e2e test: token lands verbatim, none clears, `var(--color-preset-red)` rejected server-side (422 → domain exit).
- **Migration `scripts/migrate-color-tokens.mts`** (migrate-node-type pattern: read-only dry-run, backup+quick_check before write, strict re-validation of every rewritten payload, snapshots dropped, derived DBs removed, restore_epoch bumped, idempotent marker `color_token_migration_v1`; protocol_version stays 3 — envelope shape unchanged). Rewrites `var(--color-preset-<x>)` → `<x>` in the three color ops' payloads AND inside JSON icon strings — plus a **legacy-hex → token table** (pre-§34.42 web palette, retired ClassView raw hexes, drifted Flutter muted hexes; the mobile cream default #f9f5e8 correctly stays custom). **Live dry-run: 19 legacy hexes → tokens across 4 workspaces, 1 custom passthrough, 0 unmapped, 0 var() refs** (the owner colored from mobile/class-view, never from the web pickers).

**Lockstep (the "everywhere" of the directive) — no new op, but a payload-schema change, so the three-way gate ran:**

- **GTK** (`notees-clients/notees-gtk`, uncommitted → committed+pushed+tagged **`v2.0.0-m5`**): `core/protocol/colors.py` parity module + pydantic `ColorValue`; builders take `color` via the file's `_UNSET` sentinel (None → explicit wire clear); **presence-vs-null fix** in `_apply_object_update`/`_apply_class_update`/`_upsert_class_node` (`"color" in payload`, TS `!== undefined` parity); vendored 13th fixture + replay test (intermediates + both class rows); +73 tests (**515 passed, 3 skipped**; ruff + mypy clean). **Latent parity bug found & fixed beyond the brief**: GTK's `_upsert_class_node` INSERT didn't carry create-time icon/color — the exact §34.40 TS bug, still present here; aligned with `appliers.ts`.
- **Flutter** (`notees-clients/notees-flutter`, → committed+pushed+tagged **`v2.0.0-m15`**): `domain/models/relay/colors.dart` (pure-Dart grammar port); `_color()` validator on all three ops (rejects the retired encoding/garbage; null-clear satisfies the at-least-one-field rule); `_undefined` sentinels on builders AND on the offline outbox (JSON round-trips `"color": null` — proven by flush tests); `ColorPresets.entries` gains tokens (labels unchanged: "Sky" = web's "Light blue", and the var-name lookup keeps resolving); pickers write tokens; `tryResolve` gains a token branch (the brief's assumption that label-lookup covered tokens was wrong — it only ran in the css-var branch); **`_applyClassUpdate` description clobber fixed** (unconditional write → presence-based, TS parity); color clear plumbed end-to-end (`NodeRepository.updateNode` sentinel → `update_color` null → wire). +28 tests (**479 passed**; analyze clean).
- **Observed, recorded, not fixed (out of scope):** a pre-existing GTK WS-timing test flutters intermittently on the pristine baseline too (`test_ws_client.py::TestLifecycle::test_hello_dispatches_and_updates_state`, passes in isolation); Flutter's mobile class-edit path still routes via `object.update` for class fields (converges on the node table; pre-existing); Flutter quick-capture create-time color never reaches the wire (v2 `object.create` carries no color slot — the TS CLI composes create+update for this).

**Verification:** main repo `pnpm -r build` + `pnpm test` green at the entry (protocol 129, domain 30, export 162, store 171 both backends, sync 13, query 153, server 116, **web 489**, cli 64). GTK 515/3-skipped; Flutter 479 — all suites green, both client repos uncommitted-until-this-entry's-commit.

**Docs (same pass):** SCHEMA.md new normative "Data color grammar" section; `docs/usage.md` CLI `--color` grammar; AGENTS.md lockstep line bumped to m5/m15.

**Deploy addendum (owner "commit push and deploy everything"):** committed+pushed all three repos (main `3f8613dc`; GTK `c00fbf5` + tag **`v2.0.0-m5`**; Flutter `848ed75` + tag **`v2.0.0-m15`** — CI publishes from the tags), then `docker compose stop` → `migrate-color-tokens.mts --apply` (**19 payload rewrites**, backup `relay.db.bak-20261003-171912` quick_check-verified, 18 snapshots dropped, 4 derived DBs removed, restore_epoch bumped ×4) → host-built `:latest` images → `docker compose up -d` → smoke **VERIFY-PASS**. The pre-migration server accepted tokens (its schema was any ≤32-char string), so the rewrite was safe under the old build. No main-repo git tag pushed — ghcr CI published nothing.

**Post-migration observations (recorded, no action needed):** (1) the server boot replay (183k-envelope workspace, derived DBs wiped) saturated the event loop ~19 minutes before healthchecks passed — expected one-time cost; (2) every client full-resyncs on next open (restore_epoch bump + snapshots deleted): a fresh browser measured **~5.3 min** to "Sync: idle", so `verify-min.mjs`'s 240 s window timed out twice — a 900 s-window scratch copy passed (VERIFY-PASS: UI search hit, no raw JSON, footer clean); if that window recurs in future migrations, raise the script's timeout permanently; (3) the replay surfaced one **pre-existing** sync error — an old `object.move` envelope parenting class `12eb6ec4…` (move-guard rejects it loud, by design) — historical log data untouched by this migration, visible only because the wipe forced a full replay.

**Register cross-checks (no double-listing):** §34.42 (palette values + presets — the grammar's token set and hexes inherit it; PRESET_HEX parity guard now prevents re-drift) · §34.40 (the GTK INSERT bug it fixed in TS — same bug fixed in GTK here) · §34.38 (CLI create+update composition pattern reused for --color) · lockstep law (AGENTS.md parked decisions): payload-schema change → the three-way gate SHIPPED same day (m5/m15) · SCHEMA.md owed-work register (no entry needed — the normative section IS the record).

### 34.44 Class view redesign — a class page is a page (owner directive 2026-10-03 — SHIPPED same day)

Owner directive ("the class view looks super ugly compared to the page view… a normal page view with some extra, class-relevant sections, no class pills but class extends instead"), designed against Capacities (type page = database of objects; settings in panels) and Tana (supertag page = table of tagged nodes; config behind a wrench panel) and recorded at `.plans/design/05-class-view-redesign.md` (rev 2, the owner's corrections folded: class pages keep an editable block body; extends — not class pills — in the corner; class-only picker; Description dropped since title-is-content makes it a literal duplicate; "super nice" UIs for property definitions and templates; ClassPills → NodePills rename).

**What shipped (commits `8430ac73` + `7134fbaf`):**

- **PageView composition slots** — `forClass`, `rootClassName`, `corner`, `iconButton`, `headerActions`, `notice`, `sections`, `systemSections`; all default to the plain-page chrome, so page rendering is untouched. The page read accepts a class node only under `forClass` (`getPage` excludes classes by design).
- **ClassView is a thin wrapper** over PageView: same document chrome, same editable outliner body (classes are containers — the old read-only Blocks section left; the body IS the block tree), Find/Replace, tags row, kebab, empty-page affordance.
- **Corner: ExtendsRow** — the class's parents as NodePills (colored pills, × removes, "+" opens the class-only NodeSelector, self excluded); writes go through `class.setExtends` (replace semantics — the store's loud CycleError surfaces as the transient banner via the `notice` slot). No drag-sort (extends order is deterministic).
- **Header** — the curated ClassIconButton replaces the page icon picker (slot); the 10-swatch color strip became one ColorButton dot with the full picker (§34.43 grammar, none-option clears; the header swatches now ride the §34.42 palette).
- **Sections** — ClassedNodesSection (the instances: existing ViewToolbar + editable table, a column per binding; **expanded by default** — the class page's centerpiece per the Capacities/Tana lesson); PropertyDefinitionsSection (the schema editor — one line per binding: drag-grip reorder writing sequences, per-type mdi glyph, only-set chips (filter/default/precision), Required/Readonly/Hide-when-empty icon toggles, "Configure" expands the full editor (rename, read-only type, default, checkbox flags, date precision/qualified); "Add property" opens a search/create popup over existing schemas; **expanded when empty, collapsed once bound** — parity with the page's "Properties N"); TemplatesSection (assigned templates as cards — icon + name, hover × unbind, click opens; the §34.25 template-family picker unchanged).
- **System sections** — new ExtendedBySection (subclasses, transitive; badge count; a backlink-class read like Linked references) + the standard SystemSections reused verbatim (Child pages expanded by default, per the page view; Linked/Unlinked references). Empty sections hide themselves.
- **NodePills** — ClassPills renamed (three consumers now: page corner, block-row column, extends row) with a parameterizable write path (`actions` add/remove/reorder + removeLabel/addLabel/sortable/excludePickerNodeId); default behavior unchanged for the existing two sites.
- **Dropped** — the Description panel (title-is-content), the Extends/Extended-by/Templates/Property-bindings admin panels (`.nt-class-panel*` CSS retired), the color swatch strip, the read-only Blocks section. The class's generic Properties table suppresses the has-template row (the Templates section is its friendly face).

**Decisions taken (recorded per the owner rule):**

1. **Target-class filter is read-only** in the expanded editor — the wire's `propertySchema.update` carries no `targetClassFilter` (create-only field). Editing it needs a protocol addition (three-way lockstep) — out of this slice; the collapsed chip and expanded pills display it.
2. **Precision is a text chip on the collapsed row** (not a click-cycler as the proposal sketched) — the cycling select lives in the expanded editor; less chrome, no hidden write path.
3. **Classed nodes has no eager count badge** — members aren't a materialized count, and the section defaults to expanded so the badge would be redundant.
4. **Class pages keep the page view's Tags row and Properties section** (page parity); only the has-template row is suppressed (see above).
5. **`getPage` stays class-exclusive** — PageView gains a separate class-aware read under `forClass` rather than widening the `getPage` contract other callers rely on.

**Verification:** `npx tsc --noEmit` clean; full gate green — `pnpm -r --workspace-concurrency=1 build` + `pnpm test` (protocol 129, store 171 both backends, sync 13, query 153, domain 30, export 162, server 116, **web 490**, cli 64). Class-view suite rewritten for the new composition (extends picker + cycle banner, classed-nodes expanded-by-default, property-definitions editor flows, Child pages in system sections).

**Register cross-checks (no double-listing):** §34.25 T3 (the templates slot's bind/unbind UI moved into TemplatesSection — the has-template property semantics and the ONE-class-filtered-picker amendment unchanged) · §34.42/§34.43 (the class color dot consumes the new palette + grammar; the legacy-hex mapping retired with the strip) · §34.23 render-state cascade (ClassView remains the `is_class` branch; the cascade spec untouched) · §34.19/§34.34 registers (no block-content delta) · SCHEMA.md owed-work register (no entry needed — no normative change; the wire is untouched) · lockstep law (AGENTS.md parked decisions): **no new op, no wire change → no three-way gate**; GTK/Flutter class views are separate code, unaffected.

### 34.45 Properties + search correctness batch — PB2/PB3/PB4/PG4/PC1/PC2 + M2/M3/M5 (2026-10-03 — SHIPPED same day)

The two registers' store/web correctness slices executed together (both are "no wire change, unblocked" per their cost frames — §34.32 sequencing step 1's PB1–PB4/PG4/PC1/PC2 minus PG6, and §34.30 sequencing M2→M3→M5). **No new op types, no payload changes — zero protocol/lockstep gate** (applier semantics changed; GTK/Flutter keep the old derived state until they port, with no data loss — the log is untouched and a wipe+replay heals).

**PB2 — text-property carrier lifecycle** (`packages/store/src/appliers.ts`, `property-values.ts` new, `apps/web/src/core/workspace-client.ts`, `apps/web/src/ui/views/TableView.tsx`):
- `property.set` enforces one-shape-per-type fail-loud at the applier, keyed off `property_schema.type`: **text = scalar string or `{nodeId}` carrier ref**; **date/object = node reference** (legacy bare uuid normalizes to `{nodeId}`; a date-looking string is rejected — dates are nodes); **date_range = `{start,end}` of refs, either side open**. Unknown schema ids store unchecked (`property.set` has no schema FK — server-tested behavior preserved). `null` means "no value" and bypasses the check.
- `property.unset` of a node-backed text value **deletes the carrier**: trash + retention, consistent with node deletion, guarded three ways — the removed value resolves to a node ref, the target is an active non-class **child of the owner**, and **no other `property_value` row references it** (both stored shapes checked). Scalar text (citekey-style) carries no carrier; object-typed unsets never delete their target.
- **"Promote to block"** surfaces at the client level as `WorkspaceClient.promotePropertyCarrier(objectId, schemaId, idx)` — detaches the value and revives the carrier as an ordinary body child, composed from the two existing ops (`property.unset`, whose applier trashes the orphaned carrier, then `object.restore`, a safe no-op when a remaining reference kept it alive). Display state only: no move op, no tree write.
- The three coexisting text shapes converge: `{nodeId}` canonical, plain strings = scalar text (the seeded citekey/isbn/publisher family stays string-typed — server API tests pin this), legacy bare uuids read-lenient and normalize on write.

**PB3 — body-exclusion depth bug** (`apps/web/src/core/workspace-client.ts`): `getBlockTree` computed the carrier-exclusion set once per page; now computed **per subtree root** (`propertyCarrierIdsOf(id)` at every level), and an excluded carrier's subtree is pruned with it.

**PB4 — documented gap-tolerance**: normative SCHEMA.md statement — multi-value idx slots are positional LWW, `unset` never re-packs, readers must treat idx as an opaque slot key (real fix stays PG5 element identity).

**PG4 — extends-aware binding resolution** (`packages/store/src/effective.ts`): winners are (class, ancestor) candidates discovered by BFS over `class_extends` — own binding (distance 0) first, then shortest extends-path, ties by class-assignment HLC then class id; `boundBy` names the ancestor whose row supplies default + metadata. Subclass nodes inherit ancestor bindings (the citations promise: runtime `source` subclasses get `authors`/`attachments`). The `class_hierarchy` closure carries no distance, so the walk uses the edge table (register said "walk class_hierarchy" — deviation recorded; no distance column exists). With no extends edges the sort key reduces exactly to the shipped first-class-applied-wins.

**PC1 — render contract**: normative SCHEMA.md statement in "Class properties" — readonly dims editors, required = empty-highlight + lint *suggestion*, hideWhenEmpty hides valueless rows; **client-honor by design law, zero store enforcement** (no new ops, per the register). The web chrome half shipped in §34.44's PropertyDefinitionsSection.

**PC2 — typed/validated defaults**: `class.property.set` fails loud on a `defaultValue` mismatching the schema type (node-typed schemas accept only JSON null — a default link is meaningless); the effective read drops a stored default that drifted out of match (schema delete+recreate under one id) instead of deriving garbage.

**M2 — FTS ranking** (`packages/store/src/search.ts`, `store.ts`): `Store.search` keeps its signature; ordering is now relevance + recency. **Deviation from the register, verified**: its "bare `rank` works FTS4+FTS5" claim is false for the shipped sql.js wasm ("no such column: rank") — FTS5 orders by the hidden `rank` column in SQL; FTS4 fetches `matchinfo('x')` and scores hit counts in JS. Both tiebreak `updated_at` DESC then node id. **The module is a property of the database, not the backend** (the cross-backend snapshot restore parks an FTS4 index inside better-sqlite3 and the repair path keeps it — caught by the existing restore test), so it is detected from `sqlite_master` and cached per connection (WeakMap; restore swaps the connection). Title-weight column still pending per the register (DDL, rides the rebuild path, sequenced last).

**M3 — snippet helper**: `searchSnippet(db, nodeId, query, {maxTokens, ellipsis})` + `Store.getSearchSnippet` return the excerpt around the densest query-term cluster with char-accurate match spans. **Deviation, verified**: computed in JS over the derived plaintext instead of SQL `snippet()` — the stock sql.js FTS4 `snippet()` emits its column index into the output and misplaces markers (probe evidence), and `offsets()` units differ per module; one JS implementation is byte-identical on both and needs no MATCH query.

**M5 — property values in the FTS index** (`packages/store/src/content.ts`, `appliers.ts`): `extractSearchPlaintext(db, raw, nodeId?)` (additive optional param) folds text-ish property values into the row — text carrier content (one level), scalar strings (url/email), select option labels, numbers as strings; date/object refs, ranges, booleans stay structural. `property.set`/`property.unset` reindex the owner; `reindexAllSearch` rebuilds the same rows (restore-repair included).

**Verification:** store build clean (tsup + DTS); store 255 tests green on BOTH adapters (new `test/property-values.test.ts` 26 + `test/search-ranking.test.ts` 22); web typecheck `npx tsc --noEmit -p .` clean; web 529 tests green (properties-panel gained PB2/PB3/promote coverage; view-modes' text-cell test updated to the carrier contract; TableView text cells now write carriers — create-on-first-edit, update-the-carrier after); server 141 tests green (search route untouched signature-wise; citekey/isbn string writes + unknown-schema writes still pass).

**Register cross-checks (no double-listing):** §34.32 (PB2/PB3/PB4/PG4/PC1/PC2 rows ticked above; PG6 remains — its scalar/multi/target-existence checks are the next batch; PB1 remains — owner rule pending; PC8's doc-lag batch remains, one item of which — SCHEMA.md:9's metadata tick — this batch touches adjacent text but does not tick) · §34.30 (M2/M3/M5 rows ticked; M1/M4/M6–M12 untouched; B1's stale-comment row rides M4 as registered) · SCHEMA.md (extends owed item :20 ticked at the read model — the `class_extends.ord` column stays deferred per the owner decision; FTS plaintext :41 ticked with the M5 enumeration; "Class properties" gained the PG4/PC1/PC2 normative statements; "Node-backed text properties" gained the write-shape contract, the unset-carrier guards, the promote composition, and the PB4 gap-tolerance) · architecture.md §11 item 1 (PG4 headline — marked done) · §34.38 restore (`object.restore` semantics unchanged; promote composes it) · §34.25 templates (clone engine copies authored `{nodeId}` refs unchanged) · §34.34 BB-rows (untouched) · lockstep law: no new op, no wire change → no three-way gate.
