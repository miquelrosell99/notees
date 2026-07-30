# Troubleshooting

This guide covers common issues when installing, running, or developing Notees.

---

## Installation and startup

### First-boot registration is rejected

**Symptom:** The registration form shows an error and no admin user is created.

**Causes / fixes:**

- `ADMIN_PASSWORD` is unset or does not meet complexity requirements. It must be at least 12 characters and contain uppercase, lowercase, digit, and special character.
- `SECRET_KEY` is missing or shorter than 32 characters. Generate one with `python scripts/generate_secret_key.py`.
- `POSTGRES_PASSWORD` is not set or does not match the value used by the PostgreSQL container.

### Cannot connect to PostgreSQL or Redis

**Symptom:** The backend container fails its health check or logs connection errors.

**Fixes:**

- Ensure `compose.dev.yaml` services are healthy: `docker compose -f compose.dev.yaml ps`.
- Verify `.env` values match the container environment. Inside Docker the backend uses `postgres:5432` and `redis://redis:6379/0`; on the host the mapped ports are `5433` and `6380`.
- If you changed `.env` after the first start, recreate the containers: `docker compose -f compose.dev.yaml up -d --force-recreate`.

### Port already in use

**Symptom:** `bind: address already in use` when starting the dev stack.

**Fix:** The dev stack uses non-default ports (`5173`, `8001`, `5433`, `6380`) to avoid conflicts. If one is still occupied, stop the conflicting service or override the port mapping in `compose.dev.yaml`.

---

## Frontend loading and runtime

### "Loading notees" hangs or the page stays blank

**Causes / fixes:**

- The Web Worker failed to initialize `sql.js`. Check the browser console for WASM or IndexedDB errors.
- A previous worker is stuck or terminated. Reload the page; if the issue persists, clear site data for the origin and reload.
- The workspace database is large and the initial snapshot restore is slow. Wait for the progress indicator; catch-up after a snapshot is bounded by operations newer than the snapshot HLC.

### Duplicate workspace databases or stale data after switching workspaces

**Fix:** The worker and IndexedDB state are scoped per workspace. If a workspace switch appears to show the previous workspace, reload the page. The `WorkspaceStoreInitializer` cleanup effect closes the previous workspace when `workspaceId` changes.

---

## Sync and data correctness

### Local edits disappear after a network mutation

**Likely cause:** Debounced save / query invalidation boundary race. `useContentSave` debounces content changes; if a sync pull arrives and invalidates the query before the local operation is persisted, the stale server state may overwrite the local edit.

**Fix:** This is a known class of issue addressed by the stability plan. Ensure the app is on the latest commit and report reproducible cases.

### Sync shows error or backend unavailable

**Fixes:**

- Check that the backend is reachable from the browser (network tab, CORS errors).
- The app will queue edits locally and retry. A dismissible warning banner is shown for short outages; a full lock is applied only after a longer threshold.
- Verify the WebSocket connection for real-time broadcasts if using multiple clients.

### Session expiry loops

**Symptom:** The app keeps redirecting to `/auth` after login.

**Fix:** In `AuthenticatedShell`, session expiry is handled by checking `authStatus.authenticated === false` and redirecting before loading workspaces. Clear cookies and log in again. If the issue persists, verify `SECRET_KEY` and token lifetimes in `.env`.

---

## Performance

### Large pages with many linked references are slow

**What is expected:**

- Backlink count badges are fast (materialized in `node_stats`).
- The "Linked references" section is collapsed by default; IDs are fetched only on expansion.
- Hydration of backlinked rows is deferred until visible.

**If it is still slow:**

- Very large linked-reference lists are not virtualized; rendering thousands of rows can stress React.
- `HydrateLinkedReferencesQuery` resolves properties and class metadata per source id. Consider collapsing sections or reducing the number of backlinks.

### Block tree expansion is slow

**Fix:** `useBlockTree` now fetches the whole visible subtree in one recursive `GetNodeTreeQuery` and batch-projects visible ids. If a page is still slow, check for an extremely deep or wide subtree and collapse branches.

### Search is slow or returns no results

**Fix:**

- Search runs against the local FTS4 `search_index` table. Rebuild is triggered automatically when node content changes.
- If results look stale, reload the workspace to force a fresh snapshot restore.
- CJK text is tokenized character-by-character; phrase queries are disabled to prevent FTS4 syntax injection.

---

## Development

### Backend tests fail with database errors

**Fix:** Ensure Postgres and Redis are running (`task services` or `docker compose -f compose.dev.yaml up postgres redis -d`). Some tests require a fresh test database and will create it automatically if permissions allow.

### Frontend lint or type check fails

**Fix:** Run inside the frontend container:

```bash
npm run lint
npx tsc -b --noEmit
```

Address new errors introduced by your changes. Pre-existing warnings may remain.

### Local development: `pg_dump` not found

**Fix:** Install the PostgreSQL 17 client tools on your host. The local backend uses `pg_dump` for some operations.

---

## Security checklist before production

If something feels off, re-check the production security baseline:

- [ ] Strong `SECRET_KEY` (minimum 32 characters).
- [ ] Strong `ADMIN_PASSWORD` set before first startup.
- [ ] `ENVIRONMENT=production`.
- [ ] HTTPS enabled with valid certificates.
- [ ] `CORS_ORIGINS` set explicitly.
- [ ] Database backups configured.
- [ ] Rate limiting reviewed.
- [ ] Dependencies up to date.
- [ ] Logs monitored.

See [Configuration](configuration.md) and [SECURITY.md](SECURITY.md) for details.
