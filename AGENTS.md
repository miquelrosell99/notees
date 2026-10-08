# AGENTS.md

Notees — a self-hosted, privacy-first, local-first **personal information environment**: one object graph (nodes carry `is_class` + `present_as_main`; "page" and "block" are render states, not node kinds; typed properties, typed link marks, assets) whose only authority is an immutable **operation log** (envelope **v3**); every SQLite database (server, browser worker, CLI) is a derived projection of that log. TypeScript everywhere (Node 22, pnpm 9).

## Skills (mandatory)

```
AGENTS.md
    │
    ├── notees-development   (project skill — .agents/skills/notees-development/)
    │      ├── architecture          → references/architecture.md
    │      ├── coding conventions    → references/coding-conventions.md
    │      └── development workflow  → references/development-workflow.md
    │
    └── notees-operations    (project skill — .agents/skills/notees-operations/)
           ├── deployment             → references/deployment.md
           ├── health checks          → references/health-checks.md
           ├── logs                   → references/logs.md
           ├── rollback               → references/rollback.md
           ├── database migrations    → references/database-migrations.md
           ├── backups                → references/backups.md
           ├── monitoring             → references/monitoring.md
           ├── incident response      → references/incident-response.md
           └── maintenance            → references/maintenance.md
```

- **Any code, model, wire, applier, fixture, sync, or UI change → invoke the `notees-development` skill first** and follow its laws (fixture gate + GTK/Flutter lockstep, dev-condition exports, changelog-as-record, docs-part-of-change, designed-not-built register).
- **Any operations task — deploy, health check, logs, rollback, database migration, backup, monitoring, incident response, maintenance → invoke the `notees-operations` skill first.** Deployment and rollback discipline additionally follows the **`deployment-runbook`** skill (pre-deploy checklist, health checks, rollback triggers, postmortem) — if it is not installed in the current environment, fetch and follow it from GitHub: <https://github.com/majiayu000/claude-skill-registry/blob/main/skills/data/deployment-runbook/SKILL.md>
- The skills summarize and enforce; their references point at the canonical `docs/developers/` runbooks (person-facing, written for people **and** agent sessions). Content is referenced, not duplicated — update skill + runbook in the same pass; on disagreement the runbook wins until the skill is corrected.

## Layout

- `packages/protocol` — op wire spec, envelopes, fixtures (the convergence gate corpus), `SCHEMA.md` (the normative model)
- `packages/domain` — seeds (fixed system-class UUIDs), display-name derivation, content stringify (the text-only flatten for class content and the create/promotion boundaries)
- `packages/store` — derived SQLite schema + appliers; one TS implementation, three backends (better-sqlite3, sql.js)
- `packages/sync` — SyncEngine (HLC + server seq, snapshots, compaction, WebSocket)
- `packages/query` — QueryAST model + SQLite compiler
- `packages/export` — export projections over the object graph: IR + serializers (markdown/html/docx/latex package-side, pdf client-side in the web app, csv + json-archive view-shaped); detail in `docs/developers/architecture.md`
- `apps/server` — sync relay + object API + CAS assets + coordination state (per-user prefs, plugin-manifest registry, workflow rules + run audit) + read-only public page shares (`notees-sync` image)
- `apps/web` — React/Vite outliner editor + worker (`notees-web` image); carries the session-local op-inverse **undo journal** (`src/core/undo-journal.ts` — client convenience only, inverses compose existing ops, per-tab)
- `apps/cli` — MOVED 2026-10-05: lives in its own repo (`notees-cli`, sibling to the GTK/Flutter clients, consuming the packages via a pinned `vendor/notees` submodule)
- `docs/` — **person-facing only**: `usage.md`, `ux.md`, `philosophy.md` + the `developers/` runbooks (indexed by `docs/developers/README.md`). **Internal notes never go in `docs/`; user docs never go in dot-folders.**
- `.plans/` — date-stamped proposal folders (`YYYY-MM-DD-HHMM-<slug>/`, owner sorting convention 2026-10-06 — first: `2026-10-06-1352-main-content-restructure/`). The old implementation plan + decision record retired 2026-10-06 (pre-retirement history is recoverable from git history); the shipped-work record lives in `CHANGELOG.md`. · `.audits/` — internal audit reports · `.agents/` — internal agent reference: `parked-decisions.md` + the **project skills** (`skills/notees-development`, `skills/notees-operations` — Kimi Code auto-discovers project skills from `.agents/skills/`, Project scope)

Full file map: `docs/developers/architecture.md` · normative model & wire: `packages/protocol/SCHEMA.md` (and `WIRE.md`).

## Commands

- Install: `pnpm install` · Build: `pnpm -r --workspace-concurrency=1 build` · Test: `pnpm test` (all green = blocking gate). Full command table, the fixture gate, and the add-an-op recipe: `docs/developers/development.md`.
- **Dev-condition exports**: vitest reads `src`, `tsc` reads `dist` — after changing a package's public API, rebuild its dist before typechecking dependents.
- Deploy: plain Docker, `docker compose build` + `docker compose up -d` from the repo root (the compose build contexts pin the deployment to the local codebase; hosts that haven't built pull :latest) (web :8378, sync :8377; data under `./config/notees/`), then the `verify-min.mjs` smoke — **invoke the `notees-operations` skill first** (plus `deployment-runbook` for the deploy/rollback discipline). Full runbook, ghcr/CI publish path, and the client lockstep law: `docs/developers/releases.md` + `deployment.md`.

## Invariants (design law — read the linked homes before changing the model, wire, or appliers)

- The operation log is the only authority; semantic state only — device state is never an op (`docs/developers/architecture.md`).
- Conflict semantics: **LWW by HLC** (scalars, property values) · **OR-Set add-wins** (class/collection membership) · tag membership mirrors the OR-Set with a strictly-greater add tiebreak (deliberate asymmetry — cheat sheet in `docs/developers/development.md`).
- **Title-is-content** (owner 2026-10-01): no `name` field on the wire — a node's title IS its text content; a page's own content MAY carry inline rich tokens (mentions, external links — the header title is a full block row), class content stays text-only, and display-name derivation still flattens to text (`SCHEMA.md`).
- **Render-state model** (Revision 11, owner 2026-10-02): nodes have no page/block kind — only `is_class` + `present_as_main`. Wire is envelope **v3**; retired keys are rejected outright — **no backward compatibility** (owner directive, sole user): migration is a one-time in-place rewrite of the stored log, after which every store re-syncs (`SCHEMA.md` "Node structure"; `migrations.md`).
- **Node fields vs properties**: platform-fixed, cardinality-1 node fundamentals that core chrome or navigation reads or writes (`coverAssetId`, `bannerAssetId`, `aliasedNodeId` — the icon/color precedent) are **wire node fields**, with derived columns as their direct projections. The property system is for user-extensible typed attributes (class-bound, multi-value, defaulted, qualified, query-filtered) — never for platform fundamentals, and property drift is never answered with reserved-schema machinery.
- **Impossible states are write-time impossible**: structural invariants (extends DAG, alias-chain acyclicity, class-parenting) are validated at the operation level — loud failure, never applied — and render assumes them; there is no UI for impossible states.
- New op types are additive and require protocol fixtures exercising every client applier (TS reference; GTK/Flutter lockstep) before implementation counts as complete (`docs/developers/development.md`).
- Identity is UUIDv7 everywhere; titles/paths/citekeys are attributes, never identity.
- Sync server (PostgreSQL relay) is coordination, not the object database.

## UI primitives

All chrome MUST compose from `apps/web/src/ui/components/ui/` — one element per file, co-located CSS, barrel-exported, token-only CSS (`variables.css`). No ad-hoc styled controls in feature code. Values that track type metrics or layout take the adaptive form (`1lh`/`em`/`ch`/`%`, `clamp()`, spacing/radius/motion tokens), not fixed px numbers — hard-coded px only where the dimension is genuinely constant (hairlines, tap-target floors). **Catalog, the popup-dismissal seam, the drift classes, and the adaptive-values law: `docs/developers/ui-primitives.md`.**

## Working rules (owner)

- **Docs are part of the change**: any change to behavior, the model, the wire, or the UX updates the relevant documentation in the same pass — user-facing `docs/`, `packages/protocol/SCHEMA.md`, `AGENTS.md` / `.agents/` when they describe changed reality, and the `docs/developers/` runbooks.
- **The changelog is the record** (owner 2026-10-06): what shipped and why lives in `CHANGELOG.md` at the repo root — one entry per shipped slice, newest first. `AGENTS.md` itself is static guidance: never append history, dates, or work-record entries to it; edit it only when the guidance changes. Before implementing, skim `CHANGELOG.md` for recent related work and check `.plans/` for an in-flight proposal folder. A change without its changelog + doc updates is not done.
- **Fleet-agnostic artifacts** (owner 2026-10-06): never hardcode machine names (Tailscale device names), IPs, or tailnet names in code, templates, docs, or notes — write `<host>`, `<tailnet>`, `<lan-ip>`, `<tailscale-ip>`, or "the fleet host". Concrete values live only in gitignored host-local files (`.env`) and per-host operator config; example values in templates must be clearly generic (e.g. `192.168.1.10`).
- **Worktrees live in `.worktrees/`** (owner 2026-10-07, extended 2026-10-08): git worktree work goes in the repo's own gitignored `.worktrees/<slug>/` — never a random sibling folder (`git worktree add .worktrees/<slug> -b <slug> main`). Concurrent sessions on unrelated tasks each default to their own worktree (own branch, install, gate) so one session's half-done edits can't break another's tests; slices land one at a time in the main checkout (rebase onto main, fast-forward merge, push — promptly, keeping merges small), and a landed slice cleans up after itself: `git worktree remove .worktrees/<slug>` + `git branch -d <slug>`.
- **Shared record files** (owner 2026-10-08): `CHANGELOG.md`, `README.md`, `docs/`, and `AGENTS.md` are touched by nearly every slice and conflict at merge time by construction — keep edits minimal and anchored (changelog entries prepend under the current date heading, never reorder existing entries) and resolve conflicts by keeping both blocks, never dropping another slice's entry.
- **No transient-internal-doc pointers in the tree** (owner 2026-10-07): code, tests, docs, and CHANGELOG entries never reference `.plans/` proposal folders, design docs, or any internal transient documentation — the durable text stands alone. Internal cross-references live inside the internal docs themselves; the tree carries zero pointers to them.
- **Parallel sessions** (owner 2026-10-08): other agent or human sessions may be working in this repo — and against the same dev environment — at the same time. Detect before writing and before any shared-state action: `git status --porcelain` + `git log --oneline -5` at session start (unfamiliar changes belong to someone else's in-flight task), `git worktree list`, a present `.git/index.lock`, `docker compose ps`. Handle: never revert, delete, reformat, or commit files outside your task (per-file staging only — never `git add -A` / `git commit -a`); red tests or lint errors in files you didn't touch are another session's in-flight work — report them, don't fix them; avoid stack-wide commands (`compose down`, image rebuilds, DB resets under `config/notees/`, killing processes) without checking who else is using the environment — prefer scoped commands; snapshot-commit your own verified stable states so your work is visible and recoverable. Detail: `docs/developers/development.md` + the `agent-repo-workflow` skill.
- **Commit and push when done** (owner 2026-10-08): a finished slice — gate green, `CHANGELOG.md` entry in — is committed (per-file staging only, Conventional Commits) and pushed to the current branch before the session ends. Pushing is standing authorization in this repo; the `agent-repo-workflow` skill's per-push confirmation rule does not apply here. If the remote moved, integrate (`git pull --rebase`), never force.

## Records index (scan, don't embed)

| Record | Home |
|--------|------|
| Shipped work | `CHANGELOG.md` (newest first, one entry per slice) |
| In-flight proposals | `.plans/YYYY-MM-DD-HHMM-<slug>/` |
| Parked decisions | `.agents/parked-decisions.md` |
| Audit reports | `.audits/` |

## Parked decisions (owner)

See **`.agents/parked-decisions.md`** — SDK publish archived (2026-10-03) · releases/lockstep runbook pointer · repo-split state (CLI split out; web split wanted, deferred; `notees-sync` stays).
