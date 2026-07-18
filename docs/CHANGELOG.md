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
- This changelog entry finalized.

### Developer Notes

- `frontend/src/core/` is the sole path for state, hooks, and sync.
- `agents/plans/notees-phase7-plus-plan.md` is marked complete.
