# AGENTS.md

Notees CLI — the `notees` command-line client for Notees: the
object/property/search surface, plus markdown / JSON-archive export and a
scripting REPL (`notees shell`). **Local-first like the other clients**
since the server retired its content API (plan 07): the CLI syncs a
workspace through the `@notees/sync` engine into a per-workspace
derived SQLite store (the `@notees/store` package, better-sqlite3 backend,
one file under `<state-dir>/stores/<workspace-id>.db`), serves every content
read from that store, and pushes writes as protocol-v3 envelopes through the
engine's outbox. Since the ADR-002 reunification this CLI is a **workspace
project of the Notees monorepo** (`clients/cli`, Node 22 or 26, pnpm 9,
TypeScript, vitest): it consumes the monorepo's TypeScript packages
(`@notees/protocol`, `@notees/domain`, `@notees/store`, `@notees/sync`,
`@notees/query`, `@notees/export`; `@notees/server` for the test suite)
directly from `packages/*` — there is no `vendor/notees` submodule and no
vendor bump; the lockstep boundary is the monorepo workspace itself plus the
fixture gate.

## Skills (mandatory)

```
AGENTS.md
    │
    ├── notees-cli-development    (project skill — .agents/skills/notees-cli-development/)
    │      └── development workflow  → references/development-workflow.md
    └── notees-cli-operations     (project skill — .agents/skills/notees-cli-operations/)
           └── releases & packaging → references/releases.md
```

(The graph-data manipulation playbook — class migrations, carrier blocks,
bulk jobs — lives in the **user-scope** `notees-cli-manipulation` skill,
host-global at `~/.agents/skills/`; repo scope stays for development and
operations.)

- **Any code, test, or doc change → invoke the `notees-cli-development` skill
  first** and follow its laws (workspace lockstep, gate-before-done,
  changelog-as-record, docs-in-the-same-pass).
- **Any release or versioning task → invoke the
  `notees-cli-operations` skill first.**
- **Any task that edits graph data through the CLI (retagging, Description
  links, batch node edits) → the user-scope `notees-cli-manipulation`
  skill** (host-global; its model facts — carrier-block refs, the
  root-flatten invariant, idempotent membership — decide whether a script
  is safe to re-run).
- The skills summarize and enforce; their references point at the canonical
  homes (README.md here, and the monorepo root's `docs/developers/`
  runbooks). Content is referenced, not duplicated —
  update skill + doc in the same pass.

## Layout

- `src/` — the CLI (`cli.ts` commander program + `notees` bin entry;
  `shell.ts` the scripting REPL; per-concern modules: `local-workspace.ts`
  the local-first session — sync engine bootstrap, the E2EE custody probe,
  the retired server read projections ported over the local store, the
  envelope write seam, the durable restore backend; `client.ts` the fetch
  client (surviving coordination routes only), `exit-codes.ts` the
  exit-code contract, `state.ts` the local state file,
  `json-export.ts` / `markdown-export.ts` the exporters, `util.ts`,
  `uuid.ts`)
- `test/` — vitest suite; boots a **real** server from `@notees/server`
  against a temp workspace (`vitest.config.ts` deliberately excludes the
  core packages' own suites); `test/fake-relay.ts` implements the relay
  wire over an in-memory envelope log for the mocked unit specs (the
  retired content REST API can no longer be mocked — there is nothing left
  to mock it with)
- `scripts/install.sh` — release-bundle installer (resolves the newest
  `cli-v*` release, fetches its `cli.mjs` + checksum, links `notees` into
  `~/.local/bin`)
- `packaging/arch/` — the pacman PKGBUILD (builds from the release assets of
  the `miquelrosell99/notees` repo; `release-cli.yml` verifies its checksum
  and smoke-builds it on Arch)
- `word-snapshot/` — committed snapshot of the notees-word add-in's
  localhost build (the fallback that keeps fresh checkouts and CI green);
  `notees word serve` resolves its statics `NOTEES_WORD_DIST` > a built
  `clients/word/dist` > `word-snapshot/dist` > the copy embedded in the
  bundle at build time
- the monorepo root's `.github/workflows/ci-cli.yml` — install
  (`--frozen-lockfile`) + build + test on pushes/PRs touching `clients/cli/`
  or `packages/**`; `.github/workflows/release-cli.yml` — on `cli-v*` tags:
  a guard job fails a tag that does not touch `clients/cli/`, then gate +
  build, the PKGBUILD checksum check, attaching the bundle (`cli.mjs` +
  sha256) to the tag's GitHub Release (consumed by `scripts/install.sh`),
  and a `pacman-smoke` job that build-installs `packaging/arch/` on Arch and
  runs `notees`

## Commands

- Setup: from the monorepo root, `corepack enable && corepack prepare pnpm@9.0.0 --activate` → `pnpm install` (the CLI is a workspace project — running `pnpm install` inside `clients/cli` resolves the root workspace too). There are no submodules to init.
- Build: `pnpm build` (tsup bundle → `dist/cli.js`, the `notees` bin). After changing a `packages/*` public API, first `pnpm -r --filter "@notees/*" build` to rebuild the core packages' dists (dev-condition exports: tsc reads `dist`).
- Test: `pnpm test` (vitest) · Typecheck: `pnpm typecheck` (`tsc --noEmit`)
- **Gate before declaring done: `pnpm typecheck && pnpm test` — all green.**
- Run from source: `pnpm dev -- --help` (tsx).

## Invariants / conventions

- **The monorepo workspace is the lockstep boundary.** Wire/applier/model
  changes land in `packages/*` in this repo, and a wire change is not done
  until the monorepo's fixture gate has converged (TS reference + GTK +
  Flutter over byte-identical, sha256-pinned fixtures) — the
  `fixture-drift` workflow at the repo root fails any commit that changes
  the canonical corpus (`packages/protocol/fixtures/`) without updating the
  GTK (`clients/gtk/tests/fixtures/wire/`) and Flutter
  (`clients/flutter/test/fixtures/wire/`) copies in the same commit. The CLI
  consumes the core packages as workspace projects — there is no vendor pin
  to bump. Never edit fixture bytes anywhere.
  The `word-snapshot/` copy of the Word add-in is outside this law — it
  follows the add-in's own build, not the fixture gate.
- **The CLI's only authoritative state is the relay log** — the per-workspace
  derived store (`<state-dir>/stores/<workspace-id>.db`) is a disposable
  projection (delete it any time; the next command re-syncs). The state file
  keeps the session credential + the resolved name→workspace-id cache (mode
  0600); the sync cursor lives in the store's `app_meta`, not the state
  file. Writes apply locally before they push — a failed push is durable in
  the store's local op log, never lost with the process.
- **Exit-code contract** (`src/exit-codes.ts`): 0 ok, 1 domain, 2 usage,
  3 auth, 4 conflict, 5 network. Wire errors map onto these codes.
- **`--json` is the stable machine surface**: the JSON output shape is
  additive-only (agents consume it); human-readable text may change freely.
- **No client-side shape checks on credentials** — the client sends the
  credential verbatim and maps the server's 401.
- **No-legacy-version-names**: live version identifiers (`/api/relay/v2`,
  envelope v3, the `notees-json-archive` v1 envelope, `v2.0.0-mN` git tags)
  are wire/format facts and stay exact — never use v1/v2 as prose qualifiers
  for history, and no milestone labels (M1–M5).
- **Fleet-agnostic artifacts**: never hardcode host names, IPs, or tailnet
  names in code or docs — write `<host>`, `<tailnet>`, "the fleet host".
  Concrete values live only in gitignored env files / operator config.

## Records index (scan, don't embed)

| Record | Home |
|--------|------|
| Shipped work | `CHANGELOG.md` (newest first, one entry per slice) |
| In-flight proposals | `.plans/YYYY-MM-DD-HHMM-<slug>/` at the monorepo root (date-stamped proposal folders, created on demand) |
| Project skills | `.agents/skills/` |

## Working rules (owner)

- **The changelog is the record**: what shipped and why lives in
  `CHANGELOG.md` at the repo root — one entry per shipped slice, newest
  first. App changes only — never operations on a
  personal workspace or its specifics (workspace names/ids, data sizes,
  per-workspace counts, personal node samples); data work is reported to the
  owner, not recorded in the repo's public record. `AGENTS.md` itself is static guidance: never append history, dates,
  or work-record entries to it; edit it only when the guidance changes.
  Before implementing, skim `CHANGELOG.md` for recent related work and check
  `.plans/` for an in-flight proposal folder. A change without its changelog
  + doc updates is not done.
- **Docs are part of the change**: any behavior, command, or flag change
  updates README.md (and the help text) in the same pass.
