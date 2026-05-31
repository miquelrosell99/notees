# Single-User-Per-Block Real-Time Collaboration

**Status:** Implemented  
**Date:** 2026-05-31  
**Scope:** Backend, Frontend  
**Architecture:** Server-enforced block locking + WebSocket broadcast + offline mutation queue

---

## 1. Executive Summary

This document describes the real-time collaboration architecture for Notees. Unlike traditional CRDT-based collaboration (where multiple users edit the same document concurrently and changes merge automatically), Notees uses a **single-user-per-block locking model**:

- **One user edits a block at a time.** When a user focuses a block, the server grants them an exclusive lock.
- **Other users see live updates** as the editor types, but their editors are read-only for that block.
- **Locks expire** after 30 seconds of inactivity, or release immediately on blur/disconnect.
- **Offline support:** Edits queue locally and sync when the connection is restored.

This model was chosen because:
1. It aligns perfectly with the per-block `InlineEditor` architecture.
2. It eliminates the need for complex CRDT merge semantics.
3. It provides a predictable UX — users never have their changes overwritten by a concurrent edit.
4. It is dramatically simpler to implement and maintain than full CRDT collaboration.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT BROWSER                                  │
│  ┌─────────────┐    ┌─────────────────────────────────────────────────────┐ │
│  │  Inline     │    │  LiveSyncManager (WebSocket)                        │ │
│  │  Editor     │───►│  • sendFocus() → request lock                       │ │
│  │  (per block)│    │  • sendBlur()  → release lock                       │ │
│  └─────────────┘    │  • sendBlockUpdate() → broadcast to viewers         │ │
│                     │  • heartbeat (15s) → keep lock alive                │ │
│                     └─────────────────────────────────────────────────────┘ │
│                                    ▲                                        │
│                     ┌──────────────┘                                        │
│                     │  WebSocket JSON                                       │
│                     ▼                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Offline Queue (IndexedDB / idb-keyval)                             │   │
│  │  • Enqueue failed content mutations when offline                    │   │
│  │  • Auto-drain when connection restored                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BACKEND (FastAPI)                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  WebSocket Endpoint: /api/ws/live/{page_uuid}                       │    │
│  │  • Authenticate JWT                                                 │    │
│  │  • Authorize read/write permissions                                 │    │
│  │  • Lock registry: page_uuid → block_uuid → connection               │    │
│  │  • Focus → check lock → grant/deny                                  │    │
│  │  • Blur → release lock                                              │    │
│  │  • block_update → verify lock → broadcast                           │    │
│  │  • heartbeat → refresh lock timer                                   │    │
│  │  • disconnect → release all held locks                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│                              Redis Pub/Sub                                   │
│                         (cross-instance broadcast)                           │
│                                    │                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Message Protocol

### Client → Server

| Type | Payload | Purpose |
|------|---------|---------|
| `focus` | `{ block_uuid }` | Request lock for a block |
| `blur` | `{ block_uuid }` | Release lock for a block |
| `block_update` | `{ block_uuid, block_id, name }` | Broadcast content change to viewers |
| `heartbeat` | `{}` | Keep lock alive (every 15s) |

### Server → Client

| Type | Payload | Purpose |
|------|---------|---------|
| `user_focus` | `{ block_uuid, user }` | User focused a block |
| `user_blur` | `{ block_uuid, user_id }` | User blurred a block |
| `block_locked` | `{ block_uuid, user_id }` | Lock granted |
| `block_lock_denied` | `{ block_uuid, reason, locked_by? }` | Lock denied (already taken) |
| `block_lock_released` | `{ block_uuid, user_id }` | Lock released voluntarily |
| `lock_expired` | `{ block_uuid, user_id }` | Lock expired due to inactivity |
| `block_updated` | `{ block_uuid, block_id, name, user_id }` | Content changed (viewer update) |
| `users_list` | `{ users }` | Snapshot of current editors |

---

## 4. Block Locking Semantics

### Lock Lifecycle

1. **Request**: Client sends `focus` with `block_uuid`.
2. **Grant**: Server checks `_page_locks[page_uuid][block_uuid]`. If `None`, grant lock, start 30s timer, broadcast `block_locked`.
3. **Deny**: If lock held by another user, send `block_lock_denied` to requester only.
4. **Refresh**: Client sends `heartbeat` or `block_update` every 15s. Server resets 30s timer.
5. **Release**: Client sends `blur`. Server removes lock, broadcasts `block_lock_released`.
6. **Expire**: If 30s passes with no activity, server removes lock, broadcasts `lock_expired`.
7. **Disconnect**: On WebSocket close, server releases all locks held by that connection.

### Cross-Instance Consistency

The lock registry is **in-memory per instance**. For multi-instance deployments:
- Lock state is **best-effort** across instances.
- A user connecting to Instance A sees locks from Instance A users immediately.
- Locks from Instance B users are visible via Redis pub/sub messages (e.g., `block_locked`, `block_lock_released`), but there is a small propagation delay.
- In the worst case, two users on different instances could both be granted a lock for the same block briefly. This is harmless because:
  - REST saves (the source of truth) are sequential.
  - The last writer wins, which is acceptable for a single-user-per-block model.

---

## 5. Offline Write Queue

### Architecture

```
User types → InlineEditor onChange → onContentChange
  → Online? → debounce 500ms → REST PUT + WS broadcast
  → Offline? → debounce 500ms → enqueue in IndexedDB

On reconnect:
  → Drain queue sequentially (content updates first)
  → Each item: REST PUT
  → Success → remove from queue
  → 4xx → drop (don't retry invalid requests)
  → Network/5xx → re-enqueue with incremented retry count
  → Max 5 retries → drop
```

### Deduplication

For content mutations, only the **latest state** per block is queued. If a user edits Block A three times while offline, the queue contains only one entry for Block A (the most recent content).

### UX

- Offline banner shows: "Working offline — N changes queued"
- When reconnecting: "Syncing N changes..."
- When done: "All changes synced"

---

## 6. Save Path

```
User types in InlineEditor
  → Lexical OnChangePlugin fires
  → onContentChange(blockUuid, content)
  → ListView.handleContentChangeBridge(blockUuid, content)
    → Looks up serverId from NodeGraphRuntime
    → Calls onContentChange(serverId, content)
  → useContentSave.handleContentChange(serverId, content)
    → Debounce 500ms
    → saveBlock(serverId, content)
      → 1. Broadcast via WebSocket immediately
      → 2. REST PUT /api/nodes/{serverId} (persist to DB)
        → On success: update TanStack Query cache
        → On network error: enqueue to offline queue
```

The WebSocket broadcast happens **before** the REST call, so viewers see changes within ~500ms (the debounce interval), not 500ms + network roundtrip.

---

## 7. Why Not Yjs/CRDT?

The original proposal (2026-05-27) explored Yjs CRDTs for full concurrent editing. That approach was **rejected** for the following reasons:

1. **Complexity**: Yjs requires page-level documents, which conflicts with the per-block `InlineEditor` architecture. Adapting it would require another major editor refactor.
2. **Overkill**: Notees targets personal and small-team use. The probability of two users genuinely needing to edit the exact same block simultaneously is low.
3. **Maintenance burden**: Yjs Python bindings (`y-py`) and Lexical integration (`@lexical/yjs`) add native dependencies that complicate builds and deployments.
4. **Offline complexity**: CRDT offline support requires local document state that syncs on reconnect. The single-user-per-block model achieves 90% of the value with 10% of the complexity.

---

## 8. Performance Budget

| Metric | Target | Notes |
|--------|--------|-------|
| **Lock acquisition latency** | < 50ms p99 | In-memory dict lookup |
| **Broadcast latency** | < 50ms p99 | WebSocket + Redis pub/sub |
| **Viewer update latency** | < 600ms | 500ms debounce + 50ms broadcast + render |
| **Offline queue drain** | < 1s per 10 items | Sequential REST calls |
| **Concurrent users per page** | 50+ | WebSocket connections scale horizontally |

---

## 9. Security

| Action | Required Permission | Enforcement Point |
|--------|---------------------|-------------------|
| Open WebSocket | `can_read` on page | `websocket.accept()` gate |
| Acquire lock | `can_write` on page | Implicit — focus is only useful if you can edit |
| Send block_update | `can_write` on page | Verified against lock holder + `can_write` flag |
| Receive updates | `can_read` on page | Connection gated at accept |

---

## 10. Files

### Backend
| File | Purpose |
|------|---------|
| `app/routers/live_sync_ws.py` | WebSocket endpoint with lock registry |
| `app/infrastructure/redis_pubsub.py` | Cross-instance broadcast |

### Frontend
| File | Purpose |
|------|---------|
| `frontend/src/collab/LiveSyncManager.ts` | WebSocket client singleton |
| `frontend/src/hooks/useLivePageSync.ts` | React hook for page-level sync |
| `frontend/src/stores/livePresenceStore.ts` | Lock owner + presence state |
| `frontend/src/lib/offlineQueue.ts` | IndexedDB mutation queue |
| `frontend/src/hooks/useOfflineQueue.ts` | React hook for queue management |
| `frontend/src/hooks/useContentSave.ts` | Debounced save with WS broadcast |
