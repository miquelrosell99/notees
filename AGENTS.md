# AGENTS.md

Self-hosted, privacy-first, local-first note-taking application with FastAPI backend and React frontend.

Formal docs live under `skills/`. Read `skills/*/SKILL.md` — default to `primary: true` skill; only switch when task clearly matches another skill's description.

Conflicts between loaded project instructions → formal docs in `skills/notees/` win. This does not override harness-native skill name precedence.

## Documentation layout (v2)

- `v2/docs/` — **user-facing only** (usage, philosophy, ux).
- `v2/.plans/` — internal plans, the decision record (`2026-09-24-object-graph-pim-evolution/`), the design stack (`design/`), and dev docs (`dev/`: architecture, development, deployment).
- `v2/.audits/` — internal audit reports (evidence-based assessments, gap analyses, competitive sweeps).

Internal project notes never go in `docs/`; user-facing docs never go in dot-folders.

## v2 repo split & SDK — STATUS (owner decision, in progress)

Owner decided (2026-09-26): split into `notees-sync` + `notees-web` repos **inside this folder** (`/etc/periphery/stacks/notees/{notees-sync,notees-web}`), deployed by a **folder-level `compose.yaml`** at `/etc/periphery/stacks/notees/compose.yaml`; existing `notees-gtk`/`notees-flutter` stay separate. The monorepo (this repo, `v2/`) remains the source of truth for the shared packages and the fixture gate.

**Blocked / pending:**
- **SDK publish — BLOCKED on an npmjs token** (owner doesn't have one; GitHub Packages rejects the `@notees/*` scope — it must equal the owner). Publish infra is READY: tsup builds per package, `pnpm release` in `v2/`, flow documented in `v2/.plans/dev/sdk-publishing.md`. Owner action: create a free token at npmjs.com, then run the release flow. Until published, consumers bridge with `pnpm.overrides` → `file:.worktrees/greenfield-m1/v2/packages/<name>` (requires `pnpm -r build` in the worktree first).
- **Repo extraction — PARKED** (two attempts interrupted). Sources of truth remain `v2/apps/server` and `v2/apps/web`. To finish: extract both to `/etc/periphery/stacks/notees/notees-{sync,web}` → semver deps `^0.1.0-m1` + the file: overrides above → **externalize `@notees/*` in the server's tsup config** (it currently bundles workspace TS) → per-repo Dockerfiles (sync: node:22-alpine + `NOTEES_DATA_DIR=/data` volume, EXPOSE 8377; web: nginx serving the vite build with a runtime `/config.js` from `NOTEES_SERVER_URL`) → folder-level `compose.yaml` (services `notees-sync` + `notees-web`, named volume, healthchecks) → `git init -b main` in each. Monorepo copies stay until the split repos verify green, then remove.
- **Client lockstep — NOT STARTED**: `notees-flutter`/`notees-gtk` cloned at `/etc/periphery/stacks/notees-clients/` on `protocol-v2` branches; their protocol layers await the v2 wire spec (`v2/packages/protocol/WIRE.md`).

<!-- The <always-applicable> and <task-routing> XML tags below are load-bearing.
     Rationale: LLMs parse XML-tag blocks as discrete hard-constraint sections
     more reliably than plain markdown headings, especially after context
     compression. See skill's references/thin-shells.md § XML-Tag Injection. -->

<always-applicable>

**Always Read (every task, in addition to route-specific reads)**

<!-- ALWAYS_READ_START -->
- `skills/notees/rules/project-rules.md`
- `skills/notees/rules/coding-standards.md`
- `skills/notees/rules/agent-behavior.md`
<!-- ALWAYS_READ_END -->

**Route-before-routing check**: if the request contains vague improvement verbs ("refactor / clean up / optimize / make it better / 整理 / 重构 / 优化") **without** a concrete module/file or verifiable outcome → stop and ask for scope. Do not offer partial plans; see `skills/notees/protocol-blocks/ambiguous-request-gate.md` if present.

</always-applicable>

Route metadata lives in `skills/notees/routing.yaml`; the bootstrap below tells agents how to match it.

<task-routing>

**Quick Routing (survives context truncation)**

<!-- ROUTING_BOOTSTRAP_START -->
Task routes live in `skills/notees/routing.yaml`.

For every new task:
1. Read `skills/notees/routing.yaml`.
2. Match by `labels`, `trigger_examples`, and task intent.
3. Read only that route's `required_reads` plus Always Read files.
4. Follow that route's `workflow`.
5. If no route matches, use the `other` route.
<!-- ROUTING_BOOTSTRAP_END -->

</task-routing>

<!-- BEHAVIOR_BLOCK_START -->
## Auto-Triggers

- **New task in same session** → always re-match the route (Common Tasks / `routing.yaml`); the new task may need a different route. Re-read the route's files only if the route changed or context was compacted (a fresh `skills/notees/SKILL.md` injection is the signal) — unchanged background stays in context, don't re-read it every task. Can't tell if context compacted? Re-read.
- Before declaring any non-trivial task complete → run Task Closure Protocol (see `skills/notees/workflows/task-closure.md`)
- Skip closure only for: formatting-only, comment-only, dependency-version-only, or behavior-preserving refactors
- When user asks to "record/save/remember" something → project-level knowledge goes to `skills/notees/` docs; personal preferences go to agent memory

## Red Flags — STOP

- "Just this once I'll skip the AAR" → stop. See `skills/notees/workflows/task-closure.md` § Rationalizations to Reject.
<!-- BEHAVIOR_BLOCK_END -->
