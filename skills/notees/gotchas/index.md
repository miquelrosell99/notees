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

## Playwright route globs match Vite module URLs

In e2e, a route glob like `**/api/**` also matches Vite's module URLs (`/src/features/auth/api/*.ts`) and bricks the boot. Match on parsed URL pathname instead (see `frontend/e2e/local-mode.spec.ts`).

## Local mode is a connection mode, not a build variant

Serverless behavior keys off `useConnectionMode()` / `useCapabilities()` (`frontend/src/config/serverUrl.ts`, `config/capabilities.ts`) — never scatter raw `localStorage`/`isLocal` checks through features. New server-dependent UI must declare its capability. See plan `references/agents/plans/2026-08-22-local-first-split/`.

## Repository SQL can drift from schema migrations

`app/db/schema/sql.py` evolves tables via guarded `ALTER TABLE` blocks (e.g. `pending_invite` dropped `node_id` at v5), but nothing fails CI when repository SQL still references the dropped column — the breakage only surfaces at runtime. After changing schema DDL, grep `app/features/**/repository.py` for the old column name.

## Dev vs Prod

Development infrastructure settings in `compose.dev.yaml` must never be used in production.
