# Notees Protocol v2 — Wire Spec

Status: **v2.0-draft, 2026-09-26.** Companion to `SCHEMA.md` (payloads/content grammar — normative there) and the envelope/op schemas in `src/` (executable form).

Base path: `/api/relay/v2`. Auth: single-user API key (`X-API-Key`) today (JWT sessions land with multi-user); actor identity is derived from the authenticated principal only. All request/response bodies are camelCase JSON; envelopes travel inside bodies as defined in `envelope.ts` (`seq` never appears inside an envelope — it rides on catch-up responses and WS frames).

## 1. Endpoints

### `POST /batch`
Submit a batch of envelopes. Request `{"envelopes": [...]}` (≤ 1000; each payload ≤ 1 MB). Response 200 `{"savedCount": n, "savedIds": [...]}`; duplicate ids silently ignored (idempotent retry). Errors: 401, 422 (validation), 429.

### `POST /catch-up`
Request `{"workspaceId": "...", "afterSeq": 0, "limit": 1000}` (limit clamped [1, 10000]). Response 200:
```
{"envelopes": [...], "nextAfterSeq": int|null, "hasMore": bool, "restoreEpoch": int, "totalRemaining": int}
```
Envelopes ascending by server-assigned `seq` (the only ordering authority; envelope HLCs are causality metadata, never ordering). `afterSeq` is an exclusive lower bound; the final page's `nextAfterSeq` covers the tail. `restoreEpoch` change ⇒ clients wipe local state and resync.

### `GET /snapshot?workspaceId=…`
Latest snapshot metadata: `{"snapshotId", "hlc": {physical, logical}, "hasSnapshot", "restoreEpoch", "upToSeq"}`. Members only.

### `GET /snapshot/data?workspaceId=…`
Snapshot bytes (`application/octet-stream`) — a serialized derived-state SQLite database. Clients restore, then catch up from `upToSeq`. 404 when absent.

### `PUT /snapshot/data?workspaceId=…&physical=…&logical=…`
Upload a client-produced snapshot (owner-only in multi-user; single-user today: any key with write scope). Raw body bytes. Body cap: **512 MiB route-local** — the app-global request cap is 128 MiB, and this route is the one deliberate exception (an authenticated, workspace-scoped full projection is the largest body the API carries). Over-cap answers `413 entity_too_large` (the error envelope); a client that sees it reports once and keeps syncing normally (the server-side snapshot covers restore) — it MUST NOT treat the refusal as sync failure.

### `POST /compact`
Owner/admin: `{"workspaceId", "upToHlc": {physical, logical}, "prune": true, "dataBase64": "..."}` — snapshot the derived state up to an HLC and optionally prune covered envelopes. `prune: true` requires non-empty `dataBase64`. Single checkpoint flow (replacing the three divergent snapshot endpoints of the first system).

### `GET /stats?workspaceId=…`
`{"envelopeCount", "snapshotCount", "compactedOperationCount", "maxHlc", "restoreEpoch", "latestSnapshotHlc"}`.

## 2. WebSocket — `/ws/{workspaceId}`

Auth via `?token=` (API key) or subprotocol header. Framing version `wsProtocolVersion = 2`, independent of the envelope `protocolVersion`.

- Server → client on connect: `{"type": "hello", "wsProtocolVersion": 2, "restoreEpoch": int, "latestSeq": int}`.
- Client → server: `{"type": "batch", "envelopes": [...]}` (same path and limits as HTTP `/batch`).
- Server → client per committed batch: `{"type": "ops", "wsProtocolVersion": 2, "envelopes": [...], "seqs": {"<envelopeId>": int}}` — `seqs` maps envelope id → server seq so clients can advance their cursor from the live stream alone.
- Server → client: `{"type": "ack", "savedIds": [...]}` · `{"type": "error", "message": "..."}`.
- Unknown frame types are ignored; a `hello`/`ops` with a newer framing version fails loud (clients must not silently apply newer framing).

The socket is an acceleration path only: a dropped socket is indistinguishable from a delayed one — the seq cursor remains the authoritative recovery mechanism (buffer `ops` while catch-up runs; id-dedupe makes overlap harmless).

## 3. Errors, limits, versioning

- Error envelope (all endpoints): `{"error": {"code": string, "message": string, "status": int}}` — stable machine codes (`unauthenticated`, `forbidden`, `validation_failed`, `not_found`, `rate_limited`, `conflict`, `idempotency_replay`).
- Limits: batch ≤ 1000 envelopes / 1 MB per payload; catch-up page ≤ 10000; global fallback 10 000 req/min per IP; per-endpoint buckets documented at implementation.
- `PROTOCOL_VERSION = 3` (envelope schema; v3 accepts only 3 — Revision 11's render-state model) and `WS_PROTOCOL_VERSION = 2` (framing) are versioned independently. Additive changes (optional fields, new op types) do not bump either; breaking changes bump both repos + fixtures together. Envelopes without `protocolVersion` are rejected; receivers fail loud on a newer version. **No backward compatibility:** retired payload keys (e.g. v2's `nodeType`) are rejected outright, and previously stored v2 rows are rewritten in place once by the one-time migration script (`scripts/migrate-node-type.mts`, planned) — not replayed, not bridged.
- **2026-10-07 additive batch (the wire node fields):** `object.update` gains the optional nullable `coverAssetId` / `bannerAssetId` / `aliasedNodeId` (SCHEMA.md "Node structure"). No version bump, but the payload is strict — pre-batch clients reject envelopes carrying the new keys, so the GTK/Flutter ports accept them before the live migration runs (`scripts/migrate-cover-banner-alias.mts`); the client alignment is a follow-up in the clients repo. Canonical fixture: `object-wire-fields.json`.
- **2026-10-07 second batch (the class-class retirement + the asset type):** (1) `class.create` on an EXISTING node id is now the conversion capability — the applier flips `is_class`, cuts a parented node to a root, and the registry adopts the node's title; no payload keys change (the schema always accepted the id — pre-batch clients build the registry row but never flip the bit, the inconsistent half-state, so the live migration `scripts/migrate-retire-class-class.mts` gates on the GTK/Flutter ports). (2) `propertySchema.create`'s type enum gains `"asset"` — a strict-payload change (pre-batch clients reject the retype envelope; `scripts/migrate-attachments-asset-type.mts` gates on the ports). Canonical fixtures: `class-convert.json`, `property-asset-type.json`.

## 4. Trust model

Routing metadata (`affectedNodeIds`) is client-supplied and best-effort; workspace membership is the real security boundary. Payloads are opaque to the relay except the E2EE slot (`{"$e": …}`), which skips payload validation. Semi-trusted server: for plaintext workspaces the operator can read contents; E2EE workspaces (once E2EE exists) expose only routing metadata, sizes, timing.
