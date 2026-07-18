# AGENTS.md — Notees

This file contains project-specific context for AI coding agents. If you are reading this, you are expected to modify code in this repository. Read this file carefully before making changes.

Detailed guidance lives in focused reference documents under `agents/`; this file keeps the project-specific quick reference and entry points.

> **Documentation layout**: Agent reference files (architecture, conventions, subsystems, testing) live under `agents/`; plans and working documents go under `agents/plans/` (workflow artifacts under `agents/superpowers/`). `docs/` is reserved for **user-facing documentation** only (e.g. `docs/SECURITY.md`). Never put agent reference material or plans in `docs/`.

---

## Project Overview

**Notees** is a self-hosted, privacy-first, local-first note-taking application. The authoritative data model is an immutable operation log (client-side SQLite derived state, end-to-end encrypted relay). PostgreSQL persists users, workspace membership, share metadata, the encrypted operation log, and snapshots/compaction segments. The product offers wiki-style linking, a block-based outliner, journals, custom types & properties, QueryAST collections, offline-first PWA support, multi-workspace knowledge bases, and Markdown/HTML/PDF export. Developed with AI assistance; licensed AGPL-3.0.

---

## Agent Quick Reference

- **Architecture**: Feature-first hexagonal backend. Domain services use repository port interfaces only — never FastAPI or asyncpg directly. See `agents/backend.md`.
- **Data Model**: The operation log is the source of truth; everything is a `node` (pages, blocks, classes) with class assignments and relational property schemas. Hierarchy is an adjacency list (`parent_id`) materialized in the client-side SQLite derived store. See `agents/data-model.md`.
- **Identifiers**: Public resources use UUIDs in the HTTP API and UI; the document model uses **UUIDv7** (`uuid_extensions.uuid7()` backend, `generateUUID()` frontend) for index locality; internal numeric IDs must never appear in URL paths or public request/response bodies.
- **DB Connections**: Never call `pool.acquire()` directly. Use `app.db.connection.get_connection()` or `get_transaction()`.
- **DI Factories**: `app/dependencies.py` and feature `dependencies.py` return port interfaces from the owning feature's `port.py` (or shared `app/domain/ports.py`), not concrete PostgreSQL implementations.
- **Frontend Imports**: Always use path aliases (e.g. `@/components/ui/Button`, `@/features/auth/api/auth`); never relative `../../../` paths. CSS is co-located with components.
- **Feature Barrels**: Cross-feature imports go through `frontend/src/features/<name>/index.ts` barrels; never import from another feature's internal subdirectories.
- **Feature Hooks**: Domain-specific hooks live in `frontend/src/features/<feature>/hooks/` (or `api/`); generic hooks stay in `frontend/src/hooks/`.
- **Query Keys**: All TanStack Query keys are created through factories in `frontend/src/hooks/queryKeys.ts`. No literal query keys in components.
- **Zustand Selectors**: Avoid large store destructurings; use per-field selectors or focused selector hooks (e.g. `features/layout/hooks/useNavigationSelectors.ts`).
- **Confirmations**: Never use `window.confirm` / `window.alert` / `window.prompt` — use `ConfirmationModal` from `@/components/ui/ConfirmationModal` (see `agents/frontend.md`).
- **Editor popup keepalive**: Any portaled popup/modal opened from the custom inline editor (slash follow-on pickers, pill "Edit link" modal, etc.) MUST hold `openPopup()` while open and `closePopup()` on close — otherwise editor blur unmounts it mid-action and later mutations silently no-op. See `agents/frontend.md#custom-inline-editor--popup-keepalive-invariant`.
- **UI Building Blocks**: Views are compositions of shared primitives — never nest a view mode (`NodeCollection`/`ListView`/`DocumentView`) inside a cell, card, or panel; embed the leaf primitive instead (`NodeCellEditable` pattern). See `agents/building-blocks.md`.
- **Secret Key**: `SECRET_KEY` is mandatory (>= 32 chars). The app will not start without it.
- **Dev vs. Prod**: Development infrastructure settings in `compose.dev.yaml` must never be used in production.
- **Docker-first development**: Backend, frontend, PostgreSQL, and Redis run via `compose.dev.yaml`. Do not recommend bare `npm run dev`, `uvicorn ...`, or other host-local runtime commands unless the user explicitly opts out of Docker; lint and type-check inside the containers.
- **Engineering rules**: Take the technically best path, not the simpler one. Fix root causes instead of adding defensive workarounds. If a bug comes from bad data, fix the data and add a migration — never add "backward compatibility" code to tolerate bad data.

> Generic engineering principles (code style, testing discipline, accessibility, performance, security, agent workflow) are covered by the skills listed under [Skill References](#skill-references).

---

## Architecture (Local-first Operation Log)

- **Source of truth**: the immutable operation log (`app/core/operation.py`). PostgreSQL stores the encrypted relay log, snapshots/compaction segments, users, workspace membership, and share metadata; client-side SQLite is a derived view.
- **Sync**: the encrypted operation relay (`app/relay/`) is the only sync path.
- **Frontend runtime store**: `frontend/src/core/` (sql.js/IndexedDB SQLite + core hooks + sync engine) is the sole data path.
- **Legacy removal**: `app/features/nodes/`, `app/features/properties/`, and `frontend/src/runtime/` have been removed.

For the migration plan see `agents/plans/notees-phase7-plus-plan.md`.

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
| Mobile | Flutter (Dart) | — | Native mobile app, lives in `miquelrosell99/notees-flutter` |
| Containerization | Docker + Docker Compose | — | Production deployment and local development stack |

---

## Project Structure

```
notees/
├── app/                     # Backend (FastAPI)
│   ├── main.py              # App factory, lifespan, middleware, routers
│   ├── config.py            # Pydantic-settings configuration
│   ├── dependencies.py      # Cross-feature DI helpers
│   ├── core/                # Local-first operation log, CRDT adapters, derived SQLite appliers
│   ├── db/                  # Database layer (connections, pool, schema)
│   ├── domain/              # Shared domain kernel
│   ├── features/            # Feature modules (router + service + port + repository)
│   ├── infrastructure/      # Infrastructure adapters
│   ├── relay/               # Encrypted operation relay server
│   ├── static/              # Static assets + built frontend output (dist/)
│   └── utils/
├── frontend/                # React SPA
│   ├── src/
│   │   ├── api/             # Shared Axios client only
│   │   ├── components/ui/   # Reusable UI atoms
│   │   ├── core/            # Local-first SQLite store, sync client, derived-state hooks
│   │   ├── features/        # Feature-first modules
│   │   ├── hooks/           # Generic React hooks (+ queryKeys.ts factories)
│   │   ├── stores/          # Cross-cutting Zustand stores
│   │   ├── types/ utils/    # Shared TS types / utility functions
│   │   ├── views/           # Top-level view components
│   │   ├── workers/         # Web Workers
│   │   ├── sync/            # Sync UI state and status indicator
│   │   └── lib/             # Core libs (AST builder, query client, stringifyAST)
│   └── vite.config.ts       # PWA plugin, proxy, path aliases
├── tests/                   # Backend test suite (pytest)
├── agents/                  # Agent reference docs; plans/ for plans, superpowers/ for workflow artifacts
├── docs/                    # User-facing documentation only (never agent reference or plans)
├── scripts/                 # Utility scripts
├── data/  logs/             # User data, assets, backups, logs (gitignored)
├── compose.yaml             # Docker Compose (production)
├── compose.dev.yaml         # Docker Compose (development services)
├── Dockerfile               # Production multi-stage build
├── Taskfile.yml             # Common development tasks
└── pyproject.toml           # Python metadata, Ruff, mypy config
```

---

## Working Conventions

> Agent workflow rules (snapshot commits, concurrent-agent discipline, verify-before-finishing, plan-mode threshold for multi-file changes): see the `agent-repo-workflow` skill.
> Generic patterns: `react-ui-patterns`, `fastapi-patterns`, `design-system`, `accessibility-primer`. Notees-specific conventions: `agents/frontend.md`, `agents/data-model.md`.

- **Verify before finishing**: run the lint/test commands below after code changes; fix all failures your changes caused.
- **Rebuild the dev stack for runtime-behavior fixes** (routes, request/response schemas, sync mappers, build output, container startup): `docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build` (or `task dev -- --build`), then confirm the behavior in the browser.
- **Race condition triage**: if a bug is "local change disappears after a network mutation", check the **debounced save / query invalidation boundary FIRST**. See `agents/operations.md`.

---

## Build and Test

The canonical development workflow is Docker Compose: `task dev` (or `docker compose -f compose.dev.yaml up`). Frontend: http://localhost:5173 — Backend API: http://localhost:8001. Dev services use non-default host ports (`8001` backend, `5433` PostgreSQL, `6380` Redis) to coexist with other local services.

```bash
# Verify after changes (inside containers)
docker compose -f compose.dev.yaml exec backend uv run ruff check app/
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov
docker compose -f compose.dev.yaml exec frontend npm run lint
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit

# Fast unit tests (no Docker, no DB)
uv run pytest tests/unit -m unit --no-cov

# Frontend tests (Vitest, jsdom)
cd frontend && npm run test:run
```

Full build/release/production details: `agents/build-and-release.md`. Test tiers, fixtures, and E2E (Playwright): `agents/testing.md`.

---

## Security Considerations

> Generic security practices: `security-hardening`. Full Notees defaults and rate-limit tables: `agents/security-and-rate-limiting.md`.

- `SECRET_KEY` mandatory (min 32 chars). JWT HS256: 15-min access in production / 8h in development; refresh tokens rotate on use with a short reuse grace period.
- CORS disabled by default; `CORS_ORIGINS=*` is rejected when credentials are enabled. HSTS / HTTPS redirect only when `ENVIRONMENT=production`.
- Admin user auto-created only when `ADMIN_PASSWORD` meets complexity requirements. Rate limiting: per-IP buckets via `fastapi_limiter` + `pyrate_limiter`.

---

## Documentation

Agent reference (under `agents/`):

- `agents/backend.md` — Backend architecture and patterns
- `agents/frontend.md` — Frontend architecture and conventions
- `agents/building-blocks.md` — Composable UI primitives inventory and layering model
- `agents/data-model.md` — Data model, identifier strategy, domain conventions
- `agents/build-and-release.md` — Build, dev, release, and deployment
- `agents/security-and-rate-limiting.md` — Security defaults and rate limiting
- `agents/testing.md` — Testing strategy and E2E (Playwright)
- `agents/subsystems.md` — Graph view, QueryAST client-side evaluation, block editor, service worker/PWA, asset uploads
- `agents/operations.md` — Debugging, verification, performance, linting, config, pitfalls
- `agents/design-language.md` — Full design language
- `agents/plugin-system.md` — Plugin architecture
- `agents/mobile-sync.md` — Mobile sync validation notes
- `agents/plans/` — Implementation plans and working documents
- `docs/` — User-facing documentation only (e.g. `docs/SECURITY.md`)
- `miquelrosell99/notees-flutter` — Mobile app context

## Skill References

- `agent-repo-workflow` — Snapshot commits, concurrent-agent discipline, verify-before-finishing, plan-mode threshold.
- `fastapi-patterns` — Hexagonal architecture, request-scoped connections, background tasks, per-key rate limiting, backend code style.
- `react-ui-patterns` — React/TypeScript/Vite conventions, data flow, state boundaries, query discipline, view composition, barrels, hook decomposition, TanStack Query v5 behavior.
- `security-hardening` — Auth, HTTPS, secrets, input validation, rate limiting, dependency auditing.
- `performance-optimizer` — Profiling, memoization, code splitting, list virtualization, pool tuning.
- `accessibility-primer` — Screen readers, focus, contrast, touch targets, motion, hover-reveal fallbacks.
- `design-system` — Fleet-wide design tokens, dark mode, motion, haptics.
- `frontend-design` — Distinctive web UI aesthetic guidance.
- `selfhost-release` — Docker Compose, multi-stage Dockerfile, env files, health checks, update workflow.
- `codebase-organizer` — Feature-first structure, import boundaries, modular architecture.
