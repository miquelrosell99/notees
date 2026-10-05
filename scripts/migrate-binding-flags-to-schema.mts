/**
 * §34.90 binding-flags rewrite (owner review 2026-10-05, same day as the
 * §34.89/§34.90 releases): the render contracts moved from the class binding
 * to the property schema — readonly, hideWhenEmpty, display are PROPERTY-level
 * (class.property.set now strict-rejects them); required stays per-class.
 * The live relay log still carries envelopes that wrote the moved keys on
 * class.property.set (42 hideWhenEmpty + 1 display across ~26 schemas), and
 * the latest snapshot embeds the pre-move derived state. Both must be
 * rewritten or every strict replay (client wipe + resync after the epoch
 * bump) fails on the retired keys — the no-backward-compatibility law.
 *
 *  1. IN-PLACE envelope rewrite: every class.property.set envelope carrying
 *     hideWhenEmpty/readonly/display gets those keys STRIPPED from its stored
 *     payload (the surviving keys — sequence/required/defaultValue/active —
 *     are untouched; a payload reduced to {classId, propertySchemaId} is a
 *     legal no-op patch). Seq/id/HLC untouched.
 *  2. APPENDED compensation: one propertySchema.update per affected schema
 *     carrying the schema-level values read from the CONVERGED server-derived
 *     state (the v3.3.0 store still carries them on the binding rows; row-LWW
 *     makes a per-schema last-write translation equivalent to translating
 *     every historical write in order — and the live values are uniform).
 *     Full replays converge from the log alone.
 *  3. SNAPSHOT PATCH: the newest snapshot's bytes get the same move applied
 *     (add the schema columns, write the values, then the v13→v14 store
 *     migration rebuilds class_property) so the server rehydrates
 *     snapshot+tail without the ~35-minute full replay the owed-work register
 *     documents. Backups first; verification opens the patched bytes.
 *  4. RESTORE-EPOCH BUMP: every client wipes and re-syncs from the rewritten
 *     log (the §34.11 precedent) — without it, applied_envelope id-skips the
 *     rewritten envelopes and clients silently keep the old derivation.
 *
 * The moved values are read from the server's derived database (read-only;
 * the converged authority the migration plans from, the migrate-system-names
 * precedent). Run the styles migration FIRST if it has not run — it is what
 * set display=bullet on the task Status binding.
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies: every
 * rewritten envelope re-validates through the strict payload schema, and a
 * fresh scratch store replays the FULL log with zero StoreError throws with
 * the schema rows carrying the moved values.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-binding-flags-to-schema.mts \
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

const ACTOR = "01920000-0000-7000-8000-0000000000a1";
const DEVICE = "migrate-binding-flags-to-schema";
const CLIENT = "migrate-binding-flags-to-schema";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const MOVED_KEYS = ["hideWhenEmpty", "readonly", "display"] as const;

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

/** The moved keys found in a class.property.set payload. */
function movedKeysOf(payload: Record<string, unknown>): string[] {
  return MOVED_KEYS.filter((key) => key in payload);
}

interface MovedValues {
  schemaId: string;
  hideWhenEmpty?: boolean;
  readonly?: boolean;
  display?: string;
}

/**
 * The converged per-schema moved values, read from the server's derived
 * database (read-only WAL reader; the v3.3.0 store still carries the flags on
 * the binding rows — exactly the state a pre-move replay produced).
 */
function readMovedValues(dataDir: string, workspaceId: string): MovedValues[] {
  const file = join(dataDir, "derived", `${workspaceId}.db`);
  if (!existsSync(file)) {
    throw new Error(`derived store ${file} not found — is the sync server deployed with --data-dir ${dataDir}?`);
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT property_schema_id, hide_when_empty, readonly, display,
                hlc_physical, hlc_logical
         FROM class_property
         WHERE hide_when_empty IS NOT NULL OR readonly IS NOT NULL OR display IS NOT NULL`,
      )
      .all() as Array<{
      property_schema_id: string;
      hide_when_empty: number | null;
      readonly: number | null;
      display: string | null;
      hlc_physical: number;
      hlc_logical: number;
    }>;
    // Row-LWW per (class, schema); across classes the max-causality row
    // supplies the schema-level value (last write wins; the live values are
    // uniform hideWhenEmpty=false, so the choice is moot there).
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
    const result: MovedValues[] = [];
    for (const [schemaId, row] of winnerBySchema) {
      const value: MovedValues = { schemaId };
      if (row.hide_when_empty !== null) value.hideWhenEmpty = row.hide_when_empty === 1;
      if (row.readonly !== null) value.readonly = row.readonly === 1;
      if (row.display !== null) value.display = row.display;
      result.push(value);
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
 * Apply the same move to a snapshot's bytes: add the property_schema columns
 * (the snapshot is a serialized v13 derived store), write the per-schema
 * values, then open it through the store so the v13→v14 migration rebuilds
 * class_property. Returns the patched bytes.
 */
function patchSnapshot(snapshotFile: string, values: MovedValues[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "notees-snapshot-patch-"));
  const tempDb = join(dir, "snapshot.db");
  try {
    copyFileSync(snapshotFile, tempDb);
    const raw = new Database(tempDb);
    try {
      const columns = (raw.prepare("PRAGMA table_info(property_schema)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      if (!columns.includes("display")) {
        raw.exec(`
          ALTER TABLE property_schema ADD COLUMN display TEXT;
          ALTER TABLE property_schema ADD COLUMN readonly INTEGER;
          ALTER TABLE property_schema ADD COLUMN hide_when_empty INTEGER;
        `);
      }
      for (const value of values) {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (value.hideWhenEmpty !== undefined) {
          sets.push("hide_when_empty = ?");
          params.push(value.hideWhenEmpty ? 1 : 0);
        }
        if (value.readonly !== undefined) {
          sets.push("readonly = ?");
          params.push(value.readonly ? 1 : 0);
        }
        if (value.display !== undefined) {
          sets.push("display = ?");
          params.push(value.display);
        }
        if (sets.length === 0) continue;
        raw.prepare(`UPDATE property_schema SET ${sets.join(", ")} WHERE id = ?`).run(...params, value.schemaId);
      }
    } finally {
      raw.close();
    }
    // Store.open runs migrate() (v13 → v14: the guarded ALTERs no-op, the
    // class_property rebuild drops the retired binding columns).
    const store = Store.open(betterSqlite3Backend(tempDb));
    try {
      const moved = store.database
        .prepare(
          "SELECT COUNT(*) AS n FROM property_schema WHERE display IS NOT NULL OR hide_when_empty IS NOT NULL OR readonly IS NOT NULL",
        )
        .get() as { n: number };
      if (moved.n === 0 && values.length > 0) {
        throw new Error("snapshot patch verification failed: no property_schema row carries the moved values");
      }
      const columns = (
        store.database.prepare("PRAGMA table_info(class_property)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      for (const retired of ["display", "hide_when_empty", "readonly"]) {
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

    // 1. Plan: scan the log for class.property.set envelopes carrying moved keys.
    const affected = (
      relay.allEnvelopes(options.workspace) as Array<{
        seq: number;
        id: string;
        opType: string;
        payload: Record<string, unknown>;
      }>
    ).filter((env) => env.opType === "class.property.set" && movedKeysOf(env.payload).length > 0);

    // 2. The converged per-schema values (from the server's derived store).
    const values = readMovedValues(options.dataDir, options.workspace);

    console.log("\nplanned §34.90 binding-flags rewrite:");
    if (affected.length === 0) {
      console.log("  no class.property.set envelope carries hideWhenEmpty/readonly/display — nothing to rewrite.");
    } else {
      console.log(`  ${affected.length} envelope(s) carry moved key(s) — stripped in place:`);
      for (const env of affected.slice(0, 8)) {
        console.log(`    ${env.id.slice(0, 13)}…  ${movedKeysOf(env.payload).join(", ")}`);
      }
      if (affected.length > 8) console.log(`    … and ${affected.length - 8} more`);
    }
    if (values.length === 0) {
      console.log("  no binding row carries a moved value — no compensation update needed.");
    } else {
      console.log(`  ${values.length} schema(s) gain the moved values via appended propertySchema.update:`);
      for (const value of values.slice(0, 8)) {
        console.log(`    ${value.schemaId}  ${JSON.stringify({ ...value, schemaId: undefined })}`);
      }
      if (values.length > 8) console.log(`    … and ${values.length - 8} more`);
    }

    if (affected.length === 0 && values.length === 0) {
      console.log("\nnothing to rewrite — the log is already §34.90-clean.");
      return;
    }

    // The compensation envelopes (appended after the log tail).
    const physical = Date.now();
    const compensation: Envelope[] = values.map((value, index) => {
      const payload: Record<string, unknown> = { propertySchemaId: value.schemaId };
      if (value.hideWhenEmpty !== undefined) payload.hideWhenEmpty = value.hideWhenEmpty;
      if (value.readonly !== undefined) payload.readonly = value.readonly;
      if (value.display !== undefined) payload.display = value.display;
      return newEnvelope({
        workspaceId: options.workspace,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: index },
        affectedNodeIds: [],
        opType: "propertySchema.update",
        payload,
      });
    });

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to perform the rewrite (backup → envelope rewrite + compensation → snapshot patch → epoch bump → verify).",
      );
      return;
    }

    // --- apply ----------------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-flags-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-flags-${stamp}`);

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
      const patched = patchSnapshot(snapshotFile, values);
      writeFileSync(snapshotFile, patched);
      console.log(`patched snapshot ${snapshot.id} (bytes backup at /tmp/snapshot-${snapshot.id}.bak-${stamp}).`);
    } else {
      console.log("no snapshot — the next hydration replays the full log (slow path, correct by construction).");
    }

    // 5. Epoch bump: every client wipes + resyncs from the rewritten log.
    const epoch = relay.bumpRestoreEpoch(options.workspace);
    console.log(`restore_epoch bumped to ${epoch}.`);

    // 6. Verify.
    verify(relay, options.workspace, values);
    console.log("done.");
  } finally {
    relay.close();
  }
}

/**
 * Post-rewrite verification:
 *  1. every class.property.set envelope in the log validates through the
 *     strict payload schema (the moved keys are gone everywhere),
 *  2. a fresh scratch store replays the FULL log (zero StoreError throws) and
 *     the schema rows carry the moved values; the binding table is flag-clean.
 */
function verify(relay: RelayStorage, workspaceId: string, values: MovedValues[]): void {
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
  console.log(`verify: all ${count} class.property.set envelopes validate clean (moved keys gone).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    for (const value of values) {
      const row = store.database
        .prepare("SELECT display, readonly, hide_when_empty FROM property_schema WHERE id = ?")
        .get(value.schemaId) as
        | { display: string | null; readonly: number | null; hide_when_empty: number | null }
        | undefined;
      if (row === undefined) throw new Error(`verification failed: schema ${value.schemaId} missing after replay`);
      if (value.display !== undefined && row.display !== value.display) {
        throw new Error(
          `verification failed: schema ${value.schemaId} display ${JSON.stringify(row.display)} != ${JSON.stringify(value.display)}`,
        );
      }
      if (
        value.hideWhenEmpty !== undefined &&
        (row.hide_when_empty === null ? null : row.hide_when_empty === 1) !== value.hideWhenEmpty
      ) {
        throw new Error(`verification failed: schema ${value.schemaId} hideWhenEmpty diverged`);
      }
      if (
        value.readonly !== undefined &&
        (row.readonly === null ? null : row.readonly === 1) !== value.readonly
      ) {
        throw new Error(`verification failed: schema ${value.schemaId} readonly diverged`);
      }
    }
    const bindingColumns = (
      store.database.prepare("PRAGMA table_info(class_property)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const retired of ["display", "hide_when_empty", "readonly"]) {
      if (bindingColumns.includes(retired)) {
        throw new Error(`verification failed: class_property still carries the retired ${retired} column`);
      }
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: full replay clean; ${values.length} schema row(s) carry the moved values; the binding table is flag-clean.`,
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
