---
status: active
created: 2026-08-22
branch: feat/local-first-split
---

# Local-first split — client runs serverless, sync optional

## Context

The web client is baked into the backend image (`compose.yaml`); the Flutter
app lives in a separate repo. A protocol hardening round (server seq cursors,
typed WS framing, fail-loud versioning — see `protocol/SPEC.md`) just landed,
so the sync contract is stable enough to make the server optional.

## Problem

Today the client cannot boot without a backend: the render-blocking chain is
`GET /auth/status` → `/auth/me` → `/workspaces` → `/settings`
(`AppRoutes.tsx:207-393`), workspace open blocks on `syncEngine.initialize()`
(`workspaceStoreAdapter.ts:157`), a 30s outage triggers a full-screen UI lock
(`useBackendHealth.ts:67-77`), and assets live only on the server
(`app/features/assets/service.py`). Users who want a purely local notes app —
or want to try before deploying — can't use the product.

## Options Considered

See `alternatives.md`. Chosen: **A — local profile in the existing client,
server as optional sync target** (B: separate lite build; C: embedded local
server — both rejected, reasons in the file).

## Chosen Approach

One client, three connection states: `local` (no server configured),
`connected`, `unreachable` (configured but down). A runtime server-URL setting
(empty = local mode) drives capability gating. Local mode uses a synthetic
local identity and a client-seeded local workspace; the op log stays the
source of truth so attaching a server later is a sync operation, not a
migration. Flutter inherits the same model via `protocol/SPEC.md` (separate
repo, out of scope here beyond the contract note).

## Requirements & Acceptance Criteria

- R1: `npm run build` artifact served statically (no backend) boots to a usable
  editor: create/edit pages, blocks, tasks, properties; restart persists
  everything. Acceptance: Playwright e2e with the API route fully blocked.
- R2: Login screen offers "Continue locally"; local mode never calls `/api/*`
  (acceptance: e2e with a fetch/XHR spy asserting zero calls).
- R3: With a server URL configured, current behavior is unchanged (existing
  e2e suite passes).
- R4: Server-only UI (shares, notifications, import/export, admin, account
  security, workspace management) is hidden in local mode, not merely broken.
- R5: Image assets upload/render/persist in local mode (bytes in IndexedDB).
- R6: Attaching a server URL to an existing local profile replays the local op
  log into a fresh server workspace and syncs bidirectionally from there
  (acceptance: integration test — local edits appear on a second client).
- R7: `notees-web` standalone container image + docs; `compose.yaml` keeps
  working as-is (all-in-one stays the default).

## Out of Scope

- Flutter implementation (contract documented in SPEC; repo is separate).
- Merging a local identity into an existing server *account* (v1 replays into
  a new workspace; see `contracts.md` § adoption).
- E2EE of payloads (unchanged roadmap item).
- Removing the all-in-one image.

## Task Breakdown

Interfaces are pinned in `contracts.md`; build order + parallel cut-points in
`rollout.md`.

### Task 1 — Runtime server config + connection state
- **Files**: owns `frontend/src/config/serverUrl.ts` (new),
  `frontend/src/stores/connectionStore.ts` (extend), `frontend/src/api/client.ts`
  (baseURL resolution); shares `frontend/src/core/transportHttp.ts` (read).
- **Produces**: `getServerUrl(): string | null`, `setServerUrl(url | null)`,
  `useConnectionMode(): 'local' | 'connected' | 'unreachable'`; axios +
  HttpTransport resolve base URL from it (`null` → no client instantiation).
- **Acceptance**: unit tests for URL resolution + mode transitions; `tsc` clean.

### Task 2 — Local session + boot bypass
- **Files**: owns `features/auth/stores/authStore.ts`,
  `features/auth/components/LoginView.tsx`,
  `features/layout/components/AppRoutes.tsx` (guard chain); forbidden:
  `api/client.ts` internals beyond consuming Task 1.
- **Consumes**: Task 1 mode.
- **Produces**: `loginLocally()` creating a persisted local session
  (`{ uuid, email: 'local', isLocal: true }`); guard chain short-circuits all
  four boot queries in local mode; health polling + UI lock disabled.
- **Acceptance**: R2 e2e spy; boot-to-editor with API blocked (Playwright).

### Task 3 — Client-side workspace seed
- **Files**: owns `frontend/src/core/seed.ts` (new or extend existing seed
  module — check `frontend/src/core/store.ts` seed paths first),
  `workspaceStoreAdapter.ts` init path.
- **Consumes**: Task 2 local session; system class UUIDs
  (`@/constants/systemProperties`).
- **Produces**: `ensureLocalWorkspace(client)` emitting the same op sequence
  as `app/core/seed.py` (class.create for system classes + Inbox page) into the
  local store; `SyncEngine.initialize()` skipped in local mode.
- **Acceptance**: fresh IndexedDB boot shows Inbox; reload preserves content;
  unit test asserting the seed op sequence.

### Task 4 — Capability gating
- **Files**: owns `frontend/src/config/capabilities.ts` (new) + the UI entry
  points enumerated in `architecture.md` § gating; forbidden: feature internals.
- **Consumes**: Task 1 mode.
- **Produces**: `useCapabilities()` → `{ shares, notifications, importExport,
  admin, accountSecurity, workspaceManagement, activity, collabPresence }`;
  entry points hidden when false.
- **Acceptance**: R4 — grep/e2e: no gated nav item renders in local mode;
  connected mode renders all.

### Task 5 — Local asset store
- **Files**: owns `frontend/src/features/assets/api/localAssets.ts` (new),
  `features/assets/api/assets.ts` (dispatch), `AssetImage.tsx` URL resolution.
- **Consumes**: Task 1 mode; asset op shape (`asset.upload`).
- **Produces**: IndexedDB blob store keyed by content hash; `getAssetUrlAsync`
  returns object URLs in local mode; upload emits `asset.upload` op with
  bytes stored locally.
- **Acceptance**: R5 — upload → render → reload → still renders (e2e).

### Task 6 — Connect-later adoption
- **Files**: owns `frontend/src/core/adoption.ts` (new), settings UI for server
  URL; consumes `protocol/SPEC.md` §4.2.
- **Produces**: `adoptServer(url)`: create server workspace, replay local op
  log as envelopes (workspace/actor remapped), then normal seq-cursor sync.
- **Acceptance**: R6 integration test.

### Task 7 — Packaging
- **Files**: owns `Dockerfile.web` (new), `compose.web.yaml` (new),
  `.github/workflows/` (web image), `docs/installation.md`.
- **Acceptance**: `docker build -f Dockerfile.web` serves the app; R1 e2e runs
  against it.

## Open Questions

- None blocking. Deferred-by-decision (recorded, not open): account merging on
  connect (v1 = replay into new workspace); whether local mode should allow
  *multiple* local workspaces (v1: single).

## Synthesis

Chosen path: Option A — local profile in the existing client, server as an
optional sync target; no backend or protocol changes.

- `alternatives.md` — why A over a lite build (B) or embedded local server (C).
- `architecture.md` — coupling map with file:line evidence; target shape;
  the gating-surface inventory Task 4 consumes.
- `contracts.md` — runtime config, local session shape, local seed, asset
  store, and the adoption sequence with its pinned class.create dedupe detail.
- `rollout.md` — build order (T1→T2→T3 sequential, T4∥T5, T6/T7 tail),
  failure-mode decisions (unreachable server no longer blocks workspace open),
  verification strategy, rollback.
