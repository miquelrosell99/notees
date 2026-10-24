/**
 * class-level parentlessRole (owner 2026-10-24): the render contract that
 * demotes flagged classes' PARENTLESS members to the Block role (SCHEMA.md
 * "Node structure"). The seed manifests (server seed, web ensures) carry the
 * flag for NEW workspaces; this script converges LIVE workspaces by APPENDED
 * envelopes (migrations.md Path A — the immutable relay log is never edited):
 * one `class.update { classId, parentlessRole: "block" }` per flagged class
 * whose converged row does not yet carry it.
 *
 * Only the seed-flagged set (SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK, 14 classes)
 * is written; `meeting` / `birthday` are deliberately absent — they inherit
 * the demote through `event` via the extends closure (the effective flag
 * derives at read time; one-way demote, no per-level unflag), so authoring a
 * flag on them would be redundant config.
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), so the
 * compared rows are the converged log state. Every envelope is validated
 * through the protocol zod schemas BEFORE anything is inserted. Idempotent:
 * a second run plans nothing (every flagged row carries the flag).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, every
 * flagged class row carrying parentless_role = 'block').
 *
 * Ordering (the lockstep law): run AFTER the GTK/Flutter ports accept the
 * parentlessRole payload key — a pre-batch client rejects a class.update
 * carrying the unknown key.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-class-parentless-role.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid> | --all] [--apply]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK,
  SYSTEM_CLASS_UUIDS,
  type SystemClassName,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a3";
const DEVICE = "migrate-class-parentless-role";
const CLIENT = "migrate-class-parentless-role";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  all: boolean;
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
    all: argv.includes("--all"),
    apply: argv.includes("--apply"),
  };
}

/** Every workspace id the relay log carries. */
function listWorkspaces(relay: RelayStorage): string[] {
  const rows = relay.db
    .prepare("SELECT DISTINCT workspace_id FROM envelope ORDER BY workspace_id")
    .all() as Array<{ workspace_id: string }>;
  return rows.map((row) => row.workspace_id);
}

// --- scratch derived store ----------------------------------------------------

/**
 * Restore the workspace's latest snapshot into a fresh in-memory store and
 * apply every log envelope after it (the hydration shape the sync server
 * uses). Throws on any StoreError — a tail that cannot apply must block the
 * migration, not be planned against.
 */
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
    for (const envelope of page.envelopes) {
      try {
        store.apply(envelope);
      } catch (error) {
        store.close();
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`tail apply failed at seq > ${cursor}: ${detail}`);
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

// --- planning -----------------------------------------------------------------

interface ClassPlan {
  name: SystemClassName;
  classId: string;
  /** The class node row is absent from this workspace entirely. */
  classMissing: boolean;
  /** The converged flag (NULL = the "page" default). */
  currentRole: string | null;
}

/** One plan row per seed-flagged class, in manifest order. */
function planClasses(store: Store): ClassPlan[] {
  const stmt = store.database.prepare("SELECT parentless_role FROM node WHERE id = ?");
  return [...SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK].map((name) => {
    const classId = SYSTEM_CLASS_UUIDS[name];
    const row = stmt.get(classId) as { parentless_role: string | null } | undefined;
    return {
      name,
      classId,
      classMissing: row === undefined,
      currentRole: row?.parentless_role ?? null,
    };
  });
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, drifted: ClassPlan[]): Envelope[] {
  const physical = Date.now();
  let logical = 0;
  return drifted.map((plan) =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: logical++ },
      affectedNodeIds: [plan.classId],
      opType: "class.update",
      payload: { classId: plan.classId, parentlessRole: "block" },
    }),
  );
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
function validateEnvelopes(envelopes: Envelope[]): void {
  const failures: string[] = [];
  for (const envelope of envelopes) {
    const envResult = envelopeSchema.safeParse(envelope);
    if (!envResult.success) {
      failures.push(`${envelope.opType} ${envelope.id}: envelope invalid — ${envResult.error.message}`);
      continue;
    }
    const schema = payloadSchemaFor(envelope.opType);
    if (schema === undefined) {
      failures.push(`${envelope.opType} ${envelope.id}: no payload schema registered`);
      continue;
    }
    const payloadResult = schema.safeParse(envelope.payload);
    if (!payloadResult.success) {
      failures.push(`${envelope.opType} ${envelope.id}: payload invalid — ${payloadResult.error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `refusing to insert: ${failures.length} invalid envelope(s):\n  ${failures.join("\n  ")}`,
    );
  }
}

// --- verification -------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log:
 *  1. read the new envelopes back (count + protocol validation),
 *  2. build a FRESH scratch store from the same snapshot and apply the tail
 *     INCLUDING the new envelopes — zero StoreError throws,
 *  3. assert every seed-flagged class row carries parentless_role = 'block'.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
): void {
  const rows = relay
    .allEnvelopes(workspaceId)
    .filter((envelope) => envelope.deviceId === DEVICE);
  if (rows.length !== expectedCount) {
    throw new Error(`read-back mismatch: expected ${expectedCount} new envelopes, found ${rows.length}`);
  }
  for (const envelope of rows) {
    const stored = envelopeSchema.parse(envelope);
    const schema = payloadSchemaFor(stored.opType);
    if (schema === undefined || !schema.safeParse(stored.payload).success) {
      throw new Error(`read-back envelope ${stored.id} (${stored.opType}) fails protocol validation`);
    }
  }

  const store = buildScratchStore(relay, workspaceId);
  try {
    const stmt = store.database.prepare("SELECT parentless_role FROM node WHERE id = ?");
    const unconverged = [...SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK].filter((name) => {
      const row = stmt.get(SYSTEM_CLASS_UUIDS[name]) as
        | { parentless_role: string | null }
        | undefined;
      return row === undefined || row.parentless_role !== "block";
    });
    if (unconverged.length > 0) {
      throw new Error(
        `verification failed: ${unconverged.length} flagged class row(s) not 'block' after the migration: ` +
          unconverged.join(", "),
      );
    }
  } finally {
    store.close();
  }

  console.log(
    `verify: ${rows.length} new envelope(s) read back; tail applied clean since seq ${snapshotSeq}; ` +
      "every seed-flagged class row converges to parentless_role = 'block'.",
  );
}

// --- main ---------------------------------------------------------------------

function migrateWorkspace(relay: RelayStorage, workspaceId: string, apply: boolean): void {
  const snapshot = relay.latestSnapshot(workspaceId);
  const snapshotSeq = snapshot?.up_to_seq ?? 0;
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  const plans = planClasses(store);
  store.close();

  const missing = plans.filter((plan) => plan.classMissing);
  const drifted = plans.filter((plan) => !plan.classMissing && plan.currentRole !== "block");
  const converged = plans.length - missing.length - drifted.length;

  if (missing.length > 0) {
    console.log(
      `  ${missing.length} flagged class node(s) absent from this workspace (never seeded/deployed): ` +
        missing.map((plan) => plan.name).join(", ") +
        " — skipped; a later deploy/ensure authors the flag with the class.",
    );
  }
  if (converged > 0) {
    console.log(`  ${converged} flagged class(es) already carry the flag.`);
  }
  if (drifted.length === 0) {
    console.log("  nothing to do — every present flagged class carries parentlessRole 'block'.");
    return;
  }

  console.log(`planned parentlessRole convergence (${drifted.length} class(es)):`);
  for (const plan of drifted) {
    console.log(
      `  class.update { classId: <${plan.name}>, parentlessRole: "block" }` +
        `  (stored role: ${plan.currentRole ?? "NULL (page default)"})`,
    );
  }

  const envelopes = buildEnvelopes(workspaceId, drifted);
  validateEnvelopes(envelopes);
  console.log(`${envelopes.length} envelope(s) built and protocol-validated.`);

  if (!apply) {
    console.log("dry run — re-run with --apply to append these envelopes to the relay log.");
    return;
  }

  const { savedIds } = relay.ingest(envelopes);
  if (savedIds.length !== envelopes.length) {
    throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
  }
  console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);

  verify(relay, workspaceId, snapshotSeq, envelopes.length);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const workspaces = options.all ? listWorkspaces(relay) : [options.workspace];
    console.log(
      `class parentlessRole convergence: ${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"})`,
    );
    for (const workspaceId of workspaces) {
      migrateWorkspace(relay, workspaceId, options.apply);
    }
    if (options.apply) {
      console.log(
        "\ndone. The appended envelopes flow to every device through ordinary catch-up — " +
          "no restart or epoch bump needed (Path A append, not a log rewrite).",
      );
    }
  } finally {
    relay.close();
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
