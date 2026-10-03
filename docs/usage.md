# Using Notees v2 (M1 alpha)

Everything on this page was run against the M1 code and the output shown is real (trimmed where marked). The ideas behind the commands are in [philosophy.md](philosophy.md); the interface concepts are in [ux.md](ux.md).

## Prerequisites and install

- Node 22 or newer, pnpm 9 (`packageManager` is pinned in `package.json`)
- From the repo root:

```bash
pnpm install
```

## Running the server

```bash
pnpm --filter @notees/server dev
```

The server is a single Fastify process: relay (op log), object API, and CAS asset storage, all under one data directory. Configuration is environment-only:

| Variable | Default | Meaning |
|---|---|---|
| `NOTEES_DATA_DIR` | `./data` | Relay log, snapshots, derived DBs, asset bytes, and the API-key file all live under here |
| `NOTEES_API_KEY` | *(generated)* | Bootstrap key, shape `nk_` + 32 chars. When absent, first boot generates one and persists it to `<dataDir>/api_key.txt` (mode 0600), logging it once |
| `NOTEES_PORT` | `8377` | Listen port |
| `NOTEES_HOST` | `0.0.0.0` | Listen host |
| `NOTEES_RELAY_BATCH_PER_MINUTE` | `30000` | Envelope-ingest rate limit per workspace |
| `NOTEES_GLOBAL_REQ_PER_MINUTE` | `10000` | Global fallback rate limit per IP |
| `NOTEES_MAX_MEDIA_BYTES` | `50 MB` | Media upload cap (sniffed jpeg/png/webp/audio) |
| `NOTEES_MAX_DOCUMENT_BYTES` | `100 MB` | Document upload cap (sniffed pdf/epub) |
| `NOTEES_LOG` | `true` | Request logging (`false` to silence) |

Reading the bootstrap key after first boot:

```bash
export NOTEES_API_KEY=$(cat data/api_key.txt)
```

Sanity probes (no auth needed for the first two):

```bash
curl -s localhost:8377/healthz                       # {"ok":true}
curl -s localhost:8377/api/version                # {"name":"notees-server","version":"2.0.0-m1","protocolVersion":3,...}
```

A fresh workspace seeds itself: a starter class catalog (`person`, `organization`, the `source` tree with its `book`/`paper`/`article`/`document`/`movie`/`thesis` children, `task`, `whiteboard`, `collection`, `query`, `template`, `note`, the `day`/`month`/`year` journals, …), plus `scratchpad` and `inbox` pages.

## Configuring the CLI

The CLI (`apps/cli`, invoked as `notees` once built, or `npx tsx src/cli.ts` in dev) talks to the server over HTTP. It needs the server URL and a credential, by flag or environment:

```bash
export NOTEES_SERVER=http://localhost:8377
export NOTEES_API_KEY=$(cat data/api_key.txt)   # operator key, user API key, or session token
# or per invocation: notees --server http://localhost:8377 --key nk_… <command>
```

The credential is sent verbatim — the server resolves operator keys, user API keys, and account session tokens (there is no client-side shape check; an invalid credential is the server's 401 → exit 3). When you authenticate as a user, `--workspace <name|id>` (env `NOTEES_WORKSPACE`) addresses the object API at that workspace instead of the server default: a uuid passes through with any credential; a name resolves through the account's workspace listing (cached per profile) and therefore needs an account credential.

Every command accepts `--json` (stable machine-readable output — the human output shown below is allowed to change; without it, listings render as compact fixed-width tables). Exit codes: `0` ok · `1` domain error · `2` usage · `3` auth · `4` conflict · `5` network.

**Standing sign-in.** `notees auth login --email you@example --password-stdin` verifies the password, mints a dedicated CLI API key (listed under your account's API keys, revocable from the app), and stores it per profile — later commands on this server skip `--key` entirely. `notees auth status` reports whether the stored credential still authenticates; `notees auth logout` revokes it server-side and clears it. A key may revoke itself; managing *other* keys still requires an account session.

**Destructive commands require `--yes`.** Without it, they fetch the object, print a blast-radius preview, and exit 2 — they never drop into an interactive prompt when `--json` is set or stdout is not a TTY. Scripts stay safe by construction.

## The shell

`notees shell` drops you into a Node REPL with the object API preloaded — the Odoo-shell equivalent: arbitrary graph scripting against the live server, top-level `await` included:

```bash
notees shell
# > const p = await create({ name: "Reading list" })
# > await search("Kuhn")
# > await effective(p.id)        # authored + derived class defaults
# > await exportMd([p.id])       # markdown bundle (alias of helpers.export)
# > .help                        # the full helper list
```

Helpers: `api` (raw client), `get`, `list`, `search`, `classes`, `classInfo`, `backlinks`, `props`, `effective`, `create`, `update`, `del`, `setProperty`, `upload(filePath)`, `exportMd`, plus op submission for graph maintenance: `makeOp(opType, payload, affected?)` builds an envelope-v3 op (HLC-stamped, workspace from `--workspace`), `submitOp` / `submitOps` push ops through the relay batch endpoint — the same one write path the app uses. Piped stdin runs as a script and exits (`echo 'console.log((await search("Kuhn")).length)' | notees shell`) — exit 0 ok, 1 script error, 3 auth, 5 unreachable.

## A real session

The transcript below is one actual run against a fresh server (docs build, 2026-09-26). IDs are UUIDv7 — yours will differ.

**0. Check the setup** — `notees doctor` probes configuration, reachability, and auth in one pass:

```console
$ notees doctor
ok  server configured: http://localhost:8477
ok  api key configured: present
ok  api key shape: nk_ + 32 chars
ok  server reachable: notees-server 2.0.0-m1 (protocol v3)
ok  authentication: API key accepted
```

**1. Create a page.** Non-JSON output prints just the new id, so it scripts cleanly:

```console
$ notees object create --name "Paris trip"
01a0dd78-cd48-73d5-87d6-8f650e8d7487
```

**2. Add a block with content.** Blocks are children (`--parent`); content is the token stream from the [SCHEMA.md content grammar](../packages/protocol/SCHEMA.md) — here one text run plus a mention of the page itself, passed as a JSON body on stdin:

```console
$ echo '{"contentAst":[{"type":"text","text":"Visited the Louvre with "},
        {"type":"mention","targetNodeId":"01a0dd78-cd48-73d5-87d6-8f650e8d7487","text":"Paris trip"}]}' \
    | notees object create --parent 01a0dd78-cd48-73d5-87d6-8f650e8d7487 --stdin
01a0dd78-ce72-769e-a424-e4d372a3ff62
```

**3. Search.** Unified FTS over active nodes:

```console
$ notees search "Louvre"
{ "results": [ { "id": "01a0dd78-ce72-…", "name": "Visited the Louvre with Paris trip",
                 "isClass": false, "presentAsMain": false,
                 "parentId": "01a0dd78-cd48-…", "updatedAt": "2026-09-26T11:27:57.042Z" } ] }
```

**4. Backlinks.** The mention from step 2 is already an edge in the derived index — one row per link, with type and provenance:

```console
$ notees backlinks 01a0dd78-cd48-73d5-87d6-8f650e8d7487
{ "backlinks": [ { "source_id": "01a0dd78-ce72-…", "target_id": "01a0dd78-cd48-…",
                   "type": "mention", "verb": null, "created_at": "2026-09-26T11:27:57.042Z" } ] }
```

**5. Inspect the class catalog.** Seeded classes with their inheritance edges (`extendsClassId`) and live member counts:

```console
$ notees class list
{ "classes": [ …, { "name": "paper",  "extendsClassId": "00000000-0000-0000-0001-000000000023" },
               { "name": "source", "extendsClassId": null }, … ] }        # trimmed
```

Membership changes are first-class commands — the class argument accepts a uuid or a title (case-insensitive, must be unambiguous); both ops are idempotent:

```console
$ notees class assign 01a0dd78-… book        # add the book class to an object
$ notees class unassign 01a0dd78-… book      # drop the membership (authored values survive)
```

Whole classes migrate in one shot — every member moves to the target class and `extends` edges pointing at the old class are remapped (the emptied class stays; deletion remains a separate, deliberate step). Preview-first, like the destructive commands:

```console
$ notees class remap fuente source --dry-run   # what would move, writes nothing
$ notees class remap fuente source --yes       # do it
```

**6. Attach an asset.** Upload is content-sniffed (jpeg/png/webp/pdf/epub/audio); the id prints, and `--object` links it to a node:

```console
$ notees asset add ./kuhn.pdf --object 01a0dd78-cd48-73d5-87d6-8f650e8d7487
01a0dd79-76a0-7733-a630-7a7b9a4b96c4

$ notees asset get 01a0dd79-76a0-7733-a630-7a7b9a4b96c4 --output ./kuhn-back.pdf
```

**7. The `--yes` rail.** Deletion refuses without it, by design:

```console
$ notees object delete 01a0dd78-cd48-73d5-87d6-8f650e8d7487
Refusing to move to trash "Paris trip" (page) without confirmation.
Re-run with --yes to proceed. Deleted object id: 01a0dd78-cd48-73d5-87d6-8f650e8d7487
$ echo $?
2

$ notees object delete 01a0dd78-cd48-73d5-87d6-8f650e8d7487 --yes
deleted 01a0dd78-cd48-73d5-87d6-8f650e8d7487
```

Delete is a **trash, not a purge**: the node and its subtree go inactive (`isActive: false`, still retrievable via `object get`) until retention cleans up. `--permanent --yes` hard-deletes and says "unrecoverable" in the preview.

**8. Watch the log grow.** The relay is the authority; the CLI keeps a local cursor per profile:

```console
$ notees sync status
server http://localhost:8477: 54 envelopes (restoreEpoch 0)
local cursor: seq 0 — 54 behind
```

Useful supporting commands: `notees object list --presentAsMain --q <text> --limit 20 --cursor <id>` (add `--all` to follow the cursor to exhaustion), `notees object get <id>`, `notees object update <id> --name … --presentAsMain|--no-presentAsMain --icon … --color …` (this is also promotion/demotion — flipping the render bit in place, identity and links intact; see [ux.md](ux.md#promotion-and-demotion)), and `notees ops [opType]` — the operation catalog (one-line description, example payload, affected-node shape per op) that backs the shell's `submitOp`.

## The web app

```bash
pnpm --filter @notees/web dev
```

Slice 1 is deliberately read-mostly. What works today:

1. **Account boot** — server URL, then sign in (or the initial-setup screen when the server has no users yet: it creates the admin account). No API key or workspace UUID prompts: after login you pick a workspace from your list, create one, or adopt "this device" (an offline workspace pushes its backlog on connect). "Work offline" skips the account entirely — edits stay on the device and sync on the first later connection. The session is remembered; sign out from the footer.
2. **Page list** — every active page, sidebar, `+ New page` creates one (a local-first write: applied to the local SQLite projection immediately, pushed to the relay in the background).
3. **Page view** — the page header and its block tree, rendered from content tokens: text marks (bold/italic/strike/highlight/code), mentions and class chips resolved to current names, quotes, external links, math (plain-code fallback until KaTeX), `hard_break`; asset/embed/query/whiteboard tokens render as labeled placeholders.

What is not there yet: editing in the browser (the outliner is M1 editor scope, landing with the interactive editor), backlinks/system sections UI, classes UI beyond the API. The data path underneath — local store, outbox, catch-up — is the same engine the editor will use.

## The Calendar

The sidebar's **Calendar** entry (hide it from Workspace Settings → Sidebar Visibility) opens a day view for one date — today by default:

- **Day header** — the weekday, a Today marker when you're on today, the full date in your date-format setting, the ISO week number, and ‹ / › buttons to step one day either side (Today jumps back).
- **Quick create** — one chip per class that has a date property (e.g. a Meeting class with a When property). Clicking a chip creates an object of that class with that date set to the selected day and opens it. By default every eligible class appears — on a fresh workspace that is the system Task class (its Scheduled property is set to the selected day). To narrow the list, use **Workspace Settings → Calendar Quick-Create** (the workspace switcher's gear): uncheck the classes you don't want. The choice is stored per workspace on this device; "Reset to defaults" returns to the automatic list.
- **Daily note** — the selected day's page embedded inline (edit it where it renders). No page yet? The "+ Daily Note" button creates it in place.
- **Tasks** — open tasks scheduled for the day, with overdue ones grouped above in muted red. The checkbox closes a task (and reopens it) exactly like the Tasks hub; "New" creates a task scheduled for the selected day. A task appears here when its **Scheduled** property points at this day; Done and Cancelled tasks never list.
- **Dated** — everything else that references this day through a date property (a meeting held that day, a range ending on it).
- **Created** — objects created on the selected day, newest first.
- **Month grid** (right column) — the selected month with today highlighted, days that have a note dotted, and prev/next arrows; click any day to select it. The Days/Months/Years switch zooms the grid, and its Today button returns to today.

Filter tabs (All / Daily note / Tasks / Dated / Created) narrow the left column to one section.

## Exporting

Export is a **projection, one-way by design** (the operation log is the truth) — engineered to be as round-trippable as possible.

- **A page or node** — the node menu (context menu / page header / "…" button) → **Export**. Five formats: **Markdown**, **HTML** (standalone, print-friendly), **Word (.docx)**, **LaTeX** (with a bibliography built from source-classed nodes), and **PDF** — three layouts (Notes = the app look, Essay = single-column typeset, Academic = two-column numbered headings) on A4 or Letter, rendered in the browser with a bundled open-license font (nothing leaves the machine). Options collapse open with per-format checkboxes (include child pages, hide empty properties, include asset files for Markdown, …). Markdown and PDF get a live preview. Export downloads one file — or a `.zip` when assets are included or several nodes are selected at once (human-readable `<title>-<id8>` files + `notees-manifest.json` for Markdown).
- **A whole workspace** — the workspace switcher's Export entry opens a small dialog: optional "Include asset files", then one `.zip` download — one Markdown file per top-level and child page (properties in YAML frontmatter, cross-page links rewritten to relative file links, whiteboard layouts as sidecar JSON), an `assets/` folder when included, and the manifest mapping every file back to its node id. The same zip is available headless: `GET /api/workspaces/:id/export.zip?includeAssets=0|1`.
- **From the CLI** — `notees export markdown --ids <id>… | --linked-to <id> [--depth N|fixpoint] [--output-dir <dir> | --stdout]` builds the same Markdown bundle (bullet order follows child position), and `notees shell`'s `exportMd(ids)` returns it as text. Markdown escaping, full-depth closure (no silent truncation), and whiteboard sidecars are the engine defaults.

## Object API quick reference

Base URL `http://localhost:8377`, auth header `X-API-Key: nk_…` on every call. Bodies are camelCase JSON; `contentAst` follows the [SCHEMA.md grammar](../packages/protocol/SCHEMA.md).

| Endpoint | What it does |
|---|---|
| `GET /api/objects?isClass=&presentAsMain=&class=&q=&limit=&cursor=` | List objects (paginated, filterable; `presentAsMain` selects the document-chrome rows — "pages" — its negation the inline body) |
| `POST /api/objects` | Create an object; body `{"name": …, "parentId": …, "presentAsMain": …, "classIds": [...], "contentAst": [...]}` (`isClass: true` declares a class — a root) — returns the full object |
| `GET /api/objects/:id` | Fetch one object, including `contentAst`, `classes`, `properties` |
| `GET /api/objects/:id/children` | Direct children in child-position order (both render zones; active only) |
| `PATCH /api/objects/:id` | Update `name`, `presentAsMain`, `contentAst`, `icon`, `color` |
| `PUT /api/objects/:id/classes/:classId` | Assign the object to a class (idempotent OR-Set add; class nodes are rejected — identity is the `is_class` bit) |
| `DELETE /api/objects/:id/classes/:classId` | Remove the class membership (idempotent tombstone; authored property values survive) |
| `DELETE /api/objects/:id` | Trash (subtree); `?permanent=true&confirm=<id>` hard-deletes |
| `GET /api/objects/:id/backlinks` | Edges pointing at the node (mentions, typed links, property refs) |
| `GET /api/search?q=&isClass=&presentAsMain=` | Full-text search over active nodes |
| `GET /api/classes` · `GET /api/classes/:id` | Class catalog and detail (bindings, members) |
| `GET /api/properties/:id/values` | Values asserted for a property schema |
| `POST /api/assets` (multipart) · `GET /api/assets/:id` · `GET /api/assets/:id/info` | Upload (sniffed), download, metadata |
| `GET /api/workspaces/:id/export.zip?includeAssets=0|1` | Full-workspace Markdown zip — one file per top-level and child page, manifest, optional `assets/` folder |
| `GET /healthz` · `GET /api/version` | Liveness and version/protocol probes |

One curl, end to end:

```bash
curl -s -X POST localhost:8377/api/objects \
  -H "X-API-Key: $NOTEES_API_KEY" -H 'Content-Type: application/json' \
  -d '{"parentId":"01a0dd78-cd48-73d5-87d6-8f650e8d7487",
       "contentAst":[{"type":"text","text":"Back via curl"}]}'
```

The relay surface your clients sync through (`POST /api/relay/v2/batch`, `POST /catch-up`, snapshot endpoints, `/stats`, `/ws/:workspaceId`) is specified in [packages/protocol/WIRE.md](../packages/protocol/WIRE.md). You rarely touch it directly — the `packages/sync` engine and the web `WorkspaceClient` speak it for you.

## Scope: accounts + operator key

The server has accounts (email + password, scrypt-hashed) with sessions, and an initial-setup screen gates the first admin. Workspace access is membership-based: the first account to write to an unclaimed workspace adopts it; reads require membership. The operator API key (`nk_…`) remains the machine path — the CLI and owned devices use it with unrestricted access. Multi-user hardening (roles, shares, registration) still lands with M3; expose the port to machines you trust.

## See also

- [README.md](../README.md) — the front door
- [philosophy.md](philosophy.md) — why the log is the truth
- [ux.md](ux.md) — the interaction model, Today vs Designed
