# Testing Strategy

> Generic testing discipline is covered by `fastapi-patterns` and `react-ui-patterns`. The commands and project-specific setup below are Notees-specific.

## Backend Tests

Tests are in `tests/` and use **pytest** with async support. Unit tests in `tests/unit/` run in-memory with fake repositories/ports and do not require Docker or PostgreSQL. Integration tests run against the PostgreSQL container started by `compose.dev.yaml`.

### Test Tiers

Use these tiers during development and CI:

```bash
# Fast unit tests (no Docker, no DB)
uv run pytest tests/unit -m unit --no-cov

# Integration tests excluding slow (run inside the backend container)
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov

# Full suite with coverage (run inside the backend container)
docker compose -f compose.dev.yaml exec backend uv run pytest tests/
```

> Prefer unit tests for domain-service behavior. Use integration tests for endpoint contracts and cross-layer concerns. Mark slow tests with `@pytest.mark.slow`.

### Integration Run Inside the Dev Container

```bash
# 1. Ensure the dev stack is running
docker compose -f compose.dev.yaml up -d

# 2. Create the test database (one-time setup)
docker compose -f compose.dev.yaml exec postgres psql -U notees -c "CREATE DATABASE notees_test;"

# 3. Run integration tests inside the backend container
#    (compose.dev.yaml sets TEST_DATABASE_URL to the dev Postgres service,
#     so testcontainers is not needed inside the container)
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" -p no:cacheprovider --no-cov -v
```

If you run tests locally instead of inside the container, set `TEST_DATABASE_URL`:

```bash
TEST_DATABASE_URL=postgresql://notees:YOUR_PASSWORD@localhost:5433/notees_test uv run pytest tests/ -m "not slow" -p no:cacheprovider --no-cov -v
```

### Test Configuration (`pytest.ini`)

- `asyncio_mode = auto`
- Coverage target: `--cov-fail-under=30` (current baseline; raise only after coverage consistently exceeds a new threshold)
- Coverage reports to `htmlcov/`
- Markers: `slow`, `integration`, `unit`

### Fixtures (`tests/conftest.py`)

- `db_pool`: Initializes asyncpg pool, drops and recreates the `public` schema, and re-creates extensions + schema before every test. Explicitly drops `uuid-ossp` before the schema drop to avoid stale extension catalog entries; does **not** drop `pg_trgm` because that can segfault Postgres 17-alpine.
- `db_pool` also resets per-key rate-limit buckets (`PerKeyBucketFactory.reset_all()`) and clears the auth cache so tests do not inherit leftover request budgets or stale user data.
- `test_user`: Creates a unique test user + workspace and returns auth token.
- `client` / `authenticated_client`: `httpx.AsyncClient` against the FastAPI ASGI app.
- `node_repository`, `property_repository`, `link_repository`, `node_service`: Domain-layer fixtures wired to the test DB.

## Frontend Tests

```bash
cd frontend

# Run Vitest
npm run test

# Run once (CI)
npm run test:run

# Coverage
npm run test:coverage
```

Tests use Vitest with `jsdom`, `@testing-library/react`, and `@testing-library/jest-dom`. Test files exist in `frontend/src/tests/`.

## E2E tests (Playwright)

E2E specs live in `frontend/e2e/` with config at `frontend/playwright.config.ts` (`testDir: ./e2e`, `baseURL: http://localhost:5173`, single `chromium` project). Run them inside the frontend container:

```bash
# Browsers are NOT preinstalled in the dev image — install once (downloads to
# ~/.cache/ms-playwright, i.e. outside the repo; confirm with the user first):
docker compose -f compose.dev.yaml exec -T frontend npx playwright install chromium

# Run the suite (or a single spec)
docker compose -f compose.dev.yaml exec -T frontend npx playwright test
docker compose -f compose.dev.yaml exec -T frontend npx playwright test e2e/smoke.spec.ts
```

Auth for specs: the access token is an **HTTPOnly cookie** set by the backend (only the user profile is in `localStorage.user`). The browser talks to the API through the Vite proxy, so authenticate via `context.request` against the page origin so the cookie lands on `localhost:5173`:

```ts
await context.request.post('http://localhost:5173/api/auth/login', {
  data: { email, password, remember_me: true },
});
// cookie is now set for localhost:5173; mirror the profile so the SPA treats us as logged in:
await page.addInitScript((u) => localStorage.setItem('user', JSON.stringify(u)), user);
```

Caveat: a running dev DB usually already has an admin account whose password you don't know — don't wipe it. Prefer onboarding on a fresh/isolated DB (`POST /api/auth/register` when `GET /api/auth/status` reports `has_users === false`) or a freshly registered test user if registration is enabled.
