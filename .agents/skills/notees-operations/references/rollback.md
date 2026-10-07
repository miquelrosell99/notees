# Rollback

Canonical: `docs/developers/releases.md` + `docs/developers/deployment.md`.
Discipline per the `deployment-runbook` skill (rollback triggers, traffic
switch, postmortem) — this file is the Notees-specific mechanics.

## Code/image rollback

Images are tag-addressable, so the rollback is a pin change:

```sh
docker pull ghcr.io/miquelrosell99/notees-sync:vPREVIOUS
git checkout vPREVIOUS && docker compose build && docker compose up -d
# both images rebuild from the checkout — no tags to manage
```

then re-run the smoke (`references/health-checks.md`). Both images roll back
independently; the web client tolerates an older/newer sync server within the
current wire version.

## Hard limits

- **Store downgrade is unsupported** — a `derived/*.db` written by a newer
  store schema is a hard error at boot. The way back is a **backup restore**
  (`references/backups.md`), then re-deploy the older image.
- **Never re-tag.** A broken release is fixed by the next patch tag; same-day
  correction = next patch.
- A breaking wire change requires the three-client lockstep to have shipped
  first — if a rollback crosses a wire-version bump, older clients fail loud
  on unknown envelopes (by design).

## Data rollback

= restore from backup (server stopped): copy back `relay.db` (+ `snapshots/`,
`workspaces/`, `api_key.txt`), start, verify. If the forward change was a
log-rewriting migration, restoring the pre-migration backup is the only
complete undo — there is no op-level "migrate down".
