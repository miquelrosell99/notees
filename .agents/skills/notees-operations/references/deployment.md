# Deployment

Canonical: `docs/developers/deployment.md` + `releases.md`.

## Standard deploy (from repo root)

```sh
docker build -f apps/server/Dockerfile -t ghcr.io/miquelrosell99/notees-sync:latest . \
&& docker build -f apps/web/Dockerfile    -t ghcr.io/miquelrosell99/notees-web:latest . \
&& docker compose up -d
cd scripts/screenshots && NOTEES_ADMIN_PASSWORD=$(cat ../../config/notees/.admin_password) node verify-min.mjs
```

`verify-min.mjs` logs in via `/api/auth/login`, seeds localStorage, and asserts
the footer has no sync error + UI search finds a known hit; prints
`VERIFY-PASS` / `VERIFY-FAIL` (exit 1), with a 900 s boot window.

## Version pinning (ghcr path)

Compose defaults to `:latest`. To run a specific release:

```sh
docker pull ghcr.io/miquelrosell99/notees-sync:vX.Y.Z
NOTEES_SYNC_TAG=vX.Y.Z docker compose up -d
```

(same for `NOTEES_WEB_TAG`). The host's ghcr login is read-only; a release is
published by pushing a `v*` git tag (CI `.github/workflows/release-docker.yml`
publishes both images at the tag + `latest`), or
`gh workflow run release-docker.yml -f image_tag=X.Y.Z` to re-publish without
a tag.

## First boot

The bootstrap API key is generated+persisted once (or taken from
`NOTEES_API_KEY` / an existing `api_key.txt`):
`docker compose exec notees-sync cat /data/api_key.txt`.
The bind-mounted data dir needs uid-1000 ownership (images run `USER node`).

## Configuration (env vars only, `apps/server/src/config.ts`)

| Var | Default | Notes |
|---|---|---|
| `NOTEES_DATA_DIR` | `./data` | `/data` in compose |
| `NOTEES_API_KEY` | — | shape `/^nk_[A-Za-z0-9_-]{32}$/`; invalid = fatal |
| `NOTEES_PORT` / `NOTEES_HOST` | 8377 / 0.0.0.0 | set host 127.0.0.1 for single-machine |
| `NOTEES_LOG` | true | compose sets false (see logs.md) |
| `NOTEES_RELAY_BATCH_PER_MINUTE` | 30000 | |
| `NOTEES_GLOBAL_REQ_PER_MINUTE` | 10000 | |
| `NOTEES_MAX_MEDIA_BYTES` / `NOTEES_MAX_DOCUMENT_BYTES` | 50 MB / 100 MB | |
| `NOTEES_CORS_ORIGIN` | absent = no CORS | compose defaults `*` |
| `NOTEES_SERVER_URL` | empty | optional web prefill; the web client guesses `protocol//hostname:8377` from its origin |

CLI env: `NOTEES_SERVER`, `NOTEES_API_KEY`, `NOTEES_WORKSPACE`,
`NOTEES_STATE_FILE` (default `~/.notees/state.json`).

## HTTPS topology (fleet host — deployment.md)

`tailscale serve` terminates TLS on the tailnet; compose ports bind
loopback-only by default (8377/8378) with inert LAN shadows at
`127.0.0.1:18377/18378`; `NOTEES_SYNC_LAN_PORT=<lan-ip>:8377` /
`NOTEES_WEB_LAN_PORT=<lan-ip>:8378` re-expose plain HTTP on the LAN.
The bare hostname has no TLS identity (handshake aborts) — green access is
always the `https://<host>.<tailnet>.ts.net` name. Inspect with
`tailscale serve status`; undo with `tailscale serve reset`. Never write real
host/tailnet names into any artifact — `.env` only.

## After a data migration that rewrote the log

`docker compose restart notees-sync` — required so the running derived store
reapplies (ingest alone does not reapply; migrations.md step 7).
