/**
 * The attachments-asset-type migration's node-free planning core — the
 * client-side executor pattern (F3 fleet extraction, 2026-11-06), the
 * Stage-1 proving pattern repeated. NODE-DEP-FREE by contract: imports only
 * the browser-safe workspace packages (protocol/store), no node builtins,
 * no better-sqlite3, no RelayStorage, no fs.
 *
 * The CLI (scripts/migrate-attachments-asset-type.mts) delegates here
 * unchanged; the web repo's vendor-pinned rehearsal suite
 * (apps/web/test/migrate-attachments-asset-type.test.ts) is the pin (it
 * imports the planner/builder through the script's re-export).
 *
 * Semantics (unchanged by the extraction — the script header is the
 * normative story): the attachments schema retypes to "asset" through the
 * propertySchema.create upsert (the ONLY wire path that can change a
 * schema's type), with every stored column riding verbatim.
 */

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../../../packages/protocol/src/index.ts";
import type { Store } from "../../../packages/store/src/index.ts";

/** The migration's actor/device/client constants — the CLI path's identity. */
export interface MigrationIdentity {
  actorId: string;
  deviceId: string;
  client?: string;
}

export const MIGRATION_IDENTITY: MigrationIdentity = {
  actorId: "01920000-0000-7000-8000-0000000000a5",
  deviceId: "system-asset-type-migration",
  client: "migrate-attachments-asset-type",
};

/** One migration write in its wire-neutral triple form (the client-side
 *  executor stamps these with its session constants through the normal
 *  write path — no new crypto, no wire change). */
export interface MigrationOp {
  opType: string;
  payload: Record<string, unknown>;
  affected: string[];
}

/** The attachments schema id — hardcoded on purpose: fixed seed vocabulary
 *  (SYSTEM_PROPERTY_UUIDS.attachments in @notees/domain). */
export const ATTACHMENTS_SCHEMA_ID = "00000000-0000-0000-0000-000000000011";

// --- planning -------------------------------------------------------------------

export interface AttachmentsSchemaRow {
  name: string;
  type: string;
  multi: number;
  /** The v24 locality column (JSON class-id list; NULL = global) — the
   *  retired `scope` enum column was rebuilt away at store v24; the list rides the retype envelope verbatim. */
  scopeClassIds: string | null;
  options: string;
  display: string | null;
  hideWhenEmpty: number | null;
}

export interface AssetTypePlan {
  /** The schema row is absent (never authored here — the web self-heal does it). */
  schemaAbsent: boolean;
  /** The retype envelope is needed (row exists, type not yet "asset"). */
  retypeNeeded: boolean;
  row: AttachmentsSchemaRow | null;
}

/**
 * Plan the retype from a converged derived store. Structural over the Store
 * class (the src/dist split under the dev-condition exports makes the class
 * itself import-fragile; only `database` is read).
 */
export function planAssetType(store: Pick<Store, "database">): AssetTypePlan {
  const row = store.database
    .prepare(
      `SELECT name, type, multi, scope_class_ids AS scopeClassIds, options, display, hide_when_empty AS hideWhenEmpty
       FROM property_schema WHERE id = ?`,
    )
    .get(ATTACHMENTS_SCHEMA_ID) as AttachmentsSchemaRow | undefined;
  if (row === undefined) return { schemaAbsent: true, retypeNeeded: false, row: null };
  return {
    schemaAbsent: false,
    retypeNeeded: row.type !== "asset",
    row,
  };
}

/**
 * The pending probe the client-side surface lists by: the migration needs
 * a run exactly when the planner finds a retype (a schema-absent store is
 * the web self-heal's job).
 */
export function isPending(store: Pick<Store, "database">): boolean {
  return planAssetType(store).retypeNeeded;
}

// --- ops + envelopes ------------------------------------------------------------

/** The plan's ops as wire-neutral triples (empty when nothing to retype). */
export function buildOps(plan: AssetTypePlan): MigrationOp[] {
  if (!plan.retypeNeeded || plan.row === null) return [];
  const row = plan.row;
  let options: unknown = [];
  try {
    const parsed: unknown = JSON.parse(row.options);
    if (Array.isArray(parsed)) options = parsed;
  } catch {
    options = [];
  }
  let scopeClassIds: string[] | null = null;
  try {
    const parsed: unknown = row.scopeClassIds === null ? null : JSON.parse(row.scopeClassIds);
    scopeClassIds = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : null;
  } catch {
    scopeClassIds = null;
  }
  return [
    {
      opType: "propertySchema.create",
      payload: {
        propertySchemaId: ATTACHMENTS_SCHEMA_ID,
        name: row.name,
        type: "asset",
        multi: row.multi === 1,
        // The scope list rides verbatim (absent = global) — the retired
        // `scope` enum is rejected outright by the strict schema.
        ...(scopeClassIds !== null ? { scopeClassIds } : {}),
        options: options as Array<{ id: string; label: string }>,
        // No targetClassFilter: the asset type carries the filter implicitly
        // now — the explicit column retires (NULL on the upsert).
        ...(row.display !== null ? { display: row.display as "panel" | "bullet" | "inline" } : {}),
        ...(row.hideWhenEmpty !== null ? { hideWhenEmpty: row.hideWhenEmpty === 1 } : {}),
      },
      affected: [],
    },
  ];
}

/**
 * The envelope builder: the plan's ops as fully-stamped protocol envelopes.
 * `stamp` is the HLC physical clock (the CLI passes `Date.now()`);
 * `identity` defaults to {@link MIGRATION_IDENTITY}.
 */
export function buildEnvelopes(
  workspaceId: string,
  plan: AssetTypePlan,
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
