# Installation

Notees is developed and deployed with **Docker Compose**. The recommended path is to run the full stack in containers; a local-development alternative is documented below but requires explicit opt-in.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/)
- [Task](https://taskfile.dev/installation/) (optional) — dev task runner used by `Taskfile.yml`
- For local development outside Docker: PostgreSQL 17 client tools (`pg_dump`) on the host

---

## Development stack

The development stack runs the backend, frontend, PostgreSQL, and Redis in containers with hot-reload. Services use non-default host ports so Notees can coexist with other local services:

| Service | Host port | Container port |
|---------|-----------|----------------|
| Frontend (Vite) | 5173 | 5173 |
| Backend API | 8001 | 8000 |
| PostgreSQL | 5433 | 5432 |
| Redis | 6380 | 6379 |

### 1. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and set at least:

- `SECRET_KEY` — a random string of at least 32 characters (see [Configuration](configuration.md#secret_key))
- `ADMIN_PASSWORD` — strong initial admin password (see [Configuration](configuration.md#admin_password))
- `POSTGRES_PASSWORD` — PostgreSQL password

### 2. Start the stack

```bash
# With Task (recommended)
task dev

# Or directly with Docker Compose
docker compose -f compose.dev.yaml up
```

### 3. Open the app

- Frontend: http://localhost:5173
- Backend API: http://localhost:8001

`compose.dev.yaml` bind-mounts source directories for hot-reload and disables PostgreSQL durability settings for speed. Do not use `compose.dev.yaml` in production.

### Development Docker files

| File | Purpose |
|------|---------|
| `Dockerfile.dev` | Development backend with hot-reload |
| `frontend/Dockerfile.dev` | Development frontend build stage |
| `compose.dev.yaml` | Development deployment (all services) |
| `.dockerignore` | Files excluded from Docker builds |

---

## Production deployment

### Build the production image

`Dockerfile` is a multi-stage build that compiles the frontend and bakes it into the backend image:

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env: set SECRET_KEY, ADMIN_PASSWORD, POSTGRES_PASSWORD, ENVIRONMENT=production

# Build the image
docker build -t notees .
```

### Run the image

```bash
docker run -p 8000:8000 --env-file .env notees
```

### Deploy with Docker Compose

`compose.yaml` uses the released image and production-ready settings:

```bash
export TAG=latest
docker compose up -d
```

Production defaults:

- Backend listens on port `8000` (override with `NOTES_PORT` in `.env`)
- PostgreSQL and Redis use named volumes
- Health checks are enabled for all services
- Set `ENVIRONMENT=production` to enable HSTS/HTTPS redirect and short-lived JWT tokens

See [Configuration](configuration.md) for the full environment variable reference and security checklist.

### Web-only deployment (no server)

`Dockerfile.web` builds a static frontend image (nginx) that runs **local-only**:
all data stays in the browser (IndexedDB), no login, no sync. Useful for trying
Notees or for single-device use.

```bash
docker build -f Dockerfile.web -t notees-web .
docker run -p 8080:80 notees-web
```

Or with Compose (the `web` service lives in the main `compose.yaml` alongside the
sync server; it is optional since the backend image already serves the UI):

```bash
NOTEES_SERVER_URL= docker compose up -d web
```

To attach a sync server later, either set it at container start:

```bash
docker run -p 8080:80 -e NOTEES_SERVER_URL=https://notes.example.com notees-web
```

or configure the server URL in the app's settings (a full reload applies it).
The all-in-one image above remains the default and is unchanged.

---

## Local development (alternative)

Only use this path if you explicitly choose not to use Docker for the running services.

```bash
# Install backend and frontend dependencies
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

---

## First-boot registration

When `ADMIN_PASSWORD` is set and no admin user exists, the first registration request that supplies the exact `ADMIN_PASSWORD` creates the first admin account with that password. If `ADMIN_PASSWORD` is unset or too weak, the instance stays locked until a valid password is set and the server is restarted, or until you bootstrap an admin manually:

```bash
python scripts/promote_user_to_admin.py <email>
```

See [Configuration](configuration.md#admin_password) for the password requirements.
