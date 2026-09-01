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

## Dev Environment Quirks

- uvicorn `--reload` does not reliably pick up mounted-source changes; after backend edits, verify the container has the new code and `docker compose -f compose.dev.yaml restart backend` (no rebuild) if in doubt.
- `tests/` has ~20 standing environmental failures, not regressions: `tests/unit/plugins/builtin/test_pdf_lookup.py` fails collection (missing `pypdf`), `test_relay_protocol_fixtures.py` needs `/app/protocol` (not mounted), `test_system_uuid_parity.py` needs `/app/frontend` (not mounted), one WS frame-ordering flake in `test_relay_ws.py`. Rerun with `--ignore=tests/unit/plugins/builtin/test_pdf_lookup.py` to get past collection.
- Postgres storage tests need the `notees_test` database; it is not auto-created in the dev `db` container (`TEST_DATABASE_URL` points at it). Create it once with `CREATE DATABASE notees_test;`.

## Full Build / Release

See `references/agents/build-and-release.md` for production build and release details.

## E2E / Playwright

See `references/agents/testing.md` for test tiers, fixtures, and E2E details.
