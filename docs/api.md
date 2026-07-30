# API Reference

Notees exposes a REST API under `/api/*`. The same routes are also mirrored under `/api/v1/*`.

Most data reads and writes in the web app go through the local-first SQLite store and the operation relay, not the legacy mutable endpoints. Public-share and server-state endpoints (auth, workspaces, shares, activity) still use the REST API directly.

---

## Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Authenticate a user and obtain tokens. |
| `GET` | `/api/auth/status` | Check current authentication status. |

Authentication uses short-lived JWT access tokens and rotating refresh tokens. See [Configuration](configuration.md) for token lifetime settings.

---

## Operation relay

The relay is the sync path for the local-first core. All operation-log traffic goes through these endpoints.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/relay/batch` | Push a batch of encrypted operation envelopes to the relay. |
| `POST` | `/api/relay/catch-up` | Pull operation envelopes newer than a given HLC, paginated. |
| `GET` | `/api/relay/latest-snapshot` | Return the newest snapshot for a workspace. |
| `POST` | `/api/relay/snapshot` | Create a relay snapshot up to a given HLC (admin/owner only). |
| `POST` | `/api/relay/compact` | Compact relay envelopes up to a given HLC (admin/owner only). |
| `GET` | `/api/relay/stats` | Return operational statistics for a workspace relay. |
| `WS` | `/api/relay/ws/{workspace_id}` | WebSocket endpoint for real-time sync broadcasts. |

### `/api/relay/batch`

Accepts a `BatchRequest` body containing encrypted operation envelopes. Returns the count and ids of saved envelopes.

Rate limit: 30,000 envelopes per minute, keyed by actor and workspace.

### `/api/relay/catch-up`

Accepts a `CatchUpRequest` body with an HLC cursor and optional pagination `after_id`. Returns paginated envelopes newer than the cursor.

Rate limit: 600 requests per minute, keyed by actor and workspace. The default/requestable page size is capped at 10,000 envelopes.

### `/api/relay/latest-snapshot`

Query parameters: `workspace_id`, optional `share_token`. Returns the newest snapshot as base64-encoded SQLite bytes, plus its HLC and the workspace `restore_epoch`. Clients can restore the snapshot and then catch up only operations newer than the snapshot HLC.

### `/api/relay/snapshot`

Creates a relay snapshot up to the provided HLC. Requires workspace ownership or admin role.

### `/api/relay/compact`

Compacts relay envelopes up to the provided HLC. Requires workspace ownership or admin role.

---

## Daily journal

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/daily` | Get or create the daily page for a date. |

---

## Query views

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/nodes/views/execute` | Run an ad-hoc QueryAST without saving a view. |

Saved views are implemented as nodes with the `query` class; the QueryAST is evaluated client-side against the local SQLite store. The `/api/nodes/views/execute` endpoint is available for server-side ad-hoc execution.

---

## Removed endpoints

The legacy mutable endpoints have been removed:

- `/api/nodes/*`
- `/api/properties/*`
- `/api/sync/*`

The frontend now reads and writes through the local SQLite store and syncs via `/api/relay/*`.

---

## OpenAPI

When the backend is running, the interactive API documentation is available at:

- `/docs` — Swagger UI
- `/redoc` — ReDoc

These are generated automatically from the FastAPI routers.
