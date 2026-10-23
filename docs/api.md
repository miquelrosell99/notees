# Object API quick reference

The whole HTTP surface of the Notees server, for scripts and agents. The CLI wraps the same routes ([cli.md](cli.md)); the web app's feature pages describe what the routes are for.

Base URL `http://localhost:8377`, auth header `X-API-Key: nk_…` on every call except the public probes (`/healthz`, `/api/version`, `/api/meta`, `/api/openapi.json`, `/api/server-info`, `/api/setup`, `/api/auth/login`, `/api/auth/signup` — the last only exists while `NOTEES_SIGNUP_ENABLED` is on). Bodies are camelCase JSON; `contentAst` follows the [SCHEMA.md grammar](../packages/protocol/SCHEMA.md).

**The developer contract is machine-readable:** `GET /api/openapi.json` serves the OpenAPI 3.1 document of the whole HTTP surface, and CI fails when it drifts from the registered routes. It pins the error taxonomy (`x-error-codes` — every failure answers `{"error": {code, message, status}}`, codes and statuses are stable), the rate limits (`x-rate-limits` — 10k req/min/IP global fallback, 30k envelopes/min/workspace relay batches, 10 logins/min/IP + the 5-failures lockout), the API-key scope vocabulary (`x-api-key-scopes`), and the revision/idempotency rules below.

| Endpoint | What it does |
|---|---|
| `GET /api/objects?isClass=&isEmbedded=&class=&q=&limit=&cursor=` | List objects (paginated, filterable; `isEmbedded=true` selects the embedded body rows — blocks — `isEmbedded=false` the standalone rows — pages) |
| `POST /api/objects` | Create an object; body `{"name": …, "parentId": …, "isEmbedded": …, "classIds": [...], "contentAst": [...]}` (`isClass: true` declares a class — a root) — returns the full object |
| `GET /api/objects/:id` | Fetch one object, including `contentAst`, `classes`, `properties` (each property entry carries its stable `elementId` — the multi-value element identity) |
| `GET /api/objects/:id/children` | Direct children in child-position order (both render zones; active only) |
| `PATCH /api/objects/:id` | Update `name`, `isEmbedded`, `contentAst`, `icon`, `color`; optional `baseRevision: {physical, logical}` — the object's `hlc` as last seen — 409s when stale (the only route with a natural per-node revision; see `x-revision-checks`) |
| `PUT /api/objects/:id/classes/:classId` | Assign the object to a class (idempotent OR-Set add; class nodes are rejected — identity is the `is_class` bit) |
| `DELETE /api/objects/:id/classes/:classId` | Remove the class membership (idempotent tombstone; authored property values survive) |
| `DELETE /api/objects/:id` | Trash (subtree); `?permanent=true&confirm=<id>` hard-deletes |
| `POST /api/objects/:id/merge` | Merge the object into another: body `{targetId}` — children move, class/tag bindings + authored properties + cover/banner/description remap (target wins populated fields), incoming mentions/property references/aliases/collection memberships retarget, the source trashes; `?dryRun=true` returns `{dryRun, summary}` without writing. Guards (class/collection/trashed source, target in the source subtree) fail 422 before anything reaches the log |
| `GET /api/objects/:id/backlinks` | Edges pointing at the node (mentions, typed links, property refs) |
| `GET /api/search?q=&isClass=&isEmbedded=&limit=&cursor=` | Full-text search over active nodes — priority-ranked: exact matches in page titles first, then exact matches in blocks, then terms in order (non-adjacent), then first-parent-name matches, then partial matches (fewer terms last); terms prefix-match, and a matching alias page also surfaces its canonical page. Query modes: a fully quoted query (`"gmi dental"`) matches the exact substring only, a leading caret (`^gmi`) matches at the start only; `cursor` (a previous response's `nextCursor`) pages until it comes back `null` |
| `GET /api/resolve?name=` | Resolve a node's id from its exact display name (case-insensitive; 404 when no active node carries it) — the one-round-trip counterpart of `/api/search` for name→id lookups |
| `GET /api/classes` · `GET /api/classes/:id` | Class catalog and detail (bindings, members) |
| `GET /api/property-schemas` · `GET /api/property-schemas/:id` | Active property schemas (list and one) |
| `POST /api/property-schemas` | Create a schema (`propertySchema.create`; caller-chosen uuid) |
| `PATCH /api/property-schemas/:id` | Patch a schema (`propertySchema.update`: name, options, datePrecision, dateQualified) |
| `DELETE /api/property-schemas/:id` | Soft-delete a schema (authored values survive; recreate under the same uuid reactivates) |
| `POST /api/classes/:id/properties` | Bind a schema to a class (`class.property.set`: the active soft-unbind patch — the binding's only per-class mechanic; `required`/`defaultValue`/`sequence` retired, owner rulings 2026-10-20/21; class bindings list alphabetically by property name) |
| `DELETE /api/classes/:id/properties/:propertySchemaId` | Remove the binding (authored property values survive) |
| `GET /api/properties/:id/values` | Values asserted for a property schema (each entry carries the value's `elementId`) |
| `POST /api/assets` (multipart) · `GET /api/assets/:id` · `GET /api/assets/:id/info` | Upload (sniffed), download, metadata |
| `GET /api/workspaces/:id/export.zip?includeAssets=0|1` | Full-workspace Markdown zip — one file per top-level and child page, manifest, optional `assets/` folder |
| `POST /api/workspaces/:id/clone` | Clone a workspace from its derived snapshot image (owner-only): a fresh envelope-empty workspace gets the source's nodes with every `workspace_id` rewritten — returns `{id, name, nodeCount}` |
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

**Snapshot images: clone & import.** Both workspace-rebuild surfaces move a serialized `@notees/store` database (the derived projection), not log history. `POST /api/workspaces/:id/clone` snapshots a source workspace's derived store (consistent online backup) into a fresh workspace; `PUT /api/relay/v2/snapshot/data?…&mode=import` installs an image file into an existing workspace (`scripts/import-snapshot.mjs` is the ready-made driver). The target must be **envelope-empty** — refused with 409 otherwise — and the image must carry node rows at any log size (422). **Checkpoint semantics:** an imported or cloned workspace's log starts from its seed envelopes — the history is not in the log, and the installed snapshot is load-bearing: a derived-cache wipe rehydrates from the snapshot plus the log, not the log alone.

Workflow rules are managed through this API only (no UI yet): `GET/POST /api/workflows`, `GET/PATCH/DELETE /api/workflows/:id`, and the run audit at `GET /api/workflows/:id/runs` — see [features/workflows.md](features/workflows.md) for the vocabulary and an example, and [developers/workflows.md](developers/workflows.md) for the table shapes, the loop policy, and the audit semantics.
