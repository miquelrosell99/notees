/**
 * One-time migration: retire the stored-log `class.delete` envelopes and
 * re-route stored `object.delete` envelopes addressed at class nodes
 * (owner ruling 2026-10-22, the classes-gallery batch; envelope v3).
 *
 * Slice 1 retired the `class.delete` OP outright (strict schemas reject it —
 * no wire compat), and slice 2 moved its routing into the `object.delete`
 * applier: four arms decided by the target class's kind (locked → fail loud;
 * family base → the feature toggle; other system class → archival; user
 * class → plain trash). Old stored logs replay differently under the new
 * appliers — some envelopes would THROW and break replay — so the stored
 * relay log is rewritten IN PLACE (the stack must be stopped; the owner is
 * the sole user), following the migrate-is-embedded / migrate-node-type
 * class of one-time migrations:
 *
 *  - `class.delete {classId}` → by the class's kind (classness is tracked
 *    positionally: the domain seed manifest + every `class.create` payload
 *    seen so far):
 *      - LOCKED system class (year/month/day + table, asset, query, code,
 *        template, comment) → DROP. The old op tombstoned memberships of a
 *        class the new world considers un-removable; replaying it would
 *        throw (LockedSystemClassError). Dropping keeps the memberships —
 *        the intended "membership rides" world.
 *      - a class id that is NOT a seed and was never `class.create`d in the
 *        log → DROP. The old op was a pure no-op on a missing class (the
 *        UPDATEs matched zero rows); the rewritten forms would throw
 *        NotFoundError.
 *      - family base (task, event, meeting, source, person) →
 *        `workspace.feature.set {feature, enabled: false}` (envelope id,
 *        HLC, actor, timestamp preserved — the applier's LWW row gate makes
 *        the routed delete converge with racing toggles exactly as the old
 *        F4 routing did).
 *      - any other system class → `object.update {objectId, active: false}`
 *        (archival, not trash).
 *      - user class → `object.delete {objectId, permanent: false}`.
 *  - `object.delete {objectId}` where objectId resolves to a KNOWN class at
 *    that log position → the same routing (locked → DROP; family base →
 *    the toggle; other system → archival); user class → LEFT AS-IS (trash
 *    semantics are unchanged).
 *  - Everything else passes through untouched. protocol_version stays 3.
 *
 * MEMBERSHIP SEMANTICS (documented honestly): the old `class.delete`
 * tombstoned `class_member_set` — the class left every node's class_ids,
 * lossy. The rewritten ops deliberately do NOT: a store rebuilt from the
 * migrated log KEEPS memberships the pre-migration world had stripped
 * (restore/enable brings the class back with every assignment intact).
 * That is the intended "membership rides" world (owner ruling 2026-10-22) —
 * the migration converges the OPS, and the membership difference is the
 * point of the ruling, not a migration defect.
 *
 * Deployment order: the OLD server rejects nothing new here, but the NEW
 * server rejects `class.delete` outright — stack down → new images up →
 * migration → restart. Stale snapshots (relay rows + blob files) deleted;
 * every server-side derived DB (<dataDir>/derived/<ws>.db) removed so the
 * schema rebuilds from the migrated log; restore_epoch bumped per
 * workspace so every client wipes and full re-syncs.
 *
 * The dry-run is READ-ONLY and never aborts: it reports the full per-
 * workspace distribution plus a scan-notes list of anything it could not
 * map. --apply fails loud on any unmapped remainder (defense in depth:
 * every rewritten envelope is re-validated against the strict v3 schemas
 * before the write).
 *
 * Idempotent: a schema_meta row marks a completed run; a second invocation
 * without --force reports "already migrated" and exits 0.
 *
 * Usage (from the repo root, stack stopped for --apply):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-class-delete.mts \
 *     --db ../../config/notees/sync/relay.db --dry-run     # occurrence report
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-class-delete.mts \
 *     --db ../../config/notees/sync/relay.db --apply       # rewrite (backs up first)
 *
 * Exit codes: 0 success (dry-run included), 1 any error.
 */

import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  payloadSchemaFor,
} from "../packages/protocol/src/index.ts";
import {
  featureForManagedClass,
  isLockedSystemClassId,
  systemClassNameForId,
  SYSTEM_CLASS_UUIDS,
} from "../packages/domain/src/index.ts";

const MARKER_KEY = "class_delete_migration_v1";
const CLASS_DELETE_OP = "class.delete";
const OBJECT_DELETE_OP = "object.delete";

// --- arguments -------------------------------------------------------------------

function parseArgs(argv: string[]): {
  dbPath: string;
  derivedDir: string;
  snapshotsDir: string;
  apply: boolean;
  force: boolean;
} {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") args.apply = false;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--force") args.force = true;
    else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  const dbPath = resolve(String(args.db ?? "config/notees/sync/relay.db"));
  const dataDir = dirname(dbPath);
  return {
    dbPath,
    derivedDir: resolve(String(args["derived-dir"] ?? join(dataDir, "derived"))),
    snapshotsDir: resolve(String(args["snapshots-dir"] ?? join(dataDir, "snapshots"))),
    apply: args.apply === true,
    force: args.force === true,
  };
}

// --- rewriting (pure — unit-tested from packages/store/test) ----------------------

export interface StoredRow {
  seq: number;
  id: string;
  workspace_id: string;
  actor_id: string;
  device_id: string;
  client: string | null;
  physical: number;
  logical: number;
  affected_node_ids: string;
  op_type: string;
  payload: string;
  protocol_version: number;
  timestamp: string;
}

export type RowPlan =
  | {
      action: "rewrite";
      seq: number;
      opType: string;
      payload: Record<string, unknown>;
      affectedNodeIds: string[];
    }
  | { action: "drop"; seq: number; reason: string };

export interface WorkspaceStats {
  total: number;
  classDeleteRows: number;
  classDeleteRewrites: number;
  classDeleteDrops: number;
  objectDeleteClassRows: number;
  objectDeleteRewrites: number;
  objectDeleteDrops: number;
  unmapped: number;
}

export interface MigrationPlan {
  plans: RowPlan[];
  /** Per-workspace distribution (report). */
  workspaces: Map<string, WorkspaceStats>;
  /** Anything that needs attention before --apply. */
  scanNotes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(row: StoredRow): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new Error(`envelope seq ${row.seq}: payload is not valid JSON`);
  }
  if (!isRecord(payload)) {
    throw new Error(`envelope seq ${row.seq}: payload is not an object`);
  }
  return payload;
}

/** Strict-schema validation of a rewritten envelope (fail loud before any write). */
function validateRewritten(
  row: StoredRow,
  opType: string,
  payload: Record<string, unknown>,
  affectedNodeIds: unknown,
): void {
  const envelope: Record<string, unknown> = {
    id: row.id,
    protocolVersion: row.protocol_version,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    deviceId: row.device_id,
    hlc: { physical: row.physical, logical: row.logical },
    affectedNodeIds,
    opType,
    timestamp: row.timestamp,
    payload,
  };
  if (row.client !== null) envelope.client = row.client;
  const checkedEnvelope = envelopeSchema.safeParse(envelope);
  if (!checkedEnvelope.success) {
    throw new Error(
      `envelope seq ${row.seq}: rewrite fails the v3 envelope schema: ${checkedEnvelope.error.issues[0]?.message}`,
    );
  }
  const schema = payloadSchemaFor(opType);
  if (schema === undefined) {
    throw new Error(`envelope seq ${row.seq}: no payload schema for opType ${opType}`);
  }
  const checkedPayload = schema.safeParse(payload);
  if (!checkedPayload.success) {
    throw new Error(
      `envelope seq ${row.seq}: rewritten ${opType} payload fails the strict schema: ${checkedPayload.error.issues[0]?.message}`,
    );
  }
}

interface RouteDecision {
  /** The opType to rewrite to; null = drop the envelope. */
  opType: string | null;
  payload: Record<string, unknown> | null;
  /** affected_node_ids for the rewrite ([] = the feature-toggle convention). */
  affectedNodeIds: string[];
  /** Drop/leave reason (scan notes). */
  reason: string | null;
}

/**
 * Route one class-addressed delete to its new-world equivalent. `createdInLog`
 * is whether a `class.create` for this id was seen earlier in the log (the
 * seed manifest is the floor — every seed class is "known" from position 0).
 * `forClassDeleteOp` distinguishes the two source ops: the old class.delete
 * was requireNode-free (a missing class was a no-op), object.delete required
 * the node (a missing class already threw — leave those alone).
 */
function routeClassTarget(
  classId: string,
  createdInLog: boolean,
  forClassDeleteOp: boolean,
  context: string,
): RouteDecision {
  const feature = featureForManagedClass(classId);
  const systemName = systemClassNameForId(classId);
  if (isLockedSystemClassId(classId)) {
    return {
      opType: null,
      payload: null,
      affectedNodeIds: [],
      reason: `${context}: ${systemName} is a locked system class — the delete would now throw (LockedSystemClassError); dropping keeps the memberships (membership rides)`,
    };
  }
  if (feature !== null) {
    return {
      opType: "workspace.feature.set",
      payload: { feature, enabled: false },
      affectedNodeIds: [],
      reason: null,
    };
  }
  if (systemName !== null) {
    return {
      opType: "object.update",
      payload: { objectId: classId, active: false },
      affectedNodeIds: [classId],
      reason: null,
    };
  }
  // User class.
  if (forClassDeleteOp && !createdInLog) {
    return {
      opType: null,
      payload: null,
      affectedNodeIds: [],
      reason: `${context}: user class ${classId} was never class.create'd in the log — the old class.delete was a pure no-op on a missing class; the rewritten object.delete would throw NotFoundError`,
    };
  }
  return {
    opType: OBJECT_DELETE_OP,
    payload: { objectId: classId, permanent: false },
    affectedNodeIds: [classId],
    reason: null,
  };
}

/**
 * Walk the stored log (seq order) and plan the rewrite. Pure: takes the
 * parsed relay rows, returns the per-row plans plus the report data — the
 * CLI applies the plans transactionally, and the store test replays them
 * into a fresh Store to pin the rebuilt state.
 */
export function planClassDeleteMigration(rows: StoredRow[]): MigrationPlan {
  // Classness tracking: the seed manifest is the floor; class.create payloads
  // grow the set positionally (class ids are globally unique uuids, so one
  // set serves the whole relay log).
  const knownClasses = new Set<string>(Object.values(SYSTEM_CLASS_UUIDS));
  const createdClasses = new Set<string>();
  const plans: RowPlan[] = [];
  const workspaces = new Map<string, WorkspaceStats>();
  const scanNotes: string[] = [];

  const statsFor = (workspaceId: string): WorkspaceStats => {
    let stats = workspaces.get(workspaceId);
    if (stats === undefined) {
      stats = {
        total: 0,
        classDeleteRows: 0,
        classDeleteRewrites: 0,
        classDeleteDrops: 0,
        objectDeleteClassRows: 0,
        objectDeleteRewrites: 0,
        objectDeleteDrops: 0,
        unmapped: 0,
      };
      workspaces.set(workspaceId, stats);
    }
    return stats;
  };

  for (const row of rows) {
    const ws = statsFor(row.workspace_id);
    ws.total += 1;

    if (row.op_type === "class.create") {
      const payload = parsePayload(row);
      if (typeof payload.classId === "string") {
        knownClasses.add(payload.classId);
        createdClasses.add(payload.classId);
      }
      continue;
    }

    if (row.op_type === CLASS_DELETE_OP) {
      ws.classDeleteRows += 1;
      const payload = parsePayload(row);
      const classId = payload.classId;
      if (typeof classId !== "string") {
        ws.unmapped += 1;
        scanNotes.push(`envelope seq ${row.seq}: class.delete payload has no string classId`);
        continue;
      }
      const decision = routeClassTarget(classId, createdClasses.has(classId), true, "class.delete");
      if (decision.opType === null) {
        ws.classDeleteDrops += 1;
        plans.push({ action: "drop", seq: row.seq, reason: decision.reason ?? "dropped" });
        continue;
      }
      ws.classDeleteRewrites += 1;
      validateRewritten(row, decision.opType, decision.payload!, decision.affectedNodeIds);
      plans.push({
        action: "rewrite",
        seq: row.seq,
        opType: decision.opType,
        payload: decision.payload!,
        affectedNodeIds: decision.affectedNodeIds,
      });
      continue;
    }

    if (row.op_type === OBJECT_DELETE_OP) {
      const payload = parsePayload(row);
      const objectId = payload.objectId;
      if (typeof objectId !== "string") {
        ws.unmapped += 1;
        scanNotes.push(`envelope seq ${row.seq}: object.delete payload has no string objectId`);
        continue;
      }
      if (!knownClasses.has(objectId)) continue; // a node delete — unchanged
      ws.objectDeleteClassRows += 1;
      // A user-class object.delete keeps plain trash semantics — unchanged
      // (every locked/system class IS a system class by the seed manifest).
      if (systemClassNameForId(objectId) === null) continue;
      const decision = routeClassTarget(objectId, createdClasses.has(objectId), false, "object.delete");
      if (decision.opType === null) {
        ws.objectDeleteDrops += 1;
        plans.push({ action: "drop", seq: row.seq, reason: decision.reason ?? "dropped" });
        continue;
      }
      ws.objectDeleteRewrites += 1;
      const affectedNodeIds =
        decision.affectedNodeIds.length > 0
          ? decision.affectedNodeIds
          : (JSON.parse(row.affected_node_ids) as string[]);
      validateRewritten(row, decision.opType, decision.payload!, affectedNodeIds);
      plans.push({
        action: "rewrite",
        seq: row.seq,
        opType: decision.opType,
        payload: decision.payload!,
        affectedNodeIds,
      });
      continue;
    }
  }

  return { plans, workspaces, scanNotes };
}

// --- main --------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.dbPath)) {
    throw new Error(`relay DB not found: ${options.dbPath}`);
  }

  // The better-sqlite3 driver is imported lazily (deep path — the bare
  // specifier does not resolve from scripts/) so the pure planner stays
  // importable from the store's unit tests without the native module. Only
  // the small surface this script uses is typed (the same build the relay
  // storage uses, via the server's dependency).
  interface DbStatement {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  }
  interface Db {
    prepare: (sql: string) => DbStatement;
    exec: (sql: string) => void;
    pragma: (pragma: string, options?: { simple?: boolean }) => unknown;
    close: () => void;
    transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
  }
  // The specifier is non-literal on purpose: TypeScript cannot (and need
  // not) resolve types through the server's nested node_modules — the cast
  // below carries the minimal surface this script uses.
  const driverPath = "../apps/server/node_modules/better-sqlite3/lib/index.js";
  const { default: Database } = (await import(driverPath)) as unknown as {
    default: new (filename: string, options?: { readonly?: boolean }) => Db;
  };

  // The dry-run is strictly read-only (it may run while the stack is up).
  const db: Db = new Database(options.dbPath, { readonly: !options.apply });
  try {
    db.pragma("busy_timeout = 5000");

    // Idempotency marker (a completed run refuses to re-run without --force).
    // The marker table is only created by --apply; the dry run never writes.
    if (options.apply) {
      db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }
    const markerTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
      .get();
    const marker = markerTable
      ? (db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(MARKER_KEY) as { value: string } | undefined)
      : undefined;
    if (marker !== undefined && !options.force) {
      console.log(`already migrated (${marker.value})`);
      console.log("nothing to do — re-run with --force to execute anyway (a fresh backup is written first).");
      return;
    }

    // Scan + plan. In apply mode planning is strict: anything unmapped throws
    // BEFORE the backup/write. In dry-run mode problems are collected as scan
    // notes and the full distribution still prints (exit 0).
    const rows = db.prepare("SELECT * FROM envelope ORDER BY seq ASC").all() as unknown as StoredRow[];
    let plan: MigrationPlan;
    try {
      plan = planClassDeleteMigration(rows);
    } catch (error) {
      if (options.apply) throw error;
      plan = { plans: [], workspaces: new Map(), scanNotes: [error instanceof Error ? error.message : String(error)] };
    }

    const snapshotRows = db.prepare("SELECT id, workspace_id FROM snapshot").all() as unknown as Array<{
      id: string;
      workspace_id: string;
    }>;
    const derivedFiles = existsSync(options.derivedDir)
      ? readdirSync(options.derivedDir).filter((name) => /\.db(-wal|-shm|-journal)?$/.test(name))
      : [];
    const epochWorkspaces = [
      ...new Set([
        ...plan.workspaces.keys(),
        ...snapshotRows.map((row) => row.workspace_id),
        ...(
          db.prepare("SELECT workspace_id FROM restore_epoch").all() as unknown as Array<{
            workspace_id: string;
          }>
        ).map((row) => row.workspace_id),
      ]),
    ];

    // Report.
    console.log(`relay DB: ${options.dbPath}`);
    console.log(`mode: ${options.apply ? "APPLY" : "DRY-RUN (read-only)"}${options.force ? " (forced)" : ""}`);
    console.log(`workspaces: ${plan.workspaces.size} (${rows.length} envelope rows)`);
    for (const [workspaceId, ws] of plan.workspaces) {
      console.log(`workspace ${workspaceId}:`);
      console.log(`  envelopes: total=${ws.total}`);
      console.log(
        `  class.delete rows: ${ws.classDeleteRows} (rewrites: ${ws.classDeleteRewrites}; drops: ${ws.classDeleteDrops}); ` +
          `object.delete-on-class rows: ${ws.objectDeleteClassRows} (rewrites: ${ws.objectDeleteRewrites}; drops: ${ws.objectDeleteDrops}); unmapped: ${ws.unmapped}`,
      );
    }
    console.log(`envelope rewrites planned: ${plan.plans.filter((p) => p.action === "rewrite").length}`);
    console.log(`envelope drops planned: ${plan.plans.filter((p) => p.action === "drop").length}`);
    console.log(`protocol_version: unchanged (3)`);
    console.log(`snapshots to drop: ${snapshotRows.length} row(s) + blob file(s)`);
    console.log(`derived DB files to remove: ${derivedFiles.length} under ${options.derivedDir}`);
    console.log(`restore_epoch bump: ${epochWorkspaces.length} workspace(s)`);
    if (plan.scanNotes.length > 0) {
      console.log(`scan notes (${plan.scanNotes.length} occurrence(s) need attention before --apply):`);
      for (const note of plan.scanNotes.slice(0, 50)) console.log(`  ${note}`);
      if (plan.scanNotes.length > 50) console.log(`  … and ${plan.scanNotes.length - 50} more`);
    }

    if (!options.apply) {
      console.log("dry-run only — no writes. Re-run with --apply to execute (a timestamped backup is written first).");
      return;
    }

    // Apply: backup first (WAL checkpoint so the main file is complete).
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const backupPath = `${options.dbPath}.bak-${stamp}`;
    db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(options.dbPath, backupPath);
    const check = new Database(backupPath, { readonly: true });
    const quickCheck = check.pragma("quick_check", { simple: true });
    check.close();
    if (quickCheck !== "ok") {
      throw new Error(`backup integrity check failed (${String(quickCheck)}) — aborting before any write`);
    }
    console.log(`backup written: ${backupPath} (quick_check ok)`);

    const rewrites = plan.plans.filter((p) => p.action === "rewrite");
    const drops = plan.plans.filter((p) => p.action === "drop");
    const run = db.transaction(() => {
      const updateEnvelope = db.prepare("UPDATE envelope SET op_type = ?, payload = ?, affected_node_ids = ? WHERE seq = ?");
      for (const p of rewrites) {
        updateEnvelope.run(p.opType, JSON.stringify(p.payload), JSON.stringify(p.affectedNodeIds), p.seq);
      }
      const deleteEnvelope = db.prepare("DELETE FROM envelope WHERE seq = ?");
      for (const p of drops) {
        deleteEnvelope.run(p.seq);
      }
      const snapshotIds = snapshotRows.map((row) => row.id);
      if (snapshotIds.length > 0) {
        db.prepare(`DELETE FROM snapshot WHERE id IN (${snapshotIds.map(() => "?").join(",")})`).run(
          ...snapshotIds,
        );
      }
      const bumpEpoch = db.prepare(
        `INSERT INTO restore_epoch (workspace_id, epoch) VALUES (?, 1)
         ON CONFLICT(workspace_id) DO UPDATE SET epoch = epoch + 1`,
      );
      for (const workspaceId of epochWorkspaces) bumpEpoch.run(workspaceId);
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(
        MARKER_KEY,
        JSON.stringify({
          appliedAt: new Date().toISOString(),
          backupPath,
          envelopeRewrites: rewrites.length,
          envelopeDrops: drops.length,
          snapshotsDropped: snapshotRows.length,
          derivedDbFilesRemoved: derivedFiles.length,
          restoreEpochWorkspaces: epochWorkspaces.length,
        }),
      );
    });
    run();

    // Post-commit filesystem work: snapshot blobs + derived DB files.
    let blobsRemoved = 0;
    for (const snapshot of snapshotRows) {
      try {
        unlinkSync(join(options.snapshotsDir, `${snapshot.id}.db`));
        blobsRemoved += 1;
      } catch {
        // Blob already gone.
      }
    }
    let derivedRemoved = 0;
    for (const name of derivedFiles) {
      try {
        unlinkSync(join(options.derivedDir, name));
        derivedRemoved += 1;
      } catch {
        // File already gone.
      }
    }

    console.log("migration applied:");
    console.log(`  envelopes rewritten: ${rewrites.length}; envelopes dropped: ${drops.length}`);
    console.log(`  snapshot rows dropped: ${snapshotRows.length}; blob files removed: ${blobsRemoved}`);
    console.log(`  derived DB files removed: ${derivedRemoved}/${derivedFiles.length}`);
    console.log(`  restore_epoch bumped for ${epochWorkspaces.length} workspace(s)`);
    console.log(`  marker written: ${MARKER_KEY}`);
  } finally {
    db.close();
  }
}

// Run only when executed directly (tsx …/migrate-class-delete.mts); the
// store's unit tests import the planner without touching the relay DB.
const invokedAsMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  main().catch((error) => {
    console.error(`migrate-class-delete: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
