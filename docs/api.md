# API Reference

Notees exposes a REST API under `/api/*`. The same routes are also mirrored under `/api/v1/*`.

Most data reads and writes in the web app go through the local-first SQLite store and the operation relay, not the legacy mutable endpoints. Public-share and server-state endpoints (auth, workspaces, shares, activity) still use the REST API directly.

Authentication for the endpoints below is the session JWT (HTTPOnly cookie or `Authorization: Bearer`); `X-API-Key` is accepted as an alternative on authenticated routes. Bodies are snake_case unless they contain relay envelopes (camelCase, see `protocol/SPEC.md`).

---

## Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Register a user. On first boot this creates the **admin**: the request must carry `admin_password` matching the configured `ADMIN_PASSWORD`, and that configured password becomes the account password. Returns a `Token` (`access_token`, `refresh_token`, `token_type`, `user`) and sets auth cookies. |
| `POST` | `/api/auth/login` | Authenticate with `{email, password, remember_me}`. Returns a `Token`; when the user has TOTP enabled it instead returns `{requires_2fa: true, preauth_token, purpose}` (`purpose` is `"verify"` or `"setup"`) and no session is issued yet. |
| `POST` | `/api/auth/2fa/verify` | Complete a 2FA login: `{preauth_token, code}` (6-digit TOTP or a one-time backup code). Returns a `Token`. |
| `GET` | `/api/auth/status` | Check current authentication status (`needs_onboarding`, `authenticated`, `registration_enabled`). |
| `GET` | `/api/auth/me` | Current user profile (`User`: `id`, `uuid`, `email`, `name`, `role`, `totp_enabled`, ...). |
| `PUT` | `/api/auth/me` | Update profile (`name`, `surnames`, `profile_pic`). Returns the updated `User`. |
| `POST` | `/api/auth/refresh` | Exchange the refresh-token cookie for a new access token (`{access_token, token_type}`); rotates the refresh token and revokes the whole token family on reuse detection. |
| `POST` | `/api/auth/logout` | Clear auth cookies. Returns `{success: true}`. |
| `POST` | `/api/auth/change-password` | `{current_password, new_password}`; invalidates all refresh tokens and API keys. |
| `GET` | `/api/auth/api-keys` | List active API keys (`ApiKeyResponse`: `id`, `name`, `scopes`, `last_4`, `last_used_at`, `revoked`, `created_at`, `expires_at`). |
| `POST` | `/api/auth/api-keys` | Create a key: `{name, scopes?, expires_at?}`. Response adds `key` — the plaintext key is returned **once** and cannot be retrieved later. |
| `DELETE` | `/api/auth/api-keys/{key_uuid}` | Revoke an API key. |
| `POST` | `/api/auth/device-token` | Register a mobile push device token: `{token, platform}`. |

Authentication uses short-lived JWT access tokens and rotating refresh tokens. See [Configuration](configuration.md) for token lifetime settings.

---

## Operation relay

The relay is the sync path for the local-first core. All operation-log traffic goes through these endpoints.
The field-level wire contract (envelope fields, HLC rules, versioning policy) lives in `protocol/SPEC.md`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/relay/batch` | Push a batch of relay operation envelopes to the relay. |
| `POST` | `/api/relay/catch-up` | Pull operation envelopes past a server-assigned seq cursor, paginated. |
| `GET` | `/api/relay/snapshot` | Return the newest snapshot's metadata for a workspace (no blob). |
| `GET` | `/api/relay/snapshot/data` | Download the newest snapshot's blob as a raw binary body. |
| `PUT` | `/api/relay/snapshot/data` | Upload/create a snapshot from a raw binary body (admin/owner only). |
| `POST` | `/api/relay/compact` | Compact relay envelopes up to a given HLC (admin/owner only). |
| `GET` | `/api/relay/stats` | Return operational statistics for a workspace relay. |
| `GET` | `/api/relay/encryption-key` | Return the workspace's wrapped E2EE key blob (members only). |
| `PUT` | `/api/relay/encryption-key` | Store the workspace's wrapped E2EE key blob (owner/admin only). |
| `PUT` | `/api/relay/user-public-key` | Publish the caller's X25519 identity public key. |
| `GET` | `/api/relay/user-public-key` | Return any user's published X25519 public key. |
| `PUT` | `/api/relay/encryption-key/members` | Upsert wrapped workspace-key copies for members (owner/admin only). |
| `DELETE` | `/api/relay/encryption-key/members/{workspace_id}/{user_id}` | Delete one member's wrapped-key copies (owner/admin only). |
| `WS` | `/api/relay/ws/{workspace_id}` | WebSocket endpoint for real-time sync broadcasts. |

### `/api/relay/batch`

Accepts a `BatchRequest` body containing relay operation envelopes. Returns the count and ids of saved envelopes (`{saved_count, saved_ids}`); duplicate ids are silently ignored, so `saved_ids` may omit ids the client sent (retry-safe).

Rate limit: 30,000 envelopes per minute, keyed by actor and workspace.

### `/api/relay/catch-up`

Accepts a `CatchUpRequest` body with an `after_seq` cursor (the server-assigned sequence number of the last applied envelope; `0` for a cold start). Returns paginated envelopes with `seq > after_seq` plus `next_after_seq`/`has_more` for paging, `restore_epoch` (wipe local state and resync when it differs from the stored epoch), and `total_remaining` (envelopes with `seq > after_seq`, including this page — for global catch-up progress). An optional `share_token` query parameter grants read-only access via a public share (node-filtered).

Rate limit: 600 requests per minute, keyed by actor and workspace. The default/requestable page size is capped at 10,000 envelopes.

### `/api/relay/snapshot` (GET)

Query parameters: `workspace_id`. Requires an authenticated workspace member — public share tokens are not accepted because the snapshot contains the full derived database (share readers use node-filtered catch-up instead). Returns the newest snapshot's metadata: HLC, the covered `up_to_seq` cursor, and the workspace `restore_epoch`. Clients probe the metadata first, then download the blob only when it is newer than their local watermark, restore it, and catch up operations past `up_to_seq`.

Rate limit: 60 requests per minute, keyed by actor and workspace.

### `/api/relay/snapshot/data` (GET)

Query parameters: `workspace_id`. Members only, same rule as the metadata endpoint. Returns the newest snapshot's blob as a raw `application/octet-stream` body; 404 when the workspace has no snapshot.

### `/api/relay/snapshot/data` (PUT)

Upload/create a snapshot: raw binary request body (no base64/JSON wrapping) with `workspace_id`, `physical`, and `logical` query parameters carrying the covered HLC. Requires workspace ownership or admin role. Returns `SnapshotResponse` (`snapshot_id`, `workspace_id`, `up_to_hlc`, `up_to_seq`).

### `/api/relay/compact`

Compacts relay envelopes up to the provided HLC. Requires workspace ownership or admin role.

### E2EE key endpoints

Key-record endpoints for workspaces that opt into end-to-end encryption (SPEC §8). Requests are snake_case, responses camelCase; all blobs are opaque to the server.

- `GET /api/relay/encryption-key?workspace_id=...` — members only. Returns `{workspaceId, wrappedKey, enabled, memberKeys}`; `wrappedKey` is the passphrase-derived KEK blob, `memberKeys` holds only the caller's per-version wrapped copies.
- `PUT /api/relay/encryption-key` — owner/admin only. Body `{workspace_id, wrapped_key}`; stores the passphrase blob.
- `PUT /api/relay/user-public-key` — any authenticated user, publishes the caller's own key. Body `{public_key}`.
- `GET /api/relay/user-public-key?user_id=...` — any authenticated user. Returns `{userId, publicKey}` (`null` when unpublished).
- `PUT /api/relay/encryption-key/members` — owner/admin only. Body `{workspace_id, members: [{user_id, wrapped_key, key_version}, ...]}`; only the submitted rows are written.
- `DELETE /api/relay/encryption-key/members/{workspace_id}/{user_id}` — owner/admin only; part of member removal (the owner then rotates the workspace key).

---

## Workspaces

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/workspaces/` | List the current user's workspaces. **Trailing slash required**: without it the SPA fallback answers 404 before Starlette's slash redirect runs. Returns a `PaginatedResponse` — workspaces are under `items` (`{uuid, name, is_active}`, plus `total`, `page`, `page_size`, `has_next`, `has_prev`). |
| `POST` | `/api/workspaces/` | Create a workspace (`{name}`). |
| `POST` | `/api/workspaces/{uuid}/switch` | Switch the active workspace. Returns `{status: "ok", active: uuid}`. |

---

## Shares

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/shares` | List active public share links in the current workspace (`share_uuid`, `created_at`, `expiry_date`, `url`, `node_name`, `node_uuid`). |
| `DELETE` | `/api/shares/{share_uuid}` | Revoke a public share link. |
| `POST` | `/api/nodes/{uuid}/shares` | Create a public share link for a node (`{expiry_date?, password?}`). Returns `{share_uuid, created_at, expiry_date, url}`. |
| `GET` | `/api/nodes/{uuid}/shares` | List a node's active public shares: `{shares: [...]}`. |

---

## Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/notifications` | List notifications for the current user (`include_read`, `limit` query params). Returns `{notifications, unread_count}`; entries carry `notification_uuid`, `type`, `actor_name`, `node_uuid`, `node_name`, `message`, `is_read`, `create_date`. |
| `POST` | `/api/notifications/{uuid}/read` | Mark one notification as read (404 when unknown). |
| `POST` | `/api/notifications/read-all` | Mark all notifications as read. |

---

## Assets

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/assets/upload` | Multipart upload (`file`, optional `parent_uuid` / `existing_node_uuid` / `content`). Creates an asset-class block node; files are stored content-addressed by SHA-256. Type and size limits are enforced (magic-byte checked). Returns `AssetResponse`. |
| `GET` | `/api/assets/` | List workspace assets, paginated (`page`, `page_size` ≤ 200). Returns `AssetListResponse` (`{assets, total}`). |
| `GET` | `/api/assets/{uuid}/info` | Asset metadata. Returns `AssetResponse`. |
| `GET` | `/api/assets/{uuid}` | Download the asset binary. Supports HTTP Range requests (206). Auth: JWT or an `asset_token` query parameter from `POST /api/assets/{uuid}/token` (15-minute token). |
| `DELETE` | `/api/assets/{uuid}` | Delete the asset and its associated node. |

`AssetResponse`: `uuid`, `node_uuid`, `filename`, `content_type`, `category` (`image`/`audio`/`file`), `size_bytes`, `url`.

---

## Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Liveness probe. Returns `{status: "ok"}` (also mounted at `/health`). |

---

## Removed endpoints

The legacy mutable endpoints have been removed:

- `/api/nodes/*` (except the share routes above)
- `/api/properties/*`
- `/api/sync/*`

The frontend now reads and writes through the local SQLite store and syncs via `/api/relay/*`.

Server-side undo has also been removed: every `/undo/*` endpoint returns **410 Gone**. Undo is implemented client-side by generating inverse operations (`property.unset` for `property.set`, `node.delete` for created nodes, etc.) and appending them to the local operation log.

---

## OpenAPI

When the backend is running, the interactive API documentation is available at:

- `/docs` — Swagger UI
- `/redoc` — ReDoc

These are generated automatically from the FastAPI routers.
