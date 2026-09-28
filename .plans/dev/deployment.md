# Notees v2 — Deployment

Self-hosting the Notees v2 server (`@notees/server`) in its M1-alpha state: a
single-user, single-binary Fastify server with an embedded SQLite relay log and
per-workspace derived databases. Companion docs: `architecture.md` (system),
`development.md` (hacking).

**Maturity.** M1 is single-user and plaintext: one API key is the entire auth model, and
the server operator can read all workspace contents. Multi-user auth and E2EE are M3 and
do not exist. Everything below was verified against `apps/server/src/config.ts`,
`relay-storage.ts`, `assets.ts`, and `workspace-store.ts`.

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

The CLI builds the same way: `pnpm --filter @notees/cli build` → `apps/cli/dist/cli.js`
(exposed as the `notees` bin). There is intentionally no root `build` script; use
`pnpm -r build`.

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

CLI environment (for clients, `apps/cli/src/cli.ts`): `NOTEES_SERVER` (server URL),
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

## 9. Docker + Compose (shipped 2026-09-26)

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
  server URL from it (manual form remains the fallback). A conf.d snippet
  extends gzip to js/css/wasm (stock nginx gzips text/html only).

The folder-level deployment project lives at
`/etc/periphery/stacks/notees/compose.yaml` (project name `notees-v2` — kept
distinct from the running v1-dev `notees` project):

```sh
cd /etc/periphery/stacks/notees
docker compose config          # validate
docker compose up -d --build   # notees-sync (:8377) + notees-web (:8080)
```

- Ports: `NOTEES_SYNC_PORT` (default 8377), `NOTEES_WEB_PORT` (default 8080).
- Data: named volume `notees-sync-data` → `/data` (relay.db, snapshots,
  derived/, workspaces/, `api_key.txt`).
- CORS: compose sets `NOTEES_CORS_ORIGIN=http://localhost:8080` so a browser
  on the host can talk to the API. LAN clients add their origin
  (`http://<lan-ip>:8080`) — comma-separated — or set `*` on trusted LANs.
- First boot generates the API key; read it with
  `docker compose exec notees-sync cat /data/api_key.txt` (also logged once).
- `NOTEES_SERVER_URL` is baked into the web image at build time
  (`http://notees-sync:8377` in compose — only resolvable inside the docker
  network). For real browsers rebuild with a LAN/domain URL
  (`docker compose build --build-arg …` or an override file), or override at
  runtime: `docker run -e NOTEES_SERVER_URL=http://<host>:8377 …`.

Operator caveats: the server binds `0.0.0.0` (right inside a container); put
a reverse proxy in front for TLS. Bind-mounting `/data` instead of the named
volume needs the mount owned by uid 1000 (`node`).
