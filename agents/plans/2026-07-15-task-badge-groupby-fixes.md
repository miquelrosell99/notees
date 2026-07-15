# Task Badge + Group-By Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the missing task-status badge on blocks and in the Tasks view (three root causes: no optimistic runtime update after status mutations, non-workspace-scoped property UUID lookups causing cross-workspace data corruption, query results lacking properties), repair the contaminated data with a migration, and fix group-by-page having no effect in list mode.

**Architecture:** Backend: scope `PropertyRepository.get_by_uuid`/`get_by_uuids` to the repo's workspace (system properties are seeded per-workspace with identical UUIDs), validate selection-line ownership on write, and add an idempotent startup repair block in `app/db/schema/sql.py` (pattern from commit `a5283dc3`) that dedupes/remaps cross-workspace `node_property` rows. Frontend: optimistic `taskStatus` upserts in `useTaskActions`, `include_properties: true` in task view queries, and removal of the `showGroupByProp` gate in `NodeCollection` grouping.

**Tech Stack:** FastAPI + asyncpg + PostgreSQL 17, pytest; React 19 + TypeScript, Vitest + jsdom.

## Global Constraints

- Root causes documented in `.superpowers/sdd/task-badge-groupby-investigation.md` (not required reading — this plan is self-contained).
- Backend repo pattern: domain services use repository ports; DB access only via `app.db.connection` helpers. The repository already carries `self._workspace_id`.
- Idempotent repair blocks live in `app/db/schema/sql.py` as `DO $$ ... END $$;` statements that run at every startup (see the task-status block at lines 1971-2043); they must be safe to re-run (`IS DISTINCT FROM`-style guards / NOT EXISTS checks).
- Frontend tests run inside the dev container: `docker compose -f compose.dev.yaml exec frontend npx vitest run <file>` (host node_modules is stale). Backend tests: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/... --no-cov`.
- Commits follow Conventional Commits; stage only the files listed per task.
- Known contaminated rows in the dev DB (both node workspace 5, foreign property 2712 of workspace 14): `node_property` ids 12854, 12855. The Task 3 repair must clean them; Task 6 verifies.

---

### Task 1: Workspace-scope property UUID lookups

**Files:**
- Test: `tests/test_property_workspace_scoping.py` (new)
- Modify: `app/features/properties/repository.py:319-339`

**Interfaces:**
- Consumes: `self._workspace_id` (int) already on the repository; `acquire_connection(self._pool)`.
- Produces: `get_by_uuid(uuid)` / `get_by_uuids(uuids)` resolve to the current workspace's copy when duplicates share a UUID, falling back to `workspace_id IS NULL` properties; never to another workspace's copy.

Context: system properties are seeded per workspace with identical UUIDs (dev DB: 19 "Status" rows, same UUID, workspaces 5,12-29). A bare `WHERE uuid = $1` lookup resolves to an arbitrary copy, so property writes assign foreign-workspace properties to nodes.

- [ ] **Step 1: Write the failing test**

Create `tests/test_property_workspace_scoping.py`, mirroring the two-workspace fixtures/patterns in `tests/test_property_attributes.py` (read it first for the workspace/repo fixtures). Test cases:

```python
async def test_get_by_uuid_prefers_own_workspace_copy(...):
    # Given: two workspaces A and B; both have a "Status" property with the
    # same system UUID (seed per workspace, as in production).
    # When: repo_for_A.get_by_uuid(STATUS_UUID)
    # Then: returns workspace A's property row (id == A's Status id), not B's.

async def test_get_by_uuids_scopes_per_workspace(...):
    # Same setup; batch lookup from A returns A's copy only.

async def test_get_by_uuid_falls_back_to_null_workspace(...):
    # Given: a property with workspace_id NULL and no workspace-owned copy.
    # Then: get_by_uuid still resolves it.
```

If the test fixtures do not already create two workspaces with duplicate-UUID system properties, seed them the way `tests/test_property_attributes.py`'s two-workspace regression test does.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/test_property_workspace_scoping.py --no-cov -v`
Expected: FAIL — lookup returns the other workspace's copy (or an arbitrary one).

- [ ] **Step 3: Scope the lookups**

In `app/features/properties/repository.py`, replace `get_by_uuid`:

```python
    async def get_by_uuid(self, uuid: str) -> Property | None:
        """Get property by UUID, preferring this workspace's copy.

        System properties are seeded per workspace with identical UUIDs, so a
        bare UUID lookup can resolve to another workspace's copy and corrupt
        writes. Prefer the row owned by this workspace; fall back to
        workspace-agnostic (NULL) rows.
        """
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT id FROM property
                WHERE uuid = $1 AND active = TRUE
                  AND (workspace_id = $2 OR workspace_id IS NULL)
                ORDER BY (workspace_id = $2) DESC, id
                LIMIT 1
                """,
                uuid,
                self._workspace_id,
            )
            if not row:
                return None
            return await self.get_by_id(row["id"])
```

Replace the fetch in `get_by_uuids`:

```python
            rows = await conn.fetch(
                """
                SELECT DISTINCT ON (uuid) *
                FROM property
                WHERE uuid = ANY($1) AND active = TRUE
                  AND (workspace_id = $2 OR workspace_id IS NULL)
                ORDER BY uuid, (workspace_id = $2) DESC, id
                """,
                uuids,
                self._workspace_id,
            )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/test_property_workspace_scoping.py --no-cov -v`
Expected: PASS.

- [ ] **Step 5: Run the property test suites**

Run: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/test_property_attributes.py tests/test_properties.py tests/test_property_workspace_scoping.py --no-cov`
Expected: all PASS (scoping must not break existing behavior).

- [ ] **Step 6: Commit**

```bash
git add tests/test_property_workspace_scoping.py app/features/properties/repository.py
git commit -m "fix(properties): scope UUID lookups to the repository workspace"
```

---

### Task 2: Validate selection-line ownership on write

**Files:**
- Test: `tests/test_property_workspace_scoping.py` (append)
- Modify: `app/features/properties/service.py:634-649`

**Interfaces:**
- Consumes: `self._property_repo.get_selection_line_by_uuid(item)` returning a line with `id` and `property_id`.
- Produces: `resolve_property_value` raises `ValueError` when a selection line UUID resolves to a line of a different property; the REST layer maps it to a 4xx (verify existing mapping — ValueError is already translated to 400 in the values router per prior work).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_property_workspace_scoping.py`:

```python
async def test_set_property_rejects_foreign_selection_line(...):
    # Given: workspaces A and B, both with a "Status" selection property.
    # When: POST /nodes/{node_in_A}/properties sets A's Status property UUID
    #       with a selection-line UUID that belongs to B's Status property.
    # Then: 4xx response; no node_property row created for node_in_A.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/test_property_workspace_scoping.py::test_set_property_rejects_foreign_selection_line --no-cov -v`
Expected: FAIL — the write succeeds (or resolves) today. (After Task 1, the property lookup itself is scoped, so simulate the exact corruption path: pass a line UUID of the other workspace's property with the *owning* property UUID of the current workspace.)

- [ ] **Step 3: Add the ownership check**

In `app/features/properties/service.py`, inside `resolve_property_value`, change `_resolve_selection_item`:

```python
            async def _resolve_selection_item(item: Any) -> int:
                if isinstance(item, int):
                    return item
                if isinstance(item, str):
                    line = await self._property_repo.get_selection_line_by_uuid(item)
                    if line is None or line.id is None:
                        raise PropertyNotFoundError(f"Selection line {item} not found")
                    if line.property_id != prop.id:
                        raise ValueError(
                            f"Selection line {item} does not belong to property {prop.uuid}"
                        )
                    return line.id
                raise ValueError(
                    f"Selection property expects selection line UUID or array of UUIDs, got {type(item)}"
                )
```

- [ ] **Step 4: Run tests**

Run: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/test_property_workspace_scoping.py tests/test_property_attributes.py tests/test_properties.py --no-cov`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_property_workspace_scoping.py app/features/properties/service.py
git commit -m "fix(properties): reject selection lines of another property on write"
```

---

### Task 3: Repair cross-workspace node_property data (idempotent migration)

**Files:**
- Modify: `app/db/schema/sql.py` (append a `DO $$ ... END $$;` block immediately before the closing `"""` at line 2044)
- Test: `tests/test_property_workspace_scoping.py` (append)

**Interfaces:**
- Consumes: schema pattern of the task-status repair block (`app/db/schema/sql.py:1971-2043`); runs at every startup, must be idempotent.
- Produces: zero `node_property` rows whose property belongs to a different workspace than the node; selection values remapped by line name where possible.

Contamination model: per-workspace seeded properties (e.g. Status) share a UUID. Corrupted rows assign workspace B's property (and possibly B's selection lines) to workspace A's node. Two cases: (1) the node also has its own workspace's assignment of the same property UUID — the foreign row is a duplicate: delete it; (2) only the foreign assignment exists — remap it to the node's own workspace copy (remapping selection values by line name; values with no same-named line are dropped). If no own-workspace property copy exists at all, delete the unreadable row and `RAISE NOTICE` a count.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_property_workspace_scoping.py`:

```python
async def test_startup_repair_cleans_cross_workspace_assignments(...):
    # Given: node in workspace A carrying (a) a duplicate assignment of
    # workspace B's Status property while A's own assignment exists, and
    # (b) a second node whose only Status assignment points at B's property
    # with a same-named selection line ("Done").
    # When: the schema repair SQL is applied (re-run the schema/repair routine
    #       the same way tests for the task-status repair do).
    # Then: (a) foreign node_property row gone, own assignment untouched;
    #       (b) assignment re-pointed to A's property with value "Done";
    #       detection query returns 0 rows:
    #       SELECT count(*) FROM node_property np
    #       JOIN node n ON n.id = np.node_id
    #       JOIN property p ON p.id = np.property_id
    #       WHERE p.workspace_id IS NOT NULL AND p.workspace_id <> n.workspace_id
```

Mirror the approach used by the `a5283dc3` tests in `tests/test_property_attributes.py` for re-applying repair SQL.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/test_property_workspace_scoping.py -k repair --no-cov -v`
Expected: FAIL — contaminated rows survive.

- [ ] **Step 3: Add the repair block**

In `app/db/schema/sql.py`, append immediately before the closing `"""`:

```sql
-- Migration: repair node_property rows that reference another workspace's
-- copy of a per-workspace seeded property (e.g. Status). Writes once resolved
-- property UUIDs without workspace scoping, so nodes could end up with
-- foreign-workspace property assignments. Idempotent: re-runs are no-ops.
DO $$
DECLARE
    deleted_count integer;
BEGIN
    -- Case 1: node already has its own workspace's assignment of the same
    -- property UUID — the foreign assignment is a duplicate. Drop its values
    -- and the row.
    DELETE FROM property_value_selection pvs
    USING node_property np, node n, property p
    WHERE pvs.node_property_id = np.id
      AND np.node_id = n.id AND np.property_id = p.id
      AND p.workspace_id IS NOT NULL AND p.workspace_id <> n.workspace_id
      AND EXISTS (
          SELECT 1 FROM node_property own_np
          JOIN property own_p ON own_p.id = own_np.property_id
          WHERE own_np.node_id = n.id AND own_p.uuid = p.uuid
            AND (own_p.workspace_id = n.workspace_id OR own_p.workspace_id IS NULL)
      );

    DELETE FROM node_property np
    USING node n, property p
    WHERE np.node_id = n.id AND np.property_id = p.id
      AND p.workspace_id IS NOT NULL AND p.workspace_id <> n.workspace_id
      AND EXISTS (
          SELECT 1 FROM node_property own_np
          JOIN property own_p ON own_p.id = own_np.property_id
          WHERE own_np.node_id = n.id AND own_p.uuid = p.uuid
            AND (own_p.workspace_id = n.workspace_id OR own_p.workspace_id IS NULL)
      );

    -- Case 2: only the foreign assignment exists and the node's workspace has
    -- its own copy of the property — remap. Selection values are re-pointed
    -- to the same-named line of the workspace copy; unmatched values drop.
    UPDATE property_value_selection pvs
    SET selection_line_id = new_line.id,
        property_id = new_p.id
    FROM node_property np, node n, property old_p, property new_p,
         property_selection_line old_line, property_selection_line new_line
    WHERE pvs.node_property_id = np.id
      AND np.node_id = n.id AND np.property_id = old_p.id
      AND old_p.workspace_id IS NOT NULL AND old_p.workspace_id <> n.workspace_id
      AND new_p.uuid = old_p.uuid AND new_p.active = TRUE
      AND (new_p.workspace_id = n.workspace_id OR new_p.workspace_id IS NULL)
      AND old_line.id = pvs.selection_line_id
      AND new_line.property_id = new_p.id AND new_line.name = old_line.name;

    -- Drop selection values that could not be remapped by name (still tagged
    -- to the foreign property after the remap UPDATE above).
    DELETE FROM property_value_selection pvs
    USING node_property np, node n, property p
    WHERE pvs.node_property_id = np.id
      AND np.node_id = n.id AND np.property_id = p.id
      AND p.workspace_id IS NOT NULL AND p.workspace_id <> n.workspace_id
      AND pvs.property_id = p.id;

    UPDATE node_property np
    SET property_id = new_p.id
    FROM node n, property old_p, property new_p
    WHERE np.node_id = n.id AND np.property_id = old_p.id
      AND old_p.workspace_id IS NOT NULL AND old_p.workspace_id <> n.workspace_id
      AND new_p.uuid = old_p.uuid AND new_p.active = TRUE
      AND (new_p.workspace_id = n.workspace_id OR new_p.workspace_id IS NULL)
      AND NOT EXISTS (
          SELECT 1 FROM node_property own_np
          WHERE own_np.node_id = n.id AND own_np.property_id = new_p.id AND own_np.id <> np.id
      );

    -- Case 3: final sweep — anything still cross-workspace here either has no
    -- own-workspace property copy (unreadable in the node's workspace) or was
    -- skipped by the remap guard because a duplicate assignment exists.
    -- Delete it (values first) and report.
    DELETE FROM property_value_selection pvs
    USING node_property np, node n, property p
    WHERE pvs.node_property_id = np.id
      AND np.node_id = n.id AND np.property_id = p.id
      AND p.workspace_id IS NOT NULL AND p.workspace_id <> n.workspace_id;

    DELETE FROM node_property np
    USING node n, property p
    WHERE np.node_id = n.id AND np.property_id = p.id
      AND p.workspace_id IS NOT NULL AND p.workspace_id <> n.workspace_id;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    IF deleted_count > 0 THEN
        RAISE NOTICE 'Removed % remaining cross-workspace node_property rows', deleted_count;
    END IF;
END $$;
```

Note for the implementer: verify `property_value_selection` has no other value-table siblings for non-selection types that also key `node_property_id` (check the schema for `property_value_*` tables); if relation/date/etc. value tables exist, extend the DELETE statements to cover them in the same order (values first, then `node_property`).

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/test_property_workspace_scoping.py -k repair --no-cov -v`
Expected: PASS. Then run the full backend suite: `docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov` — all PASS.

- [ ] **Step 5: Apply to the dev database and verify the known rows are gone**

Restart the backend so the startup repair runs: `docker compose -f compose.dev.yaml up -d --force-recreate backend` (or `docker compose -f compose.dev.yaml restart backend`).
Then:
```bash
docker compose -f compose.dev.yaml exec postgres psql -U notees -d notees -c "SELECT np.id, np.node_id, n.workspace_id, np.property_id, p.workspace_id AS prop_ws FROM node_property np JOIN node n ON n.id = np.node_id JOIN property p ON p.id = np.property_id WHERE p.workspace_id IS NOT NULL AND p.workspace_id <> n.workspace_id;"
docker compose -f compose.dev.yaml exec postgres psql -U notees -d notees -c "SELECT id, node_id, property_id FROM node_property WHERE id IN (12854, 12855);"
```
Expected: first query 0 rows; second query 0 rows.

- [ ] **Step 6: Commit**

```bash
git add app/db/schema/sql.py tests/test_property_workspace_scoping.py
git commit -m "fix(schema): repair cross-workspace node_property assignments at startup"
```

---

### Task 4: Optimistic taskStatus updates + properties in task queries

**Files:**
- Modify: `frontend/src/features/tasks/hooks/useTaskActions.ts` (applyTaskStatus, clearTask, openTask)
- Test: `frontend/src/features/tasks/hooks/useTaskActions.test.ts` (extend)
- Modify: `frontend/src/features/tasks/hooks/useTasks.ts:16-25`
- Test: `frontend/src/features/tasks/hooks/useTasks.test.ts` (new)
- Modify: `frontend/src/features/content/hooks/useLazyChildren.ts:44-47` (`include_properties: false` → `true`)

**Interfaces:**
- Consumes: `getOperationRuntime()` / `getNode(runtime, uuid)` from `@/runtime` and `@/runtime/graphHelpers`; the runtime's public `upsertNodes` API (`OperationRuntime.ts:53-61`); `resolveTaskStatusIds` in the same file.
- Produces: after `applyTaskStatus(status)` / `openTask()` / `clearTask()`, the runtime graph node's `taskStatus` reflects the change immediately (badge appears/updates without a tree refetch); `useTasks` requests carry `include_properties: true`.

- [ ] **Step 1: Write the failing tests**

Extend `frontend/src/features/tasks/hooks/useTaskActions.test.ts` (read it first and follow its runtime-mocking pattern):

```ts
it('optimistically upserts taskStatus into the runtime when applying a status', async () => {
  // arrange: runtime graph node exists for the block; properties cache primed
  // act: applyTaskStatus('Done') via the exposed hook API (or cycleTaskStatus)
  // assert: getNode(runtime, uuid).taskStatus === 'Done' immediately
});

it('clears taskStatus in the runtime when clearing a task', async () => {
  // arrange: graph node with taskStatus 'Done'
  // act: clearTask() (or cycleTaskStatus from a closed status)
  // assert: getNode(runtime, uuid).taskStatus == null immediately
});
```

Create `frontend/src/features/tasks/hooks/useTasks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getQueryForTab } from './useTasks';

describe('getQueryForTab', () => {
  it.each(['all', 'today', 'future'] as const)('requests properties for the %s tab', (tab) => {
    expect(getQueryForTab(tab).include_properties).toBe(true);
  });
});
```

(Export `getQueryForTab` from `useTasks.ts` — it is currently module-private.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/useTaskActions.test.ts src/features/tasks/hooks/useTasks.test.ts`
Expected: FAIL — no runtime upsert happens; `include_properties` undefined.

- [ ] **Step 3: Implement the optimistic upserts**

In `useTaskActions.ts`:
- In `applyTaskStatus`, after `setProperty.mutate(...)`, upsert the runtime node:
```ts
const runtime = getOperationRuntime();
const gn = getNode(runtime, node.uuid);
if (gn) runtime.upsertNodes([{ ...gn, taskStatus: status }]);
```
- In `clearTask`, after `setProperty.mutate(...)`, upsert with `taskStatus: null` (same pattern).
- Verify the exact `upsertNodes` signature and the graph node type's `taskStatus` field in `frontend/src/runtime/types.ts` / `OperationRuntime.ts` before writing; adapt the spread to the real type. Also confirm `upsertNodes` emits the change event consumed by `BlockAfterContent` (eventBus change-detection for `taskStatus` exists at `frontend/src/runtime/eventBus.ts`).

In `useTasks.ts`, change `getQueryForTab` to include properties and export it:

```ts
export function getQueryForTab(tab: TaskTab): QueryExecuteRequest {
  switch (tab) {
    case 'all':
      return { query_ast: buildTasksQueryAST(), include_properties: true };
    case 'today':
      return { query_ast: buildTodayOverdueQueryAST(), include_properties: true };
    case 'future':
      return { query_ast: buildFutureQueryAST(), include_properties: true };
  }
}
```

In `useLazyChildren.ts`, change `include_properties: false` to `include_properties: true` (lazy-loaded subtrees currently wipe `taskStatus` on wholesale runtime upsert).

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/tasks/hooks/`
Expected: PASS.

- [ ] **Step 5: Type-check + focused regression run**

Run:
```bash
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/content/hooks/
```
Expected: clean / PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/tasks/hooks/useTaskActions.ts frontend/src/features/tasks/hooks/useTaskActions.test.ts frontend/src/features/tasks/hooks/useTasks.ts frontend/src/features/tasks/hooks/useTasks.test.ts frontend/src/features/content/hooks/useLazyChildren.ts
git commit -m "fix(tasks): optimistic taskStatus runtime updates, properties in task queries"
```

---

### Task 5: Group-by wiring in list mode

**Files:**
- Modify: `frontend/src/features/content/components/nodes/NodeCollection.tsx:346`
- Modify: `frontend/src/features/tasks/pages/TasksView.tsx` (pass `showGroupBy` to the `NodeCollection`, ~lines 142-155)
- Modify: `frontend/src/features/content/pages/TrashView.tsx:177`, `frontend/src/features/content/pages/ArchivedPagesView.tsx`, `frontend/src/features/templates/components/TemplateGallery.tsx:117` (pin `groupBy="none"` — verify exact paths/props before editing)
- Test: `frontend/src/features/content/components/nodes/NodeCollection.grouping.test.tsx` (new)

**Interfaces:**
- Consumes: existing `isGroupByActive`, `ListView`'s complete grouping implementation (`ListView.tsx:59-88, 317-415`), registry `capabilities.groupBy`.
- Produces: list-mode grouping depends only on `groupBy` being active — not on selector visibility; Tasks view shows the group-by selector; toolbar-hidden collections stay flat.

Root cause: `NodeCollection.tsx:346` gates grouping on `showGroupByProp`, while the toolbar badge always displays the active `groupBy` (default `'page'`) — so consumers without the selector (TasksView) render a flat list with a misleading "Group: Page" badge.

- [ ] **Step 1: Write the failing test**

Create `NodeCollection.grouping.test.tsx` (follow the mock patterns in `frontend/src/features/layout/components/Sidebar/SidebarRail.test.tsx` for store setup; check an existing ListView or NodeCollection-adjacent test for rendering patterns first):

```tsx
it('groups list-mode rows by page even without the group-by selector', () => {
  // arrange: nodes belonging to two different parent pages, viewMode 'list',
  // NO showGroupBy prop, groupBy defaulting to 'page'
  // assert: two group headers render with the page names
});

it('renders flat when groupBy is none', () => {
  // arrange: same nodes, groupBy="none"
  // assert: no group headers
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/content/components/nodes/NodeCollection.grouping.test.tsx`
Expected: FAIL — first test renders flat (no group headers).

- [ ] **Step 3: Apply the wiring fixes**

In `NodeCollection.tsx`, change line 346:

```ts
  // Enable grouping for list view when any group-by level is active
  const enableGrouping = viewMode === 'list' && isGroupByActive(groupBy);
```

In `TasksView.tsx`, add `showGroupBy` to the `NodeCollection` props (so users can change or clear grouping).

In `TrashView.tsx`, `ArchivedPagesView.tsx`, `TemplateGallery.tsx`, pass `groupBy="none"` to `NodeCollection` (they hide the toolbar and must stay flat — they previously relied on the `showGroupByProp` gate).

- [ ] **Step 4: Run tests**

Run: `docker compose -f compose.dev.yaml exec frontend npx vitest run src/features/content/components/nodes/`
Expected: PASS, including the new grouping tests and any existing NodeCollection tests.

- [ ] **Step 5: Type-check**

Run: `docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/content/components/nodes/NodeCollection.tsx frontend/src/features/content/components/nodes/NodeCollection.grouping.test.tsx frontend/src/features/tasks/pages/TasksView.tsx frontend/src/features/content/pages/TrashView.tsx frontend/src/features/content/pages/ArchivedPagesView.tsx frontend/src/features/templates/components/TemplateGallery.tsx
git commit -m "fix(views): enable list grouping independent of selector visibility"
```

---

### Task 6: Final verification

**Files:** none (verification only).

- [ ] **Step 1: All gates**

```bash
docker compose -f compose.dev.yaml exec backend uv run ruff check app/
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov
docker compose -f compose.dev.yaml exec frontend npm run lint
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
docker compose -f compose.dev.yaml exec frontend npm run test:run
```
Expected: all clean / green.

- [ ] **Step 2: Rebuild the dev stack**

`docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build -d`, then confirm all services healthy.

- [ ] **Step 3: Data verification**

Re-run the Task 3 Step 5 queries: zero cross-workspace `node_property` rows; ids 12854/12855 gone.

- [ ] **Step 4: Live UX verification (headless browser or manual)**

Against http://localhost:5173:
- Create a task in a daily page via Ctrl+Enter → status badge appears immediately; cycle to Done → badge updates; cycle again → task clears.
- Open `/tasks` → rows show status badges; group-by selector is visible; "Page" grouping actually groups rows under page headers; switch grouping off → flat list.
- Trash/Archived/Template gallery list views remain flat.
- Log in/out still works (auth path untouched by this plan, but cheap to confirm).
