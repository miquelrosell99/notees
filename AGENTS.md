# AGENTS.md — Notees

This file contains project-specific context for AI coding agents. If you are reading this, you are expected to modify code in this repository. Read this file carefully before making changes.

---

## Project Overview

**Notees** is a self-hosted, privacy-first note-taking application with bidirectional linking, block-based editing, and offline support. It was developed with AI assistance and is licensed under AGPL-3.0.

Key features:
- **Bidirectional Linking**: Wiki-style `[[Page Name]]` links with automatic backlink tracking.
- **Block-Based Editor**: Outliner-style editing where every block is a referenceable node.
- **Daily Journals**: Built-in daily, monthly, and yearly journal pages.
- **Types & Properties**: Custom properties and classes for powerful filtering and organization.
- **Query-Driven Collections**: A QueryAST system compiles structured queries into PostgreSQL SQL at runtime.
- **Offline-First**: PWA with service worker caching; works without internet.
- **Multi-Database / Workspaces**: Separate knowledge bases per project or context.
- **Export**: Markdown, HTML, and PDF export.

The project has three main parts:
1. **Backend** (`app/`): FastAPI (Python 3.12+)
2. **Frontend** (`frontend/`): React 19 + TypeScript + Vite SPA
3. **Mobile** (`mobile/`): Android Kotlin wrapper app (WebView-based)

---

## Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Backend | FastAPI | 0.109.0 | REST API framework |
| Backend | Uvicorn | 0.27.0 | ASGI server |
| Backend | Pydantic | 2.5.3 | Data validation |
| Backend | pydantic-settings | 2.1.0 | `.env` configuration |
| Backend | PyJWT | >=2.8.0 | JWT tokens (HS256) |
| Backend | passlib | 1.7.4 | Password hashing (pbkdf2_sha256) |
| Backend | asyncpg | >=0.29.0 | Async PostgreSQL driver |
| Backend | slowapi | >=0.1.9 | Rate limiting |
| Backend | WeasyPrint | >=62.0 | PDF generation |
| Backend | Pillow | >=10.0.0 | Image processing |
| Database | PostgreSQL | 16 | Primary persistent storage |
| Frontend | React | 19.2.0 | UI framework |
| Frontend | TypeScript | ~5.9.3 | Type safety |
| Frontend | Vite | 7.2.4 | Build tool & dev server |
| Frontend | Zustand | 5.0.10 | Client-side state management |
| Frontend | TanStack Query | 5.90.17 | Server-state caching |
| Frontend | Lexical | 0.40.0 | Rich-text block editor |
| Frontend | Axios | 1.13.2 | HTTP client |
| Frontend | @dnd-kit | latest | Drag & drop |
| Frontend | sql.js | 1.14.0 | In-browser SQLite (WASM) |
| Mobile | Kotlin + Android SDK | 35 (minSdk 26) | WebView wrapper app |
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

The `mobile/` directory contains a minimal Android Kotlin app (API 26–35, minSdk 26) that wraps the frontend in a WebView. It provides:
- A server setup screen (`SetupActivity`).
- A native share receiver (`ShareActivity`).
- An `AndroidBridge` for native-to-web communication.
- Encrypted server URL storage via `EncryptedSharedPreferences`.
- Deep link support: `notees://note/42`.
- File chooser for uploads, custom User-Agent, back button handling.

---

## Build and Development Commands

### Prerequisites
- Python 3.12+
- Node.js 18+
- PostgreSQL 16 (local or Docker)
- Docker & Docker Compose (optional)

### Backend

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
# .venv\Scripts\activate   # Windows

# Install dependencies
pip install -r requirements.txt

# Run with auto-reload (requires PostgreSQL running and DATABASE_URL set)
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
# Edit .env and set SECRET_KEY, DATABASE_URL, and Postgres credentials

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
- `postgres_container`: Spins up a PostgreSQL 16-alpine container via **testcontainers** per session (requires Docker).
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
| `DATABASE_URL` | PostgreSQL connection string. Format: `postgresql://user:pass@host:port/db` |

**Important:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | (generated, not logged) | Initial admin password. If unset, a random password is generated on first startup. **The password is NOT shown in logs.** Set this env var to retrieve or change it. |
| `CORS_ORIGINS` | `[]` | Comma-separated allowed origins. Never use `*` in production |
| `ACCESS_TOKEN_EXPIRE_HOURS` | `24` | JWT token lifetime (code default). `.env.example` sets `168` for development convenience. |
| `HOST` | `0.0.0.0` | Server bind host |
| `PORT` | `8000` | Server bind port |
| `RELOAD` | `true` | Uvicorn auto-reload (dev only) |
| `LOG_LEVEL` | `INFO` | Logging verbosity |
| `LOG_FILE` | `logs/notees.log` | Log file path |
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

### Docker Compose (Development)

The included `compose.yaml` brings up:
- `postgres`: PostgreSQL 16 (with `fsync=off`, `synchronous_commit=off`, `full_page_writes=off` for dev speed — **never use in production**)
- `backend`: FastAPI with hot-reload, mounted source volumes
- `frontend`: Vite dev server on port 5173, proxying `/api` to the backend

### Production Docker

`Dockerfile` is a multi-stage build:
1. **Stage 1**: `node:20-alpine` builds the frontend.
2. **Stage 2**: `python:3.12-slim` runs the backend with the built frontend copied into `app/static/dist`.

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

### Adding a New Frontend Component
1. Place React components in the appropriate subdirectory under `frontend/src/components/`.
2. Use path aliases (e.g., `@/components/core/Button`) for imports.
3. Co-locate CSS in a `.css` file with the same base name.
4. If the component is domain-specific, it may import from `core/`, `api/`, `hooks/`, and `stores/`. **Core components must never import domain components.**
5. Register new routes/views in `frontend/src/views/` and wire them into `MainContent` / `appStore`.

---

## Common Pitfalls

- **Do not** use `pool.acquire()` directly in domain services or routers. Use `get_connection()` or `get_transaction()` from `app.db.connection`.
- **Do not** forget to set `SECRET_KEY` before running. The app will crash at startup with a clear validation error.
- **Do not** run the dev PostgreSQL settings (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`) in production. They are explicitly set only in `compose.yaml`.
- **Do not** assume `run_dev.py` or `run.py` exists at the project root. The actual entry points are `uvicorn app.main:app --reload` (backend) and `npm run dev` (frontend).
- When building the Docker image, the frontend build stage outputs to `./dist` inside the container and is copied to `app/static/dist` in the final stage.
- The frontend build uses `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers to enable `SharedArrayBuffer` (required for sql.js/WebAssembly features).
- The `README.md` mentions SQLite and older Python/React versions — those are outdated. The actual stack is **PostgreSQL 16**, **Python 3.12+**, and **React 19.2.0**.

---

## Documentation

Additional architecture and feature docs live in `docs/`:
- `01-Architecture-Overview.md`
- `02-Node-Model.md`
- `03-API-Reference.md`
- `04-Properties-System.md`
- `05-Query-System.md`
- `06-Links-and-Backlinks.md`
- `07-Classes-and-Inheritance.md`
- `08-Daily-Journals.md`
- `09-Assets-Management.md`
- `10-Frontend-Architecture.md`
- `11-Editor-and-Blocks.md`
- `12-Authentication-and-Workspaces.md`
- `13-State-Management.md`

Refer to these when working on specific subsystems.
