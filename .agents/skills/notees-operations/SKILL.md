---
name: notees-operations
description: Operate a Notees deployment — the notees-sync (:8377) + notees-web (:8378) docker compose stack with data under ./config/notees/. Use when deploying, upgrading, restarting, health-checking, rolling back, backing up, migrating, monitoring, or troubleshooting the Notees stack on the fleet host. Covers deployment, health checks, logs, rollback, database migrations, backups, monitoring, incident response, and maintenance.
---

# Notees operations

Production stack = two containers from `compose.yaml`:

- `notees-sync` — image `ghcr.io/miquelrosell99/notees-sync:${NOTEES_SYNC_TAG:-latest}`, host port 8377, volume `./config/notees/sync:/data`
- `notees-web` — image `ghcr.io/miquelrosell99/notees-web:${NOTEES_WEB_TAG:-latest}`, host port 8378 (nginx :80), `depends_on: service_healthy` on sync

Data layout under the bind-mounted data dir (canonical
`docs/developers/deployment.md`): `relay.db` (**THE authority** — envelope
log, snapshot/compaction metadata, asset index, restore_epoch),
`api_key.txt` (mode 0600), `snapshots/<id>.db` (optional),
`derived/<workspaceId>.db` (**cache — deletable, rehydrates from the log**),
`workspaces/<ws>/assets/<hash[:4]>/<hash>` (CAS bytes).
**`relay.db` + `workspaces/` + `api_key.txt` = the whole dataset.**

## Non-negotiable laws

1. **Never edit or copy `relay.db` while the server is running** — stop the
   container first (or use the snapshot endpoints).
2. **Compose has no `build:` by design** — images come from ghcr (`:latest` by
   default) or a local `docker build`; pin versions with `NOTEES_SYNC_TAG` /
   `NOTEES_WEB_TAG`.
3. **After any log-rewriting migration:** bump the restore epoch **and**
   `docker compose restart notees-sync` — ingest alone does not reapply to the
   running derived store (learned 2026-10-05, `migrations.md`).
4. **Store downgrade is unsupported** — a derived DB newer than the code is a
   hard error; the way back is a backup restore.
5. **Never re-tag a release.** Same-day correction = next patch tag.
6. **Fleet-agnostic artifacts** — never hardcode host names, IPs, or tailnet
   names; write `<host>`, `<tailnet>`, `<lan-ip>`, "the fleet host". Real
   values live only in gitignored `.env`.
7. **Deployment and rollback discipline follows the `deployment-runbook`
   skill** — pre-deployment checklist, health checks before/after, rollback
   triggers and postmortems. If it is not installed in this environment, fetch
   and follow it from GitHub:
   <https://github.com/majiayu000/claude-skill-registry/blob/main/skills/data/deployment-runbook/SKILL.md>

## Read by topic

| Topic | Reference | Canonical runbook |
|---|---|---|
| Deployment | `references/deployment.md` | `docs/developers/deployment.md`, `releases.md` |
| Health checks | `references/health-checks.md` | `deployment.md` |
| Logs | `references/logs.md` | `deployment.md` |
| Rollback | `references/rollback.md` | `releases.md` |
| Database migrations | `references/database-migrations.md` | `docs/developers/migrations.md` |
| Backups | `references/backups.md` | `deployment.md` |
| Monitoring | `references/monitoring.md` | `releases.md`, `deployment.md` |
| Incident response | `references/incident-response.md` | `migrations.md`, `deployment.md` |
| Maintenance | `references/maintenance.md` | `deployment.md` |

The end-to-end smoke after any deploy or restart:
`cd scripts/screenshots && NOTEES_ADMIN_PASSWORD=$(cat ../../config/notees/.admin_password) node verify-min.mjs` → expect `VERIFY-PASS`.
