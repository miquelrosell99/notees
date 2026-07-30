# Technical Architecture

This document describes the technical architecture of Notees: the local-first operation log, client-side derived SQLite store, GraphQuery layer, rendering pipeline, sync protocol, and performance considerations.

For installation, configuration, usage, plugin development, and troubleshooting, see the other docs in this directory:

- [Installation](installation.md)
- [Configuration](configuration.md)
- [Usage](usage.md)
- [Developer Guide](developer-guide.md)
- [API Reference](api.md)
- [Plugins](plugins.md)
- [Troubleshooting](troubleshooting.md)
- [FAQ](faq.md)

---

## 1. High-level architecture

Notees is a local-first, privacy-first note application. The authoritative source of truth is an immutable **operation log** stored on the server as an encrypted relay and replayed in the browser. The client builds a derived **SQLite** database (via `sql.js`/WebAssembly) from that log. All reads the UI performs run against the local SQLite store; writes append local operations that are asynchronously pushed to the server.

```
Browser UI (React)
       │
       ▼
GraphQuery / Projection layer   ←── hooks such as useGraphQuery, useBlockTree
       │
       ▼
Web Worker  ←── owns the sql.js Database
       │
       ├── applyOperation()  →  derived tables (node, edge, node_stats, …)
       └── query / mutate dispatch
       │
       ▼
SyncEngine  ←── push/pull encrypted operation envelopes
       │
       ▼
FastAPI backend  ←── encrypted relay log, snapshots, users, shares
```

### Main layers

| Layer | Responsibility | Key location |
|-------|----------------|--------------|
| **React UI** | Renders pages, blocks, collections, editors | `frontend/src/features/content/` |
| **GraphQuery layer** | Named, cacheable, invalidatable read objects | `frontend/src/core/graphQueries/` |
| **Projection layer** | Converts raw DB rows / IDs into view models | `frontend/src/core/projections/` |
| **Derived-store appliers** | Apply one operation to SQLite; emit change notifications | `frontend/src/core/derived/` |
| **WorkspaceStore** | In-worker API over the SQLite database | `frontend/src/core/store.ts` |
| **Worker client** | Main-thread proxy that posts messages to the worker | `frontend/src/core/worker/WorkspaceStoreClient.ts` |
| **Sync engine** | Push local ops, pull remote ops, detect conflicts, snapshots | `frontend/src/core/sync.ts` |
| **Backend relay** | Encrypted operation storage, snapshot storage, auth | `app/relay/`, `app/features/auth/` |

### Folder structure

```
frontend/src/core/
  graphQueries/          # Query objects, registry, dispatcher, useGraphQuery
    GraphQuery.ts
    queryRegistry.ts
    QueryInput.ts
    QueryOutput.ts
    queries/             # Concrete query implementations
    hooks/useGraphQuery.ts
  projections/           # View-model builders
    NodeSummaryProjection.ts
    NodeTreeProjection.ts
    LinkedReferenceProjection.ts
  derived/               # Operation appliers and derived-table helpers
    node.ts
    edge.ts
    nodeStats.ts
    childOrder.ts
    property.ts
    index.ts
  db/                    # SQLite schema and low-level query helpers
    schema.ts
    sqlite.ts
  query/                 # QueryAST → SQLite compiler and search helpers
    queryNodes.ts
    compileToSqlite.ts
    search.ts
  worker/                # Web Worker protocol and dispatch
    workspaceWorker.ts
    WorkspaceStoreClient.ts
    workerProtocol.ts
  sync.ts                # SyncEngine
  store.ts               # WorkspaceStore (worker-side)

frontend/src/features/content/
  hooks/
    useBlockTree.ts          # Block tree rendering
    useNodeLinkQueries.ts    # Linked references hooks
    useLinkedReferencesCount.ts
  components/nodes/
    QueryNodeCollection.tsx  # Renders query-backed collections
    QuerySection.tsx         # Collapsible section wrapper
```

### Data flow from UI to database

1. A React hook (e.g. `useGraphQuery`) asks the worker client to execute a named GraphQuery.
2. `WorkspaceStoreClient` posts a `query` message to the Web Worker.
3. The worker dispatcher calls `executeGraphQuery(name, input)`, which looks up the query object and runs it against the in-memory `WorkspaceStore` / SQLite database.
4. The query returns lightweight IDs or rows; a projection (optionally in a second query) hydrates visible rows into view models.
5. The worker posts the result back to the main thread.
6. `useGraphQuery` stores the result in local React state and subscribes to worker change notifications. When a matching scoped notification arrives, it re-runs the query.
7. Writes go through mutations / appliers: an operation is applied inside the worker, derived tables are updated, and scoped notifications are broadcast.

---

## 2. Data model

The client-side SQLite database is a derived view of the operation log. It can be rebuilt at any time by re-applying operations. The main tables are below.

### `operation`

Immutable log of every change. The authoritative source of truth.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | UUIDv7 operation id |
| `workspace_id` | TEXT | Workspace UUID |
| `actor_id` | TEXT | User id that authored the operation |
| `hlc_physical` | INTEGER | Hybrid logical clock – physical component |
| `hlc_logical` | INTEGER | HLC – logical component |
| `affected_node_ids` | TEXT | JSON array of node ids |
| `op_type` | TEXT | e.g. `node.upsert`, `childOrder.reorder` |
| `payload` | BLOB | JSON operation payload |
| `timestamp` | TEXT | ISO timestamp |

Indexes:

- `idx_operation_workspace_hlc(workspace_id, hlc_physical, hlc_logical)`

### `snapshot`

Server-provided compacted derived-state snapshots.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | Snapshot UUID |
| `workspace_id` | TEXT | |
| `hlc_physical`, `hlc_logical` | INTEGER | Snapshot HLC |
| `state_hash` | TEXT | |
| `data` | BLOB | Binary SQLite dump |
| `created_at` | TEXT | |

### `compacted_operation_segment`

Tracks operation ranges that have been compacted into a snapshot.

### `node`

Polymorphic table for pages and blocks.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | UUIDv7 |
| `workspace_id` | TEXT | |
| `kind` | TEXT CHECK `'page'\|'block'` | |
| `class_ids` | TEXT DEFAULT `'[]'` | JSON array of class UUIDs |
| `parent_id` | TEXT | Adjacency-list parent (null for roots) |
| `content` | TEXT DEFAULT `'[]'` | JSON CRDT text / structured content |
| `active` | INTEGER DEFAULT 1 | Soft-delete flag |
| `created_at`, `updated_at` | TEXT | |
| `created_by`, `updated_by` | TEXT | |

### `node_child_order`

Deterministic ordering of children under a parent.

| Column | Type | Notes |
|--------|------|-------|
| `parent_id` | TEXT | |
| `child_id` | TEXT | |
| `position` | TEXT | Lexicographic position string |
| PRIMARY KEY | `(parent_id, child_id)` | |

### `edge`

Graph edges, currently used primarily for `[[reference]]` / node-link references.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | |
| `workspace_id` | TEXT | |
| `source_id` | TEXT | Node that contains the reference |
| `target_id` | TEXT | Node being referenced |
| `type` | TEXT | e.g. `reference` |
| `property_schema_id` | TEXT | Optional property edge |
| `metadata` | TEXT | JSON, e.g. `{"label":"…"}` |
| `created_at` | TEXT | |

Indexes:

- `idx_edge_source_type(source_id, type)`
- `idx_edge_target_type(target_id, type)`

### `node_stats`

Materialized counts. Rebuilt incrementally by `rebuildNodeStats()`.

| Column | Type | Notes |
|--------|------|-------|
| `node_id` | TEXT PRIMARY KEY | |
| `child_count` | INTEGER DEFAULT 0 | Direct children |
| `backlink_count` | INTEGER DEFAULT 0 | Incoming `reference` edges |
| `reference_count` | INTEGER DEFAULT 0 | Outgoing `reference` edges |
| `descendant_count` | INTEGER DEFAULT 0 | Total descendants |
| `updated_at` | TEXT | |

### `property_value` / `property_value_tombstone`

Stores typed property values and deletion tombstones for CRDT merge.

### `class`, `class_hierarchy`, `property_schema`, `class_property_edge`

Type system: classes, class inheritance, property schemas, and the many-to-many mapping between classes and properties.

### `search_index`

FTS4 virtual table over node plain text. Tokenizer: `unicode61`. See [SEARCH.md](SEARCH.md) for details.

### `sync_watermark`, `sync_push_watermark`, `sync_outbox`

Sync state: received/pushed HLCs, local pending operations, retry scheduling.

### `node_view`, `user_favorite`, `node_asset`, `activity_log`, `task_completion`, etc.

UI views, favorites, uploads, activity, task metadata.

### How the graph is modeled

- **Hierarchy**: adjacency list (`node.parent_id`) plus explicit order table (`node_child_order`). The derived store rebuilds both from tree operations.
- **References**: `edge` rows with `type = 'reference'`. References are parsed from node content (`[[target]]` wiki-links and `node_link` inline links) by `rebuildEdgesForNode()`.
- **Classes**: `node.class_ids` JSON array; hierarchy in `class_hierarchy`.
- **Properties**: `property_value` rows keyed by `(node_id, property_schema_id, idx)`.
- **Ordering**: children are ordered by `position` strings.

---

## 3. Query layer

The query layer has two tiers:

1. **GraphQuery objects** – named, cache-keyed, invalidatable queries that run inside the worker and return IDs or lightweight rows.
2. **Projections** – synchronous functions that turn IDs/rows into view models.

### Base contract

```ts
// frontend/src/core/graphQueries/GraphQuery.ts
export interface GraphQuery<Input, Output> {
  readonly name: string;
  cacheKey(input: Input): string;
  execute(store: WorkspaceStore, input: Input): Output;
  shouldInvalidate(input: Input, notification: NotifyChangeMessage): boolean;
}
```

### Important queries

#### `GetBacklinksQuery`

Purpose: return the source node ids that reference a target node.

```ts
export const GetBacklinksQuery: GraphQuery<NodeInput, IdPageOutput> = {
  name: 'GetBacklinksQuery',
  cacheKey: (i) => `backlinks:${i.nodeUuid}`,
  execute(store, i) {
    const ids = getBacklinks(store.getDb(), i.nodeUuid);
    return { ids, totalCount: ids.length, hasMore: false };
  },
  shouldInvalidate(i, n) {
    return n.scope === 'edge' || n.scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
```

SQL used:

```sql
SELECT DISTINCT source_id FROM edge WHERE target_id = ? ORDER BY source_id
```

Complexity: `O(log n)` with `idx_edge_target_type`.

#### `GetLinkedReferencesQuery`

Purpose: return paginated source node ids for the "Linked references" section, using the QueryAST runtime.

```ts
export const GetLinkedReferencesQuery: GraphQuery<PaginatedInput, IdPageOutput> = {
  name: 'GetLinkedReferencesQuery',
  cacheKey: (i) => `linked-refs:${i.nodeUuid}:${i.limit ?? 'all'}:${i.offset ?? 0}`,
  execute(store, i) {
    const ast = autoFixSystemQuery(createEmptyQueryAST(), 'linked_references', { nodeUuid: i.nodeUuid });
    const allIds = queryNodes(store, {
      ast,
      runtimeParams: { current_node_uuid: i.nodeUuid, current_node_id: i.nodeUuid },
      projectionDepth: 0,
    }).map((n) => n.uuid);
    const offset = i.offset ?? 0;
    const limit = i.limit ?? allIds.length;
    const ids = allIds.slice(offset, offset + limit);
    return { ids, totalCount: allIds.length, hasMore: offset + limit < allIds.length };
  },
  ...
};
```

The QueryAST is compiled to SQLite by `compileToSqlite()`. The resulting SQL joins `node` with the edge/reference conditions defined by the AST. Because the query returns only ids with `projectionDepth: 0`, no recursive child projection happens at this stage.

#### `HydrateLinkedReferencesQuery`

Purpose: convert a small list of source ids into `LinkedReference` view models.

```ts
export const HydrateLinkedReferencesQuery = {
  name: 'HydrateLinkedReferencesQuery',
  cacheKey: (i) => `hydrate-linked-refs:${i.nodeUuid}:${i.sourceIds.join(',')}`,
  execute(store, i) {
    return hydrateLinkedReferences(store, i.nodeUuid, i.sourceIds);
  },
  shouldInvalidate() { return false; },
};
```

This calls `buildSyntheticRef()` per source id, which uses `projectNode()` to get the source node, walks up to the containing page, and builds a breadcrumb path.

#### `GetNodeTreeQuery`

Purpose: fetch an entire visible subtree in a single recursive SQL query.

```sql
WITH RECURSIVE tree AS (
  SELECT
    n.id,
    n.parent_id AS parentId,
    0 AS depth,
    n.kind,
    n.content,
    n.class_ids AS classIds,
    n.active,
    NULL AS position,
    '/' || n.id AS sortPath
  FROM node n
  WHERE n.id = ?

  UNION ALL

  SELECT
    n.id,
    t.id AS parentId,
    t.depth + 1,
    n.kind,
    n.content,
    n.class_ids,
    n.active,
    nco.position,
    t.sortPath || '/' || nco.position || ':' || n.id
  FROM tree t
  JOIN node_child_order nco ON nco.parent_id = t.id
  JOIN node n ON n.id = nco.child_id
  WHERE ? < 0 OR t.depth < ?
)
SELECT id, parentId, depth, kind, content, classIds, active, position
FROM tree
ORDER BY sortPath
```

Complexity: `O(k)` where `k` is the number of rows in the requested subtree.

#### `GetChildrenQuery`

Purpose: return direct child ids.

```ts
execute(store, i) {
  const ids = store.getChildren(i.nodeUuid);
  return { ids, totalCount: ids.length, hasMore: false };
}
```

#### `SearchQuery`

Purpose: full-text / metadata search. Delegates to `queryNodes()`.

#### `GetPageQuery`

Purpose: fetch a full `Node` view model for a page. Still uses `projectNode(store, id, 2)`.

### Query dispatch

`queryRegistry.ts` holds a map of query name → implementation. The worker handles `executeGraphQuery` messages; `WorkspaceStoreClient` exposes the same method on the main thread. `registerAllQueries()` is called once when the worker initialises.

---

## 4. Rendering pipeline

### Opening a page

1. `App.tsx` initialises the workspace store client for the route's `workspaceId`.
2. The worker loads a persisted SQLite dump from IndexedDB (or falls back to a fresh DB) and replays any pending local operations.
3. `WorkspaceStoreInitializer` starts the sync engine, which pulls remote operations in a batched `applyMany` call.
4. `PageView` renders. It calls `useNode(nodeUuid)` and `useBlockTree(...)`.
5. `useBlockTree` uses `GetNodeTreeQuery` to fetch the page subtree in one worker round-trip. `NodeTreeProjection.getVisibleNodeIds()` decides which rows are visible given collapsed state. `projectNodesFromClient()` projects only those visible ids to the legacy `Node` shape.
6. Linked-references sections render via `QuerySection`, which defaults to collapsed. The count badge comes from `useLinkedReferencesCount()` → `GetBacklinksQuery`, so no heavy reference hydration runs on initial load.

### Expanding a block

1. The user toggles collapse in the UI.
2. `useUIStateStore` updates collapsed state.
3. `useBlockTree` re-computes `getVisibleNodeIds()` from the cached tree rows and re-projects newly visible ids.
4. `GetNodeTreeQuery` is **not** re-executed unless a structural notification arrives.

### Opening backlinks

1. The user expands the "Linked references" section.
2. `QuerySection` flips `isExpanded` to true.
3. `QueryNodeCollection` enables `GetLinkedReferencesQuery`.
4. The query returns a page of source ids.
5. `useLinkedReferences` then enables `HydrateLinkedReferencesQuery` for those ids only.
6. The hydrated `LinkedReference[]` is rendered as rows.

### Scrolling

List views render via `NodeCollection` / `ListView`. There is currently no windowing/virtualization for large collections; the limit is the local query result cap (`LOCAL_QUERY_RESULT_LIMIT = 500`).

### Editing text

1. The block editor emits content changes.
2. `useContentSave` debounces and calls a mutation that creates/appends an operation.
3. The operation is applied in the worker (`applyNodeOperation`, `applyLinkOperation`, etc.).
4. Derived tables update, including `edge`, `search_index`, and `node_stats`.
5. The applier returns `ChangeNotification[]` with scope `node`/`edge`/`tree`.
6. The worker broadcasts scoped notifications.
7. `useGraphQuery` subscribers whose `shouldInvalidate` matches re-run their queries and React re-renders affected components.

---

## 5. Backlinks implementation

### Storage

Backlinks are stored as `edge` rows with `type = 'reference'`. When a node's content changes, `rebuildEdgesForNode(db, nodeId)`:

1. Reads the node's `content` JSON.
2. Extracts `[[target]]` wiki-link references and `node_link` inline link targets.
3. Compares the desired set of `(source_id, target_id)` pairs with the existing `edge` rows for that source.
4. Inserts, updates metadata, or deletes edges to match.
5. Returns the set of affected node ids (source + all touched targets).

### Materialized counts

`node_stats` holds `child_count`, `backlink_count`, `reference_count`, and `descendant_count`. `rebuildNodeStats(db, nodeIds?)` recomputes these counts:

- Full rebuild: groups `node_child_order`, `edge`, and recursive descendants in a single `INSERT … SELECT`.
- Incremental rebuild: computes the ancestor closure of the changed ids so descendant counts stay correct up to the roots, then updates only those rows.

`rebuildNodeStats()` is called from the operation appliers after batches of structural/link changes.

### Backlink query timing

- **Count badge**: always enabled via `useLinkedReferencesCount` → `GetBacklinksQuery` (cheap index lookup).
- **ID list**: enabled only when the section is expanded.
- **Hydration**: enabled only after the ID list returns non-empty results.

### Children / descendants of backlinked nodes

The implementation does **not** recursively load children of backlinked nodes when computing the backlink list. `GetLinkedReferencesQuery` uses `projectionDepth: 0`, so only the matching source node ids are returned. `HydrateLinkedReferencesQuery` calls `projectNode(..., 0)` for each visible source id and walks ancestors only to build breadcrumbs.

### Backlink badges

Badges are computed from `node_stats.backlink_count`, not by counting edges at render time. They update when edge appliers trigger a `node_stats` rebuild and emit a `scope: 'edge'` notification.

### Pagination / virtualization

`GetLinkedReferencesQuery` supports `limit`/`offset`. The UI currently uses a page size constant in `QueryNodeCollection` for linked references. There is no virtualization; large lists render all hydrated rows.

---

## 6. Caching

| Cache | What it stores | Invalidation |
|-------|----------------|--------------|
| **`useGraphQuery` local state** | Latest query result per `cacheKey` | Re-runs on scoped worker notifications matching `shouldInvalidate` |
| **Worker-side SQLite** | Entire derived database | Rebuilt by applying operations; notifications emitted per transaction |
| **`node_stats`** | Pre-aggregated counts | Incrementally rebuilt after structural/link changes |
| **TanStack Query** | Server-state queries (auth, workspaces, shares, activity) | Manual `queryClient.invalidateQueries()` on mutations |
| **React `useMemo`** | Derived view arrays (e.g. `flatNodes`) | Recomputed when dependencies change |
| **`WorkspaceStoreClient` subscription list** | Per-subscriber callbacks | Removed on unmount |

There is no separate in-memory graph cache beyond the SQLite database itself.

---

## 7. Synchronization

### Local SQLite

The worker owns one `sql.js` `Database` per workspace. It is serialised to a `Uint8Array` and persisted to IndexedDB periodically / on close. On load the worker imports the bytes and checks `PRAGMA user_version` to run migrations.

### Sync protocol

- **Push**: `SyncEngine.push()` queries pending operations from `sync_outbox` (those with HLC greater than the pushed watermark), batches them into encrypted envelopes, sends them via `Transport`, and marks acknowledged ids. Failed operations record `attempt_count` and `next_retry_at`.
- **Pull**: `SyncEngine.pull()` fetches the latest snapshot. If the server's `restore_epoch` changed, local derived state and the operation log are cleared and rebuilt from the server. Otherwise, or if the snapshot is newer, the snapshot is restored and then newer operations are fetched with `catchUp()` and applied in one `applyMany` worker batch.
- **Conflict detection**: after pulling, remote operations are compared against still-pending local operations on the same affected nodes via `detectConflicts()`.

### Operation log

Operations are immutable, ordered by HLC. The backend stores them encrypted and serves them in HLC order.

### Batching / optimistic updates

- The worker exposes `startBatch`/`endBatch` so many remote operations can be applied in one transaction, emitting notifications only at the end.
- Local mutations create operations and apply them immediately in the worker, so the UI sees the change synchronously before sync runs.

---

## 8. AI architecture

The frontend local-first core does not currently contain embeddings, vector search, or an AI retrieval pipeline. The backend has an `app/features/agents/` service, but AI-driven graph access is not part of the client read path described here. Any future AI work would likely query the same GraphQuery layer and operate on `NodeSummary` / `LinkedReference` projections rather than hydrating full subtrees.

---

## 9. Performance

### Largest tables

- `operation` – unbounded, capped server-side by compaction/snapshots.
- `node` – one row per page/block.
- `edge` – one row per reference.
- `property_value` – one row per property instance/value index.
- `search_index` – FTS4 index over all active node text.

### Slowest / heaviest queries

- **`GetLinkedReferencesQuery`**: still compiles a QueryAST that may scan or join against `edge`. It returns only ids, but for a page with thousands of backlinks the ID list can be large. Hydration is deferred until expansion.
- **Full `rebuildNodeStats()`**: acceptable because it runs inside SQLite in a single query, but full rebuilds happen only on schema upgrade or hard reset.
- **Legacy `projectNode(..., depth > 0)`**: recursive child projection is expensive. The new `useBlockTree` path avoids this by using `GetNodeTreeQuery` + batch projection of visible ids only.

### N+1 removed

- `useBlockTree` previously fetched children per node via repeated worker round-trips. It now fetches the whole subtree in one `GetNodeTreeQuery`.
- `useLinkedReferences` previously hydrated every backlink on page load. It now fetches IDs lazily and hydrates only visible rows.

### Remaining bottlenecks

- Large linked-reference lists are not virtualized; rendering thousands of rows can still stress React.
- `HydrateLinkedReferencesQuery` calls `projectNode()` per source id, which still resolves properties and class metadata.
- Global TanStack Query invalidations for server-state queries can refetch more than necessary.

---

## 10. Important source files

| File | Responsibility |
|------|----------------|
| `frontend/src/core/graphQueries/GraphQuery.ts` | Base query-object contract |
| `frontend/src/core/graphQueries/queryRegistry.ts` | Name → query dispatch registry |
| `frontend/src/core/graphQueries/queries/GetLinkedReferencesQuery.ts` | Linked-reference ID query |
| `frontend/src/core/graphQueries/queries/HydrateLinkedReferencesQuery.ts` | Linked-reference view-model hydration |
| `frontend/src/core/graphQueries/queries/GetNodeTreeQuery.ts` | Recursive subtree query |
| `frontend/src/core/graphQueries/queries/GetBacklinksQuery.ts` | Backlink id/count query |
| `frontend/src/core/graphQueries/hooks/useGraphQuery.ts` | React hook over worker queries |
| `frontend/src/core/projections/NodeSummaryProjection.ts` | Lightweight node summary |
| `frontend/src/core/projections/NodeTreeProjection.ts` | Flatten recursive tree rows |
| `frontend/src/core/projections/LinkedReferenceProjection.ts` | Build `LinkedReference` view models |
| `frontend/src/core/derived/nodeStats.ts` | Materialized count rebuild |
| `frontend/src/core/derived/edge.ts` | Reference extraction and edge rebuild |
| `frontend/src/core/derived/index.ts` | Operation applier dispatcher and notifications |
| `frontend/src/core/db/schema.ts` | SQLite schema and migrations |
| `frontend/src/core/query/queryNodes.ts` | QueryAST / search execution |
| `frontend/src/core/worker/workspaceWorker.ts` | Web Worker message dispatch |
| `frontend/src/core/worker/WorkspaceStoreClient.ts` | Main-thread client proxy |
| `frontend/src/core/worker/workerProtocol.ts` | Worker message types and notification scopes |
| `frontend/src/core/store.ts` | Worker-side WorkspaceStore API |
| `frontend/src/core/sync.ts` | SyncEngine push/pull/conflict logic |
| `frontend/src/features/content/hooks/useBlockTree.ts` | Block tree React hook |
| `frontend/src/features/content/hooks/useNodeLinkQueries.ts` | Linked-reference hooks |
| `frontend/src/features/content/hooks/useLinkedReferencesCount.ts` | Count badge hook |
| `frontend/src/features/content/components/nodes/QuerySection.tsx` | Collapsible section wrapper |
| `frontend/src/features/content/components/nodes/QueryNodeCollection.tsx` | Query-backed collection renderer |

---

## Architecture summary

Notees is a local-first note app where an immutable server-side operation log is replayed into a client-side SQLite database inside a Web Worker. The UI reads from that derived database through a thin **GraphQuery** layer: named query objects (`GetBacklinksQuery`, `GetLinkedReferencesQuery`, `GetNodeTreeQuery`, etc.) return lightweight IDs or rows, while separate **projections** hydrate only the visible rows into view models. This split, plus a materialized `node_stats` table, makes it cheap to show backlink counts and collapse linked-reference sections by default. When a user expands a section, only the first page of source ids is fetched and then hydrated, rather than projecting the entire backlink graph on page load.

The block tree rendering path now fetches the whole visible subtree in a single recursive `GetNodeTreeQuery` and batch-projects the legacy `Node` shape for exactly the visible ids, removing the previous per-child worker round-trip N+1.

Appliers in `frontend/src/core/derived/` apply operations to SQLite and emit scoped change notifications (`node`, `edge`, `tree`, `class`, `property`, `all`). `useGraphQuery` subscribes to those notifications and only re-runs queries whose `shouldInvalidate` matches, reducing global re-renders.

Writes remain optimistic: local operations are applied immediately in the worker, then pushed to the FastAPI backend in batches. Pulls apply remote operations in a single worker batch, restore snapshots when available, and detect semantic conflicts against pending local edits.

The result is a projection-driven read layer on top of the existing operation-log foundation, keeping the source of truth unchanged while making pages with thousands of linked references open quickly.
