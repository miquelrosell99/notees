# AGENTS.md — Notees

This file contains project-specific context for AI coding agents. If you are reading this, you are expected to modify code in this repository. Read this file carefully before making changes.

---

## Project Overview

**Notees** is a self-hosted, privacy-first note-taking application with bidirectional linking, block-based editing, and offline support. The goal is to provide a powerful, user-owned alternative on par with tools like **Logseq, Obsidian, Notion, Roam Research, and Anytype**. It was developed with AI assistance and is licensed under AGPL-3.0.

Key features:
- **Bidirectional Linking**: Wiki-style `[[Page Name]]` links with automatic backlink tracking.
- **Block-Based Editor**: Outliner-style editing where every block is a referenceable node.
- **Daily Journals**: Built-in daily, monthly, and yearly journal pages.
- **Types & Properties**: Custom properties and classes for powerful filtering and organization.
- **Query-Driven Collections**: A QueryAST system compiles structured queries into PostgreSQL SQL at runtime.
- **Offline-First**: PWA with service worker caching; works without internet.
- **Multi-Database / Workspaces**: Separate knowledge bases per project or context.
- **Export**: Markdown, HTML, and PDF export.

---

## Agent Quick Reference

- **Architecture**: Backend uses strict hexagonal architecture. Domain services must only use repository interfaces, never FastAPI or asyncpg directly.
- **DB Connections**: Never call `pool.acquire()` directly. Use `app.db.connection.get_connection()` or `get_transaction()`.
- **Frontend Imports**: Always use path aliases (e.g., `@/components/core/Button`). Never use relative `../../../` paths. CSS is co-located with components.
- **Secret Key**: `SECRET_KEY` is mandatory (>= 32 chars). The app will not start without it.
- **Node Model**: Everything is a `node` (pages, blocks, tags, properties, journals). Differentiation is via boolean flags (`is_page`, `is_tag`, etc.).
- **Dev vs. Prod**: Dev PostgreSQL settings (`fsync=off`, etc.) in `compose.yaml` must never be used in production.
- **Docker-first**: Development and production are both Docker-based. Local venv setup is possible but not the supported path.

---

## Decision-Making & Planning

- **Multi-file changes**: If a task touches more than 2–3 files, spans both frontend and backend, or changes interfaces/schemas, use **plan mode** (`EnterPlanMode`) and get user approval before writing code.
- **Always verify**: After code changes, run the relevant linter/test suite before finishing.
  - Backend: `pytest tests/ -v` and `ruff check app/`
  - Frontend: `cd frontend && npm run lint` and `npm run typecheck`
- **Fix all test failures**: If tests fail after your changes — even failures that appear unrelated to your task — you must fix them before finishing. Do not leave the test suite broken.
- **Prefer minimal changes**: Do not refactor unrelated code. Follow the existing file's style, even if it differs slightly from the general guidelines.

---

The project has three main parts:
1. **Backend** (`app/`): FastAPI (Python 3.13+)
2. **Frontend** (`frontend/`): React 19 + TypeScript + Vite SPA
3. **Mobile** (`mobile/`): Android Kotlin wrapper app (WebView-based)

---

## Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Backend | FastAPI | 0.136.3 | REST API framework |
| Backend | Uvicorn | 0.48.0 | ASGI server |
| Backend | Pydantic | 2.13.4 | Data validation |
| Backend | pydantic-settings | 2.14.1 | `.env` configuration |
| Backend | PyJWT | 2.13.0 | JWT tokens (HS256) |
| Backend | passlib | 1.7.4 | Password hashing (pbkdf2_sha256) |
| Backend | asyncpg | 0.31.0 | Async PostgreSQL driver |
| Backend | slowapi | 0.1.9 | Rate limiting |
| Backend | WeasyPrint | 68.1 | PDF generation |
| Backend | Pillow | 12.2.0 | Image processing |
| Database | PostgreSQL | 17 | Primary persistent storage |
| Frontend | React | 19.2.6 | UI framework |
| Frontend | TypeScript | ~6.0.3 | Type safety |
| Frontend | Vite | 8.0.14 | Build tool & dev server |
| Frontend | Zustand | 5.0.13 | Client-side state management |
| Frontend | TanStack Query | 5.100.14 | Server-state caching |
| Frontend | Lexical | 0.44.0 | Rich-text block editor |
| Frontend | Axios | 1.16.1 | HTTP client |
| Frontend | @dnd-kit | latest | Drag & drop |
| Frontend | sql.js | 1.14.0 | In-browser SQLite (WASM) |
| Mobile | Kotlin + Android SDK | 36 (minSdk 26) | WebView wrapper app |
| Containerization | Docker + Docker Compose | — | Deployment |

---

## Project Structure

```
notees/
├── app/                          # Backend (FastAPI)
│   ├── main.py                   # FastAPI app factory, lifespan, middleware, routers
│   ├── config.py                 # Pydantic-settings configuration (.env support)
│   ├── auth.py                   # JWT auth, password hashing, user management
│   ├── models.py                 # Pydantic request/response schemas
│   ├── backup.py                 # Automatic backup scheduler (pg_dump)
│   ├── logging_config.py         # Structured logging setup
│   ├── node_export.py            # Export logic (Markdown, HTML, PDF)
│   ├── workspace_io.py           # Workspace import/export
│   ├── workspace_manager.py      # Workspace lifecycle management
│   ├── dependencies.py           # FastAPI dependency injection helpers
│   ├── db/                       # Database layer
│   │   ├── connection.py         # asyncpg pool + request-scoped connections
│   │   └── schema/               # Schema initialization, migrations, constants
│   │       ├── sql.py            # Raw DDL (~1250 lines)
│   │       ├── init.py           # Seeding + migration orchestration
│   │       └── constants.py      # System UUIDs, class definitions
│   ├── domain/                   # Hexagonal architecture: domain layer
│   │   ├── entities/             # Pure data models (Node, Link, Property, User, QueryAST)
│   │   ├── services/             # Business logic (NodeService, LinkService, QueryService, etc.)
│   │   ├── repositories/         # Repository interfaces + PostgreSQL implementations
│   │   ├── errors.py             # Domain exceptions
│   │   └── stringify_ast.py      # AST parser/serializer for block content
│   ├── routers/                  # FastAPI API endpoints
│   │   ├── auth.py
│   │   ├── workspaces.py
│   │   ├── assets.py
│   │   ├── export.py
│   │   ├── sync.py
│   │   ├── activity.py
│   │   ├── undo/
│   │   ├── nodes/                # Node CRUD, search, daily, links, comments, favorites, views
│   │   └── properties/           # Property CRUD, values, classes, selection lines
│   ├── infrastructure/           # Additional infra adapters (e.g., user repository)
│   ├── static/                   # Static assets + built frontend output (dist/)
│   └── utils/                    # Small utilities (datetime helpers)
│
├── frontend/                     # React SPA
│   ├── src/
│   │   ├── api/                  # Axios client + endpoint functions
│   │   ├── components/           # React components
│   │   │   ├── core/             # Domain-agnostic atoms (Button, Card, Modal, etc.)
│   │   │   ├── blocks/           # Block display components
│   │   │   ├── nodes/            # Node-level components (NodeCollection, PageHeader, etc.)
│   │   │   ├── properties/       # Property editors
│   │   │   ├── queries/          # Query builder UI
│   │   │   ├── layout/           # App shell (Layout, Sidebar, CommandPalette, TopBar)
│   │   │   ├── sidebar/          # Right sidebar cards
│   │   │   └── workspace/        # Workspace management modals
│   │   ├── editor/               # Lexical editor (BlockEditor, plugins, custom nodes)
│   │   ├── hooks/                # React hooks (data fetching, mutations, keyboard)
│   │   ├── stores/               # Zustand stores (auth, app, settings, undo, etc.)
│   │   ├── types/                # TypeScript type definitions
│   │   ├── utils/                # Utility functions (tree ops, date parsing, colors)
│   │   ├── views/                # Top-level view components (NodeView, JournalsView, etc.)
│   │   ├── workers/              # Web Workers (query, parser, command palette)
│   │   ├── runtime/              # Runtime systems (NodeGraphRuntime, ProjectionReconciler)
│   │   └── lib/                  # Core libraries (AST builder, query client, stringifyAST)
│   ├── package.json
│   ├── vite.config.ts            # Vite config with PWA plugin, proxy, path aliases
│   ├── tsconfig.app.json
│   ├── eslint.config.js
│   └── vitest.config.ts          # Vitest test runner config
│
├── mobile/                       # Android Kotlin app
│   ├── app/build.gradle.kts      # Android app module config
│   ├── app/src/main/java/...     # MainActivity, SetupActivity, ShareActivity, AndroidBridge
│   ├── build-apk.sh              # APK build script
│   └── Dockerfile                # Multi-stage Docker build for APK
│
├── tests/                        # Backend test suite
│   ├── conftest.py               # Shared pytest fixtures (DB pool, test user, HTTP client)
│   └── test_*.py                 # Test modules (16 files)
│
├── docs/                         # Architecture documentation (01-13)
├── scripts/                      # Utility scripts
│   ├── generate_secret_key.py    # Cryptographically secure SECRET_KEY generator
│   ├── check_extends.py          # Inspect class extension relationships
│   ├── run_migration.py          # Apply undo_log migration
│   └── reset_system_views.py     # Reset system views to default QueryAST
├── data/                         # User data, assets, backups (gitignored)
├── logs/                         # Application logs (gitignored)
├── compose.yaml                  # Docker Compose (development: backend + frontend + postgres)
├── Dockerfile                    # Production multi-stage build
├── Dockerfile.dev                # Development backend with hot-reload
├── requirements.txt              # Python dependencies
├── pyproject.toml                # Build system, Ruff, mypy config
├── pytest.ini                   # Pytest configuration
└── .env.example                  # Example environment variables
```

---

## Architecture

### Backend: Hexagonal (Ports & Adapters)

The backend follows a strict hexagonal architecture with three layers:

1. **Domain Layer** (`app/domain/`)
   - `entities/`: Pure dataclasses with no external dependencies.
   - `services/`: Business logic orchestrators. Services never import FastAPI or asyncpg directly; they use repository interfaces.
   - `repositories/interfaces.py`: Abstract ports (e.g., `NodeRepository`, `PropertyRepository`).
   - `errors.py`: Domain-specific exceptions.

2. **Infrastructure Layer** (`app/domain/repositories/`)
   - Concrete PostgreSQL implementations: `postgres_node.py`, `postgres_link.py`, `postgres_property.py`, `postgres_user.py`, etc.
   - These are the **only** files that execute SQL against asyncpg.

3. **API Layer** (`app/routers/`)
   - FastAPI routers that depend on domain services.
   - Request/response schemas are defined in `app/models.py` or `app/routers/*/models.py`.

**Key backend patterns:**
- **Request-scoped DB connections**: `app/db/connection.py` uses a `ContextVar` to share one pooled connection across all repository calls within a single HTTP request. This avoids pool contention.
- **Everything is a Node**: Pages, blocks, tags, classes, properties, journals, tasks, templates, comments, and assets are all `node` table rows differentiated by boolean flags (`is_page`, `is_tag`, `is_property`, `is_daily`, `is_task`, etc.).
- **Closure table**: `node_path` maintains transitive ancestor/descendant relationships for fast tree queries.
- **Link parsing**: `[[Page Name]]` and `((block-uuid))` references in content are parsed into explicit `node_link` records for efficient backlink queries.
- **QueryAST**: Structured queries compile to PostgreSQL SQL at runtime via `app/domain/services/query_ast_sql.py`.
- **Soft delete**: `is_deleted` + `deleted_at` columns; soft delete cascades to descendants via closure table.
- **Optimistic locking**: `version` column on `node`; `expected_version` parameter returns 409 Conflict on mismatch.

### Frontend: React SPA

- **Build tool**: Vite with PWA plugin (`vite-plugin-pwa`). The build outputs to `app/static/dist`.
- **State**: Zustand for client state (navigation, UI, auth, settings, undo); TanStack Query for server state and caching.
- **Editor**: Lexical with 28+ custom plugins for block editing, slash commands, drag-and-drop, tables, code blocks, etc.
- **Routing**: Client-side routing within the SPA. FastAPI serves `index.html` for all non-API routes (`spa_fallback`).
- **Path aliases**: `@/components`, `@/hooks`, `@/stores`, `@/api`, `@/editor`, `@/runtime`, `@/types`.
- **Optimistic UI**: Mutations update TanStack Query cache immediately and roll back on failure.
- **View modes**: `NodeCollection` dispatches to `ListView`, `DocumentView`, `CardView`, `TableView`, `GanttView`, `GraphView`, `TimelineView`, and `WhiteboardView`.
- **PWA**: Service worker auto-updates; precaches JS/CSS/HTML/ICO/PNG/SVG/WOFF2; network-first API caching; CacheFirst WASM caching; Web Share Target support.

### Mobile

The `mobile/` directory contains a minimal Android Kotlin app (API 26–36, minSdk 26) that wraps the frontend in a WebView. It provides:
- A server setup screen (`SetupActivity`).
- A native share receiver (`ShareActivity`).
- An `AndroidBridge` for native-to-web communication.
- Encrypted server URL storage via `EncryptedSharedPreferences`.
- Deep link support: `notees://note/42`.
- File chooser for uploads, custom User-Agent, back button handling.

---

## Build and Development Commands

### Prerequisites
- Docker & Docker Compose

### Full Stack (Docker Compose — Recommended)

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env and set SECRET_KEY and Postgres credentials

# Start backend, frontend, and PostgreSQL
docker compose up

# The frontend dev server runs on http://localhost:5173
# The backend API runs on http://localhost:8000
```

### Backend (local debugging only)

```bash
# Not the recommended path — use Docker Compose instead
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Development server with hot reload (port 5173)
npm run dev

# Type check
npm run typecheck   # tsc -b

# Production build (outputs to ../app/static/dist)
npm run build

# Preview production build
npm run preview

# Linting
npm run lint
```

### Full Stack (Docker Compose — Recommended for Development)

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env and set SECRET_KEY and Postgres credentials

# Start backend, frontend, and PostgreSQL
docker compose up

# The frontend dev server runs on http://localhost:5173
# The backend API runs on http://localhost:8000
```

### Production Docker Build

```bash
# Multi-stage build (builds frontend + backend image)
docker build -t notees .
```

### Production Docker Run

```bash
docker run -p 8000:8000 --env-file .env notees
```

### Mobile

```bash
cd mobile
./build-apk.sh
```
The debug keystore is checked into the repo intentionally (it is not a secret).

---

## Testing Strategy

### Backend Tests

Tests are in `tests/` and use **pytest** with async support.

```bash
# Run all tests
pytest tests/ -v

# Run without slow tests
pytest tests/ -v -m "not slow"

# Run with coverage (minimum 50%)
pytest tests/ --cov=app --cov-report=term-missing --cov-report=html
```

**Test configuration (`pytest.ini`):**
- `asyncio_mode = auto`
- Coverage target: `--cov-fail-under=50`
- Coverage reports to `htmlcov/`
- Markers: `slow`, `integration`

**Fixtures (`tests/conftest.py`):**
- `postgres_container`: Spins up a PostgreSQL 17-alpine container via **testcontainers** per session (requires Docker).
- `db_pool`: Initializes asyncpg pool, drops all tables, and re-creates schema before every test.
- `test_user`: Creates a unique test user + workspace and returns auth token.
- `client` / `authenticated_client`: `httpx.AsyncClient` against the FastAPI ASGI app.
- `node_repository`, `property_repository`, `link_repository`, `node_service`: Domain-layer fixtures wired to the test DB.

**Alternative test database:**
Set `TEST_DATABASE_URL` to use an external PostgreSQL instance instead of testcontainers.

### Frontend Tests

```bash
cd frontend

# Run Vitest
npm run test

# Run once (CI)
npm run test:run

# Coverage
npm run test:coverage
```

Tests use Vitest with `jsdom`, `@testing-library/react`, and `@testing-library/jest-dom`. Test files exist in `frontend/src/tests/`.

---

## Code Style Guidelines

### Python

- Follow **PEP 8**.
- Use **type hints** extensively; import `from __future__ import annotations` where needed.
- Use **async/await** for all I/O (asyncpg, FastAPI).
- Domain services use repository **interfaces**, never concrete DB drivers directly.
- Loggers are obtained via `app.logging_config.get_logger(__name__)`.
- String literals: double quotes for docstrings and user-facing strings; consistent style within files.
- Imports are grouped: stdlib, third-party, local (with relative imports inside `app/`).
- **Linting**: Ruff is configured in `pyproject.toml` (target py312, line-length 120, Google docstyle convention, select E/W/F/I/N/UP/B/C4/SIM).
- **Type checking**: mypy is configured in `pyproject.toml` (`disallow_untyped_defs = true`, `ignore_missing_imports = true`).

### TypeScript / React

- **Strict TypeScript** enabled (`tsconfig.app.json`):
  - `strict: true`
  - `noUnusedLocals: true`
  - `noUnusedParameters: true`
  - `verbatimModuleSyntax: true`
- Path aliases are mandatory; never use relative `../../../` paths.
- Component files use `.tsx`; utility files use `.ts`.
- CSS files are co-located with components (`.css`).
- Custom hooks live in `frontend/src/hooks/`.
- Zustand stores live in `frontend/src/stores/`.
- API calls are centralized in `frontend/src/api/`.

### Linting

- **Frontend**: ESLint (flat config) with `@eslint/js`, `typescript-eslint`, `react-hooks`, `react-refresh`, and `jsx-a11y`.
  ```bash
  cd frontend && npm run lint
  ```
- **Backend**: Ruff (configured in `pyproject.toml`).

---

## Configuration & Environment Variables

All configuration is centralized in `app/config.py` using **pydantic-settings**. Values are read from `.env` (or environment variables).

**Required:**
| Variable | Description |
|----------|-------------|
| `SECRET_KEY` | JWT signing key. **Must be >= 32 chars.** Generate with `python scripts/generate_secret_key.py` |
| `POSTGRES_PASSWORD` | PostgreSQL password. Used by both the database container and the app. |

**Docker:**
| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `1000` | Host user ID for file ownership on bind mounts |
| `PGID` | `1000` | Host group ID for file ownership on bind mounts |
| `TZ` | `UTC` | Container timezone |

**Important:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | (generated, not logged) | Initial admin password. If unset, a random password is generated on first startup. **The password is NOT shown in logs.** Set this env var to retrieve or change it. |
| `CORS_ORIGINS` | `[]` | Comma-separated allowed origins. Never use `*` in production |
| `ACCESS_TOKEN_EXPIRE_HOURS` | `24` | JWT token lifetime (code default). `.env.example` sets `168` for development convenience. |
| `LOG_LEVEL` | `INFO` | Logging verbosity |
| `BACKUP_INTERVAL_SECONDS` | `3600` | Automatic backup interval |
| `MAX_BACKUPS` | `50` | Max backup files to keep |
| `POSTGRES_POOL_MIN` | `5` | Connection pool minimum size |
| `POSTGRES_POOL_MAX` | `50` | Connection pool maximum size |

**PostgreSQL connection pool tuning:**
- `POSTGRES_POOL_MAX_INACTIVE_TIME` (default 300s)
- `POSTGRES_STATEMENT_CACHE_SIZE` (default 100)

See `.env.example` for the full template.

---

## Security Considerations

- **SECRET_KEY is mandatory** and validated at startup (min 32 chars). The app will refuse to start without it.
- **Password hashing**: Uses `pbkdf2_sha256` via passlib (bcrypt was avoided to eliminate backend length limits and compatibility issues).
- **JWT tokens**: Signed with HS256. Token lifetime defaults to 24 hours (configurable via `ACCESS_TOKEN_EXPIRE_HOURS`).
- **CORS**: Must be explicitly configured. Wildcard `*` triggers a warning and should never be used in production.
- **Rate limiting**: `slowapi` with remote-address keying is configured in `app/main.py`.
- **Request body size limit**: 55 MB maximum (to support the 50 MB asset upload cap plus multipart overhead).
- **User cache**: In-memory user cache with 5-minute TTL to avoid DB pool acquisition on every request.
- **Static asset caching**: Hashed JS/CSS chunks get long-term cache headers; everything else is `no-store`.
- **Cross-Origin headers**: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` are set on all responses to enable `SharedArrayBuffer` in the browser.
- **Admin user**: Auto-created on first startup if it does not exist. If `ADMIN_PASSWORD` is unset, a random password is generated. **The generated password is NOT logged.** Set `ADMIN_PASSWORD` env var to retrieve or change it.
- **Production Docker image**: Runs as non-root `appuser`.
- **Backup security**: `pg_dump`/`pg_restore` credentials are passed via environment variables (`PGPASSWORD`, `PGUSER`) rather than command-line arguments to prevent exposure via `ps`.

---

## Deployment

**Notees is deployed via Docker** for both development and production environments. There is no bare-metal or native deployment path; all runtime dependencies (Python, Node.js, PostgreSQL) are containerized.

### Docker Compose (Development)

The included `compose.yaml` brings up:
- `postgres`: PostgreSQL 17 (with `fsync=off`, `synchronous_commit=off`, `full_page_writes=off` for dev speed — **never use in production**)
- `backend`: FastAPI with hot-reload, mounted source volumes
- `frontend`: Vite dev server on port 5173, proxying `/api` to the backend

### Production Docker

`Dockerfile` is a multi-stage build:
1. **Stage 1**: `node:22-alpine` builds the frontend.
2. **Stage 2**: `python:3.13-slim` runs the backend with the built frontend copied into `app/static/dist`.

System dependencies in the production image include `libpango`, `libcairo2`, `fonts-liberation`, `libffi-dev`, and `libgdk-pixbuf` for WeasyPrint PDF generation. The container runs as non-root `appuser`, exposes port 8000, and has a healthcheck on `/api/auth/status`.

### Mobile

Build the Android APK with:
```bash
cd mobile
./build-apk.sh
```
The debug keystore is checked into the repo intentionally (it is not a secret).

---

## Development Conventions

### Data Model at a Glance

```
workspace
  └── node (pages, blocks, tags, properties, journals, tasks, templates, comments, assets)
        ├── node_path (closure table: transitive ancestor/descendant relationships)
        ├── node_link (parsed [[Page]] and ((block-uuid)) references for backlinks)
        ├── property (schema definitions + values)
        └── asset (files on disk under data/workspaces/{workspace_uuid}/assets/)
```

- **Everything is a Node**: One `node` table with boolean flags (`is_page`, `is_tag`, `is_property`, `is_daily`, `is_task`, `is_template`, `is_system`).
- **Closure Table**: `node_path` stores transitive parent/child relationships for fast tree queries and soft-delete cascading.
- **Links**: `node_link` is the source of truth for backlinks; it is populated by parsing the block content AST.
- **Workspace Isolation**: Every node, property, and asset belongs to exactly one workspace.

### Node Model
Everything in the system is a **Node**. Differentiation happens via boolean columns and tags:
- `is_page = true` → Page (can contain blocks and child pages)
- `is_page = false` → Block (content within a page)
- `is_tag = true` → Tag (also a page)
- `is_property = true` → Property schema (also a page)
- `is_daily = true` → Daily journal page
- `is_task = true` → Task item
- `is_template = true` → Template page
- `is_system = true` → System-generated node (e.g., system classes)

Pages use `name` as their title; blocks use `name` as a UUID. `display_name` is the human-readable label.

### Block Content AST
Block content is stored as a JSON AST (Abstract Syntax Tree). The domain module `app/domain/stringify_ast.py` handles parsing and serialization. The frontend uses `frontend/src/lib/stringifyAST.ts` and related utilities.

### Workspace Isolation
All user data is scoped to a **workspace**. Each user gets a default workspace on enrollment. Workspaces have their own node trees, properties, classes, and assets. Assets are stored on disk under `data/workspaces/{workspace_uuid}/assets/`.

### Request-Scoped Connections
Never call `pool.acquire()` directly in routers or services. Use:
- `app.db.connection.get_connection()` — for general DB access.
- `app.db.connection.get_transaction()` — for transactions.
- Repositories use `acquire_connection()` which transparently reuses the request-scoped connection when inside an HTTP request (set by middleware in `app/main.py`).

### Middleware Behavior
`app/main.py` adds two critical `http` middlewares:
1. **Request logging + DB connection wrapping**: API requests (`/api/*`) are wrapped in `request_connection()` so repos share one connection.
2. **Static asset caching vs. no-cache**: Hashed assets under `/assets/` are cached immutably; API responses and `index.html` are never cached.

### Adding a New API Endpoint
1. Define Pydantic schemas in `app/models.py` or `app/routers/<module>/models.py`.
2. Add domain logic to the appropriate service in `app/domain/services/`.
3. If needed, extend the repository interface in `app/domain/repositories/interfaces.py` and implement it in the Postgres repository.
4. Create/update the router in `app/routers/`.
5. Include the router in `app/main.py`.
6. Add tests in `tests/`.

### Frontend Conventions

- **Strict TypeScript**: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `verbatimModuleSyntax: true`.
- **Path Aliases**: Mandatory. Use `@/components`, `@/hooks`, `@/stores`, `@/api`, `@/editor`, `@/runtime`, `@/types`. Never use relative `../../../` paths.
- **CSS Co-location**: Each component has a `.css` file with the same base name in the same directory.
- **Component File Extensions**: `.tsx` for React components, `.ts` for utilities.
- **Import Boundaries**:
  - `core/` components are domain-agnostic atoms (Button, Card, Modal). They **must never** import domain components.
  - Domain-specific components (`blocks/`, `nodes/`, `properties/`, `queries/`) may import from `core/`, `api/`, `hooks/`, and `stores/`.
- **Custom Hooks**: Live in `frontend/src/hooks/`.
- **State**: Zustand for client state; TanStack Query for server state. Avoid direct fetch/XMLHttpRequest inside UI components.

### Frontend Data Flow Architecture

The frontend uses a **three-layer data model** with clear ownership:

```
Backend API ←→ TanStack Query (server state cache) ←→ NodeGraphRuntime (client graph) ←→ Lexical editors / UI
```

| Layer | Technology | Owns | Do NOT put here |
|-------|-----------|------|-----------------|
| **Server State** | TanStack Query | API responses, normalized entity cache, query keys | UI flags, ephemeral selection state, full Node objects that bypass the cache |
| **Client Runtime** | `NodeGraphRuntime` | In-memory graph of blocks, structural intents, undo stack, projections | API calls, authentication, navigation |
| **UI State** | Zustand stores | Navigation, modals, display preferences, keyboard shortcuts, clipboard | Server responses, query caches, full entity trees |

#### Store Boundaries (Zustand)

- **Zustand stores must hold only client/UI state.** Server data belongs in TanStack Query.
- Stores that currently violate this (migrate when touched):
  - `favoritesStore` — fetches favorites/recents manually instead of using `useQuery`.
  - `undoStore` — accepts `QueryClient` as a parameter, coupling store layer to TanStack Query internals.
  - `navigationStore` — `activeNode` stores a full `Node` object but is unused; components read `useNode(activeNodeId)` instead.
- Use selectors to subscribe to only the slice you need: `useNavigationStore(s => s.openNode)` not `useNavigationStore()`.
- Avoid imperative `useXStore.getState().action()` inside render paths; prefer the React hook subscription or use it only in event handlers.

#### Query Key Discipline

- **Always use factory functions** from `frontend/src/hooks/queryKeys.ts`. Never hardcode raw arrays like `['nodes', 'page-content']`.
- Prefix factories exist for cache-wide invalidation:
  ```ts
  // Invalidates ALL page-content queries regardless of node ID
  queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
  ```
- When adding a new query, add its key factory to `queryKeys.ts` first, then use it in the hook AND in every mutation that invalidates it.

#### Mutation Cache Invalidation

- Use the shared `invalidateNodeCaches()` helper from `useNodeMutations.ts` for common cases (lists, pages, search, graph, etc.).
- For tree mutations (create, update, delete, move), prefer **explicit cache iteration** over `setQueriesData` with partial key matching. The latter is unreliable for deeply nested block structures.
- Optimistic updates must provide `onError` rollback. Snapshot the previous cache value in `onMutate` before mutating.

#### API Layer Purity

- `frontend/src/api/` functions must be **thin transport wrappers** only: build the URL, call axios, return `response.data`.
- Do NOT put in the API layer:
  - DOM manipulation (creating anchor tags for downloads)
  - Data grouping/sorting/presentation logic
  - Auth state helpers (localStorage access belongs in `utils/auth.ts` or the auth store)
  - `Promise.all` orchestration of multiple unrelated endpoints (belongs in a mutation hook)
- File downloads should use a dedicated `utils/download.ts` helper that accepts a `Blob` and triggers the browser save.

#### Axios Client Configuration

- `frontend/src/api/client.ts` configures a single axios instance.
- It must have an explicit `timeout` (default 30s) to prevent hung requests.
- Global 401 handling, request/response logging, and auth token injection live in interceptors.

#### Barrel Files (Re-exports)

The frontend uses a **two-level barrel file** pattern to keep import paths clean:

1. **Top-level barrels** (`frontend/src/*/index.ts`) are the public API for each module.
   - Example: `frontend/src/hooks/index.ts` re-exports everything consumers should import from `@/hooks`.
   - Example: `frontend/src/components/core/index.ts` re-exports all core atoms.

2. **Domain-specific sub-barrels** aggregate related exports from deeper files.
   - Example: `frontend/src/hooks/useNodes.ts` is a sub-barrel that re-exports node queries, mutations, and activity hooks from `useNodeQueries.ts`, `useNodeMutations.ts`, etc.
   - `frontend/src/hooks/index.ts` then re-exports from `useNodes.ts` (and other sub-barrels) so consumers only need `@/hooks`.

**Rules:**
- Import from the **shallowest public barrel** that exposes the symbol. `@/hooks` is preferred over `@/hooks/useStringifyAST` unless you are inside the `hooks/` module itself.
- Do **not** use sub-barrels to re-export unrelated utilities. If a utility (e.g., `nodeNameToText`) lives in `useStringifyAST.ts`, it should be re-exported directly from `hooks/index.ts`, not routed through `useNodes.ts`.
- When adding a new hook or utility, update the appropriate `index.ts` so it is discoverable via path aliases.

#### Adding a New Frontend Component
1. Place React components in the appropriate subdirectory under `frontend/src/components/`.
2. Use path aliases (e.g., `@/components/core/Button`) for all imports.
3. Co-locate CSS in a `.css` file with the same base name.
4. Respect import boundaries: `core/` must not import domain components.
5. Register new routes/views in `frontend/src/views/` and wire them into `MainContent` / `appStore`.

---

## Common Pitfalls

- **Do not** use `pool.acquire()` directly in domain services or routers. Use `get_connection()` or `get_transaction()` from `app.db.connection`.
- **Do not** forget to set `SECRET_KEY` before running. The app will crash at startup with a clear validation error.
- **Do not** run the dev PostgreSQL settings (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`) in production. They are explicitly set only in `compose.yaml`.
- **Do not** assume `run_dev.py` or `run.py` exists at the project root. The actual entry points are `uvicorn app.main:app --reload` (backend) and `npm run dev` (frontend).
- When building the Docker image, the frontend build stage outputs to `./dist` inside the container and is copied to `app/static/dist` in the final stage.
- The frontend build uses `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers to enable `SharedArrayBuffer` (required for sql.js/WebAssembly features).
- The `README.md` is kept up to date with the current stack. For the canonical version list, check `pyproject.toml`, `package.json`, and the AGENTS.md Technology Stack table.

### TanStack Query v5: `onSuccess` / `onError` and Component Unmounting

In **TanStack Query v5**, `onSuccess`, `onError`, and `onSettled` callbacks defined on `useMutation` (or passed to `.mutate()`) are **only executed while the component that owns the hook is mounted**. If the component unmounts before the mutation finishes, those callbacks are silently dropped.

This is a breaking change from v4 and has caused multiple bugs where:
- Cache invalidation never runs after a delete/archive/unarchive
- Navigation away from a deleted page doesn't happen
- Zustand store updates (favorites, recents) are lost
- Modal/menu close callbacks are missed

**Most at-risk patterns:**
- Context menus that call `mutate()` then `onClose()` (e.g., `NodeContextMenu`, `TrashNodeContextMenu`, `ArchivedNodeContextMenu`)
- Confirmation modals that close immediately after `mutate()`
- Popovers or quick-add inputs that disappear on submit

**Safe patterns:**
1. **Move critical side effects into `onMutate`** — it runs synchronously when `mutate()` is called, before the component can unmount. Good for: optimistic Zustand updates, navigation, cache invalidation that doesn't need the server response.
2. **Use `mutateAsync()` + `await` in the event handler** — keeps the component mounted until the mutation completes. Only use this if the UX is acceptable (the menu/modal stays open during the API call).
3. **Global `MutationCache` callbacks** — register observers on the `QueryClient`'s `mutationCache` for side effects that must always run regardless of which component triggered the mutation.

**When adding or reviewing mutations, ask:**
- Is this mutation triggered from a modal, menu, or popover that will unmount?
- Does `onSuccess` do anything essential (navigation, store updates, cache invalidation)?
- If yes, move that work to `onMutate` or use a global observer.

### Dependency Updates

Keep dependencies reasonably current to avoid security issues and benefit from bug fixes. Check for outdated packages periodically:

```bash
# Backend
pip list --outdated

# Frontend
cd frontend && npm outdated
```

**Current versions vs. latest (as of 2026-05-25):**

| Package | Current | Latest | Notes |
|---------|---------|--------|-------|
| FastAPI | 0.136.3 | 0.136.3 | ✅ Up to date |
| Uvicorn | 0.48.0 | 0.48.0 | ✅ Up to date |
| Pydantic | 2.13.4 | 2.13.4 | ✅ Up to date |
| asyncpg | 0.31.0 | 0.31.0 | ✅ Up to date |
| WeasyPrint | 68.1 | 68.1 | ✅ Up to date |
| React | 19.2.6 | 19.2.6 | ✅ Up to date |
| TypeScript | ~6.0.3 | ~6.0.3 | ✅ Up to date |
| Vite | 8.0.14 | 8.0.14 | ✅ Up to date |
| TanStack Query | 5.100.14 | 5.100.14 | ✅ Up to date |
| Lexical | 0.44.0 | 0.44.0 | ✅ Up to date |
| Axios | 1.16.1 | 1.16.1 | ✅ Up to date |
| Zustand | 5.0.13 | 5.0.13 | ✅ Up to date |

**Upgrade rules:**
- **Patch versions** (e.g., 5.100.14 → 5.100.20): generally safe; run tests and lint.
- **Minor versions** (e.g., 0.109.0 → 0.110.0): review changelog for deprecations; run full test suite.
- **Major versions** (e.g., Vite 7 → 8, TypeScript 5 → 6): plan carefully; check all plugin/config compatibility; run both frontend and backend tests.
- **Never upgrade multiple major versions at once** — upgrade one dependency at a time and verify.
- After any upgrade, run: `pytest tests/ -v`, `ruff check app/`, `cd frontend && npm run lint && npm run build`.
- Update this AGENTS.md table after upgrades so it stays accurate.

---

## Documentation

Architecture documentation lives in `AGENTS.md` and inline code documentation.

Refer to these when working on specific subsystems.
