# Notees Connector

A Firefox extension that captures web pages into your self-hosted
[Notees](https://github.com/miquelrosell99/notees-web) workspace — as
**bibliography sources** or **read-it-later** entries. Privacy-first: it sends
nothing anywhere except the Notees server you configure.

Manifest V2, built with Vite, packaged with `web-ext`.

## What it captures

Only the page's **URL, title, and `<head>` metadata** (DOI from
`citation_doi` / `dc.identifier`, ISBN from `citation_isbn` / ISBN-typed
`dc.identifier`). The extension never reads the page body, never touches
forms, and never runs on any site unless you grant its origin explicitly.

## How a capture travels — the two transports

Each capture picks one transport, per capture:

1. **Tab relay (preferred).** If a tab open to your Notees server origin is
   found, the extension injects a tiny `postMessage` bridge into that tab and
   the save rides the tab's own authenticated session. No API key is used, no
   credential leaves the browser, and it works on end-to-end-encrypted
   workspaces (the tab's client seals the op like any user write).
2. **Direct REST (fallback).** Otherwise the extension POSTs to
   `https://<host>/api/capture/web-page` with your scoped API key in the
   `X-API-Key` header. The key leaves the extension only inside that request,
   only to the configured origin. DOI/ISBN enrichment is added on this path
   only (the page protocol has no field for it).

Definitive answers are final: if the Notees tab or server says
`not_authenticated` or `feature_disabled`, there is no silent fallback — you
get a notification saying what to fix. A `409 e2ee_required` tells you to open
Notees and capture again (only the tab relay can write to an encrypted
workspace).

## Installation

The XPI in `web-ext-artifacts/` is **unsigned**. Firefox release builds refuse
to install unsigned extensions, so pick one:

### Temporary (development)

1. `pnpm build`
2. Firefox → `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
3. Pick `dist/manifest.json`.

Gone when Firefox restarts. `pnpm start` builds and launches this in one step
(`web-ext run`).

### Persistent unsigned install

Only on **Firefox Developer Edition**, **Nightly**, or **ESR**: set
`xpinstall.signatures.required` to `false` in `about:config`, restart, then
open the XPI file (drag it onto Firefox). Note the trade-off: this disables
signature verification for **all** extensions on that profile, so use it only
on a profile dedicated to self-hosted/development extensions. Release Firefox
will reject it — the honest fix is AMO self-distribution signing (`web-ext
sign`), which is a planned follow-up, not part of this slice.

## Settings (extension preferences)

Open the extension's options (toolbar icon → ⚙ / Manage Extension →
Preferences):

- **Server URL** — your Notees origin, e.g. `https://<host>`. Normalized to a
  bare origin (path and trailing slash are dropped); credentials in the URL
  are rejected.
- **API key** — minted in Notees (`Settings → API keys`) with the
  `capture.write` scope. Only needed for the REST transport; the tab relay
  uses the open tab's session instead.
- **Feature toggles** — bibliography capture and read-it-later independently
  enable/disable the toolbar/context-menu entries.
- **Test connection** — probes the server with the key and distinguishes
  *key rejected* from *not a Notees server* from *unreachable*.
- On save, Firefox asks for an **origin permission** grant limited to exactly
  the configured server origin (`https://<host>/*`) — the extension can then
  reach that server and inject the bridge into its tabs, and nothing else.

## Usage

- **Toolbar button** or **Ctrl+Alt+S** — save to bibliography.
- **Right-click** a page or link — *Save to bibliography* / *Read later*.

A notification confirms every outcome, success or failure.

## Development

```sh
pnpm install        # deps (corepack pnpm 9)
pnpm dev            # build + watch the background bundle
pnpm start          # build + run in Firefox (web-ext run)
pnpm test           # vitest suite (103 tests)
pnpm typecheck      # tsc --noEmit
pnpm build          # vite (3 modes) + static copy → dist/
pnpm lint:ext       # pnpm build + web-ext lint (0 errors, 0 warnings)
pnpm run pack       # pnpm build + web-ext build → web-ext-artifacts/*.zip
```

Note: the script is `pnpm run pack` — a bare `pnpm pack` is pnpm's own tarball
command and produces an npm `.tgz`, not the extension.

`test/build-output.test.ts` re-builds and pins the contract between the vite
output and the manifest's file references, so a bundle rename can't silently
ship a broken extension.

## Honest limitations

- **Unsigned only** in this slice: no `web-ext sign`/AMO listing yet; release
  Firefox users are limited to temporary installs until signing lands.
- **E2EE workspaces need an open Notees tab** — without one, captures fail
  with a `409`-derived "open Notees" notification.
- **Identifiers are REST-path-only** — captures that ride the tab relay don't
  carry DOI/ISBN (the page protocol has no field for them).
- **The relay needs the tab to answer within 15 s**; a slow tab falls back to
  REST if possible, otherwise fails with a notification.
- Temporary add-ons (`about:debugging`) do not survive a browser restart.

## Icons

`icons/icon-48.png` / `icons/icon-96.png` (manifest + toolbar + notification
icon — PNG because several OS notification servers refuse SVG) are generated
from `icons/icon.svg`, the design source kept in the repo. Regenerate both
with `pnpm run icons` (dependency-free: `scripts/render-icons.mjs` encodes
the PNG on `node:zlib`; the "N" glyph is drawn from geometry measured off the
shipped icon, since dependency-free SVG text rendering has no font engine).

## Planned follow-ups (not in this slice)

- `web-ext sign` for AMO self-distribution (makes the XPI installable on
  release Firefox).
- Chrome/MV3 port (non-goal per the spec — the extension is Firefox-shaped).
