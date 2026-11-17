---
name: notees-gtk-development
description: Develop the notees-gtk tree — the Python/GTK4 lockstep desktop client for Notees (envelope v3 wire models, strict payload parity, derived SQLite appliers, threaded sync engine), living at clients/gtk in the Notees monorepo. Use when writing or changing code, the wire models, appliers, fixtures, sync, or UI in this tree. Covers the three-client lockstep law, the fixture byte-pin, the build/test gate, coding conventions, and the changelog-as-record workflow.
---

# notees-gtk development

notees-gtk is one of three implementations of the Notees sync protocol —
the TypeScript core in this monorepo (`packages/*`) is the reference, Flutter
(`clients/flutter`) is the third. This tree ports the wire models
(`core/protocol/`), the REST/WS clients (`core/api/`), the sync engine
(`core/sync/`), and the derived SQLite appliers (`data/`) to Python; the GTK
chrome (`ui/`) is deliberately thin over a headless-testable core.

Canonical protocol references live in this monorepo at `packages/protocol/
SCHEMA.md` (the normative model) and `WIRE.md` (the wire spec) — read them
before touching the wire.

## Non-negotiable laws

1. **The fixture corpus is byte-pinned — never edit fixture bytes.**
   `tests/fixtures/wire/` is the GTK copy of the canonical corpus at
   `packages/protocol/fixtures/` in this monorepo, sha256-identical by fiat.
   It is the cross-implementation convergence anchor shared with Flutter
   (`clients/flutter/test/fixtures/wire/`). The root `fixture-drift` workflow
   fails any commit that changes one copy without the others — never
   hand-patch a drifting copy; update every copy in the same commit. Verify
   with the sha256 procedure in `references/development-workflow.md`.
2. **Lockstep law.** A wire/applier/payload change is NOT done until all
   three implementations converge, each with fixtures exercising every
   affected applier: the TS reference (plus its fixture gate), this client,
   and Flutter. The GTK side of that recipe is in
   `references/development-workflow.md`.
3. **The changelog is the record.** Before implementing, skim `CHANGELOG.md`
   in this tree for recent related work. After shipping a slice, add one
   entry (what shipped, why, how it was verified) in the same pass. A change
   without its changelog entry is not done.
4. **Docs are part of the change.** Wire changes update this monorepo's
   `packages/protocol/SCHEMA.md`/`WIRE.md`; behavior changes update this
   tree's `README.md`/`AGENTS.md`/skills in the same pass when they describe
   changed reality.
5. **Fail loud; no backward compatibility.** Retired wire keys are rejected
   outright by the strict payload schemas and envelope models (`extra=
   "forbid"`), mirroring the zod `.strict()` reference. Never add a compat
   read path.
6. **No legacy version names.** Keep narrative v1/v2 history and milestone
   labels (M1–M5) out of comments, docs, and test titles. Live version
   identifiers stay: envelope v3, `/api/relay/v2`, WS framing v2, the
   `tests/fixtures/wire/` path, `v2.0.0-mN`-style tags, and DB-schema version
   numbers (`SCHEMA_VERSION`, web-schema parity notes).

## Gate before declaring done

Two tiers (the monorepo root's "Gate economics" is the shared law — same
shape here):

- **Scoped (the per-task loop):** `uv run pytest tests/<touched-files>` on the
  tests covering the change + `uv run ruff check` + `uv run mypy src`.
  Red-green rides those files.
- **Full (`uv sync && uv run pytest && uv run ruff check && uv run mypy src`):
  blocking at pre-landing, after a rebase onto a moved main, and when the
  change touches the wire models, appliers, or the sync engine (the lockstep
  surfaces a sibling client compiles against).** All green mirrors
  `.github/workflows/ci-gtk.yml` at the monorepo root.

Host memory discipline: one suite at a time — never parallel full gates (two
concurrent gates OOM the 15Gi dev host); sequential dispatches whose gates
overlap; cap workers under pressure (`uv run pytest -n 2`); a red that
vanishes on an unloaded re-run is a load symptom — root-cause before
retrying.

The live end-to-end module (`tests/test_live_server_e2e.py`) self-skips without a
built sync server — run it deliberately when the change touches the wire:

```sh
pnpm --filter @notees/server build   # at the monorepo root
NOTEES_V2_ROOT=<path-to-monorepo-checkout> uv run pytest tests/test_live_server_e2e.py
```

## Read by topic

- **Development workflow (lockstep recipe, fixture byte-pin, coding
  conventions)** → `references/development-workflow.md`
- **Releases & packaging (`gtk-v*` tags, CI, PKGBUILD)** → the
  `notees-gtk-operations` skill and its `references/releases.md`
