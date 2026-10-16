/**
 * Parent-page condition migration (owner ruling 2026-10-15): a parented node
 * renders with document chrome ONLY when present_as_main = 1 AND its parent
 * renders with document chrome. The store enforces the rule write-time from
 * this slice on (MoveGuardError on create/promotion/move under a non-page
 * parent, and on demoting a parented page that still carries main children) —
 * but state written under the old permissive model can carry the bit under a
 * class or an inline-block parent (legal then; the bit simply won there).
 * This script converges every workspace onto the new rule:
 *
 *  - SNAPSHOT-BAKED violations: the relay prunes covered envelopes on
 *    compaction (POST /compact), so a violation born below the snapshot
 *    horizon has no surviving op to rewrite — its state lives in the snapshot
 *    bytes. The latest snapshot is restored into a scratch store, violating
 *    rows are found by scanning the parent chains, and the bit is cleared by
 *    direct derived-state surgery (UPDATE node — the class-chip-rename
 *    byte-patch precedent; the bit is not indexed, so no reindex). The
 *    patched bytes REPLACE the snapshot blob (same id, same up_to_seq).
 *  - TAIL violations: envelopes after the snapshot are walked through the NEW
 *    applier; a create/promotion claiming presentAsMain: true while the as-of
 *    parent is not a page is rewritten in place (payload true → false; the
 *    bit was inert under the new rule anyway). The walk applies the mutated
 *    envelope to its scratch store so as-of state stays true to the
 *    post-rewrite log — children of a rewritten node are evaluated against
 *    exactly the state a fresh hydrate sees.
 *  - Historical move/demote-class MoveGuardErrors the new guards add (a main
 *    node moved under a then-legal non-page parent; a parented page demoted
 *    with then-legal main children) are NOT rewritten: they replay-quarantine
 *    like every other old-era guard breach (Store.applyMany's
 *    quarantineMoveGuards — the date-chain-locks precedent), leaving
 *    convergent, valid state. They are recorded so the operator sees the
 *    retroactive no-ops, and they make the workspace affected (every replica
 *    must resync to converge on the quarantine).
 *
 * VERIFY (both modes): a fresh scratch store restores the PATCHED snapshot
 * and replays the rewritten tail through applyMany({quarantineMoveGuards:
 * true}) — the real hydrate shape — which must throw nothing; the quarantined
 * set must be exactly the recorded skips; and the final state must carry ZERO
 * violating rows (every present_as_main = 1 row's parent chain reaches a
 * parentless non-class node without crossing a class or a bit-0 row).
 *
 * DRY RUN BY DEFAULT and safe while the stack is UP (read-only). --apply
 * REQUIRES THE STACK STOPPED: it backs up relay.db, rewrites the tail
 * payloads + the snapshot blob in one transaction, bumps the affected
 * workspaces' restore_epoch so every client wipes and full re-syncs, deletes
 * their server derived DBs (they carry pre-migration state; the next hydrate
 * rebuilds them from the patched snapshot + rewritten tail), and prints the
 * restart instruction.
 *
 * Idempotent: a re-run plans nothing against a converged workspace (no baked
 * rows, no tail rewrites, no skips → no writes, no epoch bump).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-main-parent-page.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync, existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The script lives outside the server package, so the bare specifier does not
// resolve from here — go through the server's dependency (the same
// better-sqlite3 build the relay storage uses). The require returns `any`;
// the CLI apply-phase types it structurally below (the planning core takes a
// MigrationStore, never this handle).
const requireFromHere = createRequire(import.meta.url);
const Database = requireFromHere("../apps/server/node_modules/better-sqlite3/lib/index.js") as new (
  path: string,
  options?: { readonly?: boolean },
) => SqliteDb;

/** The better-sqlite3 surface the CLI apply-phase uses (typed structurally —
 *  the driver's own types resolve only inside the server package). */
interface SqliteStatement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): unknown;
}
interface SqliteDb {
  pragma(pragma: string, options?: { simple?: boolean }): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction(fn: () => void): () => void;
  close(): void;
}

import { envelopeSchema, payloadSchemaFor, type Envelope } from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { MoveGuardError } from "../packages/store/src/errors.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

/** The scratch-store shape the migration core needs. Structural on purpose:
 *  the test suite passes the package (dist) Store while the script builds the
 *  source Store — both satisfy this (a src/dist type identity would couple
 *  the pinned test to the dev-condition build state). */
export interface MigrationStore {
  apply(input: unknown): unknown;
  applyMany(
    inputs: unknown[],
    options?: { quarantineMoveGuards?: boolean },
  ): Array<{ quarantined?: boolean }>;
  getNode(id: string): unknown;
  database: { prepare(sql: string): SqliteStatement; exec(sql: string): void };
  restore?(bytes: Uint8Array): void;
  close(): void;
}

// --- violation scan + correction (exported; pinned by
// --- apps/web/test/migrate-main-parent-page.test.ts) -----------------------------------

interface RenderRow {
  id: string;
  parent_id: string | null;
  is_class: number;
  present_as_main: number;
}

/**
 * The ids of every row that violates the stored parent-page invariant:
 * present_as_main = 1 but the parent chain does not reach a parentless
 * non-class node through bit-set parents only (a class or a bit-0 row in the
 * chain makes the bit inert). Evaluated against the CURRENT store state, so
 * one pass flags the whole violating set — a violating parent's children are
 * flagged with it (their chains fail at the same place).
 */
export function violatingRowIds(store: MigrationStore): string[] {
  const rows = store.database
    .prepare("SELECT id, parent_id, is_class, present_as_main FROM node")
    .all() as unknown as RenderRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const violating: string[] = [];
  for (const row of rows) {
    if (row.is_class === 1 || row.present_as_main !== 1 || row.parent_id === null) continue;
    const seen = new Set<string>([row.id]);
    let cursor = byId.get(row.parent_id);
    let ok = false;
    while (cursor !== undefined && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      if (cursor.is_class === 1) break; // a class is not a page
      if (cursor.parent_id === null) {
        ok = true; // parentless non-class = a page
        break;
      }
      if (cursor.present_as_main !== 1) break; // the chain crossed a block
      cursor = byId.get(cursor.parent_id);
    }
    if (!ok) violating.push(row.id);
  }
  return violating;
}

/** The snapshot-baked correction: clear the render bit directly (derived
 *  surgery — the bit is not indexed, so no reindex; stats carry no bit). */
export function clearPresentAsMain(store: MigrationStore, ids: string[]): void {
  const update = store.database.prepare("UPDATE node SET present_as_main = 0 WHERE id = ?");
  for (const id of ids) update.run(id);
}

/** The number of violating rows still in the store (the verify bar: zero). */
export function countViolatingRows(store: MigrationStore): number {
  return violatingRowIds(store).length;
}

// NOTE the bulk-replay helper indexes this script created locally during its
// first run (mig_alias / mig_child_order_child) SHIPPED into the real schema
// as the v20 read indexes (idx_node_aliased_source /
// idx_node_child_order_child, owner 2026-10-16 — the parent-page dry-run
// profiled both full scans) — Store.open/restore migrates every scratch
// store to v20, so the migration needs no local indexes anymore.

// --- tail walk ------------------------------------------------------------------------

export interface Rewrite {
  /** Positional index into the walked tail (0-based). */
  tailIndex: number;
  workspaceId: string;
  opType: string;
  objectId: string;
  parentId: string | null;
}

export interface Skip {
  tailIndex: number;
  workspaceId: string;
  opType: string;
  message: string;
}

export interface UnexpectedThrow {
  tailIndex: number;
  workspaceId: string;
  opType: string;
  message: string;
}

export interface MainParentPagePlan {
  rewrites: Rewrite[];
  skips: Skip[];
  unexpected: UnexpectedThrow[];
}

/** True when the payload claims the render bit (the only rewritable breach shape). */
function setsPresentAsMain(envelope: Envelope): boolean {
  const opType = envelope.opType;
  if (opType !== "object.create" && opType !== "object.update") return false;
  return (envelope.payload as Record<string, unknown>).presentAsMain === true;
}

/**
 * Walk the log TAIL, in order, through a scratch store already carrying the
 * (corrected) snapshot state and running the NEW applier. Violating set-bit
 * envelopes are applied MUTATED (bit cleared) so the walk's as-of state
 * equals the post-rewrite log's state; every other MoveGuardError is a
 * recorded skip (replay-quarantined on hydrate); anything that is not a
 * MoveGuardError is unexpected and blocks --apply.
 */
export function walkMainParentPage(
  tailEnvelopes: Envelope[],
  store: MigrationStore,
  onProgress?: (applied: number) => void,
): MainParentPagePlan {
  const plan: MainParentPagePlan = { rewrites: [], skips: [], unexpected: [] };
  for (const [tailIndex, envelope] of tailEnvelopes.entries()) {
    if (onProgress !== undefined && tailIndex > 0 && tailIndex % 5000 === 0) {
      onProgress(tailIndex);
    }
    try {
      store.apply(envelope);
      continue;
    } catch (error) {
      const payload = envelope.payload as Record<string, unknown>;
      if (!(error instanceof MoveGuardError)) {
        plan.unexpected.push({
          tailIndex,
          workspaceId: envelope.workspaceId,
          opType: envelope.opType,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!setsPresentAsMain(envelope)) {
        // Historical move/demote-class breach: replay-quarantined, not rewritten.
        plan.skips.push({
          tailIndex,
          workspaceId: envelope.workspaceId,
          opType: envelope.opType,
          message: error.message,
        });
        continue;
      }
      const mutatedPayload = { ...payload, presentAsMain: false };
      const schema = payloadSchemaFor(envelope.opType);
      if (schema === undefined) {
        plan.unexpected.push({
          tailIndex,
          workspaceId: envelope.workspaceId,
          opType: envelope.opType,
          message: "no payload schema for the op type",
        });
        continue;
      }
      const checked = schema.safeParse(mutatedPayload);
      if (!checked.success) {
        plan.unexpected.push({
          tailIndex,
          workspaceId: envelope.workspaceId,
          opType: envelope.opType,
          message: `mutated payload fails the strict schema: ${checked.error.issues[0]?.message ?? "unknown"}`,
        });
        continue;
      }
      try {
        store.apply({ ...envelope, payload: mutatedPayload });
      } catch (error2) {
        plan.unexpected.push({
          tailIndex,
          workspaceId: envelope.workspaceId,
          opType: envelope.opType,
          message: `mutated envelope still throws: ${error2 instanceof Error ? error2.message : String(error2)}`,
        });
        continue;
      }
      plan.rewrites.push({
        tailIndex,
        workspaceId: envelope.workspaceId,
        opType: envelope.opType,
        objectId: String(payload.objectId ?? ""),
        parentId: (payload.parentId as string | null | undefined) ?? null,
      });
    }
  }
  return plan;
}

/**
 * The real-hydrate acceptance bar: a fresh scratch store restores the PATCHED
 * snapshot bytes (null = the workspace has no snapshot) and replays the
 * rewritten tail through applyMany({quarantineMoveGuards: true}) — the shape
 * every hydrate uses — without a non-quarantine throw; the quarantined set is
 * exactly the recorded skips; and the final state carries zero violating
 * rows.
 */
export function verifyMainParentPage(
  tailEnvelopes: Envelope[],
  plan: MainParentPagePlan,
  patchedSnapshotBytes: Uint8Array | null,
  openStore: () => MigrationStore,
): { quarantined: number; violatingRows: number } {
  const rewritten = tailEnvelopes.map((envelope, tailIndex) => {
    const rewrite = plan.rewrites.find((r) => r.tailIndex === tailIndex);
    if (rewrite === undefined) return envelope;
    return { ...envelope, payload: { ...(envelope.payload as Record<string, unknown>), presentAsMain: false } };
  });
  const store = openStore();
  try {
    if (patchedSnapshotBytes !== null) {
      if (store.restore === undefined) throw new Error("the verify store cannot restore snapshot bytes");
      store.restore(patchedSnapshotBytes);
    }
    const summaries = store.applyMany(rewritten, { quarantineMoveGuards: true });
    const quarantined = summaries.filter((s) => s.quarantined === true).length;
    return { quarantined, violatingRows: countViolatingRows(store) };
  } finally {
    store.close();
  }
}

// --- relay snapshot + tail ------------------------------------------------------------

/** Restore the latest snapshot into a fresh store and return the tail start. */
function loadSnapshot(relay: RelayStorage, workspaceId: string, store: Store): number {
  const snapshot = relay.latestSnapshot(workspaceId);
  if (snapshot === null) return 0;
  const bytes = relay.readSnapshotData(snapshot.id);
  if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
  store.restore(new Uint8Array(bytes));
  return snapshot.up_to_seq;
}

/** Read the full tail after a seq cursor (paged, the hydration shape). */
function tailEnvelopes(relay: RelayStorage, workspaceId: string, afterSeq: number): Envelope[] {
  const out: Envelope[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const raw of page.envelopes) {
      const checked = envelopeSchema.safeParse(raw);
      if (!checked.success) {
        throw new Error(
          `tail envelope after seq ${cursor} fails the v3 envelope schema: ${checked.error.issues[0]?.message}`,
        );
      }
      out.push(checked.data as Envelope);
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return out;
}

// --- CLI ------------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  dataDir: string;
  derivedDir: string;
  workspace: string | null;
  apply: boolean;
} {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      args[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  const dataDir = resolve(String(args["data-dir"] ?? "config/notees/sync"));
  return {
    dataDir,
    derivedDir: resolve(String(args["derived-dir"] ?? join(dataDir, "derived"))),
    workspace: args.workspace !== undefined ? String(args.workspace) : null,
    apply: args.apply === true,
  };
}

interface WorkspacePlan {
  workspaceId: string;
  snapshotId: string | null;
  afterSeq: number;
  bakedIds: string[];
  tail: Envelope[];
  plan: MainParentPagePlan;
  patchedBytes: Uint8Array | null;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relayDbPath = join(options.dataDir, "relay.db");
  if (!existsSync(relayDbPath)) throw new Error(`relay DB not found: ${relayDbPath}`);

  // The dry run is strictly read-only (it may run while the stack is up).
  const relay = new RelayStorage(relayDbPath, join(options.dataDir, "snapshots"));
  const relayDb: SqliteDb = new Database(relayDbPath, { readonly: !options.apply });
  try {
    relayDb.pragma("busy_timeout = 5000");

    const workspaceIds = (
      relayDb.prepare("SELECT DISTINCT workspace_id FROM envelope ORDER BY workspace_id").all() as unknown as Array<{
        workspace_id: string;
      }>
    ).map((row) => row.workspace_id);
    const targets = options.workspace === null ? workspaceIds : workspaceIds.filter((id) => id === options.workspace);
    if (targets.length === 0) throw new Error(`no workspace matched ${options.workspace}`);
    console.log(
      `relay DB: ${relayDbPath}\nmode: ${options.apply ? "APPLY (stack must be stopped)" : "DRY-RUN (read-only)"}` +
        `\nworkspaces: ${options.workspace ?? "all"} (${targets.length} of ${workspaceIds.length})`,
    );

    const plans: WorkspacePlan[] = [];
    for (const workspaceId of targets) {
      const store = Store.open(betterSqlite3Backend(":memory:"));
      let workspacePlan: WorkspacePlan;
      try {
        // Snapshot-anchored: restore, correct the baked state (capturing the
        // patched bytes BEFORE the tail walk — the snapshot must not contain
        // tail-era state), then walk the tail.
        const t0 = Date.now();
        const afterSeq = loadSnapshot(relay, workspaceId, store);
        const snapshot = relay.latestSnapshot(workspaceId);
        const t1 = Date.now();
        // The verify phase always restores the snapshot (patched when baked
        // violations were corrected, original otherwise) — a null here would
        // verify against an EMPTY store, not the snapshot state. The bytes
        // carry the v20 bulk-replay indexes (migrate() runs inside restore),
        // which is right: they are canonical schema, not migration-local.
        const snapshotBytes = snapshot !== null ? store.snapshot() : null;
        const bakedIds = violatingRowIds(store);
        if (bakedIds.length > 0) clearPresentAsMain(store, bakedIds);
        const patchedBytes = bakedIds.length > 0 ? store.snapshot() : snapshotBytes;
        const tail = tailEnvelopes(relay, workspaceId, afterSeq);
        const t2 = Date.now();
        const plan = walkMainParentPage(tail, store, (applied) => {
          console.log(`  … walk ${applied}/${tail.length} (${((Date.now() - t2) / 1000).toFixed(0)}s)`);
        });
        const t3 = Date.now();
        console.log(
          `  timings ${workspaceId.slice(0, 8)}…: snapshot ${t1 - t0}ms, scan+tail ${t2 - t1}ms, walk ${t3 - t2}ms`,
        );
        workspacePlan = {
          workspaceId,
          snapshotId: snapshot?.id ?? null,
          afterSeq,
          bakedIds,
          tail,
          plan,
          patchedBytes,
        };
      } finally {
        store.close();
      }

      for (const id of workspacePlan.bakedIds) {
        console.log(`baked   ${workspaceId.slice(0, 8)}… node ${id} present_as_main 1→0 (snapshot-corrected)`);
      }
      for (const rewrite of workspacePlan.plan.rewrites) {
        console.log(
          `rewrite ${workspaceId.slice(0, 8)}… tail+${rewrite.tailIndex} ${rewrite.opType} node=${rewrite.objectId} ` +
            `parent=${rewrite.parentId ?? "?"} presentAsMain true→false (parent not a page)`,
        );
      }
      for (const skip of workspacePlan.plan.skips) {
        console.log(`skip    ${workspaceId.slice(0, 8)}… tail+${skip.tailIndex} ${skip.opType}: ${skip.message}`);
      }
      for (const unexpected of workspacePlan.plan.unexpected) {
        console.log(
          `UNEXPECTED ${workspaceId.slice(0, 8)}… tail+${unexpected.tailIndex} ${unexpected.opType}: ${unexpected.message}`,
        );
      }
      console.log(
        `${workspaceId}: snapshot@${workspacePlan.afterSeq} tail=${workspacePlan.tail.length} — ` +
          `${workspacePlan.bakedIds.length} baked, ${workspacePlan.plan.rewrites.length} rewrite(s), ` +
          `${workspacePlan.plan.skips.length} replay-quarantined, ${workspacePlan.plan.unexpected.length} unexpected`,
      );
      plans.push(workspacePlan);
    }

    const errored = plans.filter((p) => p.plan.unexpected.length > 0);
    if (errored.length > 0) {
      throw new Error(
        `${errored.reduce((n, p) => n + p.plan.unexpected.length, 0)} unexpected apply failure(s) — refusing to ${options.apply ? "apply" : "report a clean plan"}`,
      );
    }

    // The real-hydrate acceptance bar, per workspace, on the planned state.
    for (const workspacePlan of plans) {
      const verify = verifyMainParentPage(
        workspacePlan.tail,
        workspacePlan.plan,
        workspacePlan.patchedBytes,
        () => Store.open(betterSqlite3Backend(":memory:")),
      );
      console.log(
        `verify  ${workspacePlan.workspaceId}: quarantined=${verify.quarantined} (expected ${workspacePlan.plan.skips.length}), violating rows=${verify.violatingRows}`,
      );
      if (verify.quarantined !== workspacePlan.plan.skips.length) {
        throw new Error(
          `${workspacePlan.workspaceId}: verify mismatch — ${verify.quarantined} quarantined vs ${workspacePlan.plan.skips.length} recorded skips`,
        );
      }
      if (verify.violatingRows !== 0) {
        throw new Error(`${workspacePlan.workspaceId}: verify failed — ${verify.violatingRows} violating row(s) remain`);
      }
    }

    const affected = plans.filter(
      (p) => p.bakedIds.length > 0 || p.plan.rewrites.length > 0 || p.plan.skips.length > 0,
    );
    if (affected.length === 0) {
      console.log("nothing to do — every target workspace already satisfies the parent-page condition.");
      return;
    }
    console.log(`affected workspace(s): ${affected.map((p) => p.workspaceId).join(", ")}`);

    if (!options.apply) {
      console.log("dry-run only — no writes. Re-run with --apply to execute (a timestamped backup is written first; the stack must be stopped).");
      return;
    }

    // Apply: backup first (WAL checkpoint so the main file is complete).
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const backupPath = `${relayDbPath}.bak-${stamp}`;
    relayDb.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(relayDbPath, backupPath);
    const check = new Database(backupPath, { readonly: true });
    const quickCheck = check.pragma("quick_check", { simple: true });
    check.close();
    if (quickCheck !== "ok") {
      throw new Error(`backup integrity check failed (${String(quickCheck)}) — aborting before any write`);
    }
    console.log(`backup written: ${backupPath} (quick_check ok)`);

    const run = relayDb.transaction(() => {
      const updateEnvelope = relayDb.prepare("UPDATE envelope SET payload = ? WHERE seq = ?");
      for (const workspacePlan of affected) {
        for (const rewrite of workspacePlan.plan.rewrites) {
          const envelope = workspacePlan.tail[rewrite.tailIndex]!;
          const payload = { ...(envelope.payload as Record<string, unknown>), presentAsMain: false };
          updateEnvelope.run(JSON.stringify(payload), seqOf(relayDb, envelope));
        }
        relay.bumpRestoreEpoch(workspacePlan.workspaceId);
      }
    });
    run();

    // Post-commit: the patched snapshot blobs (same id/up_to_seq, new bytes)
    // + the server derived DBs (they carry pre-migration state; the next
    // hydrate rebuilds them from the patched snapshot + rewritten tail).
    for (const workspacePlan of affected) {
      if (workspacePlan.patchedBytes !== null && workspacePlan.snapshotId !== null) {
        const path = join(options.dataDir, "snapshots", `${workspacePlan.snapshotId}.db`);
        writeFileSync(path, workspacePlan.patchedBytes);
        relayDb.prepare("UPDATE snapshot SET size = ? WHERE id = ?").run(workspacePlan.patchedBytes.length, workspacePlan.snapshotId);
      }
      if (existsSync(options.derivedDir)) {
        for (const name of readdirSync(options.derivedDir)) {
          if (!name.startsWith(`${workspacePlan.workspaceId}.db`)) continue;
          try {
            unlinkSync(join(options.derivedDir, name));
          } catch {
            // File already gone.
          }
        }
      }
    }

    let rewritten = 0;
    let baked = 0;
    for (const workspacePlan of affected) {
      rewritten += workspacePlan.plan.rewrites.length;
      baked += workspacePlan.bakedIds.length;
    }
    console.log("migration applied:");
    console.log(`  snapshot-baked rows corrected: ${baked}`);
    console.log(`  tail envelope payloads rewritten: ${rewritten}`);
    console.log(`  restore_epoch bumped + server derived DBs removed for ${affected.length} workspace(s)`);
    console.log("  NEXT: restart the sync server (docker compose up -d notees-sync), then open the web app — every client wipes and full re-syncs through the bumped epoch.");
  } finally {
    relayDb.close();
    relay.close();
  }
}

/** The stored seq of an envelope already applied to the walk store (read back
 *  from the relay row by envelope id — the tail's positional index is not the
 *  relay seq under a --workspace filter). */
function seqOf(relayDb: SqliteDb, envelope: Envelope): number {
  const row = relayDb.prepare("SELECT seq FROM envelope WHERE id = ?").get(envelope.id) as
    | { seq: number }
    | undefined;
  if (row === undefined) throw new Error(`envelope ${envelope.id} not found in the relay log`);
  return row.seq;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`migrate-main-parent-page: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
