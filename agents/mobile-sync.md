# Mobile Sync — Pre-M1 Validation Notes

This document records the answers to the Pre-M1 validation questions from
`refactor_plan.md` and notes mobile-specific constraints for the local-first
sync architecture.

## Validation Answers

### 1. Can `OperationIntent` carry block ID, parent ID, content delta, and op type cleanly?

**Status: Pass (with new models in Phase 1).**

The current frontend uses `MutationIntent` (`frontend/src/runtime/types.ts`) and
the backend uses whole-node state sync (`app/domain/entities/sync.py`). Neither
has an `OperationIntent` type today. Phase 1 introduces
`app/domain/entities/sync_v2.py` with `OperationIntent`, covering:

- `block_id` / `node_uuid`
- `parent_id` for tree ops
- `content_delta` / `content_ast` for text edits
- `op_type` discriminator

The existing `MutationIntent` → `Operation` mapping in
`frontend/src/sync/intents.ts` maps cleanly to the new model without
restructuring.

### 2. Can `SyncService` wrap a mixed batch of tree + text ops in a single PostgreSQL transaction?

**Status: Pass.**

The backend uses request-scoped connections (`app/db/connection.py`) and
`get_transaction()`. `NodeService` already exposes atomic methods such as
`create_block`, `move_node`, and `update_node`. `SyncServiceV2.apply_batch()`
calls these inside a single transaction and advances per-node version vectors
atomically.

### 3. Does `live_sync_ws.py` support generic `broadcast_ops(room_id, ops[])` without lock-coupling?

**Status: Pass (after Phase 1).**

Before Phase 1, `live_sync_ws.py` only had page-scoped presence/lock
broadcasts. Phase 1 removes lock state and adds `broadcast_ops(page_uuid, ops,
sender_id)`, reusing the existing `_broadcast` helper and Redis pubsub channel
for cross-instance fan-out.

### 4. Does the Flutter side have an `OperationIntent` equivalent that can queue to sqflite?

**Status: Pass (mechanism exists; models need alignment).**

The mobile app already has:

- `sqflite: ^2.4.1` in `notees-flutter/pubspec.yaml`.
- An offline queue abstraction in `notees-flutter/lib/domain/services/offline_queue.dart`.
- `notees-flutter/lib/domain/services/editor_save_service.dart` for debounced editor saves.

These existing services can be extended with the same `OperationIntent` shape
used by the web client and queued to a local `outbox` table. The sync protocol
contract is the same HTTP/JSON API, so the mobile implementation is a
straightforward parallel of the web SyncManager.

### 5. Does mobile `sqflite` include FTS5?

**Status: Not yet verified; fallback documented.**

`sqflite` uses the SQLite version shipped with Android/iOS. FTS5 is available
on:

- Android: API 24+ (Android 7.0+) usually ships FTS5.
- iOS: system SQLite generally includes FTS5 on modern versions.

However, `sqflite` does **not** bundle `sqlite3` by default and does not
guarantee FTS5. If FTS5 is unavailable at runtime, the fallback plan is:

1. **Trigram index fallback**: create a `node_fts` table with
   `CREATE INDEX idx_node_fts_text ON node_fts USING gin (text gin_trgm_ops)`
   (server side) or a local `LIKE '%term%'` with a cached word index on mobile.
2. **Dart search library**: use a pure-Dart n-gram index over node names and
   block text, rebuilt incrementally on sync.

The offline search milestone (M5) should begin with a runtime probe:

```sql
SELECT fts5('test');
```

If this throws, switch to the trigram/Dart fallback.

## Recommended Mobile Sync Data Model

```text
outbox
  - id (auto-increment)
  - op JSON (OperationIntent)
  - attempt_count INTEGER
  - last_error TEXT
  - next_retry_at DATETIME
  - created_at DATETIME

local_nodes (mirror of server node rows)
  - uuid TEXT PRIMARY KEY
  - parent_uuid TEXT
  - name TEXT
  - content TEXT (JSON AST)
  - sequence REAL
  - is_deleted INTEGER
  - updated_at TEXT
  - vector TEXT (JSON version vector)

ui_state (device-local)
  - node_uuid TEXT PRIMARY KEY
  - collapsed INTEGER
  - zoom_root TEXT
```

## Next Steps for Mobile

1. Define Dart `OperationIntent` models matching the OpenAPI contract.
2. Implement `OutboxService` with exponential backoff.
3. Add runtime FTS5 probe and fallback index.
4. Wire `workmanager` for background sync once the web v2 protocol is stable.
