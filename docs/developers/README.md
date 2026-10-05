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
4. **[releases.md](releases.md)** — how this repo and the GTK/Flutter clients
   ship: the tag/CI mechanics, the three-client lockstep law and batch
   history, and the fleet-host deploy + smoke runbook.
5. **[migrations.md](migrations.md)** — changing data the live relay log
   already carries: the append-only vs in-place-rewrite decision, the
   snapshot/restore-epoch/restart sequence, and the catalog of every
   `scripts/migrate-*.mts`.
6. **[workflows.md](workflows.md)** — the server-side workflow-rules engine
   (issue #13): "when X on nodes matching Y, do Z" as coordination state,
   the evaluation point, the depth-1 loop policy, and the run audit.

[sdk-publishing.md](sdk-publishing.md) is archived reference for the parked
npm-distribution program.

The normative model and wire spec live in
[packages/protocol/SCHEMA.md](../../packages/protocol/SCHEMA.md); the
implementation decision record and work registers live in
[.plans/implementation-plan.md](../../.plans/implementation-plan.md) (internal
to the repo — these runbooks reference it but never duplicate it).
