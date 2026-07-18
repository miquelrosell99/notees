# Notees Changelog

## 2.0.0 — Local-first architecture complete (Phases 6–8)

**Date:** 2026-07-18

### Architecture

- The authoritative data model is now an **immutable operation log** with client-side SQLite derived state and an encrypted operation relay.
- The legacy `/api/nodes/*`, `/api/properties/*`, and `/api/sync/*` endpoints have been unmounted. The frontend now reads and writes through the local SQLite store and syncs via `/api/relay/*`.
- The legacy v2 sync dispatcher (`SyncManagerV2`, `localSyncEngine`, `LocalIndexManager`, `QueryLiveUpdater`) and `frontend/src/runtime/` (`OperationRuntime`) have been removed.
- `app/features/nodes/` and `app/features/properties/` have been deleted; all remaining feature islands (tasks, assets, import, shares, activity, undo, plugins, collab) operate on the operation-log core.
- All operations carry unencrypted routing metadata (`affected_node_ids`, `op_type`, HLC) so the relay can enforce node-level shares without decrypting payloads.

### Data & Migration

- Existing workspaces have been seeded into the encrypted operation relay using `scripts/seed_relay_from_postgres.py --all --direct`.
- A full PostgreSQL backup and workspace-data backup were captured before destructive changes:
  - `data/backups/notees-20260718-085505.dump`
  - `data/backups/notees-data-20260718-085514.tar.gz`
- A pre-Phase 8 backup is available at `data/backups/phase8/`.

### Developer Notes

- `frontend/src/core/` is the sole path for state, hooks, and sync.
- `agents/plans/notees-phase7-plus-plan.md` tracks Phase 9 production hardening and Phase 10 release tasks.
