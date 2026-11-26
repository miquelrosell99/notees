/**
 * Task date-pills convergence (2026-11-26, the display-position program):
 * the task Scheduled and Deadline schemas (…0003-…0003 / …0003-…0002,
 * "Scheduled"/"Deadline", datetime) now carry the schema-level render
 * contract `display: "pill"` (packages/domain TASK_FAMILY_SEED) — the
 * values ride a dedicated pills row under the block, rendered even when
 * empty (the pill itself the add/edit affordance). New workspaces receive
 * the position from the seeds / the store applier ensure / the web
 * `ensureTaskFamily` upgrade pass; EXISTING workspaces carry the schemas
 * display-less (panel) — this script converges them.
 *
 * Path A append (the migrate-task-status-default shape, reduced to the one
 * envelope family this migration needs): per drifted workspace, at most two
 * `propertySchema.update {propertySchemaId, display: "pill"}` envelopes —
 * only when the schema row exists, is ACTIVE, and its stored display is not
 * already "pill" (patch semantics: the present key sets, absent keys keep —
 * SCHEMA.md "Class properties"). A schema carrying a CLIENT-AUTHORED
 * different display (a user deliberately moved it to bullet/inline) is
 * REPORTED, never touched (the migrate-pmid-property attribute-drift
 * posture); a missing/soft-deleted schema is reported and left alone (the
 * web ensure self-heals the seed shape — a position on a dead schema is
 * inert).
 *
 * NO LOCKSTEP GATE beyond the slice already shipped: `display` is an
 * EXISTING `propertySchema.update` payload key every port applies, and the
 * "pill" ENUM value itself is the fixture-gated slice that landed with
 * d2881f08a (the property-schema-display-pill.json fixture replays through
 * all three appliers) — this script only writes the new value, which the
 * port updates accept.
 *
 * Fresh ids/HLC at the log tail, NO epoch bump; a snapshot built before the
 * append catches up the tail on every hydration. Restart the sync server
 * after --apply so its running derived store rehydrates.
 *
 * Idempotent: a second run plans nothing (display already "pill").
 *
 * DRY RUN BY DEFAULT. --apply backs up relay.db, ingests through
 * RelayStorage.ingest, then verifies from the persisted log: read-back +
 * protocol validation, and a FRESH scratch replay asserting the converged
 * end state.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-task-date-pills.mts \
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
import { SYSTEM_PROPERTY_UUIDS } from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

import {
  buildScratchStore as scratchStoreBuild,
  refuseIfContentOnKeyed,
  type MigrationContentClass,
} from "./lib/scratch-store.ts";

/**
 * This migration's content class (the dev-ops contract, scripts/lib/scratch-store.ts):
 * "scaffolding" touches the schema rows every replica derives identically.
 */
export const CONTENT_CLASS: MigrationContentClass = "scaffolding";

/** The fixed task date-schema ids (exported for the e2e test precedent). */
export const DATE_SCHEMA_IDS = [
  { key: "Scheduled", id: SYSTEM_PROPERTY_UUIDS.taskScheduled },
  { key: "Deadline", id: SYSTEM_PROPERTY_UUIDS.taskDeadline },
] as const;

const ACTOR = "01920000-0000-7000-8000-0000000000c4";
const DEVICE = "migrate-task-date-pills";
const CLIENT = "migrate-task-date-pills";
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

function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
  return scratchStoreBuild(relay, workspaceId, ({ encrypted, pending }) => {
    console.log(
      `  (scratch: ${encrypted} encrypted + ${pending} pending envelope(s) skipped — ` +
        "a keyed workspace's sealed content is invisible to a server-side plan)",
    );
  });
}

// --- planning -------------------------------------------------------------------

export interface DatePillPlan {
  /** Schema ids that need the display patch. */
  updates: string[];
  /** Rows that exist but carry a client-authored different position. */
  drift: string[];
  /** Rows that are missing or soft-deleted (the web ensure self-heals). */
  absent: string[];
}

function planDatePills(store: Store): DatePillPlan {
  const plan: DatePillPlan = { updates: [], drift: [], absent: [] };
  // The scratch store is built for ONE workspace (its derived rows carry
  // only that workspace's content — the migrate-seed-pins precedent), so
  // the queries need no workspace scoping.
  const rows = store.database
    .prepare(
      "SELECT id, name, display, active FROM property_schema WHERE id IN (?, ?)",
    )
    .all(DATE_SCHEMA_IDS[0].id, DATE_SCHEMA_IDS[1].id) as Array<{
    id: string;
    name: string;
    display: string | null;
    active: number;
  }>;
  for (const target of DATE_SCHEMA_IDS) {
    const row = rows.find((entry) => entry.id === target.id);
    if (row === undefined || row.active !== 1) {
      plan.absent.push(`${target.key} (${target.id})`);
      continue;
    }
    if (row.display === "pill") continue;
    if (row.display === null || row.display === "panel") {
      plan.updates.push(target.id);
    } else {
      plan.drift.push(`${row.name} carries client-authored display "${row.display}"`);
    }
  }
  return plan;
}

// --- envelopes ------------------------------------------------------------------

export function buildDatePillEnvelopes(workspaceId: string, plan: DatePillPlan): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  let logical = 0;
  for (const schemaId of plan.updates) {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: logical++ },
        affectedNodeIds: [],
        opType: "propertySchema.update",
        payload: { propertySchemaId: schemaId, display: "pill" },
      }),
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
 * The applier gate, on a THROWAWAY scratch store (a fresh hydration of the
 * CURRENT log) so a bad envelope drops HERE, never mid-ingest.
 */
export function simulateDatePillEnvelopes(
  relay: RelayStorage,
  workspaceId: string,
  envelopes: Envelope[],
): Envelope[] {
  const store = buildScratchStore(relay, workspaceId);
  try {
    for (const envelope of envelopes) store.apply(envelope);
    return envelopes;
  } finally {
    store.close();
  }
}

// --- verification ---------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log: a FRESH scratch
 * store (snapshot + FULL tail, the appended envelopes included) replays
 * clean into the converged end state — both schemas carry display "pill".
 */
function verify(relay: RelayStorage, workspaceId: string, appended: number): void {
  const store = buildScratchStore(relay, workspaceId);
  try {
    for (const target of DATE_SCHEMA_IDS) {
      const row = store.database
        .prepare("SELECT display FROM property_schema WHERE id = ?")
        .get(target.id) as { display: string | null } | undefined;
      if (row === undefined) {
        throw new Error(`verify failed: ${target.key} schema row is absent after ingest`);
      }
      if (row.display !== "pill") {
        throw new Error(`verify failed: ${target.key} display reads "${row.display}", expected "pill"`);
      }
    }
    console.log(`verify: ${appended} appended envelope(s) replayed — both date schemas read display "pill".`);
  } finally {
    store.close();
  }
}

// --- main -------------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    refuseIfContentOnKeyed(options.dataDir, options.workspace, CONTENT_CLASS, "migrate-task-date-pills.mts");
    const snapshot = relay.latestSnapshot(options.workspace);
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`,
    );

    const store = buildScratchStore(relay, options.workspace);
    const plan = planDatePills(store);
    store.close();

    console.log("\nplanned task date-pills convergence:");
    for (const id of plan.updates) {
      const key = DATE_SCHEMA_IDS.find((target) => target.id === id)?.key ?? id;
      console.log(`  update the ${key} schema: display = "pill"`);
    }
    for (const line of plan.drift) {
      console.log(`  reported drift (NOT touched): ${line}`);
    }
    for (const line of plan.absent) {
      console.log(`  absent/soft-deleted (the web ensure self-heals): ${line}`);
    }
    if (plan.updates.length === 0) {
      console.log("\nnothing to migrate — the workspace already converged.");
      return;
    }

    const envelopes = buildDatePillEnvelopes(options.workspace, plan);
    validateEnvelopes(envelopes);
    const simulated = simulateDatePillEnvelopes(relay, options.workspace, envelopes);
    console.log(
      `\n${simulated.length} envelope(s) built, protocol-validated, and applier-simulated clean.`,
    );

    if (!options.apply) {
      console.log("\ndry run — re-run with --apply to append these envelopes.");
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-task-date-pills-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-task-date-pills-${stamp}`);

    const { savedIds } = relay.ingest(simulated);
    if (savedIds.length !== simulated.length) {
      throw new Error(`ingest saved ${savedIds.length}/${simulated.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);
    console.log("no epoch bump (Path A append) — restart the sync server to rehydrate its derived store.");

    verify(relay, options.workspace, simulated.length);
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
