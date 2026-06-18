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
- **Offline-First**: PWA with service worker caching.
- **Multi-Database / Workspaces**: Separate knowledge bases per project or context.
- **Export**: Markdown, HTML, and PDF export.

---

## Agent Quick Reference

- **Architecture**: Backend uses strict hexagonal architecture. Domain services must only use repository interfaces, never FastAPI or asyncpg directly.
- **DB Connections**: Never call `pool.acquire()` directly. Use `app.db.connection.get_connection()` or `get_transaction()`.
- **DI Factories**: `app/dependencies.py` and feature `dependencies.py` factory functions return repository port interfaces from the owning feature's `port.py` (or shared `app/domain/ports.py`), not concrete PostgreSQL implementations.
- **Frontend Imports**: Always use path aliases (e.g., `@/components/ui/Button`, `@/features/auth/api/auth`). Never use relative `../../../` paths. CSS is co-located with components.
- **Feature Barrels**: Cross-feature imports go through `frontend/src/features/<name>/index.ts` barrels. Do not import from another feature's internal subdirectories.
- **Feature Hooks**: Domain-specific hooks live in `frontend/src/features/<feature>/hooks/` (or `api/`). Generic hooks stay in `frontend/src/hooks/`.
- **Query Keys**: All TanStack Query keys are created through factories in `frontend/src/hooks/queryKeys.ts`. No literal query keys in components.
- **Zustand Selectors**: Avoid large store destructurings. Use per-field selectors or focused selector hooks (e.g., `features/layout/hooks/useNavigationSelectors.ts`).
- **Secret Key**: `SECRET_KEY` is mandatory (>= 32 chars). The app will not start without it.
- **Node Model**: Everything is a `node` (pages, blocks, tags, properties, journals, tasks). Differentiation is via boolean flags (`is_page`, `is_task`, etc.) that are kept in sync with system class assignments.
- **Dev vs. Prod**: Dev PostgreSQL settings (`fsync=off`, etc.) in `compose.yaml` must never be used in production.
- **Technical Excellence**: Always take the technically best path, not the simpler path. Proper extraction, clean interfaces, and type safety take precedence over minimal diff size.
- **Root Causes Over Hacks**: Always fix root causes instead of adding defensive workarounds. If a symptom points to a deeper architectural issue (stale state, lifecycle mismatches, incorrect boundaries), refactor the underlying cause rather than patching around it.
- **Fix Bad Data at the Source**: If a bug is caused by incorrect data in the database or schema, fix the data and add a migration — never add frontend/backend "backward compatibility" code to tolerate bad data.
- **Docker-first**: Development and production are both Docker-based. Local venv setup is possible but not the supported path.

> Generic engineering principles (code style, import grouping, testing discipline, accessibility, performance, security patterns) are covered by the skills listed under [Skill References](#skill-references).

---

## Debugging Conventions

- **Race condition triage**: If a bug involves "local change disappears after a network mutation" (e.g., typed text reappears, inline pill vanishes after adding a class/tag), check the **debounced save / query invalidation boundary FIRST** before tracing DOM or editor logic. The frontend debounces content saves (`useContentSave`) while mutations like `addClass` invalidate queries immediately. A refetch can return stale server-side content and overwrite the editor's local state. Always verify whether `flushAllContentSaves()` or an equivalent flush is needed before firing the mutation.
- **Root causes over local fixes**: When symptoms look like a local editor bug (popup not closing, text not removed, selection wrong), step back and check cross-layer interactions — especially between Lexical editor state, `OperationRuntime` projections, TanStack Query cache updates, and debounced persistence.

---

## Decision-Making & Planning

- **Multi-file changes**: If a task touches more than 2–3 files, spans both frontend and backend, or changes interfaces/schemas, use **plan mode** (`EnterPlanMode`) and get user approval before writing code.
- **Always verify**: After code changes, run the relevant linter/test suite before finishing.
  - Backend: `ruff check app/`; run tests inside the backend Docker container (see [Testing Strategy](#testing-strategy)).
  - Frontend: `cd frontend && npm run lint` and `npx tsc -b --noEmit`.
- **Fix all test failures**: If tests fail after your changes — even failures that appear unrelated to your task — you must fix them before finishing. Do not leave the test suite broken.
- **Prefer minimal changes**: Do not refactor unrelated code. Follow the existing file's style, even if it differs slightly from the general guidelines.

---

## Technology Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Backend | FastAPI | 0.136.3 | REST API framework |
| Backend | Uvicorn | 0.48.0 | ASGI server |
| Backend | Pydantic | 2.13.4 | Data validation |
| Backend | pydantic-settings | 2.14.1 | `.env` configuration |
| Backend | PyJWT | 2.13.0 | JWT tokens (HS256) |
| Backend | passlib | 1.7.4 | Password hashing (bcrypt primary, pbkdf2_sha256 legacy) |
| Backend | asyncpg | 0.31.0 | Async PostgreSQL driver |
| Backend | fastapi-limiter | 0.2.0 | Rate limiting (with `pyrate_limiter`) |
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

## Fleet Migration

Notees was brought into compliance with the RosellRamos fleet skill library. The full phased plan is recorded in `docs/migration-plan.md`.

Skills applied during the migration:

- `fleet-migration`
- `design-system`
- `ui-ux-audit`
- `accessibility-primer`
- `performance-optimizer`
- `security-hardening`
- `codebase-organizer`
- `react-ui-patterns`
- `fastapi-patterns`
- `frontend-design`

Post-migration, the backend enforces strict hexagonal boundaries, the frontend uses the sage-accented tokenized design system with accessible components, and mobile hardening is complete. See [Known Drift / Resolved](#known-drift--resolved) for the specific drift items that were fixed.

---

## Project Structure

```
notees/
├── app/                          # Backend (FastAPI)
│   ├── main.py                   # FastAPI app factory, lifespan, middleware, routers
│   ├── config.py                 # Pydantic-settings configuration
│   ├── models.py                 # Cross-cutting Pydantic request/response schemas
│   ├── backup.py                 # Automatic backup scheduler (pg_dump)
│   ├── logging_config.py         # Structured logging setup
│   ├── dependencies.py           # Cross-feature dependency injection helpers
│   ├── db/                       # Database layer
│   │   ├── connection.py         # asyncpg pool + request-scoped connections
│   │   └── schema/               # Schema initialization, migrations, constants
│   ├── domain/                   # Shared domain kernel
│   │   ├── entities/             # Pure data models (Node, User, Property, QueryAST)
│   │   ├── errors.py             # Domain exceptions
│   │   ├── permissions.py        # Permission checks
│   │   ├── ports.py              # Cross-cutting ports (EmailSender, NodeExportRenderer)
│   │   └── stringify_ast.py      # AST serialization
│   ├── features/                 # Feature-first modules (router + service + repository)
│   │   ├── activity/
│   │   ├── admin/
│   │   ├── assets/
│   │   ├── auth/
│   │   ├── export/
│   │   ├── nodes/
│   │   ├── notifications/
│   │   ├── properties/
│   │   ├── shares/
│   │   ├── sync/
│   │   ├── tasks/
│   │   ├── undo/
│   │   └── workspaces/
│   ├── infrastructure/           # Infrastructure adapters
│   │   ├── email.py              # SMTP email sender adapter
│   │   └── export/               # HTML/PDF/Markdown export rendering adapters
│   ├── workspace_io.py           # Workspace import/export
│   ├── workspace_manager.py      # Workspace lifecycle management
│   ├── static/                   # Static assets + built frontend output (dist/)
│   └── utils/                    # Small utilities
│
├── frontend/                     # React SPA
│   ├── src/
│   │   ├── api/                  # Shared Axios client only
│   │   ├── components/ui/        # Reusable UI atoms (Button, Card, Modal, etc.)
│   │   ├── features/             # Feature-first modules
│   │   │   ├── auth/
│   │   │   ├── collab/
│   │   │   ├── content/          # Core node/page/block logic
│   │   │   ├── editor/           # Lexical editor, plugins, inline editor
│   │   │   ├── journals/
│   │   │   ├── layout/
│   │   │   ├── properties/       # Property cells, renderers, registry
│   │   │   ├── queries/
│   │   │   ├── shares/
│   │   │   ├── sidebar/
│   │   │   ├── tasks/
│   │   │   ├── views/            # Graph, timeline, gantt, kanban, etc.
│   │   │   ├── whiteboard/
│   │   │   └── workspace/
│   │   ├── hooks/                # Generic React hooks
│   │   ├── stores/               # Cross-cutting Zustand stores
│   │   ├── types/                # Shared TypeScript type definitions
│   │   ├── utils/                # Shared utility functions
│   │   ├── views/                # Top-level view components
│   │   ├── workers/              # Web Workers
│   │   ├── runtime/              # OperationRuntime + graph/event/undo helpers
│   │   ├── sync/                 # SyncManager: OperationRuntime → TanStack Query adapter
│   │   └── lib/                  # Core libraries (AST builder, query client, stringifyAST)
│   ├── package.json
│   ├── vite.config.ts            # Vite config with PWA plugin, proxy, path aliases
│   ├── tsconfig.app.json
│   ├── eslint.config.js
│   └── vitest.config.ts          # Vitest test runner config
│
├── mobile/                       # Android Kotlin app
│   ├── app/                      # App module (Activities, Bridge, preferences, widget)
│   ├── build-apk.sh              # Docker-based APK build script
│   └── Dockerfile
│
├── tests/                        # Backend test suite
├── docs/                         # Architecture documentation
├── scripts/                      # Utility scripts
├── data/                         # User data, assets, backups (gitignored)
├── logs/                         # Application logs (gitignored)
├── compose.yaml                  # Docker Compose (development)
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

The backend follows a feature-first hexagonal architecture:

1. **Feature modules** (`app/features/<feature>/`)
   - Each feature owns its `router.py`, `service.py`, `port.py` (repository interface), `repository.py` (PostgreSQL implementation), `dependencies.py`, and `models.py`.
   - Features depend on other features only through their public barrels or shared `app/domain/ports.py`.
   - Routers are thin HTTP adapters; business logic lives in `service.py`.

2. **Shared domain kernel** (`app/domain/`)
   - `entities/`: Pure dataclasses with no external dependencies.
   - `ports.py`: Cross-cutting ports such as `EmailSender` and `NodeExportRenderer`.
   - `errors.py`, `permissions.py`, `stringify_ast.py`: shared domain concerns.

3. **Infrastructure adapters** (`app/infrastructure/`)
   - Concrete adapters for cross-cutting concerns: SMTP email (`email.py`), HTML/PDF/Markdown export rendering (`export/`), Redis pubsub, etc.
   - PostgreSQL implementations live inside their owning feature's `repository.py` and are the only files that execute SQL against asyncpg.

**Post-migration boundary changes:**
- Backend is organized by feature under `app/features/<feature>/`, each owning router, service, repository port, and PostgreSQL implementation.
- Routers are thin HTTP adapters; business logic and orchestration live in domain services.
- `UndoService` no longer executes SQL directly; persistence is handled by the `UndoRepository` interface inside `app/features/undo/`.
- Auth persistence moved from direct database access in `app/auth.py` into `app/features/auth/`.
- Services depend on repository ports from their own or another feature's `port.py`; concrete `Postgres*` implementations are wired in feature `dependencies.py` or `app/dependencies.py`.
- Cross-cutting ports (`EmailSender`, `NodeExportRenderer`) live in `app/domain/ports.py` and are implemented in `app/infrastructure/`.

**Key backend patterns:**
- **Request-scoped DB connections**: `app/db/connection.py` uses a `ContextVar` to share one pooled connection across all repository calls within a single HTTP request. This avoids pool contention.
- **Everything is a Node**: Pages, blocks, tags, classes, properties, journals, tasks, templates, comments, and assets are all `node` table rows differentiated by boolean flags (`is_page`, `is_tag`, `is_property`, `is_daily`, `is_task`, `is_template`, etc.). Task items are flagged with `is_task`, which is kept in sync with the `task` system class assignment and indexed for fast queries.
- **Closure table**: `node_path` maintains transitive ancestor/descendant relationships for fast tree queries.
- **Link parsing**: `[[Page Name]]` and `((block-uuid))` references in content are parsed into explicit `node_link` records for efficient backlink queries.
- **QueryAST**: Structured queries compile to PostgreSQL SQL at runtime via `app/domain/services/query_ast_sql.py`.
- **Soft delete**: `is_deleted` + `deleted_at` columns; soft delete cascades to descendants via closure table.
- **Optimistic locking**: `version` column on `node`; `expected_version` parameter returns 409 Conflict on mismatch.
- **Long-running operations**: Any endpoint that may take more than a few seconds (exports, bulk imports, migrations) must not hold a synchronous HTTP connection open. Use an async job pattern: return a job ID immediately, run work in a background `asyncio` task, and expose a poll endpoint for progress. The frontend polls with TanStack Query (`refetchInterval`) and downloads the result when `status: "completed"`.
  - Background task functions must be **module-level**, never inline closures inside the endpoint handler. Closures capture request-scoped variables (DB connections, user dependencies) by reference, which leads to race conditions and hard-to-debug 500s once the request context is torn down. Pass all required data as explicit arguments.
  - Background tasks spawned with `asyncio.create_task` **inherit the parent's context variables**, including the request-scoped DB connection. The task MUST call `clear_request_conn()` (from `app.db.connection`) before any DB access, or it will race with the middleware releasing the connection and raise `InterfaceError: cannot perform operation: another operation is in progress`.

### Known Drift / Resolved

The fleet audit identified a number of drift items. The following have been resolved during the migration:

- **Router-level SQL**: Direct `await conn.` calls and raw SQL were removed from routers; persistence operations now live in domain services and repository implementations.
- **UndoService SQL**: `UndoService` no longer contains SQL; all undo persistence is handled by the `UndoRepository` interface inside `app/features/undo/`.
- **Auth persistence**: Direct database access in `app/auth.py` was moved into `app/features/auth/`.
- **Concrete repository imports**: Routers and services depend on repository ports from their feature's `port.py` or `app/domain/ports.py`; concrete `Postgres*` implementations are wired in feature `dependencies.py` or `app/dependencies.py`.
- **Design-token drift**: Hardcoded colors, decorative glows/shadows, and incorrect radius values were replaced with tokens from `variables.css`.
- **Accent default**: The `:root` default accent is now sage `#5B7D5B`, with `--color-on-accent` and dark-mode overrides. The earlier default `#404040` has been retired.
- **Block bullet**: Block bullets remain **circular** per the product-owner decision; the design language documents this signature element.
- **Accessibility gaps**: Touch targets were increased to at least 44×44 px, `div role="button"` controls were converted to real `<button>` elements, visible `:focus-visible` rings were restored, form labels were associated with inputs, toast notifications were given `aria-live` regions, modal-like surfaces trap focus, and hover-only actions also reveal on `:focus-within`/`:focus-visible`.
- **Mobile hardening**: Hardcoded English strings were externalized to `strings.xml`, WebView cookie/third-party settings were tightened, origin handling was improved, `android:allowBackup` was set to `false`, and the debug keystore is tracked.
- **Feature-first frontend structure**: Domain-specific hooks, API endpoint modules, React contexts, and Zustand stores moved from `frontend/src/{api,contexts,hooks,stores}/` into their owning `frontend/src/features/<feature>/` module. The `collab` feature was fully consolidated under `features/collab/`. Feature barrels remain the only public surface for cross-feature imports, and the two remaining file-level import cycles were broken.
- **DI ports**: `app/dependencies.py` factories now return repository port interfaces instead of concrete `Postgres*` implementations.
- **Backend boundary cleanup**: Password hashing utilities were extracted to `app/utils/password.py`, removing the `app.auth` ↔ `postgres_user` import cycle. Router imports of `db.schema.constants` were redirected to `domain.entities.constants`. `build_import_records` was moved out of `workspace_io_service.py` so repositories no longer depend on a domain service.
- **Invite password validation**: `InviteAcceptRequest` enforces the same password-complexity rules as other account endpoints.
- **Pydantic request bodies**: Raw `request.json()` calls in `app/routers/sync.py` and `app/routers/nodes/favorites.py` were replaced with Pydantic models.
- **Asset caching**: The service worker caches `/api/assets/` responses with a CacheFirst strategy.
- **Export rendering port**: Rendering, YAML frontmatter, static share paths, and PDF generation were moved from `app/node_export.py` into `app/infrastructure/export/`. `ExportService` now depends on the `NodeExportRenderer` port, and `HtmlPdfExportRenderer` is wired through `app/dependencies.py`.
- **PropertyService**: Property lifecycle, values, class filters, selection lines, class-property bindings, and side effects (task automation, activity logging) moved from `app/routers/properties/` into `app/features/properties/service.py`. Property routers are now thin HTTP adapters.
- **Router transaction boundaries**: `async with get_transaction():` blocks in `nodes/classes.py` and `nodes/links.py` moved into atomic methods on `NodeService` inside `app/features/nodes/`.
- **Email sender port**: Email sending and public-URL building extracted from `WorkspaceService` and `PostgresShareRepository` into the `EmailSender` port (`app/domain/ports.py`) and `SmtpEmailSender` adapter (`app/infrastructure/email.py`). `ShareService` inside `app/features/shares/` orchestrates repository + email port.
- **Full backend feature-first re-layout**: Every major feature was moved from layer-first directories into `app/features/<feature>/`, including `auth`, `activity`, `assets`, `admin`, `export`, `nodes`, `notifications`, `properties`, `shares`, `sync`, `tasks`, `undo`, and `workspaces`. Each feature owns its router, service, repository port, and PostgreSQL implementation.
- **Frontend feature splits**: `features/whiteboard/`, `features/properties/`, `features/views/`, and `features/editor/` were extracted from the `features/content` monolith into standalone modules with their own barrels.
- **Leaner test suite**: Added `unit` marker, reusable fakes in `tests/fakes.py`, and fast unit tests in `tests/unit/`. Integration tests are tagged with `@pytest.mark.integration`. The fast unit suite runs in ~0.1 s without Docker/Postgres.
- **Legacy layer-first directory cleanup**: `app/routers/` now only re-exports feature routers; `app/domain/services/` only contains the shared QueryAST compiler kernel; `app/domain/repositories/interfaces.py` only holds cross-cutting repository ports. All feature-specific code lives under `app/features/<feature>/`.

### Frontend: React SPA

> Generic React/TypeScript/Vite patterns (strict TS, path aliases, co-located CSS, data flow, store boundaries, query key discipline, mutation cache invalidation, barrel files, hook decomposition, TanStack Query v5 unmounting behavior) are covered by `react-ui-patterns`. The items below are Notees-specific implementations and deviations.

- **Build tool**: Vite with PWA plugin (`vite-plugin-pwa`). The build outputs to `app/static/dist`.
- **State**: Zustand for client state (navigation, UI, auth, settings, undo); TanStack Query for server state and caching.
- **Feature-first frontend**: `frontend/src/features/` owns cohesive domains: `content` (core node/page/block logic), `editor` (Lexical editor, plugins, inline editor), `properties` (property cells/renderers/registry), `views` (graph, timeline, gantt, kanban, table, etc.), `whiteboard`, `tasks`, `queries`, `auth`, `workspace`, `shares`, `journals`, `layout`, `sidebar`, and `collab`. Cross-feature imports go through feature barrels.
- **Editor**: Lexical with 28+ custom plugins for block editing, slash commands, drag-and-drop, tables, code blocks, etc. Editor code lives in `frontend/src/features/editor/`.
- **Routing**: Client-side routing within the SPA via a custom router (`src/hooks/useRouter.hook.ts`). FastAPI serves `index.html` for all non-API routes (`spa_fallback`).
- **Path aliases**: `@/components`, `@/hooks`, `@/stores`, `@/api`, `@/editor`, `@/runtime`, `@/types`, `@/features`.
- **Optimistic UI**: Mutations update TanStack Query cache immediately and roll back on failure.
- **View modes**: `NodeCollection` dispatches to view components in `frontend/src/features/views/` (`ListView`, `DocumentView`, `CardView`, `TableView`, `GanttView`, `GraphView`, `TimelineView`, etc.).
- **Canvas Renderers**: `GanttView` and `TimelineView` use extracted imperative canvas renderers (`GanttRenderer.ts`, `TimelineRenderer.ts`) in `frontend/src/features/views/renderers/`.
- **PWA**: Service worker auto-updates; precaches JS/CSS/HTML/ICO/PNG/SVG/WOFF2; network-first API caching; CacheFirst WASM caching; Web Share Target support.

#### Frontend Data Flow Architecture

The frontend follows the `react-ui-patterns` three-layer model without deviation:

```
Backend API ←→ TanStack Query (server state) ←→ SyncManager (adapter) ←→ OperationRuntime + helpers (derived state) ←→ React UI
```

**Layers:**

1. **OperationRuntime** (`frontend/src/runtime/OperationRuntime.ts`): Pure derived-state engine. It owns base nodes (from TanStack Query) + pending operations = projected nodes. It has no React, TanStack Query, or API imports.
2. **Runtime helpers** (`frontend/src/runtime/graphHelpers.ts`, `eventBus.ts`, `serverIdMap.ts`, plus `frontend/src/stores/undoEngine.ts`): Thin modules around OperationRuntime. They provide graph traversal, typed event emission, server-id mapping, undo/redo, and intent dispatch. None of them call the API.
3. **SyncManager** (`frontend/src/sync/SyncManager.tsx`): The **sole** React adapter between OperationRuntime and TanStack Query. Mounted once in `App.tsx`, it observes dispatchable operations, fires `useMutation` hooks, applies targeted cache updates, and acknowledges operations on success.
4. **useContentSave** (`frontend/src/features/editor/hooks/useContentSave.ts`): Debounces editor content changes and forwards them to the undo engine as `update_content` intents. It no longer calls the API directly.

**Boundary rules:**

- The runtime never calls the API or TanStack Query directly.
- Only SyncManager dispatches API mutations.
- Cache updates are centralized in `cacheWriter.ts` and `mutationMap.ts`.
- Offline/ordering is handled by OperationRuntime's operation log and dependency graph; operations dispatch only after their dependencies are acknowledged.
- Graph helper functions return **ephemeral projections**, not persistent state.
- Legacy bridge hooks (`useBlockPersist`, `useStructureSync`, `useOfflineQueue`) are no-ops; their responsibilities moved to SyncManager and OperationRuntime.

### Mobile

The `mobile/` directory contains a minimal Android Kotlin app (API 26–36, minSdk 26) that wraps the frontend in a WebView. It provides:
- A server setup screen (`SetupActivity`).
- A native share receiver (`ShareActivity`).
- An `AndroidBridge` for native-to-web communication.
- Encrypted server URL storage via `EncryptedSharedPreferences`.
- Deep link support: `notees://note/42`.
- File chooser for uploads, custom User-Agent, back button handling.

For build instructions and full mobile details, see `mobile/README.md`. For agent context when modifying the mobile app, see `mobile/AGENTS.md`.

---

## Performance Notes & Accepted Tech Debt

The fleet migration resolved the high-severity performance issues. The remaining shortcuts below are intentional and documented; do not paper over them with defensive code.

- **Immersive views are client-side capped**: `NodeCollection` feeds at most `IMMERSIVE_VIEW_NODE_LIMIT = 500` nodes to `graph`, `timeline`, `gantt`, `calendar`, `chart`, and `pivot` views. A real fix requires server-side aggregation/pagination for each view mode; until then, the cap prevents UI lockups.
- **Gantt label pane is virtualized**: Only visible label rows are rendered in the DOM. The canvas right pane still draws every bar; with the 500-node cap this is acceptable.
- **Timeline is event-driven**: The permanent `requestAnimationFrame` loop was removed; canvas renders are triggered by dependency changes. Event hit-testing uses an x-sorted spatial index for O(log n) lookups.
- **Exports are asynchronous jobs**: `POST /export` and `GET /export/{uuid}` return `{job_id}`. Callers must poll `GET /export/jobs/{job_id}` and download from `GET /export/jobs/{job_id}/download`. Jobs are stored in memory and results are written to `data/exports`; they do not survive a backend restart.
- **Tests are bind-mounted in development**: `compose.yaml` mounts `./tests:/app/tests` and `./pytest.ini:/app/pytest.ini`, so tests can be run without `docker cp`.

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

> Generic testing discipline is covered by `fastapi-patterns` and `react-ui-patterns`. The commands and project-specific setup below are Notees-specific.

### Backend Tests

Tests are in `tests/` and use **pytest** with async support. Unit tests in
`tests/unit/` run in-memory with fake repositories/ports and do not require
Docker or PostgreSQL. Integration and slow tests that exercise the HTTP client
and database **must be run inside the backend Docker container** against the
existing PostgreSQL service.

#### Test tiers

Use these tiers during development and CI:

```bash
# Fast unit tests (no Docker, no DB)
pytest tests/unit -m unit --no-cov

# Integration tests excluding slow
pytest tests/ -m "not slow" --no-cov

# Full suite with coverage (CI)
pytest tests/
```

> Prefer unit tests for domain-service behavior. Use integration tests for
> endpoint contracts and cross-layer concerns. Mark slow tests with
> `@pytest.mark.slow`.

#### Docker-based integration run

```bash
# 1. Ensure the dev stack is running (bind-mounts tests/ and pytest.ini)
docker compose up -d

# 2. Create the test database (one-time setup)
docker exec notees-postgres-dev psql -U notees -c "CREATE DATABASE notees_test;"

# 3. Install test dependencies inside the backend container
docker exec notees-backend-dev pip install pytest==7.4.4 pytest-asyncio==0.23.3 pytest-cov httpx==0.26.0 testcontainers

# 4. Run integration tests using the existing postgres container (use --no-cov to avoid coverage overhead)
docker exec -e TEST_DATABASE_URL=postgresql://notees:YOUR_PASSWORD@postgres:5432/notees_test notees-backend-dev pytest tests/ -m "not slow" -p no:cacheprovider --no-cov -v
```

**Test configuration (`pytest.ini`):**
- `asyncio_mode = auto`
- Coverage target: `--cov-fail-under=30` (current baseline; raise only after coverage consistently exceeds a new threshold)
- Coverage reports to `htmlcov/`
- Markers: `slow`, `integration`, `unit`

**Fixtures (`tests/conftest.py`):**
- `db_pool`: Initializes asyncpg pool, drops and recreates the `public` schema, and re-creates extensions + schema before every test. Explicitly drops `uuid-ossp` before the schema drop to avoid stale extension catalog entries; does **not** drop `pg_trgm` because that can segfault Postgres 17-alpine.
- `db_pool` also resets per-key rate-limit buckets (`PerKeyBucketFactory.reset_all()`) and clears the auth cache so tests do not inherit leftover request budgets or stale user data.
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

## Code Style & Linting

> Generic Python and TypeScript/React style rules are covered by `fastapi-patterns` and `react-ui-patterns`. Project-specific enforcement tools are listed below.

- **Backend**: Ruff is configured in `pyproject.toml` (target py312, line-length 120, Google docstyle convention, select E/W/F/I/N/UP/B/C4/SIM). Run `ruff check app/`.
- **Frontend**: ESLint (flat config) with `@eslint/js`, `typescript-eslint`, `react-hooks`, `react-refresh`, and `jsx-a11y`. Run `cd frontend && npm run lint`.
- **Design System Validator**: `frontend/scripts/validate-design-system.js` catches hardcoded pixel values in spacing/layout properties. It uses a baseline (`scripts/.design-system-baseline.txt`) that grandfathers existing violations, so only *new* violations fail the build.
  ```bash
  cd frontend
  node scripts/validate-design-system.js              # check for new violations
  node scripts/validate-design-system.js --update-baseline  # after fixing a batch
  ```
- **Dead code detector**: `cd frontend && npx knip` finds unused exports and files.

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
| `ADMIN_PASSWORD` | (unset) | Initial admin password. If set and no admin exists on startup, an admin user is created automatically. Must be at least 12 characters with uppercase, lowercase, digit, and special character. If unset, or set but too weak, and no admin exists, both automatic admin creation and first-boot registration are rejected until a valid password is configured or an admin is created with `scripts/promote_user_to_admin.py`. When first-boot registration is allowed, the registrant must supply the configured `ADMIN_PASSWORD` in the registration request; the first admin is created with `ADMIN_PASSWORD`, not the registrant's chosen password. |
| `ACCESS_TOKEN_EXPIRE_HOURS` | `0.25` (15 minutes) | JWT access token lifetime. Override only if you understand the security trade-off. |
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

> Generic security practices (auth, HTTPS, secrets, input validation, rate limiting, dependency auditing) are covered by `security-hardening`. The Notees-specific defaults and headers are listed below.

- **SECRET_KEY is mandatory** and validated at startup (min 32 chars). The app will refuse to start without it.
- **Password hashing**: Uses `bcrypt` via passlib (with `pbkdf2_sha256` retained for backward compatibility with existing hashes).
- **JWT tokens**: Signed with HS256. Access token lifetime defaults to **15 minutes** (configurable via `ACCESS_TOKEN_EXPIRE_HOURS`).
- **CORS**: Disabled by default (frontend and backend are same-origin). Only configure `CORS_ORIGINS` if you run them on separate domains. `CORS_ORIGINS=*` is rejected in all environments when credentials are enabled.
- **HSTS / HTTPS redirect**: Hardened headers (`Strict-Transport-Security` and the HTTP→HTTPS redirect) are enabled **only** when `ENVIRONMENT=production`. Set this explicitly for production deployments; do not rely on the reload flag.
- **Rate limiting**: `fastapi_limiter` (0.2.0) + `pyrate_limiter` are configured in `app/main.py` and individual routers. See the [Rate Limiting](#rate-limiting) subsystem reference for details.
- **Request body size limit**: 55 MB maximum (to support the 50 MB asset upload cap plus multipart overhead).
- **User cache**: In-memory user cache with 5-minute TTL to avoid DB pool acquisition on every request.
- **Static asset caching**: Hashed JS/CSS chunks get long-term cache headers; everything else is `no-store`.
- **Cross-Origin headers**: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` are set on all responses to enable `SharedArrayBuffer` in the browser.
- **Admin user**: Auto-created on first startup **only when `ADMIN_PASSWORD` is set and meets the admin complexity baseline** (≥12 characters, mixed case, digit, special character). If `ADMIN_PASSWORD` is unset, too weak, or empty and no admin exists, both automatic admin creation and first-boot registration are rejected; an error is logged. Set a valid `ADMIN_PASSWORD` and restart, or run `scripts/promote_user_to_admin.py` to bootstrap an admin manually. The `/auth/register` first-boot path requires the caller to provide the configured `ADMIN_PASSWORD`; the initial admin account is created with `ADMIN_PASSWORD` as its password, never with the registrant's chosen password.
- **Production Docker image**: Runs as non-root `appuser`.
- **Backup security**: `pg_dump`/`pg_restore` credentials are passed via environment variables (`PGPASSWORD`, `PGUSER`) rather than command-line arguments to prevent exposure via `ps`.
- **Backup/export encryption at rest**: Backup `.dump` files and workspace export ZIPs are **not encrypted by the application**. Store `data/backups/` and `data/workspaces/{uuid}/export/` on encrypted volumes, or encrypt files outside the app. Optional `BACKUP_ENCRYPTION_KEY` support is planned as a follow-up.
- **Content Security Policy**: The current CSP allows `'unsafe-inline'` for scripts and styles, which is required by the current SPA build architecture. Inline script injection is prevented because all rendered HTML is generated by the compiled React application and FastAPI, not from raw user input. A nonce- or hash-based CSP is a future hardening item.

---

## Deployment

> Generic self-hosting patterns (Docker Compose, multi-stage Dockerfile, env files, health checks, update workflow) are covered by `selfhost-release`. Notees-specific commands and warnings are below.

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
        ├── asset (files on disk under data/workspaces/{workspace_uuid}/assets/)
        ├── task_recurrence (structured recurrence rule per task node)
        └── task_completion (history of completed/skipped occurrences)
```

- **Everything is a Node**: One `node` table with boolean flags (`is_page`, `is_tag`, `is_property`, `is_daily`, `is_task`, `is_template`, `is_system`). `is_task` is kept in sync with the `task` system class assignment and indexed for fast queries.
- **Task Recurrence**: A dedicated `task_recurrence` table is the source of truth for automation. The legacy `task_recurrence` selection property is kept for QueryAST compatibility but is no longer used by `TaskAutomationService`. Completion history lives in `task_completion`.
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
- `is_task = true` → Task item (synchronized with the `task` system class)
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
1. Identify the owning feature under `app/features/<feature>/`.
2. Define Pydantic schemas in `app/features/<feature>/models.py` (or `app/models.py` for truly shared schemas).
3. Add domain logic to `app/features/<feature>/service.py`.
4. If needed, extend the repository port in `app/features/<feature>/port.py` and implement it in `app/features/<feature>/repository.py`.
5. Create/update `app/features/<feature>/router.py`.
6. Include the router in `app/features/<feature>/__init__.py` and wire it in `app/main.py`.
7. Add tests in `tests/`.

### Frontend Conventions

> Generic React patterns — See the `react-ui-patterns` skill for cross-project guidance on strict TypeScript, path aliases, CSS co-location, import boundaries, data flow architecture, store boundaries, query key discipline, mutation cache invalidation, API layer purity, barrel files, hook decomposition, and TanStack Query v5 unmounting behavior. The items below are Notees-specific implementations and file paths.

- **Strict TypeScript**: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `verbatimModuleSyntax: true`.
- **Path Aliases**: Mandatory. Use `@/components`, `@/hooks`, `@/stores`, `@/api`, `@/editor`, `@/runtime`, `@/types`. Never use relative `../../../` paths.
- **CSS Co-location**: Each component has a `.css` file with the same base name in the same directory.
- **Component File Extensions**: `.tsx` for React components, `.ts` for utilities.
- **Import Boundaries**:
  - `components/ui/` components are domain-agnostic atoms (Button, Card, Modal). They **must never** import domain components or stores.
  - Domain-specific components (`features/content/components/blocks/`, `features/content/components/nodes/`, `features/properties/`, `features/queries/`) may import from `components/ui/`, `api/`, `hooks/`, and `stores/`.
- **Custom Hooks**: Live in `frontend/src/hooks/`.
- **State**: Zustand for client state; TanStack Query for server state. Avoid direct fetch/XMLHttpRequest inside UI components.

#### Icons

The app uses **SVG-only icon rendering** via a shared sprite sheet (`frontend/public/mdi-sprite.svg`).

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

> Generic design system guidance is covered by `design-system`. The Notees-specific token names and rules are below.

- **Design Tokens First**: All spacing, layout, sizing, and positioning values must use tokens from `variables.css`. Never hardcode pixel values that describe spatial relationships between components.
  - Block indentation: `--block-indent-step`
  - Thread line position: `--thread-line-offset`
  - Collapse arrow position: `--collapse-arrow-offset`
  - Bullet sizes: `--bullet-wrapper-size`, `--bullet-dot-size`
- **No Cross-Component Selectors**: A CSS file must never reach into another component's internals (e.g., `.node-block--editing .bullet-dot` is forbidden). If a child component needs to change appearance based on parent state, pass a prop or use a data attribute on the child.
- **Component Co-location**: Each `.tsx` file has exactly one `.css` file in the same directory. CSS for a component lives only in its own file.
- **Dead Code Hygiene**: Delete unused CSS classes immediately when the corresponding TSX structure changes. Do not leave orphaned rules "just in case."
- **No Magic Numbers**: If a value appears in more than one CSS file, it must be a token.
- **UI Components First**: Never create a one-off `<button>` or `<input>` when a shared UI component exists. The `Button`, `Icon`, `Input`, `Checkbox`, etc. components in `frontend/src/components/ui/` enforce consistency (sizing, accessibility, focus states, hover styles). Always use them. If a design truly requires a custom element, extract a new UI component rather than inlining raw HTML.
  - Icon-only buttons: `<Button variant="ghost" size="xs" iconOnly icon="mdi mdi-close" />`
  - Text + icon buttons: `<Button icon="mdi mdi-plus">Add</Button>`
  - Never use raw `<button>` for icon actions — `Button` handles `aspect-ratio: 1`, `padding: 0`, and flex-centering automatically.

#### Aesthetic Recipe

The full design language is documented in `docs/design-language.md`. The summary below is the single source of truth for implementation decisions.

Notees is a calm, writing-first knowledge workspace. Its visual identity is defined by a deliberate recipe:

- **55% monastic-productivity** — generous whitespace, minimal chrome, content as the hero.
- **30% editorial-software** — typographic hierarchy, structured pages, long-form reading feel.
- **15% playful-computational-design** — tactile block-editor interactions and purposeful micro-motion.

**Palette**: a warm paper base (`--color-background: #f5f3ef` in light mode; warm charcoal in dark mode) with pure-white page surfaces. The default functional accent is **sage** (`--color-accent: #5B7D5B`; dark-mode override `#7FB285`). Users can choose an arbitrary custom accent from Settings → Appearance. Custom accents set `--color-accent` directly and compute `--color-on-accent` (black or white) from the hex value so primary actions stay readable in light, dark, and OLED modes. Preset accents include dark-mode overrides; accent is reserved for links, active filters, selected states, and primary actions.

**Typography**: Inter remains the UI and body face. Page titles and major headlines use the system serif display stack (`--font-family-display: Georgia, 'Times New Roman', serif`) for an editorial feel. Use the type-scale tokens (`--font-body-*`, `--font-title-*`, `--font-headline-*`, `--font-label-*`, `--font-display-*`) rather than raw sizes.

**Signature elements**:
- **Editorial page header**: warm surface container, accent left border, large serif title.
- **Circular block bullet**: small, solid circular bullet indicator (`border-radius: 50%`) that turns accent on hover/selection.
- **Receding chrome**: top bar and sidebars use transparent or surface-container backgrounds so the page surface dominates.

**Design decision log**:
| Date | Decision | Rationale |
|---|---|---|
| 2026-06-12 | Block bullets remain circular | Product-owner preference; the earlier “sharp square” exploration was rejected in favor of the softer circular mark. |
| 2026-06-12 | Custom accent picker in Settings | Phase 6.3 of the fleet migration plan; `--color-on-accent` is computed from luminance so the chosen color is usable in every theme. |

**Elevation**: Zero decorative shadows. `--elevation-*` tokens are all `none`. Depth is conveyed with surface color shifts and thin outlines (`--color-outline-variant`).

**Shape**: Keep the existing minimal radius scale. Identity comes from color and type, not from corner roundness.

**Spacing**: Use the 4px-based scale (`--spacing-1` = 0.25rem). Avoid arbitrary margins/paddings; if a value is repeated, make it a token.

**Motion**: Short and tactile. Default transitions use `--motion-duration-short` (100ms) or `--motion-duration-medium` (250ms). Respect `prefers-reduced-motion` — the global reset in `index.css` already disables animations for users who request it.

**Icons**: Decorative icons are `aria-hidden`. If an icon conveys meaning on its own, pass a `title` to the `Icon` component so it exposes `role="img"` and `aria-label`.

**CSS implementation**: The app currently uses co-located custom CSS driven by `variables.css`. A phased migration to Tailwind CSS is planned; when it happens, the tokens above must be mapped to `tailwind.config.js` rather than replaced with default Tailwind utilities.

**Registration**: Open registration is **disabled by default** (`REGISTRATION_ENABLED=false`). Frontend fallbacks also default to `false` so the UI does not expose a registration form when the status endpoint is unreachable.

#### Adding a New Frontend Component
1. Place React components in the appropriate feature under `frontend/src/features/`.
2. Use path aliases (e.g., `@/components/ui/Button`) for all imports.
3. Co-locate CSS in a `.css` file with the same base name.
4. Respect import boundaries: `components/ui/` must not import domain components or stores.
5. Register new routes/views in the appropriate `frontend/src/features/{name}/pages/` and wire them into `MainContent` / `appStore`.

---

## Common Pitfalls

- **Do not** use `pool.acquire()` directly in domain services or routers. Use `get_connection()` or `get_transaction()` from `app.db.connection`.
- **Do not** forget to set `SECRET_KEY` before running. The app will crash at startup with a clear validation error.
- **Do not** run the dev PostgreSQL settings (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`) in production. They are explicitly set only in `compose.yaml`.
- **Do not** assume `run_dev.py` or `run.py` exists at the project root. The actual entry points are `uvicorn app.main:app --reload` (backend) and `npm run dev` (frontend).
- When building the Docker image, the frontend build stage outputs to `./dist` inside the container and is copied to `app/static/dist` in the final stage.
- The frontend build uses `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers to enable `SharedArrayBuffer` (required for sql.js/WebAssembly features).
- The `README.md` is kept up to date with the current stack. For the canonical version list, check `pyproject.toml`, `package.json`, and the AGENTS.md Technology Stack table.

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
1. If it needs backend data, extend `LinksRequest` / `LinksResponse` in `app/features/nodes/models.py` and the endpoint in `app/features/nodes/router.py` (search routes)
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
- Asset storage uses folders (`{uuid}/main.{ext}`). Deletion flows through `app/features/assets/service.py`, which removes the whole folder.

---

### Rate Limiting

Rate limiting is implemented with **`fastapi_limiter`** (0.2.0) and **`pyrate_limiter`**. It is **not** Redis-backed; all state lives in in-memory buckets inside the Python process.

**Scaling note:** The default `PerKeyBucketFactory` uses `InMemoryBucket`, which is local to a single Python process. For multi-replica deployments, rate limits are **not shared** across instances. If you run Notees behind a load balancer with more than one backend replica, switch to a Redis-backed bucket (e.g., `RedisBucket` from `pyrate_limiter`) using the existing Redis service configured via `REDIS_URL`.

**Architecture:**
- `app/main.py` defines the global default limiter (`_default_api_limiter`) and attaches it to the `/api` and `/api/v1` root routers.
- Individual routers can define their own stricter limiters for sensitive endpoints (auth, batch operations, trash, shares).

**Current limits (as of 2026-06-01):**

| Limiter | Location | Rate | Scope |
|---------|----------|------|-------|
| Default API | `app/main.py` | **120 req/min per IP** | All `/api/*` and `/api/v1/*` routes |
| Auth register | `app/features/auth/router.py` | 3 req/min | `POST /api/auth/register` |
| Auth login | `app/features/auth/router.py` | 5 req/min | `POST /api/auth/login` |
| Node CRUD | `app/features/nodes/router/crud.py` | 120 req/min | Node create/update/delete routes |
| Batch create | `app/features/nodes/router/batch.py` | 60 req/min | `POST /api/nodes/batch` |
| Batch update | `app/features/nodes/router/batch.py` | 120 req/min | `PUT /api/nodes/batch` |
| Batch delete | `app/features/nodes/router/batch.py` | 120 req/min | `DELETE /api/nodes/batch` |
| Trash | `app/features/nodes/router/trash.py` | 120 req/min | Trash restore/permanent-delete |
| Shares | `app/features/shares/router.py` | 30 req/min | Share create/update endpoints |

**Important implementation detail — `PerKeyBucketFactory`:**

By default, `pyrate_limiter.Limiter(Rate(...))` creates a **`SingleBucketFactory`**, which means **all keys share one global bucket**. A React SPA can fire 50–100+ API requests per minute during normal browsing, so a global 200 req/min limit was exhausted immediately and caused routine usage to hit `429 Too Many Requests`.

The fix is `PerKeyBucketFactory` (defined in `app/main.py`). It creates a separate `InMemoryBucket` per rate-limit key so that each client IP gets its own independent quota. The identifier function `_ip_only_identifier` returns only the client IP (omitting the URL path) to keep bucket count bounded to the number of active clients.

**How to change a limit:**

1. **Global default** — edit the `Rate(...)` in `app/main.py`:
   ```python
   _default_api_limiter = Limiter(PerKeyBucketFactory([Rate(120, Duration.MINUTE)]))
   ```

2. **Specific router** — edit the `Rate(...)` in the relevant router file (e.g., `app/features/auth/router.py`):
   ```python
   _auth_limiter_login = Limiter(Rate(5, Duration.MINUTE))
   ```
   > **Caution:** Router-specific limiters still use the default `SingleBucketFactory`, so they share one global bucket for that endpoint. If you need per-client isolation for a specific endpoint, refactor it to use `PerKeyBucketFactory` and an IP-only identifier, mirroring the pattern in `app/main.py`.

3. **Add a new limiter** — import `RateLimiter` and `Rate`, create a `Limiter`, and add it as a `dependencies=[Depends(RateLimiter(limiter=...))]` on the route or router.

**Key files:**
- `app/main.py` — Global default limiter + `PerKeyBucketFactory`
- `app/features/auth/router.py` — Auth-specific limiters
- `app/features/nodes/router/batch.py` — Batch operation limiters
- `app/features/nodes/router/crud.py` — Node CRUD limiters
- `app/features/nodes/router/trash.py` — Trash limiters
- `app/features/shares/router.py` — Share limiters

---

## Skill References

- `fastapi-patterns` — Hexagonal architecture, request-scoped connections, background tasks, backend code style.
- `react-ui-patterns` — React/TypeScript/Vite conventions, data flow, state boundaries, query discipline, mutation cache invalidation, barrel files, hook decomposition, TanStack Query v5 behavior.
- `security-hardening` — Auth, HTTPS, secrets, input validation, rate limiting, dependency auditing.
- `performance-optimizer` — Profiling, memoization, code splitting, list virtualization, pool tuning.
- `accessibility-primer` — Screen readers, focus, contrast, touch targets, motion, hover-reveal fallbacks.
- `design-system` — Fleet-wide design tokens, dark mode, motion, haptics.
- `frontend-design` — Distinctive web UI aesthetic guidance.
- `selfhost-release` — Docker Compose, multi-stage Dockerfile, env files, health checks, update workflow.
- `codebase-organizer` — Feature-first structure, import boundaries, modular architecture.

---

## Fleet Alignment Scorecard

The fleet audit identified drift across the stack. After the migration, alignment is measured by the major fixes below rather than by invented percentages.

| Skill | Scope | Status | Key Strengths | Major Fixes Applied |
|---|---|---|---|---|
| `fastapi-patterns` | Backend | Improved | Hexagonal layers, request-scoped connections, Pydantic models, lifespan, background jobs. | Router SQL removed; `UndoRepository` extracted; auth persistence moved to `UserRepository`; routers depend on repository interfaces. |
| `security-hardening` | Backend/Infra | Improved | bcrypt + correct pin, JWT + refresh rotation, rate limits, security headers, upload validation. | QueryAST `flag_name` whitelist; per-IP batch rate limits; HSTS/HTTPS gated on `ENVIRONMENT=production`; auth logs redacted; admin password complexity enforced; `SECURITY.md` added. |
| `performance-optimizer` | Backend | Improved | Asyncpg pool tuning, request-scoped connections, pagination, in-memory caches, background exports, gzip. | `pages_only` endpoint bounded; unbounded list queries capped. |
| `react-ui-patterns` | Frontend | Improved | Feature-first structure, path aliases, co-located CSS, TanStack Query + Zustand, lazy loading, barrel files. | `components/ui/` boundary restored; barrel files slimmed; mutation/cache patterns preserved. |
| `design-system` | Frontend | Improved | Comprehensive `variables.css` tokens, monochrome base, accent palette, dark/OLED modes, validator script, zero elevation. | Default accent is sage `#5B7D5B`; custom accent picker added; dark-mode accent overrides implemented; hardcoded colors/radii/shadows replaced with tokens. |
| `frontend-design` | Frontend | Improved | Cohesive minimal aesthetic, functional accents, motion tokens. | Visual identity aligned with `docs/design-language.md`; circular block bullet retained. |
| `accessibility-primer` | Frontend | Improved | Focus trap, skip link, visible focus rings, ARIA patterns, reduced-motion reset. | Touch targets ≥ 44×44 px; `div role="button"` converted to real `<button>`; visible `:focus-visible` rings; associated form labels; toast `aria-live`; focus traps; hover-reveal focus fallbacks. |
| `performance-optimizer` | Frontend | Improved | Virtualization in Table/BlockList/query, React.memo on heavy views, code splitting, manualChunks, observers, useTransition, offline cache cap. | `prefers-reduced-motion` honored in JS-driven motion. |
| `codebase-organizer` | Cross-stack | Improved | Feature-first frontend, clear backend layers, reusable UI kit, barrel files. | UI kit boundary violations fixed; auth module concerns separated. |
| `selfhost-release` | Deployment | Improved | Docker Compose dev, multi-stage production Dockerfile, non-root user, healthcheck, env files. | Mobile build instructions updated; debug keystore tracked. |

---

## Documentation

Architecture documentation lives in `AGENTS.md` and inline code documentation. See `mobile/README.md` for mobile-specific build details and `mobile/AGENTS.md` for agent context when modifying the mobile app.
