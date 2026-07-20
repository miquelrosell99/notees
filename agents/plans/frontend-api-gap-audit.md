# Frontend → Backend API Gap Audit

**Date:** 2026-07-20
**Context:** After removing browser-side operation-log encryption and switching the dev frontend to plain HTTP, the app loads but several features still call legacy backend endpoints that no longer exist. This audit lists the gaps and the implementation plan to close them without stubs or bridges.

## Audit method

1. Listed all mounted backend routes from `app.main`.
2. Listed all frontend API callers (`frontend/src/api/*.ts` and direct `api.*` calls in features).
3. Compared the two sets and exercised the running app to confirm failures.

## Findings

### Gap 1: Properties API — entirely missing

`frontend/src/api/properties.ts` defines ~20 endpoints under `/properties`. None are mounted in the backend. The frontend still calls:

- `GET /properties/` — list all property schemas
- `GET /properties/available` — available properties for a node
- `POST /properties/` — create property schema
- `GET|PUT|DELETE /properties/{uuid}` — CRUD
- `POST|PUT|DELETE /properties/{uuid}/selection-lines/*` — selection options
- `POST|DELETE /properties/{uuid}/class-filters/*` — class filters
- `GET|POST|DELETE|PUT|PATCH /properties/classes/{classUuid}/properties/*` — class-property edges
- `GET /properties/classes/{classUuid}/extends` / `/inherited-properties` / `/extended-by` — class inheritance
- `POST /properties/classes/{classUuid}/validate-extends`
- `POST /properties/classes/batch/properties`
- `POST /properties/batch/set`
- `GET /properties/{uuid}/nodes`
- `GET /properties/stats`
- `GET /properties/suggestions`

In the new architecture, property schemas and class-property relationships should be stored as operations (`propertySchema.create`, `propertySchema.update`, `class.create`, `class.update`) and derived into the SQLite core store. The frontend should read from `WorkspaceStore` instead of calling these endpoints.

### Gap 2: Node views API — entirely missing

`frontend/src/api/nodeViews.ts` defines ~15 endpoints under `/nodes/views`. None are mounted. The frontend still calls:

- `GET /nodes/views` — list views for a node
- `GET /nodes/views/{uuid}` — get a view
- `GET /nodes/views/default/{nodeUuid}/{viewType}` — default view
- `POST /nodes/views` — create view
- `PUT /nodes/views/{uuid}` — update view
- `PUT /nodes/views/{uuid}/query-ast` — update query AST
- `DELETE /nodes/views/{uuid}` — delete view
- `POST /nodes/views/{uuid}/duplicate`
- `POST /nodes/views/reorder/{nodeUuid}/{viewType}`
- `POST /nodes/views/{uuid}/execute` — execute a saved view
- `POST /nodes/views/execute` — execute ad-hoc query
- `POST /nodes/views/count`
- `POST /nodes/views/ensure-defaults/{nodeUuid}`
- `POST /nodes/views/reset/{nodeUuid}`
- `POST /nodes/views/parse`

Views should become first-class operation-log entities (new operation types `view.create`, `view.update`, `view.delete`, `view.reorder`) and live in the SQLite core store. Query execution can reuse the existing client-side QueryAST compiler/executor.

### Gap 3: Flashcards plugin routes — not mounted

`frontend/src/api/flashcards.ts` calls `/plugins/notees.flashcards/flashcards/*`. The plugin is listed as built-in and `enabled_by_default`, but no flashcard routes appear in the mounted route list. Either the plugin loader is skipping it or the router registration is failing silently.

### Verified working

The following backend routes are mounted and responding:

- Auth (`/api/auth/*`)
- Workspaces (`/api/workspaces/*`)
- Tasks (`/api/tasks/*`)
- Export / auto-export (`/api/export/*`, `/api/auto-export/*`)
- Assets (`/api/assets/*`)
- Activity (`/api/activity/*`)
- Undo (`/api/undo/*`)
- Shares (`/api/shares/*`, `/api/nodes/{uuid}/shares`, `/api/nodes/{uuid}/user-shares`)
- Notifications (`/api/notifications/*`)
- Relay (`/api/relay/*`)
- Plugins meta (`/api/plugins/*`)

## Implementation plan

### Phase A: Class properties in the operation-log core

1. **Schema**
   - Add `property_schema` table to `frontend/src/core/db/schema.ts` and backend derived schema.
   - Add `class_property_edge` table (or derive from property schema `class_filter_uuids` / `node_uuid`).
2. **Operations**
   - Ensure `propertySchema.create` and `propertySchema.update` payloads cover all property fields (type, options, default, validation, icon, class filters, etc.).
   - Add appliers that write to `property_schema` and `class_property_edge`.
3. **Frontend adapters**
   - Replace `useClassPropertiesLegacy` with a core-store query.
   - Replace property-schema CRUD hooks (`usePropertyMutations`, `useClassPropertyMutations`) with operations.
   - Update `usePropertySchemas` to read from `property_schema` table.
4. **Cleanup**
   - Delete or deprecate `frontend/src/api/properties.ts` once all callers are migrated.

### Phase B: Node views in the operation-log core

1. **Schema**
   - Add `node_view` table to core SQLite schema.
2. **Operations**
   - Add `view.create`, `view.update`, `view.delete`, `view.reorder` operation types and payloads.
   - Add appliers that maintain `node_view`.
3. **Frontend adapters**
   - Replace `frontend/src/features/content/hooks/useNodeViews.*` with core-store queries and operations.
   - Implement `ensureDefaultViews` and `resetNodeViews` client-side by generating default view operations.
   - Route `executeNodeViewQuery` and `executeQuery` through the existing client-side QueryAST executor.
   - Keep `parseQueryLanguage` if it can be done client-side; otherwise remove the feature.
4. **Cleanup**
   - Delete `frontend/src/api/nodeViews.ts`.

### Phase C: Flashcards plugin

1. Investigate why `notees.flashcards` routes are not mounted.
2. Fix plugin loader/router registration.
3. Verify `GET/POST /plugins/notees.flashcards/flashcards/*` respond.

### Verification

- `cd frontend && npm run lint && npx tsc -b --noEmit && npm run test:run`
- `uv run pytest tests/core tests/unit -m unit --no-cov -q`
- Manual browser check over `http://atlas:5173` with no 404/405 errors in the console.

## Open questions

- Should property schemas be scoped per-workspace or global? The legacy API suggests global with per-workspace class edges. The operation-log model naturally scopes everything by workspace; global schemas may need system-class treatment.
- Should views be children of the node they belong to (using `parent_id`) or a separate `node_view` table? A separate table with `node_id` is simpler for reordering and metadata.
