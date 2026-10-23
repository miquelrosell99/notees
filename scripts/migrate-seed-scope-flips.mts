/**
 * Seed-scope flips (owner ruling 2026-10-20 — the seed-scope audit, the
 * follow-up to the property-scope batch b8548e0e): commit b8548e0e mapped
 * every old `scope: "class"` seed to `scopeClassIds: [<its bind class>]`;
 * the audit found that mapping over-scoped. Genuinely REUSABLE properties
 * must be GLOBAL (absent/null scopeClassIds — the owner ruling: the task
 * Status property "can be reused for other nodes", and the ruling covers the
 * WHOLE task family; web_page's `url` is generically reusable too — the
 * class seeded as `weblink`, renamed to `web_page`). The
 * family-identity fields stay LOCAL (citekey explicitly so — "local to the
 * source class and its extensions"; the source bibliographic family, the
 * meeting identity trio, eventDate, birthdayPerson, the person split, the
 * asset/highlight fields). Bindings are untouched — they stay per-class
 * config (zero availability semantics).
 *
 * The flip set (7 schemas):
 *   taskStatus …0003-000000000001, taskScheduled …0003-…0002,
 *   taskDeadline …0003-…0003, taskPriority …0003-…0004,
 *   taskClosedDate …0003-…0005, taskRecurrence …0003-…0006  (scope [task])
 *   url        …0000-000000000024                            (scope [web_page])
 *
 * Seeds only shape NEW workspaces; live workspaces converge by APPENDED
 * envelopes (migrations.md Path A — the immutable relay log is never
 * edited): one `propertySchema.update { propertySchemaId, scopeClassIds: null }`
 * per flipped schema whose converged row is still local. `scopeClassIds: null`
 * is the pinned keep/clear contract (fixtures property-schema-update-fields.json
 * / property-schema-scope.json) — accepted by any client whose
 * propertySchema.update validator allows the key (LOCKSTEP: run only after
 * the GTK/Flutter ports accept scopeClassIds, the same gate as
 * migrate-property-scope.mts).
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), so the
 * compared scopes are the converged log state. Every envelope is validated
 * through the protocol zod schemas BEFORE anything is inserted. Idempotent:
 * a second run plans nothing (the converged scope is already NULL).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, every
 * flipped row converges to scope_class_ids NULL).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-seed-scope-flips.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid> | --all] [--apply]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a2";
const DEVICE = "migrate-seed-scope-flips";
const CLIENT = "migrate-seed-scope-flips";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

/** The audit's flip set: fixed schema UUID → its seed-time local scope. */
const FLIPS: ReadonlyArray<{ schemaId: string; name: string; wasScopedTo: string }> = [
  { schemaId: SYSTEM_PROPERTY_UUIDS.taskStatus, name: "Status", wasScopedTo: SYSTEM_CLASS_UUIDS.task },
  { schemaId: SYSTEM_PROPERTY_UUIDS.taskScheduled, name: "Scheduled", wasScopedTo: SYSTEM_CLASS_UUIDS.task },
  { schemaId: SYSTEM_PROPERTY_UUIDS.taskDeadline, name: "Deadline", wasScopedTo: SYSTEM_CLASS_UUIDS.task },
  { schemaId: SYSTEM_PROPERTY_UUIDS.taskPriority, name: "Priority", wasScopedTo: SYSTEM_CLASS_UUIDS.task },
  { schemaId: SYSTEM_PROPERTY_UUIDS.taskClosedDate, name: "Closed", wasScopedTo: SYSTEM_CLASS_UUIDS.task },
  { schemaId: SYSTEM_PROPERTY_UUIDS.taskRecurrence, name: "Recurrence", wasScopedTo: SYSTEM_CLASS_UUIDS.task },
  { schemaId: SYSTEM_PROPERTY_UUIDS.url, name: "URL", wasScopedTo: SYSTEM_CLASS_UUIDS.web_page },
];

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

interface FlipPlan {
  schemaId: string;
  name: string;
  /** The converged scope list (null = already global — nothing to do). */
  currentScope: string[] | null;
  /** The schema row is absent from this workspace entirely. */
  schemaMissing: boolean;
}

function planFlips(store: Store): FlipPlan[] {
  const plans: FlipPlan[] = [];
  for (const flip of FLIPS) {
    const row = store.database
      .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
      .get(flip.schemaId) as { scope_class_ids: string | null } | undefined;
    plans.push({
      schemaId: flip.schemaId,
      name: flip.name,
      currentScope: row === undefined ? null : row.scope_class_ids === null ? null : (JSON.parse(row.scope_class_ids) as string[]),
      schemaMissing: row === undefined,
    });
  }
  return plans;
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, flips: FlipPlan[]): Envelope[] {
  const physical = Date.now();
  return flips.map((flip, index) =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: index },
      affectedNodeIds: [],
      opType: "propertySchema.update",
      payload: { propertySchemaId: flip.schemaId, scopeClassIds: null },
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
 *  3. assert every flipped schema row converges to scope_class_ids NULL.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
  flipped: FlipPlan[],
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
    for (const flip of flipped) {
      const row = store.database
        .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
        .get(flip.schemaId) as { scope_class_ids: string | null } | undefined;
      if (row === undefined) {
        throw new Error(`verification failed: schema ${flip.schemaId} (${flip.name}) is missing after the migration`);
      }
      if (row.scope_class_ids !== null) {
        throw new Error(
          `verification failed: schema ${flip.schemaId} (${flip.name}) scope_class_ids = ${row.scope_class_ids}, expected NULL`,
        );
      }
    }
  } finally {
    store.close();
  }

  console.log(
    `verify: ${rows.length} new envelope(s) read back (propertySchema.update×${rows.length}); ` +
      `tail applied clean since seq ${snapshotSeq}; ${flipped.length} schema(s) converge to global scope.`,
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
  const plans = planFlips(store);
  store.close();

  const toFlip = plans.filter((plan) => !plan.schemaMissing && plan.currentScope !== null);
  const missing = plans.filter((plan) => plan.schemaMissing);
  const alreadyGlobal = plans.filter((plan) => !plan.schemaMissing && plan.currentScope === null);

  console.log("planned seed-scope flips:");
  if (toFlip.length === 0) {
    console.log("  nothing to flip — every flipped schema is global or absent.");
  } else {
    for (const plan of toFlip) {
      console.log(
        `  ${plan.name} (${plan.schemaId})  scopeClassIds ` +
          `${JSON.stringify(plan.currentScope)} → null (global)`,
      );
    }
  }
  if (alreadyGlobal.length > 0) {
    console.log(`  already global: ${alreadyGlobal.map((plan) => plan.name).join(", ")}`);
  }
  if (missing.length > 0) {
    console.log(
      `  not authored in this workspace (nothing to do — the family self-heal seeds it global): ` +
        missing.map((plan) => plan.name).join(", "),
    );
  }

  if (toFlip.length === 0) return;

  const envelopes = buildEnvelopes(workspaceId, toFlip);
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

  verify(relay, workspaceId, snapshotSeq, envelopes.length, toFlip);
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
      `seed-scope flips: ${FLIPS.length} schemas × ${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"})`,
    );
    for (const workspaceId of workspaces) {
      migrateWorkspace(relay, workspaceId, options.apply);
    }
    if (options.apply) {
      console.log(
        "\ndone. RESTART the sync server so its running derived store rehydrates from the appended log.",
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
