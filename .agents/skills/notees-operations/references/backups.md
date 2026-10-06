# Backups

Canonical: `docs/developers/deployment.md`.

## What the dataset is

`relay.db` (the authority: envelope log + snapshot/compaction metadata + asset
index + restore_epoch) + `workspaces/<ws>/assets/…` (CAS bytes) +
`api_key.txt` (mode 0600). `derived/<workspaceId>.db` and `snapshots/<id>.db`
are re-derivable caches — including `derived/` speeds recovery, skipping it
only costs a slower first boot.

## File-level backup (the operator path)

**Server stopped** (never copy `relay.db` live):

```sh
docker compose stop notees-sync
ts=$(date +%Y%m%d-%H%M%S)
cp -a config/notees/sync "/tmp/notees-backup-$ts"        # or your backup target
docker compose start notees-sync
```

Restore = the reverse (server stopped), then `docker compose up -d` and run
the smoke. After restoring a pre-migration backup, see rollback.md.

## Snapshot endpoints (online alternative)

- `POST /api/relay/v2/compact` with `{workspaceId, upToHlc, prune, dataBase64}`
- `GET /snapshot/data?workspaceId=…` — download snapshot bytes
- `PUT /snapshot/data` — upload

The `restoreEpoch` mechanism is implemented but has **no operator route yet**
— plain file restore is the documented path.

## Not backups

- There is **no `notees export` backup command**; the web UI's JSON archive
  export is a view-shaped exchange format, not a dataset backup.
- `docker compose exec notees-sync cat /data/api_key.txt` — back the key up
  with the dataset; losing it means new bootstrap generates a new key and the
  actor identity changes.
