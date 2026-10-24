# Notees — Live Data Migrations (developer runbook)

How to change data the live relay log already carries. Read this before writing
or running any `scripts/migrate-*.mts`. Companion docs: `architecture.md` (the log/derived split),
`development.md` (the fixture gate + the client lockstep law).

## Running migrations

`scripts/migrate-pending.mts` is the **default entry point** for the
stored-log rewrite class (kind B below). It reads the `schema_meta`
idempotency markers, reports what is pending, and in `--apply` mode runs
every pending entry's own `--apply` in ONE maintenance window — the stack
stops once, the batch pays one backup/epoch/restart cycle, and every client
full re-syncs a single time (the rehydration is the cost, not the rewrite):

```
docker compose stop notees-sync        # apply refuses while it runs — repo law
pnpm --filter @notees/server exec tsx ../../scripts/migrate-pending.mts \
  --db ../../config/notees/sync/relay.db --apply
docker compose up -d                   # one rehydration for the whole batch
```

The orchestrator is read-only until `--apply`, and `--apply` never edits
`relay.db` itself: it aborts while `docker compose ps notees-sync` reports
the container running (unless `--assume-stopped`, after verifying by hand)
and delegates every actual rewrite to the entry script's own
backup + quick_check + epoch bump. Per-script invocation
(`pnpm --filter @notees/server exec tsx ../../scripts/<name>.mts --db …`)
stays the path for targeted re-runs and for the scripts the orchestrator does
not track (see the registry contract).

**Registry contract**: any new `scripts/migrate-*.mts` that rewrites the
stored log adds a `{ script, markerKey, kind }` entry to
`MIGRATION_REGISTRY` in `migrate-pending.mts` — `markerKey` is the script's
own `schema_meta` key. Kind classification: **"rewrite"** when the script
rewrites envelopes (replay divergence — needs the stopped stack + the epoch
bump); **"marker-only"** when it only backfills/marks with no replay
divergence (safe with the stack up). Scripts without a marker row cannot be
classified pending vs applied, so the orchestrator cannot track them — keep
the per-script invocation for those.

## 0. The law that creates migrations

**No backward compatibility** (owner directive, sole user): strict payload
schemas reject retired keys outright — there is no wire compat of any kind.
When the model changes, the stored log is rewritten **in place, once**, and
every derived store re-syncs from the migrated log. Seeds and additive JSON
ride a different (cheaper) path — decide which you have first:

| Change shape | Path | Replay cost |
|---|---|---|
| Additive **inside options/metadata JSON** (option `icon`, option `color`) | No op-shape change; old parsers STRIP unknown keys (the option record is non-strict) — syncs through old clients | None |
| Additive **optional field on a strict payload** (`display`, number formats, PC4 `active`) | New payload key; pre-batch clients **reject** envelopes carrying it → lockstep first, then append | None |
| **Retired key / moved field** (`nodeType`, `var(--color-preset-*)`, the binding flags) | In-place log rewrite + compensation + epoch bump (below) | One rewrite |
| **Seed content change** (names, option styles, family shape) | Append-only for live workspaces (self-heal or one-time script); seeds themselves only shape new workspaces | None |

The asymmetry that trips people: **option-record keys strip, payload keys
reject.** Icon-carrying options sync through an old client; a `display` on
`class.property.set` breaks it. Pick the migration moment accordingly.

## 1. The two migration kinds

### A. Append-only convergence (no log edit)

The immutable log gains envelopes; every replica applies them in order.

- **Client self-heal** (`ensureTaskFamily`, `ensureCoverProperty`,
  `meetingFamily.ts`): authors missing rows idempotently on surface open.
  Use for fresh-workspace gaps and idempotent additive seeding. Existing
  workspaces converge when the restyle helper is label-matched with **stored
  ids preserved** (`styleTaskStatusOptions` — authored values reference the
  option ids; a wholesale options replace must keep them).
- **One-time script** (`migrate-system-names.mts`, `migrate-task-status-styles.mts`):
  plan from a **scratch derived store** (snapshot + tail — the sync-server
  hydration shape, never a possibly-stale replica), protocol-validate every
  envelope BEFORE inserting, `--apply` through `RelayStorage.ingest`, then
  verify by read-back + a fresh scratch replay. Idempotent: a second run
  plans nothing.

### B. In-place rewrite (retired keys / moved fields)

`migrate-node-type.mts` set the precedent; `migrate-color-tokens.mts` and
`migrate-binding-flags-to-schema.mts` refined it. The full sequence:

1. **Plan from authority.** Read the converged state from a scratch store or
   the server's derived DB (`config/notees/sync/derived/<workspace>.db`,
   read-only WAL). Never plan from a client's replica.
2. **Backup.** Copy `relay.db` (and the snapshot bytes being patched) to
   `/tmp/…bak-<timestamp>` before anything.
3. **Rewrite the affected envelopes in place** — one transaction on the relay
   `envelope` table. Strip the retired/moved keys (surviving keys untouched;
   seq/id/HLC unchanged). Every rewritten envelope must re-validate through
   `payloadSchemaFor(opType)` afterwards — that assertion is the point.
4. **Append compensation** for anything whose value now lives elsewhere
   (`propertySchema.update` carrying the moved flags): one envelope per
   affected entity with the converged values, HLC now. Full replays must
   converge from the log ALONE — the snapshot is an optimization, never a
   requirement.
5. **Snapshots.** A snapshot embeds the derivation of its `up_to_seq`. If it
   post-dates the first rewritten envelope it is STALE: either patch its
   bytes with the same move (open, apply, `Store.open` to run the schema
   migration, verify rows, replace) or delete it — deletion forces the
   ~35-minute full replay the SCHEMA.md owed-work register documents, so
   patching is preferred when the move is mechanical. Backups first either way.
6. **Bump `restore_epoch`** (`relay.bumpRestoreEpoch`). WITHOUT this,
   `applied_envelope` id-skips the rewritten/compensation envelopes on every
   replica that already saw the old versions — clients silently keep the old
   derivation. The bump makes every client wipe + resync clean.
7. **Restart the sync server.** `RelayStorage.ingest` writes the log but does
   NOT apply to the server's running derived store — the container needs one
   restart to rehydrate snapshot+tail (learned 2026-10-05: the live API served
   pre-migration state until the restart).
8. **Verify, in order:** rewritten envelopes re-validate → fresh scratch
   replay of the FULL log with zero StoreError throws and the moved values on
   the new rows → live API serves the new state → (sqlite peek at the server
   derived DB when the API shape doesn't expose the field).

## 2. Client lockstep ordering (strict-payload changes)

1. Ship the TS reference (schemas, store, appliers, fixtures, tests).
2. Port GTK + Flutter, run their suites, tag both (the clients + their
   release mechanics: `docs/developers/README.md`).
3. Only then run the live migration / flip settings — a pre-batch client
   rejects the new envelopes and its sync stalls until updated.
4. Option-record additions (strip-safe) may migrate BEFORE the clients — they
   sync through.

## 3. Fixtures are part of the contract

- The shared corpus (`packages/protocol/fixtures/`, vendored verbatim into the
  GTK/Flutter repos) is the convergence gate: a small additive field batch
  may ride an existing fixture (the file changes in place); a batch that
  needs its own set/clear lifecycle or semantic pin gets a dedicated file +
  the exact-list gate entry (21→24 across the 2026-10-07 batches — the wire
  node fields, the class conversion, the asset property type). Either way
  the gate list is the contract — never silently drop or rename a fixture.
- Cross-applier replay (both TS store backends; GTK/Flutter CI) must pass on
  the updated fixture BEFORE the client ports count as done.

## 4. Script catalog (what each did — copy the closest)

| Script | Kind | Moved |
|---|---|---|
| `migrate-node-type.mts` | B | `nodeType` → `is_class`/`present_as_main`, envelope v3; snapshots deleted + epoch bumped |
| `migrate-title-is-content.mts` | B | `name` retired; titles became content |
| `migrate-color-tokens.mts` | B | `var(--color-preset-*)` → preset tokens/\#hex (SCHEMA.md "Data color grammar") |
| `migrate-text-carriers.mts` | A/B | text-property carrier normalization |
| `migrate-cover-to-asset.mts` | A | covers became plain assets |
| `migrate-system-names.mts` | A | display-wording renames via appended `class.update`/`propertySchema.update` |
| `migrate-task-status-styles.mts` | A | task-status option icons/colors + `display: "bullet"` on the Status **schema** |
| `migrate-binding-flags-to-schema.mts` | B | `hideWhenEmpty`/`readonly`/`display` off `class.property.set` onto the property schema |
| `migrate-cover-banner-alias.mts` | A | the retired cover/banner/aliasOf property assertions → the `coverAssetId`/`bannerAssetId`/`aliasedNodeId` wire fields (appended `object.update` + `property.unset`; resolves v1 `{hash}` cover data through the CAS table). STRICT-PAYLOAD ADDITIVE: run only after the GTK/Flutter ports accept the new keys |
| `migrate-retire-class-class.mts` | A | the retired `class` meta class — members convert to real classes via the `class.create`-on-existing-node capability + binding drops; has-template relocates to global scope (binding unset + `propertySchema.create` re-scope upsert); the emptied class-class rides to the trash. CLASS-IDENTITY SEMANTIC: run only after the GTK/Flutter ports implement the conversion |
| `migrate-attachments-asset-type.mts` | A | the attachments schema (…0011) retypes object → asset via the `propertySchema.create` upsert (the only wire path that changes a type); the explicit targetClassFilter retires (implicit in the type), values ride untouched. STRICT-ENUM ADDITIVE: run only after the GTK/Flutter ports accept the asset type |
| `migrate-unified-datetime.mts` | B | the retired `date`/`date_range` property types → `datetime` (envelope payload rewrite; values ride untouched — every legacy shape is a legal member of the new union, so no compensation envelopes) |
| `migrate-class-chip-rename.mts` | B | the retired `class_chip` content token → `class_link` (owner renaming ruling: the token is a node link, class variant; envelope payload rewrite of the `contentAst` tokens + the same byte-patch across snapshot/derived `node.content` rows; no compensation envelopes — a pure rename). Ships only after the GTK/Flutter lockstep ports; the owner-facing snapshot corpus was pruned to latest-per-workspace in the same stopped-server window |
| `migrate-main-parent-page.mts` | B | the parent-page condition (owner ruling 2026-10-15): `presentAsMain: true` claimed under a non-page parent (legal under the old model) converges to `false` — TAIL envelopes rewritten in place (detected by walking the post-snapshot tail through the new applier; the walk applies each rewrite mutated so as-of state stays true), SNAPSHOT-BAKED violations (born below the compaction horizon, no surviving op) cleared by direct derived-state surgery with the patched bytes replacing the snapshot blob. Historical move/demote-class breaches are NOT rewritten (they replay-quarantine like the date-chain locks). Affected workspaces: `restore_epoch` bumped + server derived DBs removed (the snapshot is PATCHED, not dropped — the pruned era lives only there). WINDOW CLOSED 2026-10-16: superseded by the Revision-12 rename below — the script stays as the historical artifact (its test retired), the same treatment `migrate-node-type.mts` got at the v3 bump |
| `migrate-is-embedded.mts` | B | the Revision-12 embedding model (owner 2026-10-16): `presentAsMain` → `isEmbedded` with polarity inversion (`is_embedded = 1 - present_as_main`) on `object.create`/`object.update` payloads, PLUS the embedded query ASTs (saved views / query blocks): conditions `{type:"presentAsMain"}` (value inverted), sort fields, aggregation dimensions — the AST walk recurses through group/not/nested-query shapes. Snapshots dropped + server derived DBs removed (the v21 derived-schema ladder renames/inverts the column on rebuild) + `restore_epoch` bumped. NO MIXED WINDOW: the old server rejects `isEmbedded` and the new one rejects `presentAsMain` — stack down → new images → migration → restart. LOCKSTEP GATE: run only after the GTK/Flutter ports ship the rename (the `is-embedded-parent-page.json` fixture) |
| `migrate-property-scope.mts` | B | the retired property-schema `scope` enum (owner ruling 2026-10-20): `propertySchema.create/update` payloads rewrite `scope` → `scopeClassIds` in place (`"global"` → the key stripped; `"class"` → the one-element class list, resolved from the domain seed spec then a live binding row; `"object"`/unresolvable → global + the owner report). The derived `property_schema.scope` column retires at store v24 (table rebuild — rows arrive with NULL `scope_class_ids`, the epoch bump makes every replica wipe + resync); stale snapshots are byte-patched with the same move. LOCKSTEP GATE: run only after the GTK/Flutter ports accept `scopeClassIds` and the new fixtures (`property-schema-scope.json`, `property-schema-update-fields.json`) |
| `migrate-seed-scope-flips.mts` | A | the seed-scope audit (owner ruling 2026-10-20): b8548e0e's mechanical `scope:"class"` mapping over-scoped the reusable seeds — the six task-family schemas + weblink's `url` flip to GLOBAL scope by appended `propertySchema.update {scopeClassIds: null}` (bindings untouched — per-class config); family-identity seeds (citekey, the source bibliographic family, the meeting trio, eventDate, birthdayPerson, the person split, asset/highlight fields) stay local. `--workspace`/`--all`; the same LOCKSTEP GATE as `migrate-property-scope.mts` (the same `scopeClassIds` key + fixtures) |
| `migrate-drop-binding-required.mts` | B | the owner ruling 2026-10-20 (the property-definition surfaces batch): `required` retires outright and `defaultValue` MOVES from `class.property.set` to the property schema (one global default per property, the Logseq shape). Envelopes carrying either key are stripped in place; one `propertySchema.update {defaultValue}` per affected schema is appended (the per-schema value read from the converged binding rows — max causality across classes; a stored JSON null is "no default", no compensation). The derived `class_property.required`/`default_value` columns retire at store v25 (table rebuild); stale snapshots are byte-patched with the same move (schema column + values, then the v24→v25 migration rebuilds the binding table) + `restore_epoch` bumped. LOCKSTEP GATE: run only after the GTK/Flutter ports ship the retired keys' rejection + schema-level `defaultValue` (the updated `class-property-defaults.json` / `class-property-active.json` / `class-unassign.json` fixtures) |
| `migrate-retire-external-link.mts` | B | the retired `external_link` content token (owner ruling 2026-10-21): links live as markdown `[label](href)` spans inside `text` tokens, parsed at render time (SCHEMA.md render grammar). `object.create`/`object.update`/`class.create`/`class.update` payloads rewrite each retired token → a `text` token — `[text](href)` when the pair satisfies the render grammar (http/https/mailto href without whitespace/parens; label without `]`/newline/backslash), else `text (href)` (URL stays visible, never a broken link) — quote/heading children walked; a `contentDeltaB64` carrier aborts the run (designed-not-implemented, there must be none). Snapshots + server derived DBs byte-patched the same way + `restore_epoch` bumped. LOCKSTEP GATE: run only after the GTK/Flutter ports ship the retired token's rejection + the markdown-link render parse |
| `migrate-drop-binding-sequence.mts` | B | the owner ruling 2026-10-21: `sequence` retires from `class.property.set` — class properties render as a PURE ALPHABETICAL list everywhere (by property name, read-time derivation), so panel order no longer exists to configure; the binding keeps only `active`. Envelopes carrying the key are stripped in place (no compensation — pure order metadata, discarded). The derived `class_property.sequence` column retires at store v26 (table rebuild on open — NO snapshot byte patch: no data to backfill, every hydration path opens through `Store.open`/migrate) + `restore_epoch` bumped. LOCKSTEP GATE: run only after the GTK/Flutter ports ship the retired key's rejection (the updated `class-property-defaults.json` / `class-property-active.json` / `class-unassign.json` / `property-schema-scope.json` fixtures) |
| `migrate-drop-schema-readonly.mts` | B | the owner ruling 2026-10-21: the `readonly` render contract retires from `propertySchema.create/update` — it was never user configuration (ZERO seeds ever carried the flag), so clients DERIVE readonly-ness from the system property list (`isReadonlyProperty`, packages/domain — the platform-provenance schemas `generatedFrom` + `alias`) instead of storing it. Envelopes carrying the key are stripped in place (no compensation — derived, not stored). The `property_schema.readonly` column retires at store v27 (table rebuild on open — NO snapshot byte patch: nothing to backfill) + `restore_epoch` bumped. LOCKSTEP GATE: run only after the GTK/Flutter ports ship the retired key's rejection |
| `repair-log-conformance.mts` | B | owner directive 2026-10-22 ("repair the log"): envelopes the relay ACCEPTED but the strict appliers can never apply, diagnosed by a FULL scratch replay per workspace (snapshot+tail hides below-horizon poison — the dry run must replay from seq 0). Three repairs, each dry-run by default: V1 rewrite drops not-yet-existing parents from `class.setExtends` payloads; V2 rewrite converges a system class's parent set to the seeded set (the lock forces it anyway); V3 DELETES dead envelopes — `object.delete` ops naming a node with no `create` anywhere in the workspace's log (the graph-loadtest probe dropped 50k foreign cleanup deletes into the test workspace), and guard-failing `object.create`s with zero later payload references. Rewritten payloads re-validate through the strict schema; `restore_epoch` bumped + snapshots/derived dropped for affected workspaces; verify = fresh full replay with zero throws. Envelope DELETION is the novel step (no payload to neuter) — justified only because the ops carry no recoverable intent for the workspace they landed in |
| `migrate-class-delete.mts` | B | the classes-gallery batch (owner ruling 2026-10-22): the retired `class.delete` op (family bases → `workspace.feature.set {enabled:false}`, other system classes → `object.update {active:false}`, user classes → `object.delete`, locked/orphan deletes dropped) + stored `object.delete` envelopes addressed at class nodes re-routed the same way. The old op tombstoned `class_member_set`; the rewritten ops deliberately do NOT — a rebuilt store keeps memberships the old world stripped (membership rides). `--db` points at the relay (dry-run default); snapshots dropped + server derived DBs removed + `restore_epoch` bumped. NO MIXED WINDOW: the new server rejects `class.delete` outright — stack down → new images → migration → restart. LOCKSTEP GATE: run only after the GTK/Flutter ports ship the retired op's rejection + the new fixtures (`object-update-active.json`, `object-delete-class-routing.json`) |
| `migrate-url-source-binding.mts` | A | the url seed change (owner 2026-10-22): the `url` binding row moves from weblink-only to the `source` family base — one appended `class.property.set {classId: <source>, propertySchemaId: <url>}` per workspace whose converged rows carry the url schema without a source binding (the weblink row stays — own-first resolution). A stored schema whose scope still drifts from the global seed (a pre-`migrate-seed-scope-flips` row) clears scope FIRST in the same ingest (`propertySchema.update {scopeClassIds: null}`), else the R5 dead-config check rejects the binding. No lockstep gate — ordinary config ops every port already applies; flows to devices through ordinary catch-up (no restart/epoch) |
| `migrate-source-library-roster.mts` | A | the source-library roster (owner 2026-10-23, slice 1 task 7): live workspaces converge to the task-3/4/5/6 seed state in one pass — nodes classed `paper` (…0025, withdrawn) get `class.unassign {paper}` + the re-issued `object.create` add carrier `classIds: [journal_article]`; the renamed classes' titles rewrite by `class.update` content, GATED ON THE EXACT OLD TITLE ("Article"→"Journal article" …0026, "Web link"→"Web page" …0034, "Movie"→"Film" — any other title is a user rename: reported as a skip, never clobbered; UUIDs unchanged, saved query ASTs survive); drifted workspaces get the task-6 materialization, data-driven from the manifests and existence-checked per row (missing seeded class nodes + extends, the pool property schemas + spec `bindTo` rows — the `bind: false` pool fields excluded per the owner 2026-10-24 ruling: scoped to source, no base binding row, `SYSTEM_SOURCE_CLASS_BINDINGS` only, `SYSTEM_EXTRA_CLASS_BINDINGS`, `SYSTEM_SOURCE_CLASS_BINDINGS`, the `SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES` flips after the rows exist). Missing seeded EXTENDS edges of the source family (web_page→source was the live case) heal via `class.setExtends` with exactly the seeded parent set — the deploySystemClass ensure shape, before the binding rows; planned bindings are R5 pre-checked at plan time (a runParents override carries the post-heal closure); the built envelopes are additionally TEST-APPLIED IN ORDER against the scratch store BEFORE ingest — a poison envelope (e.g. `class.unassign`'s inline-content lock) aborts with zero writes. `--all` supported; verify = fresh scratch replay (zero StoreError) + read-back assertions incl. the pre-rename saved query view still matching migrated nodes (review focus #5). No lockstep gate — ordinary config ops; the scratch companion is `scripts/migrated-verify/seed-source-roster-scratch.mts` (hard-refuses any `--data-dir` outside /tmp) |
| `migrate-authors-to-text.mts` | A | the authors retype (owner 2026-10-23, slice 1 task 8): the `authors` schema (…0012) flips object-multi → text-multi and its object {nodeId} values rewrite to "Family, Given" strings (familyName …0022 + givenName …0021, title-content fallback, element metadata verbatim), each SAME ref copied to `linkedAuthors` (…0006-…0001) so the people-graph backlinks survive. ONE ORDERED INGEST per workspace, flip-FIRST: (1) linkedAuthors adds (object values under the untouched object linkedAuthors schema), (2) the schema flip — a `propertySchema.create` UPSERT, the ONLY wire path that changes a schema's type (`propertySchema.update` carries no type; every other stored column — scope, options, filter, render flags — rides verbatim), (3) the value rewrites (strings validate against the now-text schema; each reuses its PG5 element id — an in-place LWW swap — or its positional idx). The planned values-before-flip order is IMPOSSIBLE: one-shape-per-type validation rejects a string under an object schema, so a replay would throw — flip-first is the sanctioned fallback and preserves the invariant (no replay ever validates an object value against the text schema; validation runs on incoming writes only, and a text schema still ACCEPTS a {nodeId} shape, so kept broken refs — deleted targets — converge without blocking). Broken/title-less refs KEEP their value, reported line by line; saved views carrying a property condition on …0012 are enumerated (they keep matching by UUID but read name-strings — meaning-flip report, no writes). Dry-run default; the built envelopes are TEST-APPLIED IN ORDER before ingest (dry run included); verify = fresh [pre-migration snapshot + migrated tail] replay from a clean store (zero StoreError) + read-back assertions. Idempotent — a second run plans nothing. No lockstep gate — text is an original wire type and the ops are ordinary `property.set`/`propertySchema.create`; the scratch companion is `scripts/migrated-verify/seed-authors-scratch.mts` (hard-refuses any `--data-dir` outside /tmp); the review-focus-#1 replay test lives at `apps/server/test/migrate-authors-to-text.test.ts` |

All scripts: **dry-run by default**, `--apply` to write, `--data-dir` +
`--workspace` flags (the owner workspace id is the default). Run via
`pnpm --filter @notees/server exec tsx ../../scripts/<name>.mts` from the repo
root.
