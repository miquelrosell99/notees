# Deployment

Canonical: `docs/developers/deployment.md`.

## Standard deploy (from repo root)

The live `compose.yaml` + `.env` at the repo root are **gitignored host-local
artifacts — never committed** (enforced by the
`rosellramos-coding-standards` skill); the repo ships `compose.example.yaml`
(+ `compose.dev.example.yaml`) and `.env.example`. Fresh hosts:
`cp compose.example.yaml compose.yaml && cp .env.example .env`. The compose
project name derives from the folder name (no `name:` pin). The live data
dir binds `${NOTEES_DATA_DIR:-./config/notees/sync}`; hosts keeping the data
at the fleet stacks location (the fleet host:
`/etc/periphery/stacks/notees/config/notees/sync`, the borgmatic backup
source) set `NOTEES_DATA_DIR` in the gitignored repo-root `.env`.

```sh
docker build -f apps/server/Dockerfile -t ghcr.io/miquelrosell99/notees-sync:latest . \
&& docker build -f apps/web/Dockerfile    -t ghcr.io/miquelrosell99/notees-web:latest . \
&& docker compose up -d
cd scripts/screenshots && node verify-min.mjs
```

`verify-min.mjs` logs in via `/api/auth/login`, seeds localStorage, and asserts
the footer has no sync error + UI search finds a known hit; prints
`VERIFY-PASS` / `VERIFY-FAIL` (exit 1), with a 900 s boot window. Run it from
any cwd — it self-locates the stack dir (`NOTEES_STACK_DIR` →
`/etc/periphery/stacks/notees` when present → repo root), the API key
(`<stack>/config/notees/sync/api_key.txt`), and the admin password
(`<stack>/config/notees/.admin_password`); every value is env-overridable
(`NOTEES_API`/`NOTEES_WEB`/`NOTEES_API_KEY`/`NOTEES_ADMIN_PASSWORD`/`NOTEES_ADMIN_EMAIL`/`NOTEES_WORKSPACE`/`NOTEES_VERIFY_OUT`).
The stale duplicate `scripts/verify-min.mjs` (pre-login flow, no playwright
resolution) was removed 2026-10-21 — the only copy is
`scripts/screenshots/verify-min.mjs`.

## Version pinning (ghcr path)

Compose carries the build contexts: the deployment runs the LOCAL codebase
(`docker compose build && docker compose up -d`); a host that hasn't built
pulls `:latest`. To run a specific release, check it out and build — the
image content is the checkout, no tags to manage:

```sh
git checkout vX.Y.Z && docker compose build && docker compose up -d
```

The host's ghcr login is read-only; a release is
published by pushing a `v*` git tag (CI `.github/workflows/release-docker.yml`
publishes both images at the tag + `latest`), or
`gh workflow run release-docker.yml -f image_tag=X.Y.Z` to re-publish without
a tag.

**Build source discipline:** the image content is whatever
checkout builds it — never build from a git worktree, and never build from a
main checkout that sits behind `origin/main` (a stale-checkout rebuild
silently re-ships old code; learned 2026-10-25 when a pre-hub rebuild
clobbered the deployed Sources hub). Before `docker compose build` on a
checkout-built host: `git fetch && git status` — the checkout must be clean
and at `origin/main`. On hosts with the source/stack split, build/up from the
live stack folder only.

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

## HTTPS topology (deployment.md)

HTTPS is OPTIONAL, behind the compose "edge" profile — a Caddy container
(`notees-edge:local`, built from `deploy/Dockerfile.caddy`) with the tailscale
plugin: `NOTEES_EDGE_NAME=<host>.<tailnet>.ts.net` in `.env` + `docker compose
--profile edge up -d`. One published port (`NOTEES_EDGE_HTTP`, default 8443; :443 stays free);
certs issue/renew via the mounted tailscaled socket; `/api/*` → sync and
everything else → web over the compose network (the https page is
same-origin). App publishes are remappable full `ip:port` envs
(`NOTEES_SYNC_HTTP`, `NOTEES_WEB_HTTP`, `*_LAN_HTTP`) — fleet host pins
loopback. The core stack runs fine without the edge (no https = in-process
store banner). Undo: remove the profile. Never write real host/tailnet names
into any artifact — `.env` only.

## After a data migration that rewrote the log

`docker compose restart notees-sync` — required so the running derived store
reapplies (ingest alone does not reapply; migrations.md step 7).
