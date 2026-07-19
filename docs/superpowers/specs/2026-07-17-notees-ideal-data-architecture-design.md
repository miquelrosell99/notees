# Notees Ideal Data Architecture Design

**Date:** 2026-07-17  
**Status:** Design spec for review  
**Scope:** Greenfield ideal data architecture for Notees, a self-hosted, privacy-first, block-based knowledge management application.

---

## 1. Overview

This document defines the ideal data architecture for Notees from first principles. It is not constrained by the current PostgreSQL implementation, existing migrations, or shipping timelines. The goal is a coherent, future-proof foundation that supports offline-first use, real-time collaboration, structured querying, and user data ownership.

The architecture is:

- **Local-first:** the client SQLite database is the primary runtime store.
- **Operation-based:** an immutable operation log is the source of truth.
- **CRDT-driven:** concurrent edits merge automatically without a central coordinator.
- **Classed-node graph:** every content item is a node; nodes have classes that define properties and behavior.
- **Self-hosted:** a lightweight server relays encrypted operations and manages sharing metadata.

---

## 2. Goals and Non-Goals

### Goals

1. Offline-first: all core functionality works without network.
2. Real-time collaboration: multiple users can edit the same workspace concurrently.
3. Structured querying: rich databases, filtered views, and graph queries are first-class.
4. Data sovereignty: users can self-host; no vendor lock-in.
5. Extensibility: plugins can add property types, block types, views, and operations.
6. Portability: Markdown is a guaranteed round-trip interchange format.

### Non-Goals

1. Built-in AI features. AI access is provided via an external scoped API/skill.
2. Two-way live Markdown synchronization. Markdown is import/export only.
3. Peer-to-peer sync without any server. A self-hosted server is assumed.
4. Support for very large teams (1000+ users) in a single workspace.

---

## 3. Core Concepts

### 3.1 Node

A node is the unit of content. Nodes have:

- `id`: UUIDv7.
- `kind`: one of `page`, `block`, `class`.
- `classIds`: classes the node instantiates.
- `parentId` and `children`: tree position and ordered children.
- `content`: inline AST (text, references, formatting, embeds).

### 3.2 Class

A class is a node with `kind: "class"`. It defines:

- `name`: display name.
- `propertySchemaIds`: properties available to instances.
- `extends`: parent classes for inheritance.

A class node renders as a system view listing its instances and schema. It is distinct from a user-created concept page about the same topic.

### 3.3 Property Schema

Property schemas live in a dedicated relational table:

```sql
property_schema (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,        -- text, number, date, select, multi_select, node, checkbox, file
  computed JSONB,            -- null for stored properties; { kind, expression } for computed ones
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

`type` is the scalar or structural type the property returns. `computed` is an optional computation strategy that produces the value instead of storing it. A computed property has a `kind` (`formula`, `rollup`, or `query`) and an `expression` in a restricted, safe expression language.

They are not nodes because they require strict validation and change rarely.

### 3.4 Property Value

Property values live in a dedicated table:

```sql
property_value (
  id UUID PRIMARY KEY,
  node_id UUID NOT NULL,
  property_schema_id UUID NOT NULL,
  value JSONB NOT NULL,
  index INTEGER NOT NULL DEFAULT 0,
  UNIQUE(node_id, property_schema_id, index)
);
```

Values are assigned through UI controls, not typed into content.

### 3.5 Reference

All references are ID-based with separate display labels. Inline links, property relations, class assignments, and tags use UUIDs, not names.

```ts
interface Reference {
  targetId: string;   // UUIDv7
  label: string;      // display text
}
```

---

## 4. Data Model

### 4.1 Client SQLite Schema

```sql
-- Source of truth
operation (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  hlc JSONB NOT NULL,          -- { physical, logical }
  affected_node_ids JSONB NOT NULL DEFAULT '[]',
  op_type TEXT NOT NULL,
  payload BYTEA NOT NULL,      -- encrypted
  timestamp TIMESTAMPTZ
);

-- Checkpoints / snapshots
snapshot (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  hlc JSONB NOT NULL,          -- operations up to this HLC are included
  state_hash TEXT NOT NULL,    -- hash of the derived state for integrity
  data BLOB NOT NULL,          -- compressed derived SQLite dump or equivalent
  created_at TIMESTAMPTZ
);

-- Compaction metadata
compacted_operation_segment (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  from_hlc JSONB NOT NULL,
  to_hlc JSONB NOT NULL,
  snapshot_id UUID NOT NULL,
  operation_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ
);

-- Derived state
node (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'block', 'class')),
  class_ids JSONB NOT NULL DEFAULT '[]',
  parent_id UUID,
  content JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  created_by UUID,
  updated_by UUID
);

node_child_order (
  parent_id UUID NOT NULL,
  child_id UUID NOT NULL,
  position TEXT NOT NULL,      -- CRDT sequence position
  PRIMARY KEY (parent_id, child_id)
);

property_value (
  id UUID PRIMARY KEY,
  node_id UUID NOT NULL,
  property_schema_id UUID NOT NULL,
  value JSONB NOT NULL,
  index INTEGER NOT NULL DEFAULT 0,
  UNIQUE(node_id, property_schema_id, index)
);

edge (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  source_id UUID NOT NULL,
  target_id UUID NOT NULL,
  type TEXT NOT NULL,
  property_schema_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ
);

-- Search (FTS4 is used because the sql.js build ships with it; FTS5 would
-- require a custom WASM compilation. The two are interchangeable for callers.)
CREATE VIRTUAL TABLE search_index USING fts4(
  node_id,
  content,
  notindexed=node_id,
  tokenize=unicode61
);
```

### 4.2 Server PostgreSQL Schema

```sql
"user" (id UUID PRIMARY KEY, email, password_hash, ...)
workspace (id UUID PRIMARY KEY, name, owner_id, ...)
membership (workspace_id UUID, user_id UUID, role TEXT, PRIMARY KEY (workspace_id, user_id))

node_share (node_id UUID, user_id UUID, role TEXT)
node_public_share (node_id UUID PRIMARY KEY, slug TEXT, password_hash TEXT)

operation (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  hlc JSONB NOT NULL,
  affected_node_ids JSONB NOT NULL DEFAULT '[]',
  op_type TEXT NOT NULL,
  payload BYTEA NOT NULL,  -- encrypted
  timestamp TIMESTAMPTZ
);

workspace_key (
  workspace_id UUID,
  user_id UUID,
  wrapped_key BYTEA,
  PRIMARY KEY (workspace_id, user_id)
);

compacted_operation_segment (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  from_hlc JSONB NOT NULL,
  to_hlc JSONB NOT NULL,
  snapshot_id UUID NOT NULL,
  operation_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ
);
```

---

## 5. Operation Log and CRDTs

### 5.1 Operation Types

```ts
// Structural
{ type: "node.create", nodeId, kind, parentId, index, initialContent?, classIds? }
{ type: "node.delete", nodeId }
{ type: "node.move", nodeId, newParentId, newIndex }
{ type: "node.updateContent", nodeId, crdtUpdate }
{ type: "class.assign", nodeId, classId }
{ type: "class.unassign", nodeId, classId }

// Properties
{ type: "property.set", propertyValueId, nodeId, schemaId, index, value }
{ type: "property.unset", propertyValueId, nodeId, schemaId, index }

// Schema
{ type: "propertySchema.create", schemaId, name, type, config }
{ type: "propertySchema.update", schemaId, configDelta }
{ type: "class.create", classId, name, propertySchemaIds, extends }
{ type: "class.update", classId, propertySchemaIds?, extends? }
```

### 5.2 CRDT Scope

| Structure | CRDT |
|---|---|
| Block tree children ordering | CRDT sequence (Yjs Y.Array / YATA / RGA) |
| Inline block content | CRDT rich text (Yjs Y.XmlFragment equivalent) |
| Scalar property values | LWW register |
| Multi-select / multi-relation | OR-Set |
| Class assignments | OR-Set |
| Node deletion | Tombstone + LWW |

### 5.3 Clocks

Operations are ordered with Hybrid Logical Clocks (HLC):

```ts
hlc: { physical: number, logical: number }
```

HLC provides causality tracking with constant-size timestamps.

### 5.4 Operation Envelope

Operations have a clear split between routing metadata and encrypted payload:

```json
{
  "id": "op-uuid",
  "workspaceId": "workspace-uuid",
  "actorId": "actor-uuid",
  "hlc": { "physical": 1234567890, "logical": 5 },
  "affectedNodeIds": ["node-a", "node-b"],
  "opType": "node.move",
  "encryptedPayload": "base64-or-binary"
}
```

The envelope fields are unencrypted so the server can:

- Route operations to the correct workspace.
- Enforce workspace and node-level permissions.
- Serve catch-up queries efficiently.

The `affectedNodeIds` field is populated by the client before encryption. It lists the node IDs whose state may change as a result of the operation. For workspace-private routing, this field may be empty. For node-level shares, it must be present.

### 5.5 Operation Log Compaction

Over time, workspaces can accumulate millions or billions of operations. Snapshots bound startup replay, but the raw log still grows. Compaction records which operation ranges have been superseded by a snapshot without changing the source-of-truth model:

```sql
compacted_operation_segment (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  from_hlc JSONB NOT NULL,
  to_hlc JSONB NOT NULL,
  snapshot_id UUID NOT NULL,
  operation_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ
);
```

Rules:

- A segment may be created only when a snapshot exists that fully reproduces the state derived from operations in the `[from_hlc, to_hlc]` range.
- Compacted operations can be archived or deleted; the segment record proves they are reproducible from the snapshot.
- The operation log remains authoritative in principle; compaction is a storage optimization and audit convenience.
- Clients and server can independently decide retention policies based on segment records.

---

## 6. Sync

### 6.1 Server Role

The self-hosted server is an operation relay:

1. Receives encrypted operation batches from clients.
2. Validates permissions using `membership` and `node_share` tables.
3. Persists operations in PostgreSQL.
4. Broadcasts operations to authorized connected clients.
5. Serves catch-up operations to clients that reconnect.

The server does not decrypt operation payloads for workspace-private operations.

### 6.2 Privacy Model

- Workspace-private operations are encrypted with the workspace symmetric key.
- The workspace key is wrapped for each member and stored in `workspace_key`.
- Node-level share routing uses `node_id` in the operation envelope only when a node is explicitly shared outside its workspace.
- Public pages are rendered as static snapshots uploaded by the client.

### 6.3 Offline Behavior

- Local edits append operations to the local SQLite operation log.
- Operations are queued for sync.
- When online, operations are encrypted and sent to the server.
- CRDTs ensure local and remote states converge.

### 6.4 Snapshots and Checkpoints

Long-lived workspaces may accumulate millions of operations. Replaying the entire log on startup is not scalable. Snapshots solve this:

- A **snapshot** captures the complete derived SQLite state up to a specific HLC.
- Snapshots are stored in the `snapshot` table on the client.
- The server may also store snapshots to speed up catch-up sync for new devices.
- Startup sequence:
  1. Load the latest snapshot.
  2. Replay operations with HLC greater than the snapshot's HLC.
  3. Resume live sync.
- Snapshots are generated periodically or when the operation count exceeds a threshold.
- Each snapshot includes a state hash for integrity verification.

Snapshots are an optimization, not a source of truth. The operation log remains authoritative.

---

## 7. Storage Split

| Concern | Client | Server |
|---|---|---|
| Store | SQLite file per workspace | PostgreSQL |
| Holds | Decrypted derived state, local queue, search index, blobs | Encrypted operation log, users, workspaces, memberships, shares, wrapped keys |
| Authority | Current merged view | Permission checks and operation relay |
| Backup | Markdown export + SQLite file | PostgreSQL backups + encrypted operation log |

---

## 8. Security

1. **Transport:** TLS for all client-server communication.
2. **At-rest:** SQLite encrypted with SQLCipher or platform keychain; PostgreSQL encrypted at rest.
3. **End-to-end:** Workspace-private operation payloads encrypted with workspace keys.
4. **Permissions:** Server enforces workspace and node-level access before relaying operations.
5. **Plugins:** Sandboxed execution and JSON Schema validation for plugin operations.

---

## 9. Query and Search

### 9.1 Query Model

- Primary query language: QueryAST.
- QueryAST compiles to SQLite SQL against derived tables.
- Live query blocks embed QueryAST results in pages and update automatically.
- QueryAST `tag` conditions filter by class assignments, because tags are represented as classes in the new model.

### 9.2 Search

- Full-text search via SQLite FTS4 (sql.js ships with FTS4; a custom WASM build would be needed for FTS5).
- Indexed: node names and block inline text. Property text values and class/property schema names can be added later.
- QueryAST `content` conditions support the `fts` operator, compiled to `search_index MATCH ...`.
- Vector/semantic search is out of scope for the core; can be added as a plugin.

---

## 10. Extensibility

### 10.1 Plugin Architecture

Plugins are first-class and can extend:

- Property types (custom editors, validators, renderers).
- Block types (custom content blocks).
- Views (custom renderers for query results).
- Import/export formats.
- Operation types.

Plugins declare a manifest with:

- Schemas for operations, block types, and property types.
- Derived-state handlers.
- Required permissions.

Unknown operations are preserved and forwarded by the core; plugins apply them.

### 10.2 Whiteboard Block

A `whiteboard` block stores canvas data:

```ts
interface WhiteboardData {
  viewport: { x, y, zoom };
  elements: Array<CanvasElement>;
  background: { color?, grid? };
}
```

Freehand shapes and text are embedded. Nodes dragged onto the canvas are references to graph nodes.

### 10.3 Computed Properties

Computed properties are defined by a computation strategy, not by a property type. The schema separates the scalar return type from the computation:

```ts
interface PropertySchema {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "select" | "multi_select" | "node" | "checkbox" | "file";
  computed?: {
    kind: "formula" | "rollup" | "query";
    expression: string;   // restricted safe expression, QueryAST, or relation path
  };
  config: Record<string, any>;
}
```

- `formula`: computes a value from the node's own properties and content.
- `rollup`: aggregates a property across related nodes.
- `query`: computes a boolean or count from a QueryAST subquery.

The `type` field tells the UI how to render and validate the result. The `computed` field tells the engine how to produce it. Computed values are not stored in `property_value`; they are recomputed on read and cached with dependency tracking. A restricted expression language is used; plugins can register safe functions.

### 10.4 Graph View

A built-in view over the `edge` table:

- Visualizes references, property relations, class instances, and tags.
- Supports filtering by edge type, class, and date range.
- Provides physics-based layout and clustering.

### 10.5 Publishing

Public pages are published as static snapshots:

1. Client collects the public page and referenced public subgraph.
2. Renders static HTML/CSS/JS.
3. Encrypts with a public-share key or leaves unencrypted.
4. Uploads snapshot to server.

The server serves the static snapshot; it does not dynamically render the live graph.

### 10.6 AI / Agent Access

No built-in AI layer. AI agents access Notees via an external scoped API documented as a skill:

| Scope | Permission |
|---|---|
| `read` | Read nodes, classes, properties, query results |
| `write` | Submit operations on behalf of the user |
| `search` | Full-text search and QueryAST execution |
| `admin` | Manage shares and workspace settings |

Write operations are auditable and subject to user-configurable confirmation.

### 10.7 Policies

Several long-running policies must be explicit in the architecture.

#### Tombstone garbage collection

Deleted nodes remain as tombstones in the operation log so CRDTs can converge. Tombstones can be compacted only after all known replicas have observed the deletion and after any configured retention window has passed. The client performs compaction during snapshot creation; the server never discards operations unilaterally.

#### Key rotation and member removal

Workspace keys use a wrapped-master-key hierarchy:

- A workspace master key encrypts operation payloads.
- The master key is wrapped for each member's public key and stored in `workspace_key`.
- Rotation generates a new master key, re-wraps it for current members, and issues a `workspace.keyRotate` operation.
- Removed members keep any historical data they already downloaded; they cannot decrypt new operations because they do not receive the new master key. This is treated as a feature, not a bug: historical access is a sharing decision, not a revocable lock.

#### Schema evolution

When a property schema changes type or config, existing values are not automatically migrated. Instead:

- The schema change is recorded as an operation.
- Readers apply the new validation to existing values lazily.
- A background derived-state task flags values that no longer validate.
- Users may run an explicit migration operation to rewrite invalid values.

This preserves history and avoids silent data loss.

#### Cross-workspace references

References across workspaces are not supported in the core model. A node belongs to exactly one workspace. If a public page or published snapshot references content, that content is either copied into the destination workspace or rendered as an external link. Workspace isolation is never violated.

---

## 11. User-Facing Model

### 11.1 Content Editing

- Block-based editor with `/` commands.
- Indent/outdent for outline structure.
- Inline references via `@` or `[[` picker; stored as UUID-based refs.
- Properties edited in a side panel or database view.

### 11.2 Classes and Properties

- Users create classes that define property schemas.
- Assigning a class to a node exposes its properties.
- Properties are selected/assigned via UI controls.
- Classes support inheritance via `extends`.

### 11.3 Views

- Table, list, card, kanban, calendar, graph, and timeline views over QueryAST results.
- Views are first-class nodes or blocks.
- Live query blocks embed dynamic views in pages.

---

## 12. Identifiers

- **UUIDv7** for all addressable entities: nodes, operations, classes, property schemas, property values, users, workspaces.
- **SHA-256** for content-addressed blobs.
- No integer IDs.
- Exceptions: HLC logical counters and array indices.

---

## 13. Migration from Current Notees

Moving from the current Notees to this architecture would require:

1. Replacing mutable PostgreSQL rows with an operation log.
2. Migrating boolean-flag node kinds to `page`/`block`/`class` + classes.
3. Converting `[[name]]` links to ID-based references.
4. Replacing EAV property tables with `property_value`.
5. Removing the separate asset subsystem in favor of `file` property types.
6. Moving from server-centric queries to client-local SQLite.
7. Replacing block locking with CRDT-based collaboration.
8. Introducing plugin extensibility.

This is a fundamental rewrite, not an incremental migration. The operation log makes it possible to replay historical edits into the new model, but the schema change is radical.

---

## 14. Open Issues

The architecture is converged, but a few decisions remain explicitly open rather than fully resolved:

1. **CRDT implementation complexity** for the block tree and inline content. The semantics are clear; the library choice and integration effort are not.
2. **SQLite OPFS + wasm maturity** on web clients. The shape is right; platform behavior and performance still need validation.
3. **Plugin sandboxing** across platforms. Web Workers / restricted processes are the direction; the concrete sandbox model is TBD.
4. **Computed property dependency tracking** at scale. The policy is defined; the cache invalidation engine is not.
5. **Workspace key rotation UX.** The cryptographic flow is specified; the user-facing rotation and recovery flow needs design.
6. **Tombstone GC timing.** How long to retain tombstones before compaction is a retention policy, not a resolved constant.
7. **Schema migration ergonomics.** Lazy validation plus explicit migration is the rule; the UI for reviewing and applying migrations needs design.
8. **Cross-workspace references.** Core model forbids them; whether to add safe copy-or-link semantics later is an open product decision.

---

## 15. Summary

The ideal Notees architecture is a **local-first, operation-based, CRDT-driven classed-node graph**.

- Clients run SQLite with derived state.
- The immutable operation log is the source of truth.
- CRDTs merge concurrent edits.
- A self-hosted PostgreSQL server relays encrypted operations and manages sharing.
- Classes define schemas; properties are UI-selected and stored relationally.
- References are ID-based.
- Plugins extend property types, block types, views, and operations.
- Snapshots and compaction segments keep long-lived workspaces performant.
- Markdown is interchange only.

This design prioritizes data sovereignty, offline performance, structured querying, and real-time collaboration over implementation simplicity.
