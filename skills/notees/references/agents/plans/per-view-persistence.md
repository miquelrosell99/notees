# Plan: Per-view persistence + view management UX + per-type config

Make a saved `NodeView` a self-contained bundle like Notion's views: mode + sort +
group-by + per-type layout config all persisted server-side per view, plus the
management UX to duplicate, reorder, and set-default.

Approved 2026-07-13. Working copy of the session plan; kept in sync as stages land.

## Design decisions

1. **New columns on `node_view`**: `view_mode TEXT NULL`, `sort_entries JSONB`,
   `settings JSONB` (per-type config bag). `group_by TEXT` → `JSONB` so it can
   hold `string | string[]`.
2. **`settings` bag**: `cardLayout`, gantt/calendar date-property UUIDs + time
   scale, chart config (type/groupByField/measure). Graph/Timeline internal state
   is a follow-up.
3. **appStore globals become fallbacks** (seed for new views); per-view values win.
   `nodeGroupBy` slice removed if no consumers remain.
4. **Set-default**: reuse `PUT /views/{uuid}` with `is_default` (repo already
   unsets other defaults atomically).
5. **Duplicate**: dedicated `POST /views/{uuid}/duplicate`.
6. **Optimistic UI**: `useUpdateNodeView` patches list caches in `onMutate`.

## Stages

1. Backend schema + migration (`app/db/schema/sql.py`)
2. Entity / port / repository / service / router wiring + duplicate endpoint
3. Workspace export/import wiring
4. Backend tests (`tests/test_node_views.py`)
5. Frontend types / API / hooks (optimistic update, duplicate mutation)
6. `QueryNodeCollection` rewiring (mode/sort/group/settings per view)
7. `ViewTabs` UX (drag reorder, per-view menu: rename/duplicate/default/delete)
8. Per-type config through `NodeCollection` (chart config)
9. Cleanup (appStore dead keys) + docs + full verification + stack rebuild

## Verification

- Backend (container): `uv run ruff check app/` + `uv run pytest tests/ -m "not slow" --no-cov`
- Frontend (container): `npm run lint`, `npx tsc -b --noEmit`, `npm run test:run`
- Rebuild: `docker compose -f compose.dev.yaml down && up --build`
- Manual: two views with different mode/sort/group; reload keeps state; duplicate
  copies config; set-default and drag reorder persist; per-view card/gantt/chart.
- Snapshot commits after each green stage.

## Out of scope

- Graph/Timeline internal-state persistence per view
- Column widths/wrap, frozen columns, shared/locked views, `?v=` deep links
