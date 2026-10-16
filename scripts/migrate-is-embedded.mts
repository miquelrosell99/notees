/**
 * Revision 12 one-time migration: `presentAsMain` → `isEmbedded`
 * (owner 2026-10-16), envelope v3.
 *
 * The stored relay log is rewritten IN PLACE (the stack must be stopped; the
 * owner is the sole user). The Revision-12 embedding model renames the
 * Revision-11 render bit WITH POLARITY INVERSION — `is_embedded = 1 -
 * present_as_main`: `isEmbedded: true` = the node's content belongs to the
 * parent's body (the Block role, the DEFAULT for parented nodes);
 * `isEmbedded: false` = a standalone structural element (the Page role).
 * Payload schemas reject the retired key outright, so every stored
 * occurrence must be rewritten before the new server can replay the log:
 *
 *  - object.create / object.update `payload.presentAsMain: <bool>` →
 *    `payload.isEmbedded: !<bool>`.
 *  - Query ASTs embedded in contentAst query tokens (saved views, query
 *    blocks — the AST is versioned and strict): condition
 *    `{type:"presentAsMain", presentAsMain: v}` →
 *    `{type:"isEmbedded", isEmbedded: !v}`; sort `field: "presentAsMain"` →
 *    `"isEmbedded"`; aggregation dimension `kind: "presentAsMain"` →
 *    `"isEmbedded"`. The rewrite walks the AST recursively (conditions ride
 *    inside group/not/linkedToQuery/descendantOfQuery nesting).
 *  - No other op type carries the key (object.move never writes the bit;
 *    class.create/convert clear it applier-side).
 *  - protocol_version stays 3 (envelope shape unchanged — a payload key
 *    retirement, the migrate-color-tokens class).
 *  - Stale snapshots (relay rows + blob files) deleted; every server-side
 *    derived DB (<dataDir>/derived/<ws>.db) removed so the schema rebuilds
 *    from the migrated log (the v21 derived-schema ladder renames and
 *    inverts the column in place); restore_epoch bumped per workspace so
 *    every client wipes and full re-syncs.
 *
 * Deployment order (unlike migrate-color-tokens there is NO mixed window):
 * the OLD server rejects `isEmbedded` and the NEW server rejects
 * `presentAsMain` — stack down → new images up → migration → restart. The
 * new appliers default absent flags by context, so envelopes that never
 * carried the bit replay identically.
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
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-is-embedded.mts \
 *     --db ../../config/notees/sync/relay.db --dry-run     # occurrence report
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-is-embedded.mts \
 *     --db ../../config/notees/sync/relay.db --apply       # rewrite (backs up first)
 *
 * Exit codes: 0 success (dry-run included), 1 any error.
 */

import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The script lives outside the server package, so the bare specifier does not
// resolve from here — go through the server's dependency (the same
// better-sqlite3 build the relay storage uses).
import Database from "../apps/server/node_modules/better-sqlite3/lib/index.js";

import {
  envelopeSchema,
  payloadSchemaFor,
} from "../packages/protocol/src/index.ts";

type Db = InstanceType<typeof Database>;

const MARKER_KEY = "is_embedded_migration_v1";
const BIT_OPS = new Set(["object.create", "object.update"]);

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

// --- rewriting -------------------------------------------------------------------

interface StoredRow {
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

interface RowPlan {
  seq: number;
  workspaceId: string;
  payload: Record<string, unknown>;
}

interface RowResult {
  plan: RowPlan | null;
  payloadBits: number;
  astConditions: number;
  astSortFields: number;
  astDimensions: number;
  /** values that did not map (reported; --apply aborts on any) */
  unmapped: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite the retired `presentAsMain` occurrences inside one embedded query
 * AST (any nesting depth — conditions ride inside group/not/nested-query
 * children; sort specs and aggregation dimensions sit beside the root).
 * Returns the NEW value when something changed, else the original. The
 * inversion is uniform: `isEmbedded = !presentAsMain`.
 */
function rewriteQueryAst(node: unknown, stats: RowResult): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((entry) => {
      const rewritten = rewriteQueryAst(entry, stats);
      if (rewritten !== entry) changed = true;
      return rewritten;
    });
    return changed ? next : node;
  }
  if (!isRecord(node)) return node;

  let next: Record<string, unknown> | null = null;
  const ensure = () => (next ??= { ...node });

  // A condition object: { type: "presentAsMain", presentAsMain: <bool> }.
  if (node.type === "presentAsMain") {
    const value = node.presentAsMain;
    if (typeof value !== "boolean") {
      stats.unmapped.push(`query AST presentAsMain condition with non-boolean value ${JSON.stringify(value)}`);
    } else {
      const replaced = ensure();
      delete replaced.type;
      delete replaced.presentAsMain;
      replaced.type = "isEmbedded";
      replaced.isEmbedded = !value;
      stats.astConditions += 1;
    }
  }

  // A sort spec: { field: "presentAsMain", dir: ... }.
  if (node.field === "presentAsMain") {
    ensure().field = "isEmbedded";
    stats.astSortFields += 1;
  }

  // An aggregation dimension: { kind: "presentAsMain" }.
  if (node.kind === "presentAsMain") {
    ensure().kind = "isEmbedded";
    stats.astDimensions += 1;
  }

  // Recurse into every value (children groups, nested query roots, the
  // sort/aggregation containers themselves).
  for (const [key, value] of Object.entries(next ?? node)) {
    if (key === "presentAsMain") continue; // handled above (or unmapped)
    const rewritten = rewriteQueryAst(value, stats);
    if (rewritten !== value) ensure()[key] = rewritten;
  }

  return next ?? node;
}

/** Rewrite the retired bit + embedded query ASTs in one parsed contentAst. */
function rewriteContentAst(contentAst: unknown, stats: RowResult): unknown {
  if (!Array.isArray(contentAst)) return contentAst;
  let changed = false;
  const next = contentAst.map((token) => {
    if (isRecord(token) && token.type === "query" && token.queryAst !== undefined) {
      const rewrittenAst = rewriteQueryAst(token.queryAst, stats);
      if (rewrittenAst !== token.queryAst) {
        changed = true;
        return { ...token, queryAst: rewrittenAst };
      }
    }
    return token;
  });
  return changed ? next : contentAst;
}

/** Strict-schema validation of a rewritten envelope (fail loud before any write). */
function validateRewritten(row: StoredRow, payload: Record<string, unknown>): void {
  const envelope: Record<string, unknown> = {
    id: row.id,
    protocolVersion: row.protocol_version,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    deviceId: row.device_id,
    hlc: { physical: row.physical, logical: row.logical },
    affectedNodeIds: JSON.parse(row.affected_node_ids),
    opType: row.op_type,
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
  const schema = payloadSchemaFor(row.op_type);
  if (schema === undefined) {
    throw new Error(`envelope seq ${row.seq}: no payload schema for opType ${row.op_type}`);
  }
  const checkedPayload = schema.safeParse(payload);
  if (!checkedPayload.success) {
    throw new Error(
      `envelope seq ${row.seq}: rewritten ${row.op_type} payload fails the strict schema: ${checkedPayload.error.issues[0]?.message}`,
    );
  }
}

/** Build the rewrite plan for one stored row (plan null = payload unchanged). */
function planRow(row: StoredRow): RowResult {
  const result: RowResult = {
    plan: null,
    payloadBits: 0,
    astConditions: 0,
    astSortFields: 0,
    astDimensions: 0,
    unmapped: [],
  };
  if (!BIT_OPS.has(row.op_type)) return result;

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new Error(`envelope seq ${row.seq}: payload is not valid JSON`);
  }
  if (!isRecord(payload)) {
    throw new Error(`envelope seq ${row.seq}: payload is not an object`);
  }

  let next: Record<string, unknown> | null = null;
  const ensure = () => (next ??= { ...payload });

  // The retired wire key, inverted.
  const bit = payload.presentAsMain;
  if (bit !== undefined) {
    if (typeof bit !== "boolean") {
      result.unmapped.push(`presentAsMain is not a boolean (${JSON.stringify(bit)})`);
    } else {
      const replaced = ensure();
      delete replaced.presentAsMain;
      replaced.isEmbedded = !bit;
      result.payloadBits += 1;
    }
  }

  // Embedded query ASTs (saved views / query blocks) ride the contentAst
  // carriers of the same two ops.
  if (payload.contentAst !== undefined) {
    const rewritten = rewriteContentAst(payload.contentAst, result);
    if (rewritten !== payload.contentAst) ensure().contentAst = rewritten;
  }

  if (next === null) return result;
  validateRewritten(row, next);
  return { ...result, plan: { seq: row.seq, workspaceId: row.workspace_id, payload: next } };
}

// --- main --------------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.dbPath)) {
    throw new Error(`relay DB not found: ${options.dbPath}`);
  }

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
    const workspaces = new Map<
      string,
      { total: number; payloadBits: number; astConditions: number; astSortFields: number; astDimensions: number; unmapped: number }
    >();
    const scanNotes: string[] = [];
    const plans: RowPlan[] = [];
    for (const row of rows) {
      let ws = workspaces.get(row.workspace_id);
      if (ws === undefined) {
        ws = { total: 0, payloadBits: 0, astConditions: 0, astSortFields: 0, astDimensions: 0, unmapped: 0 };
        workspaces.set(row.workspace_id, ws);
      }
      ws.total += 1;
      if (!BIT_OPS.has(row.op_type)) continue;

      let result: RowResult;
      try {
        result = planRow(row);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.apply) throw error;
        ws.unmapped += 1;
        scanNotes.push(message);
        continue;
      }
      ws.payloadBits += result.payloadBits;
      ws.astConditions += result.astConditions;
      ws.astSortFields += result.astSortFields;
      ws.astDimensions += result.astDimensions;
      if (result.unmapped.length > 0) {
        ws.unmapped += result.unmapped.length;
        for (const note of result.unmapped) scanNotes.push(`envelope seq ${row.seq}: ${note}`);
      }
      if (result.plan !== null) plans.push(result.plan);
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
        ...workspaces.keys(),
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
    console.log(`workspaces: ${workspaces.size} (${rows.length} envelope rows)`);
    for (const [workspaceId, ws] of workspaces) {
      console.log(`workspace ${workspaceId}:`);
      console.log(`  envelopes: total=${ws.total}`);
      console.log(
        `  payload presentAsMain → isEmbedded (inverted): ${ws.payloadBits}; query AST conditions: ${ws.astConditions}; query AST sort fields: ${ws.astSortFields}; query AST group dimensions: ${ws.astDimensions}; unmapped: ${ws.unmapped}`,
      );
    }
    console.log(`payload rewrites planned: ${plans.length}`);
    console.log(`protocol_version: unchanged (3)`);
    console.log(`snapshots to drop: ${snapshotRows.length} row(s) + blob file(s)`);
    console.log(`derived DB files to remove: ${derivedFiles.length} under ${options.derivedDir}`);
    console.log(`restore_epoch bump: ${epochWorkspaces.length} workspace(s)`);
    if (scanNotes.length > 0) {
      console.log(`scan notes (${scanNotes.length} occurrence(s) need attention before --apply):`);
      for (const note of scanNotes.slice(0, 50)) console.log(`  ${note}`);
      if (scanNotes.length > 50) console.log(`  … and ${scanNotes.length - 50} more`);
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

    const run = db.transaction(() => {
      const updateEnvelope = db.prepare("UPDATE envelope SET payload = ? WHERE seq = ?");
      for (const plan of plans) {
        updateEnvelope.run(JSON.stringify(plan.payload), plan.seq);
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
          envelopeRewrites: plans.length,
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
    console.log(`  envelope payloads rewritten: ${plans.length}`);
    console.log(`  snapshot rows dropped: ${snapshotRows.length}; blob files removed: ${blobsRemoved}`);
    console.log(`  derived DB files removed: ${derivedRemoved}/${derivedFiles.length}`);
    console.log(`  restore_epoch bumped for ${epochWorkspaces.length} workspace(s)`);
    console.log(`  marker written: ${MARKER_KEY}`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`migrate-is-embedded: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
