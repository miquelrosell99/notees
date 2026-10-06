# Notees — Deployment (developer)

Self-hosting the Notees server (`@notees-sync`): a single-binary Fastify server with an
embedded SQLite relay log and per-workspace derived databases. Companion docs:
[architecture.md](architecture.md) (the system), [development.md](development.md)
(hacking), [releases.md](releases.md) (the deploy runbook used on the fleet host).

**Security posture.** The server carries accounts and sessions (the web app signs in;
the initial setup creates the admin account), an operator API key for headless access,
and per-user coordination state — but transport and storage are still plaintext: no
E2EE. The server operator can read all workspace contents. Everything below was verified
against `apps/server/src/config.ts`, `relay-storage.ts`, `assets.ts`, and
`workspace-store.ts`.

## 1. Requirements

- **Node 22** (`engines.node >=22`). There is no published package — you run
  from source, from a local tsup build, or as a container (§9).
- **pnpm 9** (`packageManager: pnpm@9.0.0`) for install/build; enable via Corepack.
- **better-sqlite3** is a native module. Prebuilt binaries cover common glibc platforms;
  on musl/alpine or exotic arches you need Python 3, make, and g++ for node-gyp.
- The **web client** (`@notees/web`) is a vite dev app in M1 — the server does not serve
  a built frontend. Run `pnpm --filter @notees/web dev` and point it at the server, or
  use the CLI.

## 2. Running

From source (development):

```sh
pnpm install
pnpm --filter @notees/server dev        # tsx watch src/server.ts
```

Directly (single run from source, no watcher):

```sh
pnpm --filter @notees/server exec tsx src/server.ts
```

Via tsup build (how a deployment would run it):

```sh
pnpm install
pnpm --filter @notees/server build      # tsup → apps/server/dist/server.js (bundled,
                                        # better-sqlite3 kept external)
node apps/server/dist/server.js
# or: pnpm --filter @notees/server start
```

The CLI builds the same way in its own repo (`notees-cli`, §34.82):
`pnpm build` → `dist/cli.js` (exposed as the `notees` bin).

First boot prints the generated API key once to stderr and persists it (see §4).

## 3. Configuration

All server configuration is environment variables (`apps/server/src/config.ts`,
`loadConfig`). No config file exists.

| Variable | Default | Meaning |
|---|---|---|
| `NOTEES_DATA_DIR` | `./data` (resolved cwd-relative) | Root for the relay log, snapshots, derived DBs, CAS asset bytes, and the bootstrap key file |
| `NOTEES_API_KEY` | — | Bootstrap key, shape `nk_` + 32 base64url chars (`/^nk_[A-Za-z0-9_-]{32}$/`). When absent, the key file is used; when that is absent, a key is generated and persisted. An invalid value is a fatal startup error |
| `NOTEES_PORT` | `8377` | Listen port |
| `NOTEES_HOST` | `0.0.0.0` | Listen host. For a single machine, set `127.0.0.1`; see §7 |
| `NOTEES_LOG` | `true` | pino request logging; `false` disables |
| `NOTEES_RELAY_BATCH_PER_MINUTE` | `30000` | Envelopes per workspace per minute accepted by the relay (429 past it) |
| `NOTEES_GLOBAL_REQ_PER_MINUTE` | `10000` | Global fallback limit, requests/min/IP (WIRE §3) |
| `NOTEES_MAX_MEDIA_BYTES` | `52428800` (50 MB) | Upload cap, media sniffed by magic bytes (jpeg/png/webp/audio) |
| `NOTEES_MAX_DOCUMENT_BYTES` | `104857600` (100 MB) | Upload cap, documents (pdf/epub) |
| `NOTEES_CORS_ORIGIN` | — (no CORS headers) | Comma-separated browser origins allowed to call the API cross-origin (web client served from another origin/port). `*` allows any origin — LAN-trusted deployments only. Absent → no CORS headers: same-origin and CLI clients unaffected, browsers denied |

CLI environment (for clients, `notees-cli`'s `src/cli.ts`): `NOTEES_SERVER` (server URL),
`NOTEES_API_KEY` (the same `nk_` key; flags `--server`/`--key` override),
`NOTEES_STATE_FILE` (default `~/.notees/state.json`).

## 4. Data directory layout

Everything the server owns lives under `NOTEES_DATA_DIR`:

```
<NOTEES_DATA_DIR>/
├── relay.db                          # THE authority: envelope log (seq-ordered),
│                                     # snapshot/compaction metadata, asset index,
│                                     # per-workspace restore_epoch
├── api_key.txt                       # bootstrap key, mode 0600
├── snapshots/
│   └── <snapshotId>.db               # snapshot blobs: serialized derived-state
│                                     # SQLite bytes (flat, keyed by the metadata
│                                     # rows inside relay.db)
├── derived/
│   └── <workspaceId>.db              # per-workspace derived store (rebuildable
│                                     # from relay.db by replay)
└── workspaces/
    └── <workspaceId>/
        └── assets/
            └── <hash[:4]>/
                └── <hash>            # CAS asset bytes, sha256-addressed
```

Two properties fall out of the layout:

- **`derived/` is a cache.** Deleting it changes nothing semantically — the server
  rehydrates each workspace from the log (snapshot fast path, then seq-ordered replay)
  on next access (`apps/server/src/workspace-store.ts`).
- **`relay.db` plus `workspaces/` is the whole dataset.** `snapshots/` is optional
  acceleration; asset *metadata* (hashes, mime, names, refcounts) is rows in `relay.db`,
  so asset files are integrity-checkable against it.

## 5. The bootstrap key flow

`resolveApiKey` (`config.ts`) picks the active key in this order:

1. `NOTEES_API_KEY` — validated against the `nk_` pattern; a malformed value aborts
   startup (the message shows only the first 8 characters).
2. `<dataDir>/api_key.txt` — read and shape-validated; a corrupt file is a fatal error
   (the server refuses to guess).
3. Otherwise generate `nk_` + 24 random bytes as base64url (exactly 32 chars), write the
   file with mode `0o600`, and return `generated: true` so the entrypoint logs it once
   (`server.ts`: the one-time bootstrap notice goes to stderr).

Key properties: the key **is** the principal — the server's actor id is derived
deterministically from it (`actorIdForKey`, uuid5-layout over sha256), so envelope
provenance is stable across restarts; comparison at the auth boundary is constant-time
(`identity.ts`). Rotation means: set a new `NOTEES_API_KEY`, update clients; the old file
is ignored while the env var is set.

## 6. Backups

What M1 gives you:

- **Snapshot endpoint** — `POST /api/relay/v2/compact` with
  `{"workspaceId", "upToHlc", "prune", "dataBase64"}` snapshots derived state up to an HLC
  and optionally prunes covered envelopes (`prune: true` requires non-empty data);
  `GET /snapshot/data?workspaceId=…` downloads the blob; clients may also upload
  snapshots (`PUT /snapshot/data`). Snapshot bytes are a serialized derived-state SQLite
  database — restorable as-is, and the server itself uses them as a hydrate fast path.
- **File-level backup** — copy `relay.db` + `snapshots/` + `derived/` + `workspaces/`
  while the server is stopped (simplest consistent option; SQLite file copies are safe
  when idle). Because `derived/` replays from `relay.db`, you can skip it and accept a
  slower first boot after restore.
- **restoreEpoch** — the resync contract for restores is implemented end-to-end:
  `RelayStorage.bumpRestoreEpoch` bumps the per-workspace counter and clients wipe +
  resync on change. In M1 nothing calls it from an operator-facing surface (no admin
  route; it is exercised in tests), so a plain file restore also works without any epoch
  bookkeeping — clients converge by idempotent replay.

Designed, **not implemented**: the JSON archive export (plan §34.12 — Tier 1 full-fidelity
workspace dump slated as the M1 backup-grade format, Tier 2 Markdown projection in M2).
Until it ships, the snapshot endpoint plus the file layout above are the backup story;
there is no `notees export`.

## 7. Upgrades

- **Store schema migrations** are `PRAGMA user_version`-gated
  (`packages/store/src/schema.ts`, `migrate()`; `SCHEMA_VERSION = 1`). Opening a database
  newer than the code supports is a hard error ("newer store required") — downgrade by
  restoring a backup, not by forcing it.
- **Additive changes are safe.** New optional fields and new op types do not bump
  `PROTOCOL_VERSION` (WIRE §3), and old envelopes keep replaying identically
  (`applied_envelope` idempotency is per-envelope-id). A schema change that alters
  derived tables ships as a `SCHEMA_VERSION` bump; the wipe → replay → identical
  property means rebuild-after-migration converges by construction.
- **Breaking changes** bump `PROTOCOL_VERSION` (envelopes) and `WS_PROTOCOL_VERSION`
  (framing) independently, and the fixtures with them. Receivers fail loud on newer
  versions, so mixed-version fleets surface immediately rather than diverging.

## 8. Security notes (single-user M1)

- **The API key is the only auth.** Every route except `GET /healthz` and
  `GET /api/v1/version` requires it (`X-API-Key` header, `Authorization: Bearer`, or
  `?token=` on the socket), compared in constant time. Anyone with the key can read and
  write everything. Treat `api_key.txt` and the env var accordingly.
- **No TLS in the server.** Terminate TLS in a reverse proxy (or use an SSH tunnel /
  WireGuard) for anything leaving the machine. The `0.0.0.0` default bind exposes the
  server on all interfaces — for a strictly local deployment set `NOTEES_HOST=127.0.0.1`.
- **Upload safety** is shape-based, not trust-based: magic-byte sniffing (no
  extension/MIME trust), per-category size caps (50 MB media / 100 MB documents),
  request-body limit 128 MB, and rate limits at two levels (per-workspace relay ingest,
  global per-IP fallback).
- **No secrets in the log.** Envelopes carry actor/device/client provenance, not the key.
  `api_key.txt` is written `0600`; keep `NOTEES_DATA_DIR` permissions tight for the same
  reason.
- **Designed, not present:** E2EE (the `{"$e": …}` envelope slot is defined and passes
  through the relay unvalidated, but no client encrypts — M3), JWT sessions and
  multi-user authorization (M3), scoped keys. Until M3, "whoever holds the key" is the
  entire threat-model boundary.

## 9. Docker + Compose (shipped 2026-09-26; plain-Docker deploy since 2026-10-04)

Two images build from this monorepo (context = the repo root):

- **`apps/server/Dockerfile`** — multi-stage: `deps` (frozen workspace install;
  toolchain for the better-sqlite3 musl build), `build` (`pnpm --filter
  @notees/server... build` → tsup bundle, workspace TS inlined), `deploy`
  (`pnpm --filter @notees/server deploy --prod /out` pruned copy), `runtime`
  (`node:22-alpine`, `USER node`, `VOLUME /data`, `EXPOSE 8377`, wget
  `/healthz` healthcheck).
- **`apps/web/Dockerfile`** — `deps` + `build` (`pnpm --filter @notees/web...
  build` → vite dist: static assets + worker chunk + sql.js wasm), then
  `nginx:1.27-alpine`. The stock `/docker-entrypoint.d` mechanism runs
  `50-notees-config.sh`, which writes `/config.js`
  (`window.NOTEES_CONFIG = { serverUrl: … }`) from `NOTEES_SERVER_URL`
  (baked as a build ARG, overridable at runtime with `-e`) before nginx
  starts; `index.html` loads it first and the App bootstrap prefills the
  server URL from it (manual form remains the fallback). Two conf.d snippets
  ship in the image: `00-gzip` extends gzip to js/css/wasm (stock nginx gzips
  text/html only); `01-log` disables `access_log` so the 30s container
  healthcheck doesn't write one log line per poll forever.

**Deploy: plain Docker — Komodo is NOT required** (owner ruling 2026-10-04;
Komodo remains an optional convenience over the same compose file — every
operation it performs is reproducible with the commands below). From the repo
root:

```sh
docker build -f apps/server/Dockerfile -t ghcr.io/miquelrosell99/notees-sync:latest . \
&& docker build -f apps/web/Dockerfile -t ghcr.io/miquelrosell99/notees-web:latest . \
&& docker compose up -d
```

Compose has **no `build:` section by design**: it defaults to `:latest`
(`NOTEES_SYNC_TAG`/`NOTEES_WEB_TAG` env overrides pin ghcr tags — the host
docker login is read-only, so `docker pull ghcr.io/…:vX.Y.Z` + the env
override is the alternative to local builds). After a data migration that
rewrites the log, `docker compose restart notees-sync` rehydrates the server's
derived store from snapshot+tail (`RelayStorage.ingest` alone does not apply
to the running store — see `data-migrations.md` §1.B.7). Smoke:
`node scripts/screenshots/verify-min.mjs` from `scripts/screenshots/` with
`NOTEES_ADMIN_PASSWORD` (`config/notees/.admin_password` on the fleet host).

- Ports: `NOTEES_SYNC_PORT` (default 8377), `NOTEES_WEB_PORT` (default 8378).
- Data: bind mount `./config/notees/sync` → `/data` (relay.db, snapshots,
  derived/, workspaces/, `api_key.txt`).
- CORS: compose defaults `NOTEES_CORS_ORIGIN=*` (safe: header-based auth, no
  cookies); LAN/domain deployments can pin a comma-separated origin list via
  `.env`.
- Logging: the sync container sets `NOTEES_LOG=false` (no per-request pino
  lines); nginx `access_log` is off in the web image. Errors still reach
  stderr in both.
- First boot generates the API key; read it with
  `docker compose exec notees-sync cat /data/api_key.txt` (also logged once).
- `NOTEES_SERVER_URL` is baked into the web image at build time
  (`http://localhost:8377` by default) as a last-resort prefill; compose
  overrides it at runtime, **empty by default since §34.105** — the web
  client's same-host `:8377` guess covers every standard topology, so set it
  only for non-standard sync placements (§10).

Operator caveats: the server binds `0.0.0.0` (right inside a container); put
a reverse proxy in front for TLS. Bind-mounting `/data` instead of the named
volume needs the mount owned by uid 1000 (`node`).

## 10. Tailscale HTTPS (tailnet serving, live on the fleet host since 2026-10-06)

Tailnet TLS is terminated by the host's tailscaled via `tailscale serve` —
no reverse-proxy container, no cert files; Tailscale issues and renews the
per-hostname Let's Encrypt cert itself. The stack's host ports are published
**loopback-only** so tailscaled owns the tailnet-facing ports. Names and IPs
below are placeholders — per the fleet-agnostic rule (AGENTS.md), real values
live only in gitignored `.env`:

- `.env`: `NOTEES_SYNC_PORT=127.0.0.1:8377`, `NOTEES_WEB_PORT=127.0.0.1:8378`
  (plain HTTP stays on loopback for the serve proxies and the verify-min smoke).
- **LAN http coexists on the same port numbers** via specific-IP binds:
  `NOTEES_SYNC_LAN_PORT=<lan-ip>:8377`, `NOTEES_WEB_LAN_PORT=<lan-ip>:8378`
  in `.env`. Compose binds only the LAN IP while tailscaled holds the tailnet
  IP on the same port — the kernel allows one bind per specific address;
  only wildcard binds conflict. Result: `http://<lan-ip>:8378` (web) +
  `http://<lan-ip>:8377` (sync) on the LAN alongside the green ts.net URLs,
  and the web client's same-host `:8377` guess is correct on both networks.
  The shipped compose defaults keep `*_LAN_PORT` inert on loopback high
  ports (18377/18378) — set them to enable LAN serving. If the host's LAN IP
  changes, update the two vars (`docker compose up` fails loudly otherwise;
  pin the IP on the NIC or a DHCP reservation to avoid it).
- Serve listeners (config lives in tailscaled state; `tailscale serve status`
  to inspect, `tailscale serve reset` to undo):

````text
https://<host>.<tailnet>.ts.net:8378  → 127.0.0.1:8378   web    (canonical)
https://<host>.<tailnet>.ts.net:443   → 127.0.0.1:8378   web    (convenience)
https://<host>.<tailnet>.ts.net:8377  → 127.0.0.1:8377   sync   (canonical)
https://<host>.<tailnet>.ts.net:8443  → 127.0.0.1:8377   sync   (kept from the first cut)
````

- `NOTEES_SERVER_URL` is **unset on the fleet host and unneeded on any
  standard (same-host, :8377) topology** — the web client's same-host guess
  (`protocol//hostname:8377`, `App.tsx initialServerUrl`) derives the sync
  origin from the page origin and is correct on every access path above; the
  baked `/config.js` prefill is a last resort the guess supersedes. The
  compose default is empty since §34.105 (the entrypoint then ships the empty
  stub `window.NOTEES_CONFIG = {}`). Set the var only for non-standard sync
  placements. The default `NOTEES_CORS_ORIGIN=*` covers the https origins.
- **The bare hostname has no TLS identity.** Public CAs don't issue for
  single-label names, and Tailscale only issues for `<host>.<tailnet>.ts.net` —
  so `https://<host>:8378/` cannot work: tailscaled selects certs by SNI and
  **aborts the handshake** for a name it has no cert for (a hard connection
  failure, not a click-through warning). Green access is always the ts.net
  name. Serving the bare name would need a self-signed/private-CA cert
  terminated inside the web container (cert-file lifecycle + nginx conf
  mounts) — build only if the owner asks.
- **Prerequisite**: Serve + HTTPS certificates enabled for the tailnet (admin
  console). When gated, `tailscale serve` prints a `login.tailscale.com/f/serve?…`
  enablement URL, and `tailscale cert` fails with "account does not support
  getting TLS certs".
- **Operator caveats**: the host may run with `accept-dns=false`, in which
  case it cannot resolve ts.net names locally — verify from it with
  `curl --resolve <host>.<tailnet>.ts.net:443:<tailscale-ip> https://<host>.<tailnet>.ts.net/`;
  tailnet clients with MagicDNS resolve normally.
