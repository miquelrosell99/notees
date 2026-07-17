# Phase 3 Plan: QueryAST Retarget to SQLite

**Goal:** Make QueryAST compile to SQLite SQL against the new derived tables.

**Prerequisite:** the derived schema needs a transitive `class_hierarchy(class_id, ancestor_id)` table so class inheritance queries (`ClassCondition.contains`, `ExtendsCondition`) can be resolved without recursive schema traversal at query time. Both backend replay (`app/core/migration/replay.py`) and frontend derived appliers (`frontend/src/core/db/schema.ts` + `frontend/src/core/derived/`) must populate it from `class.create`/`class.update` payloads.

---

## Condition support matrix

| Condition | SQLite target | Status |
|---|---|---|
| Scope `entire_workspace` | `node.workspace_id = ?` | supported |
| Scope `pages` | `node.kind = 'page'` | supported |
| Scope `current_page` | ancestor-page recursive CTE | supported |
| Scope `specific_pages` | ancestor-page recursive CTE | supported |
| Scope `linked_refs` | `edge` table | supported |
| Class | `json_each(node.class_ids)` + `class_hierarchy` | supported with schema extension |
| Extends | `class_hierarchy` | supported with schema extension |
| Property (builtin) | `node` columns / ancestor CTE / JSON text extraction | supported |
| Property (custom) | `property_value.value` JSON | supported |
| Content | `search_index.content LIKE` / `json_tree(node.content)` | supported; regex out of scope |
| Style | `json_tree(node.content)` | supported if JSON1 verified |
| Reference | `edge` table + `property_value` | supported |
| Reference path | recursive CTE + `edge` | supported |
| Parent / parent path | recursive CTE on `parent_id` | supported |
| Child / child path | recursive CTE on `parent_id` | supported |
| Page | ancestor-page recursive CTE | supported |
| Tag | — | out of scope (not migrated) |
| Flags `is_page/is_class/is_day/...` | `kind` or `class_ids` | supported |
| Flags `is_private/is_favorite/active` | — | out of scope |

---

## Aggregation support

- **Dimensions:** `is_page`, `create_date`, `write_date`, `page`, `class`, and property UUIDs.
- **Measures:** `count`; `sum/avg/min/max` on numeric properties.
- Builtin numeric measures (`sequence`, `id`) are out of scope because the derived schema has no numeric sequence/id columns.

---

## Files to create / modify

### Backend

- Create `app/core/query_ast/__init__.py` — public exports.
- Create `app/core/query_ast/compiler.py` — `QueryASTToSQLite` class.
  - Parameter style: positional `?` with a list of params.
  - Inputs: `workspace_id: str`, `current_node_uuid: str | None = None`.
  - Methods: `generate(ast)`, `generate_aggregate(ast)`, per-condition `_generate_*_condition` methods.
- Create `app/core/query_ast/executor.py` (optional test helper) — run compiled SQL against a `sqlite3.Connection` and return node dicts / groups.
- Create `tests/core/query_ast/test_compiler.py` — unit tests.
- Create `tests/core/query_ast/test_executor_against_replay.py` — replay Phase 2 ops and compare query results.
- Modify `app/core/migration/replay.py` — add `class_hierarchy` table and populate from `class.create`/`class.update`.

### Frontend

- Create `frontend/src/core/query/compileToSqlite.ts` — `compileToSqlite(ast, workspaceId, currentNodeUuid?)` returning `{ sql: string; params: SqlParam[] }`.
- Create `frontend/src/core/query/executeCompiled.ts` (optional helper) — run compiled SQL via `frontend/src/core/db/sqlite.ts` helpers.
- Create `frontend/src/core/query/__tests__/compileToSqlite.test.ts` — unit tests against sql.js in-memory DB.
- Modify `frontend/src/core/db/schema.ts` — add `class_hierarchy` table.
- Modify `frontend/src/core/derived/node.ts` (or add `classHierarchy.ts`) — populate `class_hierarchy` from `class.create`/`class.update` operations.

---

## Test strategy

1. **Backend compiler unit tests:** instantiate `QueryASTToSQLite` with hand-built ASTs and assert generated SQL clauses and parameter lists.
2. **Backend executor tests:** replay operations from `tests/core/migration/` fixtures into SQLite, run queries, and assert result UUID sets.
3. **Cross-check with PostgreSQL:** where possible, run the same AST through the PostgreSQL compiler and SQLite compiler against equivalent fixture data and compare result UUID sets.
4. **Frontend compiler tests:** use `sql.js` in-memory DB, create schema, apply operations, compile AST, execute, assert results.
5. **Feature coverage tests** per condition type: class (direct + inherited), property (builtin + custom), content, reference / reference_path, parent / parent_path / child / child_path, page, flag, aggregation.

---

## Verification commands

```bash
# Backend
uv run pytest tests/core/query_ast -m unit --no-cov
uv run ruff check app/core/query_ast tests/core/query_ast

# Frontend
cd frontend
npm run test:run src/core/query
npx tsc -b --noEmit
```

After Docker rebuild for runtime integration:

```bash
docker compose -f compose.dev.yaml exec frontend npm run test:run src/core/query
```

---

## Subagent breakdown

- **Subagent C1 — Backend SQLite compiler**
  - Create `app/core/query_ast/compiler.py`, `__init__.py`, and backend tests.
  - Extend `app/core/migration/replay.py` with `class_hierarchy`.
  - Add `tests/core/query_ast/` coverage.
- **Subagent C2 — Frontend SQLite compiler** ✅ Done
  - Created `frontend/src/core/query/compileToSqlite.ts` and `frontend/src/core/query/__tests__/compileToSqlite.test.ts`.
  - Added `class_hierarchy` table to `frontend/src/core/db/schema.ts` and populated it from `class.create`/`class.update` in `frontend/src/core/derived/node.ts`.
  - Caveats: dynamic `nested_group` modes for path conditions are implemented but not exhaustively tested; `regex`/`fts` content operators and tag conditions remain out of scope as documented.
- **Subagent C3 — Cross-check / parity**
  - Build shared fixture-based tests that compile the same AST with both PostgreSQL and SQLite compilers and compare results.
  - Validate against the real migrated SQLite state produced by Phase 2.
