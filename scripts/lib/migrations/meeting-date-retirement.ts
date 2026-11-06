/**
 * The meeting-date retirement migration's node-free planning core — the
 * client-side executor pattern (F3, 2026-11-06).
 *
 * Everything a keyed client needs to RUN this content-class migration
 * against its local UNSEALED derived store lives here: the pending probe,
 * the planner, the op builder, and the envelope builder. The module is
 * NODE-DEP-FREE by contract — it imports only from
 * `packages/protocol/src` (types + `newEnvelope`) and
 * `packages/domain/src` (the system UUID tables), plus a TYPE-ONLY `Store`
 * (erased at runtime — the store package's better-sqlite3 adapter never
 * loads through this file). No better-sqlite3, no RelayStorage, no fs — a
 * browser bundle (the web client's migrations runner) imports this file
 * through the vendor pin verbatim.
 *
 * The CLI (`scripts/migrate-meeting-date-retirement.mts`) delegates its
 * planning/envelope-building here unchanged — its rehearsal suite
 * (`apps/server/test/migrate-meeting-date-retirement.test.ts`) is the pin:
 * with the default identity and the same stamp, the core's envelopes are
 * byte-identical to what the script produced pre-extraction.
 *
 * Migration semantics (unchanged by the extraction — the script header is
 * the normative story): copy each meetingDate value onto the eventDate
 * slot where the slot is empty, remove the surviving meetingDate value
 * elements, unassign the node-level declarations, unset the
 * (meeting, meetingDate) binding row, soft-delete the schema. Nothing is
 * lost: conflicted nodes (eventDate already valued, more than one element)
 * are REPORTED, never silently dropped.
 */

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../../../packages/protocol/src/index.ts";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "../../../packages/domain/src/index.ts";
import type { Store } from "../../../packages/store/src/index.ts";

/**
 * The withdrawn seed UUID — retired from SYSTEM_PROPERTY_UUIDS (never
 * reuse), so the literal rides here (the migrate scripts' precedent for
 * withdrawn ids).
 */
export const MEETING_DATE_ID = "00000000-0000-0000-0003-000000000007";
const EVENT_DATE_ID = SYSTEM_PROPERTY_UUIDS.eventDate;
const MEETING_CLASS_ID = SYSTEM_CLASS_UUIDS.meeting;

/**
 * The migration's actor/device/client constants — the identity the CLI
 * path has always ridden. A client-side executor passes ITS session
 * constants instead (the envelopes then carry the client's actor/device,
 * sealed and pushed by the sync engine like any write).
 */
export interface MigrationIdentity {
  actorId: string;
  deviceId: string;
  client?: string;
}

export const MIGRATION_IDENTITY: MigrationIdentity = {
  actorId: "01920000-0000-7000-8000-0000000000b2",
  deviceId: "migrate-meeting-date-retirement",
  client: "migrate-meeting-date-retirement",
};

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
 * Plan from the converged derived store. Only LIVE state plans work: a
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

/**
 * The pending probe the client-side surface lists by: the migration needs
 * a run exactly when the planner finds work (a converged store plans
 * nothing — idempotent by construction).
 */
export function isPending(store: Store): boolean {
  return !planIsEmpty(planMeetingDateRetirement(store));
}

// --- ops ------------------------------------------------------------------------

/**
 * One migration write in its wire-neutral triple form — the shape a
 * client-side executor stamps with ITS session constants through the
 * normal write path (`buildEnvelope` + the single enqueue seam), so the
 * sync engine seals and pushes the op like any client write on a keyed
 * workspace. No new crypto, no wire change.
 */
export interface MigrationOp {
  opType: string;
  payload: Record<string, unknown>;
  affected: string[];
}

/**
 * The plan's ops as wire-neutral triples, in log order (copies, removals,
 * unassigns, the binding unset, the schema delete).
 */
export function buildRetirementOps(plan: RetirementPlan): MigrationOp[] {
  const ops: MigrationOp[] = [];
  for (const copy of plan.copies) {
    ops.push({
      opType: "property.set",
      payload: {
        objectId: copy.nodeId,
        propertySchemaId: EVENT_DATE_ID,
        value: copy.value,
        idx: 0,
        ...(copy.metadata !== null ? { metadata: copy.metadata } : {}),
      },
      affected: [copy.nodeId],
    });
  }
  for (const removal of plan.removals) {
    ops.push({
      opType: "property.unset",
      payload: { objectId: removal.nodeId, propertySchemaId: MEETING_DATE_ID, idx: removal.idx },
      affected: [removal.nodeId],
    });
  }
  for (const unassign of plan.unassigns) {
    ops.push({
      opType: "property.unassign",
      payload: { objectId: unassign.nodeId, propertySchemaId: MEETING_DATE_ID },
      affected: [unassign.nodeId],
    });
  }
  if (plan.bindingUnset) {
    ops.push({
      opType: "class.property.unset",
      payload: { classId: MEETING_CLASS_ID, propertySchemaId: MEETING_DATE_ID },
      affected: [MEETING_CLASS_ID],
    });
  }
  if (plan.schemaDelete) {
    ops.push({
      opType: "propertySchema.delete",
      payload: { propertySchemaId: MEETING_DATE_ID },
      affected: [],
    });
  }
  return ops;
}

// --- envelopes ------------------------------------------------------------------

/**
 * The CLI envelope builder: the plan's ops as fully-stamped protocol
 * envelopes. `stamp` is the HLC physical clock (the CLI passes
 * `Date.now()`); `identity` defaults to {@link MIGRATION_IDENTITY} — with
 * the default and the same stamp the output is byte-identical to what the
 * pre-extraction script built (the rehearsal suite's direct-core pin).
 */
export function buildRetirementEnvelopes(
  workspaceId: string,
  plan: RetirementPlan,
  stamp: number,
  identity: MigrationIdentity = MIGRATION_IDENTITY,
): Envelope[] {
  const ops = buildRetirementOps(plan);
  const envelopes: Envelope[] = [];
  let logical = 0;
  for (const op of ops) {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: identity.actorId,
        deviceId: identity.deviceId,
        ...(identity.client !== undefined ? { client: identity.client } : {}),
        hlc: { physical: stamp, logical: logical++ },
        affectedNodeIds: op.affected,
        opType: op.opType,
        payload: op.payload,
      }),
    );
  }
  return envelopes;
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema BEFORE anything is inserted (the CLI's pre-ingest
 * validation, shared so a client-side run validates the same way).
 */
export function validateRetirementEnvelopes(envelopes: Envelope[]): void {
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
