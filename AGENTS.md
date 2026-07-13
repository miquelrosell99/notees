# AGENTS.md — Notees

This file contains project-specific context for AI coding agents. If you are reading this, you are expected to modify code in this repository. Read this file carefully before making changes.

Detailed guidance has been split into focused reference documents under `docs/`; this file keeps the project-specific quick reference and entry points.

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

- **Architecture**: Backend uses strict hexagonal architecture. Domain services must only use repository interfaces, never FastAPI or asyncpg directly. See `docs/backend.md`.
- **Data Model**: Everything is a `node` (pages, blocks, tags, properties, journals, tasks). See `docs/data-model.md`.
- **Tree Queries**: The `node` table uses an adjacency list (`parent_id`). Hierarchical reads (ancestors, descendants, breadcrumbs, soft-delete cascading) are implemented with recursive CTEs over `parent_id` + `document_id`. The legacy `node_path` closure table has been removed. See `docs/data-model.md`.
- **DB Connections**: Never call `pool.acquire()` directly. Use `app.db.connection.get_connection()` or `get_transaction()`.
- **DI Factories**: `app/dependencies.py` and feature `dependencies.py` factory functions return repository port interfaces from the owning feature's `port.py` (or shared `app/domain/ports.py`), not concrete PostgreSQL implementations.
- **Frontend Imports**: Always use path aliases (e.g., `@/components/ui/Button`, `@/features/auth/api/auth`). Never use relative `../../../` paths. CSS is co-located with components.
- **Feature Barrels**: Cross-feature imports go through `frontend/src/features/<name>/index.ts` barrels. Do not import from another feature's internal subdirectories.
- **Feature Hooks**: Domain-specific hooks live in `frontend/src/features/<feature>/hooks/` (or `api/`). Generic hooks stay in `frontend/src/hooks/`.
- **Query Keys**: All TanStack Query keys are created through factories in `frontend/src/hooks/queryKeys.ts`. No literal query keys in components.
- **Zustand Selectors**: Avoid large store destructurings. Use per-field selectors or focused selector hooks (e.g., `features/layout/hooks/useNavigationSelectors.ts`).
- **Editor popup keepalive**: The custom inline editor unmounts when its block loses `activeBlockId` (`shouldMountEditor` in `BlockRow.tsx`), and `blurBlock()` clears that id unless `editorFocusStore.popupOpen` is true. Any portaled popup/modal opened from the editor (slash follow-on pickers like `/date`, the pill "Edit link" modal, etc.) MUST hold `openPopup()` while open and `closePopup()` on close — otherwise clicking into it blurs the editor, unmounts it mid-action, and any `applyMutation` after an `await` lands on a dead instance (silent no-op insert, no error). See `docs/frontend.md#custom-inline-editor--popup-keepalive-invariant`.
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
| Frontend | Lexical | 0.44.0 | Rich-text block editor |
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
├── docs/                         # Architecture documentation
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

See `docs/backend.md` for:
- Hexagonal boundaries and post-migration changes
- Key backend patterns (request-scoped connections, node model, adjacency lists, QueryAST, soft delete, optimistic locking, background jobs)
- Known drift / resolved items

### Frontend

The frontend is a React SPA built with Vite. State is split between Zustand (client state) and TanStack Query (server state). The editor is Lexical-based with a per-block architecture.

See `docs/frontend.md` for:
- SPA conventions, data flow, and SyncManager / OperationRuntime boundaries
- Path aliases, CSS co-location, and design-system rules
- Icon sprite system, hover-reveal pattern, and aesthetic recipe

### Data Model

Everything in the system is a **Node** in the `node` table, differentiated by boolean flags. Workspaces isolate all user data.

See `docs/data-model.md` for:
- Data model at a glance
- Node model, block content AST, and workspace isolation
- Request-scoped connections and middleware behavior
- How to add a new API endpoint

---

## Development Conventions

> Generic patterns are covered by `react-ui-patterns`, `fastapi-patterns`, `design-system`, and `accessibility-primer`. See `docs/frontend.md` and `docs/data-model.md` for Notees-specific conventions.

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

### Debugging

- **Race condition triage**: If a bug involves "local change disappears after a network mutation", check the **debounced save / query invalidation boundary FIRST**. See `docs/operations.md`.
- **Root causes over local fixes**: Step back and check cross-layer interactions — especially between Lexical editor state, `OperationRuntime` projections, TanStack Query cache updates, and debounced persistence.

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

See `docs/build-and-release.md` for:
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

### E2E tests (Playwright)

E2E specs live in `frontend/e2e/` with config at `frontend/playwright.config.ts` (`testDir: ./e2e`, `baseURL: http://localhost:5173`, single `chromium` project). Run them inside the frontend container:

```bash
# Browsers are NOT preinstalled in the dev image — install once (downloads to
# ~/.cache/ms-playwright, i.e. outside the repo; confirm with the user first):
docker compose -f compose.dev.yaml exec -T frontend npx playwright install chromium

# Run the suite (or a single spec)
docker compose -f compose.dev.yaml exec -T frontend npx playwright test
docker compose -f compose.dev.yaml exec -T frontend npx playwright test e2e/smoke.spec.ts
```

Auth for specs: the access token is an **HTTPOnly cookie** set by the backend (only the user profile is in `localStorage.user`). The browser talks to the API through the Vite proxy, so authenticate via `context.request` against the page origin so the cookie lands on `localhost:5173`:

```ts
await context.request.post('http://localhost:5173/api/auth/login', {
  data: { email, password, remember_me: true },
});
// cookie is now set for localhost:5173; mirror the profile so the SPA treats us as logged in:
await page.addInitScript((u) => localStorage.setItem('user', JSON.stringify(u)), user);
```

Caveat: a running dev DB usually already has an admin account whose password you don't know — don't wipe it. Prefer onboarding on a fresh/isolated DB (`POST /api/auth/register` when `GET /api/auth/status` reports `has_users === false`) or a freshly registered test user if registration is enabled.

See `docs/testing.md` for the full setup, fixtures, and configuration.

### UI measurement harness (Chromium + Playwright)

For pixel-level visual bugs (alignment, spacing, optical offsets), don't guess from CSS — measure the real rendering:

1. **Harness page**: create a temporary `frontend/<bug>.html` (Vite serves any `.html` in the frontend root) plus an entry `frontend/src/<bug>.tsx` that imports the global CSS (`./variables.css`, `./styles/data-colors.css`, `./index.css`), the relevant component CSS, and renders the **real components** (e.g. `<Bullet>`) in the real DOM structure with several candidate fix variants side by side. No auth needed.
2. **Measure + screenshot script**: a Node script driving Playwright — `page.evaluate` with `getBoundingClientRect()` for element geometry and canvas `ctx.measureText()` (`fontBoundingBoxAscent/Descent`, `actualBoundingBoxAscent/Descent`) for text ink metrics, plus `page.screenshot({ deviceScaleFactor: 3, fullPage: true })` for visual confirmation.
3. **Run it on the host, not in the container**: the frontend dev image is Alpine/musl, so the bundled Chromium can't launch there (missing glibc libs). The host already has the browsers in `~/.cache/ms-playwright`; run with the repo-local Playwright package:

```bash
cd frontend && node scripts/<bug>-shot.mjs   # against http://localhost:5173/<bug>.html
```

4. **Clean up**: delete the harness HTML/TSX and the shot script once the fix is verified (or keep the script under `frontend/scripts/` only if it is reusable).

---

## Security Considerations

> Generic security practices are covered by `security-hardening`.

- **SECRET_KEY is mandatory** (min 32 chars).
- **JWT tokens**: HS256; 15 min access in production, 8 hours in development. Refresh tokens rotate on use with a short reuse grace period.
- **CORS**: Disabled by default; `CORS_ORIGINS=*` is rejected when credentials are enabled.
- **HSTS / HTTPS redirect**: Enabled only when `ENVIRONMENT=production`.
- **Admin user**: Auto-created only when `ADMIN_PASSWORD` meets complexity requirements.
- **Rate limiting**: Per-IP buckets via `fastapi_limiter` + `pyrate_limiter`.

See `docs/security-and-rate-limiting.md` for the full security defaults, rate-limit table, and `PerKeyBucketFactory` details.

---

## Subsystem Reference

Complex subsystems are documented separately:

- **Graph View** — `docs/subsystems.md#graph-view`
- **QueryAST Client-Side Evaluation** — `docs/subsystems.md#queryast-client-side-evaluation`
- **Block Editor (Lexical)** — `docs/subsystems.md#block-editor-lexical`
- **Service Worker / PWA** — `docs/subsystems.md#service-worker--pwa`
- **Asset Upload System** — `docs/subsystems.md#asset-upload-system`

---

## Performance Notes & Accepted Tech Debt

See `docs/operations.md` for:
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

- `docs/backend.md` — Backend architecture and patterns
- `docs/frontend.md` — Frontend architecture and conventions
- `docs/data-model.md` — Data model and domain conventions
- `docs/build-and-release.md` — Build, dev, release, and deployment
- `docs/security-and-rate-limiting.md` — Security defaults and rate limiting
- `docs/testing.md` — Testing strategy
- `docs/subsystems.md` — Graph, QueryAST, editor, PWA, assets
- `docs/operations.md` — Debugging, performance, linting, config, pitfalls
- `docs/design-language.md` — Full design language
- `miquelrosell99/notees-flutter` — Mobile app context
