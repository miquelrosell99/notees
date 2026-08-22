# Architecture — where the change lands

> Conclusion: all work is frontend + packaging; the backend and relay protocol are untouched — that is the point of the op-log design.

## Evidence-based coupling map (from code inspection 2026-08-22)

- **Boot gate chain** (each shows `LoadingScreen`): `authRestored` →
  `GET /auth/status` → `GET /auth/me` → `GET /workspaces` → `GET /settings`
  — `frontend/src/features/layout/components/AppRoutes.tsx:207-393`.
- **Workspace identity comes from the URL** (`/:workspaceId/*`,
  `useCurrentWorkspaceUuid.ts:7-10`); first-login creation is user-driven via
  `POST /workspaces` — there is no client-side bootstrap path.
- **Workspace open blocks on first sync** — `workspaceStoreAdapter.ts:157`
  (`syncEngine.initialize()`); failure = error overlay. `Transport` is already
  an interface (`core/transport.ts`) with a `MemoryTransport` test double, so
  a null/local transport is cheap.
- **Health watchdog locks the UI** after 30s of outages
  (`hooks/useBackendHealth.ts:67-77`) — must be inert in local mode.
- **Assets**: node with system class `asset`; bytes fetched at
  `/api/assets/{uuid}` keyed by the node's own uuid
  (`AssetImage.tsx:107`); bytes are server disk only, content-addressed
  (`app/features/assets/service.py:94-123`). 404 → placeholder, upload fails.
- **API base URL is hardcoded same-origin** (`api/client.ts:131-135`,
  `transportHttp.ts:60-64`); no runtime config mechanism exists.

## Target shape

```
                 ┌─────────────────────────────┐
                 │ Web client / Flutter        │
                 │  ┌───────────────────────┐  │
  static host or │  │ local runtime         │  │      ┌───────────────┐
  installed app  │  │ sql.js + IndexedDB    │  │      │ notees-sync   │
  (no server) ──►│  │ op log + derived view │  │◄────►│ (optional)    │
                 │  │ outbox + SyncEngine   │  │ relay│ relay + auth  │
                 │  └───────────────────────┘  │      └───────────────┘
                 │  connection mode: local |   │   only when a server URL
                 │  connected | unreachable    │   is configured
                 └─────────────────────────────┘
```

## Gating surfaces (Task 4 inventory)

- Nav/AccountMenu: Shares, Notifications, Mentions (`AccountMenu.tsx:233-245`).
- Settings modals: account/security tabs (`UserSettingsModal.tsx:363-364`),
  admin tab (`SystemSettingsModal.tsx:34`).
- Workspace switcher/management (`WorkspaceManagementView`), import/export
  modals (`features/workspace/components/`).
- Routes: `/onboarding`, `/invite/*`, `/enroll/*`, `/s/:shareUuid` stay
  server-mode only; local mode roots at `/local/…` or a fixed local workspace
  UUID.
- Activity context-menu delete and task recurrence call server endpoints —
  keep visible only where they already have local fallbacks, else gate
  (decision per `capabilities.ts` mapping; default: gate).

## Data flow in local mode

Writes append ops to the local op log exactly as today; `SyncEngine` is
constructed with a no-op transport (or not started); the outbox accumulates.
On server attach (Task 6), the outbox + full log replay through the normal
batch endpoint with remapped workspace/actor ids, then seq-cursor sync takes
over — no protocol change required (`protocol/SPEC.md` already versioned).
