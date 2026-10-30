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

/**
 * The withdrawn seed UUID — retired from SYSTEM_PROPERTY_UUIDS (never
 * reuse), so the literal rides here (the migrate scripts' precedent for
 * withdrawn ids).
 */
export const MEETING_DATE_ID = "00000000-0000-0000-0003-000000000007";
const EVENT_DATE_ID = SYSTEM_PROPERTY_UUIDS.eventDate;
const MEETING_CLASS_ID = SYSTEM_CLASS_UUIDS.meeting;

const ACTOR = "01920000-0000-7000-8000-0000000000b2";
const DEVICE = "migrate-meeting-date-retirement";
const CLIENT = "migrate-meeting-date-retirement";
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
 * Restore the workspace's latest snapshot into a fresh in-memory store and
 * apply every log envelope after it (the sync server's hydration shape).
 * Throws on any tail apply failure — the plan reads the CONVERGED state.
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

// --- planning -------------------------------------------------------------------

export interface RetirementCopy {
  nodeId: string;
  value: unknown;
  metadata: Record<string, unknown> | null;
}

export interface RetirementRemoval {
  nodeId: string;
  /** The positional slot idx (the deterministic element id is node:schema:idx). */
  idx: number;
  /** The property_value row id — report-only (the wire payload omits it: the
   *  positional id is not a UUID, and single-value slots remove by idx). */
  elementId: string;
}

export interface RetirementConflict {
  nodeId: string;
  reason: string;
}

export interface RetirementPlan {
  /** meetingDate values to copy onto the eventDate slot (idx 0). */
  copies: RetirementCopy[];
  /** meetingDate value elements to unset after the copy. */
  removals: RetirementRemoval[];
  /** Nodes whose meetingDate value STAYS (reported, never dropped). */
  conflicts: RetirementConflict[];
  /** Nodes carrying the node-level declaration (property.unassign). */
  unassigns: Array<{ nodeId: string }>;
  /** The (meeting, meetingDate) binding row exists — unset it. */
  bindingUnset: boolean;
  /** The schema row exists and is active — soft-delete it. */
  schemaDelete: boolean;
}

/**
 * Plan from the converged scratch store. Only LIVE state plans work: a
 * valued node copies when its eventDate slot is EMPTY and it carries exactly
 * one meetingDate element; anything else (eventDate already valued, more
 * than one meetingDate element) is a conflict — the value stays put and the
 * node is reported.
 */
export function planMeetingDateRetirement(store: Store): RetirementPlan {
  const db = store.database;
  const plan: RetirementPlan = {
    copies: [],
    removals: [],
    conflicts: [],
    unassigns: [],
    bindingUnset: false,
    schemaDelete: false,
  };

  const valued = db
    .prepare(
      `SELECT node_id, id, idx, value, metadata FROM property_value
       WHERE property_schema_id = ? ORDER BY node_id, idx, id`,
    )
    .all(MEETING_DATE_ID) as Array<{
    node_id: string;
    id: string;
    idx: number;
    value: string;
    metadata: string | null;
  }>;
  const byNode = new Map<
    string,
    Array<{ id: string; idx: number; value: string; metadata: string | null }>
  >();
  for (const row of valued) {
    const list = byNode.get(row.node_id) ?? [];
    list.push({ id: row.id, idx: row.idx, value: row.value, metadata: row.metadata });
    byNode.set(row.node_id, list);
  }

  const eventDated = db.prepare(
    "SELECT 1 FROM property_value WHERE node_id = ? AND property_schema_id = ? LIMIT 1",
  );
  for (const [nodeId, rows] of byNode) {
    if (rows.length > 1) {
      plan.conflicts.push({
        nodeId,
        reason: `${rows.length} meetingDate elements — manual review (the slot is single-value)`,
      });
      continue;
    }
    if (eventDated.get(nodeId, EVENT_DATE_ID) !== undefined) {
      plan.conflicts.push({
        nodeId,
        reason: "eventDate already carries a value — the meetingDate value stays for manual review",
      });
      continue;
    }
    const row = rows[0]!;
    plan.copies.push({
      nodeId,
      value: JSON.parse(row.value) as unknown,
      metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as Record<string, unknown>),
    });
    plan.removals.push({ nodeId, idx: row.idx, elementId: row.id });
  }

  const assigned = db
    .prepare("SELECT node_id FROM node_property WHERE property_schema_id = ?")
    .all(MEETING_DATE_ID) as Array<{ node_id: string }>;
  for (const row of assigned) {
    plan.unassigns.push({ nodeId: row.node_id });
  }

  plan.bindingUnset =
    db
      .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(MEETING_CLASS_ID, MEETING_DATE_ID) !== undefined;

  const schema = db
    .prepare("SELECT active FROM property_schema WHERE id = ?")
    .get(MEETING_DATE_ID) as { active: number } | undefined;
  plan.schemaDelete = schema !== undefined && schema.active === 1;

  return plan;
}

export function planIsEmpty(plan: RetirementPlan): boolean {
  return (
    plan.copies.length === 0 &&
    plan.removals.length === 0 &&
    plan.unassigns.length === 0 &&
    !plan.bindingUnset &&
    !plan.schemaDelete
  );
}

// --- envelopes ------------------------------------------------------------------

export function buildRetirementEnvelopes(
  workspaceId: string,
  plan: RetirementPlan,
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

  for (const copy of plan.copies) {
    push(
      "property.set",
      {
        objectId: copy.nodeId,
        propertySchemaId: EVENT_DATE_ID,
        value: copy.value,
        idx: 0,
        ...(copy.metadata !== null ? { metadata: copy.metadata } : {}),
      },
      [copy.nodeId],
    );
  }
  for (const removal of plan.removals) {
    push(
      "property.unset",
      { objectId: removal.nodeId, propertySchemaId: MEETING_DATE_ID, idx: removal.idx },
      [removal.nodeId],
    );
  }
  for (const unassign of plan.unassigns) {
    push(
      "property.unassign",
      { objectId: unassign.nodeId, propertySchemaId: MEETING_DATE_ID },
      [unassign.nodeId],
    );
  }
  if (plan.bindingUnset) {
    push(
      "class.property.unset",
      { classId: MEETING_CLASS_ID, propertySchemaId: MEETING_DATE_ID },
      [MEETING_CLASS_ID],
    );
  }
  if (plan.schemaDelete) {
    push("propertySchema.delete", { propertySchemaId: MEETING_DATE_ID }, []);
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

    const envelopes = buildRetirementEnvelopes(options.workspace, plan);
    validateEnvelopes(envelopes);
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
