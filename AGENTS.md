# AGENTS.md — Notees

This file contains project-specific context for AI coding agents. If you are reading this, you are expected to modify code in this repository. Read this file carefully before making changes.

Detailed guidance lives in focused reference documents under `agents/`; this file keeps the project-specific quick reference and entry points.

> **Documentation layout**: Agent reference files (architecture, conventions, subsystems, testing) live under `agents/`; plans and working documents go under `agents/plans/` (workflow artifacts under `agents/superpowers/`). `docs/` is reserved for **user-facing documentation** only (e.g. `docs/SECURITY.md`). Never put agent reference material or plans in `docs/`.

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

- **Architecture**: Backend uses strict hexagonal architecture. Domain services must only use repository interfaces, never FastAPI or asyncpg directly. See `agents/backend.md`.
- **Data Model**: Everything is a `node` (pages, blocks, tags, properties, journals, tasks). See `agents/data-model.md`.
- **Tree Queries**: The `node` table uses an adjacency list (`parent_id`). Hierarchical reads (ancestors, descendants, breadcrumbs, soft-delete cascading) are implemented with recursive CTEs over `parent_id` + `document_id`. The legacy `node_path` closure table has been removed. See `agents/data-model.md`.
- **DB Connections**: Never call `pool.acquire()` directly. Use `app.db.connection.get_connection()` or `get_transaction()`.
- **DI Factories**: `app/dependencies.py` and feature `dependencies.py` factory functions return repository port interfaces from the owning feature's `port.py` (or shared `app/domain/ports.py`), not concrete PostgreSQL implementations.
- **Frontend Imports**: Always use path aliases (e.g., `@/components/ui/Button`, `@/features/auth/api/auth`). Never use relative `../../../` paths. CSS is co-located with components.
- **Feature Barrels**: Cross-feature imports go through `frontend/src/features/<name>/index.ts` barrels. Do not import from another feature's internal subdirectories.
- **Feature Hooks**: Domain-specific hooks live in `frontend/src/features/<feature>/hooks/` (or `api/`). Generic hooks stay in `frontend/src/hooks/`.
- **Query Keys**: All TanStack Query keys are created through factories in `frontend/src/hooks/queryKeys.ts`. No literal query keys in components.
- **Zustand Selectors**: Avoid large store destructurings. Use per-field selectors or focused selector hooks (e.g., `features/layout/hooks/useNavigationSelectors.ts`).
- **Editor popup keepalive**: The custom inline editor unmounts when its block loses `activeBlockId` (`shouldMountEditor` in `BlockRow.tsx`), and `blurBlock()` clears that id unless `editorFocusStore.popupOpen` is true. Any portaled popup/modal opened from the editor (slash follow-on pickers like `/date`, the pill "Edit link" modal, etc.) MUST hold `openPopup()` while open and `closePopup()` on close — otherwise clicking into it blurs the editor, unmounts it mid-action, and any `applyMutation` after an `await` lands on a dead instance (silent no-op insert, no error). See `agents/frontend.md#custom-inline-editor--popup-keepalive-invariant`.
- **UI Building Blocks**: Views are compositions of shared primitives — never nest a view mode (`NodeCollection`/`ListView`/`DocumentView`) inside a cell, card, or panel; embed the leaf primitive instead (e.g. `NodeCellEditable` = `InlineContentStatic` + `CustomInlineEditor`). Full inventory in `agents/building-blocks.md`.
- **Secret Key**: `SECRET_KEY` is mandatory (>= 32 chars). The app will not start without it.
- **Node Model**: Everything is a `node` differentiated by boolean flags (`is_page`, `is_task`, etc.) that are kept in sync with system class assignments.
- **Identifier Strategy**:
  - Public resources use UUIDs in the HTTP API and UI.
  - The document model uses **UUIDv7** (`uuid_extensions.uuid7()` backend, `generateUUID()` frontend) for better index locality.
  - Internal DB joins and ephemeral state use auto-increment numeric IDs or UUIDv4 where a public identifier is not required.
  - Never expose internal numeric IDs in URL paths or public request/response bodies.
- **Dev vs. Prod**: Development infrastructure settings in `compose.dev.yaml` must never be used in production.
- **Technical Excellence**: Always take the technically best path, not the simpler path. Proper extraction, clean interfaces, and type safety take precedence over minimal diff size.
- **Root Causes Over Hacks**: Always fix root causes instead of adding defensive workarounds.
- **Fix Bad Data at the Source**: If a bug is caused by incorrect data in the database or schema, fix the data and add a migration — never add frontend/backend "backward compatibility" code to tolerate bad data.
- **Docker-first development**: Backend, frontend, PostgreSQL, and Redis run via `compose.dev.yaml` in development. **Do not recommend bare `npm run dev`, `uvicorn ...`, or other host-local runtime commands unless the user explicitly asks for local development without Docker.** Linting and type-checking should also prefer running inside the frontend/backend containers.

> Generic engineering principles (code style, import grouping, testing discipline, accessibility, performance, security patterns) are covered by the skills listed under [Skill References](#skill-references).

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
| Frontend | Axios | 1.16.1 | HTTP client |
| Frontend | @dnd-kit | latest | Drag & drop |
| Frontend | sql.js | 1.14.0 | In-browser SQLite (WASM) |
| Mobile | Kotlin + Android SDK | 36 (minSdk 26) | WebView wrapper app |
| Containerization | Docker + Docker Compose | — | Production deployment and local development stack |

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
│   ├── domain/                   # Shared domain kernel
│   ├── features/                 # Feature-first modules (router + service + repository)
│   ├── infrastructure/           # Infrastructure adapters
│   ├── workspace_io.py           # Workspace import/export
│   ├── workspace_manager.py      # Workspace lifecycle management
│   ├── static/                   # Static assets + built frontend output (dist/)
│   └── utils/                    # Small utilities
│
├── frontend/                     # React SPA
│   ├── src/
│   │   ├── api/                  # Shared Axios client only
│   │   ├── components/ui/        # Reusable UI atoms
│   │   ├── features/             # Feature-first modules
│   │   ├── hooks/                # Generic React hooks
│   │   ├── stores/               # Cross-cutting Zustand stores
│   │   ├── types/                # Shared TypeScript type definitions
│   │   ├── utils/                # Shared utility functions
│   │   ├── views/                # Top-level view components
│   │   ├── workers/              # Web Workers
│   │   ├── runtime/              # OperationRuntime + helpers
│   │   ├── sync/                 # SyncManager adapter
│   │   └── lib/                  # Core libraries (AST builder, query client, stringifyAST)
│   ├── package.json
│   ├── vite.config.ts            # Vite config with PWA plugin, proxy, path aliases
│   ├── tsconfig.app.json
│   ├── eslint.config.js
│   └── vitest.config.ts          # Vitest test runner config
│
├── tests/                        # Backend test suite
├── agents/                       # Agent reference docs; plans/ for plans, superpowers/ for workflow artifacts
├── docs/                         # User-facing documentation only (never agent reference or plans)
├── scripts/                      # Utility scripts
├── data/                         # User data, assets, backups (gitignored)
├── logs/                         # Application logs (gitignored)
├── compose.yaml                  # Docker Compose (production)
├── compose.dev.yaml              # Docker Compose (development services)
├── Dockerfile                    # Production multi-stage build
├── Taskfile.yml                  # Common development tasks
├── uv.lock                       # Python dependency lockfile
├── pyproject.toml                # Python project metadata, Ruff, mypy config
├── pytest.ini                   # Pytest configuration
└── .env.example                  # Example environment variables
```

---

## Architecture

### Backend

The backend follows a feature-first hexagonal architecture. Feature modules under `app/features/<feature>/` each own their `router.py`, `service.py`, `port.py`, `repository.py`, `dependencies.py`, and `models.py`. Routers are thin HTTP adapters; business logic lives in domain services.

See `agents/backend.md` for:
- Hexagonal boundaries and post-migration changes
- Key backend patterns (request-scoped connections, node model, adjacency lists, QueryAST, soft delete, optimistic locking, background jobs)
- Known drift / resolved items

### Frontend

The frontend is a React SPA built with Vite. State is split between Zustand (client state) and TanStack Query (server state). The block editor is a custom contentEditable inline editor with a per-block architecture.

See `agents/frontend.md` for:
- SPA conventions, data flow, and SyncManager / OperationRuntime boundaries
- Path aliases, CSS co-location, and design-system rules
- Icon sprite system, hover-reveal pattern, and aesthetic recipe

See `agents/building-blocks.md` for:
- Composable UI primitives (content, chrome, display, atoms) and the layering model
- The no-nested-view-modes rule, with `NodeCellEditable` as the reference pattern

### Data Model

Everything in the system is a **Node** in the `node` table, differentiated by boolean flags. Workspaces isolate all user data.

See `agents/data-model.md` for:
- Data model at a glance
- Node model, block content AST, and workspace isolation
- Request-scoped connections and middleware behavior
- How to add a new API endpoint

---

## Development Conventions

> Generic patterns are covered by `react-ui-patterns`, `fastapi-patterns`, `design-system`, and `accessibility-primer`. See `agents/frontend.md` and `agents/data-model.md` for Notees-specific conventions.

### Decision-Making & Planning

- **Multi-file changes**: If a task touches more than 2–3 files, spans both frontend and backend, or changes interfaces/schemas, use **plan mode** (`EnterPlanMode`) and get user approval before writing code.
- **Always verify**: After code changes, run the relevant linter/test suite before finishing.
  - Backend (inside container): `docker compose -f compose.dev.yaml exec backend uv run ruff check app/` and `docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov`.
  - Frontend (inside container): `docker compose -f compose.dev.yaml exec frontend npm run lint` and `docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit`.
  - Only fall back to host-local commands (`uv run ...`, `cd frontend && npm ...`) when the user explicitly says they are not using Docker.
- **Rebuild and restart the dev stack when fixes change runtime behavior**: Do not rely on live-reload or long-running containers for changes that affect backend routes, request/response schemas, sync mappers, frontend build output, or container startup state. After such fixes, run `docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build` (or `task dev -- --build`) and confirm the user verifies the behavior in the browser before considering the task done.
- **Fix all test failures**: If tests fail after your changes — even failures that appear unrelated to your task — you must fix them before finishing. Do not leave the test suite broken.

### Git Snapshots

- **Commit every stable, working state as a snapshot.** Whenever the code is in a verified working state — the relevant linters and tests pass and the change behaves as intended — make a commit **before** moving on to the next change. This keeps a known-good point to recover from at all times.
- This rule is durable standing authorization to create snapshot commits within the current task; do not re-ask for confirmation on each one. Other git mutations (`git push`, `git reset`, `git rebase`, force operations, amending published history) still require explicit per-action confirmation.
- Commit only work that belongs to the current task, use a clear Conventional Commits message (see the `git-commits` skill), and never commit a broken, half-finished, or unverified state just to make a snapshot.

### Concurrent Agents

- **Assume other AI agents are working in this repository at the same time.** Uncommitted changes (modified or untracked files) that you did not make belong to another agent's in-progress task.
- Never revert, delete, reformat, stage, or commit files outside your current task's scope. Stage snapshot commits per-file (`git add <path>...`), never with `git add -A` / `git commit -a`.
- Lint or test failures in files you did not touch are presumably another agent's in-flight work: do not "fix" them — note them in your final report and move on. This narrows the "Fix all test failures" rule above to failures caused by your own changes.
- Before running stack-wide commands that affect the shared dev environment (`compose down`, `--build`, DB resets), consider whether another agent may be using it, and prefer scoped commands (single-service restart, targeted tests).

### Debugging

- **Race condition triage**: If a bug involves "local change disappears after a network mutation", check the **debounced save / query invalidation boundary FIRST**. See `agents/operations.md`.
- **Root causes over local fixes**: Step back and check cross-layer interactions — especially between inline editor state, `OperationRuntime` projections, TanStack Query cache updates, and debounced persistence.

---

## Build and Development Commands

The canonical development workflow uses Docker Compose.

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env and set SECRET_KEY and Postgres credentials

# Build and run the full development stack
task dev
# Or without Task:
docker compose -f compose.dev.yaml up
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:8001

> Development services use non-default host ports (`8001` backend, `5433` PostgreSQL, `6380` Redis) so Notees can coexist with other local services.

See `agents/build-and-release.md` for:
- Container-based commands (tests, lint, type-check)
- Alternative local development
- Production Docker and release process
- Remote/LAN access for the Vite dev server

---

## Testing Strategy

> Generic testing discipline is covered by `fastapi-patterns` and `react-ui-patterns`.

Backend tests use pytest with async support. Unit tests in `tests/unit/` run in-memory without Docker/Postgres. Integration tests run against the PostgreSQL container started by `compose.dev.yaml`.

```bash
# Fast unit tests (no Docker, no DB)
uv run pytest tests/unit -m unit --no-cov

# Integration tests excluding slow (inside backend container)
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov
```

Frontend tests use Vitest with `jsdom` and `@testing-library/react`.

```bash
cd frontend
npm run test
npm run test:run
```

See `agents/testing.md` for:
- Full backend/frontend setup, fixtures, and configuration
- E2E tests (Playwright) — container commands and auth setup
- UI measurement harness (Chromium + Playwright) for pixel-level visual bugs

---

## Security Considerations

> Generic security practices are covered by `security-hardening`.

- **SECRET_KEY is mandatory** (min 32 chars).
- **JWT tokens**: HS256; 15 min access in production, 8 hours in development. Refresh tokens rotate on use with a short reuse grace period.
- **CORS**: Disabled by default; `CORS_ORIGINS=*` is rejected when credentials are enabled.
- **HSTS / HTTPS redirect**: Enabled only when `ENVIRONMENT=production`.
- **Admin user**: Auto-created only when `ADMIN_PASSWORD` meets complexity requirements.
- **Rate limiting**: Per-IP buckets via `fastapi_limiter` + `pyrate_limiter`.

See `agents/security-and-rate-limiting.md` for the full security defaults, rate-limit table, and `PerKeyBucketFactory` details.

---

## Subsystem Reference

Complex subsystems are documented separately:

- **Graph View** — `agents/subsystems.md#graph-view`
- **QueryAST Client-Side Evaluation** — `agents/subsystems.md#queryast-client-side-evaluation`
- **Block Editor (Custom Inline Editor)** — `agents/subsystems.md#block-editor-custom-inline-editor`
- **Service Worker / PWA** — `agents/subsystems.md#service-worker--pwa`
- **Asset Upload System** — `agents/subsystems.md#asset-upload-system`

---

## Performance Notes & Accepted Tech Debt

See `agents/operations.md` for:
- Performance notes (immersive view caps, virtualization, event-driven timeline, async exports)
- Code style & linting commands
- Environment variables and configuration
- Common pitfalls

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

## Documentation

Agent reference (under `agents/`):

- `agents/backend.md` — Backend architecture and patterns
- `agents/frontend.md` — Frontend architecture and conventions
- `agents/building-blocks.md` — Composable UI primitives inventory and layering model
- `agents/data-model.md` — Data model and domain conventions
- `agents/build-and-release.md` — Build, dev, release, and deployment
- `agents/security-and-rate-limiting.md` — Security defaults and rate limiting
- `agents/testing.md` — Testing strategy, E2E, UI measurement harness
- `agents/subsystems.md` — Graph, QueryAST, editor, PWA, assets
- `agents/operations.md` — Debugging, performance, linting, config, pitfalls
- `agents/design-language.md` — Full design language
- `agents/plugin-system.md` — Plugin architecture
- `agents/plans/` — Implementation plans and working documents
- `docs/` — User-facing documentation only (e.g. `docs/SECURITY.md`)
- `miquelrosell99/notees-flutter` — Mobile app context
