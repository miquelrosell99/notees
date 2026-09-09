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
The field-level wire contract (envelope fields, HLC rules, versioning policy) lives in `protocol/SPEC.md`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/relay/batch` | Push a batch of relay operation envelopes to the relay. |
| `POST` | `/api/relay/catch-up` | Pull operation envelopes past a server-assigned seq cursor, paginated. |
| `GET` | `/api/relay/snapshot` | Return the newest snapshot for a workspace. |
| `POST` | `/api/relay/snapshot` | Create a relay snapshot up to a given HLC (admin/owner only). |
| `POST` | `/api/relay/compact` | Compact relay envelopes up to a given HLC (admin/owner only). |
| `GET` | `/api/relay/stats` | Return operational statistics for a workspace relay. |
| `WS` | `/api/relay/ws/{workspace_id}` | WebSocket endpoint for real-time sync broadcasts. |

### `/api/relay/batch`

Accepts a `BatchRequest` body containing relay operation envelopes. Returns the count and ids of saved envelopes.

Rate limit: 30,000 envelopes per minute, keyed by actor and workspace.

### `/api/relay/catch-up`

Accepts a `CatchUpRequest` body with an `after_seq` cursor (the server-assigned sequence number of the last applied envelope; `0` for a cold start). Returns paginated envelopes with `seq > after_seq` plus `next_after_seq`/`has_more` for paging.

Rate limit: 600 requests per minute, keyed by actor and workspace. The default/requestable page size is capped at 10,000 envelopes.

### `/api/relay/snapshot` (GET)

Query parameters: `workspace_id`. Requires an authenticated workspace member — public share tokens are not accepted because the snapshot contains the full derived database (share readers use node-filtered catch-up instead). Returns the newest snapshot's metadata: HLC, the covered `up_to_seq` cursor, and the workspace `restore_epoch`. The blob itself is served as a raw binary body by `GET /api/relay/snapshot/data` (404 when none); clients probe the metadata first, then download the blob only when it is newer than their local watermark, restore it, and catch up operations past `up_to_seq`.

Rate limit: 60 requests per minute, keyed by actor and workspace.

### `/api/relay/snapshot` (GET)

Metadata only, see above. `GET /api/relay/snapshot/data` returns the blob as
`application/octet-stream` (404 when none); `PUT /api/relay/snapshot/data`
with a raw binary body and `physical`/`logical` query params uploads one.

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
