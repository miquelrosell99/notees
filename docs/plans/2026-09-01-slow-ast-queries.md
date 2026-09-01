# Plan: Fix slow AST queryNodes on page open

Date: 2026-09-01
Status: done

## Symptom

Browser worker logs: `[queryNodes] Slow query ast took ~800-1000ms (rows=0)`
when opening a daily page.

## Root causes identified

1. **Content conditions** compile to per-row
   `(SELECT group_concat(value,'') FROM json_tree(n.content) WHERE key='text')`
   (`compileToSqlite.ts` `nameTextExpr`) — full-content JSON parse per node per
   query. Used by `content` conditions and builtin `name` property conditions.
2. **Custom property / class conditions** compile to correlated per-row
   `EXISTS` probes over the entire workspace. Daily pages run "Scheduled Tasks"
   and "Overdue Tasks" (`utils/taskQueries.ts`) — expanded by default — with
   1 json_each + 3-4 property probes per node.
3. **Collapsed sections still run full queries** — the header count and
   `hideWhenEmpty` depend on results, and `useQueryAst` re-runs on every store
   mutation.

Note: the `unlinked_references` AST view is **not** rendered on pages (the
page-bottom "Unlinked Mentions" section is a stub returning `[]`). The slow
queries on daily pages are the task sections.

## Fixes

- [x] **F1 (done)**: precomputed `node.text_content` column maintained at write
  time (schema v16 + backfill), compiler reads the column instead of
  `json_tree` per row. Also: slow-query log now includes compiled SQL.
  Benchmark: ~2.6x on synthetic 10k nodes, more on large docs.
- [x] **F2**: property conditions → decorrelated
  `n.id IN (SELECT node_id FROM property_value WHERE property_schema_id = ? AND …)`
  + new index `idx_property_value_schema` (schema v17). Class condition unchanged
  (benchmark showed it doesn't dominate). Parity at 10k-node bench scale; better
  selectivity scaling on large property tables.
- [x] **F3**: collapsed query sections run only `countQueryResults` (COUNT);
  full `queryNodes` only when expanded. Mirrors the existing
  `linked_references` lazy pattern. Also fixed: `countQueryResults` now excludes
  archived nodes; query adapters ignore `enabled` → gate via `ast: undefined`;
  removed a dead duplicate `queryNodes` call for linked_references/extended_by.
- [x] **F4**: non-aggregate compiled SQL is now `SELECT n.id, n.active` (was
  `SELECT DISTINCT n.*`). ~23x on large-result queries; `DISTINCT` was provably
  redundant (no outer JOINs). Aggregate path keeps wide rows.

## Verification

- TDD benchmarks (before/after timings) + equivalence tests (legacy vs new SQL
  on fixture DBs) for both compiler changes.
- Component tests: collapsed → count only; expand → full query.
- Full frontend suite + eslint + typecheck in the dev container.
