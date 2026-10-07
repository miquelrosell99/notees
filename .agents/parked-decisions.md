# Parked decisions (owner)

The owner-parked calls, newest context first. Each entry records what is
parked, the date, and what would un-park it. Referenced from AGENTS.md;
the record of shipped work lives in `CHANGELOG.md`.

## SDK publish — ARCHIVED (owner, 2026-10-03)

The npmjs token is not being pursued for now. Publish infra stays in the
tree (`pnpm release`, `docs/developers/sdk-publishing.md` — archived
reference) and the packages stay versioned, but npm distribution (and the
repo split that sat behind it) is off the table until the owner re-opens
it.

## Releases & the client lockstep

Full runbook: `docs/developers/releases.md`. The load-bearing laws in
short:

- Git tags are the release mechanism — no GitHub Releases on this repo;
  ghcr images publish via CI on `v*` tags; X.Y.Z versioning forever.
- **Any new op / strict payload change requires the three-way lockstep**
  (TS reference with fixtures, GTK, Flutter) before it counts as done, and
  pre-batch clients fail loud on new envelopes — update clients before
  mixing writers; never run a pre-batch client build against a migrated
  server.
- The current wire state and batch history live in
  the runbook, not in AGENTS.md.
- Live data changes follow `docs/developers/migrations.md` (dry-run
  scripts, backups, snapshot/restore-epoch/restart sequence).

## Main-content restructure — follow-on register (2026-10-07)

The restructure program shipped (record: `CHANGELOG.md` 2026-10-06/07).
Deferred items and follow-on tickets, migrated here before the proposal
folder's retirement:

- **Custom views as stored tabs** (`section_view` table: node/section/name/
  sequence/query_ast composed on the derived base row set; the tab system
  is NodeCollection chrome; the derived-not-stored law — no default rows,
  emptying restores factory behavior). Design: the transient filter layer
  and the one-grammar AST contract shipped; the stored-table half is the
  follow-up.
- **The transient filter layer** (`filterable` sections, FilterSpec applied
  post-resolution/pre-windowing) — designed, unscheduled.
- **Rail card management** (reorder) and the **hover-preview → NodeView
  preview** swap — registered follow-ups from the cards-only rail slice.
- **The materialized resolved-target column** for alias edges (the
  roll-up's documented later optimization; the indexed recursive-CTE read
  serves at current scale).
- **The REST `ApiObject` response exposing the three wire fields** — the
  op log is the authoritative path; flagged, unscheduled.
- **The query-builder-guard coalescing test's load-sensitivity** — a
  stability pass on the timing assertion.
- **The M38 empty-cover/empty-banner upload triggers** — shipped with the
  banner; the empty-banner modal trigger noted for verification.

## Repo split (notees-sync / notees-web)

- **CLI** — split out 2026-10-05: `notees-cli` lives
  in its own repo (sibling to the GTK/Flutter clients), consuming the
  packages via a pinned `vendor/notees` git submodule as pnpm workspace
  projects — no npm distribution.
- **Web** — the split is registered as wanted with execution deferred to a
  quiet tree and four preconditions: gate/CI redesign, deploy-path
  redesign, quiet tree, same-pass docs.
- **`notees-sync` stays in the monorepo.**
