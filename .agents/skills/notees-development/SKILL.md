---
name: notees-development
description: Develop the Notees monorepo — an op-log-authoritative object graph (envelope v3, derived SQLite projections, TS reference with GTK/Flutter client lockstep). Use when writing or changing code, the model, the wire, appliers, fixtures, sync, or the web UI in this repo. Covers architecture, coding conventions, and the development workflow (fixture gate, add-an-op recipe, conflict law, plan-as-record).
---

# Notees development

Notees is one object graph whose only authority is an immutable operation log
(envelope **v3**); every SQLite database (server, browser worker, CLI
projections) is a derived, wipe-rebuildable projection of that log. This skill
is the working contract for changing anything in this monorepo.

Canonical runbooks (person-facing, kept current in the same pass):
`docs/developers/architecture.md` + `docs/developers/development.md` — follow
the section references in `references/` when a topic needs more than the
summary here.

## Non-negotiable laws

0. **A v1 port is 1:1 before it is adapted** (owner 2026-10-09). When the
   owner asks to port a v1 surface, enumerate the ENTIRE v1 register first —
   every block type, every operator, every mode (static/dynamic, all the
   per-type options) — and implement the full set against the v2 grammar
   before shipping. A reduced subset is a proposal to the owner, never a
   silent default; wire gaps found mid-port (a v1 construct with no v2
   condition) get the full wiring — protocol condition, compiler arm,
   evaluation — in the same slice, not an exclusion.
1. **The fixture gate is blocking.** A new op type or strict payload change is
   NOT done until fixtures exist in `packages/protocol/fixtures/` and every
   client applier converges — the TS reference here **plus** the GTK and
   Flutter ports (byte-identical fixture files, sha256-checked). Recipe:
   `references/development-workflow.md`; law: `docs/developers/development.md`.
2. **Dev-condition exports.** vitest reads `src`, `tsc` reads `dist` — after
   changing a package's public API, rebuild its dist before typechecking
   dependents.
3. **The changelog is the record.** Before implementing, skim `CHANGELOG.md`
   at the repo root for recent related work and check `.plans/` for an
   in-flight proposal folder. After shipping, add a `CHANGELOG.md` entry (what
   shipped, verification) in the same pass. A change without its record is not
   done.
4. **Docs are part of the change.** Same-pass updates to `docs/`,
   `packages/protocol/SCHEMA.md`, AGENTS.md / `.agents/`, and the
   `docs/developers/` runbooks for anything behavior/model/wire/UX changes.
5. **Fail loud; no backward compatibility.** Retired wire keys are rejected
   outright; changes are additive, or a versioned breaking bump with fixtures
   and the client lockstep.
6. **Don't fake the designed-not-built register**
   (`docs/developers/development.md`) — typed-link resolution, citations, E2EE,
   plugins, TreeCrdt port, the outliner editor program, etc. are not shipped.
   Never document, test, or build against them as if they existed.
7. **Code wins over design docs** where they disagree — fix the doc in the
   same pass (freshness cues: `releases.md`'s current-wire line for the wire,
   `packages/store/src/schema.ts` for the derived schema).
8. **The test workspace is the only workspace for agent work** (owner
   2026-10-09). Anything that touches a live workspace — API calls, browser
   probes (seed `notees.workspaceId`, don't click through the picker), CLI
   writes, verification data — happens in the test workspace
   `c491595f-9f94-5ade-a620-e30ed063d8d2` (fixed uuid, disposable), never
   the personal default "Notas" `3b30e070-039b-47bc-ad0d-2440a2f173c5` (the
   owner's live data). Probe data is created there and deleted when done.
   Detail: `references/development-workflow.md`.

## Gate before declaring done

```sh
pnpm install && pnpm typecheck && pnpm test   # from repo root; all green = blocking gate
```

Green gate + changelog entry in → commit the slice (per-file staging,
Conventional Commits) and `git push` to the current branch. Pushing is
standing authorization in this repo — the `agent-repo-workflow` skill's
per-push confirmation does not apply here.

**Redeploy what you ship** (owner 2026-10-08): the running stack carries the
LOCAL build, not the repo — a code change is not live until the image is
rebuilt and the stack recreated. Before ending the session:
`docker compose build <changed services> && docker compose up -d`, then the
`verify-min.mjs` smoke — **invoke the `notees-operations` skill first**
(deployment discipline + rollback law). Docs-only or repo-only slices (no
runtime behavior) need no redeploy.

## Read by topic

- **Architecture** → `references/architecture.md`
  (canonical: `docs/developers/architecture.md`)
- **Coding conventions** → `references/coding-conventions.md`
  (canonical: `docs/developers/development.md` + `docs/developers/ui-primitives.md`)
- **Development workflow** → `references/development-workflow.md`
  (canonical: `docs/developers/development.md`)
