# The Notees Connector

The **Notees Connector** is a browser extension that saves the page you are looking at into your Notees workspace — into your sources library as a `web_page`, or into [Read later](read-it-later.md). It captures **the URL, the title, and page metadata only — never the page body**. There is no readability extraction and no snapshot: reading stays in the browser, Notees keeps the pointer.

Where it stands, up front: the half of the connector that lives in this client — the **tab relay** an open Notees tab answers — ships with this update, and the capture endpoint the fallback transport talks to ships together with the sync-server update. The Firefox extension that drives both is **designed and still in development**: nothing to install yet, and the sections below say exactly what each part does today versus what is specified.

## The tab relay

With a Notees tab open, captures relay **through that tab** — and the tab is the preferred path, for one reason: the extension needs **zero credentials**. The extension's content script passes a `notees-capture-request` to the open tab; the tab stamps the capture through its own sync engine and answers with the created node's id. Because the tab does the writing:

- **Encrypted workspaces stay end-to-end encrypted.** The relay is the only capture path into an E2EE workspace: the master key never leaves the tab, and no plaintext channel into the store exists. A locked workspace answers honestly — unlock Notees in the tab and retry.
- **The tab answers only its own server.** Requests are honored only from the workspace's configured server origin (an exact match); anything else gets silence. Logged out entirely, the tab instead answers `not_authenticated` to any well-formed request, so the caller can tell "no workspace here" from "no answer".
- **Three failure codes, no guessing.** `not_authenticated` (no session in the tab), `feature_disabled` (the matching workspace feature is off — Read later in Settings → Features, or the Sources family for library captures), `failed` (the write itself, e.g. the workspace is locked).

What a relayed capture writes: a **`web_page` node** titled from the page, carrying the `url` and an `accessDate` (day precision) stamped through the same classed-create pipeline as any source — citation self-heal, one undo batch, the normal outbox push. Captures are **idempotent by URL**: re-capturing a known address returns the existing node instead of duplicating it. An optional note becomes the node's first child block (on creation only — a re-capture never rewrites your notes). A Read-later capture also adds the node to the workspace's **Read later** collection. A toast in the tab confirms each capture, so the tab that did the work shows it.

## Direct capture (the fallback transport)

No Notees tab open, and the workspace is not encrypted: the extension falls back to **direct REST** — `POST /api/capture/web-page` on your server, authenticated by your session or a scoped API key bearing the `capture.write` scope (minted from the API-keys settings like any scoped key). Sent with a DOI or ISBN, the server runs the metadata resolver and fills the bibliographic fields. Two refusals are part of the contract: `403 feature_disabled` when the matching feature is off, and **`409 e2ee_required`** — no plaintext path into an encrypted store — which is the extension's cue to tell you to open Notees and capture through the tab. This endpoint, the key scope, and the Read-later collection's server-side bookkeeping land **together with the sync-server update**.

## The extension (Designed)

The connector itself is one Firefox extension — a single install with per-feature toggles (bibliography capture, read later) and one settings screen (your server URL plus an API key, validated by a probe against the server). Each save picks its transport in order: relay through an open Notees tab; direct REST otherwise; and on `409 e2ee_required` with no tab open, a notification telling you to open Notees to capture. Saves come from a toolbar button (the page's `citation_doi` meta tag feeds the resolver), context-menu entries for both destinations, and a keyboard shortcut for the default. Distribution is a **self-distributed XPI** — signed and sideloaded, no store listing. That sideloading step is the honest adoption cost: it is a few minutes of one-time setup, and it is the price of the extension never touching a third-party store.
