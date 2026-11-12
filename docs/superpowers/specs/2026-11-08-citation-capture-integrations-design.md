# Citation & capture integrations — design spec

Date: 2026-11-08 · Status: draft, awaiting review

## Goal

Notees users can (a) capture web pages from Firefox into their workspace — as
bibliography sources or into a read-it-later inbox — and (b) insert live
citations and generate bibliographies in Word from their Notees sources,
local-first and Zotero-shaped. Nothing about the op-log authority model changes:
every write still rides the log as client/server-stamped envelopes.

## Decisions locked during brainstorm

1. **One generic "Notees Connector" Firefox extension** — single manifest,
   per-feature toggles (bibliography capture, read-later), one settings screen.
   Not two extensions.
2. **Read-it-later captures URL + metadata only** (no readability text, no
   snapshot). Reading happens by opening the page from Notees.
3. **Word integration = Office.js task pane add-in + a localhost bridge in the
   CLI** (`notees serve`), the Zotero architecture adapted to this stack
   (Zotero's own plugin is a native COM add-in — not buildable here).
4. **Extension transports: both from day one** — direct REST with a scoped API
   key, and relay through an open Notees tab. Tab relay is preferred when
   available; direct REST otherwise; E2EE workspaces require the tab path.

## Components and repos

| Component | Repo | Notes |
|---|---|---|
| `readItLater` feature + capture REST endpoints + add-in statics hosting | `notees-sync` (`/root/projects/notees-sync`) | protocol change, goes through the fixture gate |
| `notees serve` localhost bridge (search, citeproc, document protocol) | `notees-cli` (`/root/projects/notees-cli`) | new dependency: citeproc |
| Word add-in (Office.js task pane) | new repo `notees-word` | statics served by the sync server |
| Notees Connector (Firefox) | new repo `notees-connector` | self-distributed XPI, `web-ext` |
| Tab-relay handshake + feature toggle UI + user docs | `notees-web` (this repo) | small surface changes |

## Sync server changes (`notees-sync`)

### Protocol: `readItLater` workspace feature

- New id in `WORKSPACE_FEATURES` (`packages/protocol/src/op-types.ts`), entry in
  `WORKSPACE_FEATURE_MAP` (`packages/domain/src/features.ts`), modeled on
  `journal`: it gates a surface/capability, not a class family. No new classes
  or property schemas — reuses `web_page`, `collection`, `url`, `accessDate`.
- Fixture gate run as required for wire/model changes.

### `POST /api/capture/web-page`

New `apps/server/src/routes-capture.ts`.

- Body: `{url, title, mode: "source" | "readlater", identifiers?: {doi?, isbn?}, note?}`.
- With `identifiers`, the server runs the existing metadata resolver
  (`src/resolve-source.ts`) and fills authors/date/etc. on the node.
- Stamps `object.create` (class `web_page`) + `property.set` + (readlater mode)
  `collection.member.add` envelopes through `ctx.submit` — the one write path,
  idempotent and audited.
- Auth: session token or scoped API key bearing the new `capture.write` scope.
  (The reserved `collections.write`/`citations` vocabulary stays reserved.)
- Inbox bookkeeping: first readlater capture auto-creates a "Read later"
  collection node; its id is remembered in the relay.db workspace row
  (server-local bookkeeping, deliberately not op-log state).
- **E2EE workspaces are rejected with 409 `e2ee_required`** — no plaintext
  channel into encrypted stores. The extension falls back to the tab relay.
- Feature gating: 403 `feature_disabled` unless `readItLater` is enabled for
  the workspace (enabled via the existing `workspace.feature.set` op, from the
  web client settings or the CLI).

### Word add-in statics hosting

- The server serves the add-in's statics (manifest + taskpane assets) from a
  configurable directory (e.g. `NOTEES_WORD_ADDIN_DIR`) at `/word/`.
- Users sideload the manifest via a shared-folder catalog (desktop) or the M365
  admin center (Word for the web).

### Server tests

Vitest covering: feature gate on/off, `capture.write` scope auth, E2EE 409,
envelope stamping shape, idempotent re-capture, inbox auto-creation;
`openapi.ts` updated; fixture gate green.

## `notees serve` bridge (`notees-cli`)

- `notees serve [--port N]` runs an HTTP server bound to 127.0.0.1 only,
  speaking a small JSON protocol modeled on Zotero's connector document
  commands: `search`, `insert-citation`, `bibliography`, `refresh`,
  `document-removed`.
- Backed by existing machinery: the sync engine keeps the local derived store
  current, the query package answers search (`@notees/query`), citation
  rendering uses `@notees/export` + a citeproc implementation (new dependency).
- **Offline-first:** the add-in never talks to the network; sync is the bridge's
  problem. Word citations work without connectivity.
- Security: localhost-only bind, add-in origin check, first-connect pairing via
  a token file (the Zotero connector-authorization pattern).

## Word add-in (`notees-word`, Office.js)

- Task pane: search box → results from the bridge → Cite / Insert bibliography /
  Refresh; citation style picker (CSL; a few bundled styles + user-supplied
  .csl files).
- Citations are inserted as Word field codes carrying an embed (Zotero's `ADDIN`
  field shape) so documents stay portable and refreshable.
- The add-in talks only to `http://127.0.0.1:<port>`; it holds no credentials.

## Notees Connector (Firefox, `notees-connector`)

- One settings screen: server URL + API key (minted in Notees settings with the
  `capture.write` scope), validated by a `GET /api/features` probe.
- Per-feature toggles: bibliography capture, read-later.
- **Transport selection per capture:**
  1. Notees tab open → relay through the tab (zero credentials, E2EE-safe).
  2. Else direct REST to the configured server.
  3. Server answers 409 `e2ee_required` and no tab is open → notification
     telling the user to open Notees to capture.
- Tab relay mechanism: the extension's content script bridges
  `postMessage` between the background script and the Notees page; the page
  stamps, encrypts, and submits envelopes through its own sync engine and
  returns the created node id.
- Save actions: toolbar button (current page as `web_page` source; DOI pulled
  from `citation_doi` meta tags for resolver enrichment), context-menu entries
  "Save to bibliography" / "Read later", keyboard shortcut for the default
  mode. Content captured is URL + title + metadata only — never page body.
- Firefox only for the MVP; self-distributed XPI via `web-ext`, no store
  publishing.

## `notees-web` changes

- Tab-relay handshake module (the page side of the postMessage bridge).
- `readItLater` toggle in the settings/features UI (rides the existing
  `workspace.feature.set` op).
- User docs: one page per feature under `docs/features/` (connector, word
  add-in, read-it-later), plus entries in `docs/feature-status.md`.

## Read/unread state

Unread/read rides an existing property or tag on the `web_page` node (final
choice made during implementation, leaning toward a property). No dedicated
inbox surface in v1 — the user opens the "Read later" collection. A dedicated
inbox view is deferred follow-up work.

## Explicit non-goals (v1)

- Readability/full-text or snapshot capture.
- Chrome/Chromium port of the connector.
- Dedicated inbox UI in the web client.
- Native (COM/VSTO) Word plugin; Word-for-web support beyond sideloading.
- OAuth or third-party identity providers.

## Risks / open questions

- citeproc choice for the CLI bridge (citeproc-js vs a lighter CSL renderer) —
  decide at implementation time; bundling story matters (the CLI is a Node CLI,
  so citeproc-js is the natural fit).
- Whether `accessDate`/metadata property sets need small seed adjustments for
  `web_page` — verify against `packages/domain/src/source-class-bindings.ts`
  during implementation.
- Store/sideloading friction for the Firefox XPI and the Word manifest is user
  docs work, not code, but it is the main adoption cost.
