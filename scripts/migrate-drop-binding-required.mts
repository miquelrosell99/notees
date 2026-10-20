/**
 * Binding required/defaultValue rewrite (owner ruling 2026-10-20, the
 * property-definition surfaces batch): `required` RETIRES outright (its
 * only render effect — hiding the icon-button's "None" row — was mild
 * enforcement, contradicting the render-contract law) and `defaultValue`
 * MOVES from the class binding to the property schema (ONE global default
 * per property, the Logseq shape — a per-class default was configuration
 * creep the class page never needed). The live relay log still carries
 * envelopes that wrote the retired/moved keys on class.property.set, and
 * the latest snapshot embeds the pre-move derived state. Both must be
 * rewritten or every strict replay (client wipe + resync after the epoch
 * bump) fails on the retired keys — the no-backward-compatibility law.
 *
 *  1. IN-PLACE envelope rewrite: every class.property.set envelope carrying
 *     required/defaultValue gets those keys STRIPPED from its stored
 *     payload (the surviving keys — sequence/active — are untouched; a
 *     payload reduced to {classId, propertySchemaId} is a legal no-op
 *     patch). Seq/id/HLC untouched.
 *  2. APPENDED compensation: one propertySchema.update per affected schema
 *     carrying the schema-level default read from the CONVERGED
 *     server-derived state (the v24 binding rows still carry the values;
 *     across classes the max-causality row supplies the value — the live
 *     values are the owner's own, single-writer data, so the translation
 *     is exact). A stored JSON-null default is "no default" — no
 *     compensation for it. Full replays converge from the log alone.
 *  3. SNAPSHOT PATCH: the newest snapshot's bytes get the same move applied
 *     (add property_schema.default_value, write the values, then the
 *     v24→v25 store migration rebuilds class_property without the retired
 *     columns) so the server rehydrates snapshot+tail without a full
 *     replay. Backups first; verification opens the patched bytes.
 *  4. RESTORE-EPOCH BUMP: every client wipes and re-syncs from the rewritten
 *     log (the precedent) — without it, applied_envelope id-skips the
 *     rewritten envelopes and clients silently keep the old derivation.
 *
 * LOCKSTEP: the GTK/Flutter ports ship the same fixture + validator
 * convergence before this runs against a shared workspace (the fixture
 * gate law; the strict binding schema rejects the retired keys, old
 * clients accept their absence — the migration is what old clients need).
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies: every
 * rewritten envelope re-validates through the strict payload schema, and a
 * fresh scratch store replays the FULL log with zero StoreError throws with
 * the schema rows carrying the moved defaults.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-drop-binding-required.mts \
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
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a2";
const DEVICE = "migrate-drop-binding-required";
const CLIENT = "migrate-drop-binding-required";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const MOVED_KEYS = ["required", "defaultValue"] as const;

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

/** The retired/moved keys found in a class.property.set payload. */
function movedKeysOf(payload: Record<string, unknown>): string[] {
  return MOVED_KEYS.filter((key) => key in payload);
}

interface MovedDefault {
  schemaId: string;
  defaultValue: unknown;
}

/**
 * The converged per-schema default values, read from the server's derived
 * database (read-only WAL reader; the pre-move store still carries the
 * defaults on the binding rows — exactly the state a pre-move replay
 * produced). Row-LWW per (class, schema); across classes the max-causality
 * row supplies the schema-level value (last write wins). A stored JSON null
 * is "no default" — nothing to compensate.
 */
function readMovedDefaults(dataDir: string, workspaceId: string): MovedDefault[] {
  const file = join(dataDir, "derived", `${workspaceId}.db`);
  if (!existsSync(file)) {
    throw new Error(`derived store ${file} not found — is the sync server deployed with --data-dir ${dataDir}?`);
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT property_schema_id, default_value, hlc_physical, hlc_logical
         FROM class_property
         WHERE default_value IS NOT NULL`,
      )
      .all() as Array<{
      property_schema_id: string;
      default_value: string;
      hlc_physical: number;
      hlc_logical: number;
    }>;
    const winnerBySchema = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const current = winnerBySchema.get(row.property_schema_id);
      if (
        current === undefined ||
        row.hlc_physical > current.hlc_physical ||
        (row.hlc_physical === current.hlc_physical && row.hlc_logical > current.hlc_logical)
      ) {
        winnerBySchema.set(row.property_schema_id, row);
      }
    }
    const result: MovedDefault[] = [];
    for (const [schemaId, row] of winnerBySchema) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(row.default_value);
      } catch {
        parsed = null;
      }
      if (parsed === null) continue; // a JSON-null default IS "no default"
      result.push({ schemaId, defaultValue: parsed });
    }
    return result;
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
 * Apply the same move to a snapshot's bytes: add property_schema.default_value
 * (the snapshot is a serialized v24 derived store), write the per-schema
 * values, then open it through the store so the v24→v25 migration rebuilds
 * class_property without the retired columns. Returns the patched bytes.
 */
function patchSnapshot(snapshotFile: string, defaults: MovedDefault[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "notees-snapshot-patch-"));
  const tempDb = join(dir, "snapshot.db");
  try {
    copyFileSync(snapshotFile, tempDb);
    const raw = new Database(tempDb);
    try {
      const columns = (raw.prepare("PRAGMA table_info(property_schema)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      if (!columns.includes("default_value")) {
        raw.exec("ALTER TABLE property_schema ADD COLUMN default_value TEXT;");
      }
      const stmt = raw.prepare("UPDATE property_schema SET default_value = ? WHERE id = ?");
      for (const value of defaults) {
        stmt.run(JSON.stringify(value.defaultValue), value.schemaId);
      }
    } finally {
      raw.close();
    }
    // Store.open runs migrate() (v24 → v25: the class_property rebuild drops
    // required/default_value; the schema column guard no-ops — pre-added).
    const store = Store.open(betterSqlite3Backend(tempDb));
    try {
      const moved = store.database
        .prepare("SELECT COUNT(*) AS n FROM property_schema WHERE default_value IS NOT NULL")
        .get() as { n: number };
      if (moved.n === 0 && defaults.length > 0) {
        throw new Error("snapshot patch verification failed: no property_schema row carries the moved defaults");
      }
      const columns = (
        store.database.prepare("PRAGMA table_info(class_property)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const retired of ["required", "default_value"]) {
        if (columns.includes(retired)) {
          throw new Error(`snapshot patch verification failed: class_property still carries ${retired}`);
        }
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

    // 1. Plan: scan the log for class.property.set envelopes carrying retired keys.
    const affected = (
      relay.allEnvelopes(options.workspace) as Array<{
        seq: number;
        id: string;
        opType: string;
        payload: Record<string, unknown>;
      }>
    ).filter((env) => env.opType === "class.property.set" && movedKeysOf(env.payload).length > 0);

    // 2. The converged per-schema defaults (from the server's derived store).
    const defaults = readMovedDefaults(options.dataDir, options.workspace);

    console.log("\nplanned binding required/defaultValue rewrite:");
    if (affected.length === 0) {
      console.log("  no class.property.set envelope carries required/defaultValue — nothing to rewrite.");
    } else {
      console.log(`  ${affected.length} envelope(s) carry retired/moved key(s) — stripped in place:`);
      for (const env of affected.slice(0, 8)) {
        console.log(`    ${env.id.slice(0, 13)}…  ${movedKeysOf(env.payload).join(", ")}`);
      }
      if (affected.length > 8) console.log(`    … and ${affected.length - 8} more`);
    }
    if (defaults.length === 0) {
      console.log("  no binding row carries a default — no compensation update needed.");
    } else {
      console.log(`  ${defaults.length} schema(s) gain the moved default via appended propertySchema.update:`);
      for (const value of defaults.slice(0, 8)) {
        console.log(`    ${value.schemaId}  ${JSON.stringify(value.defaultValue)}`);
      }
      if (defaults.length > 8) console.log(`    … and ${defaults.length - 8} more`);
    }

    if (affected.length === 0 && defaults.length === 0) {
      console.log("\nnothing to rewrite — the log is already clean.");
      return;
    }

    // The compensation envelopes (appended after the log tail).
    const physical = Date.now();
    const compensation: Envelope[] = defaults.map((value, index) =>
      newEnvelope({
        workspaceId: options.workspace,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: index },
        affectedNodeIds: [],
        opType: "propertySchema.update",
        payload: { propertySchemaId: value.schemaId, defaultValue: value.defaultValue },
      }),
    );

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to perform the rewrite (backup → envelope rewrite + compensation → snapshot patch → epoch bump → verify).",
      );
      return;
    }

    // --- apply ----------------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-reqdef-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-reqdef-${stamp}`);

    // 3. Envelope rewrite, one transaction; then the compensation ingest.
    const rewrite = relay.db.transaction(() => {
      for (const env of affected) {
        const stripped = { ...env.payload };
        for (const key of movedKeysOf(env.payload)) delete stripped[key];
        relay.db
          .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND workspace_id = ?")
          .run(JSON.stringify(stripped), env.seq, options.workspace);
      }
    });
    rewrite();
    const { savedIds } = relay.ingest(compensation);
    if (savedIds.length !== compensation.length) {
      throw new Error(`ingest saved ${savedIds.length}/${compensation.length} compensation envelopes (duplicate ids?)`);
    }
    console.log(`rewrote ${affected.length} envelope(s) in place; appended ${compensation.length} compensation update(s).`);

    // 4. Snapshot patch (the newest snapshot embeds the pre-move derivation).
    if (snapshot !== null) {
      const snapshotFile = join(options.dataDir, "snapshots", `${snapshot.id}.db`);
      if (!existsSync(snapshotFile)) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
      copyFileSync(snapshotFile, `/tmp/snapshot-${snapshot.id}.bak-${stamp}`);
      const patched = patchSnapshot(snapshotFile, defaults);
      writeFileSync(snapshotFile, patched);
      console.log(`patched snapshot ${snapshot.id} (bytes backup at /tmp/snapshot-${snapshot.id}.bak-${stamp}).`);
    } else {
      console.log("no snapshot — the next hydration replays the full log (slow path, correct by construction).");
    }

    // 5. Epoch bump: every client wipes + resyncs from the rewritten log.
    const epoch = relay.bumpRestoreEpoch(options.workspace);
    console.log(`restore_epoch bumped to ${epoch}.`);

    // 6. Verify.
    verify(relay, options.workspace, defaults);
    console.log("done.");
  } finally {
    relay.close();
  }
}

/**
 * Post-rewrite verification:
 *  1. every class.property.set envelope in the log validates through the
 *     strict payload schema (the retired keys are gone everywhere),
 *  2. a fresh scratch store replays the FULL log (zero StoreError throws) and
 *     the schema rows carry the moved defaults; the binding table is clean.
 */
function verify(relay: RelayStorage, workspaceId: string, defaults: MovedDefault[]): void {
  const all = relay.allEnvelopes(workspaceId) as Array<{
    opType: string;
    payload: Record<string, unknown>;
  }>;
  const schema = payloadSchemaFor("class.property.set")!;
  let count = 0;
  for (const env of all) {
    if (env.opType !== "class.property.set") continue;
    const moved = movedKeysOf(env.payload);
    if (moved.length > 0) {
      throw new Error(`verification failed: a class.property.set payload still carries ${moved.join(",")}`);
    }
    if (!schema.safeParse(env.payload).success) {
      throw new Error("verification failed: a rewritten class.property.set payload no longer validates");
    }
    count++;
  }
  console.log(`verify: all ${count} class.property.set envelopes validate clean (retired keys gone).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    for (const value of defaults) {
      const row = store.database
        .prepare("SELECT default_value FROM property_schema WHERE id = ?")
        .get(value.schemaId) as { default_value: string | null } | undefined;
      if (row === undefined) throw new Error(`verification failed: schema ${value.schemaId} missing after replay`);
      const parsed: unknown = row.default_value === null ? null : JSON.parse(row.default_value);
      if (JSON.stringify(parsed) !== JSON.stringify(value.defaultValue)) {
        throw new Error(
          `verification failed: schema ${value.schemaId} default ${JSON.stringify(parsed)} != ${JSON.stringify(value.defaultValue)}`,
        );
      }
    }
    const bindingColumns = (
      store.database.prepare("PRAGMA table_info(class_property)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const retired of ["required", "default_value"]) {
      if (bindingColumns.includes(retired)) {
        throw new Error(`verification failed: class_property still carries the retired ${retired} column`);
      }
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: full replay clean; ${defaults.length} schema row(s) carry the moved defaults; the binding table is clean.`,
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
