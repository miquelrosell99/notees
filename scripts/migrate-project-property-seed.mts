/**
 * The `project` property seed: the task→project membership relation joins
 * the system seed manifest (packages/domain SYSTEM_PROPERTY_SPECS —
 * object-typed, multi, targetClassFilter ["project"], GLOBAL scope per the
 * 2026-10-20 seed-scope audit, hideWhenEmpty, with the class-local BINDING
 * ROW on `task`; the url→source precedent).
 *
 * Seeds only shape NEW workspaces (the server seed authors both rows); live
 * workspaces converge by APPENDED envelopes (migrations.md Path A — the
 * immutable relay log is never edited):
 *
 *  - the project SCHEMA is missing → one `propertySchema.create` (the seed
 *    shape at the reserved id — global scope, multi, the project filter,
 *    hideWhenEmpty) followed by one `class.property.set { classId: <task>,
 *    propertySchemaId: <project> }`, both in the SAME ingest;
 *  - the schema exists but the task BINDING ROW is missing → the
 *    `class.property.set` alone;
 *  - the stored schema's scope drifted from the global seed (a non-NULL
 *    scope list that would make the R5 dead-config check reject the task
 *    binding) → `propertySchema.update { scopeClassIds: null }` FIRST, the
 *    binding in the same ingest, ordered after it (the
 *    migrate-url-source-binding precedent);
 *  - attribute drift on an EXISTING schema (multi/filter/hideWhenEmpty
 *    mismatching the seed) is REPORTED, never touched — INSERT-or-ignore
 *    semantics throughout, first writer wins on the single global log, and
 *    client-authored data is never clobbered;
 *  - the `task` CLASS NODE is absent → nothing to do (the web ensure
 *    self-heals the whole family — class node, schemas, bindings — on the
 *    next tasks surface open; a binding row without the class node would
 *    re-author on every pass).
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), so the
 * compared rows are the converged log state. Every envelope is validated
 * through the protocol zod schemas BEFORE anything is inserted. Idempotent:
 * a second run plans nothing (the schema + binding rows exist).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, the
 * schema + binding rows present, the schema scope NULL when it drifted).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-project-property-seed.mts \
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
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a4";
const DEVICE = "migrate-project-property-seed";
const CLIENT = "migrate-project-property-seed";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const TASK_ID = SYSTEM_CLASS_UUIDS.task;
const PROJECT_CLASS_ID = SYSTEM_CLASS_UUIDS.project;
const PROJECT_ID = SYSTEM_PROPERTY_UUIDS.project;

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
  return relay.listWorkspaceIds();
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

interface SeedPlan {
  /** The task class NODE is absent — the web ensure self-heals the family. */
  taskClassMissing: boolean;
  /** The project schema row is absent from this workspace entirely. */
  schemaMissing: boolean;
  /** A task↔project binding row already exists — nothing to do. */
  taskBound: boolean;
  /** The converged scope list (non-null = drifted from the global seed). */
  currentScope: string[] | null;
  /** Attribute drift on an existing schema — reported, never touched. */
  attributeDrift: string[];
}

function planSeed(store: Store): SeedPlan {
  const taskNode = store.database
    .prepare("SELECT id FROM node WHERE id = ? AND is_class = 1")
    .get(TASK_ID);
  const schema = store.database
    .prepare(
      "SELECT scope_class_ids, multi, target_class_filter, hide_when_empty FROM property_schema WHERE id = ?",
    )
    .get(PROJECT_ID) as
    | { scope_class_ids: string | null; multi: number; target_class_filter: string | null; hide_when_empty: number | null }
    | undefined;
  const binding = store.database
    .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
    .get(TASK_ID, PROJECT_ID) !== undefined;

  const attributeDrift: string[] = [];
  if (schema !== undefined) {
    if (schema.multi !== 1) attributeDrift.push(`multi=${schema.multi} (seed: 1)`);
    const filter =
      schema.target_class_filter === null
        ? null
        : (JSON.parse(schema.target_class_filter) as string[]);
    if (filter === null || filter.length !== 1 || filter[0] !== PROJECT_CLASS_ID) {
      attributeDrift.push(`targetClassFilter=${schema.target_class_filter} (seed: ["project"])`);
    }
    if (schema.hide_when_empty !== 1) {
      attributeDrift.push(`hideWhenEmpty=${schema.hide_when_empty} (seed: true)`);
    }
  }
  return {
    taskClassMissing: taskNode === undefined,
    schemaMissing: schema === undefined,
    taskBound: binding,
    currentScope:
      schema === undefined || schema.scope_class_ids === null
        ? null
        : (JSON.parse(schema.scope_class_ids) as string[]),
    attributeDrift,
  };
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, plan: SeedPlan): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  let logical = 0;
  const stamp = (opType: string, payload: Record<string, unknown>, affected: string[]): Envelope =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: logical++ },
      affectedNodeIds: affected,
      opType,
      payload,
    });

  if (plan.schemaMissing) {
    // The seed shape at the reserved id: global scope (absent scopeClassIds),
    // multi, the project target filter, hideWhenEmpty — exactly the payload
    // the server seed and the web ensure author (INSERT-or-ignore: first
    // writer wins on the single global log).
    envelopes.push(
      stamp("propertySchema.create", {
        propertySchemaId: PROJECT_ID,
        name: SYSTEM_PROPERTY_DISPLAY_NAMES.project,
        type: "object",
        multi: true,
        targetClassFilter: [PROJECT_CLASS_ID],
        hideWhenEmpty: true,
      }, []),
    );
  } else if (plan.currentScope !== null) {
    // R5 dead-config guard: the task binding is only legal on a schema whose
    // scope reaches task — the drifted local scope clears FIRST, same
    // ingest, ordered before the binding.
    envelopes.push(
      stamp("propertySchema.update", { propertySchemaId: PROJECT_ID, scopeClassIds: null }, []),
    );
  }
  if (plan.schemaMissing || !plan.taskBound) {
    envelopes.push(
      stamp("class.property.set", { classId: TASK_ID, propertySchemaId: PROJECT_ID }, [TASK_ID]),
    );
  }
  return envelopes;
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
 *  3. assert the task↔project binding row exists, the schema row converged,
 *     and the scope is NULL when it drifted.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
  plan: SeedPlan,
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
    const schema = store.database
      .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
      .get(PROJECT_ID) as { scope_class_ids: string | null } | undefined;
    if (schema === undefined) {
      throw new Error("verification failed: the project schema row is missing after the migration");
    }
    const bound =
      store.database
        .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(TASK_ID, PROJECT_ID) !== undefined;
    if (!bound) {
      throw new Error("verification failed: the task↔project binding row is missing after the migration");
    }
    if (plan.currentScope !== null) {
      if (schema.scope_class_ids !== null) {
        throw new Error("verification failed: the project schema scope did not converge to NULL");
      }
    }
  } finally {
    store.close();
  }

  console.log(
    `verify: ${rows.length} new envelope(s) read back; tail applied clean since seq ${snapshotSeq}; ` +
      "the task↔project binding row converges.",
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
  const plan = planSeed(store);
  store.close();

  if (plan.taskClassMissing) {
    console.log(
      "  task class node not present — nothing to do (the web ensure self-heals the whole task family on the next tasks surface open).",
    );
    return;
  }
  if (!plan.schemaMissing && plan.taskBound) {
    console.log("  already converged — the project schema + the task binding row exist. Nothing to do.");
    return;
  }

  console.log("planned project property seed:");
  if (plan.schemaMissing) {
    console.log(
      "  propertySchema.create { propertySchemaId: <project>, name: \"Project\", type: object, multi: true, " +
        "targetClassFilter: [<project class>], hideWhenEmpty: true }",
    );
  }
  if (plan.currentScope !== null) {
    console.log(
      "  propertySchema.update { propertySchemaId: <project>, scopeClassIds: null } FIRST — stored scope drifted: " +
        JSON.stringify(plan.currentScope),
    );
  }
  console.log("  class.property.set { classId: <task>, propertySchemaId: <project> }");
  for (const drift of plan.attributeDrift) {
    console.log(`  reported drift (NOT touched): ${drift}`);
  }

  const envelopes = buildEnvelopes(workspaceId, plan);
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

  verify(relay, workspaceId, snapshotSeq, envelopes.length, plan);
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
      `project property seed: ${workspaces.length} workspace(s) ` +
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

export { buildEnvelopes, planSeed, type SeedPlan };

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
