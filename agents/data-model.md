# Data Model & Domain Conventions

## Data Model at a Glance

The authoritative source of truth is the **immutable operation log**. Every mutation is appended as an operation; PostgreSQL stores the encrypted relay log and server-side snapshots/compaction segments; the client maintains a derived SQLite database that is rebuilt by applying operations.

```
operation log (source of truth)
  └── derived SQLite state
        ├── node (pages, blocks, classes)
        ├── node_child_order (tree ordering)
        ├── property_value / property_value_tombstone
        ├── edge (backlinks and references)
        ├── crdt_state (Yjs text/tree state for concurrent editing)
        ├── search_index
        ├── node_asset
        ├── task_completion / task_recurrence
        ├── activity_log / link_click
        └── node_public_share / node_user_share
```

PostgreSQL also stores non-workspace-private metadata: `user`, `workspace`, `workspace_share`, relay envelopes, relay snapshots, and compaction segments.

## Operation Log

- Operations are immutable, idempotent, and totally ordered by **Hybrid Logical Clock (HLC)**.
- Each operation has an envelope with routing metadata (`workspace_id`, `actor_id`, `hlc`, `affected_node_ids`, `op_type`) and an opaque encrypted payload.
- Known operation types live in `app/core/operation.py` and `frontend/src/core/types/operation.ts`.
- The server relay stores encrypted envelopes and serves catch-up queries without decrypting payloads.

## Node Model

Everything is a **node**. Nodes are differentiated by `kind` and class assignments:

- `kind = 'page'` → Page (can contain blocks and child pages)
- `kind = 'block'` → Block (content within a page)
- `kind = 'class'` → Class node (defines a type/category)

Class assignments are stored in `node.class_ids` and drive behavior, property schemas, and QueryAST filters. Classes themselves are nodes so they can be linked to, mentioned, and queried like any other concept.

## Hierarchy

- Tree structure is an adjacency list (`node.parent_id`).
- Ordering is managed by a sequence CRDT and materialized in `node_child_order` (parent_id, child_id, position).
- `node_child_order` is the source of truth for display order; `parent_id` is the structural parent.

## Properties

- **Property schemas** are created with `propertySchema.create` operations. They define `type` (text, number, date, relation, file, etc.) and optionally a `computed` strategy (formula, rollup, query).
- **Property values** are stored in `property_value` (node_id, property_schema_id, value, idx, hlc, actor_id).
- Multi-value properties use `idx`.
- Tombstones track explicitly removed values for CRDT merge semantics.

## References & Links

- All references are **ID-based** (UUIDv7). Name-based `[[Page]]` links are not used because names are not unique.
- The `edge` table stores parsed links (source → target) for backlinks and graph queries.
- Backlinks are derived from edges, not stored separately.

## Assets

- Assets are nodes with a `file` property value.
- The `node_asset` derived table stores content-addressed blob metadata (hash, mime, size, original_name).
- Blob bytes live on disk under `data/workspaces/{workspace_uuid}/assets/` or in object storage.

## Tasks

- Task status, scheduled date, and deadline are property values.
- Completion history lives in `task_completion`.
- Recurrence rules live in `task_recurrence`.

## Identifier Strategy

- Public resources use UUIDs in the HTTP API and UI.
- The document model uses **UUIDv7** (`uuid_extensions.uuid7()` backend, `uuidv7` frontend package) for index locality.
- Internal numeric IDs are used only inside PostgreSQL metadata tables (`user`, `workspace`) and never appear in URL paths or public request/response bodies.

## Workspace Isolation

- Every operation is tagged with a `workspace_id`.
- Derived SQLite databases are per-workspace.
- Cross-workspace references are not supported in the core model.

## Sync

- Client edits append operations to the local SQLite operation log.
- Operations are encrypted with the workspace key and relayed through `/api/relay/*`.
- Other clients pull operations and rebuild derived state.
- The client maintains a sync watermark per workspace for pull and a separate push watermark to avoid re-sending old operations.

## Snapshots and Compaction

- Client-side snapshots serialize derived tables + CRDT state + sync watermark up to a given HLC.
- Server-side snapshots and `compacted_operation_segment` rows bound replay cost and long-term log growth.
- Compaction is a storage optimization; the operation log remains authoritative in principle.

## Request-Scoped Connections

Never call `pool.acquire()` directly in routers or services. Use:
- `app.db.connection.get_connection()` — for general DB access.
- `app.db.connection.get_transaction()` — for transactions.

## Adding a New Operation Type

1. Add the op type to `app/core/operation.py` and `frontend/src/core/types/operation.ts`.
2. Add server-side derived applier(s) in `app/core/derived/`.
3. Add client-side derived applier(s) in `frontend/src/core/derived/`.
4. Add tests for both appliers and a convergence test in `tests/core/`.
