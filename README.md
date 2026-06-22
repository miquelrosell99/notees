# Notees

A self-hosted, privacy-first note-taking application with bidirectional linking and offline support.

![Python](https://img.shields.io/badge/python-3.13+-blue.svg)
![React](https://img.shields.io/badge/react-19-61dafb.svg)
![TypeScript](https://img.shields.io/badge/typescript-6-3178c6.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)

## AI-Assisted Development

This project was developed with the assistance of AI tools. AI was used throughout the development process to help design architecture, write code, and solve problems.

## Features

- **Bidirectional Linking** — Create connections between notes with `[[wiki-style]]` links. Backlinks are tracked automatically.
- **Block-Based Editor** — Outliner-style editing where every block can be referenced, embedded, or moved.
- **Daily Journal** — Built-in daily, monthly, and yearly journal pages with calendar navigation.
- **Types & Properties** — Organize notes with types and custom properties for powerful filtering.
- **Tasks** — Track todos inline or as dedicated task pages with status, priority, and due dates.
- **Offline-First** — Works without internet. Changes sync when you're back online.
- **Self-Hosted** — Your data stays on your server. No cloud dependencies.
- **Multi-Database** — Create separate knowledge bases for different projects or contexts.
- **Export** — Export notes to Markdown, HTML, or PDF.

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
│   ├── domain/             # Core business logic
│   │   ├── entities/       # Domain models (Node, User)
│   │   ├── services/       # Domain services
│   │   └── errors.py       # Domain exceptions
│   ├── db/                 # Database layer (asyncpg, PostgreSQL)
│   ├── routers/            # API endpoints
│   └── static/dist/        # Built frontend
├── frontend/               # Frontend (React 19 + TypeScript + Vite)
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── stores/         # Zustand state management
│   │   └── types/          # TypeScript types
│   └── vite.config.ts
├── mobile/                 # Mobile app (Flutter; Android + iOS)
├── tests/                  # Backend test suite (pytest)
└── data/                   # User data (gitignored)
```

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

## Architecture

Notees follows a **hexagonal architecture** (ports & adapters) pattern:

- **Domain Layer** — Pure business logic with no external dependencies
- **Application Layer** — Use cases that orchestrate domain operations
- **Infrastructure Layer** — Database and external service implementations
- **API Layer** — FastAPI routers that expose HTTP endpoints

### Node Types

The core concept is the **Node** — everything is a node with composable types:

| Type | Description |
|------|-------------|
| `PAGE` | A document/note that can contain blocks |
| `BLOCK` | Content within a page |
| `TAG` | Categorization (always also a page) |
| `PROPERTY` | Custom metadata schema (always also a page) |
| `DAILY` | Daily journal entry (always also a page) |
| `TASK` | Todo item (can be page or block) |

## API

The REST API is available at `/api/*`:

| Endpoint | Description |
|----------|-------------|
| `POST /api/auth/login` | Authenticate user |
| `GET /api/nodes` | List nodes |
| `POST /api/nodes` | Create node |
| `GET /api/nodes/{id}` | Get node by ID |
| `PUT /api/nodes/{id}` | Update node |
| `DELETE /api/nodes/{id}` | Delete node |
| `GET /api/search` | Search nodes |
| `GET /api/daily/{date}` | Get/create daily page |

## Configuration

Environment variables (or `.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | (required) | JWT signing key - must be set! |
| `POSTGRES_PASSWORD` | (required) | PostgreSQL password |
| `ADMIN_PASSWORD` | (unset) | Initial admin password - required for first-boot registration |
| `PUID` | `1000` | Host user ID for file permissions |
| `PGID` | `1000` | Host group ID for file permissions |
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

Contributions are welcome! Please read the contributing guidelines before submitting a pull request.

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
