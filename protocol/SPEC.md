# Notees Relay Sync Protocol — SPEC

Version: **1** (`PROTOCOL_VERSION = 1`)

This document is the single source of truth for the wire protocol spoken
between Notees clients (React web, Flutter) and the FastAPI relay server.
Canonical implementations:

- Backend models: `app/core/operation.py`, `app/relay/models.py`
- Frontend models: `frontend/src/core/types/operation.ts`, `frontend/src/core/crypto.ts`
- Machine-readable fixtures: `protocol/fixtures/` (validated by
  `tests/test_relay_protocol_fixtures.py`)

## 1. Operation envelope

Every mutation is an **operation**: a routing envelope plus a payload.
The relay server stores and forwards envelopes without interpreting payload
contents. The wire model is `EncryptedEnvelope` (a historical name — payloads
are plaintext JSON on the server; confidentiality comes from TLS/Tailscale).

Envelope fields are camelCase on the wire. The server also accepts snake_case
field names on submission (`populate_by_name=True`), and always emits camelCase
on HTTP responses and WebSocket broadcasts (see §4.3).

| Wire name (`camelCase`) | Python field | Type | Required | Semantics |
|---|---|---|---|---|
| `id` | `id` | string (UUIDv7) | yes (server default: generated) | Globally unique envelope id; dedupe key (`ON CONFLICT DO NOTHING`). |
| `protocolVersion` | `protocol_version` | integer | no (default `1`) | Protocol version the producing client speaks. See §7. |
| `workspaceId` | `workspace_id` | string (UUID) | yes | Workspace the operation belongs to; routing and permission scope. |
| `actorId` | `actor_id` | string (UUID) | yes | Public id of the user/device that produced the operation. |
| `hlc` | `hlc` | object (see §2) | yes | Hybrid Logical Clock of the operation. |
| `affectedNodeIds` | `affected_node_ids` | string[] | no (default `[]`) | Node ids the operation touches; used for share-scoped filtering. |
| `opType` | `op_type` | string enum | yes | Operation type; must be in the known op-type set (§3). |
| `timestamp` | `timestamp` | string (ISO 8601, UTC) | no (server default: now) | Wall-clock creation time; informational, not used for ordering. |
| `payload` | `payload` | object | yes | Operation payload (§3). Max 1 MB serialized (§6). |

Example: `protocol/fixtures/envelope-minimal.json`.

## 2. HLC rules

An HLC is `{"physical": int, "logical": int}`:

- `physical` — wall-clock milliseconds.
- `logical` — tie-breaking counter when physical times are equal.
- Both components **must be non-negative**; the server rejects negative values
  with a validation error.
- Total order: compare `physical` first, then `logical`. Envelope streams are
  ordered by `(physical, logical, id)` — the envelope `id` is the final
  tie-breaker so pagination is stable.
- Clock semantics (advance on local event, merge on receive, never go
  backwards) are implemented in `app/core/clock.py` and
  `frontend/src/core/clock.ts`.

## 3. Op types and payloads

`opType` is a dotted string. The server validates it against the known set
(`KNOWN_OP_TYPES` in `app/core/operation.py`; mirrored in
`frontend/src/core/types/operation.ts`). Unknown op types are rejected with
422 on submission. Adding a new op type is an additive change and does not
bump the protocol version — but old clients will refuse to submit it, so both
repos must add it together.

Payload conventions:

- Payloads are JSON objects with **camelCase** keys.
- Most payload shapes are declared as TypeScript interfaces in
  `frontend/src/core/types/operation.ts` (e.g. `NodeIconUpdatePayload`,
  `PropertySchemaCreatePayload`). The server treats payloads as opaque.
- Operations that target a node carry `nodeId`; multi-node operations list
  every target in the envelope's `affectedNodeIds`.
- `plugin.op` payloads are `{pluginId, opType, data}` — namespaced per plugin.

Known op types at protocol version 1: `node.create`, `node.delete`,
`node.move`, `node.updateContent`, `node.updateIcon`, `node.updateColor`,
`node.addAlias`, `node.removeAlias`, `node.archive`, `node.restore`,
`node.permanentDelete`, `node.convert`, `class.assign`, `class.unassign`,
`property.set`, `property.unset`, `propertySchema.create`,
`propertySchema.update`, `propertySchema.delete`, `classPropertyEdge.create`,
`classPropertyEdge.update`, `classPropertyEdge.delete`,
`classPropertyEdge.reorder`, `class.create`, `class.update`, `class.delete`,
`class.setExtends`, `nodeView.create`, `nodeView.update`, `nodeView.delete`,
`nodeView.reorder`, `task.recordCompletion`, `task.deleteCompletion`,
`task.setRecurrence`, `task.deleteRecurrence`, `asset.upload`,
`asset.delete`, `activity.record`, `link.click`, `share.public.create`,
`share.public.revoke`, `share.user.grant`, `share.user.revoke`,
`user.favorite.add`, `user.favorite.remove`, `user.favorite.reorder`,
`plugin.op`.

## 4. HTTP endpoints

Base path: `/api/relay`. Authentication is the session JWT (HTTPOnly cookie
or `Authorization: Bearer`); the frontend also sends an `X-Actor-Id` header.
Request/response bodies below are snake_case unless they contain envelopes
(envelopes are camelCase, §1). Fixtures: `protocol/fixtures/`.

### 4.1 `POST /batch`

Submit a batch of envelopes.

Request (`BatchRequest`): `{"envelopes": [<envelope>, ...]}` —
see `protocol/fixtures/batch-request.json`.

Response 200: `{"saved_count": int, "saved_ids": [string, ...]}`.
Duplicate ids are silently ignored (idempotent retry-safe).

Errors: 401 unauthenticated, 403 no write permission, 422 validation
(unknown op type, negative HLC, batch/size limits §6).

Rate limit: 30,000 envelopes/minute per actor+workspace.

### 4.2 `POST /catch-up`

Fetch envelopes newer than a watermark, paginated.

Request (`CatchUpRequest`) — `protocol/fixtures/catch-up-request.json`:

```
{"workspace_id": str, "hlc": {"physical": int, "logical": int},
 "limit": int = 1000, "after_id": str | null = null}
```

- `hlc`: exclusive lower bound — only envelopes with a strictly greater
  `(physical, logical)` are returned.
- `limit`: page size, clamped server-side to [1, 10,000].
- `after_id`: pagination cursor; id of the last envelope of the previous
  page. The page continues strictly after that envelope in
  `(physical, logical, id)` order.
- Optional query param `share_token`: read-only access via a public share.

Response 200 (`CatchUpPaginatedResponse`) —
`protocol/fixtures/catch-up-response.json`:

```
{"envelopes": [<envelope>, ...], "next_after_id": str | null,
 "has_more": bool, "restore_epoch": int}
```

`next_after_id` is set when the page is full; keep paging while `has_more` is
true. `restore_epoch` changes when the server was restored from backup —
clients must wipe local state and resync when it differs from their stored
epoch.

Rate limit: 600 requests/minute per actor+workspace.

### 4.3 `GET /snapshot?workspace_id=...`

Return the newest snapshot (a serialized derived-state SQLite database).

Response 200 (`LatestSnapshotResponse`):

```
{"snapshot_id": str, "workspace_id": str, "hlc": {physical, logical},
 "data_base64": str, "has_snapshot": bool, "restore_epoch": int}
```

`has_snapshot: false` returns empty `snapshot_id`/`data_base64` and HLC zero.
Clients restore the bytes, then catch up from the snapshot HLC.

### 4.4 `POST /snapshot`

Upload/create a snapshot. Owner or admin only.

Request (`SnapshotRequest`) — `protocol/fixtures/snapshot-request.json`:
`{"workspace_id": str, "up_to_hlc": {physical, logical}, "data_base64": str}`

Response 200 (`SnapshotResponse`):
`{"snapshot_id": str, "workspace_id": str, "up_to_hlc": {physical, logical}}`

### 4.5 `POST /compact`

Compact envelopes up to an HLC into a snapshot segment and optionally prune
them. Owner or admin only.

Request (`CompactRequest`): `{"workspace_id": str, "up_to_hlc": {...},
"prune": bool = true, "data_base64": str}`. `data_base64` must be non-empty
when `prune` is true (the snapshot replaces the pruned operations).

Response 200 (`CompactResponse`): `{"snapshot_id": str, "segment_id": str,
"workspace_id": str, "up_to_hlc": {...}, "operation_count": int}`

### 4.6 `GET /stats?workspace_id=...`

Response 200 (`RelayStatsResponse`):

```
{"workspace_id": str, "envelope_count": int, "envelope_size_bytes": int,
 "snapshot_count": int, "latest_snapshot_hlc": {...} | null,
 "compacted_segment_count": int, "compacted_operation_count": int,
 "max_hlc": {physical, logical}, "restore_epoch": int}
```

## 5. WebSocket endpoint

`GET /api/relay/ws/{workspace_id}` (upgraded). Same auth as HTTP; anonymous
connections and actors without read access are closed with code 1008.

Message protocol (JSON text frames):

- Client → Server: `{"type": "batch", "envelopes": [<envelope>, ...]}` —
  same shape and limits as `POST /batch`.
- Server → Client:
  - `{"type": "ack", "saved_ids": [...]}` — after a submitted batch is saved.
  - `{"type": "error", "message": "..."}` — malformed JSON, wrong message
    type, invalid envelopes, or permission errors.
  - `<envelope object>` — every envelope saved by any client in the workspace
    is broadcast to all subscribers (including, currently, the sender).

> **Casing note:** broadcast envelopes use the same camelCase wire format as
> HTTP responses. Servers before the 2026-08 protocol-versioning change emitted
> snake_case here (`workspace_id`, `protocol_version`, ...) — receivers that may
> talk to an older server should still accept both casings. Control messages
> (`ack`, `error`) keep their snake_case keys (`saved_ids`).

## 6. Limits

- `MAX_BATCH_SIZE = 1000` envelopes per batch (`BatchRequest`).
- `MAX_ENVELOPE_SIZE_BYTES = 1 MB` per envelope payload (serialized JSON).
- Catch-up page size: default 1000, server clamp [1, 10,000].
- Rate limits: see §4.1 / §4.2.

## 7. Versioning policy

`PROTOCOL_VERSION` (backend: `app/core/operation.py`, re-exported from
`app/relay/models.py`; frontend: `frontend/src/core/types/operation.ts`)
is currently **1**. Both repos must keep the constant and this spec in sync.

Rules:

- **Additive change, no bump**: adding an optional field with a default, or a
  new op type, does not bump the version. Receivers must ignore unknown
  fields (the Pydantic models do).
- **Breaking change, bump**: renaming or removing a field, changing a field's
  type or semantics, or adding a required field bumps `PROTOCOL_VERSION` in
  both repos and updates this spec and the fixtures.
- **Missing version**: an envelope without `protocolVersion` is treated as
  version 1 (pre-versioning peers).
- **Newer version**: a peer that receives an envelope with
  `protocolVersion` greater than its own constant must **fail loud** — the
  web client throws, which drives sync into the `error` status
  (`assertSupportedProtocolVersion` in `frontend/src/core/types/operation.ts`).
  Silently applying operations from a newer protocol risks corrupting
  derived state.
- The relay server stores `protocol_version` verbatim (dedicated
  `relay_envelope.protocol_version` column) and serves it back in catch-up
  and broadcast, so a mixed-version fleet never has versions rewritten in
  transit. The server accepts any version on submission; rejecting newer
  versions is the client's responsibility.

## 8. Workspace key management

Prototype server-side key wrapping (moves to client-side E2EE later).
Base path: `/api/relay/keys`. Bodies are snake_case.

- `GET /{workspace_id}` → `KeyResponse`: `{"workspace_id": str,
  "user_id": str, "ciphertext": str, "iv": str, "key_version": int}` —
  the caller's wrapped copy of the workspace master key. `ciphertext`/`iv`
  are base64 AES-GCM values; `key_version` identifies the master key
  generation.
- `POST /{workspace_id}/invite` — owner/admin only. Request
  (`InviteKeyRequest`): `{"target_user_id": str}`. Response: `KeyResponse`
  for the target user.
- `POST /{workspace_id}/rotate` — owner/admin only. Request
  (`RotateKeyRequest`): empty body. Response (`RotateKeyResponse`):
  `{"workspace_id": str, "key_version": int}` — the key is re-wrapped for
  all members under the new version.
