# Mobile Sync — Flutter Relay Contract

Reference for the Notees Flutter app's sync contract, verified against the
mobile implementation (`notees-flutter/lib/`) and the relay backend
(`app/relay/`). The field-level wire contract lives in `protocol/SPEC.md`;
this document covers the mobile-specific flow and pitfalls.

## Sync path: relay envelopes + seq cursor

The operation relay is the **only** sync path. There is no WebSocket
requirement, no version vectors, and no whole-node state sync.

- **Push**: pending envelopes are dequeued from the local `relay_outbox`
  table and pushed in chunks of 100 to `POST /api/relay/batch`
  (`SyncV2Service.flush`, `lib/domain/services/sync_v2_service.dart`). The
  response is a whole-batch ack: `{saved_count, saved_ids}`; the server
  silently ignores duplicate envelope ids, so `saved_ids` may omit ids the
  client sent (retry-safe). On success the whole chunk is applied to the
  local cache and removed from the outbox. 401/403 are retried (token
  refresh); other 4xx responses quarantine the chunk (state `quarantined`,
  surfaced in the flush error list, never dropped silently); network/5xx
  errors retry with backoff (`[5, 15, 60, 300, 1800]` seconds).
- **Pull**: `POST /api/relay/catch-up` with the persisted `after_seq` cursor
  (SPEC §4.2), paged via `next_after_seq`/`has_more`. The cursor is persisted
  after every page, so a mid-page crash only re-fetches the tail; re-applied
  envelopes are deduped by operation id against the local `relay_operations`
  table. On the final page `next_after_seq` is still set (last envelope's
  seq) — adopt it as the stored cursor.
- **Actor id**: once authenticated, envelopes are stamped with the user's
  uuid (from `/auth/me`), matching the web client so actor-keyed state
  (favorites) is consistent across devices. Before login the per-install
  device `clientId` is used.

## Snapshots: probe, then blob

Snapshot restore is two-step (`RelayClient`, `lib/data/repositories/relay_client.dart`):

1. **Probe** `GET /api/relay/snapshot?workspace_id=...` — metadata only
   (`hlc`, `up_to_seq`, `restore_epoch`); cheap even on large workspaces.
   Members only; share tokens are not accepted.
2. **Blob** `GET /api/relay/snapshot/data?workspace_id=...` — raw binary
   (`application/octet-stream`), 404 when no snapshot exists. Download only
   when the probe says the snapshot is newer than the local watermark
   (`up_to_seq > cursor_seq`; HLC comparison is the fallback for pre-cursor
   snapshots with `up_to_seq: null`).

After a restore, catch up from `after_seq = up_to_seq` (or `0` with op-id
dedupe when `up_to_seq` is null). A `restore_epoch` mismatch between the
server and the stored watermark means the server was restored from backup:
wipe the local cache and watermarks and resync.

## `node.updateContent`: string content, legacy List

The server accepts several carriers (SPEC §3;
`apply_node_update_content` in `app/core/derived/node.py`):

- **Current format** (web): `content` is a **string** — the serialized
  content AST as JSON, or bare plaintext — accompanied by `textUpdateB64`, a
  base64 *incremental* Yjs delta. Servers without a CRDT library must NOT
  merge deltas; `crdt_state` keeps the last full state and node content comes
  from the `content` mirror. A JSON-parseable mirror is stored verbatim;
  anything else is wrapped as a plain text node.
- **Legacy List form**: `content` as an AST array (or single dict). Still
  accepted by the server and by the mobile appliers (`RelayAppliers` in
  `lib/domain/services/relay_appliers.dart` serializes it to the string
  format). The mobile producer currently emits this form
  (`OperationPayloads.nodeUpdateContent`) without CRDT updates.
- Content updates are last-write-wins: both server and mobile skip
  `updateContent` ops whose HLC is not newer than the last applied one
  (`node_content_hlc` table locally).

## Name derivation: CRDT unwrap

Derived node content (the mobile cache's `name` column) can hold the CRDT
text wrapper `[{type:'text', text:'<real AST JSON>'}]` (or the
paragraph-wrapped equivalent) because the web inline editor stores the
serialized AST inside the text CRDT. Never render `name` directly: run
`unwrapCrdtContentAst` first, then `astToPlainText`
(`lib/core/utils/ast_stringifier.dart`; web equivalent:
`unwrapCrdtContentAst` in `frontend/src/lib/astBuilder.ts:561`).

## Local database and migrations

Local state lives in a sqflite_sqlcipher database (`AppDatabase`,
`lib/data/local/app_database.dart`, schema version 15): `relay_outbox`,
`relay_operations`, `sync_watermark` (holds `cursor_seq` and
`restore_epoch`), `node_cache`, search index, favorites, task, class,
property-schema and share mirrors.

Client-side migrations must be **idempotent**: upgrade paths from versions
predating a table create it at its *current* shape, so every column ALTER
goes through `_addColumnIfMissing` (a `PRAGMA table_info` guard). An
unguarded `ALTER TABLE ... ADD COLUMN` fails with "duplicate column name" on
exactly those upgrade paths.

## Protocol version and E2EE stance

The mobile client speaks `protocolVersion` 1 (`kRelayProtocolVersion`) and
**rejects any envelope with a newer version** at parse time
(`FormatException` in `OperationEnvelope.fromJson`). Encrypted envelopes
(E2EE, SPEC §8) carry version 2 with payload `{"$e": {iv, ct}}`, so an
E2EE workspace fails loud on mobile instead of syncing ciphertext it cannot
read. Mobile is plaintext-only: confidentiality comes from the transport
layer (TLS/Tailscale).

## Undo is client-side

The server-side undo stack is removed: every `/undo/*` endpoint returns
**410 Gone** (`app/features/undo/router.py`). Undo is implemented
client-side by generating inverse operations (`property.unset` for
`property.set`, `node.delete` for created nodes, etc.) and appending them to
the local operation log.

## Gotchas

- **`GET /api/workspaces/` needs the trailing slash.** Without it, the
  server's SPA fallback answers 404 before Starlette's slash redirect can
  run (`app/main.py`). The response is a `PaginatedResponse`: workspaces are
  under `items` (`{uuid, name, is_active}`), not a bare array.
- **Null-content guard**: never enqueue an `update_content`/`update_node`
  op with null content — the payload would omit `content`, the server
  rejects it with 422, and the op lands in quarantine. `SyncV2Service.enqueue`
  skips such ops and logs instead.
- **Unknown op types**: `RelayAppliers` ignores op types it does not know
  (with a debug log) rather than failing the pull; asset/activity/share-link/
  view ops have no local derived representation by design.
