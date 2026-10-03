# AGENTS.md

Notees — a self-hosted, privacy-first, local-first **personal information environment**: one object graph (nodes carry `is_class` + `present_as_main`; "page" and "block" are render states, not node kinds; typed properties, typed link marks, assets) whose only authority is an immutable **operation log** (envelope **v3**); every SQLite database (server, browser worker, CLI) is a derived projection of that log. TypeScript everywhere (Node 22, pnpm 9).

This repo is the v2 rewrite promoted to root (2026-09-28). The v1 Python+React codebase is removed; it remains reachable at git tag **`v1-archive`** (runtime data archived outside the repo at `/etc/periphery/stacks/notees-v1-data-archive/`).

## Layout

- `packages/protocol` — op wire spec, envelopes, fixtures (the convergence gate corpus), `SCHEMA.md` (normative model + owed-work register)
- `packages/domain` — seeds (fixed system-class UUIDs), display-name derivation (title-is-content: content excerpt for every node type, date labels formatted), content stringify (text-only invariant for pages/classes)
- `packages/store` — derived SQLite schema + appliers; one TS implementation, three backends (better-sqlite3, sql.js)
- `packages/sync` — SyncEngine (HLC + server seq, snapshots, compaction, WebSocket)
- `packages/query` — QueryAST model + SQLite compiler
- `packages/export` — export projections over the object graph: `ExportDocument` IR + five formats — markdown/html/docx/latex serialize package-side (typed options bag with per-format gating, metacharacter escaping, full-closure outline, whiteboard sidecar mode, `<title-slug>-<id8>.md` filename policy where id8 = FNV-1a of the node id, `linkTarget`/`assetPath` context hooks for relative-link zips, LaTeX CSL bibliography); **pdf renders client-side in the web app** (`apps/web/src/ui/export-pdf/`, code-split, local OFL Gentium) behind the registry `delivery: "client-pdf"` seam; bundles + manifest v2, BibTeX/CSL round-trips
- `apps/server` — sync relay + object API + CAS assets (`notees-sync` image)
- `apps/web` — React/Vite outliner editor + worker (`notees-web` image)
- `apps/cli` — object/property/search surface over the public API
- `docs/` — **user-facing only** (usage, philosophy, ux)
- `.plans/` — internal: **the ongoing implementation plan** (`implementation-plan.md` — decision record §34 + the work registers), design stack (`design/`), dev docs (`dev/`: architecture, development, deployment, sdk-publishing)
- `.audits/` — internal audit reports
- Internal notes never go in `docs/`; user docs never go in dot-folders.

## Commands

- Install: `pnpm install` · Build: `pnpm -r --workspace-concurrency=1 build` · Test: `pnpm test` (all green = blocking gate)
- After changing a package's public API, rebuild its dist before typechecking dependents (dev-condition exports: vitest reads `src`, `tsc` reads `dist`).
- Deploy: **plain Docker — Komodo is NOT required.** The stack is the repo-root `compose.yaml` (web :8378, sync :8377; data under `./config/notees/`): `docker build -f apps/server/Dockerfile -t ghcr.io/miquelrosell99/notees-sync:latest . && docker build -f apps/web/Dockerfile -t ghcr.io/miquelrosell99/notees-web:latest . && docker compose up -d` (build context = repo root; compose defaults to `:latest` with `NOTEES_SYNC_TAG`/`NOTEES_WEB_TAG` overrides for pinning, and has no `build:` section by design — the host can equally `docker pull` the pinned ghcr tags, since `.github/workflows/release-docker.yml` publishes them on every `v*` tag push). Komodo (stack `notees` on the fleet host) is only an optional convenience on top of the same compose file — every operation it performs (`up -d` on this repo) is reproducible with the plain docker commands above. Smoke: `node scripts/screenshots/verify-min.mjs` (run from `scripts/screenshots/`; needs `NOTEES_ADMIN_PASSWORD`, stored on this host at `config/notees/.admin_password` — e.g. `export NOTEES_ADMIN_PASSWORD=$(cat config/notees/.admin_password)`).

## Invariants (design law — see `.plans/` decision record §34)

- The operation log is the only authority; semantic state only — device state is never an op.
- Conflict semantics: LWW by HLC (scalars, property values, class order); OR-Set add-wins (class membership, `>=` actor tiebreak); tag membership mirrors the OR-Set with a strictly-greater add tiebreak (first-in-log-wins on exact ties — deliberate asymmetry, convergent via the single global log); CRDT only for collaborative text/tree. No CRDT-everywhere.
- **Title-is-content** (owner decision 2026-10-01): a node's title IS its own text content — there is no `name` field on the wire (`object.*`/`class.*` payloads carry `contentAst`; strict schemas reject `name`). Pages and classes carry text-only content (inline rich tokens flatten; `whiteboard`/`query` widgets survive); block→page/class promotion stringifies in the same op. Client builders may keep a `name` convenience that becomes a single text token; the protocol stays name-free.
- **Render-state model** (Revision 11, owner 2026-10-02): nodes have no page/block kind — only `is_class` (identity marker; classes are always roots and may have non-class children) and `present_as_main` (render bit, read only by the third cascade branch: `is_class` → Class view; parentless → document chrome; else the bit → the parent's main-children/Pages zone + document chrome, or inline body + block chrome). Moves never write the bit; every parent type partitions its children by the one bit. Wire is envelope **v3**; retired keys (e.g. `nodeType`) are rejected outright — **no backward compatibility** (owner directive, sole user): data migration is a one-time in-place rewrite of the stored log (`scripts/migrate-node-type.mts`), after which every store re-syncs from the migrated log.
- New op types are additive and require protocol fixtures exercising every client applier (TS is the reference; GTK/Flutter lockstep) before implementation counts as complete.
- Identity is UUIDv7 everywhere; titles/paths/citekeys are attributes, never identity.
- Sync server (PostgreSQL relay) is coordination, not the object database.
- **Docs are part of the change** (owner rule): any app change that alters behavior, the model, the wire, or the UX must update the relevant documentation in the same pass — user-facing `docs/` (usage, ux, philosophy), the normative `packages/protocol/SCHEMA.md`, `AGENTS.md` when it describes the changed reality, and the internal `.plans/` dev docs (architecture, development). A change without its doc updates is not done.
- **The plan is the record** (owner rule 2026-10-03): `.plans/implementation-plan.md` is the ongoing work record and must stay current in the same pass — check it (and the rest of `.plans/`) for existing designs before implementing (follow them, or improve them in place), then record the work: a new §34 work-record entry per slice (what shipped, verification, register cross-checks), owed-work rows ticked, and any deviation registered where future readers will look. A change without its plan update is not done.

## UI primitives (always)

- All chrome MUST compose from `apps/web/src/ui/components/ui/` — one reusable element per file with co-located CSS, exported through the `index.ts` barrel (Button, Pill/AddPill, TextField, SearchField, Dropdown, Modal, ContextMenu, Badge, Checkbox, ToggleSwitch, BooleanToggle, Slider, Tabs, Card, Spinner, LoadingScreen/LoadingSkeleton, ColorButton, SelectionButton, ButtonWithPanel, InlineConfirmButton, ListSortable, FileDropZone, DataStateView, CodeTextarea, FloatingButtonArray, EmptyState, NotificationToast, SelectTrigger, Separator, ErrorBoundary, ImageModal, ConfirmationModal, BackendUnavailableOverlay, MonthCalendar — the month-grid panel over the shared `ui/calendar/` day grid; the top-bar `CalendarPopup` consumes the same grid, so calendar day cells stay one implementation).
- No new ad-hoc styled buttons, inputs, pills, or toggles in feature code — extend the library (new primitive file + barrel export) instead.
- The library's CSS is token-only: every value resolves to a custom property from `apps/web/src/ui/variables.css` — no hex literals, no hard-coded colors.
- Never mention legacy version names in files, comments, or class names; provenance lives in git history.

## Parked decisions (owner)

- **SDK publish — ARCHIVED (owner, 2026-10-03)** — the npmjs token is not being pursued for now. Publish infra stays in the tree (`pnpm release`, `.plans/dev/sdk-publishing.md`) and the packages stay versioned, but npm distribution (and the repo split that sat behind it) is off the table until the owner re-opens it.
- **ghcr image publish — via CI (`.github/workflows/release-docker.yml`)** — pushing a `v*` tag publishes that tag (v-prefixed + semver patterns) + `latest` to ghcr using the workflow's `GITHUB_TOKEN` (`packages: write`); the host's docker login stays read-only (host-local builds + `docker compose up -d` remain the deploy path). To (re)publish an existing release's images without a new tag: `gh workflow run release-docker.yml -f image_tag=2.0.0-mN`. **GitHub Releases are not used** — this repo ships docker images only (all historical releases removed 2026-10-03, owner directive); git tags remain the release mechanism.
- **Client lockstep — CURRENT (pushed)**: `notees-gtk` at **`v2.0.0-m4`** and `notees-flutter` at **`v2.0.0-m14`** (client releases since m11 carry the same wire) both carry the full Revision 11 protocol (envelope v3, `is_class` + `present_as_main`, classes-as-containers, strict rejection of retired keys) **plus the `object.restore` op** (2026-10-03 lockstep; GTK wheel/sdist/archpkg and Flutter signed APK CI releases published). **Do not run any pre-m3 GTK client or pre-m11 Flutter build against the v3 server — envelope v3 is rejected loud.** Any new op requires the same three-way lockstep before it counts as done.
- Repo split (notees-sync / notees-web) — parked indefinitely alongside the archived SDK publish; two services from one monorepo for now.
