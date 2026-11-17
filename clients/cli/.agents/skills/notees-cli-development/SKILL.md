---
name: notees-cli-development
description: Develop the Notees CLI (`clients/cli` in the Notees monorepo) — the `notees` command-line client consuming the monorepo's `packages/*` as a root pnpm workspace project. Use when writing or changing CLI code, tests, commands, exporters, or docs in this tree. Covers the workspace lockstep law, the build/test gate, coding conventions, and the changelog-as-record + docs-in-the-same-pass rules.
---

# Notees CLI development

`@notees/cli` (`clients/cli`) is a workspace project of the Notees monorepo
(Node 22 or 26, pnpm 9, TypeScript, vitest), joined to the root pnpm
workspace — there is no `vendor/notees` submodule anymore. The `@notees/*`
packages are **not** published anywhere: they resolve from `packages/*` as
workspace projects (`workspace:*`), and the test suite boots a real
`@notees/server` to exercise the CLI end-to-end. This skill is the working
contract for changing anything in this tree.

Canonical docs: `README.md` here (setup, workspace consumption, versioning)
and the monorepo root's `docs/developers/` runbooks.

## Non-negotiable laws

1. **The monorepo workspace is the lockstep boundary — there is no `vendor/`.**
   The core packages live in this repo at `packages/*`; a wire/applier/model
   change lands there and the CLI consumes it as a workspace project. A
   wire/applier/model change is not done in the monorepo until its fixture
   gate converges (TS reference + GTK + Flutter over byte-identical,
   sha256-pinned fixtures in `packages/protocol/fixtures/`) — and the root
   `fixture-drift` workflow fails any commit that changes the canonical
   corpus without updating the GTK (`clients/gtk/tests/fixtures/wire/`) and
   Flutter (`clients/flutter/test/fixtures/wire/`) copies in the same
   commit. Never edit fixture bytes anywhere; recipe:
   `references/development-workflow.md`.
2. **Dev-condition exports.** vitest resolves `src`, `tsc` resolves `dist`.
   After changing a `packages/*` public API, run `pnpm -r --filter "@notees/*"
   build` before `pnpm typecheck` / `pnpm test`.
3. **The gate is blocking.** Before declaring anything done:
   `pnpm typecheck && pnpm test` — all green.
4. **The changelog is the record.** Before implementing, skim `CHANGELOG.md`
   for recent related work and check `.plans/` (monorepo root) for an
   in-flight proposal folder. After shipping, add a `CHANGELOG.md` entry
   (what shipped, verification) in the same pass. A change without its
   record is not done.
   The changelog is **app changes only** — never operations on a personal
   workspace or its specifics (names, ids, sizes, per-workspace counts,
   personal node samples); data work is reported to the owner, not recorded.
   State rules and facts **directly** — no attribution parentheticals in `CHANGELOG.md` or `AGENTS.md`.
5. **Docs are part of the change.** Same-pass updates to README.md (commands,
   flags, behavior) and command help text.
6. **No-legacy-version-names.** Live version identifiers (`/api/relay/v2`,
   envelope v3, the `notees-json-archive` v1 envelope, `v2.0.0-mN` tags) are
   wire/format facts — keep them exact; never use v1/v2 as narrative-history
   qualifiers in comments/docs/tests, and no M1–M5 milestone labels.
7. **`--json` is the stable machine surface.** The JSON output shape is
   additive-only (agents consume it); human-readable text may change freely.
   Exit codes follow `src/exit-codes.ts` (0 ok, 1 domain, 2 usage, 3 auth,
   4 conflict, 5 network) — a changed exit code is a breaking change.

## Gate before declaring done

Two tiers:

- **Scoped (the per-task loop):** `pnpm typecheck` + `pnpm test` on the test
  files covering the change (or `pnpm --filter <area> test -- <files>`).
  Red-green rides those files.
- **Full (`pnpm typecheck && pnpm test` from the repo root): blocking at
  pre-landing, after a rebase onto a moved main, and when the change touches
  the core packages' public API or the batch/shell write paths.**

Host memory discipline: one suite at a time — never parallel full gates (two
concurrent gates OOM the dev host); sequential dispatches whose gates overlap;
the suite boots a real `@notees/server`, so give it room; a red that vanishes
on an unloaded re-run is a load symptom — root-cause before retrying.

## Read by topic

- **Development workflow** (commands, workspace build recipe, test-suite
  shape, conventions) → `references/development-workflow.md`
  (canonical: `README.md` here + the monorepo root's
  `docs/developers/development.md`)
