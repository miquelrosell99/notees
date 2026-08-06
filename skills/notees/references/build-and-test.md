# Build and Test — Notees

The canonical development workflow is Docker Compose: `task dev` (or `docker compose -f compose.dev.yaml up`).

- Frontend: http://localhost:5173
- Backend API: http://localhost:8001
- Dev services use non-default host ports (`8001` backend, `5433` PostgreSQL, `6380` Redis) to coexist with other local services.

## Verify After Changes

```bash
# Inside containers
docker compose -f compose.dev.yaml exec backend uv run ruff check app/
docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov
docker compose -f compose.dev.yaml exec frontend npm run lint
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
```

## Fast Unit Tests

```bash
uv run pytest tests/unit -m unit --no-cov
```

## Frontend Tests

```bash
cd frontend && npm run test:run
```

## Runtime Behavior Fixes

For routes, request/response schemas, sync mappers, build output, or container startup changes, rebuild the dev stack:

```bash
docker compose -f compose.dev.yaml down && docker compose -f compose.dev.yaml up --build
```

Then confirm behavior in the browser.

## Full Build / Release

See `references/agents/build-and-release.md` for production build and release details.

## E2E / Playwright

See `references/agents/testing.md` for test tiers, fixtures, and E2E details.
