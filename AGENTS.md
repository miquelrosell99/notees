# AGENTS.md

Notees — a self-hosted, privacy-first, local-first **personal information environment**: one object graph (nodes carry `is_class` + `present_as_main`; "page" and "block" are render states, not node kinds; typed properties, typed link marks, assets) whose only authority is an immutable **operation log** (envelope **v3**); every SQLite database (server, browser worker, CLI) is a derived projection of that log. TypeScript everywhere (Node 22, pnpm 9).

This repo is the v2 rewrite promoted to root (2026-09-28). The v1 Python+React codebase is removed; it remains reachable at git tag **`v1-archive`** (runtime data archived outside the repo at `/etc/periphery/stacks/notees-v1-data-archive/`).

## Layout

- `packages/protocol` — op wire spec, envelopes, fixtures (the convergence gate corpus), `SCHEMA.md` (normative model + owed-work register)
- `packages/domain` — seeds (fixed system-class UUIDs), display-name derivation (title-is-content: content excerpt for every node type, date labels formatted), content stringify (text-only invariant for pages/classes)
- `packages/store` — derived SQLite schema + appliers; one TS implementation, three backends (better-sqlite3, sql.js)
- `packages/sync` — SyncEngine (HLC + server seq, snapshots, compaction, WebSocket)
- `packages/query` — QueryAST model + SQLite compiler
- `packages/export` — Markdown/BibTeX round-trips
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
- Deploy: **plain Docker — Komodo is NOT required.** The stack is the repo-root `compose.yaml` (web :8378, sync :8377; data under `./config/notees/`): `docker build -f apps/server/Dockerfile -t ghcr.io/miquelrosell99/notees-sync:latest . && docker build -f apps/web/Dockerfile -t ghcr.io/miquelrosell99/notees-web:latest . && docker compose up -d` (build context = repo root; ghcr tags are unpublished — see parked decisions — so build the `latest` tags locally first; compose defaults to `:latest` with `NOTEES_SYNC_TAG`/`NOTEES_WEB_TAG` overrides for pinning, and has no `build:` section by design). Komodo (stack `notees` on the fleet host) is only an optional convenience on top of the same compose file — every operation it performs (`up -d` on this repo) is reproducible with the plain docker commands above. Smoke: `node scripts/screenshots/verify-min.mjs` (run from `scripts/screenshots/`; needs `NOTEES_ADMIN_PASSWORD`).

## Invariants (design law — see `.plans/` decision record §34)

- The operation log is the only authority; semantic state only — device state is never an op.
- Conflict semantics: LWW by HLC (scalars, property values, class order); OR-Set add-wins (class membership, `>=` actor tiebreak); tag membership mirrors the OR-Set with a strictly-greater add tiebreak (first-in-log-wins on exact ties — deliberate asymmetry, convergent via the single global log); CRDT only for collaborative text/tree. No CRDT-everywhere.
- **Title-is-content** (owner decision 2026-10-01): a node's title IS its own text content — there is no `name` field on the wire (`object.*`/`class.*` payloads carry `contentAst`; strict schemas reject `name`). Pages and classes carry text-only content (inline rich tokens flatten; `whiteboard`/`query` widgets survive); block→page/class promotion stringifies in the same op. Client builders may keep a `name` convenience that becomes a single text token; the protocol stays name-free.
- **Render-state model** (Revision 11, owner 2026-10-02): nodes have no page/block kind — only `is_class` (identity marker; classes are always roots and may have non-class children) and `present_as_main` (render bit, read only by the third cascade branch: `is_class` → Class view; parentless → document chrome; else the bit → the parent's main-children/Pages zone + document chrome, or inline body + block chrome). Moves never write the bit; every parent type partitions its children by the one bit. Wire is envelope **v3**; retired keys (e.g. `nodeType`) are rejected outright — **no backward compatibility** (owner directive, sole user): data migration is a one-time in-place rewrite of the stored log (`scripts/migrate-node-type.mts`), after which every store re-syncs from the migrated log.
- New op types are additive and require protocol fixtures exercising every client applier (TS is the reference; GTK/Flutter lockstep) before implementation counts as complete.
- Identity is UUIDv7 everywhere; titles/paths/citekeys are attributes, never identity.
- Sync server (PostgreSQL relay) is coordination, not the object database.
- **Docs are part of the change** (owner rule): any app change that alters behavior, the model, the wire, or the UX must update the relevant documentation in the same pass — user-facing `docs/` (usage, ux, philosophy), the normative `packages/protocol/SCHEMA.md`, `AGENTS.md` when it describes the changed reality, and the internal `.plans/` dev docs (architecture, development). A change without its doc updates is not done.

## UI primitives (always)

- All chrome MUST compose from `apps/web/src/ui/components/ui/` — one reusable element per file with co-located CSS, exported through the `index.ts` barrel (Button, Pill/AddPill, TextField, SearchField, Dropdown, Modal, ContextMenu, Badge, Checkbox, ToggleSwitch, BooleanToggle, Slider, Tabs, Card, Spinner, LoadingScreen/LoadingSkeleton, ColorButton, SelectionButton, ButtonWithPanel, InlineConfirmButton, ListSortable, FileDropZone, DataStateView, CodeTextarea, FloatingButtonArray, EmptyState, NotificationToast, SelectTrigger, Separator, ErrorBoundary, ImageModal, ConfirmationModal, BackendUnavailableOverlay).
- No new ad-hoc styled buttons, inputs, pills, or toggles in feature code — extend the library (new primitive file + barrel export) instead.
- The library's CSS is token-only: every value resolves to a custom property from `apps/web/src/ui/variables.css` — no hex literals, no hard-coded colors.
- Never mention legacy version names in files, comments, or class names; provenance lives in git history.

## Parked decisions (owner)

- **SDK publish — BLOCKED on an npmjs token** (GitHub Packages rejects the `@notees/*` scope). Publish infra is ready: `pnpm release`, flow in `.plans/dev/sdk-publishing.md`.
- **ghcr image publish — BLOCKED on a registry write token** (the host's ghcr login is read-only: push → `permission_denied: token scopes`). Compose defaults to `:latest` (built locally, tagged `latest`); images exist on the host only.
- **Client lockstep — CURRENT**: `notees-gtk` at **`v2.0.0-m3`** carries the full Revision 11 protocol (envelope v3, `is_class` + `present_as_main`, classes-as-containers, strict rejection of retired keys; wheel/sdist/Arch package CI release published). `notees-flutter` Revision-11 lockstep targets **`v2.0.0-m9`** and is in progress (its earlier tags m3–m8 are unrelated app fixes and all still speak the pre-Revision-11 protocol). **Do not run any pre-m3 GTK client or any current Flutter build against the v3 server — envelope v3 is rejected loud.** Any new op requires the same three-way lockstep before it counts as done.
- Repo split (notees-sync / notees-web) — parked until the SDK is published; two services from one monorepo for now.
