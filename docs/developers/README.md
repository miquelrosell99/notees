# Developing & Operating Notees

Runbooks for the people who hack on Notees or run a server — including the
agent sessions that work in this repo. Each page is the canonical home of its
workflow; read it before acting, and keep it current in the same pass as any
change it describes.

## Reading order

1. **[architecture.md](architecture.md)** — how the system works: one operation
   log as the sole authority, derived SQLite stores on every runtime, sync
   over WebSocket. Read this first; every other page assumes it.
2. **[development.md](development.md)** — working in this monorepo: commands,
   the fixture gate, adding an op type, conflict-semantics cheat sheet, code
   conventions.
3. **[deployment.md](deployment.md)** — self-hosting the server: requirements,
   configuration, the data directory, backups, upgrades, security posture.
4. **[migrations.md](migrations.md)** — changing data the live relay log
   already carries: the append-only vs in-place-rewrite decision, the
   snapshot/restore-epoch/restart sequence, and the catalog of every
   `scripts/migrate-*.mts`.
5. **[workflows.md](workflows.md)** — the server-side workflow-rules engine
   (issue #13): "when X on nodes matching Y, do Z" as coordination state,
   the evaluation point, the depth-1 loop policy, and the run audit.

[ui-primitives.md](ui-primitives.md) is the web client's component-library
reference: the compose-from-the-library law, the primitive catalog, and the
popup-dismissal seam. (The web app itself lives in-tree at `apps/web` —
repo split 2026-11-05, re-merged 2026-11-12; the page stays here as the
core-side reference.)

[ui-debugging.md](ui-debugging.md) is the visual-diagnosis runbook. Its tools
(the screenshot capture suite `scripts/screenshots/run.sh`, the probe
pattern) ship in-tree at `scripts/screenshots/` — the page is the method
reference.

[sdk-publishing.md](sdk-publishing.md) is archived reference for the parked
npm-distribution program.

## Clients

The companion clients live **in-tree** under `clients/`, each merged with
its full history and keeping its own toolchain, per-client `AGENTS.md`, and
project skills; each owns its releases (component-prefixed tags, CI
publishing, per-client changelog) — this page documents only that they
exist and how the wire stays convergent between them:

- **clients/cli** — the command-line client: a root pnpm workspace project
  consuming this repo's `packages/*` directly (the retired `vendor/notees`
  submodule is gone). Releases: `cli-v*` tags → `release-cli.yml` attaches
  the `cli.mjs` bundle to the tag's GitHub Release.
- **clients/gtk** — the GTK4 desktop client: Python lockstep port of the
  protocol, derived SQLite appliers, sync engine. Releases: `gtk-v*` tags →
  `release-gtk.yml` publishes sdist/wheel + Arch package + GitHub Release.
- **clients/flutter** — the mobile client: Dart port, hand-rolled
  validators. Releases: `flutter-v*` tags → `release-flutter.yml` publishes
  a production-signed APK + GitHub Release.
- **clients/word** — the Word add-in (Office.js). Releases: `word-v*` tags →
  `release-word.yml` attaches the built dist as a release zip.
- **clients/connector** — the Firefox capture extension. Releases:
  `connector-v*` tags → `release-connector.yml` attaches the built dist as a
  release zip.

The convergence law they all follow is the **fixture gate + three-way
lockstep** in [development.md](development.md); wire-affecting changes are
not done until the TS reference, GTK, and Flutter apply byte-identical
fixtures. The `fixture-drift` workflow at the repo root enforces the sha256
identity of the corpus across `packages/protocol/fixtures/`,
`clients/gtk/tests/fixtures/wire/`, and `clients/flutter/test/fixtures/wire/`
in one commit.

The normative model and wire spec live in
[packages/protocol/SCHEMA.md](../../packages/protocol/SCHEMA.md); the
shipped-work record lives in [CHANGELOG.md](../../CHANGELOG.md) and in-flight
proposals in `.plans/YYYY-MM-DD-HHMM-<slug>/` folders.
