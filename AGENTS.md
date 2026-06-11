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
- **Frontend Imports**: Always use path aliases (e.g., `@/components/ui/Button`, `@/features/auth/api/auth`). Never use relative `../../../` paths. CSS is co-located with components.
- **Secret Key**: `SECRET_KEY` is mandatory (>= 32 chars). The app will not start without it.
- **Node Model**: Everything is a `node` (pages, blocks, tags, properties, journals). Differentiation is via boolean flags (`is_page`, `is_tag`, etc.).
- **Dev vs. Prod**: Dev PostgreSQL settings (`fsync=off`, etc.) in `compose.yaml` must never be used in production.
- **Technical Excellence**: Always take the technically best path, not the simpler path. Proper extraction, clean interfaces, and type safety take precedence over minimal diff size.
- **Root Causes Over Hacks**: Always fix root causes instead of adding defensive workarounds. If a symptom points to a deeper architectural issue (stale state, lifecycle mismatches, incorrect boundaries), refactor the underlying cause rather than patching around it.
- **Fix Bad Data at the Source**: If a bug is caused by incorrect data in the database or schema (e.g., wrong icon format, malformed enum values), fix the data and add a migration — never add frontend/backend "backward compatibility" code to tolerate bad data. Clean data is cheaper than defensive code.
- **Docker-first**: Development and production are both Docker-based. Local venv setup is possible but not the supported path.

---

## Debugging Conventions

- **Race condition triage**: If a bug involves "local change disappears after a network mutation" (e.g., typed text reappears, inline pill vanishes after adding a class/tag), check the **debounced save / query invalidation boundary FIRST** before tracing DOM or editor logic. The frontend debounces content saves (`useContentSave`) while mutations like `addClass` invalidate queries immediately. A refetch can return stale server-side content and overwrite the editor's local state. In the old monolithic editor this happened via `BlockPlugin.syncProjection`; in the new per-block editor it can happen via `InlineEditor` re-renders when parent props change. Always verify whether `flushAllContentSaves()` or an equivalent flush is needed before firing the mutation.
- **Root causes over local fixes**: When symptoms look like a local editor bug (popup not closing, text not removed, selection wrong), step back and check cross-layer interactions — especially between Lexical editor state, `NodeGraphRuntime` projections, TanStack Query cache updates, and debounced persistence.

---

## Decision-Making & Planning

- **Multi-file changes**: If a task touches more than 2–3 files, spans both frontend and backend, or changes interfaces/schemas, use **plan mode** (`EnterPlanMode`) and get user approval before writing code.
- **Always verify**: After code changes, run the relevant linter/test suite before finishing.
  - Backend: `ruff check app/`; run tests inside the backend Docker container (see Testing Strategy)
  - Frontend: `cd frontend && npm run lint` and `npx tsc -b --noEmit`
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
| Backend | passlib | 1.7.4 | Password hashing (bcrypt primary, pbkdf2_sha256 legacy) |
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
│   │   │   ├── layout/           # App shell (Layout, Sidebar/, CommandPalette/, Modals/, TopBar)
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

> For the generic hexagonal architecture pattern, request-scoped connections, and background-task rules, see `fastapi-patterns`. The description below is Notees-specific.

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
- **Long-running operations**: Any endpoint that may take more than a few seconds (exports, bulk imports, migrations) must not hold a synchronous HTTP connection open. Use an async job pattern: return a job ID immediately, run work in a background `asyncio` task, and expose a poll endpoint for progress. The frontend polls with TanStack Query (`refetchInterval`) and downloads the result when `status: "completed"`.
  - Background task functions must be **module-level**, never inline closures inside the endpoint handler. Closures capture request-scoped variables (DB connections, user dependencies) by reference, which leads to race conditions and hard-to-debug 500s once the request context is torn down. Pass all required data as explicit arguments.
  - Background tasks spawned with `asyncio.create_task` **inherit the parent's context variables**, including the request-scoped DB connection. The task MUST call `clear_request_conn()` (from `app.db.connection`) before any DB access, or it will race with the middleware releasing the connection and raise `InterfaceError: cannot perform operation: another operation is in progress`.

### Frontend: React SPA

- **Build tool**: Vite with PWA plugin (`vite-plugin-pwa`). The build outputs to `app/static/dist`.
- **State**: Zustand for client state (navigation, UI, auth, settings, undo); TanStack Query for server state and caching.
- **Editor**: Lexical with 28+ custom plugins for block editing, slash commands, drag-and-drop, tables, code blocks, etc.
- **Routing**: Client-side routing within the SPA. FastAPI serves `index.html` for all non-API routes (`spa_fallback`).
- **Path aliases**: `@/components`, `@/hooks`, `@/stores`, `@/api`, `@/editor`, `@/runtime`, `@/types`.
- **Optimistic UI**: Mutations update TanStack Query cache immediately and roll back on failure.
- **View modes**: `NodeCollection` dispatches to `ListView`, `DocumentView`, `CardView`, `TableView`, `GanttView`, `GraphView`, `TimelineView`, and `WhiteboardView`.
- **Canvas Renderers**: `GanttView` and `TimelineView` use extracted imperative canvas renderers (`GanttRenderer.ts`, `TimelineRenderer.ts`) to keep React components focused on state while pure functions/classes handle 2D drawing.
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

Tests are in `tests/` and use **pytest** with async support. Because the backend depends on `y-py` and other native extensions, tests **must be run inside the backend Docker container** against the existing PostgreSQL service.

```bash
# 1. Ensure the dev stack is running
docker compose up -d

# 2. Create the test database (one-time setup)
docker exec notees-postgres-dev psql -U notees -c "CREATE DATABASE notees_test;"

# 3. Install test dependencies inside the backend container
docker exec notees-backend-dev pip install pytest==7.4.4 pytest-asyncio==0.23.3 pytest-cov httpx==0.26.0 testcontainers

# 4. Run all tests using the existing postgres container
docker exec -e TEST_DATABASE_URL=postgresql://notees:change_me_dev_password@postgres:5432/notees_test notees-backend-dev pytest tests/ -v

# Run without slow tests
docker exec -e TEST_DATABASE_URL=postgresql://notees:change_me_dev_password@postgres:5432/notees_test notees-backend-dev pytest tests/ -v -m "not slow"
```

**Test configuration (`pytest.ini`):**
- `asyncio_mode = auto`
- Coverage target: `--cov-fail-under=50`
- Coverage reports to `htmlcov/`
- Markers: `slow`, `integration`

**Fixtures (`tests/conftest.py`):**
- `db_pool`: Initializes asyncpg pool, drops all tables, and re-creates schema before every test.
- `test_user`: Creates a unique test user + workspace and returns auth token.
- `client` / `authenticated_client`: `httpx.AsyncClient` against the FastAPI ASGI app.
- `node_repository`, `property_repository`, `link_repository`, `node_service`: Domain-layer fixtures wired to the test DB.

**Why Docker for tests?**
The backend has native dependencies that are installed inside the `Dockerfile.dev` image. Running `pytest` directly on the host or in a local venv may fail with `ModuleNotFoundError`. Always run tests inside the `notees-backend-dev` container.

**Alternative test database:**
Set `TEST_DATABASE_URL` to use an external PostgreSQL instance instead of the compose postgres service.

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
- **Password hashing**: Uses `bcrypt` via passlib (with `pbkdf2_sha256` retained for backward compatibility with existing hashes).
- **JWT tokens**: Signed with HS256. Token lifetime defaults to 24 hours (configurable via `ACCESS_TOKEN_EXPIRE_HOURS`).
- **CORS**: Disabled by default (frontend and backend are same-origin). Only configure `CORS_ORIGINS` if you run them on separate domains.
- **Rate limiting**: `fastapi_limiter` (0.2.0) + `pyrate_limiter` are configured in `app/main.py` and individual routers. See the Rate Limiting subsystem reference below for details.
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

> **Generic React patterns** — See the `react-ui-patterns` skill for cross-project guidance on CSS co-location, import boundaries, data flow architecture, store boundaries, query key discipline, mutation cache invalidation, API layer purity, barrel files, hook decomposition, and TanStack Query v5 unmounting behavior. The items below are Notees-specific implementations and file paths.

- **Strict TypeScript**: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `verbatimModuleSyntax: true`.
- **Path Aliases**: Mandatory. Use `@/components`, `@/hooks`, `@/stores`, `@/api`, `@/editor`, `@/runtime`, `@/types`. Never use relative `../../../` paths.
- **CSS Co-location**: Each component has a `.css` file with the same base name in the same directory.
- **Component File Extensions**: `.tsx` for React components, `.ts` for utilities.
- **Import Boundaries**:
  - `core/` components are domain-agnostic atoms (Button, Card, Modal). They **must never** import domain components.
  - Domain-specific components (`blocks/`, `nodes/`, `properties/`, `queries/`) may import from `core/`, `api/`, `hooks/`, and `stores/`.
- **Custom Hooks**: Live in `frontend/src/hooks/`.
- **State**: Zustand for client state; TanStack Query for server state. Avoid direct fetch/XMLHttpRequest inside UI components.

#### Icons

The app uses **SVG-only icon rendering** via a shared sprite sheet (`frontend/public/mdi-sprite.svg`). This is the industry standard used by Obsidian, Logseq, Blueprint, and others.

- **Sprite sheet**: All 7,000+ Material Design Icons are stored as `<symbol>` elements in a single static file generated from `@mdi/svg`.
- **Rendering**: `Icon.tsx` and `iconDom.ts` render icons with `<svg><use href="/mdi-sprite.svg#mdi-{name}" /></svg>`.
- **No icon fonts**: `@mdi/font` and `@mdi/js` are not used. Do not introduce font-based icon fallbacks.
- **Regeneration**: After updating `@mdi/svg`, run `node scripts/generate-mdi-sprite.js` to rebuild the sprite.
- **PWA caching**: The sprite is precached by the service worker. If the sprite grows beyond 4 MB raw, update `maximumFileSizeToCacheInBytes` in `vite.config.ts`.

#### Mobile Hover-Reveal Pattern

Buttons that are only visible on `:hover` are impossible to discover on touch devices. The codebase uses a shared `.hover-reveal` utility class to solve this centrally:

```css
/* frontend/src/index.css */
.hover-reveal {
  opacity: 0;
  transition: opacity var(--motion-duration-short) var(--motion-easing-standard);
}

@media (max-width: 768px) {
  .hover-reveal {
    opacity: 1 !important;
    pointer-events: auto !important;
  }
}
```

**Usage:** add `hover-reveal` to any element that should be hidden by default and revealed on parent hover:

```tsx
<button className="my-action-button hover-reveal">…</button>
```

The component's existing parent-hover rule (e.g., `.my-container:hover .my-action-button { opacity: 1; }`) is typically **more specific** than `.hover-reveal`, so desktop behavior is unchanged. On mobile the `!important` override forces visibility.

**Rules:**
- Always prefer `.hover-reveal` over scattering `@media (max-width: 768px)` opacity overrides across individual component CSS files.
- If an element also collapses `width` or `transform` (not just opacity), keep the layout collapse in the component CSS and add a co-located mobile override for that property only (see `NodeBreadcrumbs.css` and `WhiteboardView.css` for examples).
- Do not add `.hover-reveal` to elements that are already always visible; it is only for hover-only affordances.

#### CSS & Design System Conventions

- **Design Tokens First**: All spacing, layout, sizing, and positioning values must use tokens from `variables.css`. Never hardcode pixel values that describe spatial relationships between components.
  - Block indentation: `--block-indent-step`
  - Thread line position: `--thread-line-offset`
  - Collapse arrow position: `--collapse-arrow-offset`
  - Bullet sizes: `--bullet-wrapper-size`, `--bullet-dot-size`
- **No Cross-Component Selectors**: A CSS file must never reach into another component's internals (e.g., `.node-block--editing .bullet-dot` is forbidden). If a child component needs to change appearance based on parent state, pass a prop or use a data attribute on the child.
- **Component Co-location**: Each `.tsx` file has exactly one `.css` file in the same directory. CSS for a component lives only in its own file.
- **Dead Code Hygiene**: Delete unused CSS classes immediately when the corresponding TSX structure changes. Do not leave orphaned rules "just in case."
- **No Magic Numbers**: If a value appears in more than one CSS file, it must be a token. The `24px` indentation step appears in `BlockRow.css`, `Bullet.css`, and 14 editing-trail gradient declarations — this must be `var(--block-indent-step)`.
- **UI Components First**: Never create a one-off `<button>` or `<input>` when a shared UI component exists. The `Button`, `Icon`, `Input`, `Checkbox`, etc. components in `frontend/src/components/ui/` enforce consistency (sizing, accessibility, focus states, hover styles). Always use them. If a design truly requires a custom element, extract a new UI component rather than inlining raw HTML.
  - Icon-only buttons: `<Button variant="ghost" size="xs" iconOnly icon="mdi mdi-close" />`
  - Text + icon buttons: `<Button icon="mdi mdi-plus">Add</Button>`
  - Never use raw `<button>` for icon actions — `Button` handles `aspect-ratio: 1`, `padding: 0`, and flex-centering automatically.

#### Enforcement for Solo AI Developers

Since there is no code review, the **codebase must enforce its own rules**. Three tools run automatically:

1. **Pre-commit hook** (`.git/hooks/pre-commit`): Runs `lint-staged`, which only checks files you are currently editing. It runs:
   - `eslint --fix` + `tsc --noEmit` on `.ts`/`.tsx` files
   - `node scripts/validate-design-system.js --css-files` on `.css` files

2. **Design System Validator** (`frontend/scripts/validate-design-system.js`): Catches hardcoded pixel values in spacing/layout properties. It uses a **baseline** (`scripts/.design-system-baseline.txt`) that grandfather's existing violations, so only *new* violations fail the build.

   ```bash
   cd frontend
   node scripts/validate-design-system.js              # check for new violations
   node scripts/validate-design-system.js --update-baseline  # after fixing a batch
   ```

3. **Dead code detector** (`knip`): Finds unused exports and files.
   ```bash
   cd frontend
   npx knip
   ```

**Workflow:**
- Edit CSS → commit → pre-commit hook blocks if you introduced a new hardcoded `px` value.
- Fix the violation (use a token) or run `--update-baseline` if you intentionally fixed a batch.
- The AI agent must run `npm run lint` and `npm run lint:css` before declaring a task complete.

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
   - Example: `frontend/src/components/ui/index.ts` re-exports all UI atoms.

2. **Domain-specific sub-barrels** aggregate related exports from deeper files.
   - Example: `frontend/src/hooks/useNodes.ts` is a sub-barrel that re-exports node queries, mutations, and activity hooks from `useNodeQueries.ts`, `useNodeMutations.ts`, etc.
   - `frontend/src/hooks/index.ts` then re-exports from `useNodes.ts` (and other sub-barrels) so consumers only need `@/hooks`.

**Rules:**
- Import from the **shallowest public barrel** that exposes the symbol. `@/hooks` is preferred over `@/hooks/useStringifyAST` unless you are inside the `hooks/` module itself.
- Do **not** use sub-barrels to re-export unrelated utilities. If a utility (e.g., `nodeNameToText`) lives in `useStringifyAST.ts`, it should be re-exported directly from `hooks/index.ts`, not routed through `useNodes.ts`.
- When adding a new hook or utility, update the appropriate `index.ts` so it is discoverable via path aliases.

#### Frontend Widget Inventory (`frontend/src/components/ui/`)

Reusable UI atoms available for building features. Import via `@/components/core/<Name>`.

| Widget | Purpose | Key Props |
|--------|---------|-----------|
| `Button` | Primary action button (filled, ghost, icon-only) | `variant`, `size`, `icon`, `onClick` |
| `BooleanToggle` | Switch toggle with label + description | `checked`, `label`, `description`, `labelPosition` |
| `SelectionButton` | Icon-button row for choosing from options | `options`, `value`, `size`, `labelPosition` |
| `ColorButton` | Circular color swatch with optional picker | `color`, `size`, `showPicker`, `onColorChange` |
| `TextField` | Labelled text input | `label`, `placeholder`, `value`, `onChange` |
| `SearchBox` | Node search with filter + dropdown results | `filterFn`, `onSelect`, `placeholder` |
| `Modal` | Dialog with header/content/footer slots | `isOpen`, `onClose`, `title`, `size`, `footer` |
| `Card` | Surface container with elevation | `variant`, `padding`, `children` |
| `Dropdown` | Menu dropdown triggered by button | `trigger`, `items`, `onSelect` |
| `ContextMenu` | Right-click context menu | `items`, `onSelect` |
| `Badge` | Small status/count label | `variant`, `size`, `children` |
| `Pill` | Rounded tag/chip | `variant`, `onRemove` |
| `ListSortable` | Drag-reorderable list | `items`, `renderText`, `renderAction`, `onReorder` |
| `useListDragSort` | Shared DnD hook (used by ListSortable & Sidebar favorites) | `itemCount`, `itemSelector`, `onReorder` |
| `Slider` | Range input | `min`, `max`, `value`, `onChange` |
| `Checkbox` | Checkbox with label | `checked`, `label`, `onChange` |
| `DatePickerPopup` | Calendar date picker popup | `value`, `onChange` |
| `LoadingSkeleton` | Placeholder loading UI | `variant`, `count` |
| `EmptyState` | Empty content placeholder | `icon`, `title`, `description` |
| `NotificationToast` | Temporary notification banner | `message`, `type`, `duration` |
| `ImageModal` | Image preview modal | `src`, `isOpen`, `onClose` |
| `Table` | Data table with sorting | `columns`, `data`, `keyExtractor` |
| `InlineConfirmButton` | Button that turns into confirm/cancel | `onConfirm`, `label` |
| `ButtonWithPanel` | Button that opens a pop-over panel | `icon`, `panel`, `title` |
| `SelectTrigger` | Trigger for custom select dropdowns | `value`, `placeholder`, `onClick` |
| `FloatingButtonArray` | FAB with child action buttons | `buttons`, `direction` |
| `FileDropZone` | Drag-and-drop file upload zone | `onFiles`, `accept` |

**Query Builder widgets** (`frontend/src/features/queries/components/`):
- `ViewBuilder` — Full QueryAST editor (conditions, groups, NOT)
- `QueryBlockBuilder` — Single query block renderer (used recursively by ViewBuilder)
- `QueryBlockList` — List of query blocks with add/remove/reorder
- `ProseConditionBuilder` — Prose-style condition editor
- `ProseScopeSelector` — Scope picker (pages, workspace, current page)
- `QuerySQLPreview` — Shows natural language, AST JSON, and SQL pseudocode

#### Adding a New Frontend Component
1. Place React components in the appropriate feature under `frontend/src/features/`.
2. Use path aliases (e.g., `@/components/core/Button`) for all imports.
3. Co-locate CSS in a `.css` file with the same base name.
4. Respect import boundaries: `core/` must not import domain components.
5. Register new routes/views in the appropriate `frontend/src/features/{name}/pages/` and wire them into `MainContent` / `appStore`.

#### Decomposing Complex Hooks
When a hook exceeds ~400 lines, split it into focused sub-hooks:
- **State hook** (`useXState`) — owns `useState`, `useRef`, `useEffect`, `useMemo`, `useCallback` for local UI state and derived values.
- **Items hook** (`useXItems`) — builds the aggregated data array from state.
- **Selection hook** (`useXSelection`) — handles action dispatch when an item is selected.
- **Main hook** (`useX`) — thin orchestrator that wires sub-hooks and returns the combined public API.

Example: `useCommandPalette` → `useCommandPaletteState` + `useCommandPaletteItems` + `useCommandPaletteSelection`.

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

---

## Subsystem Reference

Detailed guides for complex subsystems that agents frequently need to understand or modify.

---

### Graph View

**File paths (all under `frontend/src/features/content/components/nodes/views/`):**
- `GraphView.tsx` — Main React component
- `GraphRenderer.tsx` — Canvas wrapper (WebGL + labels overlay)
- `GraphSettingsSidebar.tsx` — Collapsible left sidebar with controls
- `graphWebGLRenderer.ts` — Custom WebGL2 instanced renderer
- `useGraphRenderer.ts` — Hook wiring physics worker ↔ WebGL ↔ interaction
- `graphTypes.ts` / `viewTypes.ts` — `GraphNode`, `GraphLink`, `GraphSettings`, `VisibilityFilters`
- `evaluateQueryAST.ts` — Client-side QueryAST evaluator for color groups
- `sge/` — SGE v2 physics engine (see below)

**Data flow:**
```
useGraphNodes()          useGraphLinks(nodeIds, { scope, cooccurrence, contextNodeId })
      │                           │
      ▼                           ▼
apiNodes (prop)            apiLinks (from POST /nodes/links)
      │                           │
      └──► GraphView ◄────────────┘
              │
              ├──► BFS neighborhood filter (when currentNodeId + levels > 1)
              ├──► Visibility filters (node types, link types, orphans)
              ├──► Alias resolution & deduplication
              ├──► Color resolution (explicit → QueryAST groups → tag hash)
              └──► GraphRenderer (WebGL + physics worker)
```

**Backend endpoints:**
- `GET /nodes/workspace/nodes` — Returns all workspace pages (no `page_size` limit for graph views)
- `POST /nodes/links` — Returns links between a set of node IDs
  - `scope: 'between'` — both endpoints in the set
  - `scope: 'touching'` — at least one endpoint in the set
  - Link types: `reference`, `parent`, `class`, `extends`, `property-reference`, `cooccurrence`

**Two usage modes:**

| Mode | Source | `currentNodeId` | `localGraphMode` | Link fetching |
|------|--------|-----------------|------------------|---------------|
| **Global graph** | `AllPagesGraphView` | `null` | `false` | All links between all nodes |
| **Local / centered** | `SidebarLocalGraph`, `NodeCollection` graph mode | Set | `true` or `false` | All links between all nodes; BFS filter applied to show neighborhood |

**Neighborhood / Levels filtering (BFS):**
- When `currentNodeId` is set, a **Levels** slider (1–5) appears in `GraphSettingsSidebar`.
- Level 1 = directly linked nodes only.
- Level N = all nodes within N hops via any link type.
- BFS is computed on the frontend from `apiLinks` using `getNeighborhoodNodeIds()` in `GraphView.tsx`.
- Both `sourceNodes` and `sourceLinks` are filtered to the discovered neighborhood before the visibility-filter pipeline runs.
- Persisted per view in `localStorage` under `graph_{viewId}_levels`.

**SGE v2 Physics Engine (`frontend/src/features/content/components/nodes/views/sge/`)**

Modular replacement for the original monolithic SemanticGraphEngine. Uses Structure-of-Arrays (SoA) typed arrays and a force-plugin API.

| Module | Purpose |
|--------|---------|
| `engine.ts` | Orchestrator: SoA buffers, composes forces, runs integration loop |
| `types.ts` | `SGEPhysicsConfig`, `SGEConfig`, `SGEEdge`, `SGEState` |
| `config.ts` | `GraphSettings` → raw numeric `SGEConfig` translation |
| `spatialHash.ts` | Robin Hood typed-array spatial hash (local repulsion queries) |
| `barnesHut.ts` | Pool-based Barnes–Hut quadtree (cluster repulsion) |
| `integrator.ts` | Velocity Verlet + adaptive timestep |
| `forces/springs.ts` | Edge springs (per-type rest length & stiffness) |
| `forces/localRepel.ts` | Short-range node-node repulsion via spatial hash |
| `forces/clusterCohesion.ts` | Shell-model community cohesion |
| `forces/clusterRepulsion.ts` | Barnes–Hut / direct O(K²) cluster repulsion |
| `forces/radialStability.ts` | Prevents expansion drift within clusters |
| `forces/componentBubble.ts` | Connected-component bounding bubbles |
| `forces/centerGravity.ts` | Global center gravity + isolate soft wall |

**Worker Protocol (main ↔ sgeWorker.ts):**
- `init` — full topology + config (creates or reuses engine)
- `setTopology` — incremental topology update
- `setConfig` — live physics parameter update
- `dragStart` / `dragMove` / `dragEnd` — node drag interaction
- `pause` / `resume` — stop/start tick loop
- `destroy` — clean up and terminate

**SharedArrayBuffer path:** When `crossOriginIsolated` is true, the worker writes positions into a SAB each tick and signals via `Atomics.load(meta, META_SEQ)`. The main thread polls in its RAF loop — zero per-frame `postMessage` overhead.

**Transferable fallback:** When SAB is unavailable, the worker posts a `Float32Array` of positions each tick via transferable (zero-copy).

**Color Resolution Pipeline (evaluated per node during `useMemo`):**
1. Explicit `node.properties.color`
2. **QueryAST color groups** — first matching group wins; groups are ordered by priority
3. Tag hash fallback (`getTagColor(tag)` — deterministic 8-color palette)
4. Renderer default color

**Key Files:**
| File | Purpose |
|------|---------|
| `GraphView.tsx` | Main component: state, sidebar, filters, color resolution, BFS neighborhood |
| `GraphRenderer.tsx` | Canvas wrapper: handles events, labels, keyboard shortcuts |
| `GraphSettingsSidebar.tsx` | Sidebar UI: physics, visibility, style, levels slider, groups |
| `graphWebGLRenderer.ts` | WebGL2 renderer: instanced nodes, glow, edges, picking |
| `sgeWorker.ts` | Web Worker entry point: thin wrapper around SGEEngine |
| `evaluateQueryAST.ts` | Client-side QueryAST evaluator for group coloring |
| `GraphGroupModal.tsx` | Modal for creating/editing QueryAST color groups |
| `graphTypes.ts` | `GraphNode`, `GraphLink`, `GraphColorGroup`, `GraphSettings` types |
| `graphConstants.ts` | Physics & rendering constants (forces, LOD, radii, dashes) |
| `graphHelpers.ts` | Radius calc, path finding, render skip, deduplication |
| `graphColoring.ts` | Palette resolution, hex→rgba, node color lookup |
| `viewTypes.ts` | Barrel re-export (backward compat) |

**Adding a new graph setting:**
1. Add to `GraphSettings` in `graphTypes.ts`
2. Add UI control in `GraphSettingsSidebar.tsx`
3. Persist via `setSetting('graph_settings', ...)`
4. If the setting affects physics, wire it through `buildSGEPhysicsConfig()` in `GraphView.tsx`

**Adding a new graph filter or data-mode control:**
1. If it needs backend data, extend `LinksRequest` / `LinksResponse` in `app/routers/nodes/models.py` and the endpoint in `search.py`
2. Update `frontend/src/api/nodes.ts` and `frontend/src/hooks/useNodeGraphQueries.ts` to expose the new parameter
3. Add state + persistence logic in `GraphView.tsx` (localStorage key pattern: `graph_{viewId}_{key}`)
4. Apply the filter in the main `useMemo` that builds `nodes` and `links`
5. Add UI control in `GraphSettingsSidebar.tsx` inside the appropriate section

---

### QueryAST Client-Side Evaluation

The `evaluateQueryAST.ts` module lets you evaluate QueryAST queries against local node data without hitting the backend. This powers graph color groups and can be reused for any client-side filtering.

**Supported Conditions:**
| Condition | Evaluates Against | Notes |
|-----------|------------------|-------|
| `class` | `node.class_ids` | Supports `is`/`is_not`/`contains`/`defined`/`not_defined` |
| `extends` | Class hierarchy | Uses `classDescendants` map from `useClasses()` |
| `property` | `node.properties[name]` | All property operators (equals, contains, gte, etc.) |
| `content` | `nodeNameToText(node.name)` | String matching: contains, starts_with, regex, fts |
| `page` | `node.type === 'page'` | — |
| `parent` | `GraphLink[]` with `type === 'parent'` | Static (specific parent IDs) or dynamic (nested group) |
| `parent_path` | Transitive parent closure | Pre-computed via `buildTransitiveClosure()` |
| `child` / `child_path` | Inverse of parent | Same patterns as parent |
| `reference` | `GraphLink[]` with `type === 'reference'` | — |
| `reference_path` | Direct references only | Transitive reference closure not pre-computed |
| `class_path` | Ancestor classes | Approximates inherited classes |
| `extends` | Class descendants | — |
| `style` | — | Returns `false` (content AST not available client-side) |

**Usage:**
```typescript
import { evaluateQueryAST, buildEvalContext } from './evaluateQueryAST';

const ctx = buildEvalContext(nodes, links, classes);
const matches = nodes.filter(n => evaluateQueryAST(queryAST, n, ctx));
```

**Context Pre-computation:**
- `parentMap`, `childMap`, `referenceMap` — built from `GraphLink[]` in O(links)
- `transitiveParentMap`, `transitiveChildMap` — BFS closures in O(nodes × avg_depth)
- `classDescendants` — class hierarchy map from `useClasses()` data

**Limitations:**
- Structural conditions (parent, child, reference) only see **visible links**. If a parent is not in the `apiLinks` array, the child won't match.
- `style` conditions always return `false`.
- `reference_path` does not compute transitive reference closures.

---

### Block Editor (Lexical)

There are **two editor architectures** in the codebase. The new per-block editor is active; the old monolithic editor is deprecated but retained for rollback safety.

#### New Architecture: Per-Block Editor (Active)

Each block gets its own minimal `LexicalComposer` instance. React owns the block tree (hierarchy, depth, drag-and-drop, selection); Lexical owns only inline text inside a single block.

**Component Hierarchy:**
```
NodeCollectionView / NodeView
  └── BlockList (React: flatten tree, keyboard routing, container hooks)
        └── BlockRow (React: bullet, inline editor, after-content, context menu)
              ├── BlockUI (React: bullet, collapse arrow, icon)
              ├── InlineEditor (LexicalComposer: ParagraphNode + TextNode + InlineLinkNode + MathNode)
              │     ├── CustomCaretPlugin
              │     ├── InlineEditorKeysPlugin
              │     ├── InlineCopyPastePlugin
              │     ├── FloatingToolbarPlugin
              │     ├── NodeLinkPlugin
              │     ├── TriggerPlugin
              │     └── HistoryPlugin
              └── BlockAfterContent (React: property previews, class pills)
```

**Key New Files:**
| File | Purpose |
|------|---------|
| `frontend/src/components/blocks/BlockList.tsx` | Static list container. Flattens tree, wires drag/selection/touch-indent hooks, handles keyboard routing (Enter/Backspace/Delete/Tab/Arrows). |
| `frontend/src/components/blocks/BlockRow.tsx` | Single block row. Composes `BlockUI` + `InlineEditor` + `BlockAfterContent` + `NodeContextMenu`. |
| `frontend/src/components/blocks/BlockUI.tsx` | Non-editable chrome: bullet, icon, collapse arrow. |
| `frontend/src/editor/InlineEditor.tsx` | Minimal Lexical instance per block. Exposes imperative `focus`/`blur`/`getCursorPosition`/`getCursorOffset`. |
| `frontend/src/stores/editorFocusStore.ts` | Zustand store for active block tracking and cross-block keyboard navigation. |
| `frontend/src/hooks/useBlockDragDrop.ts` | DOM-based drag-and-drop on `.node-block[data-block-id]` selectors (replaces `DragDropPlugin`). |
| `frontend/src/hooks/useBlockSelection.ts` | Mouse drag-to-select + shift+arrow keyboard selection (replaces `BlockDragSelectionPlugin` + `KeyboardSelectionPlugin`). |
| `frontend/src/hooks/useTouchIndent.ts` | Horizontal swipe on bullet for indent/outdent (replaces `TouchIndentPlugin`). |
| `frontend/src/editor/plugins/InlineEditorKeysPlugin.tsx` | Per-block Enter/Backspace/Delete/Tab handlers. |
| `frontend/src/editor/plugins/InlineCopyPastePlugin.tsx` | Per-block copy (`[[uuid]]`) and paste (link pills, internal block paste). |

**Mutation Flow:**
```
User types in InlineEditor
  → OnChangePlugin → extractInlineContent() → ContentAST
  → handleContentChange callback
  → runtime.applyIntent({ type: 'update_content', blockId, contentAST })
  → onContentChangeCallback → parent component
  → API PATCH /api/nodes/{id} with JSON AST
```

**Known Deferred Items:**
- **Cross-block undo/redo**: Each `InlineEditor` has an isolated `HistoryPlugin`. Unified undo across merge/split/create is not yet implemented.

#### Old Architecture: Monolithic Editor (Deprecated)

A single `LexicalComposer` instance spanned the entire page. The block hierarchy was projected into Lexical as custom `BlockNode` elements via `BlockPlugin.syncProjection`.

**Legacy Files (unused, retained for rollback):**
- `frontend/src/editor/BlockEditor.tsx`
- `frontend/src/editor/plugins/BlockPlugin.tsx`
- `frontend/src/editor/plugins/BlurOnClickOutsidePlugin.tsx`
- `frontend/src/editor/plugins/VirtualizationPlugin.tsx`
- `frontend/src/editor/plugins/useBlockPluginCommands.ts`
- `frontend/src/editor/plugins/EmptyClickPlugin.tsx`
- `frontend/src/editor/plugins/DragDropPlugin.tsx`
- `frontend/src/editor/plugins/BlockDragSelectionPlugin.tsx`
- `frontend/src/editor/plugins/KeyboardSelectionPlugin.tsx`
- `frontend/src/editor/plugins/TouchIndentPlugin.tsx`

**Custom Nodes (still shared with new editor):**
| Node | Extends | Purpose |
|------|---------|---------|
| `BlockNode` | `ElementNode` | Fundamental block unit. Stores `blockId`, `depth`, `collapsed`, `nodeType`, `hasChildren`, `icon`, `color`, `classIds`. DOM is a flex wrapper with bullet, content slot, and portal targets. |
| `InlineLinkNode` | `DecoratorNode` | Atomic inline pill referencing a node, class, URL, or embed. Renders via React portal. |
| `BlockHeadingNode` | `BlockNode` | Header variant (`<h1>`/`<h2>`/`<h3>`). |
| `BlockCodeNode` | `BlockNode` | Code block (`<pre><code>`) with optional `language`. |
| `BlockTableCellNode` | `BlockNode` | Table cell with mini-editor inside. |

**Content AST Format:**
Block content is stored as JSON AST in `node.name`. The canonical builder/stringifier are:
- `frontend/src/lib/astBuilder.ts` — `parseAST(input, mode)` with modes: `JSON`, `PLAIN`, `MARKDOWN`
- `frontend/src/lib/stringifyAST.ts` — Stringifier with modes: `NODE_MARKDOWN`, `PLAIN_MARKDOWN`, `TEXT_ONLY`
- `app/domain/stringify_ast.py` — Backend mirror

---

### Service Worker / PWA

The PWA uses **`vite-plugin-pwa`** with auto-generated Workbox service workers. There is **no custom service worker source code** in `frontend/src/`.

**Cache Strategies:**
| Resource | Strategy | Details |
|----------|----------|---------|
| SPA shell + static assets | **Precache** | JS/CSS/HTML/icons at SW install time. Hashed chunks use `revision: null`. |
| API responses (`/api/*`) | **NetworkFirst** | 3-second timeout. Falls back to `api-cache` (100 entries, 5-min TTL). |
| WASM (`sql-wasm.wasm`) | **CacheFirst** | 30-day TTL. Excluded from precache (~660 KB). |
| Navigation | **Fallback to index.html** | SPA routing works offline. |

**Update Flow:**
- `registerType: 'autoUpdate'` — new SW installs silently.
- `skipWaiting()` + `clientsClaim()` — activates immediately on next visit.
- **No user-facing update prompt.** Updates are automatic and silent.

**Current Offline State:**
- ✅ App shell loads offline
- ✅ Recent API calls may be served from cache (5-min window)
- ❌ No persistent offline data layer (TanStack Query cache is not persisted to IndexedDB)
- ❌ No `navigator.onLine` checks or offline UI states
- ❌ `offlineMode` feature flag exists but is disabled and unused

**Key Config:** `frontend/vite.config.ts` → `VitePWA({ ... })`

---

### Asset Upload System

Assets are **nodes with `is_asset=TRUE`** and the `asset` system class. There is no separate `asset` database table.

**Upload Flow:**
```
Frontend (drag/paste/slash command)
  → POST /api/assets/upload (multipart/form-data, max 50 MB)
  → Backend validates MIME type + magic bytes
  → AssetService writes to disk atomically (temp → rename)
  → Creates/updates node with is_asset=TRUE + asset class
  → Generates WebP thumbnail (images only, async thread pool)
```

**Disk Layout:**
```
data/workspaces/{workspace_uuid}/
  └── assets/
        └── {asset_uuid}/
              ├── main.{ext}      # original file
              └── thumbnail.webp  # generated thumbnail (images)
```

**Key API Endpoints:**
| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/assets/upload` | Upload file |
| `GET` | `/api/assets/{uuid}` | Download file (auth via `asset_token` query param or Authorization header) |
| `GET` | `/api/assets/{uuid}/thumbnail` | Download WebP thumbnail |
| `GET` | `/api/assets/{uuid}/info` | Metadata |
| `POST` | `/api/assets/{uuid}/token` | Generate 5-min JWT token for secure URLs |
| `DELETE` | `/api/assets/{uuid}` | Delete asset node + folder |

**Frontend Components:**
- `AssetUploadModal.tsx` — Drag/drop/paste upload modal
- `FileDropZone.tsx` — Reusable dropzone UI
- `ImageNode.tsx` — Displays image assets
- `assetTokens.ts` — Short-lived token cache

**Gotchas:**
- Legacy delete code in `app/routers/nodes/crud.py` still globs `assets_dir/{uuid}.*` (flat pattern), but assets now live in folders (`{uuid}/main.{ext}`). This may leave orphaned folders.

---

### Rate Limiting

Rate limiting is implemented with **`fastapi_limiter`** (0.2.0) and **`pyrate_limiter`**. It is **not** Redis-backed; all state lives in in-memory buckets inside the Python process.

**Architecture:**
- `app/main.py` defines the global default limiter (`_default_api_limiter`) and attaches it to the `/api` and `/api/v1` root routers.
- Individual routers can define their own stricter limiters for sensitive endpoints (auth, batch operations, trash, shares).

**Current limits (as of 2026-06-01):**

| Limiter | Location | Rate | Scope |
|---------|----------|------|-------|
| Default API | `app/main.py` | **5000 req/min per IP** | All `/api/*` and `/api/v1/*` routes |
| Auth register | `app/routers/auth.py` | 3 req/min | `POST /api/auth/register` |
| Auth login | `app/routers/auth.py` | 5 req/min | `POST /api/auth/login` |
| Node CRUD | `app/routers/nodes/crud.py` | 120 req/min | Node create/update/delete routes |
| Batch create | `app/routers/nodes/batch.py` | 60 req/min | `POST /api/nodes/batch` |
| Batch update | `app/routers/nodes/batch.py` | 120 req/min | `PUT /api/nodes/batch` |
| Batch delete | `app/routers/nodes/batch.py` | 120 req/min | `DELETE /api/nodes/batch` |
| Trash | `app/routers/nodes/trash.py` | 120 req/min | Trash restore/permanent-delete |
| Shares | `app/routers/nodes/shares.py` | 30 req/min | Share create/update endpoints |

**Important implementation detail — `PerKeyBucketFactory`:**

By default, `pyrate_limiter.Limiter(Rate(...))` creates a **`SingleBucketFactory`**, which means **all keys share one global bucket**. A React SPA can fire 50–100+ API requests per minute during normal browsing, so a global 200 req/min limit was exhausted immediately and caused routine usage to hit `429 Too Many Requests`.

The fix is `PerKeyBucketFactory` (defined in `app/main.py`). It creates a separate `InMemoryBucket` per rate-limit key so that each client IP gets its own independent quota. The identifier function `_ip_only_identifier` returns only the client IP (omitting the URL path) to keep bucket count bounded to the number of active clients.

**How to change a limit:**

1. **Global default** — edit the `Rate(...)` in `app/main.py`:
   ```python
   _default_api_limiter = Limiter(PerKeyBucketFactory([Rate(5000, Duration.MINUTE)]))
   ```

2. **Specific router** — edit the `Rate(...)` in the relevant router file (e.g., `app/routers/auth.py`):
   ```python
   _auth_limiter_login = Limiter(Rate(5, Duration.MINUTE))
   ```
   > **Caution:** Router-specific limiters still use the default `SingleBucketFactory`, so they share one global bucket for that endpoint. If you need per-client isolation for a specific endpoint, refactor it to use `PerKeyBucketFactory` and an IP-only identifier, mirroring the pattern in `app/main.py`.

3. **Add a new limiter** — import `RateLimiter` and `Rate`, create a `Limiter`, and add it as a `dependencies=[Depends(RateLimiter(limiter=...))]` on the route or router.

**Key files:**
- `app/main.py` — Global default limiter + `PerKeyBucketFactory`
- `app/routers/auth.py` — Auth-specific limiters
- `app/routers/nodes/batch.py` — Batch operation limiters
- `app/routers/nodes/crud.py` — Node CRUD limiters
- `app/routers/nodes/trash.py` — Trash limiters
- `app/routers/nodes/shares.py` — Share limiters

---

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

## Skill References

- `react-ui-patterns` — Generic React conventions, data flow, state boundaries, query discipline, barrel files, hook decomposition.
- `fastapi-patterns` — Hexagonal architecture, request-scoped connections, background tasks, code style.
- `security-hardening` — Auth, HTTPS, secrets, input validation, rate limiting, dependency auditing.
- `performance-optimizer` — Profiling, memoization, code splitting, list virtualization.
- `accessibility-primer` — Screen readers, focus, contrast, touch targets, motion.
- `design-system` — Fleet-wide design tokens, dark mode, motion, haptics.

## Documentation

Architecture documentation lives in `AGENTS.md` and inline code documentation.

Refer to these when working on specific subsystems.
