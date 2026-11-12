# Notees

**One object graph. The operation log is the only authority. Every interface — UI, CLI, API, export — is a projection of the same derived state.**

This repo is [Notees](https://github.com/miquelrosell99/notees): a self-hosted, local-first personal knowledge environment whose only authority is an immutable, append-only **operation log** (envelope v3). It carries the wire protocol (the normative model: [SCHEMA.md](packages/protocol/SCHEMA.md), [WIRE.md](packages/protocol/WIRE.md)), the TypeScript reference implementation of the model/appliers/sync engine, the self-hostable sync relay (`notees-sync` image), and the web client (`notees-web` image). Every SQLite database — server, browser worker, CLI — is a derived projection of that log.

> **Repo history.** Developed as a single monorepo, split 2026-11-05 into `notees-sync` (core + server) + `notees-web` (web client), and **re-merged 2026-11-12** — the split's audience-scope rationale did not hold for this pair (`.agents/decisions/ADR-001-merge-sync-and-web.md`). The child repos survive as archived mirrors.

The companion clients ([notees-cli](https://github.com/miquelrosell99/notees-cli), notees-gtk, notees-flutter) consume this repo's core packages through pinned vendor submodules; the pin is the lockstep boundary (see [docs/developers/](docs/developers/)).

## Layout

- `packages/protocol` — envelopes, HLC, op registry, content grammar, canonical fixtures (the convergence gate corpus), `SCHEMA.md`, `WIRE.md`
- `packages/domain` — display-name derivation, seeds (fixed system-class UUIDs), shared domain logic
- `packages/store` — derived SQLite schema + appliers (better-sqlite3, sql.js, sqlite-wasm backends)
- `packages/sync` — SyncEngine: HLC + server seq, snapshots, compaction, WebSocket
- `packages/query` — QueryAST model + SQLite compiler
- `packages/export` — export projections over the object graph (markdown/html/docx/latex package-side, pdf client-side, csv + json-archive view-shaped)
- `apps/server` — the sync relay + object API + CAS assets + coordination state (`notees-sync` image)
- `apps/web` — the web client: outliner editor + worker (sql.js/OPFS store), ui-kit, feature surfaces (`notees-web` image)
- `docs/` — the person-facing documentation; `docs/developers/` — runbooks for people developing and operating the stack
- `scripts/` — log migrations, conformance checkers, the migration rehearsal harness, `scripts/screenshots/` the visual-diagnosis probe suite
- `src-tauri/` — the Tauri v2 desktop shell (a build target for the web client)
- `brand/` — the brand submodule (design tokens/assets)

## Run it

Self-hosting (Docker) is documented in [docs/developers/deployment.md](docs/developers/deployment.md) — the stack is the `notees-sync` server (:8377) plus the `notees-web` client (:8378), composed with the shipped `compose.example.yaml`. Server-only stacks skip the web service with the compose `web` profile.

For a source checkout: Node 22+, pnpm 9, `pnpm install`, then `pnpm --filter @notees/server dev` (port 8377; the API key is generated on first boot, logged once) and `pnpm --filter @notees/web dev` (vite; `/api/*` proxies to :8377).

## Development

```bash
pnpm install
pnpm build       # all packages + server + web (workspace-concurrency=1)
pnpm test        # all suites — the blocking gate
pnpm typecheck
```

The fixture gate, the add-an-op recipe, and the GTK/Flutter/CLI lockstep law: [docs/developers/development.md](docs/developers/development.md). The CSS token-drift gate: `node scripts/check-css-tokens.mjs`. The shipped-work record: [CHANGELOG.md](CHANGELOG.md).
