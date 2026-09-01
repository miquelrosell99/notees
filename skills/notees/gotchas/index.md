# Gotchas — Notees

High-cost pitfalls specific to this codebase. Each entry links to the detailed reference when available.

## Editor Popup Keepalive

Any portaled popup/modal opened from the custom inline editor (slash follow-on pickers, pill "Edit link" modal, etc.) MUST hold `openPopup()` while open and `closePopup()` on close. Otherwise editor blur unmounts it mid-action and later mutations silently no-op.

- Reference: `references/agents/frontend.md#custom-inline-editor--popup-keepalive-invariant`

## Race Condition Triage

If a bug is "local change disappears after a network mutation", check the **debounced save / query invalidation boundary FIRST**.

- Reference: `references/agents/operations.md`

## Operation Log Immutability

The operation log is immutable. Migrations must fix bad data by appending new operations, not by editing existing envelopes or adding client-side backward-compatibility shims.

- Reference: `references/agents/operations.md`

## Date Page Content vs Display

- Stored content / search / matching use raw text extracted by `nodeNameToText`.
- Rendered names use `nodeNameToDisplayText` / `useNodeDisplayName`, which formats only nodes carrying `SYSTEM_CLASS_UUIDS.day`, `.month`, or `.year`.
- When migrating date content, change only the stored value; the display layer will pick it up automatically.

## UI Composition

Never nest a view mode (`NodeCollection`/`ListView`/`DocumentView`) inside a cell, card, or panel; embed the leaf primitive instead (`NodeCellEditable` pattern).

- Reference: `references/agents/building-blocks.md`

## **[navigation]** Property breadcrumb context uses `propertyUuid`, not `propertyId`

When plumbing a property context into `NodeBreadcrumbs` or the navigation store, the shape is `{ propertyUuid, propertyName }`. Using `propertyId` — or casting around the mismatch — silently drops the property breadcrumb and breaks the "opened via property" trail.

- Reference: `references/gotchas.md#navigation-property-context-shape-mismatch`

## **[navigation]** Text-property value blocks must be children of the owning node

A text property stores its value as the UUID of a block node. That block must be created with `parentId: <owner-node>` so it appears in the owner's child order. The main block list then excludes it via `filterTextPropertyBlocks` because the owner's `properties_uuid` references it under the text property. Creating it as a standalone `parentId: null` block makes it invisible to that filter, so it leaks into the normal block list and breadcrumbs lose the owner chain.

- Reference: `references/gotchas.md#navigation-text-property-blocks-must-be-children`

## WorkspaceStore sync lock is class-level and shared across instances

`WorkspaceStore._sync_locks` is a class-level dict keyed by workspace, so two store instances for the same workspace share one non-reentrant `asyncio.Lock`. Plugin side effects (e.g. the flashcards plugin constructs a *new* `WorkspaceStore` for the same workspace and calls `apply()`) must therefore run **after** the lock is released — holding `_sync_lock` across `_invoke_class_side_effects()` deadlocks. `apply()`/`apply_many()` hold the lock across persist+apply only.

## System view queries execute an empty AST unless auto-fixed on the execution path

Persisted system views (`classed_nodes`, `extended_by`, `child_pages`) store an empty `query_ast`; the required condition is restored by `autoFixSystemQuery`. Any new execution path for persisted views must route the AST through `getExecutionAST` — the edit UI applies the fix too, so a section can look correctly configured while executing nothing.

- Reference: `references/gotchas.md#query-persisted-system-views-store-an-empty-query_ast`

## Relay `saved_ids` excludes duplicates — ack the whole accepted batch

A successful relay batch response means every envelope is persisted server-side; the server omits duplicates from `saved_ids`. Clients must ack the whole chunk, not just `saved_ids` — otherwise a reset push watermark (e.g. interrupted rebuild) re-sends the same ops forever and workspace init hangs on "Connecting to server…".

- Reference: `references/gotchas.md#sync-relay-saved_ids-excludes-duplicates--ack-the-whole-accepted-batch`

## Applier changes must bump the derived-state version

Any change to client-side applier logic (`frontend/src/core/derived/**`) must bump `CURRENT_DERIVED_STATE_VERSION` (`frontend/src/core/store.ts`) and clear new derived tables in `resetDerivedState` in the same commit — nothing fails CI otherwise, and existing clients keep stale derived state while fresh installs work. But prefer a targeted idempotent startup repair (`repairClassHierarchy` / `repairDatePageHierarchy` pattern) when the state derives from one small table — a bump forces a full log replay on every client.

- Reference: `references/gotchas.md#derived-applier-changes-must-bump-the-derived-state-version`

## Playwright route globs match Vite module URLs

In e2e, a route glob like `**/api/**` also matches Vite's module URLs (`/src/features/auth/api/*.ts`) and bricks the boot. Match on parsed URL pathname instead (see `frontend/e2e/local-mode.spec.ts`).

## Local mode is a connection mode, not a build variant

Serverless behavior keys off `useConnectionMode()` / `useCapabilities()` (`frontend/src/config/serverUrl.ts`, `config/capabilities.ts`) — never scatter raw `localStorage`/`isLocal` checks through features. New server-dependent UI must declare its capability. See plan `references/agents/plans/2026-08-22-local-first-split/`.

## Repository SQL can drift from schema migrations

`app/db/schema/sql.py` evolves tables via guarded `ALTER TABLE` blocks (e.g. `pending_invite` dropped `node_id` at v5), but nothing fails CI when repository SQL still references the dropped column — the breakage only surfaces at runtime. After changing schema DDL, grep `app/features/**/repository.py` for the old column name.

## Query hooks gate on the AST being undefined, not on `enabled`

`useQueryAstAdapter` (`useExecuteQueryAdapter` / `useQueryResultsAdapter`) ignores the `enabled` option — execution is gated purely by `ast` being `undefined`. Passing `enabled: false` alone does NOT stop the worker `queryNodes` call. To suppress a query (e.g. collapsed sections), pass `ast: undefined`. Collapsed `QuerySection`s run `countQueryResults` only; the full query fires on expand.

## Compiled AST SQL must stay narrow and parse-free

`compileToSqlite` output is consumed for ids only (`queryNodes` reads `row.id`). Never select wide columns on the non-aggregate path (`SELECT DISTINCT n.*` materializes every matching row's full `content` JSON — ~23x slower on large result sets), and never evaluate `json_tree(n.content)` per row — node plaintext lives in the precomputed `node.text_content` column (maintained by `applyNodeOperation`; exact `json_tree key='text'` semantics). Custom property conditions use decorrelated `IN (SELECT node_id FROM property_value WHERE property_schema_id = ? …)` backed by `idx_property_value_schema`.

## SQLite LIKE is ASCII case-insensitive

`LIKE` ignores case for ASCII regardless of a `case_sensitive` flag, so `case_sensitive: true` is a no-op for content contains/starts_with/ends_with (only `equals` honors it). Don't add tests assuming sensitive LIKE matching.

## `unlinked_references` NodeView is never executed; Unlinked Mentions is a stub

Default views include `unlinked_references`, but no `.tsx` renders a `QuerySection` for it. The page-bottom "Unlinked Mentions" section uses `useUnlinkedMentions` whose `queryFn` returns `[]` (section always hides). Don't attribute worker `queryNodes` load to it.

## BlockList ignores `node.children` unless `localOnly`

With a core client available, `useBlockTree` re-projects every node and resolves children via the store's `getChildren`, ignoring the `children` arrays on the `nodes` prop. Synthetic/computed trees (class hierarchy, scratchpad, previews) must pass `localOnly` (plumbed `QueryNodeCollection → NodeCollection → ListView → BlockList`) and set `has_children` on parent nodes. Two related traps: `useBlockTree` effects must depend on memoized primitive options, not the caller's inline `options` object (sync setState loop → "Maximum update depth exceeded"), and synthetic `Node.content` must be paragraph-wrapped or `InlineContentStatic` renders blank text.

- Reference: `references/gotchas.md#views-blocklist-ignores-nodechildren-unless-localonly`

## Dev vs Prod

Development infrastructure settings in `compose.dev.yaml` must never be used in production.
