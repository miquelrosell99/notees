# Phase 5: Server Relay Hardening and Production Cut-Over

**Date:** 2026-07-18  
**Status:** Complete — all E1–E4 sub-tasks implemented and committed  
**Depends on:** Phase 4 (frontend cut-over) complete  
**Leads to:** Phase 6 (cleanup and deprecation)

---

## Goal

Make the encrypted operation relay (`app/relay/`) production-ready by replacing stub permissions with real workspace membership/share checks, adding workspace key management, adding real-time WebSocket forwarding, hardening catch-up for large workspaces, and proving the system with multi-client convergence and load tests.

At the end of Phase 5 the server should be the authoritative operation relay for all write operations, and the legacy FastAPI mutation endpoints should be considered deprecated (though still mounted for backward compatibility until Phase 6).

---

## What already exists (after Phase 4)

- `app/relay/router.py` — HTTP endpoints `/api/relay/batch` and `/api/relay/catch-up`.
- `app/relay/service.py` — `RelayService` with permission checks, deduplication, catch-up.
- `app/relay/storage.py` — `SqliteRelayStorage` with persistent SQLite file at `data/relay/relay.db`.
- `app/relay/permissions.py` — `StubPermissionChecker` (always allows).
- `app/relay/dependencies.py` — builds storage, permissions, actor id from header/state.
- `app/relay/models.py` — envelope/request/response models using `ciphertext` + `iv`.
- `app/core/crypto.py` — workspace key derivation from `workspace_id + SECRET_KEY`.
- `frontend/src/core/transportHttp.ts` — `HttpTransport` calling the relay HTTP endpoints.
- `scripts/seed_relay_from_postgres.py` — seeds relay from existing PostgreSQL workspaces.

What is missing:
- Real permission checks based on workspace ownership and `workspace_share` records.
- Node-level share/public-link integration with the relay.
- WebSocket endpoint for real-time operation forwarding per workspace.
- Paginated catch-up and snapshot delivery for large workspaces.
- Workspace key management endpoints (invite, rotate, retrieve wrapped keys).
- Convergence and load tests across multiple clients.

---

## Design decisions

1. **Permission model:**
   - Workspace owners have full read/write.
   - Shared members have read/write based on `workspace_share` columns (`s_can_write`, `s_can_delete`).
   - Public share tokens grant read-only access to specific nodes.
   - The relay checks workspace membership for read; for write it checks both workspace membership and, if `affected_node_ids` includes publicly shared nodes, the share permission.

2. **WebSocket transport:**
   - One WebSocket connection per client, subscribed to one or more workspaces.
   - Server forwards newly received envelopes to all subscribers of the relevant workspace.
   - Envelopes are still encrypted end-to-end; the server only reads routing metadata.

3. **Catch-up pagination:**
   - Add `limit`/`cursor` (HLC + id) to `/api/relay/catch-up`.
   - Clients page through history until they reach the latest operation.
   - Add optional `/api/relay/snapshot` endpoint that returns a derived SQLite snapshot for very large workspaces.

4. **Key management:**
   - Each workspace has a symmetric master key derived on the server from `workspace_id + SECRET_KEY`.
   - For each member, the master key is wrapped with the member's public key (or a shared invite secret) and stored.
   - Members fetch their wrapped key and unwrap it locally.
   - Key rotation re-wraps the master key for all active members.

5. **Legacy endpoints:**
   - Keep `app/features/nodes/router.py`, `app/features/properties/router.py`, etc., mounted but mark them deprecated in OpenAPI.
   - They continue to mutate PostgreSQL directly; the frontend only uses them when `VITE_ENABLE_SQLITE_STORE` is off.

---

## Sub-Task Breakdown

### E1 — Relay HTTP/WebSocket endpoints ✅ Done

**Status:** Committed as `feat(relay): Phase 5 E1 WebSocket and paginated catch-up` (`7016e8f2`).

**Goal:** Add real-time forwarding and paginated catch-up.

**Files to create:**
- `app/relay/websocket.py` — WebSocket endpoint `/api/relay/ws/{workspace_id}`.
  - Accepts connection, authenticates actor, subscribes to a workspace broadcast channel.
  - Receives client envelopes and forwards them to `RelayService.receive_batch`.
  - Broadcasts validated envelopes to all subscribers of the same workspace.
- `app/relay/broadcast.py` — in-memory subscriber registry (`workspace_id -> set[WebSocket]`).
- `tests/core/test_relay_ws.py` — WebSocket connection, subscription, and broadcast tests.

**Files to modify:**
- `app/relay/router.py`:
  - Add paginated catch-up query params (`limit`, `after_hlc_physical`, `after_hlc_logical`, `after_id`).
  - Add `/api/relay/snapshot` placeholder endpoint (returns 501 until E4 if time permits).
  - Add WebSocket route from `websocket.py`.
- `app/relay/service.py`:
  - Add `receive_and_broadcast` helper that persists an envelope and notifies subscribers.
  - Add paginated `catch_up` variant.
- `app/relay/storage.py`:
  - Add `get_catch_up_paginated(workspace_id, hlc, limit, after_id)` returning `(envelopes, next_hlc, next_id, has_more)`.
  - Ensure HLC comparison is lexicographic.
- `app/main.py`:
  - Ensure WebSocket route is mounted; no additional changes expected.

**Verification:**
- `uv run pytest tests/core/test_relay_ws.py tests/core/test_relay_router.py -m unit --no-cov` passes.
- WebSocket broadcast test: client A sends envelope, client B receives it.

**Results:**
- `uv run pytest tests/core/test_relay_ws.py tests/core/test_relay_router.py tests/core/test_relay.py -m unit --no-cov` → 25 passed.
- `uv run ruff check app/relay` → clean.
- `cd frontend && npm run test:run src/core && npx tsc -b --noEmit` → 52 passed, typecheck clean.

---

### E2 — Permission + share integration ✅ Done

**Status:** Committed as `feat(relay): Phase 5 E2 real permissions and share integration` (`62dfb08a`).

**Goal:** Replace `StubPermissionChecker` with real checks against PostgreSQL workspace membership and node shares.

**Files to create:**
- `app/relay/permissions_postgres.py` — `PostgresPermissionChecker` implementing `PermissionChecker`.
  - `can_read(workspace_id, actor_id)` — true if owner or active workspace_share exists.
  - `can_write(workspace_id, actor_id, affected_node_ids)` — true if owner or share with `s_can_write`; also true if all affected nodes are covered by node-level shares with write permission.
- `tests/core/test_relay_permissions.py` — tests for read/write denial and public share read.

**Files to modify:**
- `app/relay/dependencies.py`:
  - Use `PostgresPermissionChecker` by default; keep `StubPermissionChecker` for tests/PYTEST.
  - Provide a way to inject the PostgreSQL pool into the permission checker.
- `app/relay/permissions.py`:
  - Keep `PermissionChecker` ABC and `StubPermissionChecker`; add `PostgresPermissionChecker` import re-export if placed in a separate file.
- `app/features/shares/repository.py`:
  - Add `get_node_share_permissions(workspace_id, node_id, token)` or similar to resolve public-share read access.
- `app/relay/router.py`:
  - Update `catch_up` to allow public-share tokens via query param for read-only access.
  - Update `receive_batch` to reject anonymous actors (no write without auth).

**Verification:**
- `uv run pytest tests/core/test_relay_permissions.py -m unit --no-cov` passes.
- Unauthorized actor cannot read/write.
- Public-share token can read but not write.

**Results:**
- `uv run pytest tests/core/test_relay_permissions.py tests/core/test_relay.py tests/core/test_relay_router.py tests/core/test_relay_ws.py -m unit --no-cov` → 34 passed.
- `uv run ruff check app/relay` → clean.
- `cd frontend && npm run test:run src/core && npx tsc -b --noEmit` → 52 passed, typecheck clean.

---

### E3 — Key management + encryption ✅ Done

**Status:** Committed as `feat(relay): Phase 5 E3 workspace key management and frontend unwrap` (`25614d77`).

**Goal:** Provide endpoints for workspace key retrieval, member invitation, and rotation.

**Files to create:**
- `app/relay/key_management.py` — service class:
  - `get_or_create_workspace_key(workspace_id)` derives the master key.
  - `wrap_key_for_user(workspace_id, user_id, public_key)` returns wrapped key.
  - `rotate_workspace_key(workspace_id, actor_id)` creates a new master key and re-wraps for active members.
- `app/relay/key_models.py` — Pydantic models for key requests/responses.
- `app/relay/key_router.py` — FastAPI router `/api/relay/keys`:
  - `GET /keys/{workspace_id}` — return the caller's wrapped key.
  - `POST /keys/{workspace_id}/invite` — owner/admin invites a user and returns their wrapped key / invite secret.
  - `POST /keys/{workspace_id}/rotate` — owner/admin rotates the workspace key.
- `tests/core/test_relay_keys.py` — key retrieval, invite, rotation tests.

**Files to modify:**
- `app/core/crypto.py`:
  - Add `derive_workspace_key_v2` with salt rotation support.
  - Add `wrap_key(master_key, wrapping_key) -> bytes` and `unwrap_key(wrapped, wrapping_key) -> bytes` using AES-KW or simple AES-GCM.
- `app/relay/router.py`:
  - Include `key_router` under `/api/relay`.
- `frontend/src/core/crypto.ts`:
  - Add `unwrapWorkspaceKey(wrappedKey: Uint8Array, wrappingKey: CryptoKey): Promise<CryptoKey>`.
  - Update `deriveKey` to match backend v2 derivation.

**Verification:**
- `uv run pytest tests/core/test_relay_keys.py -m unit --no-cov` passes.
- Frontend typecheck and core tests still pass.

**Results:**
- `uv run pytest tests/core/test_relay_keys.py tests/core/test_relay_permissions.py tests/core/test_relay.py tests/core/test_relay_router.py tests/core/test_relay_ws.py -m unit --no-cov` → 52 passed.
- `uv run ruff check app/relay app/core/crypto.py` → clean.
- `uv run python scripts/validate_migration.py` → 0 orphans, 0 duplicates.
- `npm run test:run src/core` → 17 files, 56 tests passed.
- `npx tsc -b --noEmit` and `npm run lint` → clean (only pre-existing warnings).

---

### E4 — Conformance and load tests ✅ Done

**Status:** Committed as `test(relay): Phase 5 E4 convergence and load tests` (`2ec3d6f1`).

**Goal:** Prove multi-client convergence and catch-up performance.

**Files to create:**
- `tests/core/test_relay_convergence.py`:
  - Two in-memory `WorkspaceStore` instances connected via `MemoryTransport` or a test relay.
  - Interleaved offline edits, then sync, assert derived state matches.
- `tests/core/test_relay_load.py`:
  - Generate 10k operations, seed relay, time catch-up replay.
  - Assert catch-up completes within acceptable threshold.
- `frontend/src/core/__tests__/convergence.test.tsx`:
  - Browser-ish test: two React test renderers share a relay, make concurrent edits, assert UI state converges.

**Files to modify:**
- `scripts/seed_relay_from_postgres.py`:
  - Optionally run a smoke convergence test after seeding.
- `app/relay/storage.py`:
  - Add operation-count and storage-size metrics helpers for load tests.

**Verification:**
- `uv run pytest tests/core/test_relay_convergence.py tests/core/test_relay_load.py -m unit --no-cov` passes.
- Load test reports acceptable catch-up latency.

**Results:**
- `uv run pytest tests/core/test_relay_convergence.py tests/core/test_relay_load.py tests/core/test_relay_keys.py tests/core/test_relay_permissions.py tests/core/test_relay.py tests/core/test_relay_router.py tests/core/test_relay_ws.py -m unit --no-cov` → 62 passed.
- `uv run ruff check app/relay app/core/crypto.py scripts/seed_relay_from_postgres.py` → clean.
- `uv run python scripts/validate_migration.py` → 0 orphans, 0 duplicates.
- `npm run test:run src/core` → 18 files, 59 tests passed.
- `npx tsc -b --noEmit` and `npm run lint` → clean (only pre-existing warnings).
- Load-test timings: 1k ops ~0.008 s, 10k ops ~0.066 s.

---

## Integration Flow

1. Client opens app; `App.tsx` detects `VITE_ENABLE_SQLITE_STORE`.
2. Client fetches wrapped workspace key from `/api/relay/keys/{workspace_id}`.
3. Client unwraps key locally and opens `WorkspaceStore` from IndexedDB.
4. Client calls `/api/relay/catch-up` (paginated) to backfill missing operations.
5. Client connects WebSocket `/api/relay/ws/{workspace_id}` for live operations.
6. Local mutations create operations; `HttpTransport` pushes batches to `/api/relay/batch`.
7. Server persists, broadcasts to other subscribers, and the local store applies remote operations.

---

## Snapshot Commit Policy for Phase 5

Commit after each sub-task E1–E4:
- `feat(relay): Phase 5 E1 WebSocket and paginated catch-up`
- `feat(relay): Phase 5 E2 real permissions and share integration`
- `feat(relay): Phase 5 E3 workspace key management`
- `test(relay): Phase 5 E4 convergence and load tests`

Final Phase 5 milestone commit:
- `feat(relay): Phase 5 server relay hardening complete`

---

## Open Questions to Resolve During Implementation

1. Should WebSocket connections authenticate via existing JWT cookie/session or a separate relay token?
2. Should the relay store use PostgreSQL instead of SQLite for production? (SQLite is acceptable for the prototype slice.)
3. How should node-level public shares be represented in the relay envelope routing metadata?
4. What is the catch-up pagination page size default? (Proposal: 1,000 operations.)
5. Should snapshot endpoint be implemented in Phase 5 or deferred to Phase 6?

---

## Verification Gate for Phase 5

Before declaring Phase 5 complete, run:

```bash
# Backend
uv run pytest tests/core tests/relay -m unit --no-cov
uv run ruff check app/relay app/main.py app/core/crypto.py scripts/seed_relay_from_postgres.py
uv run python scripts/validate_migration.py

# Frontend
cd frontend
npm run test:run src/core
npx tsc -b --noEmit
npm run lint

# Manual
# 1. Seed a workspace with scripts/seed_relay_from_postgres.py.
# 2. Open two browser tabs with VITE_ENABLE_SQLITE_STORE=true.
# 3. Create/edit nodes in both tabs, verify convergence.
# 4. Revoke a member's access, verify they stop receiving operations.
```

All gates must pass before moving to Phase 6.
