# Notees Migration Gap Analysis: Current App vs. Ideal Architecture

**Date:** 2026-07-17
**Scope:** Read-only gap analysis for migrating the real Notees app (`app/`, `frontend/`, `tests/`, PostgreSQL) to the ideal architecture spec (`docs/superpowers/specs/2026-07-17-notees-ideal-data-architecture-design.md`).

---

## 1. Executive Summary

The current Notees app already contains partial building blocks of the ideal architecture (frontend `OperationRuntime`, v2 sync outbox, version vectors, Yjs CRDT text state), but the **backend remains server-centric PostgreSQL with mutable rows**. A full migration is effectively a rewrite of the data layer, sync protocol, and query engine.

---

## 2. Data Model Differences

### 2.1 Identifiers

| Current | Ideal | Gap |
|---|---|---|
| Internal `SERIAL` integer primary keys (`node.id`, `property.id`, etc.) with separate `uuid` columns for public use. `app/db/schema/sql.py:22-207` | **UUIDv7 everywhere**; no integer IDs. Spec §12 | All backend code, foreign keys, indexes, and APIs must switch from int IDs to UUIDv7 as the sole identifier. |
| Example: `node.id SERIAL PRIMARY KEY`, `node.uuid UUID` `app/db/schema/sql.py:157-159` | `node.id UUID PRIMARY KEY` | Massive refactor of repositories and services. |

### 2.2 Node Table

| Current | Ideal | Gap |
|---|---|---|
| Polymorphic `node` table with **boolean flags** for every kind: `is_page`, `is_class`, `is_task`, `is_day`, `is_month`, `is_year`, `is_asset`, `is_table`, `is_card`, `is_cloze`, etc. `app/db/schema/sql.py:174-185`; `app/domain/entities/node.py:78-91` | Only three `kind` values: `page`, `block`, `class`. Everything else is a user-defined or built-in class. Spec §3.1, §11.2 | Remove all boolean flags; migrate semantics to `class_ids`. |
| `node.name` is overloaded: pages store title AST, blocks store content AST. `app/domain/entities/node.py:61`; `app/domain/entities/content.py:20` | `node.content` is a uniform inline AST for all nodes. Spec §3.1 | Separate title vs. content concepts; rename/normalize storage. |
| `node.parent_id` + `node.page_id` adjacency list with `sequence DOUBLE PRECISION`. `app/db/schema/sql.py:164-166` | `node.parent_id` + separate `node_child_order` with CRDT sequence positions. Spec §4.1 | Replace fractional sequence ordering with CRDT sequence positions. |
| Soft-delete via `is_deleted`/`deleted_at` flags. `app/db/schema/sql.py:171-172` | Tombstone operations in immutable log; derived tables may purge after retention. Spec §5.2, §10.7 | Move delete semantics from row flags to operation log. |

### 2.3 Properties

| Current | Ideal | Gap |
|---|---|---|
| **EAV-style** schema: `property` definitions, `node_property` assignments, plus `property_value_scalar`, `property_value_relation`, `property_value_selection`. `app/db/schema/sql.py:429-579`; `app/domain/entities/property.py:81-384` | Single `property_value` table keyed by `(node_id, property_schema_id, index)`. Spec §3.4, §4.1 | Collapse three value tables into one JSONB value table. |
| Property types include `text`, `image`, `date`, `node`, `selection`, `integer`, `float`, `boolean`, `url`, `email`, `date_range`. `app/domain/entities/property.py:35-54` | Types: `text`, `number`, `date`, `select`, `multi_select`, `node`, `checkbox`, `file`. Spec §3.3 | Renumber/replace types; `file` replaces dedicated asset subsystem. |
| Property scoping: `GLOBAL`, `CLASS`, `NODE`. `app/domain/entities/property.py:56-69` | Property schemas are workspace-scoped but not nodes; classes reference schema IDs. Spec §3.3 | Keep schema table but decouple from node-scope concepts. |
| Computed properties are not a first-class concept. | `property_schema.computed` with `formula`/`rollup`/`query`. Spec §3.3, §10.3 | Add computed-property engine with dependency tracking. |

### 2.4 Links / References

| Current | Ideal | Gap |
|---|---|---|
| `node_link` materialized table for `[[Page]]` / `((block-uuid))` / inline-class / embed references, plus `node_mention` for unlinked mentions. `app/db/schema/sql.py:623-745`; `app/domain/entities/link.py:29-115` | All references are **ID-based** with separate labels; derived `edge` table. Spec §3.5, §4.1 | Replace name-based wiki links with UUID-based refs; rebuild backlink derivation from AST/edges instead of `node_link`. |
| Inline link AST uses `node_link` nodes with `link_id`. `app/features/sync/service_v2.py:256-257` | `Reference { targetId, label }`. Spec §3.5 | AST schema migration for every existing link. |

### 2.5 Assets / Files

| Current | Ideal | Gap |
|---|---|---|
| Dedicated `asset` table + `node.is_asset` flag + `node.asset_id`. `app/db/schema/sql.py:253-264`; `app/domain/entities/node.py:83-84` | No separate asset subsystem; files are nodes of a class with a `file` property. Spec §9.7, §13.5 | Remove `asset` table and `is_asset` flag; migrate files to property-backed nodes. |
| Content-addressed by `(workspace_id, hash)`. `app/db/schema/sql.py:257-263` | Content-addressed blobs on disk by hash. Spec §9.7 | Storage layout change; GC policy change. |

### 2.6 Views / Queries

| Current | Ideal | Gap |
|---|---|---|
| `node_view` table stores QueryAST JSON and view config. `app/db/schema/sql.py:754-783` | Views are first-class nodes or blocks; QueryAST compiles to SQLite. Spec §11.3 | Migrate `node_view` rows into node content; retarget compiler. |
| QueryAST compiles to **PostgreSQL SQL** at runtime. `app/domain/services/query_ast_sql.py` | QueryAST compiles to **SQLite SQL** against derived tables. Spec §9.1 | Rewrite SQL compiler backend. |

---

## 3. Backend Architecture Differences

### 3.1 Hexagonal Ports / Adapters

The current backend has feature modules with ports, but **domain services directly mutate PostgreSQL rows** and the sync service applies operations by calling `NodeService`/`PropertyService`:

- `app/features/sync/service_v2.py:27-498` — applies client ops to mutable `node` rows.
- `app/features/nodes/node_service.py:129-2959` — orchestrates creates/updates/deletes against PostgreSQL.
- `app/features/properties/service.py` — EAV property mutations.

The ideal server is a **thin encrypted operation relay** that does not decrypt payloads or derive state. Spec §6.1, §6.2.

### 3.2 Source of Truth

| Current | Ideal |
|---|---|
| PostgreSQL `node`/`property_*`/`node_link` rows are authoritative. | Immutable `operation` log is authoritative; `node`/`property_value`/`edge` are derived. Spec §4.1, §5 |
| Server applies mutations, increments `node.version`, captures `node_version` snapshots, and maintains `undo_log`. `app/db/schema/sql.py:885-930`, `add_undo_log.sql` | Server only validates permissions and persists encrypted operations; history/undo are free from the log. Spec §5.5 |

### 3.3 Sync / Collaboration Tables

| Current | Ideal |
|---|---|
| `node_revision` per-node per-client version vectors. `app/db/schema/sql.py:903-909` | HLC-based operation log + compaction segments. Spec §5.3, §5.5 |
| `node_yjs_state` per-node CRDT update blobs. `app/db/schema/sql.py:269-274` | CRDT state is derived locally from operations; server does not store CRDT state. Spec §5.2 |
| `undo_log` with before/after JSONB states. `add_undo_log.sql` | Undo = inverse operation appended to log. Spec §5 |
| WebSocket `/ws/live/{workspace_uuid}` for presence and op broadcast. `app/features/collab/live_sync_ws.py:241-423` | WebSocket still used, but server forwards encrypted operation envelopes. Spec §6.1 |

### 3.4 Current Sync Protocol

- `POST /api/sync/batch` accepts `OperationIntent` payloads and applies them as row mutations. `app/features/sync/service_v2.py:48-109`
- Conflicts return **409** with `stale_nodes` and `server_vectors`. `app/domain/entities/sync_v2.py:100-116`
- This is **optimistic locking with version vectors**, not CRDT merge.

The ideal spec uses **operation-based CRDTs** (Yjs/YATA/RGA for sequences, LWW registers, OR-Sets) so concurrent edits converge without 409s. Spec §5.2.

---

## 4. Frontend State / Query Differences

### 4.1 Authoritative State

| Current | Ideal |
|---|---|
| **TanStack Query cache** is authoritative; server responses populate `useQuery` hooks. `frontend/src/features/content/hooks/useNodeBasicQueries.ts:14-184` | **SQLite** is the primary runtime store; operation log replays into derived tables. Spec §4.1, §7 |
| `OperationRuntime` holds base server state + pending local ops and computes a projected graph. `frontend/src/runtime/OperationRuntime.ts:24-283` | `OperationRuntime` pattern aligns, but base state should come from local SQLite, not TanStack Query. |

### 4.2 Local Persistence

| Current | Ideal |
|---|---|
| IndexedDB-based `localNodeStore` mirrors server nodes for offline fallback. `frontend/src/features/sync/local/localNodeStore.ts:1-131` | SQLite per workspace is the primary store, not a fallback. Spec §4.1 |
| `MiniSearch` index persisted to IndexedDB for offline search. `frontend/src/features/sync/local/searchIndex.ts:1-381` | SQLite FTS5 virtual table. Spec §4.1, §9.2 |
| Outbox persisted in IndexedDB via `operationStorage.ts`. `frontend/src/lib/operationStorage.ts:1-174` | Outbox lives in SQLite `operation` table. Spec §4.1 |
| `sql.js` is only used for Logseq import parsing. `frontend/src/utils/logseqSqliteParser.ts` | sql.js/OPFS becomes the primary local database engine. Spec §4.1, §14.2 |

### 4.3 Live Sync

- `useLivePageSync` drives WebSocket presence and applies remote `block_updated` messages to TanStack Query cache. `frontend/src/features/content/hooks/useLivePageSync.ts:50-214`
- `SyncManagerV2` batches pending `OperationRuntime` ops to `POST /sync/batch`. `frontend/src/features/sync/SyncManagerV2.tsx:61-413`

Ideal: live sync receives encrypted operation envelopes and appends them to local SQLite; CRDT reducer merges them. Spec §6.3.

### 4.4 Query Engine

- `localQuery.ts` evaluates QueryAST against the in-memory node mirror. `frontend/src/features/sync/local/localQuery.ts:37-73`
- Ideal: QueryAST compiles to SQLite SQL executed inside the client database. Spec §9.1.

---

## 5. Migration Scripts and Schema to Replace

### 5.1 PostgreSQL Schema

`app/db/schema/sql.py` (~2207 lines) defines the current world. Key sections that would be replaced:

- `node` table: `sql.py:157-207`
- `asset` table: `sql.py:253-264`
- `node_yjs_state` table: `sql.py:269-274`
- `property` / `node_property` / `property_value_*` / `class_property` / `class_extend`: `sql.py:429-616`
- `node_link` / `node_mention`: `sql.py:623-745`
- `node_view`: `sql.py:754-783`
- `node_version` / `node_revision`: `sql.py:885-909`
- `task_recurrence` / `task_completion`: `sql.py:1411-1450`

The ideal server schema shrinks to users/workspaces/memberships, encrypted `operation` log, `workspace_key`, shares, and compaction metadata. Spec §4.2.

### 5.2 Existing Migrations to Deprecate

All files under `app/db/migrations/` assume the current PostgreSQL model:

| Migration | Purpose |
|---|---|
| `add_cascade_delete_triggers.sql` | Cascade deletes in PostgreSQL |
| `add_class_ids_column.sql` | Add `class_ids` to `node` |
| `add_node_boolean_not_null.sql` | NOT NULL on boolean flags |
| `add_node_mention.py` | Create `node_mention` table |
| `add_property_scope.sql` | Tri-state property scope |
| `add_property_uuid_unique.sql` | Per-workspace property UUIDs |
| `add_soft_delete.sql` | Soft-delete columns |
| `add_undo_log.sql` | Global undo/redo table |
| `consolidate_class_path.py` | Rewrite QueryAST `class_path` |
| `convert_raw_uuid_to_broken_link.py` | AST link repair |
| `drop_property_is_local.sql` | Drop legacy column |
| `ensure_task_recurrence_property.py` | System property creation |
| `migrate_task_recurrence_to_table.py` | Recurrence data migration |
| `normalize_inline_class_links.py` | Inline class link normalization |
| `normalize_settings_jsonb.py` | JSONB string normalization |
| `rename_banner_cover_properties.sql` | Property rename |
| `repair_node_view_json_columns.sql` | `node_view` JSON repair |
| `update_query_block_types.sql` | QueryAST block type rename |

These would be replaced by a single migration path: **export current PostgreSQL state → generate operations → replay into SQLite**.

### 5.3 Data Repair Scripts

Several utility scripts in `scripts/` assume current schema/AST formats and would need replacement:

- `find_and_fix_orphaned_links.py`
- `fix_activity_log_ast.py`
- `fix_inline_class_links.py`
- `revert_false_positive_broken_links.py`
- `reset_system_views.py`

---

## 6. Tests That Exercise Current Behavior

The test suite is large and tightly coupled to the current PostgreSQL + REST API behavior. Key buckets:

### 6.1 Core Node / Hierarchy / Links

- `tests/test_nodes.py`
- `tests/test_hierarchy.py`
- `tests/test_pages_hierarchy.py`
- `tests/test_node_breadcrumbs.py`
- `tests/test_node_conversion.py`
- `tests/test_links.py`
- `tests/test_linked_refs.py`
- `tests/test_mentions.py`
- `tests/test_stringify_ast.py`

### 6.2 Properties / Classes / Queries

- `tests/test_property_attributes.py`
- `tests/test_property_workspace_scoping.py`
- `tests/test_set_selection_property.py`
- `tests/test_system_types.py`
- `tests/test_system_queries.py`
- `tests/test_query_ast_power.py`
- `tests/test_query_ast_security.py`
- `tests/test_search_filters.py`
- `tests/test_node_views.py`
- `tests/test_table_flag.py`
- `tests/test_tags.py`

### 6.3 Sync / Collaboration / Offline

- `tests/test_sync_v2.py` — integration tests for `POST /api/sync/batch` and version vectors.
- `tests/test_live_sync_ws.py` — WebSocket presence/broadcast.
- `tests/test_yjs_state.py` — server-side Yjs CRDT state.
- `tests/test_optimistic_locking.py`
- `tests/test_undo_redo.py`
- `tests/test_soft_delete.py`

### 6.4 Assets / Import / Export

- `tests/test_assets.py`
- `tests/test_asset_tokens.py`
- `tests/test_import_markdown.py`
- `tests/test_export.py`
- `tests/test_export_properties.py`

### 6.5 Tasks / Flashcards / Recurrence

- `tests/test_tasks.py`
- `tests/test_task_recurrence_api.py`
- `tests/test_recurrence_engine.py`
- `tests/test_task_automations.py`
- `tests/test_flashcard_cloze.py`

### 6.6 Frontend Tests

- `frontend/src/runtime/OperationRuntime.test.ts`
- `frontend/src/runtime/operationReducer.test.ts`
- `frontend/src/features/sync/SyncManagerV2.test.tsx`
- `frontend/src/features/sync/engine/localSyncEngine.test.ts`
- `frontend/src/features/sync/local/localNodeStore.test.ts`
- `frontend/src/features/sync/local/localQuery.test.ts`
- `frontend/src/features/sync/local/searchIndex.test.ts`

### 6.7 Migration Tests

- `tests/test_migrations_normalize_inline_class_links.py`
- `tests/test_settings_jsonb.py`

---

## 7. Partially Aligned Areas (Existing Foundation)

Some current code already points toward the ideal architecture and can be reused conceptually:

1. **Frontend `OperationRuntime` + reducer** — pure derived-state engine with operations. `frontend/src/runtime/OperationRuntime.ts`, `operationReducer.ts`.
2. **`SyncManagerV2` / `localSyncEngine`** — outbox + acked vector pattern. `frontend/src/features/sync/SyncManagerV2.tsx`, `frontend/src/features/sync/engine/localSyncEngine.ts`.
3. **Version vectors** — `node_revision` table and `BaseVector`/`VersionVector` types. `app/db/schema/sql.py:903-909`, `app/domain/entities/sync_v2.py:1-126`.
4. **Yjs CRDT text state** — `node_yjs_state` and `broadcast_yjs_update`. `app/db/schema/sql.py:269-274`, `app/features/collab/live_sync_ws.py:145-166`.
5. **Offline mirror + search** — `localNodeStore`, `searchIndex`, `localQuery`. `frontend/src/features/sync/local/`.
6. **UUIDv7 generation** — already used for public IDs. `app/domain/entities/node.py:37-44`.

---

## 8. Key Migration Risks

1. **Identifier migration** — moving from internal int IDs to UUIDv7-only touches every repository, service, test, and API contract.
2. **CRDT semantics** — replacing optimistic-lock 409 conflicts with CRDT merge requires redesigning tree ordering (sequence → CRDT position) and inline content (AST snapshots → Yjs/YATA updates).
3. **Property EAV collapse** — `property_value_scalar/relation/selection` → single `property_value` table changes filters, indexes, and QueryAST SQL.
4. **Asset subsystem removal** — `asset` table and `is_asset` nodes become `file` property nodes.
5. **Query engine retarget** — PostgreSQL SQL compiler → SQLite SQL compiler; local execution moves from IndexedDB mirror to sql.js.
6. **Test suite rewrite** — most integration tests assume mutable PostgreSQL rows and REST endpoints; they would need to target SQLite-derived state and operation log replay.
7. **End-to-end encryption** — current payloads are plaintext JSON; ideal encrypts workspace-private operation payloads. Spec §6.2, §8.3.

---

## 9. Conclusion

The current Notees app and the ideal architecture share terminology (nodes, classes, operations, QueryAST) but differ at the **foundational layer**: mutable PostgreSQL rows vs. immutable operation log, server-centric authority vs. local SQLite authority, optimistic locking vs. CRDT convergence. Migrating incrementally is possible only at the UI/operation-shape level; the storage, sync, and query layers require a near-complete rewrite.
