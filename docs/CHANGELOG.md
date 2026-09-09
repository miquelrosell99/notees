# Notees Changelog

## 3.0.0 — Sync hardening: security boundary, realtime, E2EE, single-engine OPFS

**Date:** 2026-09-09

The full sync-hardening program (`docs/plans/sync-hardening-v1.1.md`). Breaking
changes are marked **[breaking]**.

### Security

- **[breaking]** Relay endpoints derive actor identity from authenticated credentials only; the `X-Actor-Id` header is no longer trusted (closes an impersonation bypass).
- **[breaking]** `GET /api/relay/snapshot` no longer accepts share tokens; snapshots are members-only (closes a full-workspace leak via public shares).
- Rate limits now charge per envelope on batch and cover snapshot/stats/WS surfaces.
- Snapshot creation is atomic with its recorded `up_to_seq` (table lock in one transaction).
- The unused server-side key-management prototype (`/api/relay/keys/*`) is removed.

### Realtime

- Every committed batch (HTTP or WS) is broadcast to relay WS subscribers; `ops` frames carry per-envelope `seqs`; the WS subscribes before `hello` (connect race closed). The web client connects with catch-up resume — WS is strictly an acceleration path over the seq cursor.
- Presence (focus/blur/typing, users list) rides the relay WS. **[breaking]** `/api/ws/live` and `LiveSyncManager` are removed.

### Sync engine

- Scalar node fields (icon/color/active/parent/kind) resolve last-write-wins per field; class membership is an OR-Set (add-wins on ties); any op arrival order converges (derived-state v5).
- Legacy positional child-order payloads (`node.create.index`, `node.move.newIndex`) are backfilled on replay — full-log replay is no longer structure-destroying.
- Sync status is honest: real pending/failed counts, offline state, quarantined-op retry, parked-changes recovery after a server restore (un-synced local ops are no longer discarded).
- Catch-up applies page-by-page with per-page cursor advance (no full-backlog buffering); write permission checks run once per batch; snapshots retain the newest 5 per workspace.

### End-to-end encryption (opt-in per workspace)

- Workspace payloads and snapshots encrypt client-side (AES-GCM, random per-workspace key); the relay sees only routing metadata. Encrypted envelopes carry `protocolVersion` 2 (older clients fail loud).
- Key sharing: passphrase-derived KEK blob (recovery) plus per-member X25519/ECDH-wrapped copies (v2). Silent unlock via device identity; owner wrap sweep on open; **[breaking-era semantics]** member removal rotates the workspace key (forward secrecy for new ops).

### Persistence **[breaking]**

- Single persistence engine: the workspace database is a wa-sqlite OPFS file, durable on every commit. The sql.js in-memory + whole-DB export → IndexedDB pipeline is removed. Existing workspaces convert automatically on first open (seed + integrity verification; the old IndexedDB record is left inert).

### Wire format

- **[breaking]** Snapshot blobs move to binary endpoints (`GET/PUT /api/relay/snapshot/data`); `GET /snapshot` is metadata-only.
- Yjs updates ship as base64 incremental deltas (`textUpdateB64`/`treeUpdateB64`); legacy full-state payloads still apply.

### Docs

- `protocol/SPEC.md`: §4.3/§4.4 binary snapshots, §5 presence frames + seq frames, §7 supported versions ≤ 2, §8 E2EE v1/v2.

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
- `skills/notees/references/agents/plans/notees-phase7-plus-plan.md` is marked complete.

## Phase 12 — Cleanup and roadmap

**Date:** 2026-07-20

### Cleanup debt

- **Shares UUID migration**: share metadata tables (`node_public_share`, `node_share`, `pending_invite`) now use `node_uuid` instead of the legacy numeric `node_id`. The frontend `/nodes/{uuid}/shares` and `/nodes/{uuid}/user-shares` endpoints no longer depend on the legacy `node` table.
- **Node-scoped share router**: `node_shares_router` is mounted under `/api/nodes` and `/api/v1/nodes`.
- **Collab permission repository migrated to `node_uuid`**: `PostgresPermissionRepository` and `PermissionChecker` now resolve node-level shares by UUID, removing the last internal consumer of `node_share.node_id`. `app/features/collab/yjs_service.py` checks permissions directly against the node UUID.

### Rich-text CRDT polish

- Added `TextCrdt.format()` and `TextCrdt.toDelta()` in `frontend/src/core/crdt/text.ts`.
- Added tests proving formatting attributes survive CRDT state reload and concurrent merge.

### Plugin ecosystem expansion

- Added built-in `notees.opml_exporter` plugin that exports node trees to OPML 2.0.
- Extended `ExportContext` with `nodes_data` so plugin exporters can consume the already-fetched tree.

### Scale testing and stress tests

- Added backend stress suite (`tests/core/stress/`): replay, catch-up, storage overhead, multi-client convergence.
- Added frontend stress suite (`frontend/src/core/__tests__/stress/`): apply latency, snapshot restore, catch-up, convergence burst.
- Added benchmark report at `skills/notees/references/agents/plans/phase12-scale-benchmark.md`.

### Dev environment

- Removed operation-log payload encryption from the relay. Operation payloads are now plaintext JSON; confidentiality is provided by transport-layer encryption (TLS in production, Tailscale/WireGuard in dev).
- Simplified the dev server to plain HTTP on port `5173`, matching the Home Assistant/Jellyfin self-hosted model. No bundled reverse proxy, no HTTPS inside the container.
- Deleted `frontend/scripts/dev-server.cjs`, `frontend/scripts/start-dev.sh`, and `frontend/nginx.dev.conf`.
- `frontend/Dockerfile.dev` now runs `npm run dev` directly on port `5173`; `openssl` removed.
- `compose.dev.yaml` exposes only `"5173:5173"`; removed `VITE_WORKSPACE_KEY_SECRET` and port `5172`.
- `frontend/vite.config.ts` restored to `server.port: 5173`.
- Host access: `http://localhost:5173`; over Tailscale `http://atlas:5173` now works without `crypto.subtle` errors. Add your own reverse proxy for HTTPS if desired.

### Verification

- `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 402 passed, 3 skipped, 6 deselected, 1 warning.
- `cd frontend && npx tsc -b --noEmit && npm run lint` → clean (0 errors, 5 pre-existing warnings).
- `cd frontend && npm run test:run` → 91 files / 582 passed.
- `npm run test:e2e` → 5/5 passed.

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

## Phase 13 — Residual cleanup debt

**Date:** 2026-07-20

### Schema migrations

- **`node_yjs_state` is now UUID-keyed**: the collab Yjs state table uses `node_uuid UUID PRIMARY KEY` instead of the legacy integer `node_id`. An idempotent migration backfills `node_uuid` from `node.uuid` and drops the old column. A foreign key to `node(uuid)` is not enforced because system-class UUIDs are shared across workspaces, so `node.uuid` is only unique per workspace.
- **`notification` references nodes by UUID**: the `notification` table uses `node_uuid UUID` instead of `node_id`. An idempotent migration backfills and drops the legacy integer column.

### Code updates

- `app/features/collab/yjs_repository.py` queries and upserts Yjs state by `node_uuid`; the `resolve_node_id` helper and internal `_by_node_id` methods were removed.
- `app/features/collab/yjs_service.py` no longer resolves UUID→integer before calling the repository; permissions are checked against the UUID directly.
- `app/features/notifications/{port,repository,service,router}.py` create and list notifications using `node_uuid`.
- `NotificationResponse` now returns `node_uuid` (string | null) instead of `node_id`, matching the frontend `NotificationResponse` type.

### Test cleanup

- `tests/test_visibility_and_shares.py`: removed the legacy `TestPagePrivacy` class (privacy enforcement is covered by `TestPermissionCheckerPrivacy` and relay permission tests). `TestPublicShareStaticHtml` now seeds nodes via direct PostgreSQL inserts and exercises `ShareService` for HTML generation/regeneration/deletion while still verifying static serving through `GET /s/{share_uuid}`.
- Removed broken legacy integration tests whose behavior is already covered by the core/unit suite: `test_sync_v2.py`, `test_benchmarks.py`, `test_node_conversion.py`, `test_date_range_integration.py`, `test_soft_delete.py`, `test_links.py`, `test_optimistic_locking.py`.
- Rewrote remaining integration tests to avoid the deleted `node_service` fixture:
  - `tests/test_retention_cleanup.py` now inserts nodes directly into PostgreSQL.
  - `tests/test_validation.py` now tests node create/update validation through `validate_node_create` / `validate_node_update` and keeps the invite-password tests.
  - `tests/test_yjs_state.py` now creates the test page via direct DB insert.

### Verification

- `uv run pytest tests/test_visibility_and_shares.py -q --no-cov` → 7 passed.
- `uv run pytest tests/test_retention_cleanup.py -q --no-cov` → 8 passed.
- `uv run pytest tests/test_validation.py -q --no-cov` → 9 passed.
- `uv run pytest tests/test_yjs_state.py -q --no-cov` → 3 passed.
- `uv run pytest tests/core/test_collab_router.py tests/core/test_collab_ws.py -q --no-cov` → 9 passed.
- `uv run pytest tests/core tests/unit -m unit --no-cov -q` → 402 passed, 3 skipped, 6 deselected, 1 warning.
- `uv run pytest tests/ -m integration -q --no-cov` → 36 passed; remaining failures are in untouched legacy integration tests that depend on removed endpoints.
