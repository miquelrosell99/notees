# Getting started

Prerequisites, install, running the server, and the account boot. The ideas behind the commands are in [philosophy.md](philosophy.md); for people developing or operating a Notees server, the [developers/](developers/) docs are the runbooks.

## Prerequisites and install

- Node 22 or newer, pnpm 9 (`packageManager` is pinned in `package.json`)
- From the repo root:

```bash
pnpm install
```

## Running the server

```bash
pnpm --filter @notees/server dev
```

The server is a single Fastify process: relay (op log), object API, and CAS asset storage, all under one data directory. Configuration is environment-only:

| Variable | Default | Meaning |
|---|---|---|
| `NOTEES_DATA_DIR` | `./data` | Relay log, snapshots, derived DBs, asset bytes, and the API-key file all live under here |
| `NOTEES_API_KEY` | *(generated)* | Bootstrap key, shape `nk_` + 32 chars. When absent, first boot generates one and persists it to `<dataDir>/api_key.txt` (mode 0600), logging it once |
| `NOTEES_PORT` | `8377` | Listen port |
| `NOTEES_HOST` | `0.0.0.0` | Listen host |
| `NOTEES_RELAY_BATCH_PER_MINUTE` | `30000` | Envelope-ingest rate limit per workspace |
| `NOTEES_GLOBAL_REQ_PER_MINUTE` | `10000` | Global fallback rate limit per IP |
| `NOTEES_MAX_MEDIA_BYTES` | `50 MB` | Media upload cap (sniffed jpeg/png/webp/audio) |
| `NOTEES_MAX_DOCUMENT_BYTES` | `100 MB` | Document upload cap (sniffed pdf/epub) |
| `NOTEES_LOG` | `true` | Request logging (`false` to silence) |

Reading the bootstrap key after first boot:

```bash
export NOTEES_API_KEY=$(cat data/api_key.txt)
```

Sanity probes (no auth needed for the first two):

```bash
curl -s localhost:8377/healthz                       # {"ok":true}
curl -s localhost:8377/api/version                # {"name":"notees-server","version":"2.0.0-m6","protocolVersion":3,...}
```

A fresh workspace seeds itself: a starter class catalog (`person`, `organization`, the `source` tree with its `book`/`journal_article`/`document`/`film`/`thesis` children, `task`, `event`, `meeting` (an event subclass), `birthday` (an event subclass linking to a person), `whiteboard`, `collection`, `query`, `template`, `note`, the `day`/`month`/`year` journals, …), plus an `inbox` page.

## The web app

```bash
pnpm --filter @notees/web dev
```

The feature pages under [features/](features/) document what works; the boot:

**Account boot** — server URL, then sign in (or the initial-setup screen when the server has no users yet: it creates the admin account). When the server runs with `NOTEES_SIGNUP_ENABLED`, the login screen also offers **No account yet? Create one** — self-registration creates a non-admin account and lands in the same workspace picker; with the flag off the link stays hidden and the signup route answers 404. No API key or workspace UUID prompts: after login you pick a workspace from your list, create one, or adopt "this device" (an offline workspace pushes its backlog on connect). "Work offline" skips the account entirely — edits stay on the device and sync on the first later connection. The session is remembered; sign out from the account menu (the profile circle at the sidebar's foot).

When the remembered server does not answer, the app does **not** sign you out — the outage behavior, the sync banner, and the settings Sync section are documented in [features/offline-and-sync.md](features/offline-and-sync.md).

What is not there yet: KaTeX math rendering, the plugin runtime. The data path underneath — local store, outbox, catch-up — is the same engine everything rides (see [features/offline-and-sync.md](features/offline-and-sync.md)).

## Scope: accounts + operator key

The server has accounts (email + password, scrypt-hashed) with sessions, and an initial-setup screen gates the first admin. Workspace access is membership-based: the first account to write to an unclaimed workspace adopts it; reads require membership. Registration is env-gated (`NOTEES_SIGNUP_ENABLED`, default off): when on, visitors can create their own non-admin accounts from the login screen; a signup account starts workspace-less and picks/creates its workspaces in the usual manager. The operator API key (`nk_…`) remains the machine path — the CLI and owned devices use it with unrestricted access. Per-user API keys minted from settings can carry a read-only or other scope set (server-enforced; see the [Object API quick reference](api.md)). Read-only public page shares are live (see [features/sharing.md](features/sharing.md) — owner/admin-gated, token-based); the rest of the multi-user hardening (roles, write-collaboration) is not there yet. Expose the port to machines you trust.
