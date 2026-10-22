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
popup-dismissal seam.

[ui-debugging.md](ui-debugging.md) is the visual-diagnosis runbook: the
screenshot capture suite (`scripts/screenshots/run.sh` on throwaway
containers) and the live-stack probe pattern (`probe-template.mjs`,
computed-style dumps, the react-pdf/jsdom limits).

[sdk-publishing.md](sdk-publishing.md) is archived reference for the parked
npm-distribution program.

## Clients

The companion clients are sibling repos, checked out next to this one; each
owns its own releases (tags, CI publishing, changelog) — this repo documents
only that they exist and how the wire stays convergent between them:

- **notees-gtk** (`/root/projects/notees-gtk`) — the GTK4 desktop client:
  Python lockstep port of the protocol, derived SQLite appliers, sync
  engine. Releases: annotated `v*` tags → CI publishes sdist/wheel + Arch
  package + GitHub Release.
- **notees-flutter** (`/root/projects/notees-flutter`) — the mobile client:
  Dart port, hand-rolled validators. Releases: `v*` tags → CI
  production-signed APK + GitHub Release.
- **notees-cli** (`/root/projects/notees-cli`) — the command-line client:
  consumes this repo's packages via a pinned `vendor/notees` submodule; the
  pin is the lockstep boundary. Releases: `v*` tags → CI attaches the
  `cli.mjs` bundle to the GitHub Release.

The convergence law they all follow is the **fixture gate + three-way
lockstep** in [development.md](development.md); wire-affecting changes are
not done until the TS reference, GTK, and Flutter apply byte-identical
fixtures.

The normative model and wire spec live in
[packages/protocol/SCHEMA.md](../../packages/protocol/SCHEMA.md); the
shipped-work record lives in [CHANGELOG.md](../../CHANGELOG.md) and in-flight
proposals in `.plans/YYYY-MM-DD-HHMM-<slug>/` folders.
