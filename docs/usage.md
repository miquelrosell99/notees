# Using Notees

Everything on this page was run against the shipping code and the output shown is real (trimmed where marked). The ideas behind the commands are in [philosophy.md](philosophy.md); the interface concepts are in [ux.md](ux.md). For people developing or operating a Notees server, the [developers/](developers/) docs are the runbooks.

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
curl -s localhost:8377/api/version                # {"name":"notees-server","version":"2.0.0-m6","protocolVersion":3,...}
```

A fresh workspace seeds itself: a starter class catalog (`person`, `organization`, the `source` tree with its `book`/`paper`/`article`/`document`/`movie`/`thesis` children, `task`, `event`, `meeting` (an event subclass), `birthday` (an event subclass linking to a person), `whiteboard`, `collection`, `query`, `template`, `note`, the `day`/`month`/`year` journals, …), plus an `inbox` page.

## Configuring the CLI

The CLI (the standalone [`notees-cli`](https://github.com/miquelrosell99/notees-cli) repo, invoked as `notees` once built — see its README) talks to the server over HTTP. It needs the server URL and a credential, by flag or environment:

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

Helpers: `api` (raw client), `get`, `list`, `search`, `classes`, `classInfo`, `backlinks`, `props`, `effective`, `create`, `update`, `del`, `setProperty`, `unsetProperty`, `propertySchemas`, `propertySchema`, `createPropertySchema`, `updatePropertySchema`, `deletePropertySchema`, `setClassProperty`, `unsetClassProperty`, `upload(filePath)`, `exportMd`, plus op submission for graph maintenance: `makeOp(opType, payload, affected?)` builds an envelope-v3 op (HLC-stamped, workspace from `--workspace`), `submitOp` / `submitOps` push ops through the relay batch endpoint — the same one write path the app uses. Piped stdin runs as a script and exits (`echo 'console.log((await search("Kuhn")).length)' | notees shell`) — exit 0 ok, 1 script error, 3 auth, 5 unreachable.

## A real session

The transcript below is one actual run against a fresh server (docs build, 2026-09-26). IDs are UUIDv7 — yours will differ.

**0. Check the setup** — `notees doctor` probes configuration, reachability, and auth in one pass:

```console
$ notees doctor
ok  server configured: http://localhost:8477
ok  credential configured: present
ok  server reachable: notees-server 2.0.0-m1 (protocol v3)
ok  authentication: credential accepted
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

**Seeing the children.** `notees object children <id>` lists a node's direct children in child-position order — both render zones at once, main children first-class citizens alongside inline blocks:

```console
$ notees object children 01a0dd78-cd48-73d5-87d6-8f650e8d7487
NAME                                        KIND   ID
Visited the Louvre with Paris trip          block  01a0dd78-ce72-769e-a424-e4d372a3ff62
```

(The `page` rows in that listing are `--presentAsMain` children — the parent's main-children zone; `block` rows are the inline body.)

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
{ "classes": [ …, { "name": "paper", "memberCount": 0, "parentClassIds": ["00000000-0000-0000-0001-000000000023"] },
               { "name": "source", "memberCount": 181, "parentClassIds": [] }, … ] }        # trimmed
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

Membership also moves in bulk without a target class — disband a class while keeping its members, or clear the members themselves (same preview rail as remap):

```console
$ notees class empty pokemon                      # unassign every member; the nodes stay
$ notees class delete-members pokemon --dry-run   # what would be trashed, writes nothing
$ notees class delete-members pokemon --yes       # trash every member (recoverable)
```

**Typed properties.** Class members carry structured values beside their content — `object property set` writes one (the schema argument is a uuid or a name; the value parses as JSON when it can — `42`, `true`, `{"nodeId": "…"}` — and stays a string otherwise), `object property delete` unsets a slot. The write path is shape-checked per schema type: a date or object-typed property takes a `{"nodeId": "…"}` reference (a date is a node), a text property takes a plain string or a block reference, and a mismatched shape is rejected with an error rather than stored. Deleting a text property whose value references a carrier block moves that block to the trash (recoverable with `object restore`); plain-string values simply clear:

```console
$ notees object property set 01a0dd78-… publicationDate 1962
$ notees object property set 01a0dd78-… authors '{"nodeId":"01a1…"}' --idx 1
$ notees object property delete 01a0dd78-… publicationDate
```

**Covers.** A page's cover image is a typed property (`cover`, an image-typed reference to an **asset-classed** node) — `notees cover set` is the one gesture that composes the whole invariant (family ensure → asset node → upload + attach → property + asset class), mirroring the app's header-card flow:

```console
$ notees cover set 01a0dd78-… ./photo.jpg          # upload + set (replaces by default)
$ notees cover set 01a0dd78-… --asset 01a1…        # re-point at an existing asset node
$ notees cover set 01a0dd78-… ./photo.jpg --skip-existing   # re-runnable scripts: no-op when covered
$ notees cover get 01a0dd78-…                      # the cover's asset node id
$ notees cover clear 01a0dd78-…                    # unset; the asset node survives
```

Replacing keeps the old asset node in the graph (it stays an ordinary asset); `--skip-existing` prints the current asset id and writes nothing. Counting covered nodes rides the query language's exists-arm: `notees search "class:Pokemon prop:cover:"`. In the app the cover renders as the page header's right-side card — never a property row — and the asset wears a derived **Cover** badge in card views while any cover points at it (a cover is a plain asset; there is no separate cover class).

**Property schemas.** The schema layer is manageable from the CLI too — `notees property` lists, shows, creates, renames, and deletes schemas, and binds/unbinds them to classes (the class argument is a uuid or a title, the schema argument a uuid or a name). Number schemas take display-only formatting: `notees property create "Dex number" --type number --pad 4` zero-pads the integer part (`0001`), and `--decimals 1 --rounding floor` cuts the fraction with the chosen approach — values stay exact in the log, the format shapes render only. `delete` is a soft-delete (authored values survive; the same UUID can be recreated later — in the app, the settings modal's **Convert…** runs the blessed delete+recreate flow for type changes: it creates the new schema, copies the values that map, lists the ones that don't (dropped only with explicit confirmation), re-points the class bindings, and deletes the old schema); `bind` patches one binding — omitted flags keep their stored values, `--no-<flag>` clears, and a wrong-typed `--default` is rejected:

```console
$ notees property list
$ notees property create Genre --type select --option Fiction --option Mystery
$ notees property rename Genre Style
$ notees property bind book Style --sequence 3 --required --default '"n/a"'
$ notees property unbind book Style
$ notees property delete Style --yes
```

The same surface is scriptable: `notees shell` gains `unsetProperty`, `propertySchemas`, `propertySchema`, `createPropertySchema`, `updatePropertySchema`, `deletePropertySchema`, `setClassProperty`, and `unsetClassProperty` (`.help` in the REPL lists them).

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

**Restore.** The trash is recoverable — `object list --trashed` shows it, `object restore <id>…` brings nodes back:

```console
$ notees object list --trashed
NAME            KIND   ID
Paris trip      page   01a0dd78-cd48-73d5-87d6-8f650e8d7487

$ notees object restore 01a0dd78-cd48-73d5-87d6-8f650e8d7487
01a0dd78-cd48-73d5-87d6-8f650e8d7487
```

Restore is **whole-tree**: children trashed with the node come back (tree placement intact); a child trashed on its own earlier stays trashed until you restore it. A permanently deleted node is gone — restore fails loud (exit 1). `object list` also filters `--parent <id>` for direct-children scans.

**8. Watch the log grow.** The relay is the authority; the CLI keeps a local cursor per profile:

```console
$ notees sync status
server http://localhost:8477: 54 envelopes (restoreEpoch 0)
local cursor: seq 0 — 54 behind
```

Useful supporting commands: `notees object list --presentAsMain --q <text> --limit 20 --cursor <id>` (add `--all` to follow the cursor to exhaustion; `--parent <id>` and `--trashed` filter direct children and the trash), `notees object get <id>` (`--ids <uuid…>` fetches many, in order), `notees object children <id>`, `notees object restore <id>…`, `notees object property set|delete <id> <schema> <value> [--idx N]`, `notees object update <id> --name … --presentAsMain|--no-presentAsMain --icon … --color …` (`--color` takes a preset token — `red orange yellow green teal sky blue purple pink gray` — or a custom `#RRGGBB` hex; `--color none` clears; this is also promotion/demotion — flipping the render bit in place, identity and links intact; see [ux.md](ux.md#promotion-and-demotion)), and `notees ops [opType]` — the operation catalog (one-line description, example payload, affected-node shape per op) that backs the shell's `submitOp`.

## Use cases

**Seeding a class from a dataset** — build a JSON array of create bodies and import it in one process with `object create --batch` (the 1,025-species Pokédex imports in about a minute). Each entry is exactly one `POST /api/objects` body — `name`/`contentAst`, `parentId`, `presentAsMain`, `classIds`:

```console
$ notees object create --isClass --name Pokemon
01a101c6-89e7-7bee-89c8-d1b87ea7af15
$ node build-dex.mjs        # writes dex.json: [{"name":"Bulbasaur"},{"name":"Ivysaur"}, …]
$ notees object create --batch --json < dex.json
{ "created": 1025, "ids": [ "01a1…", … ], "failures": [] }
```

Batch semantics: entries are grouped by parent and groups run concurrently (`--jobs <n>`, default 8) — entries under one parent always apply sequentially, because child position follows apply order and bulk blocks under a single parent keep their array order. Failures are collected and reported with exit 1 (add `--stop-on-error` to abort the rest); `--batch` and `--stdin` are mutually exclusive.

**A re-runnable import script** — `object upsert` finds-or-creates by exact title (case-insensitive) inside `--class`/`--parent` scopes, so a script can run daily without duplicating nodes:

```console
$ notees object upsert --name "Bulbasaur" --class 01a101c6-…
01a1…            # first run: created
$ notees object upsert --name "bulbasaur" --class 01a101c6-…
01a1…            # second run: the same id, no write (zero matches → create, one → reuse)
```

More than one node matches the title in scope and upsert refuses (exit 2, names the ambiguity) — narrow it with `--class` or `--parent` rather than guessing.

**Structuring each imported node** — combine the two: upsert the node, then batch its info blocks as children. Blocks are children with the render bit unset, so they render inline in the body's zone; `--presentAsMain` children land in the main-children (Pages) zone instead:

```console
$ POKEMON=$(notees object upsert --name "Venusaur" --class 01a101c6-…)
$ notees object create --batch <<EOF
[ {"name":"#0003","parentId":"$POKEMON"},
  {"name":"Type: Grass / Poison","parentId":"$POKEMON"},
  {"name":"Height: 2.0 m","parentId":"$POKEMON"} ]
EOF
```

(Real imports generate this array in a script — one entry per fact, thousands of blocks per run is fine; `object children` above is how you check the result.)

**Disbanding an experiment** — a seeded class you no longer want takes one command to drain and one to delete outright; both follow the preview/`--yes` rail (see the class section above):

```console
$ notees class empty pokemon          # membership gone, nodes kept
$ notees class delete-members pokemon --yes     # nodes to the trash (recoverable)
```

## The web app

```bash
pnpm --filter @notees/web dev
```

The web app is deliberately read-mostly. What works:

1. **Account boot** — server URL, then sign in (or the initial-setup screen when the server has no users yet: it creates the admin account). No API key or workspace UUID prompts: after login you pick a workspace from your list, create one, or adopt "this device" (an offline workspace pushes its backlog on connect). "Work offline" skips the account entirely — edits stay on the device and sync on the first later connection. The session is remembered; sign out from the footer. The boot screen never re-routes on its own: when an address does not answer, the error explains, and a "Try … instead" button offers the same-origin guess — clicking it is the only path there. User Settings → **Sync** shows the configured sync server (with reachability), offers **Connect to a different server**, and **Disconnect & forget this server** (confirmed — it signs you out and clears the remembered server and credentials on this device).
2. **Page list** — every active page, sidebar, `+ New page` creates one (a local-first write: applied to the local SQLite projection immediately, pushed to the relay in the background). The top bar carries the workspace selector, a **New** button (picks a class — one untitled page per picked class, the multi-select Apply creates one per checked class), and a search button; **Today** leads the sidebar's Navigation rows (today's day page, ensured on demand) — the sidebar itself starts with Navigation. The sidebar also carries the **Favorites** and **Recents** sections: star a page from its header star, any node context menu, or the row's own star — the lists follow your account across devices (server-side per-user prefs), falling back to this device's copy while offline. Row titles render as read-only block content: a title's mention links carry the same click (open the target) and right-click (the node-link menu) affordances as in the page, **Shift+click** peeks the node in the right sidebar, and a right-click anywhere else on the row opens the row's own menu. Every sidebar popup — the footer account menu, the workspace switcher, the row menus — closes on Escape or a press outside itself.
3. **Page view** — the page header and its block tree, rendered from content tokens: text marks (bold/italic/strike/highlight/code), mentions and class chips resolved to current names, quotes, external links, math (plain-code fallback until KaTeX), `hard_break`; a code block renders as a mono block with its language badge and edits in place (click it — the CodeTextarea surface writes the token's text on the usual debounced path); embed tokens render the live subtree, with the **Full/Card/Wide switcher** in the embed chrome writing the token's `view` (Card/Wide are bounded identity cards — never transclusions); query tokens run their saved query and render the results (edit the query's JSON only when you mean it — a malformed query renders an "invalid query" placeholder rather than guessing), whiteboard tokens open the spatial canvas, and asset tokens render their file with a lightbox. Class pills (the page's corner cluster and every block row's right-hand column) ×-remove a membership — except the system/journal classes (the class anchor, year/month/day), which are identity-bearing: their pill shows a lock instead, and the click explains instead of removing.
4. **Node links — open, peek, pin** — a mention (the dashed `@`-link) is a door, not just a color: **click** opens the target, **right-click** opens its menu (open, open in the sidebar, edit/retarget the link, remove or delete it), and **resting the pointer on it** raises a bounded preview card — the target's icon, title, a one-line excerpt, and its backlink count. The card is read-only on purpose: the editor owns the caret, and a hover surface that grabbed focus would fight the page you're reading. Click the card's title to open the node, or **Pin** it: the node becomes a small floating editor window — its real view (blocks and all) in a draggable card that sits beside what you're reading, editable exactly like the page (same writes, same undo, same sync), with **Open in main view** and **×** at the title bar's right. Pin an already-pinned node and its window just comes forward. The preview card closes when you move on, press Esc, or click elsewhere; the pinned window stays until you close it.
5. **Slash commands** — `/` in a block offers the block actions (text, quote, task, line break, URL, code, divider) plus the live ones: **`/code …`** converts the block to a code block (the sentence you wrote becomes the code; the typed argument is the language hint — `/code python`), **`/query`** inserts a query block and opens its builder, **`/date …`** links a typed date to its journal page (created on demand; a bare `/date` is today), **`/template …`** instantiates a template at the caret (see Templates below), **`/table …`** inserts a table whose cells are ordinary linkable blocks (see Tables below). Commands filter on the first word — the rest is the command's argument. Beyond the menu, **Ctrl/Cmd+Enter** on a block toggles its task state: a plain block becomes a task set to **Pending**, an open task jumps straight to **Done**, and a **Done** (or Cancelled) task clears back to a plain block.
6. **Quick capture** — **Ctrl/Cmd+Shift+N** quick-adds to today's page or the Inbox from anywhere; at narrow widths a floating **+ button** opens the same quick-add modal.
7. **Undo & redo** — **Ctrl/Cmd+Z** undoes, **Ctrl/Cmd+Shift+Z** (or Ctrl+Y) redoes. The topbar's **undo/redo buttons** do the same (disabled when there is nothing to (re)apply, hover for the exact step), and the undo button's **chevron** — or **Ctrl/Cmd+Shift+H** — opens the **history menu**: everything this tab did, newest first with labels and times; clicking a row opens the node it affected. The journal is session-local (this tab's writes, this tab's undo — another device or tab's edits never appear in it) and paragraph-grained for typing (one step per run of typing). While a text field or the outliner editor has the focus the keystroke stays text-scoped and the global journal stays out of the way; everything structural — creates, deletes, moves, property edits, renames — is one step. A permanent delete and deleting a class are the two gestures undo cannot take back.
8. **Properties** — in the main page layout the content card splits into two columns on one continuous vertical divider: the first (1/3) hosts the properties sidebar — a set of rows, one per property, each a property-name row (hints included; click for the settings, right-click for the row actions) followed by its value-cell row, spanning side to side to the divider; the sidebar collapses via the hamburger in the nodeview top bar. The second column (2/3) is a three-row stack: the nodeview top bar pinned to the top (hamburger + classes pills left, the blocks view switcher + "…" menu right, over a full-width divider), the nodeview proper with auto height between the bars (it scrolls when the content outgrows the cell), and the footer pinned to the bottom as a divided section — word count and the Created/Updated stamps. Compact renders (sidebar peek cards) keep the in-flow "Properties" section instead: the same rows as a label-left list under the header, collapsed by default (class-bound defaults dimmed until edited; "Add property" picks any schema or creates one). Click a property's label for its settings (rename, date precision, select options — each option carries an optional color that tints its pill and an optional icon), right-click it for the row actions: **Value history…** renders the property's writes from the server operation log (newest first), and **Convert…** changes the type via the blessed delete+recreate flow. A property value that points at a deleted node is not silently dropped — it renders the raw id in a dashed "broken" pill, and restoring the target heals it. **Text properties are blocks**: a text value renders as an editable block (with its own children) right in the row — not a repeated label per value. On a **multi-value** text property, pressing **Enter** at the end of a value starts the next value (a sibling block registered as the next entry); on a **single-value** one, **Enter** nests a child block under the value — the value is one block whose children are its lines.
9. **Inline property buttons** — a selection (or boolean) property can pin its value onto the block itself, not just the Properties section: open the property's settings (click its label in any Properties section) and pick its **value display** — **Next to bullet** renders the value as an icon button right at the block's bullet, **Before content** sets it just ahead of the text (the default **Properties panel** keeps it in the section only). The button wears the current option's icon and color, so state reads at a glance — the built-in task **Status** options are circles: gray Backlog, yellow Pending, orange Doing, blue Reviewing, green Done, red Cancelled — and clicking it opens a small picker to change the option without leaving the block. A property shown this way leaves the collapsed Properties section (the button already surfaces it). The same settings panel hosts each option's icon and color, plus the **Read-only** and **Hide when empty** property flags (**Required** stays per-class: the class page's property list sets it per binding).
10. **Aliases** — two kinds, both page metadata, coexisting:
    - **Text aliases** — the seeded **Aliases** property (add it from "Add property") gives a page alternative *names*: an alias is searchable like the title and resolves by exact name (`[[…]]` picks, unlinked references). Use it for spellings, abbreviations, alternate wordings of the same page.
    - **Node aliases** — the seeded **Alias of** property links a whole *page* under a main page: the alias page points at its main (pages only on both ends — the picker offers pages, and a non-page target is refused with an error, never written). Use it for plurals, opposites, translations — any meaning that deserves its own page. A node alias is a first-class page: searching its title opens *its* view (its own body, and only its own linked references), topped by an **Alias of \<main\>** chip that jumps to the main page. Everything pointing *at* the alias rolls up to the main page instead: mentions of the alias open the main page's view, and the main page's **Linked references** list the alias's inbound links right alongside its own (the alias title also joins the main page's names for unlinked references). The alias's own view stays quiet — it lists only what points at the alias itself.
11. **Workspace Settings → Features** — the core class families as per-workspace toggles: Tasks, Events, Meetings, Sources, Persons. A family off hides its classes from pickers, search, and hubs (family changes cascade — Events off hides Meetings and Birthdays too) while existing objects keep their data and stay in the graph. Turning a family **off** with existing instances asks first — the confirmation states that the objects keep their data and the family's surfaces hide (Cancel changes nothing); an empty family (or any enable) switches immediately.
12. **Workspace Settings → Plugins** — the plugin registry (owner/admin only): installed manifests list with their declared capabilities (export formats, importers, commands, widgets) and an enable toggle, plus an "Install manifest" paste-JSON box validated against the manifest grammar before anything is stored. The registry is honest scaffolding — the plugin *runtime* that would execute a manifest is not built yet, so installing stores validated data and an enable flag, nothing more.
13. **Search & command palette** — **Ctrl/Cmd+K** opens the command palette: sections for Recent (synced per-user across devices when online — device-local fallback), Date Pages, Pages, Classes, Content (full-text hits with excerpts, block hits labeled by their page), and Commands — including a typed **Create page "…"** row for whatever you typed. The sidebar's search button (and the top bar's, when the sidebar is collapsed) opens the same palette. Date pages answer formatted keywords ("feb 14") and the compact `YYYYMMDD` form, and the **`is_daily:`** prefix scopes the whole palette to date pages. In the `@` mention picker, a `class:Name ` prefix narrows candidates to that class's members (the create row then creates inside the class — under a **source** filter it opens the citation dialog instead: type, title, authors, year, DOI, with authors becoming linked person nodes; under an **agent** filter, a person/organization given/family split), and the Blocks tab labels every block with its containing page. **Global chords** (everywhere, yielding to text fields): **Ctrl/Cmd+N** new page, **Ctrl/Cmd+,** settings, **Ctrl/Cmd+\\** toggle the sidebar, **Alt+←/→** Back/Forward through the pages you opened, **Ctrl/Cmd+Shift+T** today's page, **Ctrl/Cmd+Shift+N** quick add, **Ctrl/Cmd+Alt+Enter** present the open page, **Ctrl/Cmd+Alt+F** focus mode.
14. **Sharing a page** — the node menu (context menu / page header / "…" button) → **Share…** mints a public **read-only** link: anyone holding it sees a static render of the page (title, block tree, properties — no app, no account, no way to write). The modal lists every link with **Copy** and **Revoke**; revocation takes effect immediately. See "Sharing a page" below.

What is not there yet: KaTeX math rendering, the plugin runtime. The data path underneath — local store, outbox, catch-up — is the same engine everything above rides.

## Presenting a page

Any page decks itself: the "…" node menu (top-right of the content card) → **Present**, the page header's right-click menu → **Present**, or **Ctrl/Cmd+Alt+Enter** with the page open. (Capacities uses Ctrl+Alt+P; that chord stays reserved for add-property here.)

The deck is a live, read-only read of the note — there are no slide objects:

- Slide 1 is the page itself (title, icon, color); each child in its **Pages** zone opens a section slide (its text is the title, its children the body); inline body blocks chunk into intro slides by a density rule; a trailing image block pulls aside (text left, image right, or centered when alone); embedded pages expand their children into the stream after the referencing slide.
- **Navigate** with ← → ↑ ↓, Space, PageUp/PageDown, the screen edges, or the floating toolbar (previous / counter / next / exit — it fades while you read and returns on any movement or keypress). **Esc** exits.
- Following a link inside a deck exits and opens the target in the app. Nothing in a deck edits the note.
- Reopening a deck within the session resumes at the slide you left — the index is session memory only, never persisted, never synced.

## Page layouts — what sticks and where

The page's surroundings, and what remembers what:

- **View modes stick (this device).** The outline/prose/cards triad on a page, the view mode of every hub (Tasks, Assets, Pages, …), the classed-nodes mode on a class page, and the cards/kanban cover layout — once chosen, they survive reloads. Storage is device-local (`notees.settings.*`): another device does not see them, and none of it ever enters the operation log. If a saved mode no longer applies (e.g. kanban after its grouping property is gone), the surface falls back to its default.
- **Appearance sticks (this device).** Settings → Appearance holds the theme (light/dark/system), OLED deep-black, the accent color, and the **UI font**: bundled (Inter + JetBrains Mono, shipped with the app — no CDN) or the platform's own system stack. Applied pre-paint via a `data-` attribute, remembered device-locally like the view modes, never in the operation log.
- **Covers.** ANY page's **cover** (an image-typed reference to an asset-classed node — set it in the page header's right-side cover card, or drop an image file on it) renders as a collapsible card beside the title, never a property row. The card shows even when empty — collapsed to a slim strip by default — and a cover whose asset has no image bytes renders a dashed placeholder naming the asset, never a silent void. The referenced asset wears a **Cover** badge in card views (derived from the property — a cover is a plain asset, no separate cover class). Whiteboard pages and embedded feeds skip the element entirely.
- **The context column** (the main layout's third column, beside the properties panel) carries the open page's context: **Contents** — a table of contents derived from the tree itself (its sub-pages and its short one-line blocks, nested one level), the current entry highlighted, click to jump — the **local graph** card (the page's neighborhood, depth 1–3), the workspace **Activity** feed, and **Comments** — threaded notes classed `comment` (a reply nests under its comment), with a quick-add composer and per-row Reply/Delete. Each column keeps its own collapse toggle in the page's top bar, remembered on this device; every section hides when it has nothing to show. (The page's incoming linked references are NOT here — they live once, in the Backlinks tab below the content; the old right-panel References list duplicated that same data and is gone.)
- **The right panel** (sidebar toggle, or shift+click anything) is the workspace-cards rail: any node you shift+click opens there as an independent card (breadcrumbs header, open-in-main, collapse, close), so you can keep several nodes beside the main view.
- **Reference tabs** — below the page's content, the page's references share one tab strip in the old slot beside the Child pages section: **Backlinks** lists what points AT the page (grouped by the referencing page), and **Unlinked mentions** (the "someone typed the page's name without linking it" tab) is the only one with row actions (below). Both tabs always show — an empty tab says so; a tab's query runs only when you first open it, re-runs on changes while it has been opened, and nothing loads for a tab you never touched.
- **Child pages** — the page's main children (the Pages zone) render as their own read-only tree section. On the main surface the section shows even when empty, with an **Add child page** button in its empty state: the create lands in the Pages zone and opens the new child. Embedded feed entries render the section read-only (no create button) and hide it while childless.
- **The footer** shows a word count (title + everything nested under it) and **Created** / **Updated** stamps; each stamp opens that day's page. A page created today reads **Created today**.
- **Breadcrumbs edit.** Hover a crumb for its chevron (or right-click it): Open, **Reassign parent…**, **Remove parent** — and a parentless page gets a "+ Add parent" pill. All of it is ordinary tree surgery (one move per gesture).
- **Unlinked mentions** (the "someone typed the page's name without linking it" tab, in the reference strip below the page) offers two actions per row: **Promote** turns the literal mention into a real link (the row moves to Backlinks), **Ignore** hides it on this device.
- **Creating classes.** The **Classes** hub's **New class** button (or the command palette's **New class…**) opens the creation dialog: a blank class (name, icon, color), or **Deploy system class** — the seeded system classes this workspace doesn't have yet (Person, Meeting, Source, the source family, …). Deploying authors the class at its designed identity, its place in the hierarchy, and its property family in one idempotent step — the same shape a server-seeded workspace starts with, so everything downstream (quick-create, calendar chips, citation fields) just works.

## Query blocks & saved views

A **query block** (insert one with `/query`) is a live saved query sitting in a page's content: it re-runs as the workspace changes and renders its results as a list or a table (the toggle persists in the block itself, so every device sees the same choice). The ⚙ button opens the builder — scope (entire workspace / this page / pages only), class, the class/render bits, text-contains, a created window, one sort, and a group-by with a measure (count, count distinct, sums/averages of number properties) that renders as a small aggregate grid. If a query was hand-written with constructs the builder can't represent (OR/NOT groups, property conditions, multi-sort), the builder shows a read-only summary of what it can represent and asks before anything is overwritten. Results window at 200 rows — **load more** widens the window, and **Export** downloads the current results as one Markdown file.

The created-window fields accept relative placeholders alongside fixed dates: **`{today}`, `{this_week}`, `{this_month}`, `{this_year}`** — resolved when the query runs, so "created after {today}" means today, every day.

The sidebar's **Queries** entry is the workspace's saved-views surface. **New query** opens the same builder as a modal: **Run** executes it ad hoc (nothing persists), **Save as view** names it and files it as a tab. Tabs are the page's saved views — rename, duplicate, reorder (move left/right), set the **default** (the view the section opens on), or delete from the tab's ⋯ menu. Saved views are ordinary query tokens hosted on a normal "Queries" page (linked at the bottom of the hub) — they sync like any content, render as query blocks when you open that page, and can be embedded anywhere else a query block can.

## The Calendar

The sidebar's **Calendar** entry (hide it from Workspace Settings → Sidebar Visibility) opens a day view for one date — today by default:

- **Day header** — the weekday, a Today marker when you're on today, the full date in your date-format setting, the ISO week number, and ‹ / › buttons to step one day either side (Today jumps back).
- **Quick create** — one chip per class that has a date property (the system Event, Meeting and Birthday classes are the examples — their date property is set to the selected day). Clicking a chip creates an object of that class with that date set to the selected day and opens it. By default every eligible class appears — on a fresh workspace those are the system Task, Event, Meeting and Birthday classes (the click sets a task's Scheduled, or an event/meeting/birthday's date). To narrow the list, use **Workspace Settings → Calendar Quick-Create** (the workspace switcher's gear): uncheck the classes you don't want. The choice is stored per workspace on this device; "Reset to defaults" returns to the automatic list. The bar's **repeat picker** (the ⟳ control) stamps the new object's date with a recurrence — pick Weekly and every chip click that day creates a weekly series anchored on the selected day.
- **Repeating events** — an event (or task) whose date carries a **repeat** rule shows on every occurrence day: the Dated and Tasks sections list it with a small ⟳ *Weekly* / *Daily* / … marker (one row per series — occurrences are computed, not stored, so there are no copies to clean up), and the month grid dots every occurrence day. Editing the event edits the whole series. Set or change the rule from the event's **Properties** panel (the ⟳ picker on the date pill — re-picking the date keeps the rule), or clear it back to "Does not repeat". The picker offers None / Daily / Weekly / Weekdays (Mon–Fri) / Monthly / Yearly. A repeating task appears in Scheduled on each occurrence day and never goes Overdue — the series rolls forward instead. **Completing one occurrence completes only that day**: the day view's checkbox records the date (the occurrence renders struck-through, every other day stays open, reopening removes just that date) — the tasks hub's checkbox, off the day context, still means the whole task.
- **Daily note** — the selected day's page embedded inline (edit it where it renders). No page yet? The "+ Daily Note" button creates it in place.
- **Tasks** — open tasks scheduled for the day, with overdue ones grouped above in muted red. The checkbox closes a task (and reopens it) exactly like the Tasks hub; "New" creates a task scheduled for the selected day. A task appears here when its **Scheduled** property points at this day; Done and Cancelled tasks never list.
- **Dated** — everything else that references this day through a date property (a meeting held that day, a range ending on it).
- **Created** — objects created on the selected day, newest first.
- **Month grid** (right column) — the selected month with today highlighted, days that have a note dotted, and prev/next arrows; click any day to select it. The Days/Months/Years switch zooms the grid, and its Today button returns to today. A day some object **references** through a date property (a meeting held that day, a range end) is dotted too — not just days that already have a note. Under the grid, the **week strip** shows the selected day's week (click to jump) and the **agenda** lists that week's dated objects day by day.
- **Reviewed days** — a day page carries a **Reviewed** boolean property (set it from the day page's Properties). Reviewed days wear a small tint on every calendar grid, so a skim shows which daily notes you already went over. The flag is an ordinary boolean property — it syncs like everything else.

Filter tabs (All / Daily note / Tasks / Dated / Created) narrow the left column to one section.

### Day pages

A day page is an ordinary page (the journal is the feed of them), and it carries its own chrome:

- **The date header** — the weekday and a Today flag ride a small line above the title; the title itself is the date in your date-format setting, with the day's **ISO week number** as a small flag after it. (The old ‹ / Today / › stepping bar is gone — step days from the calendar popup or the top-bar calendar; the **Reviewed** checkbox lived on that bar and is set from the page's Properties now.)
- **Three sections**, below the page's own content and collapsed like every system section — hidden entirely when there's nothing to show: **Tasks** (open tasks scheduled for this day, overdue above, with the same done checkbox as the Tasks hub), **Dated** (everything else that references the day), and **Created** (objects created that day, newest first, cards by default with an outline switch). **Month and year pages carry the same Created section** — everything created inside that month/year.
- **Ctrl/Cmd+Shift+T** (or the sidebar's **Today** row) opens today's page from anywhere in the app.

### The Tasks hub's buckets

The **Tasks** hub keeps its table/kanban collection and now leads with a collapsible **Buckets** section: **Overdue / Today / Upcoming / Unscheduled / Completed**. A task lands in exactly one open bucket by its earliest Scheduled/Deadline day; Completed is the whole closed set. Rows carry the same done checkbox as everywhere else — closing a task moves it into Completed under your hands. The section's collapsed state is device-local.

## Templates

A **template** is an ordinary node carrying the `template` class — its child blocks are the body that gets copied. Templates are bound to classes (the **Templates** cards on a class page, ＋ Bind template) and instantiated where objects are created: class pickers and the calendar's quick-create can offer a bound template, and the copy opens as a fresh node stamped with a `generated-from` provenance link back to the template (edit the copy freely — nothing writes back to the template). Unbinding a template from a class never touches copies already made.

Ways to use a template:

- **`/template`** (any block) — type `/template` and pick from the flat list of all templates (the typed remainder filters it, e.g. `/template meeting`). The pick creates a fresh page instantiated from the template and links it at the caret. A template is usable this way whether or not it is bound to a class.
- **The gallery** — the class page's Templates section → **Browse gallery**: every template in one searchable list. **Enter** on the highlighted row (or its **Use template** button) creates-with-template and opens the copy; the row click opens the template itself; **＋ New template** authors a new one.
- **Apply to an existing node** — a template card's apply affordance (the class page's Templates section) grafts the template onto a node you pick: its child blocks are cloned beneath, its classes/properties are added, and the `generated-from` stamp is written. Content the node already carries is never overwritten, and a node already generated from that template is skipped (no duplicated blocks).

**Variables:** write `{{name}}` placeholders in a template's text (titles included — a title is text). Instantiating a template that has variables opens a small dialog first: static names are editable rows (leave one empty to substitute nothing), dynamic names — `today`, `time`, `datetime`, `current_page` — are computed at apply time and shown read-only. Everything substitutes locally before the copy is written; a name the dialog never showed is never touched.

## Tables

A **table** is a container block carrying the `table` class: its child blocks are the rows, and each row's child blocks are the cells. Every cell is an ordinary node with its own id — mention it anywhere (`@` finds it; the reference renders the cell's *current* content), class it, give it properties, zoom into it from its bullet. Inside a cell the outliner keyboard contract is unchanged (Enter splits, Tab indents).

- **`/table`** (any block) — scaffolds the table under the current block: one row of three empty cells, caret in the first cell. The typed argument sets the column count: `/table 5`.
- **+ Row / + Column** — hover the table: **+ Row** appends a full row, **+ Column** appends a cell to every row. **− Row / − Column** delete the last row / the right-most column (inline-confirm: the check deletes, the × cancels); a deleted row's cells ride the ordinary subtree trash. The grid's column count follows the first row — a row with fewer cells shows a blank; a row with more spills an extra column.
- **Read-only projections** (embeds, the presentation deck, the Child pages tree) render the same grid; editing stays in the outline.

## Whiteboards

A **whiteboard** is a page (or an embedded block) whose content token carries the spatial canvas — a spatial view of the node's subtree, not a separate kind of content.

- **Cards are blocks.** Double-click empty space (or use the Card tool) to create a card: it is an ordinary child block with a position and size, so it indexes into search, takes classes and properties, and zooms like any block. Dragging a card is a layout update, coalesced into one write per gesture. **×** on a card deletes the block.
- **The tool palette** — Select/move, Card, Sticky note, Rectangle, Ellipse, Line, Arrow, Pen, Highlighter, Eraser, Text, Connector. Draw tools drag to draw (a bare click places a default size); place tools put one item and return to Select. The **connector** snaps its endpoints to the edges and centers of nearby cards and shapes. Sticky notes are cards with a node color (recolor them, or any selected shape/stroke, from the color swatch that appears with a selection). The **pen** draws freehand strokes; the **highlighter** lays a translucent wide marker stroke; the **eraser** drag-removes strokes and shapes under it (it stays armed until Esc — cards are graph nodes and are never erased; their **×** deletes the block).
- **Multi-select** — drag on empty space box-selects; Shift+click adds or removes; dragging any selected card moves the whole selection. With several items selected the toolbar grows alignment/distribution buttons and a stroke-width control.
- **Keyboard** — Delete/Backspace removes the selection, arrow keys nudge it (Shift = one grid step), Esc exits the active tool.
- **Context menu** — right-click any canvas object (card, shape, stroke): **Delete**, **Bring to front / Send to back** (shapes and strokes), and **Color** (cards color the node; shapes/strokes color the geometry).
- **Navigation** — mouse wheel zooms (fullscreen), middle-drag pans, the corner minimap clicks/drags to a spot, and the zoom cluster offers −, +, Fit, and 1:1. **Snap** quantizes drawing, placement, and drags to the dot grid.
- **Text that matters gets a card.** Shape labels and the Text tool are chrome — they live in the layout token, never in the graph.

Embedded whiteboards (a `/whiteboard` block inside another page) keep the full toolset; pan and wheel-zoom stay with the surrounding page.

## The graph view

The sidebar's **Graph** row (or setting your landing view to "Graph View") opens the workspace as an interactive map: every page and class is a node, every link is an edge, laid out by a force-directed simulation running off the main thread and drawn with WebGL. Blocks never appear as nodes — a block's links roll up to the page that holds it, so the map stays readable at workspace scale. The map renders edge-to-edge in the content card — the card frame is the only chrome.

- **Moving around** — drag empty space to pan, the wheel zooms (cursor-anchored). Drag a node to rearrange it (physics keeps settling around your pins); click selects, double-click (or the selection bar's **Open**) opens the node. The find field jumps to a node by name.
- **What the edges mean** — the toolbar's family chips toggle each link type: **Mentions** (one page links another), **Properties** (a property value points at a node), **Parents** (page containment), **Classes** (membership), and **Semantic** — the distinctive one: two pages are semantically linked when something mentions both in the same block. Semantic links carry a weight (how many blocks co-mention the pair) and a hover card names the blocks behind the link.
- **Semantic detail** — the sliders bound the semantic web: top-N strongest links per node, and the minimum shared-block count a link needs to appear. Raising them thins the noise; lowering them surfaces weak associations. The cuts are display-only — nothing is deleted.
- **Physics** — four presets (Sparse / Balanced / Compact / Clustered), a pause button (the layout also starts paused when your OS asks for reduced motion), and node sizing by connection count. Your layout positions are remembered per workspace, so the map greets you where you left it.
- **What stays out by default** — the journal chain (year/month/day pages) and any node family you toggle off; the counts in the toolbar always name the full filtered set, never just what's drawn. The **Orphans** toggle hides nodes with no visible links; the **Temporal** family links pages mentioned anywhere under the same day page (hover names the day); **Color groups** paints nodes by query (`class:book`, `prop:status:done`, …) — first match wins; the layout switcher offers **Force** (the simulation), **Circle**, and **Tree** (radial rings by parent depth); and the corner **minimap** shows the whole map with your viewport — click or drag it to move.

The page's context column carries the **local graph** card for the open page — its neighborhood (depth 1–3) with the same interactions at card scale.

The graph needs a WebGL 2 capable browser — without it the view says so honestly instead of rendering half a map. An empty workspace says **Nothing to graph yet**; when your filters hide every node the view offers **Reset filters** (back to the shipped defaults); an empty local neighborhood names the depth to widen. No canvas mounts for an empty map.

## Exporting

Export is a **projection, one-way by design** (the operation log is the truth) — engineered to be as round-trippable as possible.

- **A page or node** — the node menu (context menu / page header / "…" button) → **Export**. Six formats: **Markdown**, **HTML** (standalone, print-friendly), **Word (.docx)**, **LaTeX** (with a bibliography built from source-classed nodes), **PDF** — three layouts (Notes = the app look, Essay = single-column typeset, Academic = two-column numbered headings) on A4 or Letter, rendered in the browser with a bundled open-license font (nothing leaves the machine) — and **JSON archive**: the subtree as one structured `notees-json-archive` document (versioned envelope; every node with its verbatim content tokens, class ids, property values, position-ordered child ids, and the mention/embed/link/property edges mined from its content — the highest-fidelity projection, the disaster-recovery artifact). Options collapse open with per-format checkboxes (include child pages, hide empty properties, include asset files for Markdown, …). Markdown and PDF get a live preview. Export downloads one file — or a `.zip` when assets are included or several nodes are selected at once (human-readable `<title>-<id8>` files + `notees-manifest.json` for Markdown; the JSON archive stays one document for the whole selection).
- **A table view** (a class's classed nodes, query results, the tasks table) — the table toolbar's **Export CSV** downloads the *current view*: the visible columns × the full sorted result set (hidden columns stay out; the row window is display-only, never an export cut). Cells render exactly as on screen, RFC-4180 quoting keeps commas/quotes/newlines intact, and a UTF-8 BOM lets Excel open the file with the right encoding. **Export Excel** writes the same cut as an `.xlsx` — with a leading **uuid** column, then the visible column labels, and typed cells for number columns — so the sheet round-trips back through **Import table…**, which appears on editable tables next to the exports. The import accepts `.csv` or `.xlsx`: the first row names the columns, a `uuid` column (any capitalization) marks rows that **update** the node with that id (a non-empty title cell renames it, an empty property cell clears it), and rows without one **create** new nodes — a `name`/`title` column is the new node's title, a `class` column assigns classes by name, and every other header matches a property schema by name (select columns match option labels, node columns resolve by name, dates are ISO `YYYY-MM-DD`). A preview step shows the mapping and how many rows will create vs update; cells that can't be coerced are collected into a per-cell report at the end — nothing is guessed. When rows are checked, two scoped actions appear next to the count: **Export selected CSV** (the same columns over just the checked rows) and **Export selected…**, opening the export modal scoped to exactly those nodes — any format, over just the selection. Cards and kanban collections offer the same machinery: a card checkbox accumulates a selection, and **Export selected…** opens that modal over the checked cards.
- **A whole workspace** — the workspace switcher's Export entry opens a small dialog: optional "Include asset files", then one `.zip` download — one Markdown file per top-level and child page (properties in YAML frontmatter, cross-page links rewritten to relative file links, whiteboard layouts as sidecar JSON), an `assets/` folder when included, and the manifest mapping every file back to its node id. The system pages (the inbox; scratchpad pages from before the feature was retired) and the journal date chain (year/month/day nodes) are excluded — scaffolding, not exportable content. The same zip is available headless: `GET /api/workspaces/:id/export.zip?includeAssets=0|1`.
- **From the CLI** — `notees export markdown --ids <id>… | --linked-to <id> | --class <id|title> [--depth N|fixpoint] [--output-dir <dir> | --stdout]` builds the same Markdown bundle (bullet order follows child position; `--class` seeds the bundle with the class's current members — the natural "export this class" selector), and `notees shell`'s `exportMd(ids)` returns it as text. Markdown escaping, full-depth closure (no silent truncation), and whiteboard sidecars are the engine defaults. `notees export json --ids <id>… | --linked-to <id> | --class <id|title> [--depth N|fixpoint] [--output <file>]` builds the same JSON archive the web modal delivers (stdout, or a file with `--output`).

## Sharing a page

Sharing is **read-only by design**: you mint an unguessable link, anyone holding it reads a static render of that one page — no account, no app, no write path. (Collaborative editing over shares is a different, parked feature; the public-read slice is what exists.)

- **Create** — the node menu (context menu / page header / "…" button) → **Share…** → **Create link**. The modal shows the full URL with a **Copy** button; every link ever minted for the page lists there (newest first), each revocable on its own.
- **What the visitor gets** — `GET /s/<token>` answers one self-contained HTML document: the page title, its block tree as nested lists, its properties — the same hardened projection the HTML export uses. No JavaScript, no external resource, a strict content-security-policy, `no-store` caching, and no referrer leakage; the link carries no hint of your workspace or other pages.
- **Revoke** — immediate: the next request on that link 404s. Trashing the page kills its links the same way. Minting may also set an `expiresAt` (API/CLI option) after which a link dies on its own.
- **The threat model, honestly.** Possession of the link IS the capability — treat a shared URL like a password: anyone it reaches can read the page until you revoke, and the server does not track viewers. There is no directory listing: tokens are 24 random bytes (base64url), and unknown, revoked, and expired links answer the *same* 404, so nothing can be enumerated or probed. Share state lives in the sync server's coordination database — it is deliberately NOT operation-log state (nothing about an expiry or a revocation belongs in the semantic graph every client converges on). Only the server's default workspace can be shared, and only its owner/admin (or the operator key) can mint, list, or revoke.

Headless: `POST /api/shares {nodeId, expiresAt?}` → `{share: {token, urlPath, …}}`, `GET /api/shares?nodeId=`, `DELETE /api/shares/:token` (see the quick reference below).

## Workflows

A **workflow** watches everything written to your workspace and reacts: *when X happens to a node that matches Y, do Z* — evaluated on the server, so it runs no matter which client made the change. It is automation for your graph, not a plugin system: the triggers, the criteria language, and the actions are the built-in vocabulary below.

- **X — the trigger.** What happened: a node was created (`object.create`), a property was set (`property.set`), or a class was assigned (`class.assign` — Notees has no separate "assign class" op; this trigger covers the class-add operation however it arrives).
- **Y — the criteria.** The same query language saved views and query blocks use (class membership, present-as-main, content, property values, links, creation date — combined with and/or/not). The rule only fires if the affected node matches.
- **Z — the action, v1.** Set a property (`property.set` with a fixed value) or assign a class (`class.assign`). Actions are written as ordinary operations by the server itself, so they sync to every device like your own edits and appear in the operation feed with the `rules-engine` provenance.

Original limits, honestly: **no rule chains** — an action's effects are evaluated once more, but a match there is recorded (`skipped_depth_cap`) rather than executed, so one batch can fire at most one hop of rules. A rule's own actions can **never re-trigger the same rule** (the loop breaker, recorded as `skipped_loop` when it would have matched). Triggers cover creates and property/class writes — not moves, deletes, or restores yet. Every firing attempt lands in an append-only **run audit** (`GET /api/workflows/:id/runs`) with its outcome; a failing action is audited and never blocks your write. Rule state lives in the server's coordination database (like shares and prefs — not in the operation log); only the server's default workspace is covered, and **only the owner/admin (or the operator key) can create, change, or delete rules** — any signed-in principal can read them. There is no UI yet: rules are managed through the API.

Example — flag every new Paper for review:

```bash
curl -s -X POST localhost:8377/api/workflows \
  -H "X-API-Key: $NOTEES_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "name": "Flag new papers",
    "trigger": {"opType": "object.create"},
    "criteria": {"version": 1, "scope": {"type": "entire_workspace"},
      "root": {"type": "group", "logic": "and",
        "children": [{"type": "class", "classId": "<paper-class-uuid>"}]}},
    "actions": [{"type": "property.set",
      "propertySchemaId": "<review-schema-uuid>", "value": "needs review"}]
  }'
```

`GET/PATCH/DELETE /api/workflows[/:id]` complete the CRUD (see the quick reference below); the developer runbook ([developers/workflows.md](developers/workflows.md)) has the table shapes, the loop policy, and the audit semantics.

## Object API quick reference

Base URL `http://localhost:8377`, auth header `X-API-Key: nk_…` on every call except the public probes (`/healthz`, `/api/version`, `/api/meta`, `/api/openapi.json`, `/api/server-info`, `/api/setup`, `/api/auth/login`). Bodies are camelCase JSON; `contentAst` follows the [SCHEMA.md grammar](../packages/protocol/SCHEMA.md).

**The developer contract is machine-readable:** `GET /api/openapi.json` serves the OpenAPI 3.1 document of the whole HTTP surface, and CI fails when it drifts from the registered routes. It pins the error taxonomy (`x-error-codes` — every failure answers `{"error": {code, message, status}}`, codes and statuses are stable), the rate limits (`x-rate-limits` — 10k req/min/IP global fallback, 30k envelopes/min/workspace relay batches, 10 logins/min/IP + the 5-failures lockout), the API-key scope vocabulary (`x-api-key-scopes`), and the revision/idempotency rules below.

| Endpoint | What it does |
|---|---|
| `GET /api/objects?isClass=&presentAsMain=&class=&q=&limit=&cursor=` | List objects (paginated, filterable; `presentAsMain` selects the document-chrome rows — "pages" — its negation the inline body) |
| `POST /api/objects` | Create an object; body `{"name": …, "parentId": …, "presentAsMain": …, "classIds": [...], "contentAst": [...]}` (`isClass: true` declares a class — a root) — returns the full object |
| `GET /api/objects/:id` | Fetch one object, including `contentAst`, `classes`, `properties` (each property entry carries its stable `elementId` — the multi-value element identity) |
| `GET /api/objects/:id/children` | Direct children in child-position order (both render zones; active only) |
| `PATCH /api/objects/:id` | Update `name`, `presentAsMain`, `contentAst`, `icon`, `color`; optional `baseRevision: {physical, logical}` — the object's `hlc` as last seen — 409s when stale (the only route with a natural per-node revision; see `x-revision-checks`) |
| `PUT /api/objects/:id/classes/:classId` | Assign the object to a class (idempotent OR-Set add; class nodes are rejected — identity is the `is_class` bit) |
| `DELETE /api/objects/:id/classes/:classId` | Remove the class membership (idempotent tombstone; authored property values survive) |
| `DELETE /api/objects/:id` | Trash (subtree); `?permanent=true&confirm=<id>` hard-deletes |
| `GET /api/objects/:id/backlinks` | Edges pointing at the node (mentions, typed links, property refs) |
| `GET /api/search?q=&isClass=&presentAsMain=&limit=&cursor=` | Full-text search over active nodes — relevance-ranked; quoted `"phrases"` match exact adjacency, other terms match as prefixes; `cursor` (a previous response's `nextCursor`) pages until it comes back `null` |
| `GET /api/resolve?name=` | Resolve a node's id from its exact display name (case-insensitive; 404 when no active node carries it) — the one-round-trip counterpart of `/api/search` for name→id lookups |
| `GET /api/classes` · `GET /api/classes/:id` | Class catalog and detail (bindings, members) |
| `GET /api/property-schemas` · `GET /api/property-schemas/:id` | Active property schemas (list and one) |
| `POST /api/property-schemas` | Create a schema (`propertySchema.create`; caller-chosen uuid) |
| `PATCH /api/property-schemas/:id` | Patch a schema (`propertySchema.update`: name, options, datePrecision, dateQualified) |
| `DELETE /api/property-schemas/:id` | Soft-delete a schema (authored values survive; recreate under the same uuid reactivates) |
| `POST /api/classes/:id/properties` | Bind a schema to a class (`class.property.set`: sequence/flags/defaultValue patch) |
| `DELETE /api/classes/:id/properties/:propertySchemaId` | Remove the binding (authored property values survive) |
| `GET /api/properties/:id/values` | Values asserted for a property schema (each entry carries the value's `elementId`) |
| `POST /api/assets` (multipart) · `GET /api/assets/:id` · `GET /api/assets/:id/info` | Upload (sniffed), download, metadata |
| `GET /api/workspaces/:id/export.zip?includeAssets=0|1` | Full-workspace Markdown zip — one file per top-level and child page, manifest, optional `assets/` folder |
| `GET /api/plugins` · `POST /api/plugins` · `DELETE /api/plugins/:id` · `POST /api/plugins/:id/enabled` | The inert plugin-manifest registry: install validates the manifest grammar (idempotent on id+version), the toggle flips a stored bit. Owner/admin only — the first surface enforcing the reserved `admin` scope. The plugin runtime is parked: nothing executes |
| `POST /api/shares` · `GET /api/shares?nodeId=` · `DELETE /api/shares/:token` | Read-only public page shares: mint an unguessable token (`{nodeId, expiresAt?}` → `{share: {token, urlPath, …}}`), list (owner/admin), revoke (immediate). Share state is server coordination, not op-log state |
| `GET /s/:token` | The public share view — unauthenticated BY DESIGN (unguessable tokens): one static, read-only HTML document; unknown/revoked/expired are the same 404 (no enumeration) |
| `GET /api/workflows` · `POST /api/workflows` · `GET/PATCH/DELETE /api/workflows/:id` · `GET /api/workflows/:id/runs` | Workflow rules (issue #13) — "when X on nodes matching Y, do Z", evaluated server-side post-ingest; effects are ordinary ops by the `rules-engine` actor. Read: any authenticated principal; write: owner/admin. Bodies: `{name, enabled?, trigger: {opType}, criteria: QueryAst, actions: [property.set \| class.assign]}` |
| `GET /api/meta` | Server self-description: version, wire protocol versions, default workspace, setup state (auth-free) |
| `GET /api/openapi.json` | The OpenAPI 3.1 contract (auth-free, `cache-control: no-store`) |
| `GET /api/operations?workspaceId=&afterSeq=&limit=` | Paginated read of the workspace's relay operation log — the audit feed for agents (cursor shape like relay catch-up; entries are envelope-v3 ops) |
| `GET /healthz` · `GET /api/version` | Liveness and version/protocol probes |

**Agent safety.** Mutating JSON routes honor `Idempotency-Key: <key>`: the first 2xx response is replayed verbatim (header `x-idempotency-replay: true`) for an identical retry within 24h — no second write enters the log; reusing a key with a *different* request fails 409 `idempotency_replay`. Multipart uploads are excluded (CAS dedupes identical bytes by hash). The relay `/batch` needs nothing: it dedupes by envelope id.

**Scoped API keys (server side).** `POST /api/api-keys` accepts an optional `scopes` list (e.g. `["objects.read"]` for a read-only agent); keys without scopes — and the operator key and sessions — stay unrestricted. Scope checks are per-route (the OpenAPI `x-required-scope` extension is the enforcement table): an out-of-scope call gets 403 `scope_denied`, and scoped keys are rejected on the whole relay surface. The reserved `admin` scope gained its first enforcement with the plugin registry: `/api/plugins*` accepts the operator key or an administrator account, and a scoped key additionally needs `admin`. The in-app Read/Write/Admin checkboxes are separate web work.

One curl, end to end:

```bash
curl -s -X POST localhost:8377/api/objects \
  -H "X-API-Key: $NOTEES_API_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: import-run-001' \
  -d '{"parentId":"01a0dd78-cd48-73d5-87d6-8f650e8d7487",
       "contentAst":[{"type":"text","text":"Back via curl"}]}'
```

The relay surface your clients sync through (`POST /api/relay/v2/batch`, `POST /catch-up`, snapshot endpoints, `/stats`, `/ws/:workspaceId`) is specified in [packages/protocol/WIRE.md](../packages/protocol/WIRE.md). You rarely touch it directly — the `packages/sync` engine and the web `WorkspaceClient` speak it for you. Request bodies are capped at 128 MiB app-wide, with one deliberate exception: the client-produced snapshot upload (`PUT /api/relay/v2/snapshot/data`) rides a route-local **512 MiB** cap — a big workspace's full local projection is the largest body this API carries. Past even that, the server answers `413` and the client reports it once per session instead of retrying silently (the server-side snapshot, built by the relay itself, keeps covering restore).

## Scope: accounts + operator key

The server has accounts (email + password, scrypt-hashed) with sessions, and an initial-setup screen gates the first admin. Workspace access is membership-based: the first account to write to an unclaimed workspace adopts it; reads require membership. The operator API key (`nk_…`) remains the machine path — the CLI and owned devices use it with unrestricted access. Per-user API keys minted from settings can carry a read-only or other scope set (server-enforced; see the quick reference above). Read-only public page shares are live (the "Sharing a page" section above — owner/admin-gated, token-based); the rest of the multi-user hardening (roles, write-collaboration, registration) is not there yet. Expose the port to machines you trust.

## See also

- [README.md](../README.md) — the front door
- [philosophy.md](philosophy.md) — why the log is the truth
- [ux.md](ux.md) — the interaction model, Today vs Designed
