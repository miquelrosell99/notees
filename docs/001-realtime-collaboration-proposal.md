# Real-Time Collaboration Architecture Proposal

**Status:** Draft  
**Date:** 2026-05-27  
**Scope:** Backend, Frontend, Infrastructure  
**Target Parity:** Notion-class collaborative editing (simultaneous multi-user editing, live cursors, presence, conflict-free merging, offline resilience)

---

## 1. Executive Summary

This proposal outlines a ground-up real-time collaboration architecture for Notees, migrating from the current request-response REST model to a **CRDT-backed, WebSocket-driven collaborative system**. The design prioritizes:

1. **Correctness**: CRDTs guarantee that all users converge to the same state without a central coordination bottleneck.
2. **Offline-first**: Users can continue editing without a connection; changes merge automatically upon reconnection.
3. **Minimal intrusion**: Existing REST API, search, backlinking, and export infrastructure remain largely intact via an asynchronously maintained AST mirror.
4. **Self-hosting simplicity**: The stack adds only **Redis** as a new hard dependency; everything else runs within the existing Python/TypeScript/PostgreSQL ecosystem.

The chosen stack is **Yjs** (CRDT engine) + **WebSockets** (transport) + **Redis Pub/Sub** (cross-instance broadcast) + **PostgreSQL** (persistent event log and AST mirror).

---

## 2. Current State Analysis

### 2.1 What Works Today
- **Granular sharing**: Workspace-level (roles), node-level (read/write), and public anonymous links.
- **Optimistic locking**: `node.version` with `expected_version` checks prevents lost updates in single-user request cycles.
- **Per-block persistence**: Content saves debounced at 500ms; structure saves at 200ms. New blocks use optimistic client UUIDs remapped post-creation.
- **AST as source of truth**: Block content is a JSON AST stored in `node.name`.
- **Lexical editor**: Custom plugins, custom nodes, block-based editing.
- **NodeGraphRuntime**: Client-side graph projection layer between TanStack Query and Lexical.

### 2.2 Why the Current Model Hits a Wall
- **Optimistic locking is a last-line-of-defense, not a collaboration strategy**. A 409 Conflict with "please refresh" is unacceptable for simultaneous editing.
- **Per-block REST saves cannot express inter-block structural intent atomically**. Moving a block while another user edits its neighbor currently risks partial state exposure.
- **No broadcast mechanism**. Client A has no way to know Client B edited the same page without polling.
- **The debounce window (200–500ms) is perceptible latency** for real-time co-editing.

---

## 3. Core Technology Decision: CRDTs (Yjs)

### 3.1 CRDTs vs. Operational Transformation (OT)

| Dimension | OT (e.g., Google Docs) | CRDTs (e.g., Yjs, Automerge) |
|-----------|------------------------|------------------------------|
| **Server role** | Central transformation authority; single point of bottleneck and failure | Stateless distributor; any server can apply updates idempotently |
| **Offline support** | Requires central server to transform queued ops | Natural merge semantics; clients sync deltas on reconnect |
| **Implementation complexity** | High; transformation functions must be proven correct for every pair of operations | Medium; convergence is a mathematical property of the data structure |
| **Lexical integration** | Requires custom adapter | Official `@lexical/yjs` binding maintained by Meta |
| **Self-hosting fit** | Harder to scale horizontally without careful sequencing | Horizontal scaling is trivial because updates commute |

**Verdict:** CRDTs are the objectively superior choice for a modern, self-hosted, block-based editor in 2026.

### 3.2 Why Yjs Specifically

- **Battle-tested**: Powers Linear, GitHub Copilot Chat, and dozens of other production apps.
- **Lexical native support**: Meta maintains `@lexical/yjs`, ensuring the binding stays current with Lexical releases.
- **Efficient binary protocol**: Updates are small deltas, not full document replays.
- **Awareness protocol**: Built-in cursor positions, selections, and user presence ("3 people editing").
- **Provider ecosystem**: `y-websocket` provider can be adapted to our FastAPI backend; no need to write a custom CRDT engine.

---

## 4. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT BROWSER                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────────────┐  │
│  │  Lexical    │◄──►│   Yjs Doc   │◄──►│  CollaborationProvider (WS)     │  │
│  │  Editor     │    │  (per page) │    │  • Awareness (cursors, presence)│  │
│  └─────────────┘    └──────┬──────┘    │  • Sync protocol                │  │
│                            │           └─────────────────────────────────┘  │
│                            │                    ▲                           │
└────────────────────────────┼────────────────────┼───────────────────────────┘
                             │         WebSocket  │
                             │         (y-protocol)│
┌────────────────────────────┼────────────────────┼───────────────────────────┐
│                         BACKEND (FastAPI)        │                           │
│  ┌─────────────────────────┴────────────────────┘                           │
│  │  WebSocket Endpoint: /api/ws/collab/{page_uuid}                          │
│  │  • JWT auth (subprotocol or query param)                                 │
│  │  • Permission check on connect (read) and per-update (write)             │
│  │  • In-memory Yjs document per active page (DocumentManager)              │
│  │  • Persists binary update to DB; publishes to Redis                      │
│  └─────────────────────────────────────────────────────────────────────────┘
│                                    │                                        │
│                              Redis Pub/Sub                                  │
│                         (cross-instance broadcast)                          │
│                                    │                                        │
│  ┌─────────────────────────────────┼─────────────────────────────────────┐  │
│  │         POSTGRESQL              │                                     │  │
│  │  ┌──────────────────┐   ┌──────┴────────┐   ┌─────────────────────┐  │  │
│  │  │   yjs_updates    │   │     node      │   │   node_link (AST)   │  │  │
│  │  │  (event log)     │   │  (AST mirror) │   │   (backlinks)       │  │  │
│  │  │  • update_bin    │   │  • name (AST) │   │                     │  │  │
│  │  │  • page_uuid     │   │  • version    │   │                     │  │  │
│  │  │  • user_id       │   │  • parent_id  │   │                     │  │  │
│  │  │  • seq (clock)   │   │  • sequence   │   │                     │  │  │
│  │  └──────────────────┘   └───────────────┘   └─────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Design Principles

1. **Yjs is the source of truth for live page state.** The PostgreSQL `node` table becomes a **queryable AST mirror**—eventually consistent but kept tightly in sync.
2. **One Yjs document per page.** This includes the page title, the ordered array of blocks, and each block's content and metadata. Block reordering, indentation changes, and content edits all live inside one CRDT.
3. **Cross-page operations remain REST.** Moving a block to a different page, sharing permissions, and asset uploads still use the existing REST API. This avoids the complexity of distributed transactions across CRDT documents.
4. **Permissions are enforced at the edge.** The WebSocket connection is authenticated and authorized before the Yjs document is loaded. Write operations are rejected if the user lacks `can_write`.

---

## 5. Data Model Changes

### 5.1 New Table: `yjs_update` (Persistent Event Log)

```sql
CREATE TABLE yjs_update (
    id BIGSERIAL PRIMARY KEY,
    page_uuid UUID NOT NULL REFERENCES node(uuid) ON DELETE CASCADE,
    update_bytes BYTEA NOT NULL,
    user_uuid UUID REFERENCES "user"(uuid),
    seq BIGINT NOT NULL,           -- Lamport clock / logical ordering
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(page_uuid, seq)
);

CREATE INDEX idx_yjs_update_page_seq ON yjs_update(page_uuid, seq);
```

**Rationale:** Yjs documents are reconstructed by replaying all updates. This table is an append-only event log—conceptually similar to Kafka or Event Store, but inside PostgreSQL. Because updates are small binary deltas, this table grows slower than one might expect.

**Compaction:** A background job periodically computes a full state vector snapshot for cold pages and deletes superseded updates older than 30 days.

### 5.2 New Table: `yjs_state_vector` (Page Snapshots)

```sql
CREATE TABLE yjs_state_vector (
    page_uuid UUID PRIMARY KEY REFERENCES node(uuid) ON DELETE CASCADE,
    snapshot_bytes BYTEA NOT NULL,    -- Yjs encoded state
    state_vector BYTEA NOT NULL,      -- Yjs state vector for incremental sync
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Rationale:** When a page is opened, the server must serve the current document state quickly. Replaying 10,000 updates from `yjs_update` is too slow. The snapshot table provides instant hydration.

### 5.3 AST Mirror: `node` Table Evolution

The existing `node` table **remains the queryable index** for:
- Full-text search (PostgreSQL `tsvector`)
- Backlink queries (`node_link`)
- Export / backup
- Property filtering and QueryAST

However, `node.name` for blocks and pages is no longer the **authoritative** source of truth during editing; it is a **projected view** computed from the Yjs document.

**Change:** Add a column to track mirror staleness for debugging:
```sql
ALTER TABLE node ADD COLUMN yjs_mirror_version BIGINT DEFAULT 0;
```

This is optional telemetry; the frontend never reads it.

### 5.4 Document Schema (Yjs Shared Types)

Each page is a Yjs `Y.Doc` with this structure:

```typescript
// Root-level map for page metadata
const pageMeta = ydoc.getMap('meta');
pageMeta.set('title', Y.Text);           // Page title AST
pageMeta.set('icon', string | null);
pageMeta.set('coverImage', string | null);

// Ordered list of blocks
const blocks = ydoc.getArray('blocks');  // Y.Array<Y.Map>

// Each block
interface YBlock {
  id: string;            // UUID (stable)
  type: string;          // 'paragraph' | 'heading' | 'whiteboard' | ...
  content: Y.Text;       // Rich-text content with formatting marks
  properties: Y.Map;     // Custom properties (key -> value)
  collapsed: boolean;
  createdAt: string;     // ISO timestamp (immutable)
}
```

**Why `Y.Array` for block order?** `Y.Array` is a sequence CRDT. Concurrent insertions, deletions, and moves converge correctly. Two users adding a block at the end of the page will both see both blocks, in a deterministic order.

**Why `Y.Text` for content?** `Y.Text` handles concurrent formatting (bold, italic, links) and insertion/deletion at the character level. It is the gold standard for rich-text CRDTs.

---

## 6. Backend Design

### 6.1 Document Manager (`app/domain/services/collab_manager.py`)

A domain service that owns the lifecycle of in-memory Yjs documents.

```python
class CollabManager:
    """
    • Maintains an LRU cache of active Yjs documents (page_uuid -> Y.Doc).
    • Hydrates documents from yjs_state_vector on first access.
    • Applies incoming binary updates, persists them, and broadcasts.
    • Recomputes the AST mirror after significant changes.
    """

    async def get_or_load_doc(self, page_uuid: UUID) -> YDoc:
        ...

    async def apply_update(self, page_uuid: UUID, update: bytes, user_uuid: UUID) -> None:
        ...

    async def get_update_since(self, page_uuid: UUID, state_vector: bytes) -> bytes:
        """Returns a diff for incremental sync (client reconnect)."""
        ...
```

**Key rule:** Documents are **lazy-loaded** and **evicted** after TTL (e.g., 5 minutes of no active WebSocket connections). This prevents unbounded memory growth.

### 6.2 WebSocket Endpoint (`app/routers/collab_ws.py`)

```python
@router.websocket("/ws/collab/{page_uuid}")
async def collaboration_websocket(
    websocket: WebSocket,
    page_uuid: UUID,
    token: str,  # from query param or subprotocol
):
    # 1. Authenticate JWT
    user = await authenticate_ws_token(token)

    # 2. Authorize (read access minimum)
    if not await permission_checker.can_read_node(user.uuid, page_uuid):
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept(subprotocol="y-protocol")

    # 3. Load document
    doc = await collab_manager.get_or_load_doc(page_uuid)

    # 4. Enter pub/sub for this page
    async with redis_pubsub.subscribe(f"collab:{page_uuid}") as channel:
        # 5. Send initial sync step 1 (full state or diff)
        await send_sync_step1(websocket, doc)

        # 6. Start concurrent tasks:
        #    a) Read from client -> apply to doc -> persist -> publish to Redis
        #    b) Read from Redis -> apply to doc -> send to client
        await run_client_and_pubsub_loops(websocket, channel, doc, user)
```

**Write enforcement:** When a client sends an update, the server applies it to the in-memory Yjs document **but** also checks `can_write_node` before persisting to the database or broadcasting. If read-only, the update is silently discarded (or an error message is sent), and the client is re-synced with the canonical state.

### 6.3 Redis Pub/Sub (`app/infrastructure/redis_pubsub.py`)

When Notees runs in a multi-instance deployment (e.g., Kubernetes with 3 backend pods), WebSocket connections for the same page may land on different pods. Redis provides the **backplane** for cross-instance broadcast.

```python
class RedisPubSub:
    async def publish(self, channel: str, message: bytes) -> None:
        ...

    async def subscribe(self, channel: str) -> AsyncIterator[bytes]:
        ...
```

**Single-instance optimization:** If `REDIS_URL` is not configured, the backend falls back to an in-memory `asyncio.Queue` broadcast. This keeps self-hosted single-container deployments simple.

### 6.4 AST Reconciler (`app/domain/services/ast_reconciler.py`)

After Yjs updates are applied, the system must project the CRDT state back into the existing relational model so that search, backlinks, and exports continue to work.

```python
class ASTReconciler:
    async def reconcile_page(self, page_uuid: UUID, ydoc: Y.Doc) -> None:
        """
        1. Walk the Yjs document blocks.
        2. Convert each block's Y.Text content to JSON AST.
        3. Compare with current node rows:
           • Insert new blocks
           • Update changed blocks (name, sequence, parent_id)
           • Soft-delete removed blocks
        4. Update node_link table from parsed AST references.
        5. Update page title in node.name.
        6. Increment node.version (kept for REST compatibility).
        """
```

**Trigger strategy:** The reconciler runs:
- **Synchronously** inside the `apply_update` call if the update is small and the server is under light load.
- **Asynchronously** via `asyncio.create_task` for bulk imports or rapid burst typing, with a debounce (e.g., 250ms).

Because the reconciler is deterministic and idempotent, running it asynchronously is safe.

### 6.5 Conflict Resolution: What Happens to Optimistic Locking?

The `node.version` optimistic lock is **retained for REST API endpoints** but **irrelevant for WebSocket updates**. If a legacy client or mobile app uses REST to update a block while a collaborative session is active:

1. REST update succeeds, increments `node.version`, and triggers an AST-to-Yjs sync (reverse direction).
2. The Yjs document absorbs the REST change as a new update.
3. All connected WebSocket clients receive the update via the normal broadcast.

This hybrid model allows gradual migration without a big-bang cutover.

---

## 7. Frontend Design

### 7.1 Lexical-Yjs Integration

The official `@lexical/yjs` package provides a `CollaborationPlugin` that binds a Lexical editor instance to a Yjs `Y.Text` or `Y.Doc`.

For Notees, the integration looks like:

```typescript
// BlockEditor.tsx
import { CollaborationPlugin } from '@lexical/yjs';
import { WebsocketProvider } from './infra/WebsocketProvider';

function BlockEditor({ pageUuid }: { pageUuid: string }) {
  const { yDoc, provider } = usePageYjsDoc(pageUuid);

  return (
    <LexicalComposer initialConfig={...}>
      <CollaborationPlugin
        id={blockUuid}
        providerFactory={() => provider}
        yjsDocMap={new Map([[pageUuid, yDoc]])}
      />
      {/* existing plugins */}
    </LexicalComposer>
  );
}
```

**Important:** Notees currently instantiates one Lexical editor per block. In the collaborative model, we switch to a **single collaborative Lexical editor per page**, where each block is a custom `BlockNode`. Lexical's native block-based structure maps cleanly to the `Y.Array<Y.Map>` document schema.

This is a **significant but necessary refactor** of the editor layer. The per-block `BlockEditor` components become read-only renderers or are absorbed into a page-level `CollaborativePageEditor`.

### 7.2 Custom WebSocket Provider

Instead of `y-websocket`'s standalone server, we write a thin provider that speaks the Yjs sync protocol over our FastAPI WebSocket endpoint:

```typescript
// frontend/src/collab/WebsocketProvider.ts
export class FastAPIProvider extends Observable<string> {
  private ws: WebSocket;

  constructor(pageUuid: string, token: string) {
    super();
    this.ws = new WebSocket(
      `wss://${host}/api/ws/collab/${pageUuid}?token=${token}`,
      ['y-protocol']
    );
    // Wire Yjs message encoding/decoding
  }

  // Yjs provider interface: connect, disconnect, awareness, etc.
}
```

### 7.3 Presence & Awareness

Yjs `awareness` protocol gives us:
- **Live cursors**: Each user's caret position and selection range.
- **User presence**: "Alice is editing this page" with user metadata (name, avatar color).
- **Transient state**: Client-side only; not persisted to the database.

```typescript
// frontend/src/collab/CursorPlugin.tsx
provider.awareness.setLocalState({
  user: {
    name: currentUser.name,
    color: assignColor(currentUser.uuid),
  },
  cursor: { anchor: { block: '...', offset: 5 }, focus: { ... } },
});
```

### 7.4 NodeGraphRuntime & TanStack Query Interactions

The frontend data model changes:

```
Before:
  Backend API ←→ TanStack Query ←→ NodeGraphRuntime ←→ Lexical editors

After (collaborative pages):
  Backend WS ←→ Yjs Doc ←──┬──←── NodeGraphRuntime (read-only projection)
                             └──←── Lexical Collaborative Editor

  Backend REST ←→ TanStack Query ←→ NodeGraphRuntime (for non-collab pages)
```

- **Collaborative pages** bypass TanStack Query for content. The Yjs document is the source of truth.
- **TanStack Query remains** for page metadata (permissions, properties, backlinks), non-collaborative views (search, collections), and cross-page operations (move, delete page).
- **NodeGraphRuntime** is updated to listen to Yjs document changes and project them into its internal graph, so that sidebar components (backlinks, page properties) still work.

### 7.5 Offline Support

Because Yjs documents live in memory and can be serialized to `IndexedDB`, the PWA offline strategy is enhanced:

1. **While online**: Yjs syncs continuously via WebSocket.
2. **While offline**: Edits accumulate in the local Yjs document.
3. **On reconnect**: The provider sends a sync request with its local state vector; the server returns only the missing updates. Concurrent offline edits from two devices merge automatically.

```typescript
// Service worker or main thread
const indexeddbProvider = new IndexeddbPersistence(pageUuid, yDoc);
```

This aligns perfectly with Notees' existing PWA architecture.

---

## 8. Security & Permissions

### 8.1 Authentication

WebSocket connections carry the JWT access token via:
- **Subprotocol header**: `Sec-WebSocket-Protocol: y-protocol, bearer-${token}` (cleaner)
- **Query parameter**: `?token=...` (simpler, acceptable for same-origin)

### 8.2 Authorization Matrix

| Action | Required Permission | Enforcement Point |
|--------|---------------------|-------------------|
| Open WebSocket | `can_read` on page | `websocket.accept()` gate |
| Send content updates | `can_write` on page | `apply_update()` gate |
| Send structural updates | `can_write` on page | `apply_update()` gate |
| Receive updates | `can_read` on page | Connection gated at accept |
| Set awareness (cursor) | `can_read` on page | Allowed; no persistence risk |

### 8.3 Rate Limiting & Abuse Prevention

- **Message rate limit**: Per-IP + per-user rate limiting on WebSocket messages (e.g., 100 updates/10 seconds). Yjs naturally batches rapid keystrokes into small updates, so this limit is generous.
- **Max document size**: Enforce a page-level Yjs document size limit (e.g., 10 MB) to prevent memory exhaustion.
- **Connection limits**: Per-user max concurrent WebSocket connections (e.g., 10).

---

## 9. Infrastructure Changes

### 9.1 Docker Compose (`compose.yaml`)

Add Redis as a new service:

```yaml
services:
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]

  backend:
    environment:
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      redis:
        condition: service_healthy

volumes:
  redis-data:
```

### 9.2 Python Dependencies (`requirements.txt`)

```
y-py>=0.7.0           # Yjs Python bindings
websockets>=15.0      # FastAPI WebSocket support (already transitive, pin it)
redis>=5.0.0          # asyncio Redis client
```

### 9.3 Frontend Dependencies (`frontend/package.json`)

```json
{
  "dependencies": {
    "yjs": "^13.6.0",
    "@lexical/yjs": "^0.44.0",
    "lib0": "^0.2.0"
  }
}
```

---

## 10. Migration Strategy

Real-time collaboration is a foundational shift. A big-bang rewrite is too risky. We propose a **4-phase rollout**:

### Phase 1: Foundation (Weeks 1–3)
1. Add Redis to infrastructure.
2. Add `yjs_update` and `yjs_state_vector` tables.
3. Build `CollabManager`, `RedisPubSub`, and WebSocket endpoint.
4. Build the AST reconciler (one-way: Yjs → AST, not yet used live).
5. **No user-facing changes.** Everything is dark-launched.

### Phase 2: Dual-Write & Validation (Weeks 4–6)
1. For every REST `PUT /nodes/{id}` (block content update), also compute and save a Yjs update to `yjs_update`.
2. Run a background job that continuously reconstructs pages from Yjs updates and compares them to the AST mirror. Alert on divergence.
3. **User-facing behavior unchanged.** We are validating that the Yjs projection is bit-for-bit compatible with the existing AST.

### Phase 3: Page-Level Collaborative Beta (Weeks 7–10)
1. Add `is_collaborative_enabled` flag to `node` (pages only).
2. When a user opens a collaborative page, load the Yjs document over WebSocket and render using the new `CollaborativePageEditor`.
3. Non-collaborative pages continue using the existing per-block editor.
4. Invite beta users; monitor sync latency, reconciler lag, and error rates.

### Phase 4: Cutover & Cleanup (Weeks 11–12)
1. Enable collaboration by default for all pages.
2. Deprecate per-block REST saves for content; keep REST for structural cross-page operations.
3. Remove `expected_version` checks from content endpoints (retain for structure/move endpoints if desired).
4. Archive the old per-block editor code.

---

## 11. Trade-offs & Rejected Alternatives

### 11.1 Rejected: PostgreSQL LISTEN/NOTIFY as Pub/Sub

**Why rejected:** LISTEN/NOTIFY works for single-instance deployments but breaks down under connection pool churn and does not work across separate backend processes unless all share one long-lived PostgreSQL connection per page. Redis is the industry standard for this and is trivial to self-host.

### 11.2 Rejected: SSE (Server-Sent Events) instead of WebSockets

**Why rejected:** SSE is simplex (server-to-client only). Yjs requires full-duplex communication for the sync protocol (client sends state vector, server sends diff, client sends awareness). Polling or long-polling hacks are unacceptable.

### 11.3 Rejected: WebRTC (y-webrtc provider)

**Why rejected:** WebRTC provides peer-to-peer collaboration without a server, which is appealing for privacy. However, it requires a signaling server anyway, is unreliable across NATs/firewalls, and makes permission enforcement and audit logging nearly impossible. The server-mediated model is correct for a multi-user SaaS/self-hosted app.

### 11.4 Rejected: Block-level Yjs documents

**Why rejected:** Giving each block its own `Y.Doc` would simplify the per-block editor architecture but would make block reordering, indentation, and page-level awareness extremely complex (cross-document transactions are not a native CRDT concept). Page-level documents are the standard pattern (Notion, Linear, GitHub Copilot Chat).

### 11.5 Rejected: Automerge instead of Yjs

**Why rejected:** Automerge is excellent and has a richer JSON-like data model, but its Lexical integration is community-maintained and less mature than `@lexical/yjs`. Yjs is the safer, faster choice for a Lexical-based stack.

---

## 12. Performance Budget

| Metric | Target | Notes |
|--------|--------|-------|
| **Sync latency** | < 50ms p99 | Server applies update + Redis publish + client render |
| **Initial page load** | < 200ms for 1000 blocks | Snapshot from `yjs_state_vector`; no log replay |
| **Reconciler lag** | < 500ms behind live edits | AST mirror kept in near-real-time for search |
| **Memory per active page** | < 5 MB | Yjs document + Lexical editor state |
| **Concurrent users per page** | 50+ | Yjs scales horizontally with users |

---

## 13. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Lexical-Yjs binding instability** | Low | High | Use official `@lexical/yjs`; pin versions; extensive e2e testing in Phase 2. |
| **AST reconciler divergence** | Medium | High | Dark-launch dual-write; automated divergence detection; nightly consistency audits. |
| **Redis becomes a SPOF** | Low | Medium | Single-instance fallback mode; PostgreSQL LISTEN/NOTIFY as emergency fallback. |
| **Mobile app incompatibility** | Medium | Medium | Android WebView supports WebSockets natively; test early in Phase 3. |
| **Migration complexity** | Medium | High | Strict phase gates; beta flag per page; ability to disable collaboration instantly. |

---

## 14. Summary

This proposal replaces Notees' current request-response editing model with a **Yjs CRDT architecture** that provides Notion-class real-time collaboration. The key decisions are:

1. **Yjs** for conflict-free replicated data types (industry standard, Lexical-native).
2. **Page-level Yjs documents** where blocks are items in a `Y.Array` and content is `Y.Text`.
3. **WebSockets** for bidirectional sync, with **Redis Pub/Sub** for horizontal scaling.
4. **PostgreSQL append-only event log** (`yjs_update`) for persistence and auditability.
5. **AST mirror** (`node` table) maintained by a reconciler so existing search, backlinks, and export features continue to work.
6. **4-phase migration** with dark-launch validation and per-page opt-in flags.

This is not a hack. It is a rigorous, incrementally adoptable, and technically best-in-class architecture for real-time collaboration in a self-hosted note-taking application.
