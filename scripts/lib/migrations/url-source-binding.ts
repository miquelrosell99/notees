/**
 * The url-source-binding migration's node-free planning core — the
 * client-side executor pattern (F3 fleet extraction, 2026-11-06), the
 * Stage-1 proving pattern repeated. NODE-DEP-FREE by contract: imports only
 * the browser-safe workspace packages (protocol/domain/store), no node
 * builtins, no better-sqlite3, no RelayStorage, no fs.
 *
 * The CLI (scripts/migrate-url-source-binding.mts) delegates here
 * unchanged.
 *
 * Semantics (unchanged by the extraction — the script header is the
 * normative story): the source↔url binding row rides class.property.set,
 * and a drifted class-local scope on the url schema clears to NULL FIRST
 * (the R5 dead-config guard — the binding is only legal on a schema whose
 * scope reaches source). The web_page↔url row is reported, never touched.
 */

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../../../packages/protocol/src/index.ts";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "../../../packages/domain/src/index.ts";
import type { Store } from "../../../packages/store/src/index.ts";

/** The migration's actor/device/client constants — the CLI path's identity. */
export interface MigrationIdentity {
  actorId: string;
  deviceId: string;
  client?: string;
}

export const MIGRATION_IDENTITY: MigrationIdentity = {
  actorId: "01920000-0000-7000-8000-0000000000a3",
  deviceId: "migrate-url-source-binding",
  client: "migrate-url-source-binding",
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
const URL_ID = SYSTEM_PROPERTY_UUIDS.url;

// --- planning -----------------------------------------------------------------

export interface BindingPlan {
  /** The url schema row is absent from this workspace entirely. */
  schemaMissing: boolean;
  /** A source↔url binding row already exists — nothing to do. */
  sourceBound: boolean;
  /** The web_page↔url row exists (reported, never touched). */
  webPageBound: boolean;
  /** The converged scope list (non-null = drifted from the global seed). */
  currentScope: string[] | null;
}

export function planBinding(store: Store): BindingPlan {
  const schema = store.database
    .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
    .get(URL_ID) as { scope_class_ids: string | null } | undefined;
  const binding = (classId: string): boolean =>
    store.database
      .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(classId, URL_ID) !== undefined;
  return {
    schemaMissing: schema === undefined,
    sourceBound: binding(SOURCE_ID),
    webPageBound: binding(SYSTEM_CLASS_UUIDS.web_page),
    currentScope:
      schema === undefined || schema.scope_class_ids === null
        ? null
        : (JSON.parse(schema.scope_class_ids) as string[]),
  };
}

/**
 * The pending probe the client-side surface lists by — the CLI's "nothing
 * to do" arms inverted: a missing url schema is the deploy self-heal's job
 * (it seeds the schema + binding together), an existing source binding
 * plans nothing.
 */
export function isPending(store: Store): boolean {
  const plan = planBinding(store);
  return !plan.schemaMissing && !plan.sourceBound;
}

// --- ops + envelopes ------------------------------------------------------------

/** The plan's ops as wire-neutral triples (the scope clear FIRST when it
 *  drifted, then the binding — the R5 ordering is load-bearing). */
export function buildOps(plan: BindingPlan): MigrationOp[] {
  const ops: MigrationOp[] = [];
  if (plan.currentScope !== null) {
    // R5 dead-config guard: the source binding is only legal on a schema
    // whose scope reaches source — the drifted local scope clears FIRST,
    // same ingest, ordered before the binding.
    ops.push({
      opType: "propertySchema.update",
      payload: { propertySchemaId: URL_ID, scopeClassIds: null },
      affected: [],
    });
  }
  ops.push({
    opType: "class.property.set",
    payload: { classId: SOURCE_ID, propertySchemaId: URL_ID },
    affected: [SOURCE_ID],
  });
  return ops;
}

/**
 * The envelope builder: the plan's ops as fully-stamped protocol envelopes.
 * `stamp` is the HLC physical clock (the CLI passes `Date.now()`);
 * `identity` defaults to {@link MIGRATION_IDENTITY}.
 */
export function buildEnvelopes(
  workspaceId: string,
  plan: BindingPlan,
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
