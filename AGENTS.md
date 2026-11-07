# AGENTS.md

> **Repo split (2026-11-05).** This repo (`notees-web`) is the web client + user-docs half of the former `miquelrosell99/notees` monorepo (archived, history preserved): the React/Vite outliner editor (`apps/web`, the `notees-web` image) and the person-facing docs (`docs/`). The wire authority and core packages live in the sibling **[`miquelrosell99/notees-sync`](https://github.com/miquelrosell99/notees-sync)** repo and arrive here through the pinned `vendor/notees` submodule — never edit anything under `vendor/`.

Notees — a self-hosted, privacy-first, local-first **personal information environment**: one object graph whose only authority is an immutable **operation log** (envelope **v3**); every SQLite database (server, browser worker, CLI) is a derived projection of that log. The normative model + wire live in the sync repo (`packages/protocol/SCHEMA.md`, `WIRE.md`); the developers runbooks (architecture, development, deployment, migrations, ui-primitives, ui-debugging) live there under `docs/developers/`.

## Layout

- `apps/web` — the client: outliner editor + worker (sql.js/OPFS derived store), `src/components/ui/kit/` the component library, feature surfaces under `src/features/`, the undo journal (`src/core/undo-journal.ts` — session-local, inverses compose existing ops, per-tab), `test/` the vitest suite
- `scripts/screenshots/` — the visual-diagnosis probe suite + `verify-min.mjs` (the post-deploy smoke; method runbook: notees-sync `docs/developers/ui-debugging.md`)
- `scripts/check-css-tokens.mjs` — the CSS token-drift gate (CI job `css-token-drift`)
- `docs/` — **person-facing only**: front door, `getting-started.md`, `cli.md`, `api.md`, `feature-status.md`, `philosophy.md`, one page per feature under `features/`, the convention docs under `workflows/`. **Internal notes never go in `docs/`; user docs never go in dot-folders.**
- `brand/` — the brand submodule (design tokens/assets; `src/ui/variables.css` is seeded from it)
- `vendor/notees` — pinned `notees-sync` checkout (the `@notees/*` core packages)
- `CHANGELOG.md` — the shipped-work record

## Commands

- Setup: `git submodule update --init --recursive` → `corepack enable && corepack prepare pnpm@9.0.0 --activate` → `pnpm install`.
- Dev: `pnpm --filter @notees/web dev` (vite; `/api/*` proxies to a sync server on :8377). Build: `pnpm --filter @notees/web build`. Test: `pnpm --filter @notees/web test` (the blocking gate). Typecheck: `pnpm --filter @notees/web typecheck`.
- **Dev-condition exports**: vitest reads the vendored packages' `src`, `tsc` reads their `dist` — after a vendor bump, first `pnpm -r --filter "@notees/*" build`, then `pnpm install` (the lockfile tracks the submodule pointer) and commit both.

## Consuming the core (the vendor pin)

- `vendor/notees` is a git submodule → `miquelrosell99/notees-sync`, pinned to `main` (the lockstep boundary). The pnpm workspace consumes `vendor/notees/packages/{protocol,domain,store,sync,query,export}` as workspace projects; `@notees/*` imports resolve through them (no path aliases needed).
- Never edit `vendor/` — fix it in `notees-sync` (its fixture gate + GTK/Flutter lockstep is the law for wire/model changes), then bump the pin: `git -C vendor/notees fetch origin && git -C vendor/notees checkout origin/main` → `pnpm -r --filter "@notees/*" build` → `pnpm install` → commit the submodule pointer + lockfile + `CHANGELOG.md` entry.
- A handful of specs exercise the sync repo's log-migration rehearsal scripts by importing them **through the vendor pin** (`../../../vendor/notees/scripts/…` from `apps/web/test/`, `vendor/notees/scripts/lib/map-query-ast-v1-v2.js` from `src/features/collection/…`) — keep those imports vendor-relative; never copy the scripts into this repo.

## UI primitives (binding law for any apps/web change)

All chrome MUST compose from `apps/web/src/components/ui/kit/` — one element per file, co-located CSS, barrel-exported, token-only CSS (`src/ui/variables.css`). **ALWAYS the system components** unless the UI is genuinely one-of-a-kind; then create it as an INDEPENDENT COMPONENT under the system components, never ad-hoc styled markup in feature code. No ad-hoc styled controls in feature code. Values that track type metrics or layout take the adaptive form (`1lh`/`em`/`ch`/`%`, `clamp()`, spacing/radius/motion tokens), not fixed px numbers — hard-coded px only where the dimension is genuinely constant (hairlines, tap-target floors). **Catalog, the popup-dismissal seam, the drift classes, chrome-row layout contracts, and the adaptive-values law: notees-sync `docs/developers/ui-primitives.md`.** Visual decisions defer to the `rosellramos-design-system` skill; this repo's deviations live in `.agents/design-overrides.md` (audits treat a documented deviation as a decision, an undocumented one as drift).

## Working rules

- **The changelog is the record**: what shipped and why lives in `CHANGELOG.md` — one entry per shipped slice, newest first; app changes only, never operations on a personal workspace. `AGENTS.md` is static guidance: never append history entries; edit only when the guidance changes. A change without its changelog + doc updates is not done.
- **Docs are part of the change**: behavior or UX changes update the relevant `docs/` page in the same pass; wire/model-visible changes are made in `notees-sync` (with its fixture gate), not here.
- **Fleet-agnostic artifacts**: never hardcode machine names, IPs, or tailnet names in code, templates, docs, or notes — write `<host>`, `<tailnet>`, `<lan-ip>`, or "the fleet host". Concrete values live only in gitignored host-local files (`.env`).
- **No transient-internal-doc pointers in the tree**: code, tests, docs, and CHANGELOG entries never reference internal proposal folders or transient design docs.
- **Parallel sessions**: other agent or human sessions may be working in this repo at the same time — `git status --porcelain` + `git log --oneline -5` at session start; per-file staging only (never `git add -A`); red tests in files you didn't touch are someone else's in-flight work — report, don't fix.
- **Commit and push when done**: a finished slice — gate green, `CHANGELOG.md` entry in — is committed (per-file staging, Conventional Commits: `feat(web): …`) and pushed; never force-push.
- **Redeploy what you ship — always via the live stack's own compose** (`docker compose build <service> && docker compose up -d` from the live stack folder, whose build context IS this checkout): the running stack carries the local build, never the registry tag. Release tags are for other users of the app, not for the fleet's own deployment — never wait for a release, never pin the fleet stack to `ghcr.io` tags. A code change is not live until the changed service's image is rebuilt from the checkout and the container recreated; then the `verify-min.mjs` smoke must answer VERIFY-PASS (enforced at all times).

## Records index

| Record | Home |
|--------|------|
| Shipped work | `CHANGELOG.md` (newest first) |
| Design overrides (deviations from the RosellRamos design system) | `.agents/design-overrides.md` |
| Core architecture / wire / runbooks | `vendor/notees/docs/developers/` (canonical: the `notees-sync` repo) |
