# Notees → Local-First Personal Information Environment
## Evidence-Based Feasibility Assessment & Evolution Blueprint

Date: 2026-09-24 · Status: the ongoing implementation plan (moved to `.plans/implementation-plan.md` 2026-10-02; formerly `.plans/2026-09-24-object-graph-pim-evolution/assessment.md`) · Evidence base: full-repo inspection (backend, frontend, protocol, plugins, tests, deployment, docs) on `main` @ Notees 3.0.0

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
| Keyboard map breadth: Ctrl+N new page, Ctrl+Shift+T today, Ctrl+, settings, Ctrl+\ sidebar, Ctrl+Alt+P add property, Ctrl+F find (`keyboardStore`) | 🟡 | Only palette/quick-add/find exist |
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
| TasksPopup: Overdue/Today/Upcoming/Unscheduled/Completed sections, recurrence picker, completion history | 🟡 | **Tasks hub shipped 2026-10-02** (`App.tsx:1418-1445` — `/tasks` CollectionHub over task-class members, pages AND blocks, table default with task property columns + kanban by status); owed: bucketed Overdue/Today/Upcoming/Unscheduled/Completed view, recurrence picker (engine absent → §34.28 #6), completion history; fresh workspaces silently drop Scheduled/Deadline columns (bug → §34.28 #2) |
| Daily-page sections: Scheduled/Overdue tasks on day pages | ❌ | §34.28 #4(b) — no model work needed (day-node backlink set + date query arms already exist) |
| TrashView (restore/permanent delete/empty trash/batch) + ArchivedPagesView | ❌ | Store has trash; no UI |
| Templates: `{{variables}}`, TemplateGallery, slash instantiate, TemplateVariableDialog | ❌ | Template class exists; no machinery — design brief **§34.25** (2026-10-02, Capacities comparison); implementation pending (T1–T6 there) |
| PresentationModal (children as slides) | ❌ | Design brief **§34.26** (Capacities comparison, 2026-10-02; PENDING behind §34.23) — v1 source `frontend/src/features/content/components/PresentationModal.tsx` @ `v1-archive` |

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
| API keys with scopes (Read/Write/Admin checkboxes) | 🟡 | Name-only keys |
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
2. **Prose view** = v2's existing `nt-prose` display transform (editable, flattened chrome) — NOT a v1 `DocumentView` clone.
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
- [ ] **M5b one-time migration script** — `scripts/migrate-node-type.mts` (template: `migrate-title-is-content.mts`): `--dry-run` occurrence report, then in-place relay-log rewrite (object.create/update `nodeType`→`presentAsMain`; class-valued occurrences → `class.create` envelopes; `protocol_version` 2→3 all rows; query-token AST `nodeType` conditions/sorts/aggregations remapped), stale snapshots deleted, server-side derived stores rebuilt from the migrated log, `restore_epoch` bumped; backup before run. Run happens at deploy time (stack stopped).
- [x] **M6 web** — render cascade (`App.tsx NodeView`); body = `present_as_main=0` + carrier exclusion; Child pages section → main-children (`present_as_main=1`); ClassView body + main-children (R1 for class parents; rule-1 code deleted); "Move to Pages / Move to content" intents + zone-aware drops (`block-dnd.ts`); query-builder conditions; labels/pickers/type chips; containing-node walk.
- [x] **M7 gate** — full monorepo green + web build.
- [x] **M8 GTK lockstep** — payloads/store/appliers/migration v7/UI cascade/fixtures re-port per the sweep checklist (no legacy-replay anything — strict rejection like the reference); tag **`v2.0.0-m3`** (CI publishes wheel/sdist/archpkg).
- [x] **M9 Flutter lockstep** — payloads/appliers/model/repository/migration v20/UI split per the sweep checklist (strict rejection like the reference); tag **`v2.0.0-m9`** (CI signs + publishes APK). Note: `lib/data/models/user.dart` dirty with unrelated auth WIP — leave uncommitted; do not tag over it without owner ok. *(Hold lifted 2026-10-02 — in progress.)*
- [x] **M10 docs+release+deploy** — SCHEMA.md normative rewrite + extends-ord owed entry; AGENTS.md (lead, invariants, lockstep row); this section's shipped state; query README; dev docs; user docs keep "pages/blocks" as render-state vocabulary; monorepo tag `v2.0.0-m3`; rebuild images; run the M5b migration against the stopped stack; `docker compose up -d`; `verify-min.mjs` → VERIFY-PASS.

**Explicit non-goals (this pass):** extends `ord`; extended mentions (`extra_content`); delete/orphan-to-inbox; `node_references` table (mentions stay content tokens); un-flatten on demotion; **backward compatibility of any kind** — no legacy payload keys, no replay-compat applier code, no vestigial columns; the stored log is rewritten once by M5b and everything re-syncs from it (owner directive, sole user).

**Flutter m9–m10 (2026-10-02).** m9: journal calendar Today shortcut + Sunday-label fix (the picker pre-existed), Home SafeArea/header inset fix, and the sonarly-style screenshot harness (`integration_test/screenshots_test.dart` driving the real app on a serverless sync engine with seeded nodes + `scripts/screenshots/run.sh`; runs headless via `flutter-tester`, PNGs on a real device/emulator). m10: **the grey box root cause** — `_buildRow`'s DragTarget builder captured the `content` local *by reference*; by build time it pointed at the DragTarget itself → infinitely deep widget tree → stack overflow → ErrorWidget across the whole block body (data-independent, that's why every content page was grey). Fixed with a pre-wrap final capture + up-front token parsing with an inline placeholder + cycle guards + unknown-token degradation. Also: Library became the browse hub (All pages/classes/journals, Archive, Trash) so Home vs Library no longer duplicate (owner confusion); device-local recents record on open (server order was `write_date DESC` — reads never surfaced) merged ahead of the server list; effective icon in the editor header + child-pages rows. 406 tests green; harness asserts the editor body actually renders.

### 34.24 Capacities-style export redesign — work record (owner directive 2026-10-02, PENDING — scheduled behind §34.23)

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
- [ ] **E1 IR + options model** — `ExportDocument` IR in `packages/export`; options bag threaded through `nodeToMarkdown`/`bundleMarkdown`; per-format serializer skeletons behind a format registry in the package (web registry delegates to it).
- [ ] **E2 Markdown hardening** — markdown metacharacter escaping (closes SCHEMA.md deferral); full-closure default (no depth cap / no silent truncation — make the cap an explicit option); position-aware child order via new `GET /objects/:id/children` endpoint (server route + client seam; closes the second deferral); options: hideEmptyProperties / showTypeLabels / includeEmbedded; whiteboard sidecar files when bundling (closes the third deferral — sidecars in zips, inline ```json only for single-file).
- [ ] **E3 Web registry + modal rebuild** — extend `ExportFormatDefinition` (`availability`, options schema); rebuild `ExportPageModal` per modelling decision 3; wire or delete `ExportPageTrigger.tsx`; fix batch → zip. Tests: modal specs in `apps/web/test/` (registry-driven options, batch zip, disabled formats).
- [ ] **E4 Store roots query** — `packages/store` roots read (`parent_id IS NULL` page/class filter) + worker/client seam; replace hand-rolled client filters (`Sidebar.tsx`, `App.tsx`).
- [ ] **E5 Server workspace zip** — `GET /api/workspaces/:id/export.zip` (replaces `GET /export`, route deleted): `fflate` streaming, roots + descendant pages, human-readable filenames, manifest, properties wired, relative link rewriting, `?includeAssets=1` CAS folder. Tests: route spec with fixture workspace (small synthetic store), zip round-trip parse asserting file set + manifest + relative links.
- [ ] **E6 Workspace export UI** — `WorkspacesView` export entry → small modal (include-assets toggle + format note) → download; progressive status for large workspaces (spinner/state, not blocking UI).
- [ ] **E7 Node-level include-assets zip** — client subtree asset scan + concurrency-limited fetch + zip + relative ref rewrite (modal option).
- [ ] **E8 Phase-1 docs + gate** — usage/ux export sections rewritten (modal, options, workspace zip); SCHEMA.md export spec updated (options, escaping DONE, ordering DONE, sidecars DONE, zip layout, manifest shape); AGENTS.md lead; `.plans/dev/architecture.md` export paragraph; this section's shipped state.
- [ ] **H1 HTML serializer** — `ExportDocument` → standalone styled HTML (token-only CSS, print-friendly); docx intermediate.
- [ ] **P1 PDF direct download** — `@react-pdf/renderer` + OFL font bundle; Notes/Essay/Academic themes; A4/Letter; embed images as data URLs; `downloadBlob` `.pdf`; modal layout cards + preview. Watch bundle size (code-split the pdf engine — dynamic import on first PDF export).
- [ ] **P2 Phase-2 docs + gate** — docs/ux PDF section; SCHEMA.md format table; shipped state.
- [ ] **D1 Word `.docx`** — `docx` lib serializer over the IR (H1 HTML as reference rendering); modal card; tests.
- [ ] **L1 LaTeX** — escaping-correct template serializer; article/two-column class variants mirroring layouts; source-class nodes reuse `nodeToCsl`→BibTeX emission (`\bibliography` block); tests with golden fixtures.
- [ ] **P3 Phase-3 docs + gate** — docs + SCHEMA.md + shipped state. (LaTeX/Word layout parity note: layouts apply as template variants, not CSS.)

**Parked register (recorded, not this work):** CSV view export; selection-scoped export; scheduled/automated export (server cron → `./config/notees/`); batch asset endpoint (only if client N+1 proves slow); workspace **PDF** bundle (zip is markdown+assets only — PDF stays a per-node format); JSON archive Tier-1 backup export (§34.12, separate track); re-import round-trip harness for the new zip layout (§34.12 exit criterion still owed — pairs naturally with E5 when built).

**Explicit non-goals:** legacy `.doc`; server-side PDF rendering; exporting classes/tags as standalone files; block-roots in workspace export; any protocol/wire change or client lockstep; parity with Capacities' automated-export scheduling (parked, not refused).

### 34.25 Templates — design brief & work record (Capacities comparison, 2026-10-02, PENDING — scheduled behind §34.23, after §34.24)

Comparison of Capacities' template system ([reference docs](https://docs.capacities.io/reference/templates), verified 2026-10-02) against Notees, and the implementation handoff. This section is the source of truth for templates: it supersedes the one-line proposals in `01-knowledge-model.md` §6, `02-model-assessment.md` §5/§9, and the `00-INDEX` deferred item 3 (all updated to point here), and collapses the SCHEMA.md:25 owed-work open question ("`has-template` placement") into concrete decision points **D1-D4** (owner to confirm before code).

**Capacities model (the reference):** a template = prefilled properties + blocks bound to exactly one object type (daily notes, pages, custom types), edited as a blank canvas with the full block editor; applied four ways — bottom-of-empty-object picker, `+ New`, `Cmd/Ctrl+U` + name, `/name` slash in a page (create + apply in one shot); referenced objects (tags, select values, links) are **linked, never duplicated**; `{date:...}` variables in titles substitute at apply time.

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
- **D1 — relation direction & cardinality.** Recommendation: `has-template` lives on the **class** node (Capacities' "templates belong to one object type"), `multi: true` — Capacities allows N templates per type and the wire already supports it.
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
- [ ] **P1 `PresentationOverlay` kit primitive** — new `apps/web/src/ui/components/ui/` component + `index.ts` barrel export: fullscreen host, auto-hiding bottom toolbar (prev / slide counter / next / exit), screen-edge click zones, Esc, focus trap; token-only CSS. Sized for two consumers (deck now; whiteboard fullscreen later, `docs/ux.md:104`). Tests: render + auto-hide + focus-trap specs.
- [ ] **P2 deck builder** — pure module (`page subtree → slide list`): title slide from the node's own content; one section slide per top-level child (post-M6: per `present_as_main=1` main-child; pre-migration fallback = top-level children — the §34.23 gate); intro-slide chunking of body children by density. No marker, per D1. Unit tests over synthetic trees: empty page, flat children, deep nesting, text-only page, intro + sections mixed.
- [ ] **P3 DeckView slide renderer** — one slide = a read-only render of its slice: reuse the embed read-only projection + `nt-prose` transform + `InlineTokens`; token renderers (whiteboard/query/asset/embed) render as in PageView. Two slide chrome kinds: centered section-title slide (title + no body) and left-aligned body slide at reading width.
- [ ] **P4 layout heuristics** — title slide (derived content title + node icon/color); trailing-image side-pull (last body block an `asset_ref`/asset image → text-left/image-right; image alone → centered full-size, the Capacities rule); density-based text sizing (short slides large, dense slides normal, overflow guard). Token-only CSS.
- [ ] **P5 embed expansion** — in deck context, an `embed_ref`'s target's children splice into the slide stream after the referencing slide (Capacities' "embedded pages expand into the deck"); renderer-context change only — the embed rule "live subtree, never a clone" (SCHEMA.md:62) and its cycle guard are untouched.
- [ ] **P6 input layer + entry points** — a presentation keymap context owned by the overlay (→/↓/space/PageDown next; ←/↑/PageUp prev; Esc exit; edge clicks hit the zones from P1), active only while presenting; entry points: page-menu "Present" item (node context menu / page chrome) + shortcut (Capacities-compatible Ctrl+Alt+P Windows / Ctrl+Cmd+P Mac); toolbar counter from P1.
- [ ] **P7 resume state** — last slide index per object, session-local (D3), same slot pattern as collapse; nothing persisted, nothing on the wire.
- [ ] **P8 parity row + docs + gate** — §34.19:1149 ❌→✅ with the shipped-state note; `docs/ux.md` presentation section (heuristic, gestures, what renders, read-only-live contract); `docs/usage.md` paragraph; `.plans/dev/architecture.md` view-layer paragraph; this section's shipped state; `pnpm -r build` + `pnpm test` green; `scripts/screenshots/verify-min.mjs` smoke.

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
- **@-picker NL date insert** — `parseDate` on the picker query; `@feb 14` offers "Go to/Create daily page" and ensure-chains + picks in one gesture (`NodeSelector.tsx:300-334`); the §34.19 SuggestionPopup row is updated above.
- **`dateQualified` link qualifiers fully wired in web** — ClassView bindings checkbox (`ClassView.tsx:433-447`); per-chip start/end range control persisting as `metadata.startDate`/`endDate` (`MetadataSection.tsx:212-213,337-349,690-694`).
- **`markedDates` in the date picker** — has-note day marks collected from existing day pages (`collectMarkedDates`, `MetadataSection.tsx:118-133`, wired at `:446,:534,:577,:683`).
- **Store backfill** — `property_schema.date_precision`/`date_qualified` v3→v4 migration (`packages/store/src/schema.ts:466-477`).
- **Flutter Home Today card + Journal tab** — m8, already recorded §34.22 `:1298` (not re-claimed here); the mobile parity gaps are #18 below.

**Verified bugs (pending):**

| # | Bug | Evidence | Fix direction |
|---|---|---|---|
| 1 | UTC "today" when defaulting a new date property | `MetadataSection.tsx:1074` defaults via `new Date().toISOString().slice(0, 10)` (UTC); every other today-path uses local midnight (`todayIsoLocal` `JournalsView.tsx:29-35`, `todayIsoDate` `QuickAddModal.tsx:30-34`) | Extract the shared local-midnight helper into one module and use it at `:1074` — wrong day near midnight |
| 2 | Task property schemas never authored in v2 | Reserved UUIDs `taskStatus`/`taskDeadline`/`taskScheduled`/`taskPriority`/`taskClosedDate`/`taskRecurrence` (`seeds.ts:138-143`) exist as constants + v1-migration mappings only (`scripts/migrate-v1/migrate.py:154-156`); nothing in v2 creates them, so a fresh workspace's tasks hub silently drops the Scheduled/Deadline columns (`App.tsx:1328-1350` filters missing schemas) and shows Name+Created only | Seed the task family alongside the system classes, or author the six schemas idempotently on first tasks-hub open; interacts with #20 |
| 3 | Dead `DatePicker.tsx`; two calendar component families | `apps/web/src/ui/DatePicker.tsx` (272 lines) has zero imports — superseded by `pickers/DatePickerPopup.tsx` + `pickers/CalendarPopup.tsx`; the top-bar `components/ui/CalendarPopup.tsx` is a second, parallel family | Delete `ui/DatePicker.tsx` (or fold anything still unique into the pickers family) and consolidate the two calendar families |

**Missing features (pending)** — read-model/UI-only unless marked:

| # | Item | Evidence | Approach |
|---|---|---|---|
| 4 | Day-page aggregations — no day-class branch in PageView | (a) "Dated this day": the day node's EXISTING backlink set — date refs already fan out to the day node in the edge index (`edges.ts:96-130`), so this is a backlinks render, zero model work; (b) Scheduled/Overdue task section (named in §34.19 `:1146`); (c) "Created today": a `createdAt` range query only — the date-aware arms exist (`compiler.ts:480-606`), no model work | One day-branch in PageView composing the three as named system-query sections (SCHEMA.md system-sections contract: collapsed by default, no eager queries) |
| 5 | Bucketed tasks surface | Zero bucket logic anywhere in `apps/web` (grep-verified: no Overdue/Upcoming/Unscheduled) | Overdue/Today/Upcoming/Unscheduled/Completed computed from `taskScheduled`/`taskDeadline` + closed state; a hub section or view mode over the existing tasks-hub members |
| 6 | Recurrence engine | Fully absent — only the UUID constant (`seeds.ts:143`); v1 migrated it as a plain select (`migrate.py:154-156`); nothing executes it | Spec decision first: materialized next occurrence (op) vs compute-on-read; then engine + picker (§34.19 TasksPopup row) |
| 7 | Prev/next day navigation | Zero `prevDay`/`nextDay` hits; no date bar on day pages or the journal feed; the top-bar calendar popup is the only day-to-day path | Date bar on day pages + journal header — ±1 day over the deterministic day-node id (ensure-chain is idempotent) |
| 8 | Open-today keyboard shortcut | None exists; §34.19 `:1131` 🟡 is accurate (Ctrl+Shift+T is free in the keydown map) | Keymap entry → local-midnight today + ensureDateChain + open |
| 9 | Slash `date` command | Only 5 slash commands exist (`TriggerPopup.tsx:33-39` — text/quote/checkbox/hard_break/url) | The @-picker already covers NL date insert (shipped above), so this is discoverability/parity: `/date` surfacing the same suggestion; pairs with the pending `daily:` suggestion prefix (§34.19 `:1134`) |
| 10 | Class quick-create from calendar | A calendar pick only ensures the chain + opens the day page (`App.tsx:1202-1205`); no way to create e.g. a meeting-classed page with its date property pre-set to the picked day | Capacities-style quick-add on the calendar: pick class → create object + set its date property to the picked day; a `{date}` template placeholder rides §34.25 T4 variables |
| 11 | Calendar breadth | Month-grid drill-down only; no week strip/agenda/objects-under-days; `hasNote` is day-node-existence-only (`App.tsx:1201`) so date-RANGED objects are invisible; `date_range` renders in the property panel only (`MetadataSection.tsx:553+`) — no calendar span, no day-page range list | Extend calendar marks to range overlap (the fan-out already projects range ends; a date query answers "objects overlapping this day"); week strip + agenda under the month grid |
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

**Register cross-checks (no double-listing):** §34.19 `:1131` keyboard map 🟡 (#8 stays accurate) · `:1133` slash commands 🟡 (#9 detail here) · `:1138` page footer ❌ → §34.27 L4 (#14) · `:1142` command palette 🟡 (#12 detail here) · `:1143` view modes 🟡 (#16) · `:1144`/`:1146` journals rows (#4) · `:1179` MobileLayout 🟡 (#18 web side) · §34.21 future register (#16) · §34.22 m8 paragraph (#18 mobile side) · §34.25 D4 daily-note templates (parked — pairs with #10 when picked up).

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
| 3 | Stale CLI surface docs | docs/usage.md documents top-level `notees search` / `notees backlinks`; the code nests them as `notees object search` / `notees class backlinks` (`apps/cli/src/cli.ts:824-925`) | Fix usage.md to the nested commands — owner rule: docs are part of the change |

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
| M2 | FTS relevance ranking | `store.ts:341-354` — `ORDER BY d.node_id LIMIT ?`, no rank, no recency, no title preference; Capacities' exact > related > recency is exactly what this forecloses | `ORDER BY rank` (hidden column, works FTS4+FTS5) + recency tiebreak from node timestamps; optional title column weight (title-is-content: a first-block column — DDL change, must ride the cross-backend rebuild path `search.ts:60-122`) |
| M3 | Snippet/highlight extraction | `SearchHit = { nodeId }` only (`store.ts:60-62`); callers rehydrate whole nodes — no match context for any results UI; `snippet()`/`offsets()` exist on FTS4+FTS5 | Snippet helper in `packages/store` returning excerpt + match spans; consumed by M1/M4 |
| M4 | Palette content group | Palette items are pages+classes+actions only (`CommandPalette.tsx:117-141`); FTS is never called from the palette; blocks unreachable, no snippets — headline stays §34.29 #10 | Debounced `client.search` alongside the fuzzy pass; "Content" group after title matches with M3 snippets; block hits labeled by containing page (M8) |
| M5 | Property values in the FTS index | `extractSearchPlaintext` indexes content plaintext + asset names + quote children ONLY (`content.ts:25-53`); Capacities searches property *values* (names excluded); QueryAST property conditions exist but are exact structured filters, not search | Append effective text-ish property values in `extractSearchPlaintext`; derived index — `reindexAllSearch` rebuilds, zero protocol impact |
| M6 | Palette sections & actions breadth | §34.19 `:1142` names: Recently Accessed/Created, Random, Commands, Date Pages, Blocks, Properties sections; filter prefixes (`class:` `uuid:` `is_page:` `is_daily:`); "+ Add page"; quick-add ⌘↵. Today: 3 hardcoded actions (New page / Toggle theme / Sign out) | Section registry + action contribution point; recents section reads the existing device-local record (`App.tsx:428-433`) — no sync, honoring the §34.29 #8 device-state ruling; typed creation `/class/title` (Capacities `@/person/Ada` pattern); paste-to-import. Date affordances stay §34.28 #12 |
| M7 | Linking-search create flow + type refine | `@`-mention candidates = pages+classes+FTS union filtered client-side by display-name substring (`outliner-context.ts:194-208`); no create fallback, no type prefilter | Reroute candidates through M2-ranked search; add the create row + class refine (NodeSelector already has page/class modes + class filters, `NodeSelector.tsx:341-374`) |
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
| PB2 | **Text-carrier orphans + three coexisting value shapes.** `property.unset` of a node-backed text leaves the carrier block alive; once the ref is gone the carrier is an ordinary child again and silently re-appears in the body (spec says trash it, SCHEMA.md:134). Separately, `text` values exist as `{"nodeId": carrier}` (panel), plain strings (`TableView.tsx:175-189` `commitCellValue`), and legacy bare uuids (tolerated at `MetadataSection.tsx:1420-1442`) | `MetadataSection.tsx:236-238` (unlink = unset only), `:1063-1071` | Implement unset-deletes-carrier (trash + retention) + the "promote to block" reparent gesture (both specced, SCHEMA.md:134); normalize the value shape at the write path (rides PG6 validation); one-shape-per-type invariant |
| PB3 | **Body-exclusion rule (projection rule 2) has a depth bug** — the carrier-exclusion set is computed once for the root page and applied at every depth, so nested blocks' own property carriers are not excluded from their bodies | `apps/web/src/core/workspace-client.ts:1000-1034` | Compute the exclusion set per subtree root (per rendered node), not once per page |
| PB4 | **Multi-value idx gaps never heal** — `property.unset` deletes the row but never reindexes; the panel appends at `max(existing idx)+1`, so gaps persist permanently and qualifiers stay keyed to stale positions | `appliers.ts:1177-1210`, `MetadataSection.tsx:221` | Real fix = PG5 (element identity). Until then: documented gap-tolerance in readers (already true — reads don't assume density) |

**Missing features (pending):**

| # | Item | Evidence | Approach |
|---|---|---|---|
| PG1 | **Schema-at-capture / create-and-bind** (the M2 make-or-break gesture; SCHEMA.md:23 headline, §34.10 `:1010`) | The only creation surface is `AddPropertyRow` — hardcoded `type: "text"`, binds to no class, initializes an authored value (`MetadataSection.tsx:1041-1109`); typed-link verbs are free-string only — bound-schema verbs render but can't be authored (`apps/web/src/ui/VerbPopover.tsx:2-18`) | Tana-grade flow: type choice + class binding at creation, verb-schema create-and-bind at capture, PropertyCreateModal (§34.19 `:1151`). Design-heavy; schedule as its own pass after the correctness batch |
| PG2 | **Property-schema CRUD surface** | No delete UI — zero `propertySchema.delete` call sites in `apps/web`; no creation UI for `type`/`multi`/`scope`/`targetClassFilter`; both immutable post-creation in wire and UI (`op-types.ts:250-260`) | PropertyCreateModal + settings additions; decide type immutability (PG3) before building the type grid |
| PG3 | **No property-type conversion** (Capacities: change-with-conversion, original kept for review) | Delete+recreate reactivates the same UUID via upsert (`appliers.ts:1047-1051, 1097-1105`) while wrong-shape authored values survive | Owner decision (below): conversion machinery vs blessed delete+recreate with orphan cleanup |
| PG4 | **`extends`-aware binding resolution** — the diamond rule (own → shortest extends-path → earliest HLC, SCHEMA.md:17) is unimplemented: only DIRECT memberships are consulted | `effective.ts:142-145` (no `extends`/`closure` reference in the file); architecture.md §11 item 1 carries the headline | Walk `class_hierarchy` (the closure table already exists) at read time with the designed ordering; pure read-model work — unblocks the citations promise that runtime `source` subclasses inherit `authors`/`attachments` (SCHEMA.md:141) |
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
| PC1 | **`readonly`/`required` contract undefined beyond chrome** — `readonly` only disables the boolean editor; every other editor ignores it; `required` does nothing (no lint, no indicator) | `MetadataSection.tsx:866-874` | Define the render-level convention (readonly dims editors; required = empty-state highlight + lint suggestion — enforcement is client-honor by design law) and apply it uniformly; SCHEMA.md statement owed |
| PC2 | **`defaultValue` is untyped and unvalidated** — `z.unknown()` on the wire, raw-text editor, malformed defaults derive silently; node-typed defaults are arguably meaningless | `op-types.ts:202`, `ClassView.tsx:363-378` | Type the default per schema type in the editor; validate at read in `effective.ts` (a wrong-typed default yields no default) |
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
