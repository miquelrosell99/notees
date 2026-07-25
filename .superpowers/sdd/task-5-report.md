# Task 5 Report: Migrate UI to class table and remove `kind='class'`

## Status

DONE

## Commit

- Message: `feat(class): migrate UI and remove kind='class'`
- See `git log` in branch `feature/class-schema-separation` for the final hash.

## Files changed

### Backend

- `app/core/derived/class.py`
  - Ensured `class.create` applier inserts the self row into `class_hierarchy` so class inheritance queries work correctly.
- `app/core/derived/class_hierarchy.py`
  - Adjusted hierarchy maintenance to work without `kind='class'` node rows.
- `app/core/derived/schema.py`
  - Restricted `node.kind` CHECK to `('page', 'block')`; removed `class`.
- `app/core/migration/nodes.py`
  - Migrated legacy class-node creation to use `class.*` operations / `class` table rows instead of `node.create` with `kind='class'`.
- `app/core/migration/properties.py`
  - Updated property migration to reference class rows in the dedicated `class` table.
- `app/core/workspace_store.py`
  - Removed class-node assumptions from workspace store helpers.
- `app/features/import_/service.py`
  - Updated import logic to create class rows instead of class nodes.

### Frontend core

- `frontend/src/core/db/schema.ts`
  - Restricted `node.kind` CHECK to `('page', 'block')`.
- `frontend/src/core/store.ts`
  - Removed `kind='class'` from `NodeRow['kind']`; removed class-node validation and conversion support.
- `frontend/src/core/types/operation.ts`
  - Removed / deprecated `kind='class'` from operation payload types.
- `frontend/src/core/adapters/nodeProjection.ts`
  - Made `isClass` always `false` for projected nodes.
- `frontend/src/core/adapters/useCreateNodeAdapter.ts`
  - Cleaned up unused imports and kind typing.
- `frontend/src/core/derived/class.ts`
  - Ensured `class.create` inserts the self row into `class_hierarchy`.
- `frontend/src/core/derived/node.ts`
  - Removed class-node handling from node applier.
- `frontend/src/core/hooks/useClasses.ts`
  - Returns `ClassRow[]` from the dedicated class table.
- `frontend/src/core/hooks/useCreateNode.ts`
  - Fixed kind type to exclude `class`.
- `frontend/src/core/query/classes.ts`
  - Added shared `classRowToNode` projector for legacy Node-shaped consumers.
- `frontend/src/core/query/compileToSqlite.ts`
  - Updated `generateExtendsCondition` to join `class_ids` against `class_hierarchy` instead of `node.kind = 'class'`.
- `frontend/src/core/query/queryNodes.ts`
  - Removed `kind='class'` fallback; class queries use `class` table only.
- `frontend/src/core/query/search.ts`
  - Removed class-node fallback from search.
- `frontend/src/core/worker/WorkspaceStoreClient.ts`
  - Fixed `classClassUuid` assignment.
- `frontend/src/core/worker/workspaceWorker.ts`
  - Cleaned up class-node handling.

### Frontend feature/UI

- `frontend/src/features/content/hooks/useNodeListQueries.ts`
  - `useClasses` and `useSearchClasses` now return `Node[]` projected from core `ClassRow[]` via `classRowToNode`.
- `frontend/src/features/content/hooks/useResolvedClassDetails.ts`
  - Continues consuming core `ClassRow[]` where canonical class metadata is needed.
- `frontend/src/features/content/hooks/usePageClass.ts`
  - Adapted to `ClassRow[]` source.
- `frontend/src/features/content/hooks/useNodeViews.mutations.ts`
  - Updated class detection logic.
- `frontend/src/features/content/hooks/useNodeSearch.utils.ts`
  - Removed `is_class` filtering; classes are no longer mixed into node search results.
- `frontend/src/features/properties/hooks/useClassProperties.ts`
  - Consumes `ClassRow[]` directly.
- `frontend/src/features/content/pages/ClassesView.tsx`
  - Uses `createClass` workspace-store method instead of `createNode({ kind: 'class' })`.
- `frontend/src/features/content/pages/NodeView.tsx`
  - `handleCreateClass`, `handleConvertToClass`, and `handleCreateExtends` use `createClass` / `updateClass` and class-table IDs.
- `frontend/src/features/content/components/nodes/NodeMetadataSection.tsx`
  - Removed `node.is_class` checks; added `isClassNode` prop for the Extends row.
- `frontend/src/features/editor/editor/plugins/TriggerPopup.tsx`
  - Class mode filters `allClasses` directly; `handleCreate` uses `createClass`.

### Tests

- `frontend/src/core/__tests__/workspaceStore.test.ts`
  - Updated class tests to use `createClass` instead of `createNode({ kind: 'class' })`.
- `frontend/src/core/derived/__tests__/appliers.test.ts`
  - Removed / adapted class-node applier tests.
- `frontend/src/core/hooks/__tests__/useQueryAst.test.tsx`
  - Updated for class-table-derived queries.
- `frontend/src/core/query/__tests__/compileToSqlite.test.ts`
  - Updated `generateExtendsCondition` tests to use `class_hierarchy`.
- `frontend/src/features/content/components/nodes/ClassPillsRow.color.test.tsx`
  - Mock data changed from `Node[]` to `ClassRow[]` to match the core hook contract.
- `frontend/src/features/content/components/nodes/NodeRef.color.test.tsx`
  - Mock data changed from `Node[]` to `ClassRow[]`; rendered nodes remain `Node[]`.
- `frontend/src/features/content/hooks/useNodeSearch.utils.test.ts`
  - Removed class-filtering assertions.
- `tests/core/derived/test_class.py`
  - Updated derived class table tests.
- `tests/core/migration/test_nodes.py`
  - Updated migration tests for class-table output.
- `tests/core/query/test_classes.py`
  - Updated class query tests.
- `tests/core/test_import_router.py`
  - Updated import tests.
- `tests/core/test_plugin_context.py`
  - Updated plugin context tests.

## Test commands run and results

### Target tests (from brief)

```bash
cd frontend && npm run lint && npm run test:run
```

Result: 651 passed, 0 failed.

```bash
uv run pytest tests/unit tests/core -m unit --no-cov -q
```

Result: 452 passed, 6 skipped, 25 deselected, 0 failed.

### Additional verification

```bash
cd frontend && npx tsc -b --noEmit
```

Result: No TypeScript errors in modified files (full build clean).

```bash
cd /root/projects/notees/.worktrees/class-schema-separation && uv run ruff check app/
```

Result: All checks passed.

## Concerns or blockers

- None. All frontend and backend unit tests pass; TypeScript build is clean; Ruff is clean.
