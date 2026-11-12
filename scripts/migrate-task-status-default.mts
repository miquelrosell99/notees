/**
 * Task-Status default convergence (2026-11-02): the task Status schema
 * (…0003-…0001, "Status", select, display "bullet") now carries the
 * schema-level `defaultValue` = the Pending option id (…0004-…0009,
 * TASK_STATUS_OPTION_UUIDS.pending — packages/domain TASK_FAMILY_SEED). The
 * store derives the default at READ time (nothing is materialized): a task
 * supplies "Pending" without an authored row, an authored row that shadows
 * the default survives as log state, and the web cycle's assign arm no
 * longer writes Pending. New workspaces receive the default from the seeds
 * / the web `ensureTaskFamily` upgrade pass; EXISTING workspaces carry the
 * schema WITHOUT `default_value` (and, redundantly, authored Pending rows
 * written before the default existed) — this script converges them.
 *
 * Path A append (the migrate-meeting-date-retirement / migrate-seed-pins
 * shape), two envelope families per drifted workspace, both inside the
 * THREE-CLIENT INTERSECTION:
 *
 *   A. `propertySchema.update {propertySchemaId, defaultValue}` — only when
 *      the schema row exists, is ACTIVE, and its stored default_value is
 *      NULL (patch semantics: present key sets, absent keeps — SCHEMA.md
 *      "Class properties"). A schema carrying a CLIENT-AUTHORED different
 *      default is REPORTED, never touched (the migrate-pmid-property
 *      attribute-drift posture); a missing/soft-deleted schema is reported
 *      and left alone (the web ensure self-heals the seed shape, and a
 *      default on a dead schema is inert). A workspace where the user
 *      DELETED the Pending option still gets the default — it simply never
 *      derives (the read-side option-membership check), harmless.
 *   B. `property.unset {objectId, propertySchemaId, idx}` (positional, the
 *      deterministic element id omitted — the meeting-date precedent) for
 *      authored property_value rows on the Status schema at idx 0 whose
 *      value EQUALS the Pending option id. Any other value (Doing, Done,
 *      …) is never touched.
 *
 *      Nothing is lost: a tombstone is only planned where the derived
 *      default ACTUALLY replaces the display — the authored row's
 *      effective `boundBy` must be non-null (a winning ACTIVE binding
 *      brings the property into the node's context, extends-aware). A node
 *      no binding covers (tasks-feature-off workspace, binding unset, a
 *      non-task carrier) keeps its authored row and is REPORTED — the value
 *      is not redundant there. The applier-simulation gate then re-checks
 *      each planned unset on a throwaway replay (the schema update applied
 *      first): the unset survives only when a `source: "default"` row with
 *      the Pending value materializes at idx 0, which also catches the
 *      rarer drifts (the Pending option deleted — the read-side membership
 *      check skips the default; a multi-typed drift where the default
 *      cannot derive).
 *
 * NO LOCKSTEP GATE (the migrate-pmid-property.mts precedent): `defaultValue`
 * is an EXISTING `propertySchema.update` payload key every port already
 * applies (PC2 shipped 2026-10-03), and `property.unset` is ancient wire —
 * no new op type, no new payload key, no fixture gate.
 *
 * Fresh ids/HLC at the log tail, NO epoch bump; a snapshot built before the
 * append catches up the tail on every hydration. Restart the sync server
 * after --apply so its running derived store rehydrates.
 *
 * Idempotent: a second run plans nothing (default_value set, bound covered
 * pending rows tombstoned); rows kept by the binding guard re-report
 * deterministically as KEEP lines without planning work.
 *
 * DRY RUN BY DEFAULT. --apply backs up relay.db, ingests through
 * RelayStorage.ingest, then verifies from the persisted log: read-back +
 * protocol validation, and a FRESH scratch replay (snapshot + full tail)
 * asserting the converged end state.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-task-status-default.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  SYSTEM_PROPERTY_UUIDS,
  TASK_STATUS_OPTION_UUIDS,
} from "../packages/domain/src/index.ts";
import { getEffectiveProperties, Store } from "../packages/store/src/index.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

import {
  buildScratchStore as scratchStoreBuild,
  refuseIfContentOnKeyed,
  type MigrationContentClass,
} from "./lib/scratch-store.ts";

/**
 * This migration's content class (the dev-ops contract, scripts/lib/scratch-store.ts):
 * "scaffolding" touches the schema/binding rows every replica derives identically.
 */
export const CONTENT_CLASS: MigrationContentClass = "scaffolding";

/** The fixed task Status schema id (exported for the e2e test, the
 *  MEETING_DATE_ID precedent). */
export const TASK_STATUS_ID = SYSTEM_PROPERTY_UUIDS.taskStatus;
/** The Pending option id — the seeded schema default. */
export const PENDING_ID = TASK_STATUS_OPTION_UUIDS.pending;

const ACTOR = "01920000-0000-7000-8000-0000000000b3";
const DEVICE = "migrate-task-status-default";
const CLIENT = "migrate-task-status-default";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
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
    apply: argv.includes("--apply"),
  };
}

// --- scratch derived store ----------------------------------------------------

/**
 * The shared scratch build (scripts/lib/scratch-store.ts — the sealed gate +
 * the skip accounting) plus this migration's house skip line.
 */
function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
  return scratchStoreBuild(relay, workspaceId, ({ encrypted, pending }) => {
    console.log(
      `  (scratch: ${encrypted} encrypted + ${pending} pending envelope(s) skipped — ` +
        "a keyed workspace's sealed content is invisible to a server-side plan)",
    );
  });
}

// --- planning -------------------------------------------------------------------

export interface TaskStatusRemoval {
  nodeId: string;
  /** The positional slot idx (the deterministic element id is node:schema:idx). */
  idx: number;
  /** The property_value row id — report-only (the wire payload omits it: the
   *  positional id is not a UUID, and single-value slots remove by idx). */
  elementId: string;
}

export interface TaskStatusKeep {
  nodeId: string;
  reason: string;
}

export interface TaskStatusPlan {
  /** The Status schema row is absent — the web ensure self-heals the seed
   *  shape (with the default); authored rows on a schema-less id are never
   *  touched (nothing derives there). */
  schemaMissing: boolean;
  /** The schema row is soft-deleted (active = 0) — a default is inert on a
   *  dead schema; reported, nothing planned. */
  schemaInactive: boolean;
  /** The schema row is live with default_value NULL — append the update. */
  schemaUpdate: boolean;
  /** A client-authored defaultValue that is NOT Pending — reported, never
   *  touched (the migrate-pmid-property attribute-drift posture). */
  defaultDrift: string | null;
  /** Authored idx-0 Pending rows a winning ACTIVE binding covers — the
   *  derived default replaces these once it lands. */
  removals: TaskStatusRemoval[];
  /** Authored idx-0 Pending rows NO binding brings into context — the
   *  value is not redundant there (reported, never dropped; the
   *  applier-simulation gate re-checks the candidates it plans). */
  keeps: TaskStatusKeep[];
}

/**
 * Plan from the converged scratch store. Only LIVE state plans work: the
 * schema update when the row is active and default-less; a removal for each
 * authored idx-0 row whose JSON value equals the Pending option id AND a
 * winning ACTIVE binding brings the property into the node's context (the
 * authored row's effective `boundBy` is non-null — extends-aware, the
 * authoritative read model). Any other authored value, and authored rows
 * no binding covers, are never candidates.
 */
export function planTaskStatusDefault(store: Store): TaskStatusPlan {
  const db = store.database;
  const plan: TaskStatusPlan = {
    schemaMissing: false,
    schemaInactive: false,
    schemaUpdate: false,
    defaultDrift: null,
    removals: [],
    keeps: [],
  };

  const schema = db
    .prepare("SELECT active, default_value FROM property_schema WHERE id = ?")
    .get(TASK_STATUS_ID) as { active: number; default_value: string | null } | undefined;
  if (schema === undefined) {
    plan.schemaMissing = true;
    return plan;
  }
  if (schema.active !== 1) {
    plan.schemaInactive = true;
    return plan;
  }
  if (schema.default_value === null) {
    plan.schemaUpdate = true;
  } else {
    const stored = JSON.parse(schema.default_value) as unknown;
    if (stored !== PENDING_ID) {
      plan.defaultDrift = `defaultValue=${JSON.stringify(stored)} (seed: ${PENDING_ID})`;
    }
  }

  const rows = db
    .prepare(
      `SELECT node_id, id, idx, value FROM property_value
       WHERE property_schema_id = ? AND idx = 0 ORDER BY node_id, id`,
    )
    .all(TASK_STATUS_ID) as Array<{ node_id: string; id: string; idx: number; value: string }>;
  for (const row of rows) {
    if (JSON.parse(row.value) !== PENDING_ID) continue;
    const bound = getEffectiveProperties(db, row.node_id).some(
      (effective) => effective.propertySchemaId === TASK_STATUS_ID && effective.boundBy !== null,
    );
    if (!bound) {
      plan.keeps.push({
        nodeId: row.node_id,
        reason: "no winning active binding brings the Status property into this node's context — the authored Pending row is not redundant here",
      });
      continue;
    }
    plan.removals.push({ nodeId: row.node_id, idx: row.idx, elementId: row.id });
  }
  return plan;
}

export function planIsEmpty(plan: TaskStatusPlan): boolean {
  return !plan.schemaUpdate && plan.removals.length === 0;
}

// --- envelopes ------------------------------------------------------------------

export function buildTaskStatusDefaultEnvelopes(
  workspaceId: string,
  plan: TaskStatusPlan,
): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  let logical = 0;
  const push = (opType: string, payload: Record<string, unknown>, affected: string[]) =>
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: logical++ },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );

  // The enabling op rides FIRST in the same ingest (the migrate-pmid-property
  // / migrate-url-source-binding ordering precedent).
  if (plan.schemaUpdate) {
    push("propertySchema.update", { propertySchemaId: TASK_STATUS_ID, defaultValue: PENDING_ID }, []);
  }
  for (const removal of plan.removals) {
    push(
      "property.unset",
      { objectId: removal.nodeId, propertySchemaId: TASK_STATUS_ID, idx: removal.idx },
      [removal.nodeId],
    );
  }
  return envelopes;
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema BEFORE anything is inserted.
 */
function validateEnvelopes(envelopes: Envelope[]): void {
  const failures: string[] = [];
  for (const envelope of envelopes) {
    if (!envelopeSchema.safeParse(envelope).success) {
      failures.push(`${envelope.opType} ${envelope.id}: envelope invalid`);
      continue;
    }
    const schema = payloadSchemaFor(envelope.opType);
    if (schema === undefined || !schema.safeParse(envelope.payload).success) {
      failures.push(`${envelope.opType} ${envelope.id}: payload invalid`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`refusing to insert: ${failures.length} invalid envelope(s):\n  ${failures.join("\n  ")}`);
  }
}

/**
 * The applier gate, on a throwaway store: replay the plan's envelopes (the
 * schema update first) and keep an unset ONLY where the derived default
 * actually replaces the tombstoned row — the effective read must show a
 * `source: "default"` row carrying the Pending value at idx 0 afterwards.
 * A node where the default does not materialize (no winning ACTIVE binding
 * in context — tasks-feature-off, binding unset, a non-task carrier — or
 * the Pending option deleted so the read-side membership check skips the
 * default) keeps its authored row: the value is not redundant there and is
 * never dropped. A rejected node-less envelope (the schema update) throws
 * loud — on a converged log it can never fail.
 */
export function simulateTaskStatusEnvelopesOnStore(
  store: Store,
  envelopes: Envelope[],
): { envelopes: Envelope[]; rejected: TaskStatusKeep[] } {
  const rejected: TaskStatusKeep[] = [];
  const blockedNodes = new Set<string>();
  const surviving: Envelope[] = [];
  for (const envelope of envelopes) {
    const payload = envelope.payload as { objectId?: string };
    const nodeId = payload.objectId;
    if (nodeId !== undefined && blockedNodes.has(nodeId)) continue;
    store.apply(envelope);
    if (nodeId === undefined) {
      surviving.push(envelope);
      continue;
    }
    const covered = getEffectiveProperties(store.database, nodeId).some(
      (row) =>
        row.propertySchemaId === TASK_STATUS_ID &&
        row.idx === 0 &&
        row.source === "default" &&
        row.value === PENDING_ID,
    );
    if (covered) {
      surviving.push(envelope);
    } else {
      blockedNodes.add(nodeId);
      rejected.push({
        nodeId,
        reason:
          "the derived Pending default does not materialize on this node " +
          "(no winning active binding in context, or the Pending option is gone) — " +
          "the authored row is not redundant here",
      });
    }
  }
  return { envelopes: surviving, rejected };
}

/**
 * The relay-shaped applier gate: replay on a THROWAWAY scratch store (a
 * fresh hydration of the CURRENT log) so a bad envelope drops HERE, never
 * mid-ingest.
 */
export function simulateTaskStatusEnvelopes(
  relay: RelayStorage,
  workspaceId: string,
  envelopes: Envelope[],
): { envelopes: Envelope[]; rejected: TaskStatusKeep[] } {
  const store = buildScratchStore(relay, workspaceId);
  try {
    return simulateTaskStatusEnvelopesOnStore(store, envelopes);
  } finally {
    store.close();
  }
}

// --- verification ---------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log: the new
 * envelopes read back + protocol-validate, and a FRESH scratch store
 * (snapshot + FULL tail, the appended envelopes included) replays clean
 * into the converged end state: the schema carries the Pending default
 * (JSON-encoded) and no authored idx-0 Pending row survives outside the
 * reported keeps.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  expectedCount: number,
  keeps: TaskStatusKeep[],
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
    const db = store.database;
    const schema = db
      .prepare("SELECT default_value FROM property_schema WHERE id = ?")
      .get(TASK_STATUS_ID) as { default_value: string | null } | undefined;
    if (schema === undefined) {
      throw new Error("verification failed: the taskStatus schema row is gone");
    }
    if (schema.default_value !== JSON.stringify(PENDING_ID)) {
      throw new Error(
        `verification failed: the taskStatus schema default is ${schema.default_value} (expected ${JSON.stringify(PENDING_ID)})`,
      );
    }
    const kept = new Set(keeps.map((keep) => keep.nodeId));
    const remaining = db
      .prepare(
        "SELECT node_id, value FROM property_value WHERE property_schema_id = ? AND idx = 0",
      )
      .all(TASK_STATUS_ID) as Array<{ node_id: string; value: string }>;
    for (const row of remaining) {
      if (JSON.parse(row.value) === PENDING_ID && !kept.has(row.node_id)) {
        throw new Error(`verification failed: authored Pending row survives on ${row.node_id}`);
      }
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: ${rows.length} new envelope(s) read back and protocol-valid; fresh scratch replay clean — the schema carries the Pending default, authored Pending rows tombstoned (outside the reported keeps).`,
  );
}

// --- main -------------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    refuseIfContentOnKeyed(options.dataDir, options.workspace, CONTENT_CLASS, "migrate-task-status-default.mts");
    const snapshot = relay.latestSnapshot(options.workspace);
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`,
    );

    const store = buildScratchStore(relay, options.workspace);
    const plan = planTaskStatusDefault(store);
    store.close();

    console.log("\nplanned taskStatus default convergence:");
    if (plan.schemaMissing) {
      console.log("  the Status schema row is ABSENT — the web ensureTaskFamily self-heals the seed shape (with the default); nothing to append.");
      return;
    }
    if (plan.schemaInactive) {
      console.log("  the Status schema is SOFT-DELETED (active = 0) — a default is inert on a dead schema; nothing to append.");
      return;
    }
    if (plan.schemaUpdate) {
      console.log("  update the Status schema: defaultValue = the Pending option id");
    }
    for (const removal of plan.removals) {
      console.log(`  unset  ${removal.nodeId}  authored Pending row ${removal.elementId}`);
    }
    for (const keep of plan.keeps) {
      console.log(`  KEEP   ${keep.nodeId}  (${keep.reason})`);
    }
    if (plan.defaultDrift !== null) {
      console.log(`  reported drift (NOT touched): ${plan.defaultDrift}`);
    }
    if (planIsEmpty(plan)) {
      console.log("\nnothing to migrate — the workspace already converged.");
      return;
    }

    const envelopes = buildTaskStatusDefaultEnvelopes(options.workspace, plan);
    validateEnvelopes(envelopes);
    const simulation = simulateTaskStatusEnvelopes(relay, options.workspace, envelopes);
    for (const rejection of simulation.rejected) {
      console.log(`  KEEP   ${rejection.nodeId}  (${rejection.reason})`);
    }
    const keeps = [...plan.keeps, ...simulation.rejected];
    console.log(
      `\n${simulation.envelopes.length} envelope(s) built, protocol-validated, and applier-simulated clean (${envelopes.length - simulation.envelopes.length} dropped by simulation).`,
    );

    if (simulation.envelopes.length === 0) {
      console.log("\nnothing safe to append — every candidate was dropped (see KEEP lines above).");
      return;
    }

    if (!options.apply) {
      console.log("\ndry run — re-run with --apply to append these envelopes.");
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-task-status-default-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-task-status-default-${stamp}`);

    const { savedIds } = relay.ingest(simulation.envelopes);
    if (savedIds.length !== simulation.envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${simulation.envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);
    console.log("no epoch bump (Path A append) — restart the sync server to rehydrate its derived store.");

    verify(relay, options.workspace, simulation.envelopes.length, keeps);
    console.log("done.");
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
