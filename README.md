# Notees

**One object graph. The operation log is the only authority. Every interface — UI, CLI, API, export — is a projection of the same derived state.**

This repo is [Notees](https://github.com/miquelrosell99/notees): a self-hosted, local-first personal knowledge environment whose only authority is an immutable, append-only **operation log** (envelope v3). It carries the wire protocol (the normative model: [SCHEMA.md](packages/protocol/SCHEMA.md), [WIRE.md](packages/protocol/WIRE.md)), the TypeScript reference implementation of the model/appliers/sync engine, the self-hostable sync relay (`notees-sync` image), the web client (`notees-web` image), and the five companion clients under [`clients/`](clients/).

> **Repo history.** Developed as a single monorepo, split 2026-11-05 into `notees-sync` (core + server) + `notees-web` (web client), and **re-merged 2026-11-12** — the split's audience-scope rationale did not hold for this pair (ADR-001). **Reunified 2026-11-17**: the five client repos (CLI, GTK, Flutter, Word, connector) merged in-tree under `clients/` with their full histories (ADR-002). The pre-merge repos survive as archived mirrors.

## Clients

The companion clients live in-tree under `clients/`, each keeping its own toolchain, docs, `AGENTS.md`, and project skills, and each releasing with a component-prefixed tag (`cli-v*` / `gtk-v*` / `flutter-v*` / `word-v*` / `connector-v*`):

- **[clients/cli/](clients/cli/)** — the `notees` command-line client (Node/pnpm; a root pnpm workspace project consuming `packages/*` directly). Install:
  `curl -fsSL https://raw.githubusercontent.com/miquelrosell99/notees/main/clients/cli/scripts/install.sh | bash`
- **[clients/gtk/](clients/gtk/)** — the GTK4/libadwaita Linux desktop client (Python/uv)
- **[clients/flutter/](clients/flutter/)** — the Flutter mobile + Linux desktop client
- **[clients/word/](clients/word/)** — the Word add-in (Office.js; a standalone pnpm project fenced off from the root workspace)
- **[clients/connector/](clients/connector/)** — the Firefox capture extension (standalone pnpm project)

The convergence law they all follow is the fixture gate + three-way lockstep (the protocol-fixture corpus is byte-identical across the tree; the `fixture-drift` workflow fails a commit that changes one copy without the others) — see [docs/developers/](docs/developers/).

## Layout

- `packages/protocol` — envelopes, HLC, op registry, content grammar, canonical fixtures (the convergence gate corpus), `SCHEMA.md`, `WIRE.md`
- `packages/domain` — display-name derivation, seeds (fixed system-class UUIDs), shared domain logic
- `packages/store` — derived SQLite schema + appliers (better-sqlite3, sql.js, sqlite-wasm backends)
- `packages/sync` — SyncEngine: HLC + server seq, snapshots, compaction, WebSocket
- `packages/query` — QueryAST model + SQLite compiler
- `packages/export` — export projections over the object graph (markdown/html/docx/latex package-side, pdf client-side, csv + json-archive view-shaped)
- `apps/server` — the sync relay + object API + CAS assets + coordination state (`notees-sync` image)
- `apps/web` — the web client: outliner editor + worker (sql.js/OPFS store), ui-kit, feature surfaces (`notees-web` image)
- `clients/` — the five companion clients in-tree (above), each with its own toolchain and per-client docs
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
