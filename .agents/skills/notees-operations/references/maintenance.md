# Maintenance

Canonical: `docs/developers/deployment.md` + `releases.md`.

## Routine

- **Image updates:** pull/build → `docker compose up -d` → smoke
  (`references/health-checks.md`). Version = the checkout: `git checkout <release> && docker compose build`
  when you don't want `:latest`.
- **Re-check `.env`** against `.env.example` after pulls — LAN ports and
  `NOTEES_CORS_ORIGIN` defaults changed meaning over time; loopback-only
  defaults are intentional on the fleet host.
- **Disk:** watch `config/notees/sync/relay.db` (append-only) and
  `workspaces/*/assets/` (CAS growth); clean up `/tmp` migration backups
  (`/tmp/notees-backup-*`) once a restore is no longer plausible.
- **Compose hygiene:** both services `restart: unless-stopped`; after host
  reboots verify `tailscale serve status` still maps the tailnet ports
  (8378/443 → web, 8377/8443 → sync).

## Key rotation

Set a new `NOTEES_API_KEY` (shape `/^nk_[A-Za-z0-9_-]{32}$/`) and recreate the
container, or replace `api_key.txt` (mode 0600) with the server stopped.
Actor identity derives from the key — rotation changes the actor id for
future API writes.

## Snapshots + compaction

`POST /api/relay/v2/compact {workspaceId, upToHlc, prune, dataBase64}` creates
snapshots; `snapshots/<id>.db` files are optional accelerators — delete stale
ones freely (full replay ~35 min), but **after a log rewrite prefer patching
snapshot bytes** (migrations.md step 5). Snapshot deletes are safe;
`relay.db` deletion is data loss, full stop.

## Health of the law

Any change to how the stack is deployed, backed up, or migrated updates
`docs/developers/deployment.md` / `releases.md` / `migrations.md` and this
skill's references in the same pass — docs and skills are part of the change.
