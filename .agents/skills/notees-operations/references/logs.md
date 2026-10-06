# Logs

Canonical: `docs/developers/deployment.md` §9 (compose logging posture).

- Compose runs the sync server with `NOTEES_LOG=false` — no per-request pino
  output. Errors still reach stderr: `docker compose logs -f notees-sync`.
- The web image's nginx disables access_log for the 30 s-interval healthcheck
  noise; web stderr: `docker compose logs -f notees-web`.
- To get full request logging on the sync server, run it with
  `NOTEES_LOG=true` (dev/single-machine), never by default on the fleet host.
- No log-aggregation stack is documented — if one is added, wire it per the
  `deployment-runbook` skill's monitoring section and record it here + in
  `docs/developers/deployment.md`.

## What to grep when

- Sync errors / failed applies / rate-limit rejects → `docker compose logs notees-sync 2>&1 | grep -iE 'error|fail|reject'`.
- A quarantined client op or "not-yet-applicable envelope" retry loop appears
  in sync stderr at boot.
- Web nginx errors → `docker compose logs notees-web`.
