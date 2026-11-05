# Parked decisions

The owner-parked calls, newest context first. Each entry records what is
parked, the date, and what would un-park it. Referenced from AGENTS.md;
the record of shipped work lives in `CHANGELOG.md`.

## Payload-shape follow-ups — UN-PARKED AND SHIPPED (2026-10-30)

The owner un-parked both items the same day; both shipped:

- **`listPageSummaries`** (92334c3a1): the lean title-only listing read
  (~5.6MB → ~1MB per listing transfer); title-pool consumers migrated,
  content-reading consumers (collection hub, picker cold-row fallback,
  agenda rows) stay on full `listPages()`.
- **Lazy property values** (8a00174be): `getPropertyRowShells` — same rows
  as `getEffectiveProperties` but the value ships only for light types
  (select/multi_select/boolean/number/date/datetime); heavy types send
  `value: null + valueCount + deferred`. Every outline BlockRow, the
  calendar row facts, task/card buckets, hub grouping, and the collapsed
  PropertiesSection count probe migrated; page-header PropertiesTable and
  editors keep the full read (expanded sections mount on expansion —
  values on demand). This removes the ~11k first-serve bulk at boot.

**Re-park condition**: if workspace growth re-makes first-serves dominate
(listings past ~100k rows, or a future surface enumerating heavy values
bulk-style), the next lever is visibility-observer value loading on the
remaining full-read surfaces — none needed today.

## Tauri desktop client — UN-PARKED (owner, 2026-11-05) — ships as a notees-web build target

The owner un-parked this on 2026-11-05: Tauri v2 ships as a **build target
in the `notees-web` repo** (`src-tauri/` — a minimal single-window shell
hosting the web client; CI builds unsigned Windows .msi + macOS .dmg
installers on `v*` tags). The parked preconditions resolved differently
than feared: the web split happened first (2026-11-05), so the web app is
already consumable as a standalone repo; the shell reuses the vendor-pinned
core packages like any other client.

- **The niche question is settled the same narrow way**: Tauri remains the
  Windows/macOS desktop target only — GTK stays Linux-native; the two must
  not overlap.
- **Sibling-client implications: none for GTK/Flutter.** The desktop shell
  uses the TS reference directly through the web client's own store
  (sql.js/OPFS in the webview, per `detectStoreMode`) — there is NO Rust
  SQLite port and no new store backend to keep fixture-identical, so no
  GTK/Flutter lockstep debt is created. The only fixture-relevant surface
  would be a future Rust store backend, which is explicitly out of scope.
- The shell has zero custom native commands for v1 — the web boot flow
  keeps owning server URL + login.

## SDK publish — ARCHIVED (owner, 2026-10-03)

The npmjs token is not being pursued for now. Publish infra stays in the
tree (`pnpm release`, `docs/developers/sdk-publishing.md` — archived
reference) and the packages stay versioned, but npm distribution (and the
repo split that sat behind it) is off the table until the owner re-opens
it.

## Releases & the client lockstep

Full runbook: `docs/developers/deployment.md`; the clients themselves (each
owns its releases, tags, and CI publishing) are listed in
`docs/developers/README.md`. The load-bearing laws in
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
  emptying restores factory behavior). The transient filter layer and the
  one-grammar AST contract shipped (record: `CHANGELOG.md` 2026-10-07); the
  stored-table half is the follow-up.
- **Rail card management** (reorder) and the **hover-preview → NodeView
  preview** swap — registered follow-ups from the cards-only rail slice.
- **The M38 empty-cover/empty-banner upload triggers** — shipped with the
  banner; the empty-banner modal trigger noted for verification.
- **Client follow-ons from the alignment batches** — DONE (2026-10-07):
  the Flutter local-seed display titles + full events family and the
  GTK/Flutter alias UI chrome all shipped. Two notes remain: the GTK
  client's LOCAL seed likely needs the same display-title mirror if it
  emits raw keys, and the Flutter app's navigation could wire resolveAlias
  app-wide (the web's universal redirect) plus the AliasOfBanner port. **Extended 2026-10-07:** the GTK/Flutter derived
  schemas gain the store v17 `edge.resolved_target_id` column (the alias
  resolved-target materialization — same write-time/re-resolution
  semantics; recorded in SCHEMA.md "Node aliases").

## Repo split (notees-sync / notees-web)

- **CLI** — split out 2026-10-05: `notees-cli` lives
  in its own repo (sibling to the GTK/Flutter clients), consuming the
  packages via a pinned `vendor/notees` git submodule as pnpm workspace
  projects — no npm distribution.
- **Web** — the split is registered as wanted with execution deferred to a
  quiet tree and four preconditions: gate/CI redesign, deploy-path
  redesign, quiet tree, same-pass docs.
- **`notees-sync` stays in the monorepo.**
- **Plan-07 ruled trades (server slimming)** — two capability trades were
  ruled, not drift: (1) the workspace zip export is CLIENT-side and covers
  the CONNECTED workspace only (unopened workspaces can't export — the
  server no longer bundles from the derived store); (2) `/<node-uuid>` deep
  links open the remembered workspace (the server node-location route was a
  content read, retired) — cross-workspace resolution degrades to the
  honest not-found after sync. Both recorded in the plan-07 changelog.
- **Plan-07 third ruled trade (key-gated content reads)** — the three kept
  content reads (`GET /api/resolve?name=`, `GET /api/classes(/:id)`,
  `GET /api/properties/:id/values`) are KEY-GATED: a workspace with a
  `workspace_key` row gets 404s (content reads are client-side over the
  local derived store); keyless workspaces keep them for CLI/legacy
  compat. Same row gate as the seed shim — the gate IS the key row.
