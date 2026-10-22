/**
 * Batch migration orchestrator — pay the stopped-stack / backup /
 * rehydration window ONCE for every pending stored-log migration
 * (the migrate-is-embedded / migrate-node-type class of one-time rewrites,
 * docs/developers/migrations.md kind B).
 *
 * The pain of running scripts/migrate-*.mts one at a time is not the rewrite
 * — it is everything around it: the stack must stop (relay.db is never edited
 * while the sync server runs), every apply writes a fresh backup, snapshots +
 * server derived DBs are purged, restore_epoch is bumped, and every client
 * full re-syncs. That cycle costs the same whether one migration runs or five.
 * This orchestrator surveys the schema_meta idempotency markers, reports what
 * is pending, and in --apply mode runs every pending entry's own --apply in
 * ONE window (the individual scripts still do their own backup / epoch bump —
 * harmless multiples within the same window).
 *
 * THE REGISTRY CONTRACT: any new scripts/migrate-*.mts that rewrites the
 * stored log must add an entry to MIGRATION_REGISTRY below — { script, the
 * script's own MARKER_KEY, kind }. kind classification: "rewrite" when the
 * script rewrites envelopes (replay divergence — needs the stopped stack and
 * the epoch bump); "marker-only" when it only backfills/marks with no replay
 * divergence (safe with the stack up). The orchestrator cannot track scripts
 * without a schema_meta marker row — their idempotency is "the plan is empty",
 * not a recorded fact — so they stay per-script invocations (below).
 *
 * REGISTRY + EXCLUSIONS (surveyed 2026-10-22, every scripts/migrate-*.mts):
 *  - migrate-node-type.mts, migrate-color-tokens.mts, migrate-is-embedded.mts,
 *    migrate-class-delete.mts — the only marker-keyed rewrite scripts; all
 *    four registered below, kind "rewrite".
 *  - repair-log-conformance.mts — a REPAIR tool (owner directive "repair the
 *    log"), not a pending-check migration: it diagnoses poison the relay
 *    accepted (full scratch replay), carries no marker key, and its window
 *    closes when the log replays clean. Excluded.
 *  - remap-reunion-evento.mts — a one-shot workspace-specific class remap
 *    (owner ruling 2026-10-04), no marker key. Excluded.
 *  - every other migrate-*.mts — no schema_meta marker row (their idempotency
 *    is plan-nothing: "nothing to rewrite"); the orchestrator cannot classify
 *    them pending vs applied, so a batch run could not order them. Both the
 *    append-only kind-A scripts (system-names, task-status-styles, …) and the
 *    pre-marker kind-B rewrites (binding-flags-to-schema, unified-datetime,
 *    property-scope, …) stay per-script invocations.
 *
 * SAFETY (the repo law): --apply NEVER touches relay.db while the notees-sync
 * stack is up. Before any child runs, the orchestrator execs
 * `docker compose ps notees-sync --status running` in the compose project dir
 * (NOTEES_STACK_DIR, else /etc/periphery/stacks/notees when present, else the
 * cwd) and ABORTS with instructions if the container runs. The orchestrator
 * itself never writes the relay DB — pending detection is strictly read-only,
 * and every actual rewrite is delegated to the entry script's own --apply.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-pending.mts \
 *     --db ../../config/notees/sync/relay.db                  # report (read-only)
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-pending.mts \
 *     --db ../../config/notees/sync/relay.db --dry-run        # + each pending script's own dry-run
 *   docker compose stop notees-sync   # FIRST — apply refuses while it runs
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-pending.mts \
 *     --db ../../config/notees/sync/relay.db --apply         # run all pending (stops on first failure)
 *   docker compose up -d              # one rehydration for the whole batch
 *
 * Exit codes: 0 nothing pending / all applied, 1 any failure or the safety
 * abort (stack running under --apply without --assume-stopped).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface MigrationEntry {
  script: string;
  markerKey: string;
  kind: "rewrite" | "marker-only";
}

/**
 * One entry per marker-keyed migration script, oldest first (a multi-entry
 * pending batch replays in historical order). See the header contract — a new
 * migrate-*.mts MUST add its entry here.
 */
export const MIGRATION_REGISTRY: readonly MigrationEntry[] = [
  { script: "migrate-node-type.mts", markerKey: "revision_11_node_type_migration", kind: "rewrite" },
  { script: "migrate-color-tokens.mts", markerKey: "color_token_migration_v1", kind: "rewrite" },
  { script: "migrate-is-embedded.mts", markerKey: "is_embedded_migration_v1", kind: "rewrite" },
  { script: "migrate-class-delete.mts", markerKey: "class_delete_migration_v1", kind: "rewrite" },
];

export interface PendingItem {
  entry: MigrationEntry;
  status: "pending" | "applied";
}

/**
 * Pure pending classification: an entry is applied iff its marker key is in
 * the marker set read from schema_meta (an absent table yields the empty set —
 * everything is pending on a fresh DB).
 */
export function planPendingMigrations(
  registry: readonly MigrationEntry[],
  presentMarkers: ReadonlySet<string>,
): PendingItem[] {
  return registry.map((entry) => ({
    entry,
    status: presentMarkers.has(entry.markerKey) ? "applied" : "pending",
  }));
}

// --- seams (the store's unit tests inject fakes; main() uses the defaults) -------

interface MarkerDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(): unknown[] };
  close(): void;
}

/** Read the applied marker keys from schema_meta — strictly read-only. */
export async function readPresentMarkers(dbPath: string): Promise<Set<string>> {
  // Lazy + non-literal on purpose, mirroring the sibling scripts: TypeScript
  // cannot (and need not) resolve types through the server's nested
  // node_modules.
  const driverPath = "../apps/server/node_modules/better-sqlite3/lib/index.js";
  const { default: Database } = (await import(driverPath)) as unknown as {
    default: new (filename: string, options?: { readonly?: boolean }) => MarkerDb;
  };
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
      .get();
    if (table === undefined) return new Set();
    const rows = db.prepare("SELECT key FROM schema_meta").all() as Array<{ key: string }>;
    return new Set(rows.map((row) => row.key));
  } finally {
    db.close();
  }
}

export type SyncRunningCheck = (stackDir: string) => Promise<boolean>;

/**
 * True when a notees-sync container reports running in the compose project.
 * Fails CLOSED: a docker error (daemon down, compose file missing) is an
 * abort, never a green light — the operator re-runs with --assume-stopped
 * after verifying the stack by hand.
 */
export const isNoteesSyncRunning: SyncRunningCheck = (stackDir) =>
  new Promise((resolvePromise) => {
    execFile(
      "docker",
      ["compose", "ps", "notees-sync", "--status", "running", "--format", "json"],
      { cwd: stackDir, timeout: 15_000 },
      (error, stdout) => {
        if (error !== null) {
          console.error(
            `migrate-pending: could not inspect the stack (${error.message}) — ` +
              "refusing to guess. Verify the stack is stopped by hand, then re-run with --assume-stopped.",
          );
          resolvePromise(true);
          return;
        }
        resolvePromise(stdout.trim().length > 0 && stdout.trim() !== "[]");
      },
    );
  });

export interface ChildResult {
  code: number;
  output: string;
}

export type ScriptRunner = (script: string, args: string[]) => Promise<ChildResult>;

/**
 * Run one entry script through the house invocation (same as the per-script
 * docs: `pnpm --filter @notees/server exec tsx ../../scripts/<script> …`),
 * from the repo root, capturing the child's output for the report.
 */
export const runScript: ScriptRunner = (script, args) =>
  new Promise((resolvePromise, reject) => {
    const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const scriptRel = `../../scripts/${script}`;
    execFile(
      "pnpm",
      ["--filter", "@notees/server", "exec", "tsx", scriptRel, ...args],
      { cwd: repoRoot, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null && typeof (error as { code?: unknown }).code !== "number") {
          reject(new Error(`failed to launch ${script}: ${error.message}`));
          return;
        }
        const code = (error as { code?: number } | null)?.code ?? 0;
        resolvePromise({ code, output: [stdout, stderr].join("").trim() });
      },
    );
  });

// --- orchestration ----------------------------------------------------------------

export interface OrchestratorOptions {
  dbPath: string;
  apply: boolean;
  assumeStopped: boolean;
  force: boolean;
  stackDir: string;
  /** Seams — the unit tests inject fakes; main() passes the defaults. */
  checkSyncRunning?: SyncRunningCheck;
  runChild?: ScriptRunner;
}

function resolveStackDir(): string {
  if (process.env.NOTEES_STACK_DIR !== undefined && process.env.NOTEES_STACK_DIR !== "") {
    return process.env.NOTEES_STACK_DIR;
  }
  const fleetStack = "/etc/periphery/stacks/notees";
  return existsSync(fleetStack) ? fleetStack : process.cwd();
}

/** Run the orchestrator; returns the process exit code (0 / 1). */
export async function runMigratePending(options: OrchestratorOptions): Promise<number> {
  const checkSyncRunning = options.checkSyncRunning ?? isNoteesSyncRunning;
  const runChild = options.runChild ?? runScript;
  const pending = planPendingMigrations(MIGRATION_REGISTRY, await readPresentMarkers(options.dbPath));
  const pendingRewrites = pending.filter((p) => p.status === "pending" && p.entry.kind === "rewrite");
  const pendingMarkers = pending.filter((p) => p.status === "pending" && p.entry.kind === "marker-only");

  // Report.
  console.log(`relay DB: ${options.dbPath}`);
  console.log(`mode: ${options.apply ? "APPLY" : "DRY-RUN (read-only)"}${options.force ? " (forced)" : ""}`);
  for (const item of pending) {
    console.log(`${item.status === "pending" ? "PENDING " : "applied "} ${item.entry.script} (${item.entry.markerKey}, ${item.entry.kind})`);
  }
  if (pending.every((p) => p.status === "applied")) {
    console.log("nothing pending — the stored log carries every migration marker.");
    return 0;
  }

  const childArgs = (mode: "--dry-run" | "--apply"): string[] => {
    const args = ["--db", options.dbPath, mode];
    if (options.force) args.push("--force");
    return args;
  };

  if (!options.apply) {
    // Read-only overall: each pending rewrite entry reports through its own
    // --dry-run (a child, same tsx runner); marker-only entries need no child.
    for (const item of pendingRewrites) {
      console.log(`\n--- ${item.entry.script} --dry-run ---`);
      const result = await runChild(item.entry.script, childArgs("--dry-run"));
      if (result.output.length > 0) console.log(result.output);
      if (result.code !== 0) {
        console.error(`migrate-pending: ${item.entry.script} dry-run exited ${result.code}`);
        return 1;
      }
    }
    if (pendingMarkers.length > 0) {
      console.log(`\nmarker-only entries pending (backfill, no replay divergence):`);
      for (const item of pendingMarkers) console.log(`  ${item.entry.script} — run its --apply with the stack UP`);
    }
    console.log("\ndry-run only — no writes. Stop the stack, then re-run with --apply to execute the batch.");
    return 0;
  }

  // SAFETY FIRST — never edit relay.db while the sync server runs.
  if (!options.assumeStopped && (await checkSyncRunning(options.stackDir))) {
    console.error(
      "\nmigrate-pending: ABORTED — the notees-sync stack reports RUNNING; relay.db must never be " +
        "edited while the server is up.\n" +
        "  1. docker compose stop notees-sync\n" +
        "  2. re-run this command (the check re-runs), or pass --assume-stopped once you have " +
        "verified the container is down by hand\n" +
        "  3. after the batch: docker compose up -d  (one rehydration for everything pending)",
    );
    return 1;
  }
  if (options.assumeStopped) {
    console.log("stack stop ASSUMED (--assume-stopped) — the notees-sync container is not running.");
  }

  // Rewrite entries: sequential, stop on first failure. Each child does its
  // own timestamped backup + quick_check + epoch bump — harmless multiples
  // inside the one window; the orchestrator itself never writes the DB.
  for (const item of pendingRewrites) {
    console.log(`\n=== applying ${item.entry.script} ===`);
    const result = await runChild(item.entry.script, childArgs("--apply"));
    if (result.output.length > 0) console.log(result.output);
    if (result.code !== 0) {
      console.error(
        `migrate-pending: ${item.entry.script} --apply exited ${result.code} — batch HALTED; ` +
          "later entries were NOT run (the failed entry made no marker, so a re-run resumes here). " +
          "The stack stays down until this is resolved.",
      );
      return 1;
    }
  }
  // Marker-only entries backfill without replay divergence — safe now, and
  // they do not need the stopped stack (only rewrites did).
  for (const item of pendingMarkers) {
    console.log(`\n=== applying ${item.entry.script} (marker-only) ===`);
    const result = await runChild(item.entry.script, childArgs("--apply"));
    if (result.output.length > 0) console.log(result.output);
    if (result.code !== 0) {
      console.error(`migrate-pending: ${item.entry.script} --apply exited ${result.code} — batch HALTED.`);
      return 1;
    }
  }

  console.log(
    "\nbatch complete — every pending migration applied in this window.\n" +
      "restart to rehydrate once:  docker compose up -d\n" +
      "every client full re-syncs (restore_epoch bumped); verify per docs/developers/migrations.md §1.8.",
  );
  return 0;
}

// --- arguments --------------------------------------------------------------------

function parseArgs(argv: string[]): {
  dbPath: string;
  apply: boolean;
  assumeStopped: boolean;
  force: boolean;
  stackDir: string;
} {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") args.apply = false;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--assume-stopped") args.assumeStopped = true;
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
  if (args.db === undefined) {
    throw new Error("--db <path> is required (the relay DB)");
  }
  return {
    dbPath: resolve(String(args.db)),
    apply: args.apply === true,
    assumeStopped: args.assumeStopped === true,
    force: args.force === true,
    stackDir: String(args["stack-dir"] ?? resolveStackDir()),
  };
}

// Run only when executed directly (tsx …/migrate-pending.mts); the store's
// unit tests import the planner + runMigratePending without touching the
// relay DB.
const invokedAsMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  main().catch((error) => {
    console.error(`migrate-pending: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  process.exitCode = await runMigratePending(options);
}
