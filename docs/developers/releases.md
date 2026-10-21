# Notees — Releases & Client Lockstep (developer runbook)

Release mechanics and the three-client wire contract. Companion docs: `migrations.md` (live data changes) and
`deployment.md` (the full deployment reference) — all in this folder.

## 1. The main repo ships docker images only

- **GitHub Releases are not used**. Git tags are the release mechanism.
- **ghcr publish is CI-driven** (`.github/workflows/release-docker.yml`):
  pushing a `v*` tag publishes `notees-sync` + `notees-web` at that tag
  (semver patterns: `vX.Y.Z`, `X.Y`) + `latest`, using the workflow's
  `GITHUB_TOKEN`. The host's docker login stays **read-only** — host-local
  builds + `docker compose up -d` remain the deploy path (deployment.md).
- Re-publish an existing release's images without a new tag:
  `gh workflow run release-docker.yml -f image_tag=X.Y.Z`.
- **Versioning: X.Y.Z forever** — the `2.0.0-mN`
  milestone tags are retired (main started at `v3.0.0`; the GTK/Flutter repos
  keep their historical m-tags and moved to X.Y.Z at v3.0.0). A same-day
  correction ships as the next patch (v3.3.0 → v3.3.1), not a re-tag.
- Version state lives in the git tag; `pyproject.toml`/pubspec are not bumped
  per release (the Flutter versionCode derives from the tag at CI time).

## 2. Deploy on the fleet host

Plain Docker — Komodo is NOT required (it is an optional convenience over the
same compose file). From the repo root:

```sh
docker build -f apps/server/Dockerfile -t ghcr.io/miquelrosell99/notees-sync:latest . \
&& docker build -f apps/web/Dockerfile -t ghcr.io/miquelrosell99/notees-web:latest . \
&& docker compose up -d
```

Compose defaults to `:latest` — but the compose file carries the build
contexts, and the development flow is `docker compose build` + `docker
compose up -d`: the deployment always runs the local codebase. A host that
hasn't built pulls `:latest` from ghcr instead (the default pull policy,
left alone). Smoke afterwards:
`node scripts/screenshots/verify-min.mjs` from `scripts/screenshots/` with
`NOTEES_ADMIN_PASSWORD` (on the fleet host: `export NOTEES_ADMIN_PASSWORD=$(cat config/notees/.admin_password)`).

## 3. Client lockstep — the law and the current wire

**Any new op / strict payload change requires the three-way lockstep before it
counts as done: TS reference (with fixtures exercising every applier), GTK
port, Flutter port.** Pre-batch clients fail loud on new envelopes — update
them before mixing writers.

Repo checkouts used for releases (both clean, tagged from `main`):
- GTK: `/etc/periphery/stacks/notees-clients/notees-gtk` — Python/pydantic
  strict payloads; store `SCHEMA_VERSION`; `uv run pytest` + `ruff` + `mypy`
  are the CI gates; tag → CI publishes sdist/wheel + Arch package + a GitHub
  Release (unlike the main repo, the GTK repo DOES use GitHub Releases).
- Flutter: `/etc/periphery/stacks/notees-clients/notees-flutter` — Dart,
  hand-rolled validators; app DB version at the two `openDatabase` sites;
  `flutter analyze` + `flutter test` before every push (SDK at
  `~/flutter-sdk`); release APKs ONLY via CI (`v*` tag → production-signed APK
  + GitHub Release; `android.yml` produces debug-signed CI artifacts for
  try-out builds).

**Current wire (through the 2026-10-21 readonly retirement):** envelope v3; Revision-12
render state; `object.restore`; the color grammar; the
workspace-feature batch (`workspace.feature.set`, `code_block`/`hr`, `embed_ref.view`, PG5
element ids, PC4 `active`, PC6 qualifiers); number formats; the
property batch — **option `icon` (strip-safe additive JSON), and the render
contracts `display`/`readonly`/`hideWhenEmpty` on the PROPERTY SCHEMA
(`propertySchema.create/update`)**; the wire node fields —
`object.update` gains optional nullable `coverAssetId`/`bannerAssetId`/`aliasedNodeId`
(store v16; fixture `object-wire-fields.json`), superseding the retired
cover/banner/aliasOf property schemas (live assertions migrate via
`scripts/migrate-cover-banner-alias.mts`); the per-block list style —
`object.create`/`object.update` gain optional nullable `listStyle`
(`"numbered" | "alpha" | "roman"`, absent/null = bullet; store v23; fixture
`object-list-style.json`; the marker number is derived at render time, never
stored); **the property-definition batch — the
retired `scope` enum is REJECTED outright, replaced by `scopeClassIds` (absent/null
= global, non-empty = local to those classes + extends; the SOLE locality
authority — bindings carry zero availability semantics); schema-level `icon`;
`propertySchema.update` gains `scopeClassIds`/`targetClassFilter`/`multi`/`validationRules`
(`{min?,max?,pattern?}`, keep/clear); fail-loud extends-aware eligibility at
`property.set` (R3) and `class.property.set` (R5); eligible-tagged effective reads;
validationRules VALUE enforcement at `property.set`; store v24 (the
property_schema rebuild); gate 33→36 (`property-schema-scope.json`,
`property-schema-update-fields.json`, `property-validation-rules.json`) — the
2026-10-07 wire fields + class conversion + asset type shipped in the clients'
2026-10-07 lockstep (GTK v4.1.x / Flutter v4.0.x), and this batch's ports are
GTK **v4.2.0** (store v16) / Flutter **v4.1.0** (DB v31) — fixtures 36/36
byte-identical both; the live migration ran the same day (5,389 + 175 envelopes,
snapshots patched, epochs 10/4) and the stack redeployed — VERIFY-PASS.**
TS reference: main repo
**v4.4.0** (store v24); GTK **v4.2.0** (store v16); Flutter **v4.1.0**
(app DB v31). The GTK UI has no property rendering (protocol+store port
only); Flutter renders the block-bullet value button.

**The 2026-10-21 binding-sequence retirement (a continuation of
the property-definition batch):** `sequence` RETIRES from `class.property.set`
— class properties render as a PURE ALPHABETICAL list everywhere (by property
name, a read-time derivation), so panel order no longer exists to configure;
the binding is strictly `{classId, propertySchemaId, active?}` (`active` the
soft-unbind flag, the only per-class mechanic left). The strict payload
rejects the retired key outright; store v25→v26 rebuilds `class_property`
without the `sequence` column (no snapshot byte patch — no data to backfill);
the class-page property panel's drag-and-drop reorder is gone with it (the
list is display-only, alphabetical at render time). The four sequence-bearing
fixtures re-vendor (gate stays 36). LOCKSTEP: GTK/Flutter ports ship the same
day (the required/defaultValue precedent); the live log rewrites via
`scripts/migrate-drop-binding-sequence.mts` (Path B, in-place strip + epoch
bump — no compensation) after the ports. The CLI's `property bind --sequence`
flag retires with a pending lockstep follow-up in the notees-cli repo.

**The 2026-10-21 readonly retirement:** the
`readonly` render contract RETIRES from `propertySchema.create/update` — an
enumeration of the seeds finds ZERO system properties that ever carried the
flag, so it was never user configuration: clients DERIVE readonly-ness from
the system property list (`isReadonlyProperty`, packages/domain — the
platform-provenance schemas `generatedFrom` + `alias`, fixed seed UUIDs) and
the strict payloads reject the retired key outright. `hideWhenEmpty` and
`display` stay user-facing render contracts. Store v26→v27 rebuilds
`property_schema` without the `readonly` column (no snapshot patch — nothing
to backfill). Web chrome in the same slice: the class view loses the "No
templates bound" empty text, the class-properties pill says "Bind property"
(the domain verb, unifying with "Bind template"), and the aliases row hides
entirely until ≥1 alias exists (the page-header action row carries the add
gesture). LOCKSTEP: GTK/Flutter ports ship the same day; the live log
rewrites via `scripts/migrate-drop-schema-readonly.mts` (Path B, in-place
strip + epoch bump — no compensation) after the ports.

**The 2026-10-07 wire batch (second, third, and fourth changes of the day):**
(1) the wire node fields (`object.update` optional nullable
`coverAssetId`/`bannerAssetId`/`aliasedNodeId`, store v15→v16 — above);
(2) the `class.create` conversion capability — `class.create` on an existing
node declares it a class (the retired class-class ruling; no payload keys
change, so pre-batch clients apply the registry upsert but never flip
`is_class` — the live migration gates on the ports); (3) the `asset`
property type (a new value in `propertySchema.create`'s strict type enum —
pre-batch clients reject retype envelopes). Canonical fixtures
`object-wire-fields.json`, `class-convert.json`, `property-asset-type.json`
(gate 21→24). **GTK/Flutter ports SHIPPED in the clients' 2026-10-07 lockstep
(GTK v4.1.x / Flutter v4.0.x).** Also shipped applier-side with no
wire footprint: write-time alias-cycle validation (`CycleError`, the
extends-DAG precedent) and the `Store.resolveAlias` chain walker; the alias
read-path repointing shipped the same day in the read-layer slice below — no
wire change, no store schema change.

**The 2026-10-05/06 issue batch (#1–#14):** NO new op types and NO strict
payload changes anywhere in the batch (including the flag pass) — the
wire contract above is untouched, so no three-way lockstep was required and
pre-batch clients keep working. What did ship: read-side store additions
(`referencesWithRollup`, `aliasOfTarget` — additive methods, no schema
change beyond the v15 index), seeded vocabulary (the `aliasOf` property
schema …0029 and five system classes …0043–…0047 — plain seeds by ruling:
zero wire cost, clients pick them up via their package pin),
server coordination state (workflow rules — the prefs/shares/plugins
precedent, no wire change), and the entire web surface. Client alignment for
this batch = bumping the package pins + releases, not code ports.

## 4. Lockstep batch history

| Batch | Day | Contents |
|---|---|---|
| color grammar | 2026-10-03 | preset-token \| `#RRGGBB` \| null; retired `var(--color-preset-*)` rejected; GTK wheel/sdist/archpkg + Flutter signed APK from the tags |
| workspace-feature batch | 2026-10-04 | `workspace.feature.set`, `code_block`/`hr`, `embed_ref.view`, PG5 element ids, PC4 `active`, PC6 qualifiers — TS (gate 13→21), GTK v3.0.0 (632 tests), Flutter v3.0.0 (529 tests) |
| number formats | 2026-10-05 | `numberPad`/`numberDecimals`/`numberRounding` — TS v3.1.5, GTK v3.0.2 (store v10), Flutter v3.0.2 (DB v24) |
| scratchpad | 2026-10-05 | Flutter seed drops the scratchpad page (v3.0.3) — no wire change, GTK unaffected |
| property batch | 2026-10-05 | option `icon` + task-status glyphs/colors + schema-level `display`/`readonly`/`hideWhenEmpty` (`required` per-class) — TS v3.3.0→v3.3.1 (store v13→v14 after the owner review moved the flags), GTK v3.1.0→v3.1.1 (store v11→v12), Flutter v3.1.0→v3.1.1 (DB v25→v26); live log rewritten by `migrate-binding-flags-to-schema.mts` |
| perf batch (parallel session) | 2026-10-05 | main-thread SQL jank fixes: guarded 2 s status poll, revision-cached render-path list reads, in-process-store banner, store v15 list-reads index, classIcons narrow read, per-row identity cache — TS-only, no wire change; folded into the v3.4.0 line below |
| the GitHub-issues batch (#1–#14) + owner-flag pass | 2026-10-06 | All 14 open issues + the flagged follow-ups (alias /resolve parity, chain-resolved row icons, focus-mode icon scope, five new seeds) — no wire change, no lockstep; TS **v3.4.0** (store v15); client alignment = package-pin bumps (GTK/Flutter/CLI rows below) |
| web batch (ghost block, backend-down ladder, flake fix, empty-block click target) | 2026-10-06 | Web/ops only — no wire change, no store schema change (the single packages/ delta is the sql.js adapter's error normalization); TS **v3.4.1** (store v15); **client alignment: none needed** — the clients' pins (CLI vendor v3.4.0, GTK/Flutter v3.1.2) are unaffected by a web-only delta; ghcr `notees-sync`/`notees-web` v3.4.1 + latest from the tag |
| web batch (hover-calm chrome, breadcrumbs, notify-storm perf, sync-details modal, the Capacities-style main layout) | 2026-10-06 | resting-calm chrome, editable breadcrumbs, the coalesced-notify/batched-reads perf pass, the sync-dot details modal — then: date-page header (weekday/Today flags + week flag, stepping bar removed), left properties side panel (panelled vs compact layout modes), Backlinks/Unlinked mentions bottom tabs (always both, headerless lazy panels), view switcher to the card corner, Created today stamp, Created on day+month+year (cards default), selection-toolbar @ link item, sidebar Today/New(+class picker)/SearchBox removal, top-bar workspace selector + collapsed New/Search — display-layer only, no wire change, no store schema change; TS **v3.4.2** (store v15); **client alignment: none needed** (web-only delta; the clients' pins stay valid); ghcr `notees-sync`/`notees-web` v3.4.2 + latest from the tag |
| review pass + the palette query-wipe fix | 2026-10-06 | Owner screenshot pass: hamburger rail pinned to the body's top-left corner, classes pills at the content column's top (panel pushes them right, toggle stays), the weekday flag pinned to en-US; then the smoke caught the CommandPalette open-reset effect wiping the typed query on every shell re-render (deps included `onOpenNode`'s fresh inline identity) — reset on the open-transition only now, regression test added; verify-min polls for its search hit. Web-only; TS **v3.4.3** (store v15); **client alignment: none needed**; ghcr `notees-sync`/`notees-web` v3.4.3 + latest from the tag |
| the main-layout grid | 2026-10-06 | The panelled layout finalized the card's centered 960px cap drops (`.nt-page-card > .nt-node-view:has(.nt-page--panelled)`) so the 1/3 sidebar \| 2/3 nodeview split spans the full card; the second column becomes a three-row stack — nodeview top bar (hamburger + classes left, view switcher + "…" right) pinned to the top, the nodeview auto-height (the scrolling cell) between, the footer pinned to the bottom as a divided section; `PropertiesSidebar` replaces the reused table (name row + value-cell row per property, `bare` value rows, full right-click menu parity); the app top bar owns New/Search/the workspace selector exclusively and the sidebar starts at Navigation. Web-only; TS **v3.4.4** (store v15); **client alignment: none needed**; ghcr `notees-sync`/`notees-web` v3.4.4 + latest from the tag |
| grid fix | 2026-10-06 | The column now stretches (`align-self: stretch` — the flex row's `align-items: flex-start` had kept it at content height), so the footer pins to the card bottom; the top bar's/footer's dividers start at the column edge (left insets removed — no more crossing the vertical divider or the properties scrollbar). Web-only; TS **v3.4.5** (store v15); **client alignment: none needed**; ghcr `notees-sync`/`notees-web` v3.4.5 + latest from the tag |
| wire node fields | 2026-10-07 | `object.update` gains optional nullable `coverAssetId`/`bannerAssetId`/`aliasedNodeId` (store v15→v16; gate 21→22, `object-wire-fields.json`); the retired cover/banner/aliasOf property schemas superseded (`scripts/migrate-cover-banner-alias.mts` rewrites live assertions); query field predicates; JSON archive carries the fields — **GTK/Flutter ports shipped in the clients' 2026-10-07 lockstep** (GTK v4.1.x / Flutter v4.0.x) |
| class-class retirement + conversion | 2026-10-07 | the seeded `class` meta class (…0001) withdrawn — `class.create` on an existing node DECLARES it a class (the conversion capability; gate 22→23, `class-convert.json`); the has-template family relocates to a global-scope schema (no binding anywhere); `migrate-retire-class-class.mts` converts live workspaces; M12 write-time alias-cycle validation + `Store.resolveAlias` ship applier-side — **GTK/Flutter ports shipped in the clients' 2026-10-07 lockstep** |
| the asset property type | 2026-10-07 | `propertySchema.create`'s type enum gains `asset` (implicit asset-class filter; gate 23→24, `property-asset-type.json`); the attachments schema (…0011) retypes object→asset by `migrate-attachments-asset-type.mts` (values ride untouched) — **GTK/Flutter ports shipped in the clients' 2026-10-07 lockstep** |
| alias read paths (the final alias-program slice) | 2026-10-07 | every alias read repointed onto the `aliased_node_id` column: the universal redirect (the App open funnels ride `resolveAliasOpen` over `Store.resolveAlias` — mentions, links, palette, breadcrumbs, graph clicks, backlink/query rows), the linked-references roll-up via a new recursive store read `Store.aliasNodesOf` (chains included; the property-based `aliasOfTarget` retires), graph exclusion (aliases are not vertices; incident edges repoint to the terminal and merge), the server `/resolve` chain fold, and the aliases UI (the title-row Aliases button/list with the backward write + the NAVIGATE bypass; the alias-side "Aliased node" pseudo-property row) — NO wire change, NO store schema change; store API delta: `aliasNodesOf` added / `aliasOfTarget` retired (clients on the store package ride `resolveAlias`/`aliasNodesOf`); web+server read layer, TS-only |
| unified datetime | 2026-10-09 | the `date`/`date_range` property types unify into one `datetime` type (strict `propertySchema.create` type enum — the retired values are rejected outright; gate 24→25, `property-datetime.json`); values ride untouched (every legacy shape is a legal member of the new union), so the live rewrite is payload-only: `scripts/migrate-unified-datetime.mts` (Path B, no compensation) — TS **v4.1.0** (ghcr `notees-sync`/`notees-web` v4.1.0 + latest from the tag); **client alignment: GTK v4.1.0 + Flutter v4.0.1 + CLI v4.1.0 tagged** (fixtures sha256-matched 25/25; CLI vendor pin → af57c5bb); live migration run the same day (owner workspace 82 envelopes rewritten, epoch 6; test workspace 3, epoch 1; snapshots patched both; full-replay verified) and the stack redeployed — VERIFY-PASS |
| per-block list style | 2026-10-16 | `object.create`/`object.update` gain the optional nullable `listStyle` (`"numbered" \| "alpha" \| "roman"`; absent/null = bullet — store v22→v23, gate 32→33, `object-list-style.json`); the marker number is render-time derivation from the sibling run, never stored; no query predicate (presentation state) — **LOCKSTEP SHIPPED 2026-10-20** with the property-definition batch's ports (GTK v4.2.0 / Flutter v4.1.0; strict-payload additive; no log migration — pre-existing nodes default to bullet) |
| property-definition batch | 2026-10-20 | the retired `scope` enum is rejected outright, replaced by `scopeClassIds` (the sole locality authority — bindings carry zero availability semantics; owner R1–R6); schema-level `icon`; `propertySchema.update` gains `scopeClassIds`/`targetClassFilter`/`multi`/`validationRules`; fail-loud extends-aware eligibility at `property.set`/`class.property.set`; eligible-tagged effective reads; validationRules value enforcement at `property.set`; store v23→v24 (the property_schema rebuild); gate 33→36 (`property-schema-scope.json`, `property-schema-update-fields.json`, `property-validation-rules.json`) — TS **v4.4.0**, GTK **v4.2.0** (store v16, 847 tests, fixtures 36/36), Flutter **v4.1.0** (DB v31, 664 tests, 36/36), CLI by vendor pin; the seed-scope audit (task family + weblink `url` → global) rides the same window; live migration run the same day (owner workspace 5,389 envelopes + test workspace 175, snapshots patched both, restore_epoch 10/4, seed-flip convergence appended; the migration script gained a snapshot-patch ordering fix + resumable apply + a verify comparison fix) and the stack redeployed — VERIFY-PASS |
| the readonly retirement | 2026-10-21 | the `readonly` render contract RETIRES from `propertySchema.create/update` — never user configuration (ZERO seeds ever carried the flag); clients DERIVE readonly-ness from the system property list (`isReadonlyProperty`, packages/domain — `generatedFrom` + `alias`); `hideWhenEmpty`/`display` stay; store v26→v27 (property_schema drops `readonly`; no snapshot patch — nothing to backfill); the class view loses the "No templates bound" empty text + the property pill says "Bind property" (the domain verb); the aliases row hides when empty (the header action is the entry point) — TS reference + GTK/Flutter lockstep ports same day (the binding-sequence convention); live log rewritten by `scripts/migrate-drop-schema-readonly.mts` (Path B) after the ports |
| the binding-sequence retirement | 2026-10-21 | `sequence` RETIRES from `class.property.set` — class properties render as a PURE ALPHABETICAL list everywhere (by property name, read-time derivation); the binding is strictly `{classId, propertySchemaId, active?}`; the class-page panel's drag reorder is removed (display-only list); store v25→v26 (class_property drops `sequence`; no snapshot patch — nothing to backfill); the four sequence-bearing fixtures re-vendor (gate stays 36) — TS reference + GTK/Flutter lockstep ports same day (the required/defaultValue convention); live log rewritten by `scripts/migrate-drop-binding-sequence.mts` (Path B) after the ports; CLI `--sequence` retirement is a pending lockstep follow-up |
| the global-default batch | 2026-10-20 | `required` RETIRES outright (its only render effect — hiding the icon-button's "None" row — was mild enforcement, contradicting the render-contract law) and `defaultValue` MOVES from `class.property.set` to the property schema — ONE global default per property, the Logseq shape; the class-page inline editor is gone with it (the class page lists its properties; the default editor lives in the base-definition modal; a binding is sequence/active only). `class.property.set` is strictly `{classId, propertySchemaId, sequence?, active?}`; `propertySchema.create/update` gain `defaultValue` (PC2-typed at apply — create against the payload's type, update against the stored type; keep/clear, the cleared spelling SQL NULL); the effective read derives the schema default when a winning ACTIVE binding brings the property into the node's context (no more per-class default conflicts); store v24→v25 (class_property drops `required`/`default_value`, property_schema gains `default_value`); the three default-bearing fixtures re-encode the global semantics (gate stays 36) — TS reference + GTK/Flutter lockstep ports same day; live log rewritten by `scripts/migrate-drop-binding-required.mts` (Path B) after the ports |

## 5. The SDK/repo splits (parked, owner)

- **SDK publish — ARCHIVED (owner, 2026-10-03).** npmjs token not pursued;
  publish infra stays (`pnpm release`, `sdk-publishing.md` in this folder), packages stay
  versioned; npm distribution off the table until re-opened.
- **Repo split (notees-sync / notees-web) — parked** (two services from one
  monorepo); registered as wanted with execution deferred to a quiet tree
  (gate/CI redesign, deploy-path redesign, quiet tree, same-pass docs). The
  CLI split out on 2026-10-05 regardless (`notees-cli`, vendored packages via
  a pinned `vendor/notees` submodule). `notees-sync` stays in the monorepo.
