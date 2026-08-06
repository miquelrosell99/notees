# Conventions — Notees

## Frontend Conventions

- **Imports**: path aliases only (`@/components/ui/Button`, `@/features/auth/api/auth`). No relative `../../../` paths.
- **Feature barrels**: cross-feature imports go through `frontend/src/features/<name>/index.ts`.
- **Hooks**: domain-specific hooks live in `frontend/src/features/<feature>/hooks/` or `api/`; generic hooks stay in `frontend/src/hooks/`.
- **Query keys**: all TanStack Query keys are created through factories in `frontend/src/hooks/queryKeys.ts`. No literal query keys in components.
- **Zustand selectors**: avoid large store destructurings; use per-field selectors or focused selector hooks.
- **CSS**: co-located with components.
- **Full frontend reference**: `references/agents/frontend.md`
- **UI primitives**: `references/agents/building-blocks.md`
- **Design language**: `references/agents/design-language.md`

## Backend Conventions

- **Hexagonal/feature-first**: domain services use repository port interfaces only — never FastAPI or asyncpg directly.
- **DB connections**: use `app.db.connection.get_connection()` or `get_transaction()`; never call `pool.acquire()` directly.
- **DI factories**: `app/dependencies.py` and feature `dependencies.py` return port interfaces from the owning feature's `port.py` or shared `app/domain/ports.py`.
- **Identifiers**: public resources use UUIDs in HTTP API and UI; document model uses UUIDv7 for index locality. Internal numeric IDs never appear in URLs or public bodies.
- **Full backend reference**: `references/agents/backend.md`

## Build & Development

- Docker-first development via `compose.dev.yaml`.
- Dev ports: backend `8001`, PostgreSQL `5433`, Redis `6380`.
- Verification commands live in `references/build-and-test.md`.

## Security

- `SECRET_KEY` mandatory (>= 32 chars).
- Admin user auto-created only when `ADMIN_PASSWORD` meets complexity requirements.
- `compose.dev.yaml` settings must never be used in production.
- Full security reference: `references/agents/security-and-rate-limiting.md`
