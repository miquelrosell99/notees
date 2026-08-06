# Developer Guide

This guide covers the project layout, development workflow, testing, and key conventions for contributors.

---

## Project structure

```
notees/
├── app/                    # Backend (FastAPI)
│   ├── core/               # Local-first operation log, CRDTs, derived SQLite appliers
│   ├── db/                 # Database layer (asyncpg, PostgreSQL)
│   ├── domain/             # Shared domain kernel (entities, services, ports)
│   ├── features/           # Feature modules (router + service + port + repository)
│   ├── infrastructure/     # Infrastructure adapters
│   ├── plugins/            # Runtime plugin system
│   ├── relay/              # Encrypted operation relay server
│   ├── routers/            # API router aggregation
│   └── static/dist/        # Built frontend
├── frontend/               # React 19 + TypeScript + Vite
│   ├── src/
│   │   ├── api/            # Shared Axios client only
│   │   ├── components/ui/  # Reusable UI atoms
│   │   ├── core/           # Local-first SQLite store, sync client, derived-state hooks
│   │   ├── features/       # Feature-first modules (tasks, queries, editor, …)
│   │   ├── hooks/          # Generic React hooks (+ query key factories)
│   │   ├── stores/         # Zustand state management
│   │   ├── views/ lib/     # Top-level views / core libraries
│   │   └── types/ utils/   # Shared TypeScript types / utility functions
│   └── vite.config.ts
├── tests/                  # Backend test suite (pytest)
├── skills/notees/          # Developer/agent reference docs and skill routing
├── docs/                   # User-facing documentation
├── scripts/                # Utility scripts
└── data/                   # User data (gitignored)
```

The frontend local-first core in `frontend/src/core/` is the sole path for state, hooks, and sync. Feature modules live under `frontend/src/features/<feature>/` and expose their public API through barrel `index.ts` files.

---

## Development workflow

The recommended workflow is the Docker Compose development stack:

```bash
cp .env.example .env
# Edit .env and set SECRET_KEY, ADMIN_PASSWORD, POSTGRES_PASSWORD

task dev
# Or: docker compose -f compose.dev.yaml up
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:8001

`Taskfile.yml` provides common tasks:

| Task | Command | Description |
|------|---------|-------------|
| `setup` | `task setup` | Build development Docker images |
| `dev` | `task dev` | Run full stack |
| `services` | `task services` | Start only Postgres + Redis |
| `services:down` | `task services:down` | Stop infrastructure services |
| `backend` | `task backend` | Run backend locally outside Docker |
| `frontend` | `task frontend` | Run frontend locally outside Docker |
| `lint` | `task lint` | Run backend and frontend linters |
| `test` | `task test` | Run fast backend tests |
| `test:full` | `task test:full` | Run full backend test suite |
| `build` | `task build` | Build production frontend and Docker image |

---

## Testing

### Backend tests

Run inside the backend container:

```bash
# Fast tests (excludes slow/marked tests)
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov -v

# Full suite
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ --no-cov -v

# Fast unit tests outside Docker (no DB)
uv run pytest tests/unit -m unit --no-cov
```

### Frontend tests

Run inside the frontend container:

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Unit tests
npm run test:run

# E2E tests
npm run test:e2e
```

### Linting

Backend lint:

```bash
docker compose -f compose.dev.yaml exec backend uv run ruff check app/
```

Frontend lint and type check:

```bash
cd frontend
npm run lint
npx tsc -b --noEmit
```

---

## Local development alternative

Only use this path if you explicitly opt out of Docker for running services:

```bash
uv sync --all-groups
cd frontend && npm install

# Infrastructure only
docker compose -f compose.dev.yaml up postgres redis -d

# Terminal 1 — backend
uv run uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload --reload-dir app

# Terminal 2 — frontend
cd frontend && npm run dev
```

You also need the PostgreSQL 17 client (`pg_dump`) installed on the host.

---

## Key conventions

### GraphQuery layer

The frontend read layer is built around **GraphQuery** objects in `frontend/src/core/graphQueries/`:

- `GraphQuery` defines a named, cache-keyed, invalidatable query.
- Concrete queries live in `frontend/src/core/graphQueries/queries/`.
- `useGraphQuery` is the React hook that dispatches queries to the worker and subscribes to change notifications.
- Projections in `frontend/src/core/projections/` convert IDs/rows into view models.

This split keeps page loads fast: queries return lightweight IDs or rows, and projections hydrate only visible rows.

### Web Worker

The Web Worker owns the `sql.js` SQLite `Database` per workspace:

- `frontend/src/core/worker/workspaceWorker.ts` — message dispatch
- `frontend/src/core/worker/WorkspaceStoreClient.ts` — main-thread proxy
- `frontend/src/core/store.ts` — worker-side `WorkspaceStore` API
- `frontend/src/core/db/schema.ts` — SQLite schema and migrations

All database reads and writes run inside the worker. The database is serialized to a `Uint8Array` and persisted to IndexedDB.

### Sync engine

`frontend/src/core/sync.ts` implements the `SyncEngine`:

- **Push**: uploads pending operations from `sync_outbox` in encrypted envelopes.
- **Pull**: fetches the latest snapshot, restores it, and catches up newer operations from `/api/relay/catch-up`.
- **Conflict detection**: compares remote operations against pending local edits.

### Derived-state appliers

Operations are applied to the SQLite derived database by appliers in `frontend/src/core/derived/`:

- `node.ts` — node upserts
- `edge.ts` — reference extraction and edge rebuild
- `nodeStats.ts` — materialized count rebuild
- `childOrder.ts` — child ordering
- `property.ts` — property values
- `index.ts` — applier dispatch and change notifications

Appliers emit scoped notifications (`node`, `edge`, `tree`, `class`, `property`, `all`). `useGraphQuery` subscribers re-run only when their `shouldInvalidate` matches.

### Source-file reference

| File | Responsibility |
|------|----------------|
| `frontend/src/core/graphQueries/GraphQuery.ts` | Base query-object contract |
| `frontend/src/core/graphQueries/queryRegistry.ts` | Name → query dispatch registry |
| `frontend/src/core/graphQueries/queries/GetLinkedReferencesQuery.ts` | Linked-reference ID query |
| `frontend/src/core/graphQueries/queries/HydrateLinkedReferencesQuery.ts` | Linked-reference view-model hydration |
| `frontend/src/core/graphQueries/queries/GetNodeTreeQuery.ts` | Recursive subtree query |
| `frontend/src/core/graphQueries/queries/GetBacklinksQuery.ts` | Backlink id/count query |
| `frontend/src/core/graphQueries/hooks/useGraphQuery.ts` | React hook over worker queries |
| `frontend/src/core/projections/NodeSummaryProjection.ts` | Lightweight node summary |
| `frontend/src/core/projections/NodeTreeProjection.ts` | Flatten recursive tree rows |
| `frontend/src/core/projections/LinkedReferenceProjection.ts` | Build `LinkedReference` view models |
| `frontend/src/core/derived/nodeStats.ts` | Materialized count rebuild |
| `frontend/src/core/derived/edge.ts` | Reference extraction and edge rebuild |
| `frontend/src/core/derived/index.ts` | Operation applier dispatcher and notifications |
| `frontend/src/core/db/schema.ts` | SQLite schema and migrations |
| `frontend/src/core/query/queryNodes.ts` | QueryAST / search execution |
| `frontend/src/core/worker/workspaceWorker.ts` | Web Worker message dispatch |
| `frontend/src/core/worker/WorkspaceStoreClient.ts` | Main-thread client proxy |
| `frontend/src/core/worker/workerProtocol.ts` | Worker message types and notification scopes |
| `frontend/src/core/store.ts` | Worker-side WorkspaceStore API |
| `frontend/src/core/sync.ts` | SyncEngine push/pull/conflict logic |
| `frontend/src/features/content/hooks/useBlockTree.ts` | Block tree React hook |
| `frontend/src/features/content/hooks/useNodeLinkQueries.ts` | Linked-reference hooks |
| `frontend/src/features/content/hooks/useLinkedReferencesCount.ts` | Count badge hook |

---

## Verification before contributing

Before opening a pull request, run the verification commands from `AGENTS.md`:

```bash
# Backend
docker compose -f compose.dev.yaml exec backend uv run ruff check app/
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov

# Frontend
docker compose -f compose.dev.yaml exec frontend npm run lint
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
```

For more detail on the architecture, see [architecture.md](architecture.md).
