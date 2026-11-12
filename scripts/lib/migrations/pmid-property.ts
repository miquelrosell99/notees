/**
 * The pmid-property migration's node-free planning core — the client-side
 * executor pattern (F3 fleet extraction, 2026-11-06), the Stage-1 proving
 * pattern repeated. NODE-DEP-FREE by contract: imports only the
 * browser-safe workspace packages (protocol/domain/store), no node builtins,
 * no better-sqlite3, no RelayStorage, no fs.
 *
 * The CLI (scripts/migrate-pmid-property.mts) delegates here unchanged; its
 * rehearsal suite (apps/server/test/migrate-pmid-property.test.ts) is the
 * pin (it imports the planner/builder through the script's re-export).
 *
 * Semantics (unchanged by the extraction — the script header is the
 * normative story): the pmid schema seeds at the reserved id (text, scoped
 * [source]) when missing, a class-local drifted scope converges to the
 * seed's [source] before the binding, and the source↔pmid binding row
 * carries the seed's PIN tier. Attribute drift on an existing schema is
 * reported, never touched.
 */

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../../../packages/protocol/src/index.ts";
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "../../../packages/domain/src/index.ts";
import type { Store } from "../../../packages/store/src/index.ts";

/** The migration's actor/device/client constants — the CLI path's identity. */
export interface MigrationIdentity {
  actorId: string;
  deviceId: string;
  client?: string;
}

export const MIGRATION_IDENTITY: MigrationIdentity = {
  actorId: "01920000-0000-7000-8000-0000000000a7",
  deviceId: "migrate-pmid-property",
  client: "migrate-pmid-property",
};

/** One migration write in its wire-neutral triple form (the client-side
 *  executor stamps these with its session constants through the normal
 *  write path — no new crypto, no wire change). */
export interface MigrationOp {
  opType: string;
  payload: Record<string, unknown>;
  affected: string[];
}

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const PMID_ID = SYSTEM_PROPERTY_UUIDS.pmid;

// --- plan shape -----------------------------------------------------------------

export interface PmidPlan {
  /** The source class NODE is absent — the citation ensure self-heals. */
  sourceClassMissing: boolean;
  /** The pmid schema row is absent from this workspace entirely. */
  schemaMissing: boolean;
  /** A source↔pmid binding row already exists (pinned or not). */
  sourceBound: boolean;
  /** The existing binding row's pinned tier flag (meaningful when bound). */
  boundPinned: boolean;
  /** The converged scope list; null = global (wider than the seed, legal). */
  currentScope: string[] | null;
  /** True when the stored scope is a class-local list excluding source. */
  scopeBlocksBinding: boolean;
  /** Attribute drift on an existing schema — reported, never touched. */
  attributeDrift: string[];
}

export function planPmid(store: Store): PmidPlan {
  const sourceNode = store.database
    .prepare("SELECT id FROM node WHERE id = ? AND is_class = 1")
    .get(SOURCE_ID);
  const schema = store.database
    .prepare("SELECT name, type, scope_class_ids FROM property_schema WHERE id = ?")
    .get(PMID_ID) as
    | { name: string; type: string; scope_class_ids: string | null }
    | undefined;
  const binding = store.database
    .prepare("SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
    .get(SOURCE_ID, PMID_ID) as { pinned: number } | undefined;

  const attributeDrift: string[] = [];
  if (schema !== undefined) {
    if (schema.type !== "text") attributeDrift.push(`type=${schema.type} (seed: text)`);
    if (schema.name !== SYSTEM_PROPERTY_DISPLAY_NAMES.pmid) {
      attributeDrift.push(`name=${schema.name} (seed: ${SYSTEM_PROPERTY_DISPLAY_NAMES.pmid})`);
    }
  }
  const currentScope =
    schema === undefined || schema.scope_class_ids === null
      ? null
      : (JSON.parse(schema.scope_class_ids) as string[]);
  return {
    sourceClassMissing: sourceNode === undefined,
    schemaMissing: schema === undefined,
    sourceBound: binding !== undefined,
    boundPinned: binding?.pinned === 1,
    currentScope,
    scopeBlocksBinding:
      currentScope !== null && !currentScope.includes(SOURCE_ID),
    attributeDrift,
  };
}

/**
 * The pending probe the client-side surface lists by: the migration needs
 * a run exactly when the planner finds work (a converged store plans
 * nothing — idempotent by construction).
 */
export function isPending(store: Store): boolean {
  const plan = planPmid(store);
  // The CLI's "nothing to do" arms inverted: a missing source class node is
  // the citation ensure's job (self-heals on the next source create), and a
  // converged store (schema + pinned binding + unblocked scope) plans nothing.
  if (plan.sourceClassMissing) return false;
  return plan.schemaMissing || !plan.sourceBound || !plan.boundPinned || plan.scopeBlocksBinding;
}

// --- ops + envelopes --------------------------------------------------------------

export function buildOps(plan: PmidPlan): MigrationOp[] {
  const ops: MigrationOp[] = [];
  const stamp = (opType: string, payload: Record<string, unknown>, affected: string[]): void => {
    ops.push({ opType, payload, affected });
  };

  if (plan.schemaMissing) {
    // The seed shape at the reserved id: text, scoped [source] (the spec's
    // bindTo — the schema is local to the source family like citekey).
    stamp("propertySchema.create", {
      propertySchemaId: PMID_ID,
      name: SYSTEM_PROPERTY_DISPLAY_NAMES.pmid,
      type: "text",
      scopeClassIds: [SOURCE_ID],
    }, []);
  } else if (plan.scopeBlocksBinding) {
    // R5 dead-config guard: the source binding is only legal on a schema
    // whose scope reaches source — the drifted class-local scope converges
    // to the seed's [source] FIRST, same ingest, ordered before the binding.
    stamp("propertySchema.update", { propertySchemaId: PMID_ID, scopeClassIds: [SOURCE_ID] }, []);
  }
  if (plan.schemaMissing || !plan.sourceBound || !plan.boundPinned) {
    // The binding row with the seed's PIN tier (creates or patches the pin).
    stamp("class.property.set", { classId: SOURCE_ID, propertySchemaId: PMID_ID, pinned: true }, [SOURCE_ID]);
  }
  return ops;
}

/**
 * The envelope builder: the plan's ops as fully-stamped protocol envelopes.
 * `stamp` is the HLC physical clock (the CLI passes `Date.now()`);
 * `identity` defaults to {@link MIGRATION_IDENTITY}.
 */
export function buildEnvelopes(
  workspaceId: string,
  plan: PmidPlan,
  stamp: number,
  identity: MigrationIdentity = MIGRATION_IDENTITY,
): Envelope[] {
  const ops = buildOps(plan);
  return ops.map((op, logical) =>
    newEnvelope({
      workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
      ...(identity.client !== undefined ? { client: identity.client } : {}),
      hlc: { physical: stamp, logical },
      affectedNodeIds: op.affected,
      opType: op.opType,
      payload: op.payload,
    }),
  );
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
export function validateEnvelopes(envelopes: Envelope[]): void {
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
