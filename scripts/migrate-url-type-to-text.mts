/**
 * Url property-type retirement: the dedicated `url` property type retires
 * into `text` — the seeded `url` property (…0000-000000000024, source
 * family, pinned) SURVIVES by name/uuid as a `text`-typed schema; the strict
 * `propertySchema.create` type enum rejects the retired value outright (the
 * no-backward-compatibility law), so a live relay log still carrying it must
 * be rewritten in place or every strict replay (client wipe + resync after
 * the epoch bump) fails. Legacy url VALUES are plain strings — a legal text
 * value — so no compensation envelopes and no value rewrite: the first edit
 * in a client mints a carrier block (ordinary object.create + property.set).
 *
 * LOCKSTEP LAW: the TS reference ships first; GTK + Flutter ports must accept
 * the retirement (reject `url`, seed the url property as `text`) BEFORE this
 * migration runs against a live relay — a pre-batch client rejects the
 * rewritten envelopes AND re-issues the seed schema with the retired type,
 * so its sync stalls until updated. Run only after the client tags.
 *
 * The migrations.md Path B shape this script implements:
 *  1. Plan from authority: scan the relay log for `propertySchema.create`
 *     envelopes whose payload.type is `url`; read the authored value counts
 *     from the server's derived DB (read-only WAL) — a scratch replay of the
 *     ORIGINAL log is impossible by construction (the strict store rejects
 *     the retired type — that is why this migration exists).
 *  2. Backup: relay.db (and the snapshot bytes being patched) to
 *     /tmp/…bak-<timestamp> before anything.
 *  3. IN-PLACE envelope rewrite, one transaction: every planned envelope's
 *     stored payload gets `type: "text"` (seq/id/HLC untouched; every other
 *     payload key — name, multi, options, scopeClassIds — untouched). NO
 *     compensation envelopes: existing string values stay legal under text,
 *     so full replays converge from the log alone. This migration writes NO
 *     new envelopes, hence no ACTOR/DEVICE/CLIENT constants.
 *  4. Snapshot patch: the newest snapshot is stale when its up_to_seq
 *     post-dates the first rewritten envelope — its bytes get the same move
 *     (open, rewrite the embedded property_schema rows' type, `Store.open`
 *     to run the schema migration, verify, replace). Backups first.
 *  5. Bump `restore_epoch`: without it, `applied_envelope` id-skips the
 *     rewritten envelopes on every replica that already saw the old versions
 *     and clients silently keep the old derivation.
 *  6. RESTART the sync server: `RelayStorage` writes the log but does NOT
 *     apply to the server's running derived store — the container needs one
 *     restart to rehydrate snapshot+tail (migrations.md step 7).
 *  7. Verify, in the runbook's order: rewritten envelopes re-validate through
 *     envelopeSchema + payloadSchemaFor → fresh scratch replay of the FULL
 *     log with zero StoreError throws → no property_schema row carries `url`
 *     → the seeded url schema row is `text` → authored values survived
 *     (counts per rewritten schema before/after match).
 *
 * Idempotent: a second run finds no retired types and plans nothing.
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-url-type-to-text.mts \
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
const RETIRED_TYPE = "url";
const TARGET_TYPE = "text";
/** The seeded url property — survives the retirement as a text schema. */
const SEEDED_URL_ID = "00000000-0000-0000-0000-000000000024";

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
  payload: Record<string, unknown>;
}

/** The retired type found in a propertySchema.create payload, if any. */
function retiredTypeOf(opType: string, payload: Record<string, unknown>): string | null {
  if (opType !== "propertySchema.create") return null;
  return payload.type === RETIRED_TYPE ? RETIRED_TYPE : null;
}

/**
 * The authored per-schema value counts for the rewritten schemas, read from
 * the server's derived database (read-only WAL; the converged authority the
 * migration plans from — the migrate-unified-datetime precedent). The
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
 * derived store whose property_schema rows still carry the retired type —
 * rewrite them to `text` (the values ride untouched inside the
 * property_value rows — plain strings are legal text values), then open it
 * through the store so migrate() runs and the rows verify. Returns the
 * patched bytes.
 */
function patchSnapshot(snapshotFile: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "notees-url-type-snapshot-patch-"));
  const tempDb = join(dir, "snapshot.db");
  try {
    copyFileSync(snapshotFile, tempDb);
    const raw = new Database(tempDb);
    try {
      const result = raw
        .prepare("UPDATE property_schema SET type = 'text' WHERE type = 'url'")
        .run();
      if (result.changes === 0) {
        throw new Error("snapshot patch made no changes — no property_schema row carries the retired type?");
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
          .prepare("SELECT COUNT(*) AS n FROM property_schema WHERE type = 'url'")
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
    //    carrying the retired type (raw rows — the rewrite targets seqs).
    const rows = relay.db
      .prepare(
        "SELECT seq, id, payload FROM envelope WHERE workspace_id = ? AND op_type = 'propertySchema.create' ORDER BY seq ASC",
      )
      .all(options.workspace) as Array<{ seq: number; id: string; payload: string }>;
    const affected: RewrittenEnvelope[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (retiredTypeOf("propertySchema.create", payload) !== null) {
        affected.push({ seq: row.seq, id: row.id, payload });
      }
    }

    console.log("\nplanned url→text property-type rewrite:");
    if (affected.length === 0) {
      console.log("  no propertySchema.create envelope carries the retired type — nothing to rewrite.");
    } else {
      const firstSeq = Math.min(...affected.map((env) => env.seq));
      console.log(
        `  ${affected.length} propertySchema.create envelope(s) carry the retired type — rewritten to "text" in place (seq/id/HLC untouched):`,
      );
      for (const env of affected.slice(0, 8)) {
        console.log(`    seq ${env.seq}  ${env.id.slice(0, 13)}…  ${env.payload.name ?? ""} (url → text)`);
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
    console.log(`  ${totalBefore} authored value(s) on the rewritten schemas (counts survive the rewrite — string values are legal text values).`);

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
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-url-type-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-url-type-${stamp}`);

    // 2. Envelope rewrite, one transaction (seq/id/HLC untouched; only
    //    payload.type changes).
    const rewrite = relay.db.transaction(() => {
      for (const env of affected) {
        const rewritten = { ...env.payload, type: TARGET_TYPE };
        relay.db
          .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND workspace_id = ?")
          .run(JSON.stringify(rewritten), env.seq, options.workspace);
      }
    });
    rewrite();
    console.log(`rewrote ${affected.length} envelope(s) in place; no compensation envelopes (string values ride untouched).`);

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

    // 5. Verify (migrations.md order).
    verify(relay, options.workspace, countsBefore);
    console.log("done. RESTART the sync server so its running derived store rehydrates from the rewritten log.");
  } finally {
    relay.close();
  }
}

/**
 * Post-rewrite verification, in the runbook's order:
 *  1. every propertySchema.create envelope in the log re-validates through
 *     envelopeSchema + the strict payload schema (no retired type remains),
 *  2. a fresh scratch store replays the FULL log (snapshot + tail) with zero
 *     StoreError throws,
 *  3. no property_schema row in the replayed store carries `url`, and the
 *     seeded url schema row (…0000-000000000024) is `text`,
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
      throw new Error("verification failed: a propertySchema.create payload still carries the retired type");
    }
    if (!schema.safeParse(env.payload).success) {
      throw new Error("verification failed: a rewritten propertySchema.create payload no longer validates");
    }
    createCount++;
  }
  console.log(`verify: all ${createCount} propertySchema.create envelopes validate clean (the retired type is gone).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    const retired = (
      store.database
        .prepare("SELECT COUNT(*) AS n FROM property_schema WHERE type = 'url'")
        .get() as { n: number }
    ).n;
    if (retired > 0) {
      throw new Error(`verification failed: ${retired} property_schema row(s) still carry the retired type`);
    }
    const seeded = store.database
      .prepare("SELECT type FROM property_schema WHERE id = ?")
      .get(SEEDED_URL_ID) as { type: string } | undefined;
    if (seeded === undefined) {
      console.log("verify: the seeded url schema has no row in this workspace (never authored — nothing to assert).");
    } else if (seeded.type !== TARGET_TYPE) {
      throw new Error(`verification failed: the seeded url schema row is "${seeded.type}", expected "${TARGET_TYPE}"`);
    }
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
      `verify: full replay clean; no property_schema row carries "url"${seeded !== undefined ? "; the seeded url schema is text" : ""}; ${totalAfter} authored value(s) survived across ${countsBefore.size} rewritten schema(s).`,
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
