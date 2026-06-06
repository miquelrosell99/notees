# Notees Use-Case Coverage Report: Outlines + Sharing

**Date:** 2026-06-06  
**Scope:** Personal, family, team, and public sharing scenarios for an outline-based notes app  
**Assessment Method:** Codebase audit of backend (`app/`), frontend (`frontend/src/`), and database schema

---

## Executive Summary

Notees has a **strong foundational sharing architecture** with three permission layers (workspace, node, public links), real-time block-level collaboration via WebSockets, and complete UI flows for managing access. However, it is currently optimized for **"single owner + guests"** rather than **"peer-to-peer collaboration."** The biggest gaps are: no email delivery system, no notification/mention pipeline, no guest editing, no team/group abstractions, and no request-access workflow.

**Overall maturity score by domain:**

| Domain | Score | Rationale |
|--------|-------|-----------|
| Personal / Home | 8/10 | Excellent for PKM; sharing with family is awkward due to account-creation friction |
| Small Team / Work | 6/10 | Workspace sharing works, but lacks notifications, comments integration, and guest access |
| Client / External | 5/10 | Public links are read-only; no password protection, no custom domains, no comment-only mode |
| Education / Study | 6/10 | Good for individual notes; group study is limited by real-time sync constraints |
| Creative / Writing | 7/10 | Outliner is ideal; co-editing same blocks is lock-based, not CRDT |

---

## 1. Personal & Home Use Cases

### 1.1 Daily Journaling (Personal)
**Description:** User writes daily journal entries in an outliner, with automatic date pages and bidirectional linking.

**Supported?** ✅ **Fully**
- Daily journals are first-class (`is_daily = true`)
- Automatic date-page creation (`POST /api/nodes/daily`)
- Outliner supports nested blocks, tags, and properties
- Works offline as a PWA with service-worker caching

**Gaps:** None significant.

---

### 1.2 Personal Knowledge Management (Zettelkasten / Second Brain)
**Description:** User builds a linked network of notes over time, using `[[wiki links]]`, tags, and backlinks.

**Supported?** ✅ **Fully**
- Bidirectional linking with automatic `node_link` table population
- Backlink sidebar in `NodeView.tsx`
- Block-level references via `((block-uuid))`
- Graph view (`AllPagesGraphView.tsx`)
- Full-text search across names and block content

**Gaps:** None significant.

---

### 1.3 Sharing Recipes with a Partner / Family Member
**Description:** User maintains a recipe collection. They want their spouse to view recipes, add comments, and maybe add new ones.

**Supported?** ⚠️ **Partially — with friction**
- **What works:** User can share individual recipe pages via "User Shares" (read or write) or share the entire "Home" workspace with the spouse as an `editor`.
- **What works well:** Real-time sync means both can edit simultaneously (different blocks).
- **Friction points:**
  1. The spouse **must create an account** before they can be invited. There is no email invitation flow — the inviter must know the exact email address and the invitee must have already signed up.
  2. The spouse sees **all shared content in the same UI** but must switch workspaces manually via `WorkspaceSwitcher`.
  3. If the user shares the entire workspace, the spouse sees *everything* (including personal notes). Node-level sharing is more granular but tedious for dozens of recipes.
  4. No "comment-only" permission — spouse with `write` can edit anything; with `read` they cannot comment at all.

**Implementation needed:**
- **Email invitations with auto-enrollment:** `POST /api/workspaces/{uuid}/members` should trigger an email with a signup/join link. If the invited email does not exist, create a pending enrollment token.
- **Folder-level / collection-level sharing:** Currently only pages and workspaces are shareable. Recipes are often grouped under a "Recipes" parent page; child inheritance exists in the permission model (`ancestor page share`) but is not exposed in the UI for creation.
- **Comment-only role:** Add `can_comment` to `node_share` and `workspace_share` schemas, and surface it in the UI.

---

### 1.4 Collaborative Travel Planning (Family / Friends)
**Description:** A group plans a trip together: itinerary, bookings, packing lists, budget.

**Supported?** ⚠️ **Partially**
- **What works:** A shared workspace or shared page with `editor` role allows everyone to add blocks (destinations, tasks, budget items).
- **What works:** Properties (e.g., "Cost", "Booked", "Date") can be used to structure the plan.
- **What works:** Task nodes (`is_task = true`) can track todos like "Buy flight tickets."
- **Friction points:**
  1. No `@mentions` — cannot ping a specific family member to handle a task.
  2. No notification when someone adds a new booking or changes the itinerary.
  3. Same-block editing (e.g., two people editing the budget table) requires locks and can feel blocking.
  4. Offline editing on mobile while traveling and later syncing is single-user only; multi-user offline merge is not supported.

**Implementation needed:**
- **@mention system:** Parse `@username` or `@email` in block AST, store mention records, and deliver notifications.
- **Notification pipeline:** WebSocket push or polling endpoint for "someone edited a page you care about."
- **Mobile offline multi-user sync:** This is a hard problem. A pragmatic interim fix is to show a "sync conflict" UI when the server state has diverged from local offline edits.

---

### 1.5 Home Renovation / Project Planning
**Description:** Tracking contractors, materials, budgets, timelines, and photos for a home project.

**Supported?** ⚠️ **Partially**
- **What works:** Image assets can be uploaded and embedded in blocks. Outliner structure suits phased projects.
- **What works:** Query-driven collections can filter tasks by status.
- **Friction points:**
  1. **No Google Photos / cloud sync for assets** — assets are stored locally on the server under `data/workspaces/{uuid}/assets/`.
  2. **No calendar integration** — cannot sync project milestones to Google/Outlook calendars.
  3. Contractors would need accounts to view shared pages.

**Implementation needed:**
- **Public share with optional password:** Allow contractors to view a read-only link without creating an account. Password protection would add a small barrier against UUID guessing.
- **Asset external storage adapters:** S3, Backblaze B2, or WebDAV adapters for asset storage.

---

### 1.6 Family Budget / Expense Tracking
**Description:** Tracking monthly expenses, categories, and savings goals in a structured outliner.

**Supported?** ⚠️ **Partially**
- **What works:** Properties (Number type) can store amounts. Tables (`TableView`) can render structured data.
- **What works:** Queries can aggregate/filter by month or category.
- **Friction points:**
  1. No spreadsheet-like formulas (sums, averages) in the outliner or table views.
  2. No CSV/Excel import for bank statements.
  3. No read-only sharing for an accountant — public links show everything including sensitive notes.

**Implementation needed:**
- **Computed properties / formulas:** A property type or view setting that aggregates child nodes (e.g., `SUM(children.cost)`).
- **Selective public sharing:** Share only a specific table/query view, not the entire page with all its nested blocks.

---

## 2. Work & Professional Use Cases

### 2.1 Meeting Notes with Action Items
**Description:** Team member takes notes during a meeting, tags action items, and shares with attendees.

**Supported?** ✅ **Mostly**
- **What works:** Fast outliner capture, task nodes, and property-based tagging.
- **What works:** Share the page with attendees (read or write). Public link for external attendees.
- **What works:** Comments system allows post-meeting discussion on specific blocks.
- **Friction points:**
  1. No **template system for recurring meetings** — user must duplicate a previous meeting page manually.
  2. No **auto-generated summary** or AI extraction of action items.
  3. No **calendar integration** to auto-create daily/weekly meeting pages.

**Implementation needed:**
- **Templates:** `is_template = true` exists in the schema but template instantiation UI is minimal. A "New from template" flow in the command palette would help.
- **Meeting page auto-creation:** Integration with CalDAV or Outlook REST to pre-create meeting note pages from calendar events.

---

### 2.2 Team Wiki / Documentation
**Description:** Living documentation for a product or team, collaboratively maintained.

**Supported?** ⚠️ **Partially — good for small teams, friction at scale**
- **What works:** Workspace sharing with `editor` role gives the whole team write access.
- **What works:** Bidirectional links prevent orphan docs.
- **What works:** Full history is implicit via `version` column and `write_date` (though no explicit diff UI exists yet).
- **Friction points:**
  1. **No approval workflow** — anyone with `editor` can publish changes immediately. No "draft" vs "published" states.
  2. **No structured permissions by folder** — cannot make "HR" docs admin-only while "Engineering" docs are open.
  3. **No search across workspaces** — if documentation is split across multiple workspaces (e.g., per-product), global search is not available.
  4. **No analytics** — cannot see which docs are most viewed or which links are dead.

**Implementation needed:**
- **Page states / publishing workflow:** Add `state` enum to `node` (`draft`, `review`, `published`). Only `published` pages appear in public shares or read-only views.
- **Folder/collection-level permissions:** Expose ancestor inheritance in the sharing UI so a folder of docs inherits permissions from its parent page.
- **Cross-workspace search:** A global search endpoint that queries all workspaces the user has access to.

---

### 2.3 Sprint Planning & Retrospectives (Agile)
**Description:** Team uses outliner for backlog grooming, sprint planning, and retro boards.

**Supported?** ⚠️ **Partially**
- **What works:** Outliner is natural for backlog items (nested stories → tasks).
- **What works:** Properties can store story points, status, assignee.
- **What works:** Query views can filter by sprint or status.
- **What works:** Whiteboard view exists for retrospectives.
- **Friction points:**
  1. **No Kanban board view** — only List, Document, Card, Table, Gantt, Timeline, Graph, and Whiteboard. Agile teams expect Kanban.
  2. **No Jira/GitHub integration** — cannot sync issues bidirectionally.
  3. **No sprint boundary enforcement** — queries are manual; no automatic sprint rollover.
  4. **Whiteboard view is local-only** — not collaborative in real-time.

**Implementation needed:**
- **Kanban view:** Group nodes by a property (e.g., `Status`) into columns with drag-and-drop.
- **Integration webhooks:** Incoming webhooks to create nodes from GitHub issues/Jira tickets; outgoing webhooks on status change.

---

### 2.4 Client Collaboration & External Sharing
**Description:** Agency shares a project plan or deliverable with a client for feedback.

**Supported?** ⚠️ **Partially — read-only is easy, feedback is hard**
- **What works:** Public share links generate a clean, read-only HTML page (`PublicShareView.tsx`).
- **What works:** User shares (authenticated) can give clients `read` or `write` access.
- **Friction points:**
  1. **Public links are read-only with no commenting** — clients cannot leave feedback without an account.
  2. **No password on public links** — links are UUID-only security. If leaked, anyone can view until expiry.
  3. **No custom branding** — public pages show generic Notees styling, not agency branding.
  4. **No versioned sharing** — cannot share "v1.0" snapshot while continuing to edit "v2.0" internally.

**Implementation needed:**
- **Comment-only public shares:** Allow anonymous users to post comments on public shares (requires CAPTCHA or rate limiting).
- **Password-protected shares:** Add `password_hash` to `node_public_share` and a password gate on `PublicShareView`.
- **Share snapshots / versions:** Allow creating a read-only snapshot of a page at a point in time, generating a separate share link.

---

### 2.5 Research & Literature Notes (Academic / R&D)
**Description:** Researcher maintains a Zettelkasten of papers, hypotheses, and experiments with citations.

**Supported?** ✅ **Mostly**
- **What works:** Bidirectional linking is ideal for connecting papers to ideas to experiments.
- **What works:** Properties can store DOI, authors, year, rating.
- **What works:** Query views can filter unread papers or high-priority hypotheses.
- **Friction points:**
  1. **No citation export** — cannot export a bibliography in BibTeX or APA format.
  2. **No PDF annotation integration** — cannot highlight a PDF and link the highlight to a block.
  3. **No Zotero integration** — must manually enter paper metadata.

**Implementation needed:**
- **BibTeX/APA export:** An export format that traverses linked paper nodes and generates a bibliography.
- **Zotero API sync:** Import items from a Zotero library as nodes.

---

### 2.6 Onboarding Documentation
**Description:** New hire reads onboarding docs, checks off tasks, and asks questions.

**Supported?** ⚠️ **Partially**
- **What works:** Structured outliner with task checkboxes, linked resources, and embedded assets.
- **What works:** Comments allow new hires to ask questions on specific blocks.
- **Friction points:**
  1. **No progress tracking** — cannot see at a glance which onboarding sections are completed.
  2. **No "assign to me" for tasks** — tasks are global, not assigned to individuals.
  3. **No due dates with reminders** — tasks have no temporal urgency.

**Implementation needed:**
- **Progress property / view:** A view mode that shows completion percentage for a page and its children.
- **Task assignment:** Extend `is_task` nodes to include `assigned_to_user_id` and filter views by assignee.

---

### 2.7 Async Standups / Team Updates
**Description:** Team members write async updates ("What I did / What I'll do / Blockers") in a shared page.

**Supported?** ⚠️ **Partially**
- **What works:** Shared page with `editor` access allows everyone to add their section.
- **What works:** Daily pages could host standup updates.
- **Friction points:**
  1. **No structured template enforcement** — updates can become inconsistent.
  2. **No threading / replies** — comments exist but are not threaded in a way that facilitates discussion per update.
  3. **No Slack/Teams integration** — cannot auto-post updates to a channel.

**Implementation needed:**
- **Template enforcement:** Allow page templates that pre-create child blocks ("Yesterday", "Today", "Blockers").
- **Slack webhook:** POST standup content to a Slack channel via incoming webhook.

---

## 3. Education & Study Use Cases

### 3.1 Course Notes & Outlining
**Description:** Student takes lecture notes in an outliner, linking concepts across lectures.

**Supported?** ✅ **Fully**
- Outliner structure maps perfectly to lecture hierarchy.
- Bidirectional links connect concepts (e.g., `[[Recursion]]` appears in CS101 and CS201).
- Flashcard generation is possible via properties but not native.

**Gaps:** No native spaced-repetition integration.

---

### 3.2 Group Study Collaboration
**Description:** Study group collaboratively builds a shared study guide before an exam.

**Supported?** ⚠️ **Partially — same friction as small team collaboration**
- Real-time editing on different blocks works.
- Lock-based same-block editing can be frustrating when 5 people try to edit the same definition simultaneously.
- No "suggestion mode" — edits are immediate and permanent.

**Implementation needed:**
- **Suggestion mode / track changes:** Store proposed edits as separate nodes or metadata, requiring approval to merge.

---

### 3.3 Thesis / Dissertation Research
**Description:** Graduate student manages chapters, references, notes, and advisor feedback.

**Supported?** ⚠️ **Partially**
- Outliner can model chapters → sections → paragraphs.
- Advisor can be given `write` or `read` access.
- **Friction:** Advisor comments are not distinguished from student text. No "reviewer" role.

**Implementation needed:**
- **Annotation / highlight layer:** Allow reviewers to highlight text and attach comments without modifying the underlying AST.

---

## 4. Creative & Writing Use Cases

### 4.1 Novel / Script Outlining
**Description:** Writer uses outliner for plot structure, character arcs, and scene beats.

**Supported?** ✅ **Mostly**
- Outliner is ideal for hierarchical story structure.
- Properties can track POV, location, word count, status.
- Whiteboard view can map plot visually.
- **Friction:** No "focus mode" or distraction-free writing environment.

---

### 4.2 Collaborative Worldbuilding
**Description:** Writers or game designers build a shared lore bible with locations, characters, and timelines.

**Supported?** ⚠️ **Partially**
- Same capabilities as team wiki.
- Timeline view exists for chronological lore.
- **Friction:** No image galleries or map embedding. Assets are single-file uploads only.

**Implementation needed:**
- **Image gallery block type:** A block that displays multiple assets in a grid/lightbox.
- **Map embedding:** Support for iframe embeds (OpenStreetMap, Google Maps).

---

## 5. Sharing Patterns Matrix

This table maps generic sharing patterns to Notees support:

| Pattern | Support | Notes |
|---------|---------|-------|
| **Read-only public link** | ✅ Full | `node_public_share` with expiry, generates static HTML |
| **Password-protected public link** | ❌ Missing | UUID-only security; trivial to implement with bcrypt hash on `node_public_share` |
| **Anonymous commenting** | ❌ Missing | Public shares are read-only; comments require auth |
| **Authenticated read/write share** | ✅ Full | `node_share` + `workspace_share` with granular booleans |
| **Comment-only share** | ❌ Missing | No `can_comment` permission flag |
| **Guest editing (no account)** | ❌ Missing | All editors must have accounts |
| **Email invitation flow** | ❌ Missing | Inviting a user requires them to already have an account |
| **Real-time co-editing (same block)** | ⚠️ Partial | Lock-based; one editor per block at a time |
| **Real-time co-editing (different blocks)** | ✅ Full | WebSocket broadcasts apply edits to all connected clients |
| **Offline-then-sync (single user)** | ⚠️ Partial | Sync endpoint exists but is labeled a "stub" needing redesign |
| **Offline-then-sync (multi-user merge)** | ❌ Missing | No CRDT or OT merge logic |
| **Cross-workspace search** | ❌ Missing | Search is scoped to active workspace |
| **Selective export (share only part)** | ⚠️ Partial | Can share a page, but not a filtered view or specific blocks |
| **Snapshot / versioned share** | ❌ Missing | Shares always reflect live state |
| **Social features (likes, reactions)** | ❌ Missing | Not implemented |
| **@mentions & notifications** | ❌ Missing | Not implemented |
| **Activity feed (what changed)** | ⚠️ Partial | `activity.py` logs exist but are not surfaced as a user-friendly feed |

---

## 6. Priority Implementation Roadmap

Based on impact vs. effort, here is the recommended order to close gaps:

### Phase 1: Foundation (High Impact, Low Effort)
1. **Email invitation + auto-enrollment**
   - Add SMTP config to `app/config.py`.
   - Add `pending_invite` table or reuse `workspace_share` with `pending = true`.
   - Generate enrollment tokens; send email with join link.
   - On enrollment, convert pending share to active.

2. **Password-protected public shares**
   - Add `password_hash` column to `node_public_share`.
   - Update `POST /api/nodes/{id}/shares` to accept optional password.
   - Update `PublicShareView.tsx` to show a password gate before rendering.

3. **Comment-only permission**
   - Add `can_comment` to `Permissions` model and `node_share` / `workspace_share`.
   - Update `PermissionChecker` to allow posting comments when `can_comment = true` even if `can_write = false`.
   - Update UI role dropdowns.

### Phase 2: Collaboration (High Impact, Medium Effort)
4. **@mentions & notification pipeline**
   - Parse `@email` or `@username` in `stringify_ast.py` and `stringifyAST.ts`.
   - Create `mention` table: `(id, node_id, block_uuid, mentioned_user_id, created_by, created_at)`.
   - Add `GET /api/notifications` endpoint (poll or SSE).
   - Frontend: notification bell + mention highlighting.

5. **Activity feed per page / workspace**
   - `activity.py` already logs events. Surface them in a UI component (`ActivityLogSidebar.tsx`).
   - Add human-readable descriptions ("Alice edited 'Meeting Notes' 5 min ago").

6. **Folder/collection sharing UI**
   - The backend already supports ancestor inheritance in `PermissionChecker`. Expose it:
     - When sharing a page, add checkbox "Apply to all nested pages and blocks."
     - On the backend, recursively create `node_share` rows for all descendant pages.

### Phase 3: Scale (High Impact, Higher Effort)
7. **Kanban view**
   - New view mode in `NodeCollection`.
   - Group nodes by a selected property into columns.
   - Drag-and-drop to change property value (reuse `@dnd-kit`).

8. **Guest editing (anonymous with captcha)**
   - Add `guest_token` concept: public share links can optionally allow anonymous edits.
   - Store edits under a pseudo-user or attribute them to the token.
   - Rate-limit aggressively and use hCaptcha/Cloudflare Turnstile.

9. **CRDT or OT for same-block merge**
   - Replace lock-based WebSocket editing with Yjs or Automerge.
   - This is a major refactor of `live_sync_ws.py` and the Lexical editor integration.
   - **Pragmatic alternative:** Keep locks for now but add "edit suggestion" mode where non-lock-holders can propose edits that appear as diff overlays.

10. **Cross-workspace global search**
    - New endpoint `GET /api/search/global?q=...` that queries all `node` rows across workspaces the user has access to, using the existing permission joins.

---

## 7. Competitive Positioning

| Competitor | Notees Advantage | Notees Disadvantage |
|------------|------------------|---------------------|
| **Notion** | Self-hosted, faster outliner, bidirectional links native | No database formulas, no native integrations, no social features |
| **Obsidian** | Native real-time collaboration, built-in sharing permissions | Obsidian has richer plugin ecosystem and local-first CRDT (with Obsidian Sync) |
| **Logseq** | Better permission model, workspace isolation, public shares | Logseq has outliner+Whiteboard parity and plugin ecosystem |
| **Anytype** | Simpler sharing model, WebSocket live sync | Anytype is fully local-first with P2P sync; Notees requires server |
| **Outline** | Block-based editor, offline PWA | Outline has mature team permissions and Slack integration |
| **Roam** | Modern React frontend, workspace model, exports | Roam has multi-player CRDT and block embeds |

**Key differentiator to preserve:** Notees is one of the few self-hosted tools that combines an outliner, bidirectional linking, real-time locks, granular permissions, and public sharing in a single package. The gaps are largely in polish (notifications, email, guest access) rather than architecture.

---

## 8. Appendix: Current Sharing Data Model

```
user
  └── workspace (create_uid = owner)
        ├── workspace_share (user_id, can_read, can_write, can_create, can_delete)
        └── node (create_uid = owner)
              ├── node_share (user_id, can_read, can_write, can_create, can_delete, inherited)
              ├── node_public_share (uuid token, expiry_date, active)
              └── node_link (parsed [[wiki links]])
```

Permission resolution (from `app/domain/permissions.py`):
1. Owner → full control
2. `is_private = true` → only owner
3. Explicit `node_share` → granted permissions
4. Ancestor page `node_share` → inherited permissions
5. `workspace_share` → fallback permissions
6. No match → no access

---

*Report generated by codebase audit. For implementation details of specific features, see inline code comments and the AGENTS.md architecture guide.*
