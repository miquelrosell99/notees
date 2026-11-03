/**
 * Query AST v2 one-time migration (Path B — the migrate-is-embedded
 * precedent): the stored relay log is rewritten IN PLACE (the stack must be
 * stopped; the owner is the sole user).
 *
 * The query AST grammar moved v1 → v2 (the 64-variant flat condition union
 * folds into the 6 parameterized types — comparator and target mode became
 * orthogonal wire axes). The strict schemas reject v1 outright (no dual-
 * parse anywhere), so every stored v1 AST must be rewritten before the new
 * server/web can replay the log:
 *
 *  - object.create / object.update payloads carrying `contentAst` with
 *    `query` tokens: token.queryAst v1 → v2 through the PURE mapping
 *    (scripts/lib/map-query-ast-v1-v2.ts — group/not/nested-query trees
 *    walk untouched). A token already v2 passes through; anything neither
 *    v1 nor v2 (foreign loose-union shapes) is reported — and fails loud
 *    under --apply — with the envelope id + JSON path.
 *  - Server coordination rows in the SAME relay.db: node_view.query_ast and
 *    workflow_rule.criteria JSON columns rewrite v1 → v2, each re-validated
 *    (strict schema parse + a trial compile — the query package's compile
 *    is store-free) before the write.
 *  - protocol_version stays 3 (envelope shape unchanged — a payload content
 *    rewrite, the migrate-is-embedded class).
 *  - Stale snapshots (relay rows + blob files) deleted; every derived DB
 *    (<dataDir>/derived/<ws>.db) removed so the schema rebuilds from the
 *    migrated log; restore_epoch bumped per workspace so every client wipes
 *    and full re-syncs.
 *
 * The dry-run is READ-ONLY and never aborts: it reports the per-workspace
 * distribution (including a per-v1-condition-shape histogram) plus a
 * scan-notes list of anything it could not map. --apply fails loud on any
 * unmapped remainder — except foreign tokens on envelopes VERIFIED
 * SUPERSEDED (named by id via the repeatable --accept-foreign flag; the
 * ancient bytes are never rewritten, and the accepted notes still list in
 * the report) — defense in depth holding otherwise: every rewritten
 * envelope is re-validated against the strict v3 schemas before the write.
 *
 * Idempotent: a schema_meta row marks a completed run; a second invocation
 * without --force reports "already migrated" and exits 0.
 *
 * Usage (from the repo root, stack stopped for --apply):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-query-ast-v2.mts \
 *     --data-dir ../../config/notees/sync                          # dry-run report
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-query-ast-v2.mts \
 *     --data-dir ../../config/notees/sync --apply                  # rewrite (backs up first)
 *   ... --workspace <uuid>        # restrict the rewrite + epoch bump to one workspace
 *                                   (node_view rows are GLOBAL — if any carries a v1 AST,
 *                                   a --workspace run refuses to apply; use --all)
 *   ... --db <path>               # override the relay file directly (precedent style)
 *   ... --force                   # re-run past the marker (fresh backup first)
 *   ... --accept-foreign <envelope-id>   # REPEATABLE: envelope ids whose foreign
 *                                   query tokens are VERIFIED SUPERSEDED (a later
 *                                   op replaced them — the query token is a loose
 *                                   record at apply, so history stays inert).
 *                                   Accepted foreign notes render distinctly and
 *                                   never block --apply; the ancient bytes are
 *                                   never rewritten. Unaccepted foreign still
 *                                   aborts before the backup, fail loud.
 *
 * Exit codes: 0 success (dry-run included), 1 any error.
 */

import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The script lives outside the server package, so bare specifiers do not
// resolve from here — go through the server's dependency (the same
// better-sqlite3 build the relay storage uses), mirroring
// migrate-is-embedded.mts. The deep import carries no type declarations (the
// script runs under tsx); the slice the migration uses is typed locally.
// @ts-expect-error — the deep import carries no type declarations (the
// script runs under tsx); the slice the migration uses is typed locally.
import DatabaseImport from "../apps/server/node_modules/better-sqlite3/lib/index.js";

type Db = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  pragma: (pragma: string, options?: { simple?: boolean }) => unknown;
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
  close: () => void;
};

const Database = DatabaseImport as unknown as new (
  path: string,
  options?: { readonly?: boolean },
) => Db;

import {
  envelopeSchema,
  payloadSchemaFor,
  queryAstSchema,
  safeParseQueryAst,
} from "../packages/protocol/src/index.ts";
import { compile } from "../packages/query/src/index.ts";
import {
  isQueryAstV1,
  mapQueryAstV1ToV2,
  QueryAstV1MapError,
} from "./lib/map-query-ast-v1-v2.ts";

const MARKER_KEY = "query_ast_v2_migration_v1";
const AST_OPS = new Set(["object.create", "object.update"]);

// --- arguments -------------------------------------------------------------------

function parseArgs(argv: string[]): {
  dbPath: string;
  derivedDir: string;
  snapshotsDir: string;
  apply: boolean;
  force: boolean;
  workspace: string | null;
  /** Envelope ids whose foreign query tokens are VERIFIED SUPERSEDED (repeatable). */
  acceptForeign: string[];
} {
  const args: Record<string, string | boolean | null> = {};
  const acceptForeign: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") args.apply = false;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--all") args.workspace = null;
    else if (arg === "--accept-foreign") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--accept-foreign requires a value");
      }
      acceptForeign.push(value);
      i += 1;
    } else if (arg.startsWith("--")) {
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
  // --data-dir is the primary flag (default the dev checkout's sync dir);
  // --db overrides the relay file directly (the migrate-is-embedded style).
  const dataDir = resolve(String(args["data-dir"] ?? "config/notees/sync"));
  const dbPath = args.db !== undefined ? resolve(String(args.db)) : join(dataDir, "relay.db");
  return {
    dbPath,
    derivedDir: resolve(String(args["derived-dir"] ?? join(dataDir, "derived"))),
    snapshotsDir: resolve(String(args["snapshots-dir"] ?? join(dataDir, "snapshots"))),
    apply: args.apply === true,
    force: args.force === true,
    workspace: typeof args.workspace === "string" ? args.workspace : null,
    acceptForeign,
  };
}

// --- AST classification + rewriting ----------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The v1 condition `type` histogram (the dry-run's per-shape distribution). */
function histogramV1Shapes(node: unknown, into: Map<string, number>, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => histogramV1Shapes(entry, into, `${path}[${index}]`));
    return;
  }
  if (!isRecord(node)) return;
  if (typeof node.type === "string") {
    into.set(node.type, (into.get(node.type) ?? 0) + 1);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "root" || key === "child" || key === "children") {
      histogramV1Shapes(value, into, `${path}.${key}`);
    }
  }
}

type AstDisposition =
  | { kind: "v1"; mapped: unknown; shapes: Map<string, number> }
  | { kind: "v2" }
  | { kind: "foreign" }
  | { kind: "error"; message: string };

/**
 * Classify one stored AST and map it when it is v1. v2 rows pass through
 * untouched; foreign shapes (the loose content-union carried them) and
 * unmappable v1 trees are reported — --apply fails loud on them.
 */
function dispositionOf(rawAst: unknown): AstDisposition {
  if (isQueryAstV1(rawAst)) {
    const shapes = new Map<string, number>();
    histogramV1Shapes(rawAst, shapes, "$");
    try {
      return { kind: "v1", mapped: mapQueryAstV1ToV2(rawAst), shapes };
    } catch (error) {
      const message =
        error instanceof QueryAstV1MapError
          ? `v1 AST unmappable: ${error.message}`
          : `v1 AST mapping threw: ${error instanceof Error ? error.message : String(error)}`;
      return { kind: "error", message };
    }
  }
  if (safeParseQueryAst(rawAst).success) return { kind: "v2" };
  return { kind: "foreign" };
}

/**
 * The strict v2 re-parse of a mapped token (review guard): the query token's
 * queryAst rides a LOOSE record union in the content grammar, so envelope
 * validation alone would admit a hypothetical mapper bug emitting an invalid
 * v2 shape — it would persist and fail at read time on every client. Every
 * mapped AST re-parses against the strict v2 schema HERE, before the
 * envelope-level validation, failing loud with the token path.
 */
export function assertRewrittenAstValid(mapped: unknown, where: string): void {
  const checked = safeParseQueryAst(mapped);
  if (!checked.success) {
    throw new Error(
      `${where}: mapped v1→v2 AST fails the strict v2 schema: ${checked.error.issues[0]?.message ?? "invalid"}`,
    );
  }
}

/**
 * Rewrite the v1 query ASTs inside one parsed contentAst (any carrier the
 * loose union accepted). Returns the NEW value when something changed, else
 * the original. `where` names the envelope (id + path) for fail-loud notes.
 */
function rewriteContentAst(
  contentAst: unknown,
  stats: { v1Tokens: number; v2Tokens: number; foreign: string[]; unmappable: string[] },
  where: string,
): unknown {
  if (!Array.isArray(contentAst)) return contentAst;
  let changed = false;
  const next = contentAst.map((token, index) => {
    if (!isRecord(token) || token.type !== "query" || token.queryAst === undefined) {
      return token;
    }
    const disposition = dispositionOf(token.queryAst);
    const tokenWhere = `${where} contentAst[${index}].queryAst`;
    switch (disposition.kind) {
      case "v1":
        assertRewrittenAstValid(disposition.mapped, tokenWhere);
        stats.v1Tokens += 1;
        changed = true;
        return { ...token, queryAst: disposition.mapped };
      case "v2":
        stats.v2Tokens += 1;
        return token;
      case "foreign":
        stats.foreign.push(tokenWhere);
        return token;
      case "error":
        stats.unmappable.push(`${tokenWhere}: ${disposition.message}`);
        return token;
    }
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

/** Trial-compile a rewritten server-row AST (store-free — compile builds SQL only). */
function trialCompile(label: string, ast: unknown): void {
  const parsed = queryAstSchema.safeParse(ast);
  if (!parsed.success) {
    throw new Error(
      `${label}: rewritten AST fails the strict v2 schema: ${parsed.error.issues[0]?.message}`,
    );
  }
  try {
    compile(parsed.data);
  } catch (error) {
    throw new Error(
      `${label}: rewritten AST fails the trial compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// --- storage shapes ----------------------------------------------------------------

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

interface ServerRowPlan {
  table: "node_view" | "workflow_rule";
  id: string;
  workspaceId: string | null;
  value: string;
}

interface WorkspaceStats {
  total: number;
  v1Tokens: number;
  v2Tokens: number;
  foreign: number;
  unmapped: number;
}

/** Build the rewrite plan for one stored envelope row (plan null = payload unchanged). */
function planRow(
  row: StoredRow,
  workspaceFilter: string | null,
  stats: WorkspaceStats,
  notes: string[],
  plans: RowPlan[],
  acceptedNotes: string[],
  acceptedForeign: ReadonlySet<string>,
): void {
  if (!AST_OPS.has(row.op_type)) return;
  if (workspaceFilter !== null && row.workspace_id !== workspaceFilter) return;

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new Error(`envelope seq ${row.seq}: payload is not valid JSON`);
  }
  if (!isRecord(payload)) {
    throw new Error(`envelope seq ${row.seq}: payload is not an object`);
  }
  if (payload.contentAst === undefined) return;

  const tokenStats = { v1Tokens: 0, v2Tokens: 0, foreign: [] as string[], unmappable: [] as string[] };
  const rewritten = rewriteContentAst(payload.contentAst, tokenStats, `envelope ${row.id} seq ${row.seq}:`);
  stats.v1Tokens += tokenStats.v1Tokens;
  stats.v2Tokens += tokenStats.v2Tokens;
  stats.foreign += tokenStats.foreign.length;
  stats.unmapped += tokenStats.unmappable.length;
  for (const note of tokenStats.foreign) {
    // A foreign token on a VERIFIED-SUPPERSEDED envelope (a later op replaced
    // it — the query token is a loose record at apply, so history stays
    // inert) may be accepted by envelope id; accepted notes render
    // distinctly and never block --apply. Anything else stays blocking.
    const envelopeId = /^envelope ([0-9a-f-]{36})/.exec(note)?.[1];
    if (envelopeId !== undefined && acceptedForeign.has(envelopeId)) {
      acceptedNotes.push(note);
    } else {
      notes.push(`${note}: neither v1 nor v2 — left untouched`);
    }
  }
  for (const note of tokenStats.unmappable) {
    notes.push(`envelope ${row.id} seq ${row.seq}: ${note}`);
  }

  if (rewritten === payload.contentAst) return;
  const next = { ...payload, contentAst: rewritten };
  validateRewritten(row, next);
  plans.push({ seq: row.seq, workspaceId: row.workspace_id, payload: next });
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

    const hasTable = (name: string): boolean =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

    // Scan + plan the envelope log. In apply mode planning is strict: anything
    // unmapped throws BEFORE the backup/write. In dry-run mode problems are
    // collected as scan notes and the full distribution still prints (exit 0).
    const rows = db.prepare("SELECT * FROM envelope ORDER BY seq ASC").all() as unknown as StoredRow[];
    const workspaces = new Map<string, WorkspaceStats>();
    const scanNotes: string[] = [];
    const acceptedNotes: string[] = [];
    const acceptedForeign = new Set(options.acceptForeign);
    const plans: RowPlan[] = [];
    const shapeHistogram = new Map<string, number>();
    for (const row of rows) {
      if (options.workspace === null || row.workspace_id === options.workspace) {
        let ws = workspaces.get(row.workspace_id);
        if (ws === undefined) {
          ws = { total: 0, v1Tokens: 0, v2Tokens: 0, foreign: 0, unmapped: 0 };
          workspaces.set(row.workspace_id, ws);
        }
        ws.total += 1;
      }
      const stats: WorkspaceStats =
        workspaces.get(row.workspace_id) ??
        { total: 0, v1Tokens: 0, v2Tokens: 0, foreign: 0, unmapped: 0 };
      const before = stats.v1Tokens;
      planRow(row, options.workspace, stats, scanNotes, plans, acceptedNotes, acceptedForeign);
      const rewritten = stats.v1Tokens - before;
      if (options.workspace === null || row.workspace_id === options.workspace) {
        workspaces.set(row.workspace_id, stats);
      }
      if (rewritten > 0) {
        // Accumulate the v1 shape distribution from the mapped tokens.
        const payload = JSON.parse(row.payload) as { contentAst?: unknown };
        if (payload.contentAst !== undefined && Array.isArray(payload.contentAst)) {
          for (const token of payload.contentAst) {
            if (isRecord(token) && token.type === "query" && isQueryAstV1(token.queryAst)) {
              histogramV1Shapes(token.queryAst, shapeHistogram, "$");
            }
          }
        }
      }
    }

    // Plan the server coordination rows (same DB).
    const serverPlans: ServerRowPlan[] = [];
    const serverNotes: string[] = [];
    if (hasTable("node_view")) {
      const viewRows = db
        .prepare("SELECT id, node_id, query_ast FROM node_view")
        .all() as unknown as Array<{ id: string; node_id: string; query_ast: string }>;
      for (const row of viewRows) {
        let raw: unknown;
        try {
          raw = JSON.parse(row.query_ast);
        } catch {
          if (options.apply) throw new Error(`node_view ${row.id}: query_ast is not valid JSON`);
          serverNotes.push(`node_view ${row.id}: query_ast is not valid JSON`);
          continue;
        }
        const disposition = dispositionOf(raw);
        const label = `node_view ${row.id} (node ${row.node_id})`;
        if (disposition.kind === "v1") {
          if (options.workspace !== null) {
            // node_view rows are GLOBAL (the table has no workspace column)
            // yet carry per-workspace ASTs: a --workspace run that rewrote
            // them while other workspaces' envelopes stay v1 would open a
            // mixed v1/v2 window the flag promises against. Fail loud; the
            // dry run reports the same as a scan note.
            const note =
              `${label} carries a v1 AST but node_view rows are global (no workspace column) — ` +
              "a --workspace run cannot rewrite them without a mixed v1/v2 window. " +
              "Re-run with --all (or drop --workspace) so every workspace converges in one pass.";
            if (options.apply) throw new Error(note);
            serverNotes.push(note);
            continue;
          }
          trialCompile(label, disposition.mapped);
          serverPlans.push({ table: "node_view", id: row.id, workspaceId: null, value: JSON.stringify(disposition.mapped) });
        } else if (disposition.kind === "error") {
          if (options.apply) throw new Error(`${label}: ${disposition.message}`);
          serverNotes.push(`${label}: ${disposition.message}`);
        } else if (disposition.kind === "foreign") {
          const note = `${label}: neither v1 nor v2 — left untouched`;
          if (options.apply) throw new Error(note);
          serverNotes.push(note);
        }
      }
    }
    if (hasTable("workflow_rule")) {
      const ruleRows = db
        .prepare("SELECT id, workspace_id, criteria FROM workflow_rule")
        .all() as unknown as Array<{ id: string; workspace_id: string; criteria: string }>;
      for (const row of ruleRows) {
        if (options.workspace !== null && row.workspace_id !== options.workspace) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(row.criteria);
        } catch {
          if (options.apply) throw new Error(`workflow_rule ${row.id}: criteria is not valid JSON`);
          serverNotes.push(`workflow_rule ${row.id}: criteria is not valid JSON`);
          continue;
        }
        const disposition = dispositionOf(raw);
        const label = `workflow_rule ${row.id} (workspace ${row.workspace_id})`;
        if (disposition.kind === "v1") {
          trialCompile(label, disposition.mapped);
          serverPlans.push({ table: "workflow_rule", id: row.id, workspaceId: row.workspace_id, value: JSON.stringify(disposition.mapped) });
        } else if (disposition.kind === "error") {
          if (options.apply) throw new Error(`${label}: ${disposition.message}`);
          serverNotes.push(`${label}: ${disposition.message}`);
        } else if (disposition.kind === "foreign") {
          const note = `${label}: neither v1 nor v2 — left untouched`;
          if (options.apply) throw new Error(note);
          serverNotes.push(note);
        }
      }
    }

    const snapshotRows = (
      db.prepare("SELECT id, workspace_id FROM snapshot").all() as unknown as Array<{
        id: string;
        workspace_id: string;
      }>
    ).filter((row) => options.workspace === null || row.workspace_id === options.workspace);
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
        )
          .map((row) => row.workspace_id)
          .filter((id) => options.workspace === null || id === options.workspace),
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
        `  query tokens: v1 → v2 rewritten=${ws.v1Tokens}; already v2 (passed through)=${ws.v2Tokens}; foreign=${ws.foreign}; unmapped=${ws.unmapped}`,
      );
    }
    if (shapeHistogram.size > 0) {
      console.log("v1 condition-shape distribution (across rewritten tokens):");
      for (const [shape, count] of [...shapeHistogram.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${shape}: ${count}`);
      }
    }
    console.log(`envelope payload rewrites planned: ${plans.length}`);
    console.log(`server rows to rewrite: node_view=${serverPlans.filter((p) => p.table === "node_view").length}; workflow_rule=${serverPlans.filter((p) => p.table === "workflow_rule").length}`);
    console.log(`protocol_version: unchanged (3)`);
    console.log(`snapshots to drop: ${snapshotRows.length} row(s) + blob file(s)`);
    console.log(`derived DB files to remove: ${derivedFiles.length} under ${options.derivedDir}`);
    console.log(`restore_epoch bump: ${epochWorkspaces.length} workspace(s)`);
    const allNotes = [...scanNotes, ...serverNotes];
    if (allNotes.length > 0) {
      console.log(`scan notes (${allNotes.length} occurrence(s) need attention before --apply):`);
      for (const note of allNotes.slice(0, 50)) console.log(`  ${note}`);
      if (allNotes.length > 50) console.log(`  … and ${allNotes.length - 50} more`);
    }
    if (acceptedNotes.length > 0) {
      console.log(`foreign (accepted, superseded) — verified by envelope id, never rewritten, not blocking:`);
      for (const note of acceptedNotes.slice(0, 50)) console.log(`  ${note}`);
      if (acceptedNotes.length > 50) console.log(`  … and ${acceptedNotes.length - 50} more`);
    }

    if (!options.apply) {
      console.log("dry-run only — no writes. Re-run with --apply to execute (a timestamped backup is written first).");
      return;
    }

    // Fail loud on any unmapped remainder BEFORE the backup/write (the dry
    // run reported them as scan notes; apply refuses to leave them behind).
    if (allNotes.length > 0) {
      throw new Error(
        `${allNotes.length} unmapped occurrence(s) — resolve before --apply:\n  ${allNotes.slice(0, 10).join("\n  ")}${allNotes.length > 10 ? `\n  … and ${allNotes.length - 10} more` : ""}`,
      );
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
      const updateView = db.prepare("UPDATE node_view SET query_ast = ? WHERE id = ?");
      const updateRule = db.prepare("UPDATE workflow_rule SET criteria = ? WHERE id = ?");
      for (const plan of serverPlans) {
        if (plan.table === "node_view") updateView.run(plan.value, plan.id);
        else updateRule.run(plan.value, plan.id);
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
          serverRowRewrites: serverPlans.length,
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
    console.log(`  server rows rewritten: ${serverPlans.length} (node_view + workflow_rule)`);
    console.log(`  snapshot rows dropped: ${snapshotRows.length}; blob files removed: ${blobsRemoved}`);
    console.log(`  derived DB files removed: ${derivedRemoved}/${derivedFiles.length}`);
    console.log(`  restore_epoch bumped for ${epochWorkspaces.length} workspace(s)`);
    console.log(`  marker written: ${MARKER_KEY}`);
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`migrate-query-ast-v2: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
