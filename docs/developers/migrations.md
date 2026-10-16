# Notees — Live Data Migrations (developer runbook)

How to change data the live relay log already carries. Read this before writing
or running any `scripts/migrate-*.mts`. Companion docs: `architecture.md` (the log/derived split),
`development.md` (the fixture gate), `releases.md` (client lockstep ordering).

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
2. Port GTK + Flutter, run their suites, tag both (`releases.md`).
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

All scripts: **dry-run by default**, `--apply` to write, `--data-dir` +
`--workspace` flags (the owner workspace id is the default). Run via
`pnpm --filter @notees/server exec tsx ../../scripts/<name>.mts` from the repo
root.
