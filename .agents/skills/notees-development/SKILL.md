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

1. **The fixture gate is blocking.** A new op type or strict payload change is
   NOT done until fixtures exist in `packages/protocol/fixtures/` and every
   client applier converges — the TS reference here **plus** the GTK and
   Flutter ports (byte-identical fixture files, sha256-checked). Recipe:
   `references/development-workflow.md`; law: `development.md` §§3–4.
2. **Dev-condition exports.** vitest reads `src`, `tsc` reads `dist` — after
   changing a package's public API, rebuild its dist before typechecking
   dependents.
3. **The plan is the record.** Before implementing, check
   `.plans/implementation-plan.md` for an existing design (follow it or improve
   it in place). After shipping, append a §34 work-record entry (what shipped,
   verification, register cross-checks) in the same pass. A change without its
   record is not done.
4. **Docs are part of the change.** Same-pass updates to `docs/`,
   `packages/protocol/SCHEMA.md`, AGENTS.md / `.agents/`, and the
   `docs/developers/` runbooks for anything behavior/model/wire/UX changes.
5. **Fail loud; no backward compatibility.** Retired wire keys are rejected
   outright; changes are additive, or a versioned breaking bump with fixtures
   and the client lockstep.
6. **Don't fake the designed-not-built register** (`development.md` §8) —
   typed-link resolution, citations, E2EE, plugins, TreeCrdt port, the outliner
   editor program, etc. are not shipped. Never document, test, or build
   against them as if they existed.
7. **Code wins over design docs** where they disagree
   (`architecture.md` §11). Known doc lags: `development.md` §2 claims the root
   has no `build` script (it has — `pnpm -r build`), and `architecture.md` §3
   says `SCHEMA_VERSION = 8` (the derived store is v15; `releases.md`'s
   current-wire line is the freshest source).

## Gate before declaring done

```sh
pnpm install && pnpm typecheck && pnpm test   # from repo root; all green = blocking gate
```

## Read by topic

- **Architecture** → `references/architecture.md`
  (canonical: `docs/developers/architecture.md`)
- **Coding conventions** → `references/coding-conventions.md`
  (canonical: `development.md` §7 + `docs/developers/ui-primitives.md`)
- **Development workflow** → `references/development-workflow.md`
  (canonical: `development.md`)
