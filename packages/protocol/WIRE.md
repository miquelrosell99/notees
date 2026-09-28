# Notees Protocol v2 — Wire Spec

Status: **v2.0-draft, 2026-09-26.** Port of v1 `protocol/SPEC.md` with the §34.4 clean-break fixes applied. Companion to `SCHEMA.md` (payloads/content grammar — normative there) and the envelope/op schemas in `src/` (executable form).

Base path: `/api/relay/v2`. Auth: single-user API key (`X-API-Key`) in M1 (JWT sessions land with multi-user in M3); actor identity is derived from the authenticated principal only. All request/response bodies are camelCase JSON; envelopes travel inside bodies as defined in `envelope.ts` (`seq` never appears inside an envelope — it rides on catch-up responses and WS frames).

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
Upload a client-produced snapshot (owner-only in multi-user; single-user M1: any key with write scope). Raw body bytes.

### `POST /compact`
Owner/admin: `{"workspaceId", "upToHlc": {physical, logical}, "prune": true, "dataBase64": "..."}` — snapshot the derived state up to an HLC and optionally prune covered envelopes. `prune: true` requires non-empty `dataBase64`. Single checkpoint flow (replaces v1's three divergent snapshot endpoints).

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
- `PROTOCOL_VERSION = 2` (envelope schema) and `WS_PROTOCOL_VERSION = 2` (framing) are versioned independently. Additive changes (optional fields, new op types) do not bump either; breaking changes bump both repos + fixtures together. Envelopes without `protocolVersion` are rejected; receivers fail loud on a newer version.

## 4. Trust model (carried from v1, unchanged)

Routing metadata (`affectedNodeIds`) is client-supplied and best-effort; workspace membership is the real security boundary. Payloads are opaque to the relay except the M3 E2EE slot (`{"$e": …}`), which skips payload validation. Semi-trusted server: for plaintext workspaces the operator can read contents; E2EE workspaces (M3) expose only routing metadata, sizes, timing.
