# Notees — Local-First Sync Architecture & Multi-Platform Roadmap
## Final Plan (v3)

> **Purpose:** Extract a clean sync API contract, remove per-block locks, and enable multi-platform clients (Web, Flutter/Android, Desktop) against a single sync server.

---

## Current Status

| Milestone | Status | Notes |
|-----------|--------|-------|
| Pre-M1 Validation | ✅ Done | Validated via code reads and spikes. |
| M0: Foundation & Quick Wins | ✅ Done | `AGENTS.md` updated, AST `schema_version`, fold-state prep, workspace `sync_protocol_version`. |
| M1: Extract Sync API | ✅ Done | Vector-clock `POST /sync/batch`, lock-free `live_sync_ws.py`, dual-vector `SyncManagerV2`, protocol flag. |
| M2: Local-First Outbox & Eager Persistence | ✅ Done | `LocalSyncEngine`, persisted outbox + retry, sync status indicator, eager persistence. |
| M3: Conflict UX & UI Cleanup | ✅ Done | Hard removal of `collapsed` DB column; fold state local-only; conflict resolution modal. |
| M4: CRDT Text | ✅ Done (spike passed) | Yjs + Lexical binding verified; integration spec in `docs/crdt-spike-report.md`. |
| M5: Offline Search & Live Queries | ✅ Done | M5a local node mirror + `MiniSearch`; M5b offline search fallback; M5c offline QueryAST evaluation for all node views, linked-references QueryAST fallback, and RuntimeEventBus-driven live invalidation. |
| M6: Interop & Assets | ✅ Done | YAML/OPML import/export, content-addressed assets. |
| M7: Web Polish, Bundle Splitting & Encryption | 🔄 In Progress | Flutter mobile client moved to `miquelrosell99/notees-flutter`. |

---

## 1. Why This Switch Makes Sense

| Current Pain | Future State | Benefit |
|--------------|--------------|---------|
| Per-block WebSocket locks leak on disconnects | Vector-clock optimistic sync | Resilient, lock-free collaboration |
| Server is canonical; offline is "best effort" | Local DB is canonical; server is a peer | True offline work on planes, trains, rural Spain |
| Tab crashes lose pending edits | Eager outbox persistence | No data loss |
| Monolithic web app only | Sync server + thin clients | Open-core model: free web, paid mobile/desktop |
| You self-host on `atlas` | You control the sync server | Data sovereignty, no vendor lock-in |

This is not a refactor. It is a **sync-layer rewrite** that extracts the backend contract and enables a multi-platform product strategy.

---

## 2. Architecture: Compose Separation

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SYNC SERVER                                   │
│  (Python/FastAPI, Docker, runs on `atlas` or any VPS)               │
│                                                                     │
│  • Auth (JWT / API keys)                                            │
│  • Vector-clock sync: POST /sync/batch                              │
│  • WebSocket broadcast of applied ops                               │
│  • PostgreSQL: node, node_revision, node_yjs_state (future)       │
│  • Optional: Yjs update merge (M4)                                    │
│  • Optional: hosted subscription tier                               │
└─────────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────────────────────┐  ┌─────────────────┐
│   WEB CLIENT    │  │  FLUTTER APP                    │  │ DESKTOP (Elec/│
│  (React/TS)     │  │  (Android/iOS)                  │  │  Tauri)         │
│                 │  │  in `miquelrosell99/notees-flutter` │  │                 │
│  • IndexedDB    │  │  • sqflite                      │  │  • Same as web  │
│  • MiniSearch   │  │  • FTS5 (or fallback)           │  │    or native    │
│  • Lexical      │  │  • Outbox queue                 │  │                 │
│  • Outbox queue │  │                                 │  │                 │
└─────────────────┘  └─────────────────────────────────┘  └─────────────────┘
```

**Deployment options:**
- **Monolithic (default):** Sync server serves the web client as static files. One Docker container.
- **Split:** Sync server runs headless; web client is static files on a CDN or `baymax`; Flutter app (built from `miquelrosell99/notees-flutter`) talks to server directly.

---

## 3. Pre-M1 Validation (1 Week — Do Not Skip)

Before writing M1 code, answer these with code reads or small spikes.

| # | Question | Pass Criteria |
|---|----------|---------------|
| 1 | Does `OperationIntent` carry block ID, parent ID, content delta, and op type cleanly? | `client_id` and `seq` can be attached without restructuring. |
| 2 | Can `sync_service.py` wrap a mixed batch of tree + text ops in a single PostgreSQL transaction? | Single `BEGIN...COMMIT` can call multiple repository methods. |
| 3 | Does `live_sync_ws.py` support generic `broadcast_ops(room_id, ops[])` without lock-coupling? | A generic broadcast method exists or is addable. |
| 4 | Does the Flutter side have an `OperationIntent` equivalent that can queue to sqflite? | Flutter has a matching abstraction layer. |
| 5 | Does mobile `sqflite` include FTS5? | `SELECT fts5('test')` succeeds, or `sqlite3_flutter_libs` is in use. |

**If any answer is "no":** Adjust M1 scope before committing. Do not discover blockers mid-rewrite.

---

## 4. Milestones

### Milestone 0: Foundation & Quick Wins (1 Week)

**Goal:** Clean stale docs, prep schemas, and verify prerequisites.

| Task | Detail |
|------|--------|
| Fix `AGENTS.md` | Remove `node_path` closure table references. Document recursive CTEs over `parent_id` + `document_id` index. |
| AST schema versioning | Add `schema_version: number` to AST content nodes. Lazy migration on read. |
| Keyboard expand/collapse | Bind `Ctrl/Cmd + .` or `Alt + ArrowRight/ArrowLeft` to toggle fold state. |
| Fold state prep | Create local-only `ui_state` table: `(node_id, collapsed, zoom_root)`. Do NOT migrate `node.collapsed` yet. |
| Sync protocol feature flag | Add `workspace.sync_protocol_version` enum (`v1`, `v2`). Default `v1`. |
| Mobile FTS5 check | Verify FTS5 availability. Document fallback (trigram index or Dart search library) if unavailable. |

**Out of scope:** Sync protocol changes, CRDT, encryption, search, outbox.

**Acceptance criteria:**
- `AGENTS.md` matches actual schema.
- `schema_version` exists on AST nodes.
- Keyboard shortcut works.
- `workspace.sync_protocol_version` column exists.
- Mobile FTS5 status documented.

---

### Milestone 1: Extract Sync API — Optimistic Vector-Clock Sync (5–6 Weeks)

**Goal:** Remove per-block locks. Establish a clean, documented sync API contract that any client can implement. Prevent silent overwrites.

> **Note:** This includes test rework (delete lock tests, add vector-clock tests, add 409 frontend tests).

#### 1.1 Sync API Contract (Documented)

```
POST /sync/batch
Headers:
  Authorization: Bearer <jwt>
  X-Notees-Sync-Protocol: v2
Body:
  {
    "ops": [OperationIntent],
    "base_vector": {
      "node-uuid-1": { "client-A": 42, "client-B": 17 },
      "node-uuid-2": { "client-A": 43 }
    }
  }

Response 200:
  {
    "applied": true,
    "new_vectors": { ... }
  }

Response 409:
  {
    "stale_nodes": ["node-uuid-1"],
    "server_vectors": { ... },
    "conflict_type": "text_edit" | "tree_conflict" | "permission_denied" | "node_deleted"
  }
```

#### 1.2 Per-Node Version Vectors

- `client_id`: stable per-device UUID (localStorage / sqflite).
- `seq`: monotonic counter per client, persisted locally.
- `node_revision` table:
  ```sql
  CREATE TABLE node_revision (
      node_id UUID NOT NULL REFERENCES node(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (node_id, client_id)
  );
  CREATE INDEX idx_node_revision_node ON node_revision(node_id);
  ```
- Each node tracks its own version vector: `{client_id: seq}`.

#### 1.3 Tree Operation Versioning Rules

For any tree op (move, indent, create, delete), three node types:

| Type | Version Advances? | Example: Move A under B |
|------|-------------------|------------------------|
| **Target** | Yes | A (the node being moved) |
| **Anchor parent** | Yes | B (the new parent) and A's old parent |
| **Descendants** | No | A's children; their path is derived at read time |

Batch endpoint validates only **target** and **anchor parent** vectors. Descendants are implicitly consistent because their stored rows do not mutate.

#### 1.4 Remove Per-Block Locks

- Delete `acquire_lock` / `release_lock` from `app/features/collab/live_sync_ws.py`.
- Keep `typing` / `presence` WebSocket messages for UI hints (not locks).
- Server no longer maintains edit lock state.

#### 1.5 Text Edit Strategy: Focus Presence + 409

- While a user has **focus** in a block, broadcast `typing` presence.
- Other clients see presence and avoid editing the same block (courtesy, not enforcement).
- If concurrent text edit occurs: server returns `409` with `conflict_type: text_edit`.
- Banner: "This block was edited by another user. Refresh to see changes."

#### 1.6 Frontend SyncManager: Dual Vectors + Batching

**Dual vector design:**
- `acked_vector`: Last vector confirmed by server. Sent in `base_vector`.
- `pending_vector`: `acked_vector` + optimistic increments from local unacknowledged ops. Used for local reads.

**Behavior:**
- Collect pending ops into batches.
- Send `base_vector = acked_vector` (never include unacknowledged ops).
- On `200`: update `acked_vector`, clear sent ops from outbox.
- On `409`: refetch stale nodes, re-queue if valid against new `acked_vector`, else surface conflict banner with `conflict_type`.
- **Keep TanStack Query as the read layer.** Do not invert source of truth yet.

#### 1.7 Minimal Outbox (Crash Survival)

- On every `OperationIntent`, immediately `put` to IndexedDB/sqflite `outbox`.
- Schema: `(id, op, created_at)`.
- Flush on `beforeunload` and `visibilitychange`.
- SyncManager reads outbox on startup and attempts send.
- No retry/backoff yet — "try once, keep in outbox if fail."

#### 1.8 Protocol Feature Flag Rollout

- v1: old lock-based WebSocket flow.
- v2: new batch endpoint + optimistic concurrency.
- Client advertises version in WebSocket handshake and HTTP header.
- Gradual rollout per workspace.

#### 1.9 Instrument base_vector Payload Size

- Log byte size of `base_vector` per batch.
- Post-M1 optimization: compact "vector summary" using per-client high-water marks.

**Out of scope:** CRDT/Yjs, local-first inversion, encryption, offline FTS, OPML/YAML, three-way diff, retry/backoff, vector summary optimization.

**Acceptance criteria:**
1. `grep -r "lock" app/features/collab/` returns only presence/typing code.
2. Two clients edit **different blocks** simultaneously → both succeed, no 409.
3. Two clients edit **same block** concurrently → 409 + banner with correct `conflict_type`, no silent overwrite.
4. App works offline: ops queue in outbox, sync on reconnect.
5. v1 and v2 clients coexist without regression.
6. All non-lock tests pass; new tests exist for batch endpoint, vector clock, and 409 handling.
7. TanStack Query remains the read layer.
8. `base_vector` payload size is logged and reviewed.

---

### Milestone 2: Local-First Outbox & Eager Persistence (2–3 Weeks)

**Goal:** Survive crashes and offline periods. Make the sync layer robust.

| Task | Detail |
|------|--------|
| Eager persistence <200ms | Structural ops: `await` local DB `put` before UI ack. Text edits: debounce 150ms + flush on `blur`, `visibilitychange`, every 10 keystrokes. |
| Robust outbox with retry | Entries: `(id, op, attempt_count, last_error, next_retry_at, created_at)`. Schedule: immediate → 5s → 15s → 1min → 5min → 30min → hold. |
| Sync status indicator | Toolbar icon: synced / syncing / offline / error. Click to view queue. |
| Local-first read layer (prep) | Add `local_query` module for offline fallback. Keep TanStack Query as primary read layer. |

**Out of scope:** TanStack Query replacement, CRDT, conflict three-way diff, search indexing.

**Acceptance criteria:**
1. Pull network cable, edit 10 blocks, reconnect → all 10 sync.
2. Kill browser tab, reopen → pending ops preserved.
3. Failed ops retry with exponential backoff.
4. No data loss in crash tests.

---

### Milestone 3: Conflict UX & UI Cleanup (2 Weeks)

**Goal:** Make conflicts resolvable. Stop syncing view state.

| Task | Detail |
|------|--------|
| Three-way diff | Extend `MergePagesModal`: Base (server at `acked_vector`), Ours (pending ops applied), Theirs (current server). Inline diff for text (`diff-match-patch`). Visual tree comparison for structural conflicts. Actions: "Keep mine", "Keep theirs", "Manual edit". |
| Fold state UI-only | Remove `collapsed` from `node` table and sync payload. Tie migration to `sync_protocol_version = v2`: server stops emitting `collapsed`. Each device migrates its own `ui_state` from last synced value when joining v2. `ui_state` is NEVER synced. |
| Keyboard shortcut | `Ctrl/Cmd + .` toggles fold state of focused block. |

**Out of scope:** CRDT, search, import/export.

**Acceptance criteria:**
1. Concurrent edit surfaces three-way diff with correct `conflict_type`.
2. `node.collapsed` not in sync payloads.
3. Fold state is device-local.
4. v1 and v2 clients handle fold state gracefully.

---

### Milestone 4: CRDT Text — Contingent on Spike (3–4 Weeks if Spike Passes)

**Goal:** True simultaneous co-editing of the same block without 409s.

**Pre-M4 spike (3 days):**
- Pick one block type: plain text paragraph.
- Integrate `@lexical/yjs` or minimal Yjs binding.
- Verify custom plugins (mentions, links, inline properties) do not break.
- **If spike fails:** Defer M4 indefinitely. Keep M1 focus-presence + 409 strategy.

**If spike passes:**
- Each block's text content becomes a Yjs `Y.Text` document.
- Server stores Yjs update blobs in `node_yjs_state`.
- Tree ops remain vector-clock batch sync (M1).
- 409s now only for tree conflicts, never text edits.

**Out of scope:** Full Automerge for tree, encryption, search.

**Acceptance criteria:**
1. Two users type in same block simultaneously → texts merge correctly.
2. No 409s for text edits.
3. Tree ops still use vector-clock batch sync.

---

### Milestone 5: Offline Search & Live Queries (2–3 Weeks)

**Goal:** Search and queries work offline and update live.

| Task | Detail |
|------|--------|
| Offline full-text search | **Web:** `MiniSearch`, persist to IndexedDB, <50ms latency. **Mobile:** `sqlite3` + `FTS5` (or trigram fallback). Incremental update on local write. |
| Live-updating queries | QueryAST results invalidate on every local mutation. Reactive cache or subscriptions. Server push invalidates on remote changes. |
| Linked References via QueryAST | Replace hardcoded endpoint with QueryAST compilation. Add filter UI (date, tags, properties). |

**Out of scope:** Encryption, import/export, background sync.

**Acceptance criteria:**
1. Search <50ms offline.
2. Query results update live.
3. Linked References uses QueryAST with filters.

---

### Milestone 6: Interop & Assets (2 Weeks)

**Goal:** Import/export and asset integrity.

| Task | Detail |
|------|--------|
| YAML frontmatter round-trip | Import parser reads YAML (`---
...
` or `+++
...+++
`). Map keys to node properties. Export writes deterministic frontmatter. |
| OPML import/export | Parse `<outline>` recursively. Export to OPML v1.0/v2.0. Handle `_note` attribute. |
| Content-addressed assets | SHA-256 hash on upload. Store as `assets/<hash_prefix>/<hash>.<ext>`. Deduplicate. `asset` table: `(hash, size, mime_type, original_name, refs_count, created_at)`. |

**Out of scope:** Encryption, background sync.

**Acceptance criteria:**
1. Markdown export → import preserves metadata.
2. OPML round-trip preserves hierarchy.
3. Same file uploaded twice → one stored copy.

---

### Milestone 7: Web Polish, Bundle Splitting & Encryption (2–3 Weeks)

**Goal:** Reduce web bundle, add optional encryption, and keep the sync protocol stable for external clients.

The Flutter mobile client has been extracted to its own repository (`miquelrosell99/notees-flutter`). Mobile-specific work (Flutter UI, Android/iOS background sync, Play Store release) is tracked there. This milestone focuses on the web client and the shared server contract.

| Task | Detail |
|------|--------|
| Flutter client (external repo) | Continues in `miquelrosell99/notees-flutter`. Consumes the same sync protocol (same API as web). sqflite + outbox. Ship to Play Store as paid app. |
| Background sync | **Web:** Periodic Background Sync API. **Mobile:** implemented in `notees-flutter`. |
| Bundle splitting | Dynamic import: `GraphView`, `MarkdownImporter`, `OPMLExporter`, `QueryEngine`. Lazy-load modals. Target: ~600–800 KB initial. |
| Encryption at rest (optional, opt-in) | **Web:** `crypto.subtle` AES-GCM, key from user password. Key in memory only. Per-workspace opt-in. **Mobile:** implemented in `notees-flutter` (e.g. `sqlcipher_flutter_libs`). |

**Out of scope:** Flutter UI work, Android/iOS packaging, Play Store release (all in `notees-flutter`).

**Acceptance criteria:**
1. The shared sync protocol remains stable and documented for `notees-flutter`.
2. Web client uses Periodic Background Sync where supported.
3. Initial web bundle <800 KB.
4. Encryption is opt-in and does not break search.

---

## 5. Dependency Graph

```
Pre-M1 Validation ──► M0: Foundation
                          │
                          ▼
                    M1: Extract Sync API ──┐
                          │              │
                          ▼              │
                    M2: Outbox + Persist │
                          │              │
                          ▼              │
                    M3: Conflict UX      │
                          │              │
                          ▼              │
                    M4: CRDT Text ◄──────┘  (requires M1; contingent on spike)
                          │
                          ▼
                    M5: Search & Queries
                          │
                          ▼
                    M6: Interop & Assets
                          │
                          ▼
                    M7: Multi-Platform & Polish
                          │
                          ▼
                ┌─────────────────┐
                │  Monetization   │
                │  (Paid Flutter  │
                │   + Hosted Sync)│
                └─────────────────┘
```

**Critical path:** Pre-M1 → M0 → M1 → M4. The `notees-flutter` client can start in parallel once M1 API is stable.

---

## 6. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| M1 breaks existing collaboration | Feature flag `sync_protocol_version`. Roll back to v1 instantly. |
| M1 introduces data loss | Keep soft-delete + 30-day GC (R9). Audit logging before deploy. |
| M4 Yjs spike fails | Defer M4. Keep M1 focus-presence + 409. No deadline pressure. |
| M5 mobile FTS5 unavailable | Verified in M0. Fallback to trigram index or Dart search library. |
| Fold-state migration across devices | Tied to `sync_protocol_version = v2`. v1 clients ignore; each device migrates its own `ui_state` on joining v2. |
| Flutter client diverges from web | Shared sync protocol spec (OpenAPI) lives in this repo. `notees-flutter` implements the same `OperationIntent`, `base_vector`, and outbox semantics. |
| Bundle splitting breaks lazy loading | Test with `webpack-bundle-analyzer` before deploy. |

---

## 7. Success Metrics

| Milestone | Metric |
|-----------|--------|
| Pre-M1 | All 5 validation questions answered. Spike results documented. |
| M0 | `AGENTS.md` matches schema. `schema_version` on AST. Keyboard shortcut works. |
| M1 | Zero 500s from sync endpoint. <1% 409 rate for different-block edits. `base_vector` payload logged. Sync API documented in OpenAPI. |
| M2 | Zero data loss in crash tests. 100% outbox recovery. |
| M3 | Conflict resolution time <30s. Fold state not in sync payloads. |
| M4 | Zero 409s for text edits (if spike passes). |
| M5 | Search <50ms offline. |
| M6 | Import/export round-trip 100% fidelity. |
| M7 | Web bundle <800 KB. Encryption opt-in works. Sync protocol documented and consumed by `notees-flutter`. |

---

## 8. File Paths (Feature-First Layout)

Use these exact paths in implementation:

- `app/features/collab/live_sync_ws.py`
- `app/features/nodes/node_service.py`
- `app/features/nodes/node_repository.py`
- `app/features/sync/router.py`
- `app/features/sync/sync_service.py`
- `app/db/schema/sql.py`
- `app/db/schema/init.py`
- `src/features/sync/SyncManager.ts`
- `src/features/editor/OperationRuntime.ts`
- `src/features/collab/livePresenceStore.ts`
