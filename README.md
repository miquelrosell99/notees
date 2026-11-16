# Notees for Word

An Office.js task-pane add-in for Word: search your Notees graph, insert live
citations as Word fields, refresh them in place, and build a bibliography —
all offline-first. The pane talks **only** to the `notees serve` CLI bridge on
`http://127.0.0.1:<port>` (your own machine); it holds no server credentials
and makes no other network calls.

The add-in's statics (`dist/`) are plain files, served **locally on the
machine running Word** by the Notees CLI: `notees word serve` serves the
vendored localhost build at `http://localhost:<port>` (loopback only) and
renders the sideload manifest for that origin into its per-user cache dir.
Nothing is hosted on the Notees sync server.

## Build

```sh
pnpm install
pnpm build             # default flavor (see below)
pnpm build:localhost   # localhost flavor — the `notees word serve` layout
```

Both flavors produce the same `dist/` tree:

```
dist/
  index.html                         task pane entry (relative asset URLs)
  manifest.xml                       classic XML manifest, placeholders resolved
  assets/icon-32.png                 manifest IconUrl
  assets/icon-80.png                 manifest HighResolutionIconUrl
  assets/index-*.js / index-*.css    bundled pane
  lib/office.js                      vendored Office.js (no CDN dependency)
  lib/o15apptofilemappingtable.js    required by office.js at runtime
```

The manifest's `SourceLocation`/icon URLs are written at build time by
`scripts/copy-manifest.mjs`, which resolves two template placeholders:

- `${HOST}` — `NOTEES_WORD_HOST`, default `https://localhost:8378`.
- `${BASE_PATH}` — `NOTEES_WORD_BASE_PATH`, default `/word`, the path prefix
  under which a static file server fronts the dist.

The **localhost flavor** (`pnpm build:localhost` — the build the Notees CLI
vendors and serves) targets the `notees word serve` layout: `${HOST}`
defaults to `http://localhost:8471` and `${BASE_PATH}` to "", so the URLs
read `http://localhost:8471/index.html`. Env vars override either flavor.

## How the statics are served (matters for the manifest URLs)

`notees word serve` (from the `notees` CLI) serves the vendored localhost
build read-only at the **root** of `http://localhost:<port>`, bound to
127.0.0.1 only:

- `GET /` serves `index.html`; `GET /manifest.xml` serves the manifest
  re-rendered for the actual port.
- The sideload manifest is written to the CLI's per-user cache dir:
  `~/.cache/notees/word/manifest.xml` on Linux/macOS (`$XDG_CACHE_HOME`
  respected), `%LOCALAPPDATA%\notees\word\manifest.xml` on Windows.
- Word fetches the manifest and both icons from the manifest URLs during
  sideloading, so `notees word serve` must be running before you sideload
  and while the pane is in use.

The default flavor's `/word/` base path serves a static file server that
fronts the dist under a prefix (the layout the Notees sync server used to
serve): such a server must name files explicitly — no directory index,
`/word/index.html`, not `/word/` — and `NOTEES_WORD_BASE_PATH` must match
the prefix it mounts the dist under.

## Sideloading

The manifest is the **classic XML** manifest (not the unified manifest for
Microsoft 365) because the shared-folder catalog — the primary desktop
sideload path — does not support unified manifests.

### Windows desktop Word — shared-folder catalog

1. Run `notees word serve`; it writes the sideload manifest to its cache dir
   (`%LOCALAPPDATA%\notees\word\manifest.xml`).
2. Trust the catalog folder (per-user, no admin rights):
   registry key `HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs`
   — add a string value whose name and data are the cache folder path
   (`C:\…\notees\word`).
3. Restart Word, then **Insert → My Add-ins → SHARED FOLDER** → Notees.
   (Choose the *Shared Folder* tab, not the Office Store.)

### Word for the web — admin-center deployment

Word for the web cannot sideload from a local folder — deployment goes
through the Microsoft 365 admin center:

1. Admin center → **Settings → Integrated apps → Upload custom apps**, upload
   the rendered manifest (from the `notees word serve` cache dir), review the
   requested permissions, and consent. The admin center must be able to reach
   the manifest URLs, so this path suits a Word session on a machine that can
   also reach the add-in host.
2. Assign the app to the users who need it. It then appears under
   **Insert → Add-ins** in Word for the web.

A per-session "Upload my add-in" shortcut exists in Word for the web, but only
when the organization's admin has explicitly allowed custom-app sideloading —
treat the admin-center upload as the supported path.

**Capability caveat**: on hosts without the WordApi 1.5 field APIs, the pane
degrades to reading fields only — citation counts and refresh status work,
but inserting, refreshing, and restyling fields need a desktop Word.
The pane says so explicitly instead of failing silently.

### Word for Mac — wef folder

Copy the rendered manifest (from the `notees word serve` cache dir,
`~/.cache/notees/word/manifest.xml`) into the Word for Mac sideload folder:

```
~/Library/Containers/com.Microsoft/Data/documents/wef
```

Restart Word; the add-in appears in the task-pane picker.

## Pairing the pane with your workspace

The pane does nothing until it is paired with a `notees serve` bridge:

1. Run `notees serve --origin http://localhost:8471` (the add-in origin must
   be allowlisted for the pane's cross-origin bridge fetches; the pane's
   default bridge port is 8474 — any port works).
2. Copy the pairing token it prints.
3. Open the Notees pane in Word → settings → enter the port and token →
   **Connect**. The token is stored in the pane's local storage, so pairing
   persists across Word sessions.

## Development

```sh
pnpm dev        # vite dev server
pnpm test       # vitest unit suite (run after `pnpm build` — the scaffold
                # smoke test pins the default-flavor dist layout)
pnpm typecheck  # tsc --noEmit
pnpm build      # full dist/ (icons + bundle + office.js + manifest)
pnpm build:localhost  # the dist/ the CLI vendors and serves locally
```

Layout: `src/bridge/` (typed fetch client for the bridge protocol),
`src/citation/` (pure, unit-tested field/OOXML/CSL logic), `src/word/` (thin
Office.js adapter), `src/ui/` (React task pane), `scripts/` (build helpers).

Host-only behavior that vitest cannot cover is checked by hand — see
[docs/smoke-checklist.md](docs/smoke-checklist.md) (sideloading, field codes,
refresh, bibliography, style picker, read-only hosts).
