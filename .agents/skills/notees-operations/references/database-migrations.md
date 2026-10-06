# Database migrations

Canonical: `docs/developers/migrations.md` — read it before touching live
data. Two distinct kinds:

## 1. Derived-store schema migrations (code)

`packages/store/src/schema.ts` `SCHEMA_VERSION`, gated by
`PRAGMA user_version`. Additive is safe; **newer-than-code = hard error at
open — downgrade by restoring a backup** (`deployment.md` §7). A breaking
wire change additionally bumps PROTOCOL_VERSION + WS_PROTOCOL_VERSION +
fixtures with the three-client lockstep.

## 2. Live-log data migrations (the stored log is rewritten in place)

The standing law: **no backward compatibility** (owner directive, sole user).
The stored log is rewritten once in place; every derived store re-syncs.

**The asymmetry that decides the strategy** (`migrations.md` §0): keys inside
option/metadata JSON *strip* safely on old clients (no migration needed);
**new keys on strict payloads are *rejected*** by pre-batch clients →
lockstep first. Retired keys/moved fields → in-place rewrite.

- **Kind A — append-only:** client self-heal families
  (`ensureTaskFamily`, `ensureCoverProperty`, `meetingFamily.ts`,
  `styleTaskStatusOptions`) or a one-time script: plan from a scratch derived
  store (snapshot + tail), protocol-validate **before** inserting, `--apply`
  through `RelayStorage.ingest`, verify by read-back + fresh scratch replay.
  Idempotent.
- **Kind B — in-place rewrite, the 8-step sequence:**
  1. Plan from the authority (scratch store, or the server
     `derived/<workspace>.db` read-only — never a client replica).
  2. Back up `relay.db` + snapshot bytes to `/tmp/…bak-<timestamp>`.
  3. Rewrite envelopes in one txn; strip retired keys; re-validate through
     `payloadSchemaFor`.
  4. Append compensation envelopes (HLC now) — full replay must converge
     from the log alone.
  5. Snapshots embedding post-rewrite seq are STALE — patch their bytes
     (preferred) or delete (forces a ~35-min full replay).
  6. `relay.bumpRestoreEpoch` — **without it, `applied_envelope` id-skips the
     rewritten envelopes and clients silently keep the old derivation.**
  7. **Restart the sync server** (`docker compose restart notees-sync`) —
     ingest does not reapply to the running derived store.
  8. Verify in order: re-validate → fresh scratch replay with zero StoreError
     → live API serves the new state → sqlite peek.

## Script catalog

`scripts/migrate-*.mts` (9 scripts; `migrations.md` §4 has the per-script
table). All: **dry-run by default, `--apply` to write**, `--data-dir` +
`--workspace` flags (owner workspace default), run from repo root:

```sh
pnpm --filter @notees/server exec tsx ../../scripts/<name>.mts --apply
```

## Lockstep ordering

TS reference change → GTK + Flutter ports + tags → **then** the live
migration. Option-record additions may migrate before the clients land
(`migrations.md` §2).
