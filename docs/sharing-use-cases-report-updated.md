# Notees Use-Case Coverage Report: Updated Status (Post-Implementation)

**Date:** 2026-06-06  
**Scope:** All sharing, collaboration, and notification features requested by user  
**Implementation Status:** COMPLETE (core features) / PARTIAL (advanced editor plugin)

---

## Summary of Changes Implemented

### Phase 1: Email Infrastructure + Invitations ✅

**Backend:**
- `app/config.py` — Added SMTP settings (`smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`, `smtp_tls`, `smtp_from`, `public_url`)
- `app/utils/email.py` — New async email utility using `smtplib` via `asyncio.to_thread`. Gracefully degrades to logging when SMTP is not configured.
- `app/db/schema/sql.py` + `init.py` — New `pending_invite` table with uuid, email, workspace_id, node_id, role, expiry (7 days). Idempotent migration for existing DBs.
- `app/routers/workspaces.py` — `POST /api/workspaces/{uuid}/members` now creates a pending invite if the email doesn't exist, sends an email via SMTP, and returns the invite link as a fallback.
- `app/routers/nodes/shares.py` — `POST /api/nodes/{id}/user-shares` now creates pending invites for non-existent users.
- `app/routers/auth.py` — New `POST /api/auth/invites/accept` endpoint handles both existing users (login + accept) and new users (register + accept).
- `.env.example` — Documented all new SMTP variables.

**Frontend:**
- `frontend/src/views/InviteAcceptView.tsx` — New page at `/enroll?token=xxx` handles invite acceptance. Shows registration form for new users, login form for existing users. Auto-accepts if already logged in.
- `frontend/src/App.tsx` — Added `/enroll` route handling before auth checks.

---

### Phase 2: @Mentions via User Pseudo-Pages ✅

**Backend:**
- `app/db/schema/sql.py` + `init.py` — Added `user_page_node_id` to `"user"` table. Migration for existing DBs.
- `app/workspace_manager.py` — `_ensure_user_page()` creates a system node (`is_page=TRUE`, `is_system=TRUE`) on first workspace creation. Stores node ID back on the user record.
- `app/domain/stringify_ast.py` — Added `user_mention` inline AST node type. Added `extract_user_mentions()` function to scan AST for mentions.
- `app/routers/nodes/crud.py` — After `create_node` and `update_node`, scans the node name AST for `@mentions` and creates notifications for mentioned users.
- `app/routers/notifications.py` — New router with `GET /api/notifications`, `POST /api/notifications/{id}/read`, `POST /api/notifications/read-all`.
- `app/main.py` — Registered notifications router.

**Frontend:**
- `frontend/src/components/layout/NotificationBell.tsx` + `.css` — Notification bell in top bar with unread count badge, dropdown panel, click-to-navigate, mark-all-read.
- `frontend/src/hooks/useNotifications.ts` — TanStack Query hooks for notifications.
- `frontend/src/api/notifications.ts` — API functions for notifications.
- `frontend/src/types/api.ts` — Added `NotificationResponse` type.

**Note:** Full Lexical editor `@mention` autocomplete plugin (custom node + dropdown) was **not implemented** due to scope. The backend infrastructure is complete; when the editor plugin is added later, mentions will automatically generate notifications.

---

### Phase 3: Comment-Only Share Mode + Password-Protected Public Shares ✅

**Backend:**
- `app/db/schema/sql.py` + `init.py` — Added `can_comment BOOLEAN DEFAULT FALSE` to `workspace_share` and `node_share`. Added `password_hash TEXT` to `node_public_share`.
- `app/domain/permissions.py` — Added `can_comment` to `Permissions` dataclass. Added `comment_only()` factory. Updated all resolution paths (workspace share, node share, ancestor share). Added `can_comment_on_node()` helper.
- `app/routers/workspaces.py` — Updated `ROLE_PERMS` to include `can_comment`. New roles: `viewer` (no comment), `commenter` (read+comment), `editor` (read+write+comment), `admin` (all). `list_members` now shows `commenter` role and pending invites. New `DELETE /pending-invites/{email}` endpoint.
- `app/routers/nodes/shares.py` — `create_share` now accepts optional `password` and hashes it with passlib. `create_user_share` supports pending invites.
- `app/routers/nodes/comments.py` — `get_comments` now allows `can_read OR can_comment`. `create_comment` allows `can_comment OR can_write`.
- `app/routers/public.py` — `GET /public/n/{share_uuid}` now checks `password_hash` and returns `403 "password_required"` if password is missing/incorrect.

**Frontend:**
- `frontend/src/components/nodes/ShareModal.tsx` — Added password field for public shares. Added "Can comment" permission option for user shares.
- `frontend/src/components/workspace/WorkspaceShareModal.tsx` — Added "Commenter" role to dropdowns. Shows pending members with "Pending" badge. Allows canceling pending invites.
- `frontend/src/views/PublicShareView.tsx` — Added password gate UI. Prompts for password when `403 password_required` is received.
- `frontend/src/api/shares.ts` — Updated `createShare`, `createUserShare`, `getPublicSharedNode`, `removePendingInvite` signatures.
- `frontend/src/hooks/useShares.ts` — Added `useRemovePendingInvite` hook.

---

### Phase 4: Card View → Kanban Rename ✅

**Files renamed:**
- `CardView.tsx` → `KanbanView.tsx`
- `CardItem.tsx` → `KanbanCard.tsx`
- `CardView.css` → `KanbanView.css`

**All references updated:**
- `frontend/src/types/nodeCollection.ts` — `NodeCollectionViewMode` changed `'card'` → `'kanban'`
- `frontend/src/constants/viewModes.ts` — Order, icons, labels updated
- `frontend/src/components/nodes/views/` — Registry, lazyViews, index exports updated
- `frontend/src/components/nodes/NodeCollection.tsx` — Switch case updated
- `frontend/src/components/nodes/NodeCollectionToolbar.tsx` — View mode check updated
- `frontend/src/components/nodes/QueryNodeCollection.tsx` — All view mode arrays updated
- `frontend/src/views/NodeView.tsx`, `NodeContent.tsx` — `displayMode` `'card'` → `'kanban'`
- `frontend/src/stores/appStore.ts` — `ContentDisplayMode` updated
- `frontend/src/tests/appStore.test.ts` — Test expectations updated
- `frontend/src/components/index.ts` — Export updated
- `frontend/src/components/nodes/views/WhiteboardCardRenderer.tsx` — Import updated

---

### Phase 5: Offline Multi-User Sync Redesign ✅

**Backend:**
- `app/models.py` — Redesigned `SyncRequest` / `SyncResponse` models with proper types:
  - `ClientNodeState` — uuid, version, name, parent_id, sequence, is_deleted
  - `ServerNodeState` — same + write_date
  - `SyncConflict` — uuid, server_version, client_version, reason
- `app/routers/sync.py` — Completely rewritten:
  - Accepts `client_nodes` and `last_sync` from client
  - Fetches server changes since `last_sync`
  - For each client node: checks permissions, detects conflicts (server deleted, both modified, permission denied, server missing)
  - Applies non-conflicting client changes with version increment
  - Re-fetches server state after applying changes
  - Returns `server_nodes`, `deleted_node_uuids`, and `conflicts`
  - Permission-filtered: only returns nodes user can read, only accepts writes user is allowed

**Frontend:**
- `frontend/src/api/shares.ts` — Types updated to match new sync response shape.

**Note:** Full client-side conflict resolution UI is a large piece of work and was not implemented. The backend now correctly detects and reports conflicts; the frontend can surface them in a future iteration.

---

### Phase 6: Bonus Improvements ✅

**Implemented:**
- **Pending invite management** — Workspace share modal shows pending invites, allows canceling them.
- **Notification bell** — Unread count, dropdown panel, mark-all-read, click-to-navigate to mentioned node.
- **Invite acceptance flow** — Dedicated `/enroll?token=xxx` page for new and existing users.

**Not implemented (out of scope for this iteration):**
- Activity feed sidebar (backend logs exist in `activity.py` but no UI)
- Cross-workspace search (backend would need a new endpoint)
- Lexical `@mention` autocomplete plugin

---

## Validation Results

| Check | Status |
|-------|--------|
| `ruff check app/` | ✅ All passed |
| `cd frontend && npm run lint` | ✅ 0 errors (52 pre-existing warnings) |
| `cd frontend && npx tsc -b --noEmit` | ✅ No type errors |

---

## Updated Sharing Patterns Matrix

| Pattern | Status | Notes |
|---------|--------|-------|
| Read-only public link | ✅ Full | Existing feature |
| **Password-protected public link** | ✅ **New** | Hash stored in `node_public_share.password_hash` |
| **Anonymous commenting** | ❌ Missing | Public shares still read-only; comment-only requires auth |
| Authenticated read/write share | ✅ Full | Existing feature |
| **Comment-only share** | ✅ **New** | `can_comment` permission + "Commenter" role |
| Guest editing (no account) | ❌ Missing | Still requires account creation |
| **Email invitation flow** | ✅ **New** | Pending invites + SMTP email + `/enroll` page |
| Real-time co-editing (same block) | ⚠️ Partial | Lock-based (unchanged) |
| Real-time co-editing (different blocks) | ✅ Full | WebSocket broadcasts (unchanged) |
| **Offline-then-sync (multi-user)** | ✅ **New** | Conflict detection backend complete |
| Cross-workspace search | ❌ Missing | Not implemented |
| Selective export | ⚠️ Partial | Unchanged |
| Snapshot / versioned share | ❌ Missing | Not implemented |
| **@mentions & notifications** | ✅ **Partial** | Backend + bell UI done; Lexical plugin deferred |
| **Activity feed** | ⚠️ Partial | Backend logs exist, no UI |

---

## Architecture Changes at a Glance

```
user
  └── workspace
        ├── workspace_share (can_read, can_write, can_create, can_delete, can_comment)
        ├── pending_invite (email, workspace_id, node_id, role, expires_at)
        └── node
              ├── node_share (can_read, can_write, can_create, can_delete, can_comment)
              ├── node_public_share (uuid, expiry_date, password_hash)
              ├── notification (user_id, type, actor_user_id, node_id, message, is_read)
              └── user_page (is_system=TRUE, linked from user.user_page_node_id)
```

---

*Report generated after implementation. For implementation details, see inline code comments and commit history.*
