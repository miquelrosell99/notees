# Notees — Releases & Client Lockstep (developer runbook)

Release mechanics and the three-client wire contract. Companion docs: `migrations.md` (live data changes) and
`deployment.md` (the full deployment reference) — all in this folder.

## 1. The main repo ships docker images only

- **GitHub Releases are not used** (owner directive 2026-10-03; all historical
  releases removed). Git tags are the release mechanism.
- **ghcr publish is CI-driven** (`.github/workflows/release-docker.yml`):
  pushing a `v*` tag publishes `notees-sync` + `notees-web` at that tag
  (semver patterns: `vX.Y.Z`, `X.Y`) + `latest`, using the workflow's
  `GITHUB_TOKEN`. The host's docker login stays **read-only** — host-local
  builds + `docker compose up -d` remain the deploy path (deployment.md).
- Re-publish an existing release's images without a new tag:
  `gh workflow run release-docker.yml -f image_tag=X.Y.Z`.
- **Versioning (owner directive 2026-10-04): X.Y.Z forever** — the `2.0.0-mN`
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

**Current wire (owner review 2026-10-05, wire node fields added 2026-10-07):** envelope v3; Revision-11
render state; `object.restore`; the color grammar; the
workspace-feature batch (`workspace.feature.set`, `code_block`/`hr`, `embed_ref.view`, PG5
element ids, PC4 `active`, PC6 qualifiers); number formats; the
property batch — **option `icon` (strip-safe additive JSON), and the render
contracts `display`/`readonly`/`hideWhenEmpty` on the PROPERTY SCHEMA
(`propertySchema.create/update`), with `required` staying on the class binding
(owner ruling: per-class requirement is real)**; the wire node fields —
`object.update` gains optional nullable `coverAssetId`/`bannerAssetId`/`aliasedNodeId`
(store v16; fixture `object-wire-fields.json`), superseding the retired
cover/banner/aliasOf property schemas (live assertions migrate via
`scripts/migrate-cover-banner-alias.mts`). **GTK/Flutter ports of the wire
fields are a separate follow-up in the clients repo — pending at shipment, so
the live migration run waits for them.** TS reference: main repo
**v3.4.4** (store v16); GTK **v3.1.2** (store v12); Flutter **v3.1.2**
(app DB v26). The GTK UI has no property rendering (protocol+store port
only); Flutter renders the block-bullet value button.

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
(gate 21→24). **GTK/Flutter ports of all three are a separate follow-up in
the clients repo — pending at shipment.** Also shipped applier-side with no
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
| the main-layout grid | 2026-10-06 | The panelled layout finalized per owner review: the card's centered 960px cap drops (`.nt-page-card > .nt-node-view:has(.nt-page--panelled)`) so the 1/3 sidebar \| 2/3 nodeview split spans the full card; the second column becomes a three-row stack — nodeview top bar (hamburger + classes left, view switcher + "…" right) pinned to the top, the nodeview auto-height (the scrolling cell) between, the footer pinned to the bottom as a divided section; `PropertiesSidebar` replaces the reused table (name row + value-cell row per property, `bare` value rows, full right-click menu parity); the app top bar owns New/Search/the workspace selector exclusively and the sidebar starts at Navigation. Web-only; TS **v3.4.4** (store v15); **client alignment: none needed**; ghcr `notees-sync`/`notees-web` v3.4.4 + latest from the tag |
| grid fix | 2026-10-06 | The column now stretches (`align-self: stretch` — the flex row's `align-items: flex-start` had kept it at content height), so the footer pins to the card bottom; the top bar's/footer's dividers start at the column edge (left insets removed — no more crossing the vertical divider or the properties scrollbar). Web-only; TS **v3.4.5** (store v15); **client alignment: none needed**; ghcr `notees-sync`/`notees-web` v3.4.5 + latest from the tag |
| wire node fields | 2026-10-07 | `object.update` gains optional nullable `coverAssetId`/`bannerAssetId`/`aliasedNodeId` (store v15→v16; gate 21→22, `object-wire-fields.json`); the retired cover/banner/aliasOf property schemas superseded (`scripts/migrate-cover-banner-alias.mts` rewrites live assertions); query field predicates; JSON archive carries the fields — **GTK/Flutter ports pending in the clients repo** (strict-payload additive: the live migration run gates on them) |
| class-class retirement + conversion | 2026-10-07 | the seeded `class` meta class (…0001) withdrawn — `class.create` on an existing node DECLARES it a class (the conversion capability; gate 22→23, `class-convert.json`); the has-template family relocates to a global-scope schema (no binding anywhere); `migrate-retire-class-class.mts` converts live workspaces; M12 write-time alias-cycle validation + `Store.resolveAlias` ship applier-side — **GTK/Flutter ports pending** (class identity is the lockstep gate) |
| the asset property type | 2026-10-07 | `propertySchema.create`'s type enum gains `asset` (implicit asset-class filter; gate 23→24, `property-asset-type.json`); the attachments schema (…0011) retypes object→asset by `migrate-attachments-asset-type.mts` (values ride untouched) — **GTK/Flutter ports pending** (strict-enum additive) |
| alias read paths (the final alias-program slice) | 2026-10-07 | every alias read repointed onto the `aliased_node_id` column: the universal redirect (the App open funnels ride `resolveAliasOpen` over `Store.resolveAlias` — mentions, links, palette, breadcrumbs, graph clicks, backlink/query rows), the linked-references roll-up via a new recursive store read `Store.aliasNodesOf` (chains included; the property-based `aliasOfTarget` retires), graph exclusion (aliases are not vertices; incident edges repoint to the terminal and merge), the server `/resolve` chain fold, and the aliases UI (the title-row Aliases button/list with the backward write + the NAVIGATE bypass; the alias-side "Aliased node" pseudo-property row) — NO wire change, NO store schema change; store API delta: `aliasNodesOf` added / `aliasOfTarget` retired (clients on the store package ride `resolveAlias`/`aliasNodesOf`); web+server read layer, TS-only |

## 5. The SDK/repo splits (parked, owner)

- **SDK publish — ARCHIVED (owner, 2026-10-03).** npmjs token not pursued;
  publish infra stays (`pnpm release`, `sdk-publishing.md` in this folder), packages stay
  versioned; npm distribution off the table until re-opened.
- **Repo split (notees-sync / notees-web) — parked** (two services from one
  monorepo); registered as wanted with execution deferred to a quiet tree
  (gate/CI redesign, deploy-path redesign, quiet tree, same-pass docs). The
  CLI split out on 2026-10-05 regardless (`notees-cli`, vendored packages via
  a pinned `vendor/notees` submodule). `notees-sync` stays in the monorepo.
