# Project Structure — Notees

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
├── skills/notees/           # Agent skill (rules, workflows, references)
├── docs/                    # User-facing documentation only
├── scripts/                 # Utility scripts
├── data/  logs/             # User data, assets, backups, logs (gitignored)
├── compose.yaml             # Docker Compose (production)
├── compose.dev.yaml         # Docker Compose (development services)
├── Dockerfile               # Production multi-stage build
├── Taskfile.yml             # Common development tasks
└── pyproject.toml           # Python metadata, Ruff, mypy config
```

## Documentation Layout

- `skills/notees/` — Agent reference docs and skill routing.
- `skills/notees/references/agents/plans/` — Implementation plans and working documents.
- `docs/` — User-facing documentation only (e.g. `docs/SECURITY.md`). Never put agent reference material or plans in `docs/`.
