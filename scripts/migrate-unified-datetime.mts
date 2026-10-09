/**
 * Unified datetime rewrite (owner 2026-10-09): the two date property types
 * (`date`, `date_range`) retire into one `datetime` type — a value is a point
 * `{nodeId, time?}` or a range `{start: slot|null, end: slot|null}` anchored
 * to the year/month/day node chain; full-day is the absence of `time` and is
 * the default for every new value. The strict `propertySchema.create` type
 * enum rejects the retired values outright (the no-backward-compatibility
 * law), so the live relay log still carrying them must be rewritten in place
 * or every strict replay (client wipe + resync after the epoch bump) fails.
 *
 * LOCKSTEP LAW: the TS reference ships first; GTK + Flutter ports must accept
 * `datetime` (and reject the retired types) BEFORE this migration runs
 * against a live relay — a pre-batch client rejects the rewritten envelopes
 * and its sync stalls until updated. Run only after the client tags.
 *
 * The migrations.md §B sequence this script implements:
 *  1. Plan from authority: scan the relay log for `propertySchema.create`
 *     envelopes whose payload.type is `date`/`date_range`; read the authored
 *     value counts from the server's derived DB (read-only WAL) — a scratch
 *     replay of the ORIGINAL log is impossible by construction (the strict
 *     store rejects the retired types — that is why this migration exists).
 *  2. Backup: relay.db (and the snapshot bytes being patched) to
 *     /tmp/…bak-<timestamp> before anything.
 *  3. IN-PLACE envelope rewrite, one transaction: every planned envelope's
 *     stored payload gets `type: "datetime"` (seq/id/HLC untouched; every
 *     other payload key — `datePrecision`, `dateQualified`, name, options —
 *     untouched). NO compensation envelopes: values ride untouched (every
 *     legacy shape is a legal member of the new union — a `{nodeId}` point
 *     and a `{start, end}` bare-ref range), so full replays converge from the
 *     log alone. This migration writes NO new envelopes, hence no
 *     ACTOR/DEVICE/CLIENT constants.
 *  4. Snapshot patch: the newest snapshot is stale when its up_to_seq
 *     post-dates the first rewritten envelope — its bytes get the same move
 *     (open, rewrite the embedded property_schema rows' type, `Store.open`
 *     to run the schema migration, verify, replace). Backups first.
 *  5. Bump `restore_epoch`: without it, `applied_envelope` id-skips the
 *     rewritten envelopes on every replica that already saw the old versions
 *     and clients silently keep the old derivation.
 *  6. RESTART the sync server: `RelayStorage` writes the log but does NOT
 *     apply to the server's running derived store — the container needs one
 *     restart to rehydrate snapshot+tail (migrations.md §B step 7).
 *  7. Verify, in the runbook's order: rewritten envelopes re-validate through
 *     envelopeSchema + payloadSchemaFor → fresh scratch replay of the FULL
 *     log with zero StoreError throws → every property_schema row is
 *     `datetime` (no `date`/`date_range` remains) → authored values survived
 *     (counts per rewritten schema before/after match).
 *
 * Idempotent: a second run finds no retired types and plans nothing.
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-unified-datetime.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store) —
// resolve it from the store package, the same binary the server runs.
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import {
  envelopeSchema,
  payloadSchemaFor,
} from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const RETIRED_TYPES = ["date", "date_range"] as const;

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

interface RewrittenEnvelope {
  seq: number;
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/** The retired type found in a propertySchema.create payload, if any. */
function retiredTypeOf(opType: string, payload: Record<string, unknown>): string | null {
  if (opType !== "propertySchema.create") return null;
  const type = payload.type;
  return typeof type === "string" && (RETIRED_TYPES as readonly string[]).includes(type) ? type : null;
}

/**
 * The authored per-schema value counts for the retired-typed schemas, read
 * from the server's derived database (read-only WAL; the converged authority
 * the migration plans from — the migrate-binding-flags precedent). The
 * original log cannot replay through the strict store, so the derived DB is
 * the only pre-rewrite read of the values.
 */
function readAuthoredCounts(
  dataDir: string,
  workspaceId: string,
  schemaIds: string[],
): Map<string, number> {
  const file = join(dataDir, "derived", `${workspaceId}.db`);
  if (!existsSync(file)) {
    throw new Error(`derived store ${file} not found — is the sync server deployed with --data-dir ${dataDir}?`);
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const counts = new Map<string, number>();
    for (const schemaId of schemaIds) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM property_value WHERE property_schema_id = ?")
        .get(schemaId) as { n: number };
      counts.set(schemaId, row.n);
    }
    return counts;
  } finally {
    db.close();
  }
}

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

/**
 * Apply the same rewrite to a snapshot's bytes: the snapshot is a serialized
 * derived store whose property_schema rows still carry the retired types —
 * rewrite them to `datetime` (the values ride untouched inside the
 * property_value rows), then open it through the store so migrate() runs and
 * the rows verify. Returns the patched bytes.
 */
function patchSnapshot(snapshotFile: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "notees-datetime-snapshot-patch-"));
  const tempDb = join(dir, "snapshot.db");
  try {
    copyFileSync(snapshotFile, tempDb);
    const raw = new Database(tempDb);
    try {
      const result = raw
        .prepare("UPDATE property_schema SET type = 'datetime' WHERE type IN ('date', 'date_range')")
        .run();
      if (result.changes === 0) {
        throw new Error("snapshot patch made no changes — no property_schema row carries a retired type?");
      }
    } finally {
      raw.close();
    }
    // Store.open runs migrate() on the snapshot bytes; verify no retired type
    // survives and the rows re-derive clean.
    const store = Store.open(betterSqlite3Backend(tempDb));
    try {
      const remaining = (
        store.database
          .prepare("SELECT COUNT(*) AS n FROM property_schema WHERE type IN ('date', 'date_range')")
          .get() as { n: number }
      ).n;
      if (remaining > 0) {
        throw new Error("snapshot patch verification failed: retired property_schema types survive");
      }
    } finally {
      store.close();
    }
    return readFileSync(tempDb);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

    // 1. Plan: scan the stored log rows for propertySchema.create envelopes
    //    carrying a retired type (raw rows — the rewrite targets seqs).
    const rows = relay.db
      .prepare(
        "SELECT seq, id, payload FROM envelope WHERE workspace_id = ? AND op_type = 'propertySchema.create' ORDER BY seq ASC",
      )
      .all(options.workspace) as Array<{ seq: number; id: string; payload: string }>;
    const affected: RewrittenEnvelope[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const retired = retiredTypeOf("propertySchema.create", payload);
      if (retired !== null) affected.push({ seq: row.seq, id: row.id, type: retired, payload });
    }

    console.log("\nplanned unified-datetime rewrite:");
    if (affected.length === 0) {
      console.log("  no propertySchema.create envelope carries a retired type — nothing to rewrite.");
    } else {
      const firstSeq = Math.min(...affected.map((env) => env.seq));
      console.log(
        `  ${affected.length} propertySchema.create envelope(s) carry a retired type — rewritten to "datetime" in place (seq/id/HLC untouched):`,
      );
      for (const env of affected.slice(0, 8)) {
        console.log(`    seq ${env.seq}  ${env.id.slice(0, 13)}…  ${env.type} → datetime`);
      }
      if (affected.length > 8) console.log(`    … and ${affected.length - 8} more`);
      console.log(
        `  snapshot ${snapshot?.id ?? "(none)"} ${snapshot !== null && snapshotSeq >= firstSeq ? `is STALE (up_to_seq ${snapshotSeq} >= first rewritten seq ${firstSeq}) — bytes patched with the same rewrite` : "predates the first rewritten envelope — not stale"}.`,
      );
    }

    // The authored per-schema value counts (from the server's derived store),
    // taken BEFORE the rewrite so verification can prove value survival.
    const schemaIds = affected.map((env) => String(env.payload.propertySchemaId));
    const countsBefore =
      affected.length === 0 ? new Map<string, number>() : readAuthoredCounts(options.dataDir, options.workspace, schemaIds);
    const totalBefore = [...countsBefore.values()].reduce((sum, n) => sum + n, 0);
    console.log(`  ${totalBefore} authored value(s) on the rewritten schemas (count survives the rewrite).`);

    if (affected.length === 0) {
      console.log("\nnothing to rewrite — the log is already clean.");
      return;
    }

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to perform the rewrite (backup → envelope rewrite → snapshot patch → epoch bump → verify).",
      );
      return;
    }

    // --- apply ----------------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-datetime-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-datetime-${stamp}`);

    // 2. Envelope rewrite, one transaction (seq/id/HLC untouched; only
    //    payload.type changes).
    const rewrite = relay.db.transaction(() => {
      for (const env of affected) {
        const rewritten = { ...env.payload, type: "datetime" };
        relay.db
          .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND workspace_id = ?")
          .run(JSON.stringify(rewritten), env.seq, options.workspace);
      }
    });
    rewrite();
    console.log(`rewrote ${affected.length} envelope(s) in place; no compensation envelopes (values ride untouched).`);

    // 3. Snapshot patch (only when the snapshot post-dates the first rewritten
    //    envelope — an older snapshot embeds none of them).
    const firstSeq = Math.min(...affected.map((env) => env.seq));
    if (snapshot !== null && snapshotSeq >= firstSeq) {
      const snapshotFile = join(options.dataDir, "snapshots", `${snapshot.id}.db`);
      if (!existsSync(snapshotFile)) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
      copyFileSync(snapshotFile, `/tmp/snapshot-${snapshot.id}.bak-${stamp}`);
      const patched = patchSnapshot(snapshotFile);
      writeFileSync(snapshotFile, patched);
      console.log(`patched snapshot ${snapshot.id} (bytes backup at /tmp/snapshot-${snapshot.id}.bak-${stamp}).`);
    } else if (snapshot !== null) {
      console.log(`snapshot ${snapshot.id} predates the first rewritten envelope — left untouched.`);
    } else {
      console.log("no snapshot — the next hydration replays the full log (slow path, correct by construction).");
    }

    // 4. Epoch bump: every client wipes + resyncs from the rewritten log.
    const epoch = relay.bumpRestoreEpoch(options.workspace);
    console.log(`restore_epoch bumped to ${epoch}.`);

    // 5. Verify (migrations.md §B order).
    verify(relay, options.workspace, countsBefore);
    console.log("done. RESTART the sync server so its running derived store rehydrates from the rewritten log.");
  } finally {
    relay.close();
  }
}

/**
 * Post-rewrite verification (migrations.md §B step 8, in order):
 *  1. every propertySchema.create envelope in the log re-validates through
 *     envelopeSchema + the strict payload schema (no retired type remains),
 *  2. a fresh scratch store replays the FULL log (snapshot + tail) with zero
 *     StoreError throws,
 *  3. every property_schema row in the replayed store is `datetime`,
 *  4. the authored values survived — per-schema counts match the pre-rewrite
 *     derived-DB read.
 */
function verify(relay: RelayStorage, workspaceId: string, countsBefore: Map<string, number>): void {
  const all = relay.allEnvelopes(workspaceId);
  const schema = payloadSchemaFor("propertySchema.create")!;
  let createCount = 0;
  for (const env of all) {
    if (!envelopeSchema.safeParse(env).success) {
      throw new Error(`verification failed: envelope ${env.id} no longer validates through envelopeSchema`);
    }
    if (env.opType !== "propertySchema.create") continue;
    if (retiredTypeOf(env.opType, env.payload as Record<string, unknown>) !== null) {
      throw new Error("verification failed: a propertySchema.create payload still carries a retired type");
    }
    if (!schema.safeParse(env.payload).success) {
      throw new Error("verification failed: a rewritten propertySchema.create payload no longer validates");
    }
    createCount++;
  }
  console.log(`verify: all ${createCount} propertySchema.create envelopes validate clean (retired types gone).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    const retired = (
      store.database
        .prepare("SELECT COUNT(*) AS n FROM property_schema WHERE type IN ('date', 'date_range')")
        .get() as { n: number }
    ).n;
    if (retired > 0) {
      throw new Error(`verification failed: ${retired} property_schema row(s) still carry a retired type`);
    }
    const datetime = (
      store.database.prepare("SELECT COUNT(*) AS n FROM property_schema WHERE type = 'datetime'").get() as {
        n: number;
      }
    ).n;
    let totalAfter = 0;
    for (const [schemaId, before] of countsBefore) {
      const row = store.database
        .prepare("SELECT COUNT(*) AS n FROM property_value WHERE property_schema_id = ?")
        .get(schemaId) as { n: number };
      if (row.n !== before) {
        throw new Error(
          `verification failed: schema ${schemaId} carried ${before} authored value(s) before the rewrite, ${row.n} after`,
        );
      }
      totalAfter += row.n;
    }
    console.log(
      `verify: full replay clean; every property_schema row is datetime (${datetime} row(s)); ${totalAfter} authored value(s) survived across ${countsBefore.size} rewritten schema(s).`,
    );
  } finally {
    store.close();
  }
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
