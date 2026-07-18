# Notees Changelog

## 2.0.0 — Local-first architecture cut-over (Phase 6)

**Date:** 2026-07-18

### Architecture

- The authoritative data model is now an **immutable operation log** with client-side SQLite derived state and an encrypted operation relay.
- The legacy `/api/nodes/*`, `/api/properties/*`, and `/api/sync/*` endpoints have been unmounted. The frontend now reads and writes through the local SQLite store and syncs via `/api/relay/*`.
- The legacy v2 sync dispatcher (`SyncManagerV2`, `localSyncEngine`, `LocalIndexManager`, `QueryLiveUpdater`) has been removed from the frontend.
- `app/features/nodes/` and `app/features/properties/` service/repository layers remain as a private compatibility shim for tasks, assets, import, shares, activity, undo, and plugins while those islands are ported.

### Data & Migration

- Existing workspaces have been seeded into the encrypted operation relay using `scripts/seed_relay_from_postgres.py --all --direct`.
- A full PostgreSQL backup and workspace-data backup were captured before destructive changes:
  - `data/backups/notees-20260718-085505.dump`
  - `data/backups/notees-data-20260718-085514.tar.gz`

### Developer Notes

- `frontend/src/core/` is now the default path for state, hooks, and sync.
- `frontend/src/runtime/` (`OperationRuntime`) is still used by the block-tree overlay and several editor hooks; it will be removed once the remaining features are ported.
- `agents/plans/phase6-cleanup-deprecation.md` details what was removed, what was kept, and what is scheduled for Phase 7.
