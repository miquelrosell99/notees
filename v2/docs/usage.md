# Using Notees v2 (M1 alpha)

Everything on this page was run against the M1 code and the output shown is real (trimmed where marked). The ideas behind the commands are in [philosophy.md](philosophy.md); the interface concepts are in [ux.md](ux.md).

## Prerequisites and install

- Node 22 or newer, pnpm 9 (`packageManager` is pinned in `v2/package.json`)
- From `v2/`:

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
curl -s localhost:8377/api/v1/version                # {"name":"notees-server","version":"2.0.0-m1","protocolVersion":2,...}
```

A fresh workspace seeds itself: a starter class catalog (`person`, `organization`, the `source` tree with its `book`/`paper`/`article`/`document`/`movie`/`thesis` children, `task`, `whiteboard`, `collection`, `query`, `template`, `note`, the `day`/`month`/`year` journals, …), plus `scratchpad` and `inbox` pages.

## Configuring the CLI

The CLI (`apps/cli`, invoked as `notees` once built, or `npx tsx src/cli.ts` in dev) talks to the server over HTTP. It needs the server URL and an API key, by flag or environment:

```bash
export NOTEES_SERVER=http://localhost:8377
export NOTEES_API_KEY=$(cat data/api_key.txt)
# or per invocation: notees --server http://localhost:8377 --key nk_… <command>
```

Every command accepts `--json` (stable machine-readable output — the human output shown below is allowed to change). Exit codes: `0` ok · `1` domain error · `2` usage · `3` auth · `4` conflict · `5` network.

**Destructive commands require `--yes`.** Without it, they fetch the object, print a blast-radius preview, and exit 2 — they never drop into an interactive prompt when `--json` is set or stdout is not a TTY. Scripts stay safe by construction.

## A real session

The transcript below is one actual run against a fresh server (docs build, 2026-09-26). IDs are UUIDv7 — yours will differ.

**0. Check the setup** — `notees doctor` probes configuration, reachability, and auth in one pass:

```console
$ notees doctor
ok  server configured: http://localhost:8477
ok  api key configured: present
ok  api key shape: nk_ + 32 chars
ok  server reachable: notees-server 2.0.0-m1 (protocol v2)
ok  authentication: API key accepted
```

**1. Create a page.** Non-JSON output prints just the new id, so it scripts cleanly:

```console
$ notees object create --nodeType page --name "Paris trip"
01a0dd78-cd48-73d5-87d6-8f650e8d7487
```

**2. Add a block with content.** Blocks are children (`--parent`); content is the token stream from the [SCHEMA.md content grammar](../packages/protocol/SCHEMA.md) — here one text run plus a mention of the page itself, passed as a JSON body on stdin:

```console
$ echo '{"contentAst":[{"type":"text","text":"Visited the Louvre with "},
        {"type":"mention","targetNodeId":"01a0dd78-cd48-73d5-87d6-8f650e8d7487","text":"Paris trip"}]}' \
    | notees object create --nodeType block --parent 01a0dd78-cd48-73d5-87d6-8f650e8d7487 --stdin
01a0dd78-ce72-769e-a424-e4d372a3ff62
```

**3. Search.** Unified FTS over active nodes:

```console
$ notees search "Louvre"
{ "results": [ { "id": "01a0dd78-ce72-…", "nodeType": "block", "name": null,
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

Useful supporting commands: `notees object list --nodeType page --q <text> --limit 20 --cursor <id>`, `notees object get <id>`, `notees object update <id> --name … --nodeType page|block --icon … --color …` (this is also promotion/demotion — flipping `node_type` in place, identity and links intact; see [ux.md](ux.md#promotion-and-demotion)).

## The web app

```bash
pnpm --filter @notees/web dev
```

Slice 1 is deliberately read-mostly. What works today:

1. **Bootstrap form** — server URL, API key, workspace ID; remembered in `localStorage`. Use the default workspace ID `c491595f-9f94-5ade-a620-e30ed063d8d2` (derived deterministically from `notees:workspace:default`; the CLI and server share it, and `sync status` prints it under `workspaceId`).
2. **Page list** — every active page, sidebar, `+ New page` creates one (a local-first write: applied to the local SQLite projection immediately, pushed to the relay in the background).
3. **Page view** — the page header and its block tree, rendered from content tokens: text marks (bold/italic/strike/highlight/code), mentions and class chips resolved to current names, quotes, external links, math (plain-code fallback until KaTeX), `hard_break`; asset/embed/query/whiteboard tokens render as labeled placeholders.

What is not there yet: editing in the browser (the outliner is M1 editor scope, landing with the interactive editor), backlinks/system sections UI, classes UI beyond the API. The data path underneath — local store, outbox, catch-up — is the same engine the editor will use.

## Object API quick reference

Base URL `http://localhost:8377`, auth header `X-API-Key: nk_…` on every call. Bodies are camelCase JSON; `contentAst` follows the [SCHEMA.md grammar](../packages/protocol/SCHEMA.md).

| Endpoint | What it does |
|---|---|
| `GET /api/v1/objects?nodeType=&class=&q=&limit=&cursor=` | List objects (paginated, filterable) |
| `POST /api/v1/objects` | Create an object; body `{"nodeType": "page", "name": …, "parentId": …, "classIds": [...], "contentAst": [...]}` — returns the full object |
| `GET /api/v1/objects/:id` | Fetch one object, including `contentAst`, `classes`, `properties` |
| `PATCH /api/v1/objects/:id` | Update `name`, `nodeType`, `contentAst`, `icon`, `color` |
| `DELETE /api/v1/objects/:id` | Trash (subtree); `?permanent=true&confirm=<id>` hard-deletes |
| `GET /api/v1/objects/:id/backlinks` | Edges pointing at the node (mentions, typed links, property refs) |
| `GET /api/v1/search?q=&nodeType=` | Full-text search over active nodes |
| `GET /api/v1/classes` · `GET /api/v1/classes/:id` | Class catalog and detail (bindings, members) |
| `GET /api/v1/properties/:id/values` | Values asserted for a property schema |
| `POST /api/v1/assets` (multipart) · `GET /api/v1/assets/:id` · `GET /api/v1/assets/:id/info` | Upload (sniffed), download, metadata |
| `GET /healthz` · `GET /api/v1/version` | Liveness and version/protocol probes |

One curl, end to end:

```bash
curl -s -X POST localhost:8377/api/v1/objects \
  -H "X-API-Key: $NOTEES_API_KEY" -H 'Content-Type: application/json' \
  -d '{"nodeType":"block","parentId":"01a0dd78-cd48-73d5-87d6-8f650e8d7487",
       "contentAst":[{"type":"text","text":"Back via curl"}]}'
```

The relay surface your clients sync through (`POST /api/relay/v2/batch`, `POST /catch-up`, snapshot endpoints, `/stats`, `/ws/:workspaceId`) is specified in [packages/protocol/WIRE.md](../packages/protocol/WIRE.md). You rarely touch it directly — the `packages/sync` engine and the web `WorkspaceClient` speak it for you.

## Scope: single user, by design

M1 auth is one API key: the server accepts exactly the configured key, derives the actor from it, and every workspace is yours. There are no users, roles, shares, or registration — multi-user lands with M3 hardening, and the wire spec already reserves what it needs (JWT sessions, E2EE envelope slot). Until then, expose the port to machines you trust.

## See also

- [README.md](../README.md) — the front door
- [philosophy.md](philosophy.md) — why the log is the truth
- [ux.md](ux.md) — the interaction model, Today vs Designed
