# AGENTS.md

Notees — a self-hosted, privacy-first, local-first **personal information environment**: one object graph (nodes carry `is_class` + `present_as_main`; "page" and "block" are render states, not node kinds; typed properties, typed link marks, assets) whose only authority is an immutable **operation log** (envelope **v3**); every SQLite database (server, browser worker, CLI) is a derived projection of that log. TypeScript everywhere (Node 22, pnpm 9).

This repo is the v2 rewrite promoted to root (2026-09-28). The v1 Python+React codebase is removed; it remains reachable at git tag **`v1-archive`** (runtime data archived outside the repo at `/etc/periphery/stacks/notees-v1-data-archive/`).

## Layout

- `packages/protocol` — op wire spec, envelopes, fixtures (the convergence gate corpus), `SCHEMA.md` (the normative model)
- `packages/domain` — seeds (fixed system-class UUIDs), display-name derivation, content stringify (text-only invariant for pages/classes)
- `packages/store` — derived SQLite schema + appliers; one TS implementation, three backends (better-sqlite3, sql.js)
- `packages/sync` — SyncEngine (HLC + server seq, snapshots, compaction, WebSocket)
- `packages/query` — QueryAST model + SQLite compiler
- `packages/export` — export projections over the object graph: IR + serializers (markdown/html/docx/latex package-side, pdf client-side in the web app, csv + json-archive view-shaped); detail in `docs/developers/architecture.md` §10
- `apps/server` — sync relay + object API + CAS assets + coordination state (per-user prefs, plugin-manifest registry, workflow rules + run audit) + read-only public page shares (`notees-sync` image)
- `apps/web` — React/Vite outliner editor + worker (`notees-web` image); carries the session-local op-inverse **undo journal** (§34.64, `src/core/undo-journal.ts` — client convenience only, inverses compose existing ops, per-tab)
- `apps/cli` — MOVED 2026-10-05: lives in its own repo (`notees-cli`, sibling to the GTK/Flutter clients, consuming the packages via a pinned `vendor/notees` submodule — §34.82)
- `docs/` — **person-facing only**: `usage.md`, `ux.md`, `philosophy.md` + the `developers/` runbooks (indexed by `docs/developers/README.md`). **Internal notes never go in `docs/`; user docs never go in dot-folders.**
- `.plans/` — the implementation plan + decision record §34 (the ongoing work record) + `design/` (historical entries saying `.plans/dev/…` read `docs/developers/…` since the 2026-10-05 move) · `.audits/` — internal audit reports · `.agents/` — internal agent reference docs (parked decisions, …)

Full file map: `docs/developers/architecture.md` §10 · normative model & wire: `packages/protocol/SCHEMA.md` (and `WIRE.md`) · design docs: `.plans/design/`.

## Commands

- Install: `pnpm install` · Build: `pnpm -r --workspace-concurrency=1 build` · Test: `pnpm test` (all green = blocking gate). Full command table, the fixture gate, and the add-an-op recipe: `docs/developers/development.md`.
- **Dev-condition exports**: vitest reads `src`, `tsc` reads `dist` — after changing a package's public API, rebuild its dist before typechecking dependents.
- Deploy: plain Docker, build + `docker compose up -d` from the repo root (web :8378, sync :8377; data under `./config/notees/`), then the `verify-min.mjs` smoke. Full runbook, ghcr/CI publish path, and the client lockstep law: `docs/developers/releases.md` + `deployment.md`.

## Invariants (design law — read the linked homes before changing the model, wire, or appliers)

- The operation log is the only authority; semantic state only — device state is never an op (`architecture.md` §2).
- Conflict semantics: **LWW by HLC** (scalars, property values) · **OR-Set add-wins** (class/collection membership) · tag membership mirrors the OR-Set with a strictly-greater add tiebreak (deliberate asymmetry — `development.md` §5 cheat sheet).
- **Title-is-content** (owner 2026-10-01): no `name` field on the wire — a node's title IS its text content; pages/classes carry text-only content (`SCHEMA.md`).
- **Render-state model** (Revision 11, owner 2026-10-02): nodes have no page/block kind — only `is_class` + `present_as_main`. Wire is envelope **v3**; retired keys are rejected outright — **no backward compatibility** (owner directive, sole user): migration is a one-time in-place rewrite of the stored log, after which every store re-syncs (`SCHEMA.md` "Node structure"; `migrations.md`).
- New op types are additive and require protocol fixtures exercising every client applier (TS reference; GTK/Flutter lockstep) before implementation counts as complete (`development.md` §§3–4).
- Identity is UUIDv7 everywhere; titles/paths/citekeys are attributes, never identity.
- Sync server (PostgreSQL relay) is coordination, not the object database.

## UI primitives

All chrome MUST compose from `apps/web/src/ui/components/ui/` — one element per file, co-located CSS, barrel-exported, token-only CSS (`variables.css`). No ad-hoc styled controls in feature code. **Catalog, the popup-dismissal seam, and the drift classes: `docs/developers/ui-primitives.md`.**

## Working rules (owner)

- **Docs are part of the change**: any change to behavior, the model, the wire, or the UX updates the relevant documentation in the same pass — user-facing `docs/`, `packages/protocol/SCHEMA.md`, `AGENTS.md` / `.agents/` when they describe changed reality, and the `docs/developers/` runbooks.
- **The plan is the record** (owner 2026-10-03): check `.plans/implementation-plan.md` (and `.plans/` generally) for existing designs before implementing — follow them or improve them in place — then record the slice in the same pass: a new §34 work-record entry (what shipped, verification, register cross-checks), owed-work rows ticked, deviations registered where future readers will look. A change without its plan/doc updates is not done.

## Parked decisions (owner)

See **`.agents/parked-decisions.md`** — SDK publish archived (2026-10-03) · releases/lockstep runbook pointer · repo-split state (CLI out §34.82; web split wanted, deferred §34.83; `notees-sync` stays).
