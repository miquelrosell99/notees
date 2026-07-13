# Data Model & Domain Conventions

## Data Model at a Glance

```
workspace
  └── node (pages, blocks, tags, properties, journals, tasks, templates, comments, assets)
        ├── node_link (parsed [[Page]] and ((block-uuid)) references for backlinks)
        ├── property (schema definitions + values)
        ├── asset (files on disk under data/workspaces/{workspace_uuid}/assets/)
        ├── task_recurrence (structured recurrence rule per task node)
        └── task_completion (history of completed/skipped occurrences)
```

- **Everything is a Node**: One `node` table with boolean flags (`is_page`, `is_tag`, `is_property`, `is_daily`, `is_task`, `is_template`, `is_system`). `is_task` is kept in sync with the `task` system class assignment and indexed for fast queries.
- **Task Recurrence**: A dedicated `task_recurrence` table is the source of truth for automation. The legacy `task_recurrence` selection property is kept for QueryAST compatibility but is no longer used by `TaskAutomationService`. Completion history lives in `task_completion`.
- **Adjacency-List Tree**: The `node` table stores hierarchy via `parent_id`. Recursive CTEs provide ancestor/descendant/breadcrumb queries and soft-delete cascading. The legacy `node_path` closure table has been removed.
- **Links**: `node_link` is the source of truth for backlinks; it is populated by parsing the block content AST.
- **Workspace Isolation**: Every node, property, and asset belongs to exactly one workspace.

## Node Model

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

## Identifier Strategy

- Public resources use UUIDs in the HTTP API and UI.
- The document model uses **UUIDv7** (`uuid_extensions.uuid7()` backend, `generateUUID()` frontend) for better index locality.
- Internal DB joins and ephemeral state use auto-increment numeric IDs or UUIDv4 where a public identifier is not required.
- Never expose internal numeric IDs in URL paths or public request/response bodies.

## Block Content AST

Block content is stored as a JSON AST (Abstract Syntax Tree). The domain module `app/domain/stringify_ast.py` handles parsing and serialization. The frontend uses `frontend/src/lib/stringifyAST.ts` and related utilities.

## Workspace Isolation

All user data is scoped to a **workspace**. Each user gets a default workspace on enrollment. Workspaces have their own node trees, properties, classes, and assets. Assets are stored on disk under `data/workspaces/{workspace_uuid}/assets/`.

## Request-Scoped Connections

Never call `pool.acquire()` directly in routers or services. Use:
- `app.db.connection.get_connection()` — for general DB access.
- `app.db.connection.get_transaction()` — for transactions.
- Repositories use `acquire_connection()` which transparently reuses the request-scoped connection when inside an HTTP request (set by middleware in `app/main.py`).

## Middleware Behavior

`app/main.py` adds two critical `http` middlewares:
1. **Request logging + DB connection wrapping**: API requests (`/api/*`) are wrapped in `request_connection()` so repos share one connection.
2. **Static asset caching vs. no-cache**: Hashed assets under `/assets/` are cached immutably; API responses and `index.html` are never cached.

## Adding a New API Endpoint

1. Identify the owning feature under `app/features/<feature>/`.
2. Define Pydantic schemas in `app/features/<feature>/models.py` (or `app/models.py` for truly shared schemas).
3. Add domain logic to `app/features/<feature>/service.py`.
4. If needed, extend the repository port in `app/features/<feature>/port.py` and implement it in `app/features/<feature>/repository.py`.
5. Create/update `app/features/<feature>/router.py`.
6. Include the router in `app/features/<feature>/__init__.py` and wire it in `app/main.py`.
7. Add tests in `tests/`.
