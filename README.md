# Notees v2

**One object graph. The operation log is the only authority. Every interface — UI, CLI, API, export — is a projection of the same derived state.**

Notees is a local-first personal knowledge environment: a single node table for pages, blocks, and classes; three information layers (attributes, discourse links, plain prose) feeding one edge index; and an append-only op log that syncs between your devices and converges without a server you have to trust.

It is also a greenfield rewrite at **M1 alpha**. The model below is settled; the surface is young. See [Status](#status-m1-alpha) before planning your workflow around it.

## The five bets

Five design decisions no competitor makes, which together define what Notees is ([why we made them](docs/philosophy.md)):

| # | Bet | What it means |
|---|---|---|
| 1 | **Op log as sole authority** | Event-sourced storage: append-only, idempotent, local-first, total offline, with an E2EE slot in the protocol. SQLite is a rebuildable projection, never the truth. |
| 2 | **Unified node table — classes are nodes** | Pages, blocks, and classes are rows of one table with one identity scheme. Inheritance (`extends`) is an m2m property on class nodes; the hierarchy closure is derived, not stored. |
| 3 | **Typed discourse links as marks on prose words** | "X *contradicts* Y" is a mark on the word you wrote — a verb in your sentence, not a field in a form. Verbs group backlinks and color the graph. |
| 4 | **Two-way link propagation along the tree** | Backlinks roll up to containing pages, and links inherit down the tree: `refset(n) = own_links(n) ∪ refset(parent(n))`. Containment is context; nobody tags anything. |
| 5 | **Agent-first surface** | Scoped API keys (server-enforced read/write scopes today; in-app checkboxes §34.19), one grammar for humans and machines, and a full CLI from M1. Agents are peers of the UI, not plugins bolted on later. |

## Status: M1 alpha

The model is implemented; the product around it is a slice. We say exactly which is which in every document — [philosophy](docs/philosophy.md) for the ideas, [usage](docs/usage.md) for what you can run now, [ux](docs/ux.md) for the interaction model (each feature labeled Today or Designed).

**Works today**

- Object model — pages, blocks, classes over one node table, with `is_class`/`present_as_main` (identity + render-state bits), tree placement, class membership, and content tokens (the full SCHEMA.md grammar)
- Local-first sync engine — outbox push, seq-cursor catch-up, snapshot shortcut, optimistic local apply
- Fastify server — relay (batch/catch-up/snapshot/compact/stats + WebSocket), object API, CAS asset storage
- CLI — object CRUD, trash restore (`object restore`, `list --trashed`), one-gesture covers (`cover set|get|clear`), typed property set/delete, children listing, bulk create (`--batch`) and find-or-create (`upsert`), search, backlinks, class list/assign/bulk ops (remap, empty, delete-members), markdown/bibtex export (incl. `--class` selector), asset add/get, sync status, doctor (incl. the cli/server version-drift warning)
- Web client — interactive outliner (text core, marks editing, `@`/`#`/`+` capture gestures, collapse, prose mode, drag reorder), Page View + Class View (editable property bindings), system sections with the lazy-loading contract, live embed transclusion, whiteboard canvas, WebSocket realtime with sync status, OPFS persistence in a worker
- Live query blocks (query tokens render results with a builder + export-on-query), citations (BibTeX/CSL round-trip; sources carry files via `attachments` and notes as child blocks), class-property defaults as a derived read model (first-applied-wins), Markdown export (CLI: `--ids` / `--linked-to` closures)

**Designed, coming**

- M2 — research environment: interactive outliner editor, typed-link capture UX, whiteboards UI, citations/bibliography, annotations on assets, Markdown export, typed-link target resolution
- M3 — trust & extension: E2EE activation, plugin runtime, multi-user, realtime collaboration

## Quickstart

Prereqs: Node 22+, pnpm 9. From the repo root:

```bash
pnpm install
export NOTEES_DATA_DIR=$PWD/data          # relay log, assets, and the key file live here
pnpm --filter @notees/server dev &        # 1. start the server (port 8377)
export NOTEES_SERVER=http://localhost:8377
export NOTEES_API_KEY=$(cat data/api_key.txt)   # generated on first boot, logged once
# 2./3. the CLI lives in its own repo (notees-cli): pnpm dev -- doctor, then
# pnpm dev -- object create --name "Hello Notees"
```

The full walkthrough — server env, a real CLI session, the web app, the object API — is in [docs/usage.md](docs/usage.md).

## Docs

- [docs/philosophy.md](docs/philosophy.md) — the ideas: op-log truth, the design law, single-sourcing, classes as nodes, UUID identity, and the wounds that became our rules
- [docs/usage.md](docs/usage.md) — install, run, CLI tutorial, web app, object API reference
- [docs/ux.md](docs/ux.md) — the interaction model: outliner, system sections, marks on words, whiteboards, promotion (Today vs Designed per feature)
- [docs/developers/](docs/developers/) — runbooks for people developing and operating Notees: architecture, development, deployment, live data migrations, releases & client lockstep
- [.plans/design/](.plans/design/) — the normative design stack (`00-INDEX.md`, `01-knowledge-model.md`, `02-model-assessment.md`, `03-paradigm-assessment.md`)
- [packages/protocol/SCHEMA.md](packages/protocol/SCHEMA.md) — content grammar, node structure, typed-link tokens, sections contract (normative)
- [packages/protocol/WIRE.md](packages/protocol/WIRE.md) — relay wire spec: envelopes, endpoints, WebSocket framing

## Layout

- `packages/protocol` — envelopes, HLC, op registry, content grammar, canonical fixtures
- `packages/domain` — display-name derivation, seeds, shared domain logic
- `packages/store` — SQLite derived state (server: better-sqlite3; web: sql.js)
- `packages/sync` — SyncEngine: outbox, catch-up, snapshot restore
- `packages/query`, `packages/search`, `packages/editor`, `packages/api-client`, `packages/plugin-sdk` — per-milestone scope (see plan assessment §34.3)
- `apps/server`, `apps/web` — the two surfaces you can run today (the CLI is its own repo: [notees-cli](https://github.com/miquelrosell99/notees-cli))

## Development

```bash
pnpm test        # all packages
pnpm typecheck   # all packages
```
