# Operations, Debugging & Performance

## Debugging Conventions

- **Race condition triage**: If a bug involves "local change disappears after a network mutation" (e.g., typed text reappears, inline pill vanishes after adding a class/tag), check the **debounced save / query invalidation boundary FIRST** before tracing DOM or editor logic. The frontend debounces content saves (`useContentSave`) while mutations like `addClass` invalidate queries immediately. A refetch can return stale server-side content and overwrite the editor's local state. Always verify whether `flushAllContentSaves()` or an equivalent flush is needed before firing the mutation.
- **Root causes over local fixes**: When symptoms look like a local editor bug (popup not closing, text not removed, selection wrong), step back and check cross-layer interactions — especially between Lexical editor state, `OperationRuntime` projections, TanStack Query cache updates, and debounced persistence.

## Decision-Making & Planning

- **Multi-file changes**: If a task touches more than 2–3 files, spans both frontend and backend, or changes interfaces/schemas, use **plan mode** (`EnterPlanMode`) and get user approval before writing code.
- **Always verify**: After code changes, run the relevant linter/test suite before finishing.
  - Backend (inside container): `docker compose -f compose.dev.yaml exec backend uv run ruff check app/` and `docker compose -f compose.dev.yaml exec backend uv run pytest tests/ -m "not slow" --no-cov`.
  - Frontend (inside container): `docker compose -f compose.dev.yaml exec frontend npm run lint` and `docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit`.
  - Only fall back to host-local commands (`uv run ...`, `cd frontend && npm ...`) when the user explicitly says they are not using Docker.
- **Fix all test failures**: If tests fail after your changes — even failures that appear unrelated to your task — you must fix them before finishing. Do not leave the test suite broken.

## Performance Notes & Accepted Tech Debt

The fleet migration resolved the high-severity performance issues. The remaining shortcuts below are intentional and documented; do not paper over them with defensive code.

- **Immersive views are client-side capped**: `NodeCollection` feeds at most `IMMERSIVE_VIEW_NODE_LIMIT = 500` nodes to `graph`, `timeline`, `gantt`, `calendar`, `chart`, and `pivot` views. A real fix requires server-side aggregation/pagination for each view mode; until then, the cap prevents UI lockups.
- **Gantt label pane is virtualized**: Only visible label rows are rendered in the DOM. The canvas right pane still draws every bar; with the 500-node cap this is acceptable.
- **Timeline is event-driven**: The permanent `requestAnimationFrame` loop was removed; canvas renders are triggered by dependency changes. Event hit-testing uses an x-sorted spatial index for O(log n) lookups.
- **Exports are asynchronous jobs**: `POST /export` and `GET /export/{uuid}` return `{job_id}`. Callers must poll `GET /export/jobs/{job_id}` and download from `GET /export/jobs/{job_id}/download`. Jobs are stored in memory and results are written to `data/exports`; they do not survive a backend restart.

## Code Style & Linting

> Generic Python and TypeScript/React style rules are covered by `fastapi-patterns` and `react-ui-patterns`. Project-specific enforcement tools are listed below.

- **Backend**: Ruff is configured in `pyproject.toml` (target py312, line-length 120, Google docstyle convention, select E/W/F/I/N/UP/B/C4/SIM). Prefer running inside the container: `docker compose -f compose.dev.yaml exec backend uv run ruff check app/`. Fall back to host-local `uv run ruff check app/` only when not using Docker.
- **Frontend**: ESLint (flat config) with `@eslint/js`, `typescript-eslint`, `react-hooks`, `react-refresh`, and `jsx-a11y`. Prefer running inside the container: `docker compose -f compose.dev.yaml exec frontend npm run lint`. Fall back to host-local `cd frontend && npm run lint` only when not using Docker.
- **Design System Validator**: `frontend/scripts/validate-design-system.js` catches hardcoded pixel values in spacing/layout properties. It uses a baseline (`scripts/.design-system-baseline.txt`) that grandfathers existing violations, so only *new* violations fail the build.
  ```bash
  # Inside the frontend container
  docker compose -f compose.dev.yaml exec frontend sh
  node scripts/validate-design-system.js              # check for new violations
  node scripts/validate-design-system.js --update-baseline  # after fixing a batch
  ```
- **Dead code detector**: `cd frontend && npx knip` finds unused exports and files. Run inside the frontend container when the dev stack is up.

## Configuration & Environment Variables

All configuration is centralized in `app/config.py` using **pydantic-settings**. Values are read from `.env` (or environment variables).

**Required:**
| Variable | Description |
|----------|-------------|
| `SECRET_KEY` | JWT signing key. **Must be >= 32 chars.** Generate with `python scripts/generate_secret_key.py` |
| `POSTGRES_PASSWORD` | PostgreSQL password. Used by both the database container and the app. |

**Docker:**
| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `1000` | Host user ID for file ownership on bind mounts |
| `PGID` | `1000` | Host group ID for file ownership on bind mounts |
| `TZ` | `UTC` | Container timezone |

**Important:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | (unset) | Initial admin password. If set and no admin exists on startup, an admin user is created automatically. Must be at least 12 characters with uppercase, lowercase, digit, and special character. If unset, or set but too weak, and no admin exists, both automatic admin creation and first-boot registration are rejected until a valid password is configured or an admin is created with `scripts/promote_user_to_admin.py`. When first-boot registration is allowed, the registrant must supply the configured `ADMIN_PASSWORD` in the registration request; the first admin is created with `ADMIN_PASSWORD`, not the registrant's chosen password. |
| `ACCESS_TOKEN_EXPIRE_HOURS` | `0.25` prod / `8.0` dev | JWT access token lifetime. Production defaults to 15 minutes; development defaults to 8 hours to avoid constant re-logins. |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `7` prod / `30` dev | Refresh token lifetime. Production defaults to 7 days; development defaults to 30 days. |
| `REFRESH_TOKEN_REMEMBER_ME_DAYS` | `90` | Refresh token lifetime when "Remember me" is checked. |
| `REFRESH_TOKEN_REUSE_GRACE_SECONDS` | `30` | One-time grace window for a rotated refresh token to be reused (prevents multi-tab logout races). |
| `LOG_LEVEL` | `INFO` | Logging verbosity |
| `BACKUP_INTERVAL_SECONDS` | `3600` | Automatic backup interval |
| `MAX_BACKUPS` | `50` | Max backup files to keep |
| `POSTGRES_POOL_MIN` | `5` | Connection pool minimum size |
| `POSTGRES_POOL_MAX` | `50` | Connection pool maximum size |

**PostgreSQL connection pool tuning:**
- `POSTGRES_POOL_MAX_INACTIVE_TIME` (default 300s)
- `POSTGRES_STATEMENT_CACHE_SIZE` (default 100)

See `.env.example` for the full template.

## Common Pitfalls

- **Do not** use `pool.acquire()` directly in domain services or routers. Use `get_connection()` or `get_transaction()` from `app.db.connection`.
- **Do not** forget to set `SECRET_KEY` before running. The app will crash at startup with a clear validation error.
- **Do not** run the dev PostgreSQL settings (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`) in production. They are explicitly set only in `compose.dev.yaml`.
- **Do not** recommend bare `npm run dev`, `uvicorn app.main:app --reload`, or other host-local runtime commands as the default way to run the app in development. The canonical entry points are the `backend` and `frontend` services in `compose.dev.yaml`. Host-local commands are only for the explicit opt-in alternative path.
- **Do not** assume `run_dev.py` or `run.py` exists at the project root.
- When building the Docker image, the frontend build stage outputs to `./dist` inside the container and is copied to `app/static/dist` in the final stage.
- The frontend build uses `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers to enable `SharedArrayBuffer` (required for sql.js/WebAssembly features).
- The `README.md` is kept up to date with the current stack. For the canonical version list, check `pyproject.toml`, `package.json`, and the AGENTS.md Technology Stack table.
- **Caret-anchored editor popups (`InlineTriggers`)**: when a slash/`@`/`#`/`+` trigger opens a follow-on popup (e.g. the `/date` calendar), anchor it to the caret rect captured **at trigger-open time** — `popup.position` on the trigger state, also held in `slashAnchorRef` inside `frontend/src/features/editor/custom/plugins/InlineTriggers.tsx`. Do **not** re-read the caret with `getCaretCoordinates()` after the trigger text has been deleted: the live DOM selection is unreliable then and the helper falls back to the editor root's bounding rect, which can be off-screen and strand the popup (symptom: calendar pinned to the bottom-right corner). Avoid the zero-size-`<span>` + `getBoundingClientRect` round-trip for caret anchoring. The shared `useViewportFlip` (`frontend/src/hooks/useViewportFlip.ts`) always clamps the final `top`/`left` into the viewport as a safety net, but that only keeps the popup visible — a correct open-time anchor is what makes it land at the caret. Note: flip/clamp logic currently exists in two places (`TriggerPopup`'s inline math and `useViewportFlip`); unifying them is the intended cleanup so a third popup cannot reintroduce this.
- **`position: fixed` is trapped by transformed ancestors**: several layout containers use `transform` / `will-change: transform` for open/close animation (e.g. `features/layout/components/Layout.css`), and any such ancestor becomes the containing block for `position: fixed` descendants. A fixed anchor element rendered inside the editor tree is therefore offset by that ancestor and can strand the popup (symptom: popup clamped to the right edge while vertical looks fine). Anchor elements for caret popups must be portaled to `document.body` (see `InlineTriggers`) so their fixed coordinates are viewport-relative — matching `TriggerPopup`, which renders at body level.
