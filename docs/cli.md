# The Notees CLI

The `notees` command-line client: configuration, the scripting shell, one real end-to-end session, and the use cases the CLI is built for. The CLI lives in the standalone [`notees-cli`](https://github.com/miquelrosell99/notees-cli) repo, invoked as `notees` once built — see its README. For the HTTP surface underneath it, see the [Object API quick reference](api.md); the web-app counterparts of these gestures live in the feature pages under `features/`.

## Configuring the CLI

The CLI talks to the server over HTTP. It needs the server URL and a credential, by flag or environment:

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

(The `page` rows in that listing are standalone (`--no-isEmbedded`) children — the parent's main-children zone; `block` rows are the inline body.)

**3. Search.** Unified FTS over active nodes:

```console
$ notees search "Louvre"
{ "results": [ { "id": "01a0dd78-ce72-…", "name": "Visited the Louvre with Paris trip",
                 "isClass": false, "isEmbedded": true,
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

**Typed properties.** Class members carry structured values beside their content — `object property set` writes one (the schema argument is a uuid or a name; the value parses as JSON when it can — `42`, `true`, `{"nodeId": "…"}` — and stays a string otherwise), `object property delete` unsets a slot. The write path is shape-checked per schema type: a datetime or object-typed property takes a node reference (a date is a node — see [features/properties.md](features/properties.md)), a text property takes a plain string or a block reference, and a mismatched shape is rejected with an error rather than stored. One **Datetime** property type covers every date need: a value is a point `{"nodeId": "…"}` or a range `{"start": …, "end": …}` on the year/month/day node chain, **Full-day** by default (the absence of a time) — set a wall-clock time by switching the picker's **All-day** off (24h `HH:MM`, day precision only), span a period with the per-value **Range** toggle, jump via the picker's **Suggestions** column (Yesterday / Today / Tomorrow / In 1 week / In 2 weeks), or clear with **Remove**. Deleting a text property whose value references a carrier block moves that block to the trash (recoverable with `object restore`); plain-string values simply clear:

```console
$ notees object property set 01a0dd78-… publicationDate 1962
$ notees object property set 01a0dd78-… authors "García Márquez, Gabriel" --idx 1
$ notees object property delete 01a0dd78-… publicationDate
```

**Covers.** A page's cover image is one wire node field — `coverAssetId` on `object.update`, a reference to an **asset-classed** node (never a property; the retired image-typed `cover` property is superseded — see [features/pages.md](features/pages.md#page-chrome--what-sticks-and-where)) — `notees cover set` is the one gesture that composes the whole invariant (asset node → upload + attach → the field + asset class), mirroring the app's header-card flow:

```console
$ notees cover set 01a0dd78-… ./photo.jpg          # upload + set (replaces by default)
$ notees cover set 01a0dd78-… --asset 01a1…        # re-point at an existing asset node
$ notees cover set 01a0dd78-… ./photo.jpg --skip-existing   # re-runnable scripts: no-op when covered
$ notees cover get 01a0dd78-…                      # the cover's asset node id
$ notees cover clear 01a0dd78-…                    # unset; the asset node survives
```

Replacing keeps the old asset node in the graph (it stays an ordinary asset); `--skip-existing` prints the current asset id and writes nothing. Counting covered nodes rides the query language's `coverAsset:` field predicate (bare = the exists arm — `notees search "class:Pokemon coverAsset:"` once the CLI's vendor pin carries the grammar). In the app the cover renders as the page header's right-side card — never a property row — and the asset wears a derived **Cover** badge in card views while any cover points at it (a cover is a plain asset; there is no separate cover class).

**Property schemas.** The schema layer is manageable from the CLI too — `notees property` lists, shows, creates, renames, and deletes schemas, and binds/unbinds them to classes (the class argument is a uuid or a title, the schema argument a uuid or a name). Number schemas take display-only formatting: `notees property create "Dex number" --type number --pad 4` zero-pads the integer part (`0001`), and `--decimals 1 --rounding floor` cuts the fraction with the chosen approach — values stay exact in the log, the format shapes render only. `delete` is a soft-delete (authored values survive; the same UUID can be recreated later — in the app, the settings modal's **Convert…** runs the blessed delete+recreate flow for type changes: it creates the new schema, copies the values that map, lists the ones that don't (dropped only with explicit confirmation), re-points the class bindings, and deletes the old schema); `bind` patches one binding — a binding carries ONLY the active soft-unbind flag (owner rulings 2026-10-20/21: `--required`, `--default` and `--sequence` retired from the binding — the property's default is a SCHEMA-level field now, one global default per property; class panels render alphabetically by property name, so there is no panel order to set; the CLI's `--sequence` flag retires with it — a pending lockstep follow-up in the notees-cli repo):

```console
$ notees property list
$ notees property create Genre --type select --option Fiction --option Mystery
$ notees property rename Genre Style
$ notees property bind book Style
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

Useful supporting commands: `notees object list --isEmbedded --q <text> --limit 20 --cursor <id>` (add `--all` to follow the cursor to exhaustion; `--parent <id>` and `--trashed` filter direct children and the trash), `notees object get <id>` (`--ids <uuid…>` fetches many, in order), `notees object children <id>`, `notees object restore <id>…`, `notees object property set|delete <id> <schema> <value> [--idx N]`, `notees object update <id> --name … --isEmbedded|--no-isEmbedded --icon … --color …` (`--color` takes a preset token — `red orange yellow green teal sky blue purple pink gray` — or a custom `#RRGGBB` hex; `--color none` clears; this is also promotion/demotion — flipping the embedding flag in place, identity and links intact; see [features/pages.md](features/pages.md#promotion-and-demotion)), and `notees ops [opType]` — the operation catalog (one-line description, example payload, affected-node shape per op) that backs the shell's `submitOp`.

## Use cases

**Seeding a class from a dataset** — build a JSON array of create bodies and import it in one process with `object create --batch` (the 1,025-species Pokédex imports in about a minute). Each entry is exactly one `POST /api/objects` body — `name`/`contentAst`, `parentId`, `isEmbedded`, `classIds`:

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

**Structuring each imported node** — combine the two: upsert the node, then batch its info blocks as children. Blocks are children with the embedding flag set (the default), so they render inline in the body's zone; `--no-isEmbedded` children land in the main-children (Pages) zone instead:

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
