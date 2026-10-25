# Query node as a nodecollection query builder — design spec

Owner-reviewed 2026-10-25. Replaces the shipped query-token renderer design.

## Problem

The query surface today is a bespoke implementation: a `query` content token
rendered **inside** the block's token stream by `QueryBlockView`
(`apps/web/src/ui/QueryBlockView.tsx`), with its own header chrome, its own
limited popover builder (`apps/web/src/ui/queryBuilder.ts` — a flat AND
subset of the grammar), and its own modal path when creating tabs. System
sections already ship the right machinery — the full-grammar builder
(`FilterBlockBuilder`/`FilterBuilderModal` over `filterQuery.ts`) inside
`FilterBar`, plus the hosted tabs row (`SectionViewTabs`) — and the query
node should be that, not a parallel implementation.

## Decisions (fixed)

1. The query block is a **normal, typeable block row**. The query machinery
   renders as sibling rows **after** the content row (same plug-in seam as
   `BlockBacklinkPanel`, the tags row, `PropertiesSection` in
   `apps/web/src/ui/BlockRow.tsx`).
2. Reuse the nodecollection chrome: the "tabs + buttons" row and the
   query builder — one builder, full grammar, nowhere a parallel subset.
3. Clicking **"+" creates the tab immediately** — no modal on create. The
   builder is an **inline, toggleable section** shown per tab when toggled,
   editing the selected tab's query.
4. **A tab is a saved query AST only.** View modes are **not stored**
   (transient surface state, per-surface as today) — no `node_surface`
   table, no `view_mode` column.
5. Renames: `SectionViewTabs` → `NodeCollectionTabs`;
   `FilterBar` → `NodeCollectionBar`.
6. Tabs are stored **per node, not per user** — and this applies to system
   sections too. The current per-user, section-required `section_view`
   table is wrong for both.

## Design

### 1. Storage — node-scoped views (server)

Replace `section_view` (`apps/server/src/auth.ts:244`) with `node_view`:

```sql
CREATE TABLE IF NOT EXISTS node_view (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    section_key TEXT NOT NULL DEFAULT '',  -- '' = node's main query
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    query_ast TEXT NOT NULL,               -- JSON-serialized QueryAST v1
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (node_id, section_key, name)
);
CREATE INDEX IF NOT EXISTS idx_node_view_owner ON node_view (node_id, section_key);
```

- `user_id` is dropped: tabs belong to the node and are shared across all
  users of the deployment (sole-user today; the multi-user semantic change
  is a deliberate decision, recorded here).
- `section_key = ''` is the node's main query — what query nodes use.
  System sections keep their keys (`linked-references`, `unlinked-mentions`,
  `classed-nodes`); the closed enum becomes an allow-list that grows
  additively.
- No `view_mode` anywhere (ruling 4). The old column dies with the table.
- Default tab stays **derived-not-stored**: empty table = factory behavior.
  A query node's default AST continues to live in its `query` content token.

Migration (one-time, at DDL site in `auth.ts`): create `node_view`, copy
rows from `section_view` dropping `user_id` and `view_mode` (dedupe on the
new unique key), drop `section_view`. Sole-user data makes this trivial; log
counts. `CREATE TABLE IF NOT EXISTS` + idempotent copy; re-runs are no-ops.

### 2. API (server)

`apps/server/src/routes-section-views.ts` is rewritten:

- Path de-scoped from `/api/me/nodes/:nodeId/...` to
  `/api/nodes/:nodeId/sections/:sectionKey/views`; empty section key travels
  as the literal sentinel `-` in the path (URL-safe; `''` is awkward in
  routes), normalized to `''` at the handler.
- Auth: still authenticated (`requireUser`), just not user-scoped.
- Endpoints unchanged in shape: list / create / rename / reorder / delete.
  Create body drops `viewMode`.
- `queryAst` validation stays `queryAstSchema` from `@notees/protocol`.

### 3. Web client plumbing

- `apps/web/src/core/workspace-client/section-views.ts` + the fetcher in
  `client-server.ts:109` — new path, `SectionView` type loses `viewMode`
  and `sectionKey` may be `''`.
- `apps/web/src/features/collection/sectionViews.ts` — cache keyed
  `(nodeId, sectionKey)`; the device cache entry key gains the section.

### 4. Web components

**Renames** (mechanical, all references):

- `apps/web/src/features/collection/SectionViewTabs.tsx` →
  `NodeCollectionTabs.tsx`; prop type `HostedViews` keeps its name unless it
  references the old term.
- `apps/web/src/features/collection/FilterBar.tsx` →
  `NodeCollectionBar.tsx`.

**"+" behavior + builder** (both in `NodeCollectionTabs` and the bar):

- `+` calls `createSectionView` immediately with the current draft AST
  (or factory AST when the draft is empty) and selects the new tab. The
  `FilterBuilderModal` open-on-create path is removed from the tabs.
- The structured-filters toggle in `NodeCollectionBar` switches an **inline
  builder section rendered beneath the tabs row** (not a popover, not a
  modal), bound to the **selected tab**. Committing writes the selected
  tab's AST via the views API; the default tab's edits write the query
  token's `queryAst` (see §5) — the commit adapter decides by which tab is
  selected.
- `FilterBuilderModal` itself stays (Queries hub "New query" is out of
  scope) but loses its role in tab creation.

**Query node renderer** (the core rework):

- `BlockRow.tsx` gains a sibling section after the content row
  (alongside the backlink/tags/properties slots, ~line 1099): when the
  block's content carries a `query` token, render a `QueryNodeSection`:
  `NodeCollectionTabs` (hosted views over `node_view` with
  `section_key: ''`) + `NodeCollectionBar` + the toggleable inline
  `FilterBlockBuilder` + results.
- Results body reuses the shared machinery — `useQueryRun`
  (`apps/web/src/ui/queryRun.ts`) + `NodeCollection`; lift the
  `QueryResults` shape out of `apps/web/src/features/collection/QueriesHub.tsx:67-165`
  into a shared component if duplication would otherwise appear.
- `QUERY_RESULT_CAP` windowing and "load more" are preserved.
- Export via `buildQueryExportMarkdown` is preserved (moves into the
  section's chrome).

**Deleted code**: `apps/web/src/ui/QueryBlockView.tsx`,
`apps/web/src/ui/queryBuilder.ts`, the `renderQuery` path in
`InlineTokens.tsx` + its wiring in `BlockRow.tsx:729-742`, and
`apps/web/src/features/collection/QueryBuilderFields.tsx` (fields move to
the full-grammar builder if anything there is unique to them).
`builderUnsupportedConstructs` disappears with the subset builder.

**Token stream**: the `query` content token stops rendering UI in the
content row. It remains the op-log marker + default AST; `/query` slash
command creation (`BlockTextEditor.tsx:834-845`) and the builder
auto-open queue survive (the queue now targets the section below the row).
`queryTokens.ts` helpers are trimmed to what the new section uses.
`queryViewRecord.ts` survives for the Queries hub (`ViewTabs.tsx`,
`QueriesHub.tsx` — title/isDefault on hub saved-view tokens, out of
scope here); the new query-node section never uses its `mode` pin, which
is dead under ruling 4.

### 5. Query node data flow

- Default tab (always present, derived): AST = the token's `queryAst`;
  edits write the token via `updateQueryTokenAst` (`object.update` op, as
  today).
- Custom tabs: rows in `node_view` for `(nodeId, '')`; edits hit the views
  REST API. Selected tab state is local component state (default tab when
  none selected).
- The query block's own text content is ordinary typed text (the block's
  title/caption) — untouched by any of this.

### 6. Explicit non-goals

- No new op types, no protocol wire change, no property-type addition;
  `query` system class seed and `_queryAst` property seed stay unused.
- GTK/Flutter lockstep: not required (prefs channel, not op wire). Sibling
  clients carry no query-node UI.
- Queries hub, ReferenceSection/ChildPagesSection behavior beyond the
  storage/rename migration; modal builder for the hub stays.
- View-mode persistence (not stored, at least for now).

## Testing

- `apps/server/test/section-views.test.ts` rewritten for the new table,
  routes, shared visibility, and the migration (seed a legacy
  `section_view` row, boot, assert `node_view` contents).
- Web vitest: `query-block`, `query-builder`, `query-builder-guard`,
  `queries-hub` suites reworked/renamed around the new section; add
  coverage for "+ creates tab without modal" and per-tab builder commits.
- Gate: `pnpm install && pnpm typecheck && pnpm test` green from repo root.

## Records (same pass)

- `CHANGELOG.md` entry (one slice or a short sequence: server storage+API,
  web plumbing+renames, query-node section rework).
- Docs: queries feature page under `docs/features/` if it documents the
  old popover builder; `docs/api.md` endpoint paths if they appear there;
  `docs/developers/` runbooks where `section_view`/`FilterBar` are named.
- No pointers to this folder from the tree.
