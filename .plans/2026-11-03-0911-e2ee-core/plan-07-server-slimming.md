# E2EE core — Plan 07: server slimming (content API retirement + prefs wrapping + client-side workflows)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Reduce the server to the spec §3 shape: relay (metadata only), auth, opaque assets, shares, coordination state, health/ops. Retire the content API (object CRUD, search/query, backlinks, effective-properties, merge, server export.zip, location), wrap per-user prefs as a master-key-encrypted blob, and move workflow-rule evaluation client-side (web). After this plan, the server store holds no readable content for keyed workspaces and serves no content reads at all.

**Architecture:** The web client already reads everything locally (QueryAST compiles to local SQLite — verified in plan 01's survey). The retirement is: (1) audit the web client for any remaining server-read call sites and move them local, (2) delete the server routes + their derived-store content dependencies (the server-side derived store keeps applying envelopes for snapshot/compaction bookkeeping but serves nothing), (3) prefs: the existing GET/PUT /api/me/prefs routes carry an opaque blob the web client encrypts with its master key (the columns collapse into one blob column), (4) workflows: server-side post-ingest QueryAST probes retire; the web client evaluates rules against its local derived store on each applied envelope batch (the rule definitions + run audit ride the existing coordination sync or a wrapped blob).

**Spec:** `.plans/2026-11-03-0911-e2ee-core/design.md` §3.

## Global Constraints

- The web client must lose ZERO capability: audit-first, every retired server read has a local replacement shipping in the same commit that retires the route.
- The relay (ingest/ordering/compaction/snapshots), auth, workspace-key routes, assets, shares, and health stay untouched.
- Sibling clients (GTK/Flutter/CLI): check whether they call any retired route (grep their api clients); if they do, the retirement either waits or the client gains a local read — record the finding and rule. (Known: GTK/Flutter have their own local stores and sync via relay; the CLI is the risk — check it.)
- OpenAPI inventory stays accurate (routes removed = inventory updated; its test must pass).
- Gates: `pnpm test` (main), and the sibling repos' gates only if their code changes.
- House laws: changelog, docs (api.md route removals, architecture.md §3 status), per-file staging.

## Review Focus

1. No retired route is still called by the web client (the audit's evidence: grep of apps/web for each route path, zero hits at retirement time).
2. The prefs blob: unreadable server-side (the server stores one opaque string), readable by the client after unlock, keyless sessions get/put an UNWRAPPED blob only when no master key exists (self-host without E2EE keeps working) — the wrapping layer is transparent.
3. Workflows: rule evaluation results identical to the server-side probes for the same envelope batches (pin a parity test with fixtures), and rules still run when the client is keyless/locked.
4. The server derived store still applies envelopes (snapshot bookkeeping) but no route reads content from it.

---

### Task 1: web-read audit
Grep apps/web for every retired surface (`/objects`, `/search`, `/query`, `backlinks`, `effective-properties`, `merge`, `export.zip`, `nodes/.*location`). Each hit moves to a local read in the same pass. Deliverable: the audit list + the moves, committed as `refactor(web): move remaining server reads local (pre-slmming audit)`.

### Task 2: retire the content API
Delete the routes + handlers (objects/search/query/backlinks/effective-properties/merge/export.zip/location), their workspace-store content-serving methods, and the OpenAPI entries. The appliers/derived-store stay (snapshot bookkeeping). Tests: route tests removed/rewritten; the OpenAPI inventory test green; `pnpm test` green. Commit `feat(server): retire the content API (relay + coordination only)`.

### Task 3: prefs wrapping
Server: `user_prefs` collapses to one opaque `blob` column (additive migration preserving existing rows as unwrapped blobs with a `wrapped: 0` marker column, or a version prefix — pick one, document). Web: the prefs layer wraps/unwraps transparently with the master key when one exists. Tests: wrapped round-trip (server sees opaque), unwrapped compat (keyless self-host), upgrade of a legacy row. Commit `feat(server,web): master-key-wrapped prefs blob`.

### Task 4: client-side workflow evaluation
Map the current workflow surface first (server: workflow rules + run audit tables/routes; web: any workflow UI). Server: retire post-ingest probe evaluation (keep rule storage + run audit as coordination data). Web: a client-side evaluator — on each applied envelope batch (local engine hook), evaluate the workspace's rules against the local derived store; write run-audit entries locally and sync them as coordination data (the existing mechanism rules use today, moved client-side). Parity test: for a fixture batch, client evaluation matches the retired server probe semantics. Commit `feat(web): client-side workflow evaluation (server probes retired)`.

### Task 5: sibling + CLI check, docs, changelog
Grep GTK/Flutter/CLI api clients for retired routes; record findings (fix or debt per the constraint). docs/api.md (route removals), architecture.md (§3 shipped status: content API retired, prefs wrapped, workflows client-side; the server is now relay+coordination), CHANGELOG.

## Self-review record
- Workflows are the largest surface; if the parity port proves bigger than the plan allows, the fallback ruling is: retire server probes + ship the client evaluator for the web's existing rule shapes only, recording unported shapes as debt.
- Shares (spec §4) are plan 08, not here.
