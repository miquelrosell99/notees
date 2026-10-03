/**
 * Color-token one-time migration (implementation-plan §34.43, owner directive
 * 2026-10-03): `var(--color-preset-<token>)` → `<token>` on the wire.
 *
 * The stored relay log is rewritten IN PLACE (the stack must be stopped; the
 * owner is the sole user). The first v3 color encoding stored CSS variable
 * references — a web-ism that leaked onto the wire and drifted between
 * clients. The §34.43 grammar is one string field: a preset TOKEN
 * (`sky`) or a custom `#RRGGBB` hex; `null` clears. Payload schemas reject
 * the retired encoding outright, so every stored occurrence must be
 * rewritten before the new server can replay the log:
 *
 *  - object.update / class.create / class.update `payload.color`:
 *      "var(--color-preset-red)" → "red" (token validated against
 *      COLOR_PRESET_TOKENS; unknown names are reported, never guessed).
 *      Custom hex and null pass through untouched.
 *  - object.update / class.create / class.update `payload.icon`: the field
 *    may be a JSON string of the form {"icon":"mdiX","color":"var(...)"} —
 *    an embedded color rides the same encoding, so it is rewritten inside
 *    the JSON (key order preserved; the string only changes when the color
 *    actually carried the retired encoding).
 *  - object.create carries no color/icon — untouched.
 *  - protocol_version stays 3 (envelope shape unchanged; this is a payload
 *    grammar refinement, same class as title-is-content's name retirement).
 *  - Stale snapshots (relay rows + blob files) deleted; every server-side
 *    derived DB (<dataDir>/derived/<ws>.db) removed so the schema rebuilds
 *    from the migrated log; restore_epoch bumped per workspace so every
 *    client wipes and full re-syncs.
 *
 * Deployment-order note: the PREVIOUS server build accepts the rewritten
 * tokens fine (its schema was any string ≤32 chars), so the migration can
 * run before the new images — but the new web/server images must ship in
 * the same window, before any old web build writes a fresh var() color.
 *
 * The dry-run is READ-ONLY and never aborts: it reports the full per-
 * workspace distribution (payload colors, icon-embedded colors, pass-through
 * hexes) plus a scan-notes list of everything it could not map. --apply
 * fails loud on any unmapped remainder (defense in depth: every rewritten
 * envelope is re-validated against the strict v3 schemas before the write).
 *
 * Idempotent: a schema_meta row marks a completed run; a second invocation
 * without --force reports "already migrated" and exits 0.
 *
 * Usage (from the repo root, stack stopped for --apply):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-color-tokens.mts \
 *     --db ../../config/notees/sync/relay.db --dry-run     # occurrence report
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-color-tokens.mts \
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
  COLOR_PRESET_TOKENS,
  envelopeSchema,
  payloadSchemaFor,
} from "../packages/protocol/src/index.ts";

type Db = InstanceType<typeof Database>;

const MARKER_KEY = "color_token_migration_v1";
const COLOR_OPS = new Set(["object.update", "class.create", "class.update"]);
const LEGACY_VAR_PATTERN = /^var\(--color-preset-([a-z]+)\)$/;

/**
 * Known legacy preset hexes → tokens (normalized to tokens by this
 * migration; any other hex stays a custom color). Three sources, all
 * drifted renderings of THE SAME preset picks:
 *  - the §34.42-pre web palette (never stored as bare hexes by web pickers,
 *    but a freeform hex input could have produced them);
 *  - ClassView's retired raw-hex class palette (#b42318 …);
 *  - the Flutter client's muted mobile palette (#c55a55 … — mobile stored
 *    resolved hexes instead of references, the drift §34.43 fixes).
 * The mobile quick-capture cream default (#f9f5e8) is NOT a preset — custom.
 */
const LEGACY_HEX_TO_TOKEN: Record<string, string> = {
  // pre-§34.42 web palette
  "#d64540": "red",
  "#e07b39": "orange",
  "#cfa70a": "yellow",
  "#219653": "green",
  "#1f8b80": "teal",
  "#336cf6": "blue",
  "#7b4ef6": "purple",
  "#d23885": "pink",
  // retired ClassView raw-hex palette
  "#b42318": "red",
  "#b54708": "orange",
  "#067647": "green",
  "#175cd3": "blue",
  "#6941c6": "purple",
  "#c11574": "pink",
  "#475467": "gray",
  // Flutter muted mobile palette
  "#c55a55": "red",
  "#c98557": "orange",
  "#b8a23a": "yellow",
  "#4f8f6a": "green",
  "#4a8a83": "teal",
  "#5a79c9": "blue",
  "#8a6cc9": "purple",
  "#c06a9a": "pink",
};

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
  /** color rewrite counts by shape */
  colorVarRefs: number;
  colorLegacyHex: number;
  hexPassThrough: number;
  iconVarRefs: number;
  /** values that did not map (reported; --apply aborts on any) */
  unmapped: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `var(--color-preset-<x>)` → `<x>`; anything else returns null. */
function tokenFromLegacyVar(value: string): string | null {
  const match = LEGACY_VAR_PATTERN.exec(value.trim());
  return match !== null ? match[1]! : null;
}

/**
 * Rewrite the retired color encodings inside one icon JSON string (both the
 * var() reference and known legacy preset hexes fold to their token).
 * Returns the NEW string when something changed, else the original. Non-JSON
 * icons and JSON without a legacy color pass through untouched.
 */
function rewriteIconColor(icon: string): { icon: string; changed: boolean; unmapped: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(icon);
  } catch {
    return { icon, changed: false, unmapped: null };
  }
  if (!isRecord(parsed) || typeof parsed.icon !== "string") {
    return { icon, changed: false, unmapped: null };
  }
  const color = parsed.color;
  if (typeof color !== "string") return { icon, changed: false, unmapped: null };
  const token = tokenFromLegacyVar(color) ?? LEGACY_HEX_TO_TOKEN[color.toLowerCase()] ?? null;
  if (token === null) return { icon, changed: false, unmapped: null };
  if (!(COLOR_PRESET_TOKENS as readonly string[]).includes(token)) {
    return { icon, changed: false, unmapped: `icon color var name "${token}"` };
  }
  // Key order is preserved by JSON round-trip (insertion-ordered string keys).
  return { icon: JSON.stringify({ ...parsed, color: token }), changed: true, unmapped: null };
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
    colorVarRefs: 0,
    colorLegacyHex: 0,
    hexPassThrough: 0,
    iconVarRefs: 0,
    unmapped: [],
  };
  if (!COLOR_OPS.has(row.op_type)) return result;

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

  const color = payload.color;
  if (color !== undefined && color !== null) {
    if (typeof color !== "string") {
      result.unmapped.push(`color is not a string (${JSON.stringify(color)})`);
    } else {
      const token = tokenFromLegacyVar(color);
      if (token !== null) {
        if (!(COLOR_PRESET_TOKENS as readonly string[]).includes(token)) {
          result.unmapped.push(`color var name "${token}"`);
        } else {
          ensure().color = token;
          result.colorVarRefs += 1;
        }
      } else {
        const legacyToken = LEGACY_HEX_TO_TOKEN[color.toLowerCase()];
        if (legacyToken !== undefined) {
          ensure().color = legacyToken;
          result.colorLegacyHex += 1;
        } else {
          // Custom hex (or a token/garbage the new schema accepts or rejects
          // loudly at validation) — no rewrite.
          result.hexPassThrough += 1;
        }
      }
    }
  }

  const icon = payload.icon;
  if (icon !== undefined && icon !== null) {
    if (typeof icon !== "string") {
      result.unmapped.push(`icon is not a string (${JSON.stringify(icon)})`);
    } else {
      const rewritten = rewriteIconColor(icon);
      if (rewritten.unmapped !== null) result.unmapped.push(rewritten.unmapped);
      if (rewritten.changed) {
        ensure().icon = rewritten.icon;
        result.iconVarRefs += 1;
      }
    }
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
      { total: number; colorVarRefs: number; colorLegacyHex: number; iconVarRefs: number; hexPassThrough: number; unmapped: number }
    >();
    const scanNotes: string[] = [];
    const plans: RowPlan[] = [];
    for (const row of rows) {
      let ws = workspaces.get(row.workspace_id);
      if (ws === undefined) {
        ws = { total: 0, colorVarRefs: 0, colorLegacyHex: 0, iconVarRefs: 0, hexPassThrough: 0, unmapped: 0 };
        workspaces.set(row.workspace_id, ws);
      }
      ws.total += 1;
      if (!COLOR_OPS.has(row.op_type)) continue;

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
      ws.colorVarRefs += result.colorVarRefs;
      ws.colorLegacyHex += result.colorLegacyHex;
      ws.iconVarRefs += result.iconVarRefs;
      ws.hexPassThrough += result.hexPassThrough;
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
        `  color var() refs → token: ${ws.colorVarRefs}; legacy preset hexes → token: ${ws.colorLegacyHex}; icon-embedded var()/hex refs: ${ws.iconVarRefs}; custom hex pass-through: ${ws.hexPassThrough}; unmapped: ${ws.unmapped}`,
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
  console.error(`migrate-color-tokens: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
