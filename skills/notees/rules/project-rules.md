# Project Rules — Notees

Cross-cutting constraints that apply to almost every change in this repository.

## Scope

Notees is a self-hosted, privacy-first, local-first note-taking application. This skill covers the FastAPI backend, React frontend, build/release tooling, tests, and agent-facing documentation in this repository. The Flutter mobile companion lives in a separate repository (`miquelrosell99/notees-flutter`) and is not owned by this skill.

## Architecture

- **Source of truth is the immutable operation log** (`app/core/operation.py`). PostgreSQL stores the encrypted relay log, snapshots/compaction segments, users, workspace membership, and share metadata; client-side SQLite is a derived view.
- **Sync path**: the encrypted operation relay (`app/relay/`) is the only sync path.
- **Frontend data path**: `frontend/src/core/` (sql.js/IndexedDB SQLite + core hooks + sync engine) is the sole data path.
- Backend is feature-first hexagonal. Domain services use repository port interfaces only — never FastAPI or asyncpg directly.

## Identifiers

- Public resources use UUIDs in the HTTP API and UI.
- The document model uses **UUIDv7** (`uuid_extensions.uuid7()` backend, `generateUUID()` frontend) for index locality.
- Internal numeric IDs must never appear in URL paths or public request/response bodies.

## Database Connections

Never call `pool.acquire()` directly. Use `app.db.connection.get_connection()` or `get_transaction()`.

## Dependency Injection

`app/dependencies.py` and feature `dependencies.py` return port interfaces from the owning feature's `port.py` (or shared `app/domain/ports.py`), not concrete PostgreSQL implementations.

## Frontend Imports and Structure

- Always use path aliases (e.g. `@/components/ui/Button`, `@/features/auth/api/auth`); never relative `../../../` paths.
- Cross-feature imports go through `frontend/src/features/<name>/index.ts` barrels; never import from another feature's internal subdirectories.
- Domain-specific hooks live in `frontend/src/features/<feature>/hooks/` (or `api/`); generic hooks stay in `frontend/src/hooks/`.
- All TanStack Query keys are created through factories in `frontend/src/hooks/queryKeys.ts`. No literal query keys in components.
- CSS is co-located with components.

## UI Patterns

- Views are compositions of shared primitives — never nest a view mode (`NodeCollection`/`ListView`/`DocumentView`) inside a cell, card, or panel; embed the leaf primitive instead (`NodeCellEditable` pattern).
- Never use `window.confirm` / `window.alert` / `window.prompt` — use `ConfirmationModal` from `@/components/ui/ConfirmationModal`.
- Any portaled popup/modal opened from the custom inline editor MUST hold `openPopup()` while open and `closePopup()` on close — otherwise editor blur unmounts it mid-action and later mutations silently no-op.

## Engineering Discipline

- Take the technically best path, not the simpler one.
- Fix root causes instead of adding defensive workarounds.
- If a bug comes from bad data, fix the data and add a migration — never add "backward compatibility" code to tolerate bad data.
- Verify before finishing: run lint/test commands after code changes and fix failures your changes caused.
- Rebuild the dev stack for runtime-behavior fixes (routes, request/response schemas, sync mappers, build output, container startup): `docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build` (or `task dev -- --build`), then confirm the behavior in the browser.
- Run `python3 scripts/validate-structure.py` after structural refactors.

## Security

- `SECRET_KEY` is mandatory (>= 32 chars). The app will not start without it.
- Admin user auto-created only when `ADMIN_PASSWORD` meets complexity requirements.
- Development infrastructure settings in `compose.dev.yaml` must never be used in production.

## Environment

- Backend, frontend, PostgreSQL, and Redis run via `compose.dev.yaml`. Do not recommend bare `npm run dev`, `uvicorn ...`, or other host-local runtime commands unless the user explicitly opts out of Docker; lint and type-check inside the containers.
- Dev services use non-default host ports (`8001` backend, `5433` PostgreSQL, `6380` Redis) to coexist with other local services.
