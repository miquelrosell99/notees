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

## Local-first Core

- **Operation log**: `app/core/operation.py` defines immutable operations. The relay stores encrypted envelopes; clients derive SQLite state by applying operations.
- **Derived appliers**: `app/core/derived/` contains appliers that project operations into queryable tables (node, child order, property values, edges, assets, tasks, activity, shares).
- **Relay**: `app/relay/` is the production sync path. It accepts encrypted batches, enforces permissions via unencrypted routing metadata, and serves catch-up queries.
- **WorkspaceStore**: `app/core/workspace_store.py` provides a server-side `(workspace_id, actor_id)` store for feature islands that still need derived state during the transition.

## Post-Migration Boundary Changes

- Backend is organized by feature under `app/features/<feature>/`, each owning router, service, and dependencies.
- `app/features/nodes/` and `app/features/properties/` were removed in Phase 8; their behavior moved into the operation-log core.
- Routers are thin HTTP adapters; business logic and orchestration live in domain services or core appliers.
- Auth persistence lives in `app/features/auth/`.
- Cross-cutting ports (`EmailSender`, `NodeExportRenderer`) live in `app/domain/ports.py` and are implemented in `app/infrastructure/`.

## Key Backend Patterns

- **Request-scoped DB connections**: `app/db/connection.py` uses a `ContextVar` to share one pooled connection across all repository calls within a single HTTP request. This avoids pool contention.
- **Everything is a Node**: Pages, blocks, and classes are nodes in the operation log. Differentiation happens via `kind` and class assignments (`class_ids`). The legacy PostgreSQL `node` table is no longer the source of truth.
- **Adjacency-list hierarchy**: Tree structure is stored via `parent_id` in the derived SQLite state. Ordering is materialized in `node_child_order`.
- **ID-based references**: Node links are ID-based (UUIDv7). Name-based `[[Page Name]]` references are not supported because names are not unique.
- **QueryAST**: QueryAST collections are evaluated against the client-side SQLite derived store. The legacy PostgreSQL QueryAST compiler was removed.
- **Soft delete**: Nodes are deleted with `node.delete` operations; deleted nodes are filtered out in derived query views.
- **Relay permissions**: The relay reads `workspace_share`, `node_user_share`, and `node_public_share` to authorize batch writes and catch-up reads without decrypting operation payloads.
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
- **Legacy nodes/properties removal**: `app/features/nodes/` and `app/features/properties/` were deleted in Phase 8. Their responsibilities now live in the operation-log core (`app/core/`) and the encrypted relay (`app/relay/`).
- **PropertyService / NodeService**: The legacy property and node services were removed; behavior is now expressed as operations and derived appliers.
- **Email sender port**: Email sending and public-URL building extracted from `WorkspaceService` and `PostgresShareRepository` into the `EmailSender` port (`app/domain/ports.py`) and `SmtpEmailSender` adapter (`app/infrastructure/email.py`). `ShareService` inside `app/features/shares/` orchestrates repository + email port.
- **Full backend feature-first re-layout**: Every major feature was moved from layer-first directories into `app/features/<feature>/`, including `auth`, `activity`, `assets`, `admin`, `export`, `nodes`, `notifications`, `properties`, `shares`, `sync`, `tasks`, `undo`, and `workspaces`. Each feature owns its router, service, repository port, and PostgreSQL implementation.
- **Leaner test suite**: Added `unit` marker, reusable fakes in `tests/fakes.py`, and fast unit tests in `tests/unit/`. Integration tests are tagged with `@pytest.mark.integration`. The fast unit suite runs in ~0.1 s without Docker/Postgres.
- **Legacy layer-first directory cleanup**: `app/routers/` now only re-exports feature routers; `app/domain/services/` only contains the shared QueryAST compiler kernel; `app/domain/repositories/interfaces.py` only holds cross-cutting repository ports. All feature-specific code lives under `app/features/<feature>/`.
