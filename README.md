# Notees Sync

**One object graph. The operation log is the only authority. Every interface — UI, CLI, API, export — is a projection of the same derived state.**

This repo is the **core and server** of [Notees](https://github.com/miquelrosell99/notees-web): a local-first personal knowledge environment whose only authority is an immutable, append-only **operation log** (envelope v3). It carries the wire protocol (the normative model: [SCHEMA.md](packages/protocol/SCHEMA.md), [WIRE.md](packages/protocol/WIRE.md)), the TypeScript reference implementation of the model/appliers/sync engine, and the self-hostable sync relay (`notees-sync` image). Every SQLite database — server, browser worker, CLI — is a derived projection of that log.

The system was developed as a single monorepo (`miquelrosell99/notees`, archived, history preserved) and split 2026-11-05 into:

- **`miquelrosell99/notees-sync`** (this repo) — wire authority + core packages + server.
- **[`miquelrosell99/notees-web`](https://github.com/miquelrosell99/notees-web)** — the web client; consumes this repo's packages through a pinned `vendor/notees` git submodule. User-facing docs live there.

The companion clients ([notees-cli](https://github.com/miquelrosell99/notees-cli), notees-gtk, notees-flutter) consume this repo through pinned vendor submodules too; the pin is the lockstep boundary (see [docs/developers/](docs/developers/)).

## Layout

- `packages/protocol` — envelopes, HLC, op registry, content grammar, canonical fixtures (the convergence gate corpus), `SCHEMA.md`, `WIRE.md`
- `packages/domain` — display-name derivation, seeds (fixed system-class UUIDs), shared domain logic
- `packages/store` — derived SQLite schema + appliers (better-sqlite3, sql.js, sqlite-wasm backends)
- `packages/sync` — SyncEngine: HLC + server seq, snapshots, compaction, WebSocket
- `packages/query` — QueryAST model + SQLite compiler
- `packages/export` — export projections over the object graph (markdown/html/docx/latex package-side, csv + json-archive view-shaped)
- `apps/server` — the sync relay + object API + CAS assets + coordination state (`notees-sync` image)
- `scripts/` — log migrations, conformance checkers, the migration rehearsal harness
- `docs/developers/` — runbooks for people developing and operating the core/server

## Run it

Self-hosting (Docker) is documented in [docs/developers/deployment.md](docs/developers/deployment.md) — the stack is the `notees-sync` server (:8377) plus the [`notees-web`](https://github.com/miquelrosell99/notees-web) client (:8378), composed with the shipped `compose.example.yaml`.

For a source checkout: Node 22+, pnpm 9, `pnpm install`, then `pnpm --filter @notees/server dev` (port 8377; the API key is generated on first boot, logged once).

## Development

```bash
pnpm install
pnpm build       # all packages + the server (workspace-concurrency=1)
pnpm test        # all packages + the server suites (the blocking gate)
pnpm typecheck
```

The fixture gate, the add-an-op recipe, and the GTK/Flutter/CLI lockstep law: [docs/developers/development.md](docs/developers/development.md). The shipped-work record: [CHANGELOG.md](CHANGELOG.md).
