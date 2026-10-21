/**
 * Schema-level readonly retirement rewrite (owner ruling 2026-10-21): the
 * `readonly` render contract RETIRES from `propertySchema.create/update` —
 * it was never user configuration (an enumeration of the seeds — seeds.ts
 * and the GTK/Flutter seed manifests — finds ZERO system properties that
 * ever carried the flag, and no live workspace row carries it), so clients
 * DERIVE readonly-ness from the system property list
 * (`isReadonlyProperty`, packages/domain) instead of storing it — the
 * binding-`sequence` philosophy: store nothing that is a fact about system
 * seeds. `hideWhenEmpty` STAYS a user-facing render contract.
 *
 * The strict payload schemas reject the retired key outright (the
 * no-backward-compatibility law), so every stored envelope that wrote it
 * must be rewritten or every strict replay (client wipe + resync after the
 * epoch bump) fails on the retired key.
 *
 *  1. IN-PLACE envelope rewrite: every propertySchema.create/update
 *     envelope carrying `readonly` gets the key STRIPPED from its stored
 *     payload (the surviving keys are untouched; a payload reduced to
 *     {propertySchemaId} is a legal no-op patch). Seq/id/HLC untouched.
 *  2. NO snapshot patch: the snapshot embeds the pre-retire DERIVED shape
 *     (the property_schema table still carries the readonly column), but
 *     the store migration v26→v27 rebuilds that table without the column
 *     on open — every hydration path (server, web worker, CLI) opens
 *     through Store.open/migrate, so the bytes migrate themselves. There
 *     is no data to backfill (derived, not stored). The verify step below
 *     opens the patched snapshot through the store to prove the migration
 *     lands clean.
 *  3. RESTORE-EPOCH BUMP: every client wipes and re-syncs from the
 *     rewritten log (the precedent) — without it, applied_envelope
 *     id-skips the rewritten envelopes and clients silently keep the old
 *     derivation.
 *
 * LOCKSTEP: the GTK/Flutter ports ship the same strict-validator
 * convergence before this runs against a shared workspace (the fixture
 * gate law; old clients accept the key's ABSENCE, so the rewrite itself is
 * what unblocks strict replay everywhere).
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies: every
 * rewritten envelope re-validates through the strict payload schema, a
 * fresh scratch store replays the FULL log with zero StoreError throws, and
 * the scratch property_schema table carries no readonly column.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-drop-schema-readonly.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store) —
// resolve it from the store package, the same binary the server runs.
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import {
  payloadSchemaFor,
} from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const DEVICE = "migrate-drop-schema-readonly";
const CLIENT = "migrate-drop-schema-readonly";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const RETIRED_KEY = "readonly" as const;
const OP_TYPES = ["propertySchema.create", "propertySchema.update"] as const;

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    workspace: value("--workspace") ?? DEFAULT_WORKSPACE,
    apply: argv.includes("--apply"),
  };
}

// --- helpers ------------------------------------------------------------------

/** Restore snapshot+tail into a scratch store (the sync-server hydration shape). */
function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
  const store = Store.open(betterSqlite3Backend(":memory:"));
  const snapshot = relay.latestSnapshot(workspaceId);
  let afterSeq = 0;
  if (snapshot !== null) {
    const bytes = relay.readSnapshotData(snapshot.id);
    if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
    store.restore(new Uint8Array(bytes));
    afterSeq = snapshot.up_to_seq;
  }
  let cursor = afterSeq;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const snapshot = relay.latestSnapshot(options.workspace);
    const snapshotSeq = snapshot?.up_to_seq ?? 0;
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
    );

    // 1. Plan: scan the log for propertySchema.create/update envelopes
    //    carrying the retired key. RAW rows (seq included — storedToEnvelope
    //    drops seq: it is not part of the wire Envelope, and the rewrite
    //    addresses rows by it; the mapped-envelope shape leaves it undefined
    //    and the UPDATE matches nothing).
    const affected = (
      relay.db
        .prepare("SELECT seq, id, op_type, payload FROM envelope WHERE workspace_id = ?")
        .all(options.workspace) as Array<{ seq: number; id: string; op_type: string; payload: string }>
    )
      .map((row) => ({
        seq: row.seq,
        id: row.id,
        opType: row.op_type,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }))
      .filter(
        (env) =>
          (OP_TYPES as readonly string[]).includes(env.opType) && RETIRED_KEY in env.payload,
      );

    console.log("\nplanned schema-readonly rewrite:");
    if (affected.length === 0) {
      console.log("  no propertySchema.create/update envelope carries readonly — nothing to rewrite.");
    } else {
      console.log(`  ${affected.length} envelope(s) carry the retired key — stripped in place:`);
      for (const env of affected.slice(0, 8)) {
        console.log(`    ${env.id.slice(0, 13)}…  ${env.opType}  ${JSON.stringify(env.payload)}`);
      }
      if (affected.length > 8) console.log(`    … and ${affected.length - 8} more`);
    }

    if (affected.length === 0) {
      console.log("\nnothing to rewrite — the log is already clean.");
      return;
    }

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to perform the rewrite (backup → envelope rewrite → epoch bump → verify).",
      );
      return;
    }

    // --- apply ----------------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-ro-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-ro-${stamp}`);

    // 2. Envelope rewrite, one transaction.
    const rewrite = relay.db.transaction(() => {
      for (const env of affected) {
        const stripped = { ...env.payload };
        delete stripped[RETIRED_KEY];
        const info = relay.db
          .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND workspace_id = ?")
          .run(JSON.stringify(stripped), env.seq, options.workspace);
        if (info.changes !== 1) {
          throw new Error(`envelope rewrite matched ${info.changes} rows at seq ${env.seq} — aborting`);
        }
      }
    });
    rewrite();
    console.log(`rewrote ${affected.length} envelope(s) in place.`);

    // 3. No snapshot patch: the v26→v27 store migration rebuilds
    //    property_schema without the readonly column on open (there is no
    //    data to backfill — derived, not stored). Every hydration path opens
    //    through Store.open.

    // 4. Epoch bump: every client wipes + resyncs from the rewritten log.
    const epoch = relay.bumpRestoreEpoch(options.workspace);
    console.log(`restore_epoch bumped to ${epoch}.`);

    // 5. Verify.
    verify(relay, options.workspace);
    console.log("done.");
  } finally {
    relay.close();
  }
}

/**
 * Post-rewrite verification:
 *  1. every propertySchema.create/update envelope in the log validates
 *     through the strict payload schema (the retired key is gone everywhere),
 *  2. a fresh scratch store replays the FULL log (snapshot + tail) with zero
 *     StoreError throws — the snapshot bytes migrate v26→v27 on open — and
 *     the property_schema table carries no readonly column.
 */
function verify(relay: RelayStorage, workspaceId: string): void {
  const all = relay.allEnvelopes(workspaceId) as Array<{
    opType: string;
    payload: Record<string, unknown>;
  }>;
  let count = 0;
  for (const env of all) {
    if (!(OP_TYPES as readonly string[]).includes(env.opType)) continue;
    if (RETIRED_KEY in env.payload) {
      throw new Error(`verification failed: a ${env.opType} payload still carries readonly`);
    }
    if (!payloadSchemaFor(env.opType)!.safeParse(env.payload).success) {
      throw new Error(`verification failed: a rewritten ${env.opType} payload no longer validates`);
    }
    count++;
  }
  console.log(`verify: all ${count} propertySchema.create/update envelopes validate clean (readonly gone).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    const columns = (
      store.database.prepare("PRAGMA table_info(property_schema)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (columns.includes(RETIRED_KEY)) {
      throw new Error("verification failed: property_schema still carries the retired readonly column");
    }
  } finally {
    store.close();
  }
  console.log(
    "verify: full replay clean (snapshot + tail through the v26→v27 migration); property_schema carries no readonly column.",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
