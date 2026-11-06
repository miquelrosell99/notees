/**
 * Meeting-date retirement (2026-10-30): the `meetingDate` property (…0003-
 * …0007, "Meeting date") is WITHDRAWN from the system seed manifest — a
 * meeting IS-A event and already carries the inherited `eventDate` (…0003-
 * …0010) through the extends-aware binding resolution, so the class-local
 * date duplicate rendered twice on every meeting. New workspaces never
 * receive the schema/binding (the seeds no longer emit it, and the web
 * ensure's MEETING_FAMILY dropped it); EXISTING workspaces carry it in their
 * log — this script converges them.
 *
 * The op set stays inside the THREE-CLIENT INTERSECTION (the lockstep law):
 * `property.assign`/`unassign`/`empty` are TS-only today (the GTK/Flutter
 * ports skip them with a warning), so the cleanup rides only ops every
 * applier implements:
 *
 *   1. COPY each meetingDate value to the eventDate slot (property.set,
 *      verbatim value + metadata) — only where the node has NO eventDate
 *      value yet (a valued eventDate wins; the meetingDate value stays and
 *      the node is REPORTED, never silently dropped).
 *   2. REMOVE each surviving meetingDate value element (property.unset —
 *      the single-value slot's positional remove at its idx; the payload
 *      omits elementId, the deterministic positional id is not a UUID).
 *   3. REMOVE the node-level declaration (property.unassign) where one
 *      exists — TS-only state in practice (ports never applied assign ops,
 *      so they skip this envelope as a harmless no-op).
 *   4. UNSET the (meeting, meetingDate) binding row (class.property.unset).
 *   5. SOFT-DELETE the schema (propertySchema.delete — active = 0): out of
 *      every list/picker surface; the row stays so history still validates.
 *
 * Nothing is lost: every copied value lands on the property the meeting
 * class actually renders (eventDate, inherited from event). Idempotent: a
 * second run plans nothing (values gone, binding gone, schema active = 0);
 * conflicted nodes re-report deterministically.
 *
 * Path A append (the migrate-seed-pins shape): fresh ids/HLC at the log
 * tail, NO epoch bump; a snapshot built before the append catches up the
 * tail on every hydration. Restart the sync server after --apply so its
 * running derived store rehydrates.
 *
 * LOCKSTEP GATE: every appended op type (property.set/unset, unassign,
 * class.property.unset, propertySchema.delete) parses on all three appliers
 * TODAY (checked 2026-10-30 against the GTK/Flutter checkouts — the delete
 * op ships the property-schema-delete.json fixture). The property.unassign
 * envelopes ride TS-only assignment state; ports skip them as no-ops.
 * Confirm the RELEASED client versions parse propertySchema.delete before
 * --apply on a live fleet (the migrations.md §0 law).
 *
 * DRY RUN BY DEFAULT. --apply backs up relay.db, ingests through
 * RelayStorage.ingest, then verifies from the persisted log: read-back +
 * protocol validation, and a FRESH scratch replay (snapshot + full tail)
 * asserting the converged end state.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-meeting-date-retirement.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { envelopeSchema, payloadSchemaFor, type Envelope } from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

import {
  buildScratchStore as scratchStoreBuild,
  refuseIfContentOnKeyed,
  type MigrationContentClass,
} from "./lib/scratch-store.ts";

// The migration's planning core is NODE-FREE (scripts/lib/migrations/ — the
// client-side executor pattern): the pending probe, the planner, the op
// builder, and the envelope builder all live there, importable verbatim by
// a keyed client through the vendor pin. This script keeps the CLI shape by
// delegating; its rehearsal suite pins the delegation byte-identical.
import {
  buildRetirementEnvelopes,
  MEETING_DATE_ID,
  MIGRATION_IDENTITY,
  planIsEmpty,
  planMeetingDateRetirement,
  validateRetirementEnvelopes,
  type RetirementConflict,
  type RetirementPlan,
} from "./lib/migrations/meeting-date-retirement.ts";
import { SYSTEM_CLASS_UUIDS } from "../packages/domain/src/index.ts";

const MEETING_CLASS_ID = SYSTEM_CLASS_UUIDS.meeting;

export {
  buildRetirementEnvelopes,
  MEETING_DATE_ID,
  planIsEmpty,
  planMeetingDateRetirement,
} from "./lib/migrations/meeting-date-retirement.ts";

/**
 * This migration's content class (the dev-ops contract, scripts/lib/scratch-store.ts):
 * "content" plans against the object graph — refused server-side on a keyed workspace (run it through a keyed client).
 */
export const CONTENT_CLASS: MigrationContentClass = "content";

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

// --- planning + envelopes -------------------------------------------------------
// planMeetingDateRetirement / planIsEmpty / buildRetirementEnvelopes /
// validateRetirementEnvelopes live in the node-free core, re-exported above.
// The op-triple primitive behind the envelope builder is the shape a
// client-side executor stamps with its session constants through the
// normal write path.


/**
 * The applier gate: replay the plan's envelopes on a THROWAWAY scratch store
 * (a fresh hydration of the CURRENT log) and drop the ones the applier
 * rejects — a copy whose node can't take eventDate (its class closure misses
 * the event scope) rejects HERE, not mid-ingest. Dropping a copy drops its
 * node's removal too: an un-copied value is never unset (nothing is lost).
 * Returns the surviving envelopes plus a conflict per dropped node.
 */
export function simulateRetirementEnvelopes(
  relay: RelayStorage,
  workspaceId: string,
  envelopes: Envelope[],
): { envelopes: Envelope[]; rejected: RetirementConflict[] } {
  const store = buildScratchStore(relay, workspaceId);
  const rejected: RetirementConflict[] = [];
  const blockedNodes = new Set<string>();
  const surviving: Envelope[] = [];
  try {
    for (const envelope of envelopes) {
      const payload = envelope.payload as { objectId?: string };
      const nodeId = payload.objectId;
      if (nodeId !== undefined && blockedNodes.has(nodeId)) continue;
      try {
        store.apply(envelope);
        surviving.push(envelope);
      } catch (error) {
        if (nodeId === undefined) {
          // A node-less envelope (binding unset / schema delete) must never
          // fail on a converged log — surface it loud.
          throw error;
        }
        blockedNodes.add(nodeId);
        rejected.push({
          nodeId,
          reason: `applier rejected the eventDate copy: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    store.close();
  }
  return { envelopes: surviving, rejected };
}

// --- verification ---------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log: the new
 * envelopes read back + protocol-validate, and a FRESH scratch store
 * (snapshot + FULL tail, the appended envelopes included) replays clean
 * into the converged end state: no live meetingDate values outside the
 * reported conflicts, no declarations, no binding, the schema soft-deleted.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  expectedCount: number,
  conflicts: RetirementConflict[],
): void {
  const rows = relay
    .allEnvelopes(workspaceId)
    .filter((envelope) => envelope.deviceId === MIGRATION_IDENTITY.deviceId);
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
    const conflicted = new Set(conflicts.map((conflict) => conflict.nodeId));
    const remaining = db
      .prepare("SELECT node_id FROM property_value WHERE property_schema_id = ?")
      .all(MEETING_DATE_ID) as Array<{ node_id: string }>;
    for (const row of remaining) {
      if (!conflicted.has(row.node_id)) {
        throw new Error(`verification failed: meetingDate value survives on ${row.node_id}`);
      }
    }
    const declaration = db
      .prepare("SELECT node_id FROM node_property WHERE property_schema_id = ? LIMIT 1")
      .get(MEETING_DATE_ID) as { node_id: string } | undefined;
    if (declaration !== undefined) {
      throw new Error(`verification failed: meetingDate declaration survives on ${declaration.node_id}`);
    }
    const binding = db
      .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(MEETING_CLASS_ID, MEETING_DATE_ID);
    if (binding !== undefined) {
      throw new Error("verification failed: the (meeting, meetingDate) binding row survives");
    }
    const schema = db
      .prepare("SELECT active FROM property_schema WHERE id = ?")
      .get(MEETING_DATE_ID) as { active: number } | undefined;
    if (schema === undefined) {
      throw new Error("verification failed: the meetingDate schema row is gone (soft delete keeps it)");
    }
    if (schema.active !== 0) {
      throw new Error("verification failed: the meetingDate schema is still active");
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: ${rows.length} new envelope(s) read back and protocol-valid; fresh scratch replay clean — values copied/removed, declarations + binding gone, schema soft-deleted.`,
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
    refuseIfContentOnKeyed(options.dataDir, options.workspace, CONTENT_CLASS, "migrate-meeting-date-retirement.mts");
    const snapshot = relay.latestSnapshot(options.workspace);
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`,
    );

    const store = buildScratchStore(relay, options.workspace);
    const plan = planMeetingDateRetirement(store);
    store.close();

    console.log("\nplanned meetingDate retirement:");
    for (const copy of plan.copies) {
      console.log(`  copy   ${copy.nodeId}  meetingDate → eventDate`);
    }
    for (const removal of plan.removals) {
      console.log(`  unset  ${removal.nodeId}  meetingDate element ${removal.elementId}`);
    }
    for (const unassign of plan.unassigns) {
      console.log(`  unassign ${unassign.nodeId}  meetingDate declaration`);
    }
    if (plan.bindingUnset) console.log("  unset  the (meeting, meetingDate) binding row");
    if (plan.schemaDelete) console.log("  delete the meetingDate schema (soft — active = 0)");
    for (const conflict of plan.conflicts) {
      console.log(`  KEEP   ${conflict.nodeId}  (${conflict.reason})`);
    }
    if (planIsEmpty(plan)) {
      console.log("\nnothing to migrate — the workspace already converged.");
      return;
    }

    const envelopes = buildRetirementEnvelopes(options.workspace, plan, Date.now());
    validateRetirementEnvelopes(envelopes);
    const simulation = simulateRetirementEnvelopes(relay, options.workspace, envelopes);
    for (const rejection of simulation.rejected) {
      console.log(`  KEEP   ${rejection.nodeId}  (${rejection.reason})`);
    }
    const conflicts = [...plan.conflicts, ...simulation.rejected];
    console.log(
      `\n${simulation.envelopes.length} envelope(s) built, protocol-validated, and applier-simulated clean (${envelopes.length - simulation.envelopes.length} dropped by simulation).`,
    );

    if (simulation.envelopes.length === 0) {
      console.log("\nnothing safe to append — every candidate was dropped (see KEEP lines above).");
      return;
    }

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to append these envelopes (LOCKSTEP GATE: confirm the released GTK/Flutter versions parse propertySchema.delete first).",
      );
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-meeting-date-retirement-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-meeting-date-retirement-${stamp}`);

    const { savedIds } = relay.ingest(simulation.envelopes);
    if (savedIds.length !== simulation.envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${simulation.envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);
    console.log("no epoch bump (Path A append) — restart the sync server to rehydrate its derived store.");

    verify(relay, options.workspace, simulation.envelopes.length, conflicts);
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
