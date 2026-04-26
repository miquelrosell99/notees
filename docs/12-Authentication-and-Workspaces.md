# Authentication & Workspaces

Notees uses **JWT-based authentication** with workspace-level data isolation. Each user can own multiple workspaces, and all data queries are scoped to the active workspace.

---

## Authentication Flow

### Registration

```
LoginView (React)
  │
  ├─ authStore.register(username, password)
  │     │
  │     └─ POST /api/auth/register  ← rate limited: 3/minute
  │           │
  │           ├─ Validate: username 3–50 chars [a-zA-Z0-9_], password 8–128 chars
  │           ├─ Check duplicate username → 400 if exists
  │           ├─ Hash password (pbkdf2_sha256)
  │           ├─ INSERT into "user" table
  │           └─ Create JWT → return Token
  │
  ├─ Store token + user in localStorage
  └─ Update Zustand authStore (persisted)
```

### Login

```
LoginView (React)
  │
  ├─ authStore.login(username, password)
  │     │
  │     └─ POST /api/auth/login  ← rate limited: 5/minute
  │           │
  │           ├─ Look up user by username → 401
  │           ├─ Verify password against hash → 401
  │           ├─ Check is_active flag → 401
  │           └─ Create JWT → return Token
  │
  ├─ Store token + user in localStorage
  └─ Update Zustand authStore
```

All auth failures return a generic `"Invalid username or password"` message — no user enumeration.

### JWT Token Details

| Property | Value |
|----------|-------|
| Algorithm | HS256 |
| Library | PyJWT |
| Expiry | 24 hours (1 day) |
| Secret | `SECRET_KEY` env var (≥32 chars) |
| Payload | `{ user_id, username, exp }` |
| Refresh | None — single long-lived token |

### Password Hashing

| Property | Value |
|----------|-------|
| Scheme | `pbkdf2_sha256` (via passlib) |
| Why not bcrypt? | Avoids 72-character length limit |
| Error handling | `verify_password` catches all exceptions, returns `False` |

---

## Request Authentication

Every API request goes through an Axios interceptor → backend dependency chain:

```
Axios Request Interceptor
  │ Reads localStorage.token
  │ Sets Authorization: Bearer {token}
  ▼
FastAPI Endpoint
  │ Dependency: get_current_user(credentials)
  │   ├─ Extract token from HTTPBearer
  │   ├─ decode_token() → { user_id, username }
  │   ├─ get_user_by_id() ← cached 5 minutes
  │   └─ Check is_active → 401 if inactive
  ▼
Endpoint Handler (user available)
```

### 401 Error Handling

When the backend returns 401, the Axios response interceptor:

1. Clears `token` from localStorage
2. Clears `user` from localStorage
3. Clears `auth-storage` (Zustand persisted state)
4. Dispatches `window.CustomEvent('auth:unauthorized')`
5. Redirects to `/auth` (unless already there)

```typescript
// Simplified from frontend/src/api/client.ts
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      clearAuthToken();
      localStorage.removeItem('auth-storage');
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
      if (!window.location.pathname.startsWith('/auth')) {
        window.location.href = '/auth';
      }
    }
    return Promise.reject(error);
  }
);
```

---

## Admin Bootstrap

On first startup with no users:

```python
ensure_admin_user()
# If ADMIN_PASSWORD env var set → uses that
# Otherwise → generates secrets.token_urlsafe(16) and logs it once
```

---

## Auth Store (Frontend)

Zustand store with persistence:

```typescript
interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}
```

| Action | Behavior |
|--------|----------|
| `login(username, password)` | API call → store token + user |
| `register(username, password)` | API call → store token + user |
| `logout()` | Clear localStorage + reset state |
| `setUser(user)` | Update user, derive `isAuthenticated` |
| `clearError()` | Reset error message |

Only `user` and `token` are persisted (via Zustand `partialize`). `isAuthenticated` is derived at runtime.

---

## Login UI

`LoginView.tsx` handles both login and registration in a single form:

```
┌──────────────────────────┐
│        Notees            │
│                          │
│  Username: [___________] │
│  Password: [___________] │
│                          │
│  [     Sign in     ]     │
│                          │
│  Don't have an account?  │
│  Register                │
│                          │
│  {error message if any}  │
└──────────────────────────┘
```

Toggles between login/register mode via `isRegister` state.

---

## Workspaces

Workspaces provide **complete data isolation**. Every node, link, property, and asset belongs to exactly one workspace.

### Architecture

```
User
├── Workspace "Personal" (active)    ← all queries scoped here
│   ├── Nodes
│   ├── Links
│   ├── Properties
│   └── Assets
├── Workspace "Work"
│   ├── Nodes (completely separate)
│   └── ...
└── Workspace "Shared" (via workspace_share)
```

### Isolation Mechanism

Every repository receives `workspace_id` at construction time:

```python
# dependencies.py
async def get_node_repository(user=Depends(get_current_user)):
    workspace_id, page_class_id = await _get_workspace_context(user.id)
    return PostgresNodeRepository(pool, workspace_id, page_class_id, user.id)
```

All SQL queries filter by `workspace_id`:

```sql
SELECT * FROM node WHERE workspace_id = $1 AND ...
```

### Workspace Context Caching

Workspace resolution is cached per-user (TTL = 5 minutes):

```python
_workspace_context_cache: dict[int, tuple[int, int, float]]
# user_id → (workspace_id, page_class_id, cached_at)
```

Cache is invalidated on workspace switch via `invalidate_workspace_cache(user_id)`.

### Active Workspace Tracking

Active workspace is tracked **in-memory** (not persisted to DB):

```python
_active_workspaces: Dict[str, str]  # user_id → workspace_uuid
```

This means the active workspace resets on server restart — the client re-establishes it.

---

## Workspace API

### List Workspaces

```
GET /api/workspaces
→ {
    workspaces: [
      { uuid, name, created_at, node_count, page_count, 
        asset_count, size_bytes, is_active, is_shared }
    ],
    active: "workspace-uuid" | null
  }
```

Includes both owned and shared workspaces.

### Create Workspace

```
POST /api/workspaces
{ name: "My Workspace" }
→ { uuid, name, ... }
```

On creation:
1. Checks for duplicate name per user
2. Inserts workspace record
3. Calls `seed_workspace()` to create system types (Page, Tag, etc.)
4. Auto-activates the new workspace

### Check Name Availability

```
GET /api/workspaces/check-name/{name}
→ { available: true, name: "My Workspace" }
```

### Switch Workspace

```
POST /api/workspaces/{workspace_uuid}/switch
→ { status: "ok", active: "workspace-uuid" }
```

1. Validates ownership or shared access
2. Updates `_active_workspaces` in-memory dict
3. Invalidates workspace context cache
4. Next API request resolves to the new workspace

### Rename Workspace

```
PUT /api/workspaces/{old_name}/rename
{ name: "New Name" }
→ { uuid, name: "New Name", ... }
```

Owner-only. Checks for name collision.

### Delete Workspace

```
DELETE /api/workspaces/{name}
→ { status: "ok" }
```

Owner-only. CASCADE deletes all data + removes workspace folder from filesystem (`shutil.rmtree`).

### Export Workspace

```
GET /api/workspaces/{name}/export
→ FileResponse (JSON file download)
```

Export format (version 2):

```json
{
  "version": 2,
  "workspace": { "uuid": "...", "name": "..." },
  "nodes": [ ... ],
  "links": [ ... ],
  "properties": [ ... ]
}
```

### Import Workspace

```
POST /api/workspaces/import
Content-Type: multipart/form-data
  name: "Imported Workspace"
  file: <upload.json>
→ { uuid, name, ... }
```

> **Note**: Import currently creates an empty workspace — full data restoration is not yet implemented.

---

## Repository Bundle

For endpoints needing multiple repositories, `RepositoryBundle` provides lazy initialization:

```python
class RepositoryBundle:
    """Lazily initializes workspace-scoped repositories."""
    
    @property
    def node(self) -> PostgresNodeRepository: ...
    
    @property
    def props(self) -> PostgresPropertyRepository: ...
    
    @property
    def link(self) -> PostgresLinkRepository: ...
```

All three share the same connection pool, workspace ID, and user ID.

---

## User Data Model

```typescript
// Frontend
interface User {
  id: number;
  uuid: string;
  username: string;
  is_active: boolean;
}
```

```python
# Backend (Pydantic)
class User(UserBase):
    id: int
    created_at: datetime
    is_active: bool = True

class UserCreate(UserBase):
    password: str
    # username: 3-50 chars, [a-zA-Z0-9_] only
    # password: 8-128 chars
```

---

## User File System Layout

```
data/
└── users/
    └── {user_id}/
        ├── databases/     ← workspace databases (legacy)
        ├── export/        ← exported workspace JSON files
        └── backups/       ← backup storage
```

---

## Security Summary

| Aspect | Implementation |
|--------|---------------|
| Password storage | pbkdf2_sha256 salted hash |
| Token format | JWT HS256, 24-hour expiry |
| Rate limiting | slowapi — 3/min register, 5/min login |
| User enumeration | Generic error messages |
| Token revocation | None (expires naturally) |
| User cache | In-memory, 5-minute TTL |
| Workspace isolation | All repos scoped by `workspace_id` |
| CORS | Configurable via `CORS_ORIGINS` env var |
| Secret key | Required ≥32 chars at startup |
| Soft delete | Users can be deactivated (not deleted) |

---

## Error Handling

| Error | HTTP Status |
|-------|------------|
| Invalid credentials | 401 |
| Inactive user | 401 |
| Expired/invalid token | 401 |
| Duplicate username | 400 |
| Workspace not found | 404 |
| Duplicate workspace name | 409 |
| Server error | 500 |
