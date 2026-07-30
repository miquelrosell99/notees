# Notees

A self-hosted, privacy-first, local-first note-taking application with bidirectional linking and offline support.

![Python](https://img.shields.io/badge/python-3.12+-blue.svg)
![React](https://img.shields.io/badge/react-19-61dafb.svg)
![TypeScript](https://img.shields.io/badge/typescript-6-3176c6.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)

## AI-Assisted Development

This project was developed with the assistance of AI tools. AI was used throughout the development process to help design architecture, write code, and solve problems.

## Features

- **Local-First / Offline-First** — Your workspace data lives in a client-side SQLite database. Edits happen instantly and sync when you're back online.
- **End-to-End Encryption** — Workspace-private operation payloads are encrypted before reaching the server.
- **Bidirectional Linking** — Create connections between notes with `[[wiki-style]]` links and `node_link` pills. Backlinks are tracked automatically.
- **Block-Based Editor** — Outliner-style editing where every block can be referenced, embedded, or moved.
- **Daily Journal** — Built-in daily, monthly, and yearly journal pages with calendar navigation.
- **Types & Properties** — Organize notes with classes and custom properties for powerful filtering.
- **Tasks** — Track todos inline or as dedicated task pages with status, priority, and due dates. A top-bar Tasks popup shows overdue, today, upcoming, and unscheduled tasks.
- **Queries & Collections** — Build structured queries with the visual query builder and view results as lists, tables, kanban boards, calendars, and more. Run temporary ad-hoc queries or save them as views.
- **Graph View & Whiteboard** — Explore your knowledge graph interactively, or sketch on an infinite canvas.
- **Flashcards** — Create and study cloze-deletion flashcards.
- **Self-Hosted** — Your data stays on your server. No cloud dependencies.
- **Multi-Workspace** — Create separate knowledge bases for different projects or contexts.
- **Plugin System** — Extend Notees with built-in or user-installed plugins (importers, export formats, commands).
- **Export** — Export notes to Markdown, HTML, or PDF.

## Web vs. Mobile App

The mobile app is a first-class native companion. It covers the workflows most useful on phones, while the web app remains the full-featured desktop editing surface. The Flutter mobile app lives in its own repository: [miquelrosell99/notees-flutter](https://github.com/miquelrosell99/notees-flutter).

| Feature | Web app | Mobile app |
|---------|:-------:|:----------:|
| Page editing | ✅ | ✅ (plain-text blocks) |
| Block-based / outliner editing | ✅ | ❌ |
| Rich inline formatting (bold, links, code) | ✅ | ❌ |
| Bidirectional `[[links]]` | ✅ | ✅ (rendered as text, still parsed on save) |
| Daily journal | ✅ | ✅ |
| Task lists | ✅ (top-bar Tasks popup) | ✅ (dedicated Tasks tab) |
| Search with filters | ✅ | ✅ |
| Favorites | ✅ | ✅ |
| Recents | ✅ | ✅ |
| List / card / table views | ✅ | ✅ |
| Properties & types | ✅ | ❌ |
| Queries / database views | ✅ | ❌ |
| Whiteboard | ✅ | ❌ |
| Graph view | ✅ | ❌ |
| Timeline / Gantt / Calendar views | ✅ | ❌ |
| Export (Markdown, HTML, PDF) | ✅ | ❌ |
| Offline-first | ✅ | ✅ (native UI + quick capture) |
| Biometric app lock | ❌ | ✅ |
| Multi-server management | ❌ | ✅ |
| Native quick capture | ❌ | ✅ |

## Quick Start

Notees is developed and deployed with **Docker Compose**. The development stack runs backend, frontend, PostgreSQL, and Redis in containers with hot-reload.

### Prerequisites

- [Docker & Docker Compose](https://docs.docker.com/compose/)
- [Task](https://taskfile.dev/installation/) (optional but recommended) — dev task runner

### Development

```bash
# Copy environment file and configure
cp .env.example .env
# Edit .env and set a secure SECRET_KEY!

# Build and run the full development stack
task dev

# Or without Task:
# docker compose -f compose.dev.yaml up
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:8001

> Note: development services use non-default host ports (`8001` for the backend, `5433` for PostgreSQL, and `6380` for Redis) so Notees can coexist with other local services.

### Production

```bash
# Copy environment file and configure
cp .env.example .env
# Edit .env and set a secure SECRET_KEY!

# Build the production image (frontend + backend)
docker build -t notees .

# Run it
docker run -p 8000:8000 --env-file .env notees

# Or deploy with Docker Compose (uses the released image by default)
export TAG=latest
docker compose up -d
```

**Docker files:**
- `Dockerfile` — Production multi-stage build (builds frontend + backend)
- `Dockerfile.dev` — Development backend with hot-reload
- `frontend/Dockerfile.dev` — Development frontend build stage
- `compose.yaml` — Production deployment
- `compose.dev.yaml` — Development deployment (backend + frontend + PostgreSQL + Redis)
- `.dockerignore` — Files to exclude from Docker builds

## Project Structure

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
├── agents/                 # Developer/agent reference docs
├── docs/                   # User-facing documentation
├── scripts/                # Utility scripts
└── data/                   # User data (gitignored)
```

## Architecture

Notees is a **local-first**, self-hosted note-taking application:

1. **Client edits** append operations to a local SQLite database.
2. **Operations** are relayed through `app/relay/` and can be end-to-end encrypted.
3. **Other clients** pull operations and rebuild their derived SQLite state.
4. **PostgreSQL** persists users, workspace membership, share metadata, and the operation log.

For the full technical architecture — data model, query layer, rendering pipeline, sync protocol, and key source files — see [docs/architecture.md](docs/architecture.md).

## API

The REST API is available at `/api/*` (also mirrored under `/api/v1/*`):

| Endpoint | Description |
|----------|-------------|
| `POST /api/auth/login` | Authenticate user |
| `POST /api/relay/batch` | Push encrypted operations to the relay |
| `GET /api/relay/catch-up` | Pull encrypted operations from the relay |
| `POST /api/daily` | Get or create the daily page for a date |
| `POST /api/nodes/views/execute` | Run an ad-hoc QueryAST (no saved view needed) |

Legacy `/api/nodes/*` and `/api/properties/*` mutable-row endpoints have been removed; the frontend now reads and writes through the local SQLite store and syncs via `/api/relay/*`.

## Development

### Full Stack (Docker Compose — Recommended)

```bash
# Copy environment file and configure
cp .env.example .env
# Edit .env and set SECRET_KEY and POSTGRES_PASSWORD

# Build and run backend + frontend + Postgres + Redis
task dev

# Run tests inside the backend container
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov -v
```

### Backend

Inside the running backend container:

```bash
docker compose -f compose.dev.yaml exec backend bash

# Run tests
uv run pytest tests/ -m "not slow" --no-cov -v

# Lint
uv run ruff check app/
```

### Frontend

Inside the running frontend container:

```bash
docker compose -f compose.dev.yaml exec frontend sh

# Development server (already running via compose)
# Type checking
npm run typecheck

# Production build
npm run build

# Linting
npm run lint
```

### Local Development (Alternative — explicit opt-in only)

Only use this path if you explicitly choose not to use Docker for the running services. The default and recommended development workflow is `task dev` or `docker compose -f compose.dev.yaml up`.

```bash
# Install local dependencies
uv sync --all-groups
cd frontend && npm install

# Start only Postgres and Redis in Docker
docker compose -f compose.dev.yaml up postgres redis -d

# Terminal 1 — backend
uv run uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload --reload-dir app

# Terminal 2 — frontend
cd frontend && npm run dev
```

For local development you also need the PostgreSQL 17 client (`pg_dump`) installed on your host.

## Configuration

Environment variables (or `.env` file — see `.env.example` for the full list):

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | (required) | JWT signing key (min 32 characters) - must be set! |
| `POSTGRES_PASSWORD` | (required) | PostgreSQL password |
| `ADMIN_PASSWORD` | (unset) | Initial admin password - required for first-boot registration |
| `REGISTRATION_ENABLED` | `false` | Allow open user registration |
| `ENVIRONMENT` | `development` | Set to `production` for HSTS/HTTPS redirect and short-lived tokens |
| `CORS_ORIGINS` | (unset) | Comma-separated allowed origins; disabled by default |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `localhost` / `5433` | PostgreSQL connection |
| `POSTGRES_USER` / `POSTGRES_DB` | `notees` | PostgreSQL user and database |
| `REDIS_URL` | `redis://localhost:6380/0` | Redis (rate limiting, real-time broadcast) |
| `PORT` | `8001` | Backend port for local runs |
| `PUID` / `PGID` | `1000` | Host user/group IDs for file permissions |
| `TZ` | `UTC` | Container timezone |
| `LOG_LEVEL` | `INFO` | Logging verbosity |

### Security Configuration

**⚠️ IMPORTANT: Before running in production, you MUST configure security settings!**

#### Required Environment Variables

Before running in production, you MUST configure:

**1. SECRET_KEY** - A secure random string for JWT signing

The `SECRET_KEY` is required and must be at least 32 characters:

```bash
# Generate a secure key
python scripts/generate_secret_key.py

# Or manually:
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Add the generated key to your `.env` file:
```bash
SECRET_KEY=your-generated-secret-key-here
```

**2. ADMIN_PASSWORD** - Initial admin password (required for first-boot registration)

If no admin user exists, the first registration is allowed **only** when `ADMIN_PASSWORD` is set to a strong password (at least 12 characters with uppercase, lowercase, digit, and special character). The registrant must provide this exact password during registration; the first admin account is created with `ADMIN_PASSWORD`.

If `ADMIN_PASSWORD` is unset, empty, or too weak, first-boot registration is rejected and the instance stays locked. You can still bootstrap an admin manually with:

```bash
python scripts/promote_user_to_admin.py <email>
```

**Recommended:** Set a specific password before first startup:
```bash
ADMIN_PASSWORD=your-secure-password-here
```

#### Security Checklist

Before deploying to production:

- [ ] Set strong `SECRET_KEY` (minimum 32 characters)
- [ ] Set a strong `ADMIN_PASSWORD` before first startup
- [ ] Enable HTTPS in production
- [ ] Set up database backups (automatic with PostgreSQL)
- [ ] Review rate limiting settings
- [ ] Regularly update dependencies
- [ ] Monitor application logs for security issues


## Contributing

Contributions are welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Notees is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

This ensures the software remains free and open-source, even when used over a network. If you modify and deploy Notees as a web service, you must make your source code available to users.

See the [LICENSE](LICENSE) file for the full license text.

## Acknowledgments

Inspired by tools like Roam Research, Logseq, and Obsidian. Built with FastAPI, React, and PostgreSQL.
