# Class Schema Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move class definitions out of the unified `node` table into a dedicated `class` table/schema while keeping the operation log as the offline-first sync source of truth.

**Architecture:**
- The operation log continues to own class lifecycle, either through new `class.*` operation types or by deriving class state from existing `node.*` operations.
- A new `class` derived table in SQLite/PostgreSQL stores class metadata: `id`, `workspace_id`, `name`, `icon`, `color`, `description`, `extends_class_ids`, `created_at`, `updated_at`.
- Existing class-specific derived tables (`class_hierarchy`, `class_property_edge`, `property_schema`) continue to reference class rows by UUID.
- Frontend and backend queries read class metadata from the `class` table instead of filtering `node WHERE kind = 'class'`.
- After the cutover, `node.kind` is reduced to `('page', 'block')`; `node.class_ids` references class IDs in the new table.

**Tech Stack:** FastAPI / Pydantic / asyncpg (backend); TypeScript / sql.js / React (frontend); operation log + derived SQLite/PostgreSQL.

## Global Constraints

- `node.kind` must eventually be `('page', 'block')`; `class` is removed.
- All public HTTP API resources use UUIDs; internal numeric IDs never appear in URLs or public bodies.
- The operation log remains the source of truth; the `class` table is derived.
- Existing class nodes must be migratable without data loss.
- DB connections: use `app.db.connection.get_connection()` / `get_transaction()`; never `pool.acquire()` directly.
- Frontend path aliases only; no relative `../../../` imports.
- TanStack Query keys must use factories in `frontend/src/hooks/queryKeys.ts`.

---

## Task 1: Add `class` derived table to frontend and backend schemas

**Files:**
- Create: `frontend/src/core/derived/class.ts` (applier)
- Modify: `frontend/src/core/db/schema.ts`
- Modify: `app/core/derived/schema.py`
- Modify: `frontend/src/core/types/operation.ts` (add `class.*` op types if chosen)
- Modify: `app/core/operation.py` (add `class.*` op types if chosen)
- Test: `frontend/src/core/derived/__tests__/appliers.test.ts`, `tests/core/derived/test_node.py`

**Interfaces:**
- Consumes: operation payloads from `node.create`, `node.convert`, `node.updateContent` (temporary derivation path) or new `class.*` ops.
- Produces: `class` table rows queryable by `id`/`workspace_id`.

- [ ] **Step 1: Add `class` table DDL**

  ```sql
  CREATE TABLE IF NOT EXISTS class (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      description TEXT,
      extends_class_ids TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_class_workspace ON class (workspace_id);
  ```

  Add identical DDL to `frontend/src/core/db/schema.ts` and `app/core/derived/schema.py`.

- [ ] **Step 2: Add class operation types (if using new ops)**

  In `frontend/src/core/types/operation.ts` and `app/core/operation.py`, add:
  - `class.create`
  - `class.update`
  - `class.delete`
  - `class.setExtends`

- [ ] **Step 3: Write failing schema tests**

  Verify the `class` table is created and can store a row after applying a `class.create` or `node.convert` operation.

- [ ] **Step 4: Commit**

  ```bash
  git add frontend/src/core/db/schema.ts app/core/derived/schema.py frontend/src/core/types/operation.ts app/core/operation.py
  git commit -m "feat(schema): add class derived table and operation types"
  ```

---

## Task 2: Materialize class metadata from the operation log

**Files:**
- Create: `frontend/src/core/derived/class.ts`
- Create: `app/core/derived/class.py`
- Modify: `frontend/src/core/derived/index.ts`
- Modify: `app/core/derived/__init__.py`
- Test: `frontend/src/core/derived/__tests__/appliers.test.ts`, `tests/core/derived/test_class.py` (new)

**Interfaces:**
- Consumes: `node.create`/`node.convert` with `kind='class'`, `node.updateContent`, and optionally `class.*` ops.
- Produces: rows in `class` table mirroring class-node metadata.

- [ ] **Step 1: Implement frontend class applier**

  Function `applyClassOperation(db, op)`:
  - On `node.create`/`node.convert` where `kind === 'class'`: insert or replace `class` row with derived name from content.
  - On `node.updateContent`: update `class.name` and `class.description` by parsing the node's content AST/text.
  - On `node.delete`: mark `class.active = 0`.

- [ ] **Step 2: Implement backend class applier**

  Mirror the frontend behavior in Python for backend migration/replay.

- [ ] **Step 3: Wire appliers into the derived-state dispatcher**

  Ensure `applyNodeOperation` calls the class applier for relevant op types, or add a separate `applyClassOperation` call in the dispatcher.

- [ ] **Step 4: Write tests**

  - Creating a class node inserts a class row.
  - Updating class content updates `class.name`.
  - Deleting a class node marks it inactive.

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/core/derived/class.ts app/core/derived/class.py tests/
  git commit -m "feat(derived): materialize class metadata from operation log"
  ```

---

## Task 3: Query layer reads from `class` table

**Files:**
- Create: `frontend/src/core/query/classes.ts`
- Create: `app/core/query/classes.py` or extend `app/core/workspace_store.py`
- Modify: `frontend/src/core/query/queryNodes.ts`
- Modify: `frontend/src/features/content/hooks/useNodes.ts`
- Test: `frontend/src/core/query/__tests__/classes.test.ts` (new), `tests/core/query/test_classes.py` (new)

**Interfaces:**
- Consumes: `class` table rows.
- Produces: `getClasses(store)` returning `ClassRow[]`; `queryClasses(store, filters)`.

- [ ] **Step 1: Add frontend class query helpers**

  ```ts
  export interface ClassRow {
    id: string;
    workspaceId: string;
    name: string;
    icon: string | null;
    color: string | null;
    description: string | null;
    extendsClassIds: string[];
    active: boolean;
    createdAt: string;
    updatedAt: string;
  }

  export function listClasses(db: Database, workspaceId: string): ClassRow[];
  export function getClass(db: Database, classId: string): ClassRow | undefined;
  ```

- [ ] **Step 2: Add backend class query helpers**

  Equivalent async helpers using `workspace_store.query()`.

- [ ] **Step 3: Update frontend `useClasses` hook**

  Change `useClasses()` to query the `class` table instead of `node WHERE kind = 'class'`.

- [ ] **Step 4: Update `queryNodes` class filtering**

  When filtering by `isClass`, join against the `class` table rather than checking `node.kind = 'class'`.

- [ ] **Step 5: Write tests**

  Verify `listClasses` returns active class rows and excludes deleted ones.

- [ ] **Step 6: Commit**

  ```bash
  git add frontend/src/core/query/classes.ts app/core/query/classes.py frontend/src/features/content/hooks/useNodes.ts
  git commit -m "feat(query): read class definitions from dedicated class table"
  ```

---

## Task 4: Class CRUD operations and frontend store methods

**Files:**
- Modify: `frontend/src/core/store.ts`
- Modify: `frontend/src/core/worker/workspaceWorker.ts`
- Modify: `frontend/src/core/hooks/useWorkspaceStoreClient.ts` types if needed
- Modify: `app/core/workspace_store.py`
- Test: `frontend/src/core/__tests__/workspaceStore.test.ts`, `tests/core/test_workspace_store.py`

**Interfaces:**
- Consumes: class metadata from UI.
- Produces: `store.createClass(...)`, `store.updateClass(...)`, `store.deleteClass(...)`, `store.setClassExtends(...)`.

- [ ] **Step 1: Add class CRUD methods to frontend `WorkspaceStore`**

  ```ts
  createClass(args: { classId: string; name: string; icon?: string | null; color?: string | null }): void
  updateClass(args: { classId: string; name?: string; icon?: string | null; color?: string | null; description?: string | null }): void
  deleteClass(classId: string): void
  setClassExtends(args: { classId: string; extendsClassIds: string[] }): void
  ```

  These emit `class.*` operations (or reuse `node.*` ops during transition).

- [ ] **Step 2: Add worker routing**

  Add `createClass`, `updateClass`, `deleteClass`, `setClassExtends` to the worker method dispatch path.

- [ ] **Step 3: Add backend class CRUD methods**

  Mirror in `app/core/workspace_store.py`.

- [ ] **Step 4: Write tests**

  Round-trip class creation, update, delete, and extends through the store.

- [ ] **Step 5: Commit**

  ```bash
  git commit -m "feat(store): class CRUD operations in frontend and backend"
  ```

---

## Task 5: Migrate existing class nodes and remove `kind='class'`

**Files:**
- Modify: `app/core/migration/nodes.py`
- Modify: `frontend/src/core/adapters/useCreateNodeAdapter.ts`
- Modify: `frontend/src/features/content/pages/ClassesView.tsx`
- Modify: `frontend/src/features/content/pages/NodeView.tsx`
- Modify: `frontend/src/core/store.ts` (remove `kind='class'`)
- Modify: `app/core/derived/schema.py` (update CHECK constraint)
- Modify: `frontend/src/core/db/schema.ts`
- Test: migration tests, existing class-related tests

**Interfaces:**
- Consumes: legacy class nodes and class-as-node code paths.
- Produces: class rows; nodes with `kind IN ('page', 'block')`.

- [ ] **Step 1: Migration script for existing class nodes**

  For every `node WHERE kind = 'class'`:
  - Insert a `class` row with derived metadata.
  - Update `property_schema.node_id` references to point to the class row ID if needed.
  - Convert the node to `kind='page'` with the class assigned in `class_ids` (or delete it if classes are no longer nodes).

- [ ] **Step 2: Update class creation UIs**

  `ClassesView.tsx`, `NodeView.tsx` `handleCreateClass`, and `handleConvertToClass` use `createClass` / `updateClass` instead of `createNode({ kind: 'class' })` / `convertNode({ kind: 'class' })`.

- [ ] **Step 3: Remove `kind='class'`**

  Update schema CHECK constraints, TypeScript types, and store methods to only allow `page`/`block`.

- [ ] **Step 4: Update tests**

  Remove or rewrite tests that rely on `kind='class'`; add tests for the new class table.

- [ ] **Step 5: Commit**

  ```bash
  git commit -m "feat(migration): move class nodes to dedicated class table"
  ```

---

## Task 6: Final verification

- [ ] **Step 1: Run backend tests**

  ```bash
  uv run pytest tests/unit tests/core -m unit --no-cov -q
  ```

  Expected: all pass.

- [ ] **Step 2: Run frontend tests**

  ```bash
  cd frontend && npm run lint && npm run test:run
  ```

  Expected: lint passes (pre-existing warnings only), all tests pass.

- [ ] **Step 3: Run migration smoke test**

  Create a workspace with legacy class nodes, run migration, verify `class` table is populated and `node.kind` has no `class` values.

- [ ] **Step 4: Commit any fixes**

---

## Out of Scope

- Changing how property schemas are stored (they already have their own table).
- Rewriting the sync protocol beyond adding class operation types.
- UI redesign of the Classes view (only data-source changes).

## Risks

- **Sync convergence:** New `class.*` operations must converge correctly with legacy `node.*` class operations during transition.
- **Migration correctness:** Legacy class nodes may have block children or complex content; the migration must handle or reject them.
- **Query compatibility:** Existing `node.class_ids` must continue to resolve to valid class IDs after the split.
