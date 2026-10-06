# Monitoring

No formal metrics stack is documented for this deployment — the built-in
surface is:

- **Container healthchecks** — `wget /healthz` every 30 s on notees-sync;
  `notees-web` waits on `service_healthy`; both `restart: unless-stopped`.
  `docker compose ps` is the status board.
- **The smoke as a periodic check** — `scripts/screenshots/verify-min.mjs`
  end-to-end through the web UI (login, no sync error in the footer, search
  renders). Run it after every deploy and on suspicion.
- **Audit feeds (in the app, not a dashboard):**
  - `GET /operations` — paginated relay-log read = the agent/actor audit feed.
  - `workflow_run` table + `GET /api/workflows/:id/runs` — the workflow-rules
    engine's append-only run audit (workflow writes are owner/admin only).
  - The web UI sync dot → details modal with conflict history
    (bounded FIFO log, `docs/developers/releases.md`).
- **Watch the growth:** `relay.db` (append-only log) and
  `workspaces/*/assets/` (CAS) grow monotonically; compaction exists via
  `POST /api/relay/v2/compact` — treat pruning as deliberate maintenance
  (`references/maintenance.md`), not routine cleanup.

If a real metrics/alerting stack is added, follow the `deployment-runbook`
skill's monitoring section and record the setup here + in
`docs/developers/deployment.md` in the same pass.
