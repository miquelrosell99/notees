/**
 * Revision 11 one-time migration: `node_type` → (`is_class`, `present_as_main`),
 * envelope v3 (implementation-plan.md §34.23, owner directive 2026-10-02).
 *
 * The stored relay log is rewritten IN PLACE (the stack must be stopped; the
 * owner is the sole user). No backward compatibility anywhere: payload
 * schemas reject the retired `nodeType` key outright, so every stored v2
 * envelope must be rewritten before the new server can replay the log:
 *
 *  - object.create / object.update carrying `nodeType`:
 *      "page"  → presentAsMain: true (the node renders with document chrome;
 *                parentless rows do regardless of the bit)
 *      "block" → presentAsMain: false (inline body)
 *      "class" → the envelope BECOMES class.create: {classId: <objectId>,
 *                contentAst?, icon?, color?} — parentId/afterId/beforeId/
 *                classIds/tagIds/presentAsMain are dropped; id/HLC/timestamps/
 *                affectedNodeIds are kept.
 *    Payloads without `nodeType` stay byte-identical: the new applier defaults
 *    (parentless → present_as_main 1, parented → 0) reproduce the old derived
 *    state exactly.
 *  - `nodeType` inside embedded query-token ASTs (contentAst query widgets):
 *      condition {type:"nodeType",nodeType:"page"|"block"} →
 *                {type:"presentAsMain",presentAsMain:true|false}
 *      condition nodeType:"class" → {type:"isClass",isClass:true}
 *      sort field "nodeType" → "isClass" (documented approximation — the old
 *      enum's class bucket maps onto the identity bit)
 *      aggregation {kind:"nodeType"} → {kind:"isClass"}
 *  - protocol_version 2 → 3 on every row.
 *  - Stale snapshots (relay rows + blob files) deleted; every server-side
 *    derived DB (<dataDir>/derived/<ws>.db) removed so the v8 schema rebuilds
 *    from the migrated log; restore_epoch bumped per workspace so every
 *    client wipes and full re-syncs.
 *
 * Idempotent: a schema_meta row marks a completed run; a second invocation
 * without --force reports "already migrated" and exits 0.
 *
 * Usage (from the repo root, stack stopped):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-node-type.mts \
 *     --db ../../config/notees/sync/relay.db --dry-run     # occurrence report
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-node-type.mts \
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

import { envelopeSchema, payloadSchemaFor } from "../packages/protocol/src/index.ts";

type Db = InstanceType<typeof Database>;

const MARKER_KEY = "revision_11_node_type_migration";
const TARGET_PROTOCOL_VERSION = 3;

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

// --- payload rewriting -------------------------------------------------------------

type TokenStats = { conditions: number; sorts: number; aggregations: number; unmapped: number };
type RowCategory = "page" | "block" | "class" | "tokens-only";

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
  opType: string;
  payload: Record<string, unknown>;
  category: RowCategory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-remap the retired nodeType shapes inside one query-token AST. Returns
 * a NEW structure when something changed (occurrence counts land in stats).
 */
function remapQueryAstShapes(value: unknown, stats: TokenStats): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry) => {
      const remapped = remapQueryAstShapes(entry, stats);
      if (remapped !== entry) changed = true;
      return remapped;
    });
    return changed ? out : value;
  }
  if (!isRecord(value)) return value;
  if (value.type === "nodeType" && typeof value.nodeType === "string") {
    switch (value.nodeType) {
      case "page":
        stats.conditions += 1;
        return { type: "presentAsMain", presentAsMain: true };
      case "block":
        stats.conditions += 1;
        return { type: "presentAsMain", presentAsMain: false };
      case "class":
        stats.conditions += 1;
        return { type: "isClass", isClass: true };
      default:
        stats.unmapped += 1;
        return value;
    }
  }
  if (value.field === "nodeType") {
    stats.sorts += 1;
    return { ...value, field: "isClass" };
  }
  if (value.kind === "nodeType") {
    stats.aggregations += 1;
    return { ...value, kind: "isClass" };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const remapped = remapQueryAstShapes(entry, stats);
    if (remapped !== entry) changed = true;
    out[key] = remapped;
  }
  return changed ? out : value;
}

/** Remap nodeType query tokens anywhere in a contentAst token stream. */
function remapContentAst(contentAst: unknown, stats: TokenStats): unknown {
  if (!Array.isArray(contentAst)) return contentAst;
  const before = stats.conditions + stats.sorts + stats.aggregations + stats.unmapped;
  const walkToken = (token: unknown): unknown => {
    if (!isRecord(token)) return token;
    let out: Record<string, unknown> | null = null;
    const ensure = () => (out ??= { ...token });
    if (token.type === "query" && isRecord(token.queryAst)) {
      const remapped = remapQueryAstShapes(token.queryAst, stats);
      if (remapped !== token.queryAst) ensure().queryAst = remapped;
    }
    if (Array.isArray(token.children)) {
      const original = token.children;
      const children = original.map(walkToken);
      if (children.some((child, index) => child !== original[index])) {
        ensure().children = children;
      }
    }
    return out ?? token;
  };
  const out = contentAst.map(walkToken);
  const changed = stats.conditions + stats.sorts + stats.aggregations + stats.unmapped > before;
  return changed ? out : contentAst;
}

/** Strict-schema validation of a rewritten envelope (fail loud before any write). */
function validateRewritten(row: StoredRow, payload: Record<string, unknown>, opType: string): void {
  const envelope: Record<string, unknown> = {
    id: row.id,
    protocolVersion: TARGET_PROTOCOL_VERSION,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    deviceId: row.device_id,
    hlc: { physical: row.physical, logical: row.logical },
    affectedNodeIds: JSON.parse(row.affected_node_ids),
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

interface RowResult {
  plan: RowPlan | null;
  /** The retired key's value when the payload carried one at the top level. */
  nodeTypeKey: string | null;
  tokens: TokenStats;
}

/**
 * Build the rewrite plan for one stored v2 row (plan null = payload stays
 * byte-identical). Throws on structural surprises (unparseable payload,
 * non-string or unknown nodeType): the migration must never guess.
 */
function planRow(row: StoredRow): RowResult {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new Error(`envelope seq ${row.seq}: payload is not valid JSON`);
  }
  if (!isRecord(payload)) {
    throw new Error(`envelope seq ${row.seq}: payload is not an object`);
  }

  let nodeTypeKey: string | null = null;
  let opType = row.op_type;
  let next: Record<string, unknown> = payload;
  let category: RowCategory | null = null;

  if (
    (opType === "object.create" || opType === "object.update") &&
    "nodeType" in payload
  ) {
    const value = payload.nodeType;
    if (typeof value !== "string") {
      throw new Error(`envelope seq ${row.seq}: nodeType is not a string (${JSON.stringify(value)})`);
    }
    nodeTypeKey = value;
    if (value === "class") {
      // Class declaration stays the class.create op: rebuild the payload from
      // the fields class.create carries; everything else is dropped.
      const converted: Record<string, unknown> = { classId: payload.objectId };
      for (const key of ["contentAst", "icon", "color"] as const) {
        if (payload[key] !== undefined) converted[key] = payload[key];
      }
      next = converted;
      opType = "class.create";
      category = "class";
    } else if (value === "page" || value === "block") {
      next = { ...payload, presentAsMain: value === "page" };
      delete next.nodeType;
      category = value;
    } else {
      throw new Error(`envelope seq ${row.seq}: unknown nodeType value "${value}"`);
    }
  }

  const tokens: TokenStats = { conditions: 0, sorts: 0, aggregations: 0, unmapped: 0 };
  const remappedAst = remapContentAst(next.contentAst, tokens);
  if (remappedAst !== next.contentAst) {
    next = { ...next, contentAst: remappedAst };
    category ??= "tokens-only";
  }
  if (tokens.unmapped > 0) {
    throw new Error(
      `envelope seq ${row.seq}: ${tokens.unmapped} nodeType token occurrence(s) with unknown values`,
    );
  }

  if (category === null) return { plan: null, nodeTypeKey, tokens };
  validateRewritten(row, next, opType);
  return {
    plan: { seq: row.seq, workspaceId: row.workspace_id, opType, payload: next, category },
    nodeTypeKey,
    tokens,
  };
}

// --- main --------------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.dbPath)) {
    throw new Error(`relay DB not found: ${options.dbPath}`);
  }

  const db: Db = new Database(options.dbPath);
  try {
    db.pragma("busy_timeout = 5000");

    // Idempotency marker (a completed run refuses to re-run without --force).
    db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const marker = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(MARKER_KEY) as { value: string } | undefined;
    if (marker !== undefined && !options.force) {
      console.log(`already migrated (${marker.value})`);
      console.log("nothing to do — re-run with --force to execute anyway (a fresh backup is written first).");
      return;
    }

    // Scan + plan.
    const rows = db.prepare("SELECT * FROM envelope ORDER BY seq ASC").all() as unknown as StoredRow[];
    const workspaces = new Map<
      string,
      {
        total: number;
        v2: number;
        nodeTypeDistribution: Record<string, number>;
        absentNodeType: number;
        tokens: TokenStats;
      }
    >();
    const plans: RowPlan[] = [];
    const categories: Record<RowCategory, number> = { page: 0, block: 0, class: 0, "tokens-only": 0 };
    let v2Count = 0;
    for (const row of rows) {
      let ws = workspaces.get(row.workspace_id);
      if (ws === undefined) {
        ws = {
          total: 0,
          v2: 0,
          nodeTypeDistribution: {},
          absentNodeType: 0,
          tokens: { conditions: 0, sorts: 0, aggregations: 0, unmapped: 0 },
        };
        workspaces.set(row.workspace_id, ws);
      }
      ws.total += 1;
      if (row.protocol_version !== 2) continue;
      ws.v2 += 1;
      v2Count += 1;

      const result = planRow(row);
      ws.tokens.conditions += result.tokens.conditions;
      ws.tokens.sorts += result.tokens.sorts;
      ws.tokens.aggregations += result.tokens.aggregations;
      if (row.op_type === "object.create" || row.op_type === "object.update") {
        if (result.nodeTypeKey !== null) {
          ws.nodeTypeDistribution[result.nodeTypeKey] =
            (ws.nodeTypeDistribution[result.nodeTypeKey] ?? 0) + 1;
        } else {
          ws.absentNodeType += 1;
        }
      }
      if (result.plan !== null) {
        plans.push(result.plan);
        categories[result.plan.category] += 1;
      }
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
    console.log(`mode: ${options.apply ? "APPLY" : "DRY-RUN"}${options.force ? " (forced)" : ""}`);
    for (const [workspaceId, ws] of workspaces) {
      console.log(`workspace ${workspaceId}:`);
      console.log(`  envelopes: total=${ws.total} v2=${ws.v2}`);
      const distribution = Object.entries(ws.nodeTypeDistribution)
        .map(([value, count]) => `${value}=${count}`)
        .join(" ");
      console.log(`  object.create/update nodeType key distribution: ${distribution || "none"}`);
      console.log(`  object.create/update without the key (applier defaults reproduce state): ${ws.absentNodeType}`);
      console.log(
        `  query-token nodeType occurrences: conditions=${ws.tokens.conditions} sorts=${ws.tokens.sorts} aggregations=${ws.tokens.aggregations}`,
      );
    }
    console.log(
      `payload rewrites: page→presentAsMain:true=${categories.page} block→presentAsMain:false=${categories.block} class→class.create=${categories.class} query-tokens-only=${categories["tokens-only"]}`,
    );
    console.log(`protocol_version 2→3 rows: ${v2Count}`);
    console.log(`snapshots to drop: ${snapshotRows.length} row(s) + blob file(s)`);
    console.log(`derived DB files to remove: ${derivedFiles.length} under ${options.derivedDir}`);
    console.log(`restore_epoch bump: ${epochWorkspaces.length} workspace(s)`);

    if (!options.apply) {
      console.log(`dry-run only — no writes. Re-run with --apply to execute (a timestamped backup is written first).`);
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
      const updateEnvelope = db.prepare("UPDATE envelope SET op_type = ?, payload = ? WHERE seq = ?");
      for (const plan of plans) {
        updateEnvelope.run(plan.opType, JSON.stringify(plan.payload), plan.seq);
      }
      const versionBump = db
        .prepare("UPDATE envelope SET protocol_version = ? WHERE protocol_version = 2")
        .run(TARGET_PROTOCOL_VERSION);
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
          categories,
          envelopeRewrites: plans.length,
          protocolVersionBumps: versionBump.changes,
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
    console.log(`  envelope payloads rewritten: ${plans.length} (${JSON.stringify(categories)})`);
    console.log(`  protocol_version 2→3 rows: ${v2Count}`);
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
  console.error(`migrate-node-type: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
