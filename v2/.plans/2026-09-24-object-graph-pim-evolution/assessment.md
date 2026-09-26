# Notees → Local-First Personal Information Environment
## Evidence-Based Feasibility Assessment & Evolution Blueprint

Date: 2026-09-24 · Status: assessment complete, implementation not started · Evidence base: full-repo inspection (backend, frontend, protocol, plugins, tests, deployment, docs) on `main` @ Notees 3.0.0

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

**Sweep outcome:** no model-level retreat is required to reach parity-or-better on any axis. The gap register from this sweep (property CRUD UX, create-and-bind, formula-language decision, template instantiation, zoom, embeds) is recorded in `SCHEMA.md` owed work and §34.10 — the sweep's purpose was to ensure nothing a competitor ships is silently absent from our schedule.

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

**Repo structure (assessed 2026-09-26; owner to confirm):** one repo for all of v2 — server, web client, CLI, and shared packages stay in the `notees` monorepo (workspace deps keep the single-implementation tax eliminated; the fixture gate runs across all consumers in one CI; deployment independence is unaffected since the web build is static). Flutter/GTK remain separate repos (different toolchains, zero shared code, wire-protocol boundary). A split is reconsidered only if a published SDK becomes necessary (M3 plugins, third-party clients).

### 34.16 Owner requests (2026-09-26): ORM shell, Python SDK option, recursive Markdown export

**1. `notees shell` — the Odoo-shell equivalent (accepted, M1-cheap).** The v1 backend was Python partly for REPL ergonomics; the v2 answer is a **Node REPL with the real packages preloaded** (`node:repl` + an open `@notees/store` + the query/search surface + domain helpers): interactive `store.query/search/backlinks` over live workspace state, arbitrary logic, identical semantics to the app because it *links the same code* — no bridge, no duplicated query semantics. Ship as `notees shell` in the CLI (loads config, opens the server's data dir read-only or via the API).

**2. Python SDK — registered option, NOT an in-process bridge (assessed).** A Python *client library* over the public HTTP API is feasible and serves the Jupyter/pandas-over-your-graph research workflow — but it is an **M2+ option, kept deliberately thin and untyped** (dict-level API, no mirrored pydantic schema) to avoid a third schema definition to keep in sync. Rejected: an in-process Python bridge into the server (would reintroduce a dual-implementation tax the rewrite exists to eliminate). Decision point: after M2, if notebook workflows materialize.

**3. Query-driven recursive Markdown export (accepted, M2).** `notees export markdown --linked-to <id> [--depth N|fixpoint] --output-dir Y` (+ query selectors): start set = pages matching the selector (edge-index closure, e.g. everything linking to X), export each via the shared Markdown renderer (**one implementation** — `packages/export`, the owed serialization package, reused by CLI export, workspace snapshots, and the future server endpoint), recurse through links/embeds/child-pages with a **visited-set cycle guard** and depth default, writing `<uuid>.md` (rename-free, §34.12) plus the UUID manifest into Y. Canned closure patterns live in the CLI; arbitrary logic lives in the shell (§34.16.1) — that division keeps the CLI surface small.
