# Backend Architecture

> For the generic hexagonal architecture pattern, request-scoped connections, and background-task rules, see the `fastapi-patterns` skill. This document covers Notees-specific backend architecture.

## Hexagonal (Ports & Adapters)

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

## Post-Migration Boundary Changes

- Backend is organized by feature under `app/features/<feature>/`, each owning router, service, repository port, and PostgreSQL implementation.
- Routers are thin HTTP adapters; business logic and orchestration live in domain services.
- `UndoService` no longer executes SQL directly; persistence is handled by the `UndoRepository` interface inside `app/features/undo/`.
- Auth persistence moved from direct database access in `app/auth.py` into `app/features/auth/`.
- Services depend on repository ports from their own or another feature's `port.py`; concrete `Postgres*` implementations are wired in feature `dependencies.py` or `app/dependencies.py`.
- Cross-cutting ports (`EmailSender`, `NodeExportRenderer`) live in `app/domain/ports.py` and are implemented in `app/infrastructure/`.

## Key Backend Patterns

- **Request-scoped DB connections**: `app/db/connection.py` uses a `ContextVar` to share one pooled connection across all repository calls within a single HTTP request. This avoids pool contention.
- **Everything is a Node**: Pages, blocks, tags, classes, properties, journals, tasks, templates, comments, and assets are all `node` table rows differentiated by boolean flags (`is_page`, `is_tag`, `is_property`, `is_daily`, `is_task`, `is_template`, etc.). Task items are flagged with `is_task`, which is kept in sync with the `task` system class assignment and indexed for fast queries.
- **Adjacency-list hierarchy**: The `node` table stores parent/child relationships via `parent_id`. Tree traversal (ancestors, descendants, breadcrumbs) uses recursive CTEs (`WITH RECURSIVE`). The legacy `node_path` closure table has been removed.
- **Link parsing**: `[[Page Name]]` and `((block-uuid))` references in content are parsed into explicit `node_link` records for efficient backlink queries.
- **QueryAST**: Structured queries compile to PostgreSQL SQL at runtime via `app/domain/services/query_ast_sql.py`.
- **Soft delete**: `is_deleted` + `deleted_at` columns; soft delete cascades to descendants via recursive CTE updates.
- **Optimistic locking**: `version` column on `node`; `expected_version` parameter returns 409 Conflict on mismatch.
- **Long-running operations**: Any endpoint that may take more than a few seconds (exports, bulk imports, migrations) must not hold a synchronous HTTP connection open. Use an async job pattern: return a job ID immediately, run work in a background `asyncio` task, and expose a poll endpoint for progress. The frontend polls with TanStack Query (`refetchInterval`) and downloads the result when `status: "completed"`.
  - Background task functions must be **module-level**, never inline closures inside the endpoint handler. Closures capture request-scoped variables (DB connections, user dependencies) by reference, which leads to race conditions and hard-to-debug 500s once the request context is torn down. Pass all required data as explicit arguments.
  - Background tasks spawned with `asyncio.create_task` **inherit the parent's context variables**, including the request-scoped DB connection. The task MUST call `clear_request_conn()` (from `app.db.connection`) before any DB access, or it will race with the middleware releasing the connection and raise `InterfaceError: cannot perform operation: another operation is in progress`.

## Known Drift / Resolved

The fleet audit identified a number of drift items. The following have been resolved during the migration:

- **Router-level SQL**: Direct `await conn.` calls and raw SQL were removed from routers; persistence operations now live in domain services and repository implementations.
- **UndoService SQL**: `UndoService` no longer contains SQL; all undo persistence is handled by the `UndoRepository` interface inside `app/features/undo/`.
- **Auth persistence**: Direct database access in `app/auth.py` was moved into `app/features/auth/`.
- **Concrete repository imports**: Routers and services depend on repository ports from their feature's `port.py` or `app/domain/ports.py`; concrete `Postgres*` implementations are wired in feature `dependencies.py` or `app/dependencies.py`.
- **Invite password validation**: `InviteAcceptRequest` enforces the same password-complexity rules as other account endpoints.
- **Pydantic request bodies**: Raw `request.json()` calls in `app/routers/sync.py` and `app/routers/nodes/favorites.py` were replaced with Pydantic models.
- **Asset caching**: The service worker caches `/api/assets/` responses with a CacheFirst strategy.
- **Export rendering port**: Rendering, YAML frontmatter, static share paths, and PDF generation were moved from `app/node_export.py` into `app/infrastructure/export/`. `ExportService` now depends on the `NodeExportRenderer` port, and `HtmlPdfExportRenderer` is wired through `app/dependencies.py`.
- **PropertyService**: Property lifecycle, values, class filters, selection lines, class-property bindings, and side effects (task automation, activity logging) moved from `app/routers/properties/` into `app/features/properties/service.py`. Property routers are now thin HTTP adapters.
- **Router transaction boundaries**: `async with get_transaction():` blocks in `nodes/classes.py` and `nodes/links.py` moved into atomic methods on `NodeService` inside `app/features/nodes/`.
- **Email sender port**: Email sending and public-URL building extracted from `WorkspaceService` and `PostgresShareRepository` into the `EmailSender` port (`app/domain/ports.py`) and `SmtpEmailSender` adapter (`app/infrastructure/email.py`). `ShareService` inside `app/features/shares/` orchestrates repository + email port.
- **Full backend feature-first re-layout**: Every major feature was moved from layer-first directories into `app/features/<feature>/`, including `auth`, `activity`, `assets`, `admin`, `export`, `nodes`, `notifications`, `properties`, `shares`, `sync`, `tasks`, `undo`, and `workspaces`. Each feature owns its router, service, repository port, and PostgreSQL implementation.
- **Leaner test suite**: Added `unit` marker, reusable fakes in `tests/fakes.py`, and fast unit tests in `tests/unit/`. Integration tests are tagged with `@pytest.mark.integration`. The fast unit suite runs in ~0.1 s without Docker/Postgres.
- **Legacy layer-first directory cleanup**: `app/routers/` now only re-exports feature routers; `app/domain/services/` only contains the shared QueryAST compiler kernel; `app/domain/repositories/interfaces.py` only holds cross-cutting repository ports. All feature-specific code lives under `app/features/<feature>/`.
