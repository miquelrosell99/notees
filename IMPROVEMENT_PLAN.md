# Notees Improvement Plan

This document outlines a phased approach to addressing all issues identified in the codebase audit. Issues are organized by priority and grouped into actionable phases.

---

## Phase 1: Critical Security Fixes (Week 1) ✅ COMPLETED

**Goal:** Eliminate critical security vulnerabilities that could lead to unauthorized access.

**Implementation Date:** January 29, 2026

**Summary of Changes:**
All Phase 1 security fixes have been successfully implemented:

1. **Secret Key Validation** - Added Pydantic validator requiring minimum 32-character SECRET_KEY
2. **Secure Admin Credentials** - Random password generation with ADMIN_PASSWORD env var option
3. **CORS Configuration** - Empty default with wildcard warning, proper middleware setup
4. **Removed Sensitive Logging** - Eliminated password hash and stack trace logging
5. **Asset Token System** - Short-lived (5-min) asset-specific tokens instead of JWT in URLs

**Files Modified:**
- `app/config.py` - Secret key and CORS validation
- `app/auth.py` - Secure admin password, removed sensitive logging
- `app/main.py` - CORS middleware configuration
- `app/routers/assets.py` - Asset token endpoints and authentication
- `frontend/src/api/assetTokens.ts` - New token management (created)
- `frontend/src/api/assets.ts` - Updated to support asset tokens
- `.env.example` - Comprehensive security documentation
- `README.md` - Security configuration section
- `scripts/generate_secret_key.py` - Helper script (created)

**Backward Compatibility:**
- Asset URLs now use Authorization headers by default (secure)
- Old `token` query parameter still supported during migration
- Frontend code remains synchronous via Authorization header auth

### 1.1 Remove Hardcoded Secret Key Default ✅

**File:** `app/config.py`

**Current:**
```python
secret_key: str = "notees-secret-key-change-in-production"
```

**Change to:**
```python
secret_key: str = ""  # Required - must be set via SECRET_KEY env var

@field_validator('secret_key', mode='after')
@classmethod
def validate_secret_key(cls, v):
    """Ensure secret key is set and not the insecure default."""
    if not v or v == "notees-secret-key-change-in-production":
        raise ValueError(
            "SECRET_KEY environment variable must be set to a secure random value. "
            "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(32))\""
        )
    if len(v) < 32:
        raise ValueError("SECRET_KEY must be at least 32 characters long")
    return v
```

**Verification:** App should fail to start without `SECRET_KEY` set.

---

### 1.2 Secure Default Admin Credentials

**File:** `app/auth.py`

**Current:**
```python
async def ensure_admin_user():
    existing = await get_user_by_username("admin")
    if not existing:
        logger.info("Creating default admin user...")
        await create_user("admin", "admin")
```

**Change to:**
```python
import os
import secrets

async def ensure_admin_user():
    """Ensure an admin user exists with secure credentials."""
    existing = await get_user_by_username("admin")
    if existing:
        return
    
    # Check for admin password in environment
    admin_password = os.environ.get("ADMIN_PASSWORD")
    
    if admin_password:
        await create_user("admin", admin_password)
        logger.info("Created admin user with password from ADMIN_PASSWORD env var")
    else:
        # Generate secure random password
        generated_password = secrets.token_urlsafe(16)
        await create_user("admin", generated_password)
        logger.warning("=" * 60)
        logger.warning("ADMIN USER CREATED WITH GENERATED PASSWORD")
        logger.warning(f"Username: admin")
        logger.warning(f"Password: {generated_password}")
        logger.warning("SAVE THIS PASSWORD - IT WILL NOT BE SHOWN AGAIN")
        logger.warning("Set ADMIN_PASSWORD env var to use a specific password")
        logger.warning("=" * 60)
```

**Verification:** On fresh start, random password should be logged once.

---

### 1.3 Fix CORS Default Configuration

**File:** `app/config.py`

**Current:**
```python
cors_origins: Union[list[str], str] = ["*"]
```

**Change to:**
```python
cors_origins: Union[list[str], str] = []  # Must be explicitly configured

@field_validator('cors_origins', mode='after')
@classmethod
def warn_cors_wildcard(cls, v):
    """Warn if using wildcard CORS in production."""
    if "*" in v:
        import warnings
        warnings.warn(
            "CORS is configured with wildcard '*'. This is insecure for production. "
            "Set CORS_ORIGINS to specific allowed origins.",
            SecurityWarning
        )
    return v
```

**Add to `app/main.py`:**
```python
from fastapi.middleware.cors import CORSMiddleware

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
```

---

### 1.4 Remove Sensitive Hash Logging

**File:** `app/auth.py`

**Remove these lines from `verify_password`:**
```python
logger.error(f"Stack trace: {''.join(traceback.format_stack()[-4:-1])}")
logger.error(f"Hash type: {hashed[:15] if hashed else 'EMPTY'}")
```

**Replace with:**
```python
logger.error(f"Password verification failed for technical reasons")
```

---

### 1.5 Fix JWT Token in Asset URLs

**File:** `frontend/src/api/assets.ts`

**Current:**
```typescript
export function getAssetUrl(uuid: string): string {
  const token = localStorage.getItem('token');
  if (token) {
    return `/api/assets/${uuid}?token=${encodeURIComponent(token)}`;
  }
  return `/api/assets/${uuid}`;
}
```

**Change to (short-lived asset token approach):**

**New file:** `frontend/src/api/assetTokens.ts`
```typescript
import api from './client';

interface AssetToken {
  token: string;
  expires_at: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getAssetToken(assetUuid: string): Promise<string> {
  const cached = tokenCache.get(assetUuid);
  const now = Date.now();
  
  // Return cached token if valid for at least 30 more seconds
  if (cached && cached.expiresAt > now + 30000) {
    return cached.token;
  }
  
  // Request new short-lived token
  const response = await api.post<AssetToken>(`/assets/${assetUuid}/token`);
  const expiresAt = new Date(response.data.expires_at).getTime();
  
  tokenCache.set(assetUuid, { token: response.data.token, expiresAt });
  return response.data.token;
}

export function getAssetUrlSync(uuid: string, assetToken?: string): string {
  if (assetToken) {
    return `/api/assets/${uuid}?asset_token=${encodeURIComponent(assetToken)}`;
  }
  return `/api/assets/${uuid}`;
}
```

**Backend:** Add endpoint to generate short-lived asset tokens (5-minute expiry).

---

## Phase 2: High Priority Fixes (Week 2) ✅ COMPLETED

**Goal:** Address high-severity issues affecting security, performance, and type safety.

**Implementation Date:** January 29, 2026

**Summary of Changes:**
All Phase 2 improvements have been successfully implemented:

1. **Rate Limiting** - Added slowapi with 5/min login and 3/min registration limits
2. **TypeScript Types** - Task N/A (generate_types.py doesn't exist)
3. **Icon Imports** - Task N/A (wildcard imports are justified for icons enumeration)
4. **React Keys** - Fixed index-based keys in BlockContent and CalendarPopup
5. **Type Assertions** - Replaced `as any` with proper isAxiosError and type guard functions
6. **Modal Focus Trap** - Integrated useFocusTrap hook with ARIA attributes
7. **SQL Column Validation** - Task N/A (already safe with explicit parameters)

**Files Modified:**
- `requirements.txt` - Added slowapi dependency
- `app/main.py` - Rate limiter setup
- `app/routers/auth.py` - Rate limits on login/register endpoints
- `frontend/src/components/blocks/BlockContent.tsx` - Stable keys
- `frontend/src/components/core/CalendarPopup.tsx` - Stable keys
- `frontend/src/hooks/useNodeQueries.ts` - Type guards with isAxiosError
- `frontend/src/lib/systemQueryAutoFix.ts` - Type guard functions
- `frontend/src/components/core/Modal.tsx` - Focus trap integration
- `frontend/src/constants/icons.ts` - Centralized icon exports (created)

### 2.1 Add Rate Limiting to Authentication ✅

**File:** `requirements.txt` - Add:
```
slowapi>=0.1.9
```

**File:** `app/main.py`
```python
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
```

**File:** `app/routers/auth.py`
```python
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)

@router.post("/login")
@limiter.limit("5/minute")  # 5 attempts per minute per IP
async def login(request: Request, credentials: UserLogin):
    ...

@router.post("/register")
@limiter.limit("3/minute")  # 3 registrations per minute per IP
async def register(request: Request, user_data: UserCreate):
    ...
```

---

### 2.2 Fix Auto-Generated TypeScript Types

**File:** `scripts/generate_types.py`

Update the type mapping to generate proper types instead of `any`:

```python
PYTHON_TO_TS_TYPES = {
    'str': 'string',
    'int': 'number',
    'float': 'number',
    'bool': 'boolean',
    'None': 'null',
    'Any': 'unknown',  # Change from 'any' to 'unknown'
    'List': 'Array',
    'Dict': 'Record',
    'Optional': '',  # Handle separately with | null
    'UUID': 'string',
    'datetime': 'string',
    'date': 'string',
}

def convert_type(python_type: str) -> str:
    """Convert Python type annotation to TypeScript."""
    # Handle Optional[X] -> X | null
    if python_type.startswith('Optional['):
        inner = python_type[9:-1]
        return f'{convert_type(inner)} | null'
    
    # Handle Union types
    if python_type.startswith('Union['):
        inner = python_type[6:-1]
        parts = [convert_type(p.strip()) for p in inner.split(',')]
        return ' | '.join(parts)
    
    return PYTHON_TO_TS_TYPES.get(python_type, python_type)
```

Run: `python scripts/generate_types.py`

---

### 2.3 Fix Icon Library Imports

**Files to update:** All files importing `@mdi/js`

**Search for:**
```typescript
import * as mdiIcons from '@mdi/js';
```

**Replace with named imports only for icons used:**
```typescript
import { 
  mdiClose, 
  mdiCheck, 
  mdiPlus,
  // ... only the icons actually used
} from '@mdi/js';
```

**Create icon index file:** `frontend/src/constants/icons.ts`
```typescript
// Centralized icon exports to avoid importing entire @mdi/js
export {
  mdiClose,
  mdiCheck,
  mdiPlus,
  mdiPencil,
  mdiDelete,
  mdiChevronRight,
  mdiChevronDown,
  // Add all icons used in the app
} from '@mdi/js';
```

---

### 2.4 Fix Index-Based React Keys

**File:** `frontend/src/components/blocks/BlockContent.tsx`

```tsx
// Before
{parts.map((part, index) => (
  <span key={index}>{part.content}</span>
))}

// After - generate stable keys
{parts.map((part, index) => {
  const key = `${part.type}-${part.content?.slice(0, 20) || ''}-${index}`;
  return <span key={key}>{part.content}</span>;
})}
```

**File:** `frontend/src/components/core/CalendarPopup.tsx`
```tsx
// Before
<div key={index} className="calendar-day-cell">

// After
<div key={`day-${day.toISOString()}`} className="calendar-day-cell">
```

---

### 2.5 Fix Type Assertions with Proper Type Guards

**File:** `frontend/src/hooks/useNodeQueries.ts`

```typescript
import { isAxiosError } from 'axios';

// Before
if ((error as any)?.response?.status === 404)

// After
if (isAxiosError(error) && error.response?.status === 404)
```

**File:** `frontend/src/lib/systemQueryAutoFix.ts`

Create proper interfaces:
```typescript
interface PropertyCondition {
  type: 'property';
  target_uuid?: string;
  property_name: string;
  value: unknown;
}

interface TypeCondition {
  type: 'has_type';
  type_uuid: string;
}

type QueryCondition = PropertyCondition | TypeCondition | { type: string };

function isPropertyCondition(condition: QueryCondition): condition is PropertyCondition {
  return condition.type === 'property';
}

function isTypeCondition(condition: QueryCondition): condition is TypeCondition {
  return condition.type === 'has_type';
}

// Usage
if (isPropertyCondition(child) && child.target_uuid === context.nodeUuid) {
  // ...
}
```

---

### 2.6 Add Focus Trap to Modal

**File:** `frontend/src/components/core/Modal.tsx`

```tsx
import { useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export function Modal({ isOpen, onClose, children, ...props }: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  useFocusTrap(containerRef, {
    enabled: isOpen,
    onEscape: onClose,
  });

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div 
        ref={containerRef}
        className="modal-container"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}
```

---

### 2.7 Whitelist SQL Column Names

**File:** `app/domain/repositories/postgres_property.py`

```python
ALLOWED_PROPERTY_COLUMNS = frozenset({
    'name', 'property_type', 'description', 'default_value',
    'is_required', 'is_unique', 'sequence', 'active'
})

async def update_property(self, property_id: int, updates: dict) -> Optional[Property]:
    # Validate column names
    invalid_cols = set(updates.keys()) - ALLOWED_PROPERTY_COLUMNS
    if invalid_cols:
        raise ValueError(f"Invalid column names: {invalid_cols}")
    
    # Now safe to build query
    set_clauses = [f"{col} = ${i+1}" for i, col in enumerate(updates.keys())]
    ...
```

---

## Phase 3: Medium Priority Improvements (Weeks 3-4)

**Goal:** Improve testing, error handling, and developer experience.

### 3.1 Add Frontend Testing Framework

**File:** `frontend/package.json` - Add to devDependencies:
```json
{
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/user-event": "^14.0.0",
    "vitest": "^2.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "jsdom": "^25.0.0",
    "msw": "^2.0.0"
  },
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```

**File:** `frontend/vite.config.ts` - Add test configuration:
```typescript
export default defineConfig({
  // ... existing config
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: ['node_modules/', 'src/test/', '**/*.d.ts'],
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50,
      },
    },
  },
});
```

**File:** `frontend/src/test/setup.ts`
```typescript
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
```

**Example test file:** `frontend/src/components/core/Button.test.tsx`
```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    
    await userEvent.click(screen.getByText('Click'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByText('Disabled')).toBeDisabled();
  });
});
```

---

### 3.2 Replace console.* with Proper Logging

Create a wrapper that can be disabled in production:

**File:** `frontend/src/utils/logger.ts` - Ensure it supports log levels:
```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = import.meta.env.PROD ? 'warn' : 'debug';

export function getLogger(name: string) {
  return {
    debug: (...args: unknown[]) => log('debug', name, ...args),
    info: (...args: unknown[]) => log('info', name, ...args),
    warn: (...args: unknown[]) => log('warn', name, ...args),
    error: (...args: unknown[]) => log('error', name, ...args),
  };
}

function log(level: LogLevel, name: string, ...args: unknown[]) {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;
  
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${name}]`;
  
  console[level](prefix, ...args);
}
```

**Migration script:** Find and replace all `console.log`, `console.error`, `console.warn`:
```bash
# Find all console.* usages
grep -r "console\.\(log\|error\|warn\)" frontend/src --include="*.ts" --include="*.tsx"
```

---

### 3.3 Add Input Validation to User Registration

**File:** `app/routers/auth.py`

```python
from pydantic import BaseModel, field_validator
import re

class UserCreate(BaseModel):
    username: str
    password: str
    
    @field_validator('username')
    @classmethod
    def validate_username(cls, v):
        if len(v) < 3:
            raise ValueError('Username must be at least 3 characters')
        if len(v) > 50:
            raise ValueError('Username must be at most 50 characters')
        if not re.match(r'^[a-zA-Z0-9_]+$', v):
            raise ValueError('Username can only contain letters, numbers, and underscores')
        return v
    
    @field_validator('password')
    @classmethod
    def validate_password(cls, v):
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters')
        if len(v) > 128:
            raise ValueError('Password must be at most 128 characters')
        # Optional: Add complexity requirements
        # if not re.search(r'[A-Z]', v):
        #     raise ValueError('Password must contain at least one uppercase letter')
        # if not re.search(r'[0-9]', v):
        #     raise ValueError('Password must contain at least one number')
        return v
```

---

### 3.4 Add Pagination to List Endpoints

**File:** `app/routers/nodes/list.py`

```python
from pydantic import BaseModel
from typing import Generic, TypeVar, List

T = TypeVar('T')

class PaginatedResponse(BaseModel, Generic[T]):
    items: List[T]
    total: int
    page: int
    page_size: int
    has_next: bool
    has_prev: bool

@router.get("/nodes", response_model=PaginatedResponse[Node])
async def list_nodes(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=200, description="Items per page"),
    # ... other params
):
    offset = (page - 1) * page_size
    
    nodes, total = await service.list_nodes(
        limit=page_size,
        offset=offset,
        return_total=True,
    )
    
    return PaginatedResponse(
        items=nodes,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )
```

---

### 3.5 Fix Broken Test Fixtures

**File:** `tests/conftest.py` - Ensure all needed fixtures exist:

```python
@pytest.fixture
async def node_service(db_pool, test_graph):
    """Provide a NodeService for tests."""
    from app.domain.services.node_service import NodeService
    service = NodeService(db_pool, test_graph.id)
    return service

@pytest.fixture
async def authenticated_client(client, test_user):
    """Provide an authenticated test client."""
    from app import auth
    token = auth.create_token(str(test_user.id), test_user.username)
    client.headers["Authorization"] = f"Bearer {token}"
    return client
```

**File:** `tests/test_phase1_features.py` - Remove skip or fix:
```python
# Remove this line if tests are ready:
# pytestmark = pytest.mark.skip(reason="Phase 1 tests need fixtures")

# Or update to use correct fixtures
```

---

### 3.6 Add Error Boundaries to Dynamic Content

**File:** `frontend/src/components/blocks/Block.tsx`

```tsx
import { BlockErrorBoundary } from './BlockErrorBoundary';

// Wrap child blocks in error boundary
{children?.map((child) => (
  <BlockErrorBoundary key={child.uuid} blockId={child.uuid}>
    <Block 
      block={child}
      depth={depth + 1}
      // ... other props
    />
  </BlockErrorBoundary>
))}
```

**File:** `frontend/src/components/blocks/BlockErrorBoundary.tsx`
```tsx
import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  blockId: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class BlockErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`Block ${this.props.blockId} error:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="block-error">
          <span>⚠️ Error rendering block</span>
          <button onClick={() => this.setState({ hasError: false })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

---

### 3.7 Add Missing aria-labels

**Audit and fix all icon-only buttons:**

```tsx
// Before
<button onClick={onDelete}>
  <Icon path={mdiDelete} />
</button>

// After
<button onClick={onDelete} aria-label="Delete item">
  <Icon path={mdiDelete} />
</button>
```

**Create lint rule:** `frontend/eslint.config.js`
```javascript
// Add jsx-a11y plugin rules
{
  rules: {
    'jsx-a11y/click-events-have-key-events': 'warn',
    'jsx-a11y/no-noninteractive-element-interactions': 'warn',
    'jsx-a11y/anchor-is-valid': 'warn',
  }
}
```

---

### 3.8 Integrate Virtualization for Large Lists

**File:** `frontend/src/components/nodes/views/NodeListView.tsx`

```tsx
import { useVirtualizedNodes } from '../../../hooks/useVirtualizedNodes';

export function NodeListView({ nodes, ...props }: NodeListViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { virtualItems, totalHeight, scrollOffset } = useVirtualizedNodes({
    items: nodes,
    containerRef,
    itemHeight: 40, // Approximate row height
    overscan: 5,
  });

  return (
    <div ref={containerRef} className="node-list-view" style={{ overflow: 'auto' }}>
      <div style={{ height: totalHeight, position: 'relative' }}>
        {virtualItems.map((virtualItem) => (
          <div
            key={virtualItem.item.uuid}
            style={{
              position: 'absolute',
              top: virtualItem.start,
              height: virtualItem.size,
              width: '100%',
            }}
          >
            <NodeListItem node={virtualItem.item} {...props} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Phase 4: Code Quality & Maintenance (Weeks 5-6)

**Goal:** Improve code organization, remove dead code, and establish better patterns.

### 4.1 Remove Sync Endpoint Stub

**File:** `app/routers/sync.py`

Either implement or remove entirely:

```python
# Option A: Remove the file and router registration
# Delete app/routers/sync.py
# Remove from app/main.py: from .routers import sync_router

# Option B: Add proper "not implemented" response with timeline
@router.post("/sync")
async def sync(request: SyncRequest, user: User = Depends(get_current_user)):
    """
    Sync endpoint - Coming soon.
    
    For now, use the export/import endpoints for data transfer.
    """
    raise HTTPException(
        status_code=501,
        detail={
            "message": "Sync is planned for v2.1",
            "alternative": "Use /api/export and /api/import for data transfer",
            "docs": "/docs#/export"
        }
    )
```

---

### 4.2 Split Large Component Files

**File:** `frontend/src/components/blocks/Block.tsx` (~1500 lines)

Split into:
```
frontend/src/components/blocks/
├── Block.tsx                    # Main component (~200 lines)
├── BlockContent.tsx             # Content rendering
├── BlockControls.tsx            # Action buttons, drag handle
├── BlockHeader.tsx              # Bullet, checkbox, collapse
├── BlockIndent.tsx              # Indentation logic
├── BlockSelection.tsx           # Selection highlighting
├── hooks/
│   ├── useBlockState.ts         # State management
│   ├── useBlockDrag.ts          # Drag & drop
│   ├── useBlockKeyboard.ts      # Keyboard shortcuts
│   └── useBlockFocus.ts         # Focus management
└── index.ts                     # Re-exports
```

---

### 4.3 Centralize Token Access

**File:** `frontend/src/utils/auth.ts`

```typescript
const TOKEN_KEY = 'token';

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getAuthToken();
}
```

Update all usages:
```typescript
// Before
const token = localStorage.getItem('token');

// After
import { getAuthToken } from '@/utils/auth';
const token = getAuthToken();
```

---

### 4.4 Add pytest-cov and Coverage Threshold

**File:** `requirements.txt` - Add:
```
pytest-cov>=4.0.0
pytest-timeout>=2.2.0
```

**File:** `pytest.ini`
```ini
[pytest]
asyncio_mode = auto
testpaths = tests
python_files = test_*.py
python_functions = test_*
addopts = -v --tb=short --cov=app --cov-report=term-missing --cov-report=html --cov-fail-under=50
timeout = 60
filterwarnings =
    error
    ignore::DeprecationWarning:pytest_asyncio
markers =
    slow: marks tests as slow (deselect with '-m "not slow"')
    integration: marks integration tests
```

---

### 4.5 Fix N+1 Query in Breadcrumbs

**File:** `app/domain/repositories/postgres_node.py`

```python
async def get_breadcrumbs(self, node_id: int) -> List[Node]:
    """Get all ancestors of a node efficiently."""
    async with self._pool.acquire() as conn:
        # Use recursive CTE to get all ancestors in one query
        rows = await conn.fetch(
            """
            WITH RECURSIVE ancestors AS (
                SELECT id, uuid, name, parent_id, 0 as depth
                FROM node
                WHERE id = $1 AND graph_id = $2
                
                UNION ALL
                
                SELECT n.id, n.uuid, n.name, n.parent_id, a.depth + 1
                FROM node n
                JOIN ancestors a ON n.id = a.parent_id
                WHERE n.graph_id = $2
            )
            SELECT * FROM ancestors
            WHERE id != $1
            ORDER BY depth DESC
            """,
            node_id, self._graph_id
        )
        return [self._row_to_node(row) for row in rows]
```

---

### 4.6 Implement or Remove Backup Scheduler

**File:** `app/backup.py`

```python
import subprocess
import asyncio
from pathlib import Path
from datetime import datetime

class BackupScheduler:
    """PostgreSQL backup scheduler using pg_dump."""
    
    def __init__(self, interval_seconds: int = 3600, max_backups: int = 50):
        self.interval = interval_seconds
        self.max_backups = max_backups
        self.backup_dir = Path("data/backups")
        self.running = False
    
    async def start(self):
        """Start the backup scheduler."""
        self.running = True
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        asyncio.create_task(self._backup_loop())
        logger.info(f"Backup scheduler started (interval: {self.interval}s)")
    
    async def _backup_loop(self):
        while self.running:
            try:
                await self._create_backup()
                await self._cleanup_old_backups()
            except Exception as e:
                logger.error(f"Backup failed: {e}")
            
            await asyncio.sleep(self.interval)
    
    async def _create_backup(self):
        """Create a PostgreSQL backup using pg_dump."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = self.backup_dir / f"notees_backup_{timestamp}.sql"
        
        # Get database URL from settings
        db_url = settings.database_url
        
        process = await asyncio.create_subprocess_exec(
            "pg_dump",
            db_url,
            "--file", str(backup_file),
            "--format", "custom",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        
        stdout, stderr = await process.communicate()
        
        if process.returncode != 0:
            raise RuntimeError(f"pg_dump failed: {stderr.decode()}")
        
        logger.info(f"Backup created: {backup_file}")
    
    async def _cleanup_old_backups(self):
        """Remove old backups exceeding max_backups."""
        backups = sorted(self.backup_dir.glob("notees_backup_*.sql"))
        
        while len(backups) > self.max_backups:
            oldest = backups.pop(0)
            oldest.unlink()
            logger.info(f"Removed old backup: {oldest}")
```

---

### 4.7 Track TODOs with GitHub Issues

Create GitHub issues for each TODO comment:

| TODO Location | Issue Title | Priority |
|---------------|-------------|----------|
| `crud.py:56` | Add user_id from JWT to node creation | Medium |
| `node_service.py:296` | Implement property value setting from ClassProperty defaults | Low |
| `node_service.py:772` | Implement proper cleanup of class/tag references | Medium |
| `node_service.py:918` | Set property values based on class | Low |
| `DatabaseManagementView.tsx` | Implement database modal components | Low |
| `PropertiesSection.tsx:231` | Navigate to node by UUID | Low |
| `PropertyConfigPanel.tsx:91` | Add description field to Property type | Low |

Then update TODO comments to reference issues:
```python
# TODO(#123): user_id from JWT
```

---

## Phase 5: Polish & Documentation (Week 7+)

**Goal:** Final improvements to accessibility, performance, and documentation.

### 5.1 Add prefers-reduced-motion Support

**File:** `frontend/src/index.css`

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

### 5.2 Add Skip Navigation Link

**File:** `frontend/src/App.tsx`

```tsx
function App() {
  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Header />
      <main id="main-content">
        {/* ... */}
      </main>
    </>
  );
}
```

**File:** `frontend/src/App.css`
```css
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: var(--color-primary);
  color: white;
  padding: 8px 16px;
  z-index: 9999;
  transition: top 0.2s;
}

.skip-link:focus {
  top: 0;
}
```

---

### 5.3 Document Environment Variables

**File:** `.env.example`

```bash
# ===========================================
# Notees Configuration
# ===========================================

# REQUIRED - Security
# Generate with: python -c "import secrets; print(secrets.token_urlsafe(32))"
SECRET_KEY=your-secure-secret-key-here

# Optional - Admin user (if not set, random password is generated on first run)
ADMIN_PASSWORD=

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/notees

# CORS - Comma-separated list of allowed origins
# Leave empty to disable CORS, use "*" only for development
CORS_ORIGINS=http://localhost:5173,https://your-domain.com

# Server
HOST=0.0.0.0
PORT=8000

# Logging
LOG_LEVEL=INFO
LOG_FILE=logs/notees.log

# Backup
BACKUP_INTERVAL_SECONDS=3600
MAX_BACKUPS=50
```

---

### 5.4 Update README with Security Best Practices

**File:** `README.md` - Add section:

```markdown
## Security Configuration

### Required Environment Variables

Before running in production, you MUST configure:

1. **SECRET_KEY** - A secure random string for JWT signing
   ```bash
   # Generate a secure key:
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

2. **ADMIN_PASSWORD** - Initial admin password (optional)
   - If not set, a random password is generated and logged on first startup
   - Change this password immediately after first login

3. **CORS_ORIGINS** - Allowed frontend origins
   - Never use `*` in production
   - Example: `CORS_ORIGINS=https://your-domain.com`

### Security Checklist

- [ ] Set strong `SECRET_KEY` (minimum 32 characters)
- [ ] Set or note the admin password
- [ ] Configure specific `CORS_ORIGINS`
- [ ] Enable HTTPS in production
- [ ] Set up database backups
- [ ] Review rate limiting settings
```

---

## Progress Tracking

### Phase 1: Critical Security ✅ COMPLETED
- [x] 1.1 Remove hardcoded secret key
- [x] 1.2 Secure admin credentials
- [x] 1.3 Fix CORS default
- [x] 1.4 Remove hash logging
- [x] 1.5 Fix JWT in asset URLs

### Phase 2: High Priority ✅ COMPLETED
- [x] 2.1 Add rate limiting
- [x] 2.2 Fix generated TypeScript types (N/A - file doesn't exist)
- [x] 2.3 Fix icon imports (N/A - justified wildcard imports)
- [x] 2.4 Fix React keys
- [x] 2.5 Fix type assertions
- [x] 2.6 Add focus trap to modal
- [x] 2.7 Whitelist SQL columns (N/A - already safe)

### Phase 3: Medium Priority ⏳
- [ ] 3.1 Add frontend testing
- [ ] 3.2 Replace console.* calls
- [ ] 3.3 Add input validation
- [ ] 3.4 Add pagination
- [ ] 3.5 Fix test fixtures
- [ ] 3.6 Add error boundaries
- [ ] 3.7 Add aria-labels
- [ ] 3.8 Add virtualization

### Phase 4: Code Quality ⏳
- [ ] 4.1 Remove sync stub
- [ ] 4.2 Split large components
- [ ] 4.3 Centralize token access
- [ ] 4.4 Add test coverage
- [ ] 4.5 Fix N+1 queries
- [ ] 4.6 Implement backups
- [ ] 4.7 Track TODOs

### Phase 5: Polish ⏳
- [ ] 5.1 Add reduced-motion support
- [ ] 5.2 Add skip navigation
- [ ] 5.3 Document env vars
- [ ] 5.4 Update README

---

## Estimated Timeline

| Phase | Duration | Focus |
|-------|----------|-------|
| Phase 1 | Week 1 | Critical security fixes |
| Phase 2 | Week 2 | High priority issues |
| Phase 3 | Weeks 3-4 | Testing & error handling |
| Phase 4 | Weeks 5-6 | Code quality |
| Phase 5 | Week 7+ | Polish & documentation |

**Total estimated time:** 7-8 weeks for full implementation

---

## Notes

- Each phase can be done incrementally with individual PRs
- Phase 1 should be completed before any production deployment
- Phases 2-3 are essential for a stable production release
- Phases 4-5 can be done as time permits after initial release
