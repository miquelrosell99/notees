---
status: done
distilled_to:
  - rules/coding-standards.md
  - references/gotchas.md
---

# Plan: Promote inline links to a real `node_link` registry

## Goal

Make every inline `node_link` pill a first-class, stable instance that:
- has a persistent UUID minted at creation time,
- is stored in a dedicated `node_link` table,
- supports navigation metadata (`click_count`, `last_navigated_at`),
- supports instance-level counts ("how many times a page has been linked"),
- supports lazy self-healing when the AST's embedded target UUID drifts from the registry.

After this change, surfaces must never display a node link as "…" because the link UUID can always be resolved to its current target.

## Identifier contract

- AST `link_id` format stays `targetUuid:linkUuid`.
- `linkUuid` is the canonical key for the link instance.
- `targetUuid` is recovery metadata; it is updated lazily when it differs from `node_link.target_id`.
- Legacy links with bare `targetUuid` get a stable `linkUuid` assigned during migration.

## Table shape

A single `node_link` table in both backend and frontend derived SQLite:

```sql
CREATE TABLE node_link (
    id TEXT PRIMARY KEY,              -- linkUuid from AST
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,          -- node containing the link pill
    target_id TEXT NOT NULL,          -- current target node
    type TEXT NOT NULL,               -- 'node' | 'class' | 'embed' | 'user'
    label TEXT,                       -- optional custom label from AST
    click_count INTEGER DEFAULT 0,
    last_navigated_at TEXT,
    created_at TEXT,
    updated_at TEXT
);
CREATE INDEX idx_node_link_source ON node_link(source_id);
CREATE INDEX idx_node_link_target ON node_link(target_id);
CREATE INDEX idx_node_link_source_target ON node_link(source_id, target_id);
```

The existing `edge` table is kept as a derived projection of `node_link` for graph-style queries that need a deduplicated source→target relation. All backlink, reference-count, instance-count, and graph-view queries read from `node_link` (using `DISTINCT` where a simple graph projection is needed). `edge` is maintained by the same appliers that populate `node_link`.

`node_link` does **not** contain parent-child relationships or class-extends relationships; those keep their own tables.

## Fan-out targets

### Backend

| File | Change |
|------|--------|
| `app/db/schema/sql.py` | Add `node_link` DDL to PostgreSQL schema (for fresh installs). |
| `app/db/schema/constants.py` | Bump `SCHEMA_VERSION`. |
| `app/db/schema/init.py` | Add idempotent migration callback that creates `node_link` on existing databases; register legacy-link normalizer. |
| `app/core/derived/schema.py` | Add `node_link` table to backend derived SQLite. |
| `app/core/derived/edge.py` | `rebuild_edges_for_node` now also upserts `node_link` rows from AST link UUIDs; `edge` rows remain as a deduplicated projection. |
| `app/core/derived/node.py` | `apply_node_delete` deletes `node_link` rows where `source_id` or `target_id` matches. |
| `app/core/derived/link.py` | `apply_link_click` updates `click_count`/`last_navigated_at` on `node_link` by `linkUuid`, falling back to source+target. |
| `app/core/derived/nodeStats.py` | Rebuild `backlink_count` and `reference_count` from `node_link`. |
| `app/core/workspace_store.py` | `record_link_click` accepts `link_uuid`; emits `link.click` payload with `sourceNodeId`, `targetNodeId`, `linkUuid`. |
| `app/features/activity/router.py` | `LinkClickRequest` accepts `node_link_uuid`; endpoint forwards it; responses include it. |
| `app/core/operation.py` | Update `link.click` validation to allow `linkUuid`. |
| `app/core/validation.py` | Allow `linkUuid` in `link.click` payload. |
| `app/db/migrations/normalize_node_link_uuids.py` | One-time migration that scans all operation-log payloads, assigns stable `linkUuid`s to bare `targetUuid` links, and rewrites payloads. |
| `app/core/derived/search.py` / `node_projection.py` / `queryHelpers.py` | Migrate any `edge` queries to `node_link`. |
| `app/features/workspaces/repository.py` | Export query reads from `node_link`. |

### Frontend

| File | Change |
|------|--------|
| `frontend/src/core/db/schema.ts` | Add `node_link` table; bump `user_version` to trigger rebuild. |
| `frontend/src/core/derived/edge.ts` | `rebuildEdgesForNode` becomes `rebuildNodeLinksForNode`; upserts `node_link` rows from AST; keeps `edge` projection. |
| `frontend/src/core/derived/node.ts` | `applyNodeOperation` for `node.delete` deletes `node_link` rows. |
| `frontend/src/core/derived/link.ts` | `applyLinkOperation` updates `node_link` metadata by `linkUuid`. |
| `frontend/src/core/derived/nodeStats.ts` | Rebuild stats from `node_link`. |
| `frontend/src/core/store.ts` | Bump `CURRENT_DERIVED_STATE_VERSION`; update `resetDerivedState` to drop `node_link`. |
| `frontend/src/core/derived/index.ts` | Update imports; ensure ordering still works. |
| `frontend/src/lib/astBuilder.ts` | Keep `buildLinkId` / `parseLinkId`; ensure legacy bare UUIDs are handled. |
| `frontend/src/core/worker/queryHelpers.ts` | Migrate `edge` queries to `node_link`. |
| `frontend/src/core/adapters/nodeProjection.ts` | Migrate `edge` usage to `node_link`. |
| `frontend/src/core/store.ts` | `resolveAndHealNodeLink` resolves `linkUuid`, queries `node_link`, and triggers AST self-heal if target differs. |
| `frontend/src/core/derived/linkHealing.ts` | Pure helper for lazy AST self-healing. |
| `frontend/src/features/views/components/DocumentView.tsx` | Navigation handler resolves `linkUuid`, queries `node_link`, tracks click, triggers AST self-heal if target differs. |
| `frontend/src/features/views/components/ListView.tsx` | Same navigation/self-heal/tracking logic. |
| `frontend/src/features/content/components/blocks/BlockRow.tsx` | Same. |
| `frontend/src/features/content/components/editor/InlineContentStatic.tsx` | Same. |
| `frontend/src/features/content/components/nodes/NodeCellEditable.tsx` | Same. |
| `frontend/src/features/content/api/activity.ts` | `trackLinkClick` accepts and sends `nodeLinkUuid`. |
| `frontend/src/features/content/hooks/useActivity.ts` | Pass through `nodeLinkUuid`. |

## Migration strategy

1. **Backend one-time operation-log rewrite** (`app/db/migrations/normalize_node_link_uuids.py`):
   - Scan every `node.create` / `node.updateContent` payload in `relay_envelope`.
   - For every `node_link` AST node:
     - If `link_id` is bare `targetUuid`, generate a UUIDv7 `linkUuid` and rewrite to `targetUuid:linkUuid`.
     - Preserve existing `targetUuid:linkUuid` links as-is.
   - Save rewritten payloads back to `relay_envelope`.
   - This makes the operation log self-describing with stable link UUIDs.

2. **Derived-state rebuild**:
   - Frontend: bump `CURRENT_DERIVED_STATE_VERSION` and `user_version` so client SQLite rebuilds `node_link` from the operation log.
   - Backend: derived SQLite rebuilds automatically on next `sync()` because `applied_operation_id` is cleared when schema/applier changes are detected.

## Link creation

No change to the editor: it already calls `nodeLink(buildLinkId(nodeUuid, generateUUID()), refType)`. The `generateUUID()` result becomes the stable `linkUuid`.

Backends that construct ASTs (imports, migrations, seeds) must also generate a `linkUuid` per link instance.

## Navigation / click flow

1. User clicks a pill with `link_id = "targetUuid:linkUuid"`.
2. Frontend parses `linkUuid`.
3. Query `node_link` in the local worker SQLite by `id = linkUuid` to get `target_id`.
4. If `target_id != targetUuid` from the AST, emit a `node.updateContent` operation that rewrites the pill's `link_id` to `"target_id:linkUuid"`.
5. Call `trackLinkClick(sourceUuid, target_id, linkUuid)`.
6. Navigate to `target_id`.

If the `node_link` row is missing, fall back to `targetUuid` from the AST and recreate the `node_link` row on the next edge rebuild.

## node_link derivation algorithm

```python
def rebuild_node_links_for_node(conn, op):
    node_id = op.payload["nodeId"]
    content = json.loads(conn.execute("SELECT content FROM node WHERE id = ?", (node_id,)).fetchone()[0])
    desired = extract_node_links(content)  # list of {link_uuid, target_uuid, type, label}

    desired_ids = {link.link_uuid for link in desired}

    # Upsert current links
    for link in desired:
        conn.execute('''
            INSERT INTO node_link (id, workspace_id, source_id, target_id, type, label, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                target_id = excluded.target_id,
                type = excluded.type,
                label = excluded.label,
                updated_at = excluded.updated_at
        ''', (link.link_uuid, workspace_id, node_id, link.target_uuid, link.type, link.label, ts, ts))

    # Delete stale link instances no longer in the AST
    existing_ids = {row["id"] for row in conn.execute("SELECT id FROM node_link WHERE source_id = ?", (node_id,))}
    for stale_id in existing_ids - desired_ids:
        conn.execute("DELETE FROM node_link WHERE id = ?", (stale_id,))
```

Frontend mirrors this in TypeScript.

## Counts from node_link

```sql
-- How many distinct pages/blocks link to X
SELECT COUNT(DISTINCT source_id) FROM node_link WHERE target_id = 'X';

-- How many link pills point to X ("how many times X has been linked")
SELECT COUNT(*) FROM node_link WHERE target_id = 'X';

-- Total clicks from A to B
SELECT SUM(click_count) FROM node_link WHERE source_id = 'A' AND target_id = 'B';

-- Graph view edges (deduplicated on the fly)
SELECT DISTINCT source_id, target_id FROM node_link WHERE type = 'node';
```

## Tests

- Backend:
  - `tests/core/derived/test_node_link.py` (new): verify `rebuild_node_links_for_node` creates `node_link` rows with AST link UUIDs.
  - Test migration of bare `targetUuid` to `targetUuid:linkUuid`.
  - Test `apply_link_click` updates `node_link` metadata by `linkUuid`.
- Frontend:
  - `frontend/src/core/derived/__tests__/linkHealing.test.ts` (new): verify lazy AST healing logic.
  - `frontend/src/core/derived/__tests__/nodeLink.test.ts` (new): verify `rebuildNodeLinksForNode` populates `node_link`.
  - Update existing breadcrumb/display tests if needed.

## Verification

1. `docker compose -f compose.dev.yaml exec backend uv run ruff check app/`
2. `docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov`
3. `docker compose -f compose.dev.yaml exec frontend npm run lint`
4. `docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit`
5. `cd frontend && npm run test:run`
6. Rebuild dev stack and confirm in browser that:
   - New node links get stable UUIDs.
   - Breadcrumbs no longer show "…" for link-only parent blocks.
   - Link click counts increment per instance.
   - Reference/backlink counts reflect true instance counts.
