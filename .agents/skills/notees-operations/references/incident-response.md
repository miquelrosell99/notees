# Incident response

Canonical: `docs/developers/migrations.md` + `deployment.md`.
Escalation discipline (when to roll back, postmortem) per the
`deployment-runbook` skill; these are the Notees-specific failure modes.

## First moves

1. `docker compose ps` — are both containers up/(healthy)? Web down but sync
   healthy ⇒ web image/config; both down ⇒ data or host.
2. `docker compose logs --tail=200 notees-sync` (errors reach stderr even with
   `NOTEES_LOG=false`).
3. What changed? Last deploy / last migration / disk pressure on
   `./config/notees`.

## Known failure modes + fixes

- **"Derived DB newer than code" hard error at boot** — an image rollback
  crossed a store migration. Fix: restore a backup (`references/backups.md`)
  or re-deploy the newer image. No downgrade path exists.
- **Live API serves stale state after a log rewrite** — the restore epoch was
  not bumped or the server was not restarted. Fix: `relay.bumpRestoreEpoch` +
  `docker compose restart notees-sync` (migrations.md steps 6–7).
- **Derived store corrupted / poisoned** — stop sync, delete the affected
  `derived/<workspaceId>.db` (it is a cache), restart; it rehydrates from the
  log (+ newest covering snapshot). Never touch `relay.db` for this.
- **Clients out of sync after any of the above** — the restoreEpoch change
  triggers full client resync (`resyncFromEpochChange`); check the sync dot /
  conflict history modal.
- **Lost API key** — bootstrap regenerates only when no env var and no
  `api_key.txt` exist; restore from backup or set `NOTEES_API_KEY` explicitly.
  Rotation = set the new env var (actor id derives from the key).
- **429 / ingest rejects** — rate limits: ≤30 k envelopes/min/workspace,
  10 k req/min/IP; relay batch ≤1000 envelopes/≤1 MB. Back off, chunk
  smaller.
- **Snapshot restore misbehaving** — a snapshot embedding a post-rewrite seq
  is stale after a log rewrite; patch its bytes or delete it (forces a full
  replay).

## Hard don'ts

- Never edit or copy `relay.db` with the server running.
- Never run a migration script without the dry-run first (they default to it;
  `--apply` is explicit).
- Never bump/reset anything (restore epoch, snapshots) without the backups.md
  backup taken first.
