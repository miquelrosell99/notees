# Build, Development & Release

## Prerequisites

- Docker & Docker Compose
- [Task](https://taskfile.dev/) — task runner (optional but recommended)

## Quick Start (Docker Compose — Recommended)

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env and set SECRET_KEY and Postgres credentials

# Build and run the full development stack
# (backend + frontend + PostgreSQL + Redis with hot-reload)
task dev

# Or without Task:
# docker compose -f compose.dev.yaml up
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:8001

> Note: development services use non-default host ports (`8001` for the backend, `5433` for PostgreSQL, and `6380` for Redis) so Notees can coexist with other local services.

## Inside the Containers

Backend tests:

```bash
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov -v
```

Frontend lint/typecheck:

```bash
docker compose -f compose.dev.yaml exec frontend sh
npm run lint
```

## Local Development (Alternative — explicit opt-in only)

Only use this path if you explicitly choose not to use Docker for the running services. The default and recommended development workflow is `docker compose -f compose.dev.yaml up`.

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

## Production Docker

```bash
# Multi-stage build (builds frontend + backend image)
docker build -t notees .

# Run it
docker run -p 8000:8000 --env-file .env notees

# Or deploy with Docker Compose
export TAG=latest
docker compose up -d
```

## Mobile

```bash
cd mobile
./build-apk.sh
```

The debug keystore is checked into the repo intentionally (it is not a secret).

## Release Process

Releases are automated through `.github/workflows/release.yml`. Pushing a Git tag that matches `v*` triggers the workflow, which:

1. Builds and pushes a multi-arch (`linux/amd64`, `linux/arm64`) Docker image to `ghcr.io/miquelrosell99/notees`.
2. Builds the Android APK in Docker and attaches it to the GitHub release with a SHA-256 checksum.

Continuous integration for the Android app is handled by `.github/workflows/android.yml`, which builds the Flutter APK on every push or pull request that touches `mobile/**` and uploads it as a workflow artifact (no release is created).

### When to Push a New Tag

- Push a tag only when `main` is in a releasable state and the production Docker build has been verified locally:
  ```bash
  docker build -t notees:canary .
  ```
- Use semantic versioning (`vMAJOR.MINOR.PATCH`).
  - `PATCH` for bug fixes and small corrections.
  - `MINOR` for new features or significant dependency updates.
  - `MAJOR` for breaking changes to the data model, API, or deployment contract.
- Do **not** move an existing published tag. If a release is broken, cut a new version (e.g. `v0.2.1`).

### Creating a Release

```bash
# 1. Ensure main is up to date
git checkout main
git pull origin main

# 2. Pick the next version and tag it
VERSION=v0.3.0
git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"
```

The `Release` workflow will run automatically. You can monitor it under **Actions → Release**.

### Re-running a Release for an Existing Tag

If the workflow failed for a tag that already exists (for example, because of a CI-only issue), use the workflow dispatch input rather than moving the tag:

```bash
gh workflow run release.yml --ref main -f tag=v0.2.0
```

### Release Artifacts

| Artifact | Location | Notes |
|---|---|---|
| Docker image | `ghcr.io/miquelrosell99/notees:vX.Y.Z` | Multi-arch; also tagged `latest` on every release. |
| Android APK | Attached to GitHub release | Named `notees-android-vX.Y.Z.apk`; debug-signed with the repo keystore. |
| Checksum | Release notes + `.sha256` file | SHA-256 of the APK for verification. |

### Deploying a Release

Use `compose.yaml` for production deployments. It consumes the released image and uses named Docker volumes instead of bind-mounts.

```bash
# Copy and edit environment variables
cp .env.example .env
# Set SECRET_KEY, Postgres credentials, etc.

# Pull and run the released version
export TAG=v0.2.0
docker compose up -d
```

Do **not** use `compose.dev.yaml` in production: it only brings up infrastructure services and is optimized for local development.

### Local Release Verification

Before pushing a tag, verify the web app Docker image locally:

```bash
# Web app Docker image
docker build -t notees:canary .
```

**Android APK builds must run in GitHub Actions only.** Do not build the release APK locally. The Android workflow (`.github/workflows/android.yml`) builds and uploads the APK on every push or pull request that touches `mobile/**`, and the `release.yml` workflow attaches it to GitHub releases. See `mobile/AGENTS.md` for details.

## Docker Compose (Development)

The included `compose.dev.yaml` brings up:
- `postgres`: PostgreSQL 17
- `redis`: Redis 7 for real-time collaboration pub/sub
- `backend`: FastAPI with hot-reload, mounted source volumes
- `frontend`: Vite dev server on port 5173, proxying `/api` to the backend

**Remote/LAN access:** The Vite dev server restricts requests by `Host` header. To connect from another device (e.g., a phone over Tailscale or LAN), add the device hostname to `VITE_ALLOWED_HOSTS` in `.env` and recreate the frontend container:

```bash
# Example .env
VITE_ALLOWED_HOSTS=localhost,atlas,atlas.ts.net

# Recreate frontend to pick up the env change
docker compose -f compose.dev.yaml up -d --force-recreate frontend
```

## Production Docker Image

`Dockerfile` is a multi-stage build:
1. **Stage 1**: `node:22-alpine` builds the frontend.
2. **Stage 2**: `ghcr.io/astral-sh/uv:python3.13-bookworm` runs the backend with the built frontend copied into `app/static/dist`.

System dependencies in the production image include `libpango`, `libcairo2`, `fonts-liberation`, `libffi-dev`, and `libgdk-pixbuf` for WeasyPrint PDF generation. The container runs as non-root `appuser`, exposes port 8000, and has a healthcheck on `/api/auth/status`.
