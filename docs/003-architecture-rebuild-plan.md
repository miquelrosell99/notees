# Notees Architecture Rebuild Plan

**Status:** Draft — open for discussion  
**Date:** 2026-06-02  
**Scope:** Full-stack architectural alignment  
**Goal:** Align the architecture with Notees' actual purpose: a self-hosted knowledge base for small groups.

---

## 1. Executive Diagnosis

### What Notees actually is

After discussion, the real product vision is clear:

> **Notees is a self-hosted knowledge base for families, friend groups, and small companies.** Users create pages, blocks, and databases together. Some content is shared among workspace members. Public sharing is limited to read-only links for individual pages.

This is **not** a personal note-taking app with optional sharing. It is **not** an Obsidian alternative. It is closer to **self-hosted Notion** or **Confluence for small teams**.

### What the architecture actually is

- **Server-first** (FastAPI + PostgreSQL) — correct for this use case
- **Offline writes are broken** — only block text edits queue; creates/deletes/moves fail
- `/api/sync` is a 501 stub
- Editor is recovering from a refactor that deleted tasks, tables, assets, code blocks, and embeds
- The "offline-first PWA" claim is marketing, not engineering reality

### The core tension

The architecture is **mostly correct** for a group knowledge base, but it has two problems:

1. **Offline support is half-baked.** The app cannot create blocks offline. For a server-first app, this is acceptable if documented honestly, but claiming "offline-first" is misleading.
2. **The editor refactor was destructive.** Half the features were deleted to fix architectural bugs.

---

## 2. Guiding Principles (non-negotiable)

1. **The backend is the source of truth.** PostgreSQL is correct. FastAPI is correct. The server is required, not optional.
2. **Workspaces are the sharing boundary.** A family, a team, a company — each is a workspace with members.
3. **Single-writer-per-block collaboration.** The WebSocket locking model is correct and stays.
4. **Offline reads work; offline writes queue.** Be honest: the app needs the server for structural changes. Text edits can queue offline.
5. **The editor must not lose features to gain architecture.** Recover tasks, tables, assets, code, queries, embeds.
6. **Everything is still a Node.** The unified data model is elegant and stays.
7. **Self-hosted is the primary deployment.** One Docker command. No managed cloud required.

---

## 3. Target Architecture

### 3.1 Data Layer: PostgreSQL as Source of Truth

The backend **stays**. PostgreSQL is the right choice.

```
┌─────────────────────────────────────────────────────────────┐
│                         CLIENT                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  React + Lexical                                    │    │
│  │  • TanStack Query for server state                  │    │
│  │  • Zustand for UI state                             │    │
│  │  • NodeGraphRuntime for optimistic structure        │    │
│  │  • Offline queue for text edits                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                   │
│                    HTTP / WebSocket                          │
│                          ▼                                   │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│              BACKEND (FastAPI + PostgreSQL)                  │
│  ┌─────────────┐    ┌─────────────────────────────────────┐ │
│  │  PostgreSQL │◄──►│  FastAPI                            │ │
│  │  (source of │    │  • REST API for CRUD                │ │
│  │   truth)    │    │  • WebSocket for live sync          │ │
│  │             │    │  • Auth & workspace permissions     │ │
│  │             │    │  • QueryAST → SQL compiler          │ │
│  │             │    │  • Export (Markdown, HTML, PDF)     │ │
│  └─────────────┘    └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Why PostgreSQL stays:**
- Group knowledge bases need a central server
- Concurrent editing requires locks and transactions
- PostgreSQL handles search (GIN), hierarchy (recursive CTEs), and permissions well
- Self-hosted users want a database they can back up and inspect

**Why we do NOT move to SQLite-in-browser:**
- A family of 4 editing the same meal plan needs a central source of truth
- SQLite-in-browser is for **solo** apps (Obsidian), not **group** apps
- Syncing SQLite files between users is harder than syncing via a server
- The QueryAST compiler, search, and exports already work well server-side

### 3.2 Workspaces: The Sharing Boundary

```typescript
interface Workspace {
  id: string;           // UUID
  name: string;
  owner_id: string;     // user UUID
  members: Member[];
  is_public: boolean;   // allow public read-only links?
}

interface Member {
  user_id: string;
  email: string;
  role: 'owner' | 'editor' | 'viewer';
}
```

**Workspace rules:**
- Every user belongs to at least one workspace
- A user can belong to multiple workspaces (family, work, hobby group)
- All nodes belong to exactly one workspace
- Workspace isolation is enforced at the database level (`workspace_id` on every row)

**Sharing within a workspace:**
- All workspace members see all pages by default
- Future: page-level permissions (private, shared, read-only)
- Future: block-level permissions (comment-only sections)

**Public sharing (read-only links):**
- A workspace member can generate a public link for any page
- Public links are read-only, no auth required
- Public links expire after N days (configurable)

### 3.3 Offline Strategy (Honest)

**Current claim:** "Offline-first PWA"

**Revised claim:** "Offline-capable. You can edit notes offline and they sync when you reconnect. Some features (sharing, invites, exports) require connectivity."

The key distinction: **offline-first** means the app is designed to work without a server. **Offline-capable** means the app gracefully handles temporary disconnections.

**What works offline:**
- View any previously loaded page
- Edit block text (queued, auto-sends on reconnect)
- Navigate the sidebar (cached page tree)
- Search (cached results)

**What requires the server:**
- Create a new block
- Delete a block
- Move / indent / outdent a block
- Add a page
- Add a class, tag, or property
- Share a page

**Why this is acceptable:**
- A family editing a shared grocery list expects it to sync when they get home
- A team member on a plane can draft meeting notes and sync at the hotel
- The app degrades gracefully: reads always work, edits queue, structural changes warn
- This is exactly how Notion, Google Docs, and Figma handle offline

**Offline queue implementation:**
- Keep the existing `offlineQueue` in IndexedDB for text edits
- Add a **structural mutation queue** for creates/deletes/moves
- Queue stores intents, not API calls
- On reconnect: flush text edits first, then structural intents in order
- If a structural intent fails (e.g., parent was deleted), show conflict UI

### 3.4 Sync Protocol

Use the existing REST API + WebSocket model, but fix the offline queue.

```typescript
interface QueuedMutation {
  id: string;
  type: 'content_edit' | 'create_block' | 'delete_block' | 'move_block';
  target_id: string;     // block UUID
  payload: object;
  timestamp: string;
  retry_count: number;
}
```

**Sync flow:**
1. User makes a change
2. Optimistic update in React + NodeGraphRuntime
3. If online: send API request immediately
4. If offline: enqueue mutation in IndexedDB
5. `useOfflineQueue` watches connection state
6. On reconnect: drain queue sequentially (preserves order)
7. Each mutation is retried up to 3 times
8. On failure: show toast with "Sync conflict — click to resolve"

**Why not op-logs / CRDTs?**
- The group is small (family, team). Conflicts are rare.
- REST API + optimistic UI is simpler and already mostly implemented
- CRDTs are overkill for 2-10 users editing a meal plan

### 3.5 Backend: Keep FastAPI, Fix the APIs

The backend does **not** shrink to 5 endpoints. It keeps its CRUD APIs but fixes the offline story.

**What stays:**
- All existing REST endpoints (they work)
- Hexagonal architecture (it works)
- PostgreSQL (it works)
- QueryAST → SQL compiler (it works)
- Request-scoped DB connections (they work)

**What changes:**
- Add structural mutations to the offline queue protocol
- Fix the `/api/sync` endpoint (currently 501 stub)
- Add workspace-level permissions
- Add public share link endpoints

**What is removed:**
- Nothing major. The backend is basically correct.

### 3.6 Frontend: Editor Architecture

**Decision: Keep per-block Lexical, finish the recovery.**

Switching to ProseMirror is a 6-month rewrite. The per-block architecture is the right boundary.

**Component hierarchy:**
```
PageView
└── BlockList (React virtualized list — @tanstack/react-virtual)
    └── BlockRow
        ├── BlockUI (bullet, checkbox, indent, collapse, class pills)
        ├── InlineEditor (LexicalComposer per block)
        │   ├── PlainTextPlugin (or RichTextPlugin)
        │   ├── LinkPillPlugin
        │   ├── ClassTagPlugin
        │   └── ContentChangePlugin → debounced PUT to /api/nodes/:id
        └── BlockAfterContent
            ├── PropertyRow[]
            ├── TaskBadge
            ├── AssetPreview
            ├── TableGrid
            ├── CodeBlock
            ├── QueryResults
            └── EmbedFrame
```

**Editor plugins to rebuild (from regression tracker):**
| Feature | Where it renders | Status |
|---------|-----------------|--------|
| Task checkbox | BlockUI (left of bullet) | ❌ Removed — rebuild |
| Task status cycle | BlockUI | ❌ Removed — rebuild |
| Task priority badge | BlockUI | ❌ Removed — rebuild |
| Paste image | InlineEditor paste handler | ❌ Removed — rebuild |
| Table grid | BlockAfterContent | ❌ Removed — rebuild |
| Asset preview | BlockAfterContent | ❌ Removed — rebuild |
| Code block | BlockAfterContent | ❌ Removed — rebuild |
| Query block | BlockAfterContent | ❌ Removed — rebuild |
| Embed block | BlockAfterContent | ❌ Removed — rebuild |

**Keyboard handling:**
- Enter, Backspace, Delete, Tab, ArrowUp/Down handled by `BlockList` container
- Call `NodeGraphRuntime` intents directly
- Flush content saves before structural mutations
- No imperative refs for cross-block navigation

### 3.7 State Management

**Keep the current stack, fix the race conditions.**

| Layer | Current | Target |
|-------|---------|--------|
| Server state | TanStack Query | Keep it. Add structural mutations to offline queue. |
| Client state | Zustand | Keep it. |
| Runtime graph | NodeGraphRuntime | Keep it. Fix `execCreateBlock` to use floats (done). Fix `afterBlockId` reads (done). |

**The three-layer problem is real but solvable:**
- React props ← TanStack Query cache ← API response
- Runtime graph ← optimistic mutations ← user intents
- The sync between them is the bug source

**Fix strategy:**
- Runtime is source of truth for optimistic structure during editing
- TanStack Query cache is source of truth for persisted data
- After every structural mutation: flush saves, fire API call, invalidate query, reconcile runtime with response
- The `useStructureSync` hook already does this — it just needs to be more robust

### 3.8 Query System

**Keep the QueryAST → SQL compiler on the backend.**

- Queries run against PostgreSQL (fast, indexed)
- The compiler is already implemented and working
- Moving it to the frontend would be a massive refactor with no benefit for a server-first app

### 3.9 Mobile & Desktop

**Current:** Android WebView wrapper.

**Target:** Keep the WebView wrapper for now. Migrate to Capacitor later.

**Why not Tauri/Electron yet?**
- The WebView wrapper is already built and working
- The priority is editor recovery and offline queue fixes
- Platform packaging can wait until the core product is solid
- When we do migrate, Capacitor is the right choice (same codebase, native plugins, iOS support)

---

## 4. Deployment Model

### 4.1 Self-Hosted (primary)

```bash
docker compose up
```

- Single command, brings up backend + PostgreSQL
- Works on a Raspberry Pi, VPS, or home server
- No external dependencies except Docker

### 4.2 Managed Cloud (future)

- Same Docker image, hosted by Notees
- For users who don't want to self-host
- Self-hosted always remains the free, open-source option

---

## 5. Migration Path: Fix, Don't Rewrite

This is **not** a rebuild. It is a **recovery and hardening** of the existing architecture.

### Phase 0: Data Model Hardening (Weeks 1-2)

**Goal:** Fix the foundation before building on it. The data model has accumulated inconsistencies that cause bugs and performance issues.

#### 0.1 Partial Indexes for Node Types ✅ DONE
Added partial indexes for every major node type:

```sql
CREATE INDEX IF NOT EXISTS idx_node_pages ON node(workspace_id, name) WHERE is_page = TRUE AND active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_blocks ON node(workspace_id, parent_id, sequence) WHERE is_page = FALSE AND active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_assets ON node(workspace_id, name) WHERE is_asset = TRUE AND active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_templates ON node(workspace_id, name) WHERE is_template = TRUE AND active = TRUE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_node_comments ON node(workspace_id, parent_id) WHERE is_comment = TRUE AND active = TRUE AND is_deleted = FALSE;
```

Also added `UNIQUE(workspace_id, source_id, target_id)` to `node_link` (0.5).

#### 0.2 Filter Comments from Tree Queries ✅ DONE
Added `AND is_comment = FALSE` to:
- `get_children()` in `postgres_node.py`
- `get_page_content()` in `postgres_node.py`
- `get_children_ids()` in `postgres_node.py`
- `get_descendants()` in `postgres_node_hierarchy.py`
- `get_descendants_batch()` in `postgres_node_hierarchy.py`
- `flattenNodes()` in `frontend/src/components/blocks/BlockList.tsx`
- `flattenNodesFromRuntime()` in `frontend/src/components/blocks/BlockList.tsx`
- `flattenNodes()` in `frontend/src/components/nodes/PropertyReferencesSection.tsx`
- `PresentationModal.tsx` already filtered comments

#### 0.3 Benchmark Recursive CTEs ✅ DONE
**Results:** Recursive CTEs are extremely fast even at deep hierarchies.

| Depth | Siblings | Total Nodes | Time (ms) |
|-------|----------|-------------|-----------|
| 1     | 100      | 101         | 0.56      |
| 5     | 10       | 51          | 0.45      |
| 10    | 5        | 51          | 0.40      |
| 10    | 10       | 101         | 0.45      |
| 20    | 3        | 61          | 0.51      |
| 50    | 2        | 101         | 0.51      |
| 100   | 1        | 101         | 0.54      |
| 5     | 100      | 501         | 0.84      |
| 10    | 50       | 501         | 1.47      |
| 10    | 100      | 1001        | 1.95      |
| 20    | 50       | 1001        | 2.23      |

**Decision:** No closure table needed. Recursive CTEs scale well for expected page sizes (even 1000 nodes is <3ms).

#### 0.4 Clarify `name` Field Semantics ✅ DONE
**Audit result:** `name` already consistently stores stringified AST or title. UUID is stored in the dedicated `uuid` column. No code stores raw UUID in `name`.

**Verified:**
- `_normalize_name_to_ast()` parses/serializes AST correctly
- `NodeCreateData.name` is used for content, not UUID
- Asset `name` stores filename, not UUID
- Frontend uses `node.uuid` for references, `node.name` for display

#### 0.5 Harden `node_link` ✅ DONE
- Added `UNIQUE(workspace_id, source_id, target_id)` constraint via migration-safe `DO $$` block
- `workspace_id` kept for now (used in many queries, removing would require joins)

#### 0.6 Asset Cleanup Job ✅ DONE
- Moved asset file deletion from soft-delete to hard-delete only (`permanently_delete_node`)
- Added `/admin/assets/audit` endpoint:
  - `POST /api/admin/assets/audit?dry_run=true` — lists orphans and missing files
  - `POST /api/admin/assets/audit?dry_run=false` — removes orphan folders
- Orphans detected: folders with no node, or node is soft-deleted/inactive
- Missing files detected: active asset nodes with no folder on disk

#### 0.7 Fix `search_vector` Trigger ✅ DONE
- Changed trigger from `BEFORE INSERT OR UPDATE OF name, search_language` to `BEFORE INSERT OR UPDATE ON node`
- This ensures `search_vector` is recomputed on any column change, not just `name`
- `GENERATED ALWAYS AS` and `REINDEX SEARCH` deferred to future optimization phase

#### 0.8 Enforce Workspace Isolation ✅ DONE
- Audited and fixed workspace isolation in **20+ repository methods**:
  - `postgres_node.py`: `get_max_sequence`, `get_node_class_ids`
  - `postgres_link.py`: `get_source_links`, `get_backlinks`, `get_outgoing_links`, `get_source_inline_classes`, `get_inline_class_references`, `get_text_link_targets`, `get_tag_link_targets`, `get_alias_node_ids`, `get_backlinks_batch`, `get_property_backlinks_batch`, `get_text_property_backlinks_batch`, `get_path_references`, `get_node_class_ids`, `get_distinct_class_ids`, `get_inline_class_targets`, `get_backlink_source_ids`, `delete_source_links`, `delete_non_tag_text_links`, `clear_tag_link`, `delete_property_links`, `ensure_tag_link`
- RLS policies deferred to Phase 3 (workspace sharing) when permission middleware is finalized

#### 0.9 Consolidate Soft-Delete Mechanism ✅ DONE
- Fixed `node_repo.delete()` to use `is_deleted = TRUE` + `deleted_at` instead of `active = FALSE`
- `active = FALSE` retained for **archive** feature (distinct from trash)
- Trash uses `is_deleted = TRUE`; archive uses `active = FALSE`
- Asset file deletion moved to hard-delete only
- All live queries already check `active = TRUE AND is_deleted = FALSE`

#### 0.10 Audit and Fix Alias Semantics ✅ DONE
- Added `_resolve_alias(node)` helper in `NodeService`
- `get_node()` and `get_node_by_uuid()` now resolve aliases transparently (Option A)
- Breadcrumbs already resolved aliases (kept as-is)
- Search already excludes aliases (`aliased_id IS NULL`)
- Exports and workspace IO handle aliases correctly

### Phase 1: Fix Offline Queue (Weeks 3-4)
1. Extend `offlineQueue` to handle structural mutations (create, delete, move)
2. Add retry logic with exponential backoff
3. Add conflict UI for failed mutations
4. Update messaging: "Works offline for reading and text editing"

### Phase 2: Editor Recovery (Weeks 5-10)
1. Implement `@tanstack/react-virtual` for BlockList
2. Rebuild Task system (checkbox, cycle, badge)
3. Rebuild Table, Asset, Code, Query, Embed renderers
4. Test keyboard navigation (Enter, Backspace, Tab, Arrows)
5. Remove or consolidate diagnostic console logs

### Phase 3: Workspace Sharing (Weeks 11-14)
1. Add workspace member management UI
2. Add invite-by-email flow
3. Add role-based permissions (owner, editor, viewer)
4. Add public read-only share links
5. Enforce workspace isolation in all queries

### Phase 4: Collaboration Hardening (Weeks 15-18)
1. Fix WebSocket reconnection logic
2. Add block locking UI ("John is editing this block")
3. Add live cursor indicators
4. Add activity feed (who changed what)
5. Test with 3-5 concurrent users

### Phase 5: Performance & Polish (Weeks 19-22)
1. Virtualized scrolling for large pages
2. Search performance (10k blocks)
3. Export performance (large pages to PDF)
4. Mobile WebView polish (keyboard handling, touch gestures)
5. Documentation and onboarding

---

## 6. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Editor recovery takes longer than expected | High | High | Scope to MVP (text + tasks + tables first) |
| Offline queue conflicts confuse users | Medium | Medium | Clear UI toasts; manual resolution for edge cases |
| WebSocket sync is unreliable on mobile | Medium | High | Fallback to HTTP polling; robust reconnection |
| Workspace permissions have bugs | Medium | High | Extensive integration tests; audit all endpoints |
| Self-hosted setup is too hard for non-technical users | Medium | Medium | One-command installer script; managed cloud option |

---

## 7. Resolved Decisions

The following questions have been answered through audit and discussion:

1. **"Everything is a Node" model:** **KEEP.** The unified model is correct. Add partial indexes and RLS to mitigate performance and isolation issues.

2. **Comments as nodes:** **KEEP.** Comments stay as nodes for editor reuse, links, and unified queries. Filter `is_comment = TRUE` from tree queries only.

3. **`name` field semantics:** **`name` is always stringified AST.** Page title = AST rendered as heading. Block content = AST rendered inline. No separate "title vs content" dichotomy.

4. **Alias feature:** **KEEP.** Audit and fix inconsistent resolution. Create a single `resolve_alias()` helper used everywhere.

5. **Soft-delete mechanism:** **Consolidate on `is_deleted`.** Remove `active` as a soft-delete flag. Use recursive CTEs for cascading soft-delete.

## 8. Open Questions for Discussion

1. **Should workspace members see *all* pages by default, or is there a private/shared distinction?**
   - Simple: all pages are workspace-visible
   - Complex: each page has visibility (private, workspace, public)

2. **Should public share links require the backend to be online, or can they be static HTML exports?**
   - Online: live updates, requires server
   - Static: generated HTML file, works without server

3. **Should we support real-time cursors and presence indicators?**
   - Already partially implemented via WebSocket
   - Need to finish: cursor positions, user avatars, "X is viewing this page"

4. **Should we limit tree depth in the UI?**
   - If recursive CTEs are slow at 10+ levels, a max depth limit (e.g., 7) may be pragmatic
   - Alternative: re-add materialized path or closure table

---

## 9. Success Criteria

The recovery is successful when:

### Phase 0 (Data Model)
- [ ] Partial indexes exist for all major node types and are used by query planner
- [ ] Comments are excluded from all tree/children/export queries
- [ ] Recursive CTE benchmark results documented; decision made on closure table
- [ ] `name` field consistently stores stringified AST; no UUID stored in `name`
- [ ] `node_link` has unique constraint; no duplicate links exist
- [ ] Asset cleanup job runs periodically; no orphaned files in asset directories
- [ ] `search_vector` trigger fires on all relevant columns
- [ ] All repository queries enforce `workspace_id` filtering; RLS policies active
- [ ] Soft-delete uses only `is_deleted` + `deleted_at`; cascades to children
- [ ] Alias resolution is consistent across all read paths

### Overall Product
- [ ] User can edit block text while offline; queue syncs on reconnect. Structural changes show "queued" state.
- [ ] Editor has feature parity with pre-refactor `main` (tasks, tables, assets, code, queries, embeds)
- [ ] A family of 4 can share a workspace and edit simultaneously without data loss
- [ ] Public share links work for read-only access
- [ ] A page with 10,000 blocks scrolls at 60fps
- [ ] Search returns results in <100ms
- [ ] Self-hosted setup is one command (`docker compose up`)
- [ ] New user goes from install to first shared note in <5 minutes

---

*This document is a draft. Each section should be discussed, debated, and revised before implementation begins.*
