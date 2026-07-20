# Notees Changelog

## 2.0.0 — Local-first architecture complete (Phases 6–9)

**Date:** 2026-07-18

### Architecture

- The authoritative data model is now an **immutable operation log** with client-side SQLite derived state and an encrypted operation relay.
- The legacy `/api/nodes/*`, `/api/properties/*`, and `/api/sync/*` endpoints have been unmounted. The frontend now reads and writes through the local SQLite store and syncs via `/api/relay/*`.
- The legacy v2 sync dispatcher (`SyncManagerV2`, `localSyncEngine`, `LocalIndexManager`, `QueryLiveUpdater`) and `frontend/src/runtime/` (`OperationRuntime`) have been removed.
- `app/features/nodes/` and `app/features/properties/` have been deleted; all remaining feature islands (tasks, assets, import, shares, activity, undo, plugins, collab) operate on the operation-log core.
- All operations carry unencrypted routing metadata (`affected_node_ids`, `op_type`, HLC) so the relay can enforce node-level shares without decrypting payloads.

### Production Hardening (Phase 9)

- **Backend relay adapter**: PostgreSQL-backed `PostgresRelayStorage` with envelope/snapshot/compaction tables, rate limiting, envelope validation, and admin endpoints.
- **Frontend persistence**: `openWorkspaceDatabase` loads and saves the SQLite database from IndexedDB; `WorkspaceStore` supports explicit `persistNow`, snapshot export, and compaction.
- **Snapshot replay**: startup loads the latest snapshot and replays only operations newer than the snapshot HLC, bounding cold-start cost.
- **Push watermark**: `SyncEngine.push()` tracks the last-pushed HLC in `sync_push_watermark` and only uploads newer operations.
- **Storage quota**: `useStorageQuota` monitors `navigator.storage.estimate()`; `SyncStatusIndicator` surfaces warning/critical quota alerts.

### Data & Migration

- Existing workspaces have been seeded into the encrypted operation relay using `scripts/seed_relay_from_postgres.py --all --direct`.
- A full PostgreSQL backup and workspace-data backup were captured before destructive changes:
  - `data/backups/notees-20260718-085505.dump`
  - `data/backups/notees-data-20260718-085514.tar.gz`
- A pre-Phase 8 backup is available at `data/backups/phase8/`.

### Phase 9D/E — Remove remaining legacy frontend API callers

- The last `frontend/src/api/nodes.ts` consumers (search, selectors, command palette, navigation, views/graph, comments, aliases, templates, share receiver, version history, merge, and trash) have been ported to the core SQLite store.
- `frontend/src/api/nodes.ts` has been deleted. The frontend no longer calls any `/api/nodes/*` endpoints.
- Comments are implemented as child blocks with the `comment` system class.
- Templates are pages with the `template` class; variables are parsed from content placeholders.
- Aliases and version restore are intentionally not yet modeled in the operation-log core and return empty/no-op results.

### Phase 10 — Final documentation and release milestone

- `AGENTS.md` and agent reference docs updated to reflect the completed migration.
- Added an idempotent schema migration for pre-existing flashcard tables: legacy `flashcard.node_id` is migrated to `flashcard.node_uuid`, ensuring fresh starts and upgraded dev databases both initialize cleanly.
- Full verification run completed:
  - `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 367 passed, 3 skipped.
  - `cd frontend && npx tsc -b --noEmit && npm run lint` → clean (5 pre-existing warnings).
  - `cd frontend && npm run test:run` → 83 test files / 552 tests passed.
  - `npm run test:e2e` → 4/4 smoke tests passed.
- Final milestone commit: `feat(core,relay,frontend): Notees 2.0 local-first migration complete`.

### Developer Notes

- `frontend/src/core/` is the sole path for state, hooks, and sync.
- `agents/plans/notees-phase7-plus-plan.md` is marked complete.

## Phase 11 — Close remaining product gaps

**Date:** 2026-07-20

### Core payload alignment

- `node.updateContent` now accepts `content` (direct AST payload) and `treeUpdate` (tree CRDT state) in addition to `crdtUpdate`/`textUpdate`.
- Derived-state applier stores `treeUpdate` in `crdt_state.tree_state` without overwriting `node.content`.

### Workspace operation-log seeding

- New workspaces are now seeded into the encrypted operation-log relay via `app/core/seed.py`.
- System classes (`page`, `whiteboard`, `query`, `task`, `comment`, `card`, `cloze`, `asset`, `template`, `class`) and the default page are created as operations, so fresh accounts have the same derived state as migrated ones.
- Fixed encrypted-envelope wire-format mismatch: `workspaceId`/`actorId`/`affectedNodeIds`/`opType` are now camelCase on the wire and accepted by name.
- `useClasses` is now reactive to all `WorkspaceStore` changes.

### Re-implemented importers

- **Logseq Markdown-folder importer** restored as a client-side core-store importer plugin (`useLogseqMarkdownImporter.ts`, `ImportLogseqFolderModal.tsx`).

### Whiteboard and flashcards

- **Whiteboard**: save/reload now round-trips through the operation-log relay; added Playwright E2E test (`frontend/e2e/whiteboard.spec.ts`).
- **Flashcards**: auto-create flashcard rows on `card` class assignment, rehydrate front/back text from node name and cloze children, added router/service/component tests.

### Comments threading

- `SidebarComments` now renders nested replies recursively with indentation and reply affordances.

### Verification

- `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 384 passed, 3 skipped, 6 deselected, 1 warning.
- `cd frontend && npx tsc -b --noEmit && npm run lint` → clean (0 errors, 5 pre-existing warnings).
- `cd frontend && npm run test:run` → 88 files / 571 passed.
- `npm run test:e2e` → 5/5 passed.
- Final gap-closure commit: `feat(core,frontend): Phase 11 remaining gaps closed`.
