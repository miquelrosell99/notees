# Notees Web

**The web client for [Notees](https://github.com/miquelrosell99/notees-sync)** — a self-hosted, privacy-first, local-first personal information environment whose only authority is an immutable operation log. This repo is the React/Vite outliner editor + worker (`notees-web` image, :8378); the wire authority, core packages, and sync server live in the sibling **[`miquelrosell99/notees-sync`](https://github.com/miquelrosell99/notees-sync)** repo, whose user-facing docs (front door, getting started, features, workflows) are kept here under `docs/`.

The system was developed as a single monorepo (`miquelrosell99/notees`, archived, history preserved) and split 2026-11-05 into this repo (web client + user docs) and `notees-sync` (core + server). The companion clients ([notees-cli](https://github.com/miquelrosell99/notees-cli), notees-gtk, notees-flutter) consume the core through the same pinned-submodule pattern.

## Consuming the core

The core packages (`@notees/protocol`, `@notees/domain`, `@notees/store`, `@notees/sync`, `@notees/query`, `@notees/export`) are **not** developed here — they arrive through a pinned git submodule at `vendor/notees` (→ `notees-sync` main). The pnpm workspace consumes them as workspace projects; TypeScript reads their `src` via dev-condition exports in vitest, and their built `dist` under `tsc`/bundling (rebuild the vendored dists after a bump: `pnpm -r --filter "@notees/*" build`).

```bash
git submodule update --init --recursive   # vendor/notees + brand
corepack enable && corepack prepare pnpm@9.0.0 --activate
pnpm install
```

**Never edit anything under `vendor/`** — fix it in `notees-sync`, then bump the pin (`git -C vendor/notees fetch origin && git -C vendor/notees checkout origin/main`, then `pnpm install` + commit the lockfile + submodule pointer).

## Development

```bash
pnpm dev        # vite dev server — /api/* proxies to localhost:8377 (run a sync server)
pnpm test       # the web suite (vitest, jsdom) — the blocking gate
pnpm build      # vite production build (apps/web/dist)
pnpm typecheck  # tsc --noEmit
```

The UI laws (compose from `apps/web/src/components/ui/kit/`, token-only CSS, adaptive values) live in `AGENTS.md`; the full catalog is in the notees-sync repo's `docs/developers/ui-primitives.md`.

## Desktop (Tauri)

The web client also builds as a desktop app through the Tauri v2 shell in `src-tauri/` — a minimal single-window host (no native commands; the web boot flow handles server URL + login, and the store rides sql.js/OPFS in the webview). Prerequisite: a Rust toolchain ([rustup](https://rustup.rs/)).

```bash
pnpm install          # also fetches the pinned @tauri-apps/cli
pnpm tauri:dev        # vite dev server + the shell against it (still needs a sync server on :8377)
pnpm tauri:build      # production web build + installers → src-tauri/target/release/bundle/
```

Installers are **unsigned** (no code signing configured) — fine for the self-hosted audience; expect OS warnings on first install. CI (`.github/workflows/desktop.yml`) builds Windows (.msi) + macOS (.dmg) installers on `v*` tags and uploads them as release artifacts. Regenerate the icon set with `pnpm tauri icon <source-png>` after a brand change.

## Docker

The `notees-web` image builds from this repo's root (the build context must carry the initialized `vendor/notees` submodule):

```sh
docker build -f apps/web/Dockerfile -t ghcr.io/miquelrosell99/notees-web:latest .
```

CI publishes `:nightly` (scheduled) and release tags (`v*` tag push) to ghcr; see `.github/workflows/`. Self-hosting the full stack (sync server + this client + the optional tailnet edge) is documented in notees-sync's `docs/developers/deployment.md`.

## Layout

- `apps/web` — the client: outliner editor, worker (sql.js/OPFS store), ui-kit (`src/components/ui/kit/`), feature surfaces, the screenshot/probe suite (`test/`, plus `scripts/screenshots/` probes and `scripts/screenshots/verify-min.mjs`, the post-deploy smoke)
- `docs/` — the person-facing documentation (front door, getting started, one page per feature under `features/`, the `workflows/` convention docs); the developers runbooks live in the notees-sync repo under `docs/developers/`
- `brand/` — the brand submodule (design tokens/assets; `src/ui/variables.css` references it)
- `vendor/notees` — pinned notees-sync checkout (the core packages)
- `src-tauri/` — the Tauri v2 desktop shell (a build target for the web client; see "Desktop (Tauri)")
- `CHANGELOG.md` — the shipped-work record
