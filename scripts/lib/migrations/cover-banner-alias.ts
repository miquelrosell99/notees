/**
 * The cover-banner-alias migration's node-free planning core — the
 * client-side executor pattern (F3 fleet extraction, 2026-11-06), the
 * Stage-1 proving pattern repeated. NODE-DEP-FREE by contract: imports only
 * the browser-safe workspace packages (protocol/domain/store), no node
 * builtins, no better-sqlite3, no RelayStorage, no fs.
 *
 * The CLI (scripts/migrate-cover-banner-alias.mts) delegates here
 * unchanged; the web repo's vendor-pinned rehearsal suite
 * (apps/web/test/migrate-cover-banner-alias.test.ts) is the pin (it imports
 * the planner/builder through the script's re-export).
 *
 * Semantics (unchanged by the extraction — the script header is the
 * normative story): each retired cover/banner/aliasOf property value moves
 * onto its wire node field (object.update — the LAST visible row's
 * resolution wins), with one unset per visible row of the (node, schema)
 * pair (element remove for element-authored rows, slot unset for the legacy
 * positional rows). Unresolvable winners are reported as skipped, never
 * silently dropped.
 */

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../../../packages/protocol/src/index.ts";
import { SYSTEM_PROPERTY_UUIDS } from "../../../packages/domain/src/index.ts";
import type { Store } from "../../../packages/store/src/index.ts";

/** The migration's actor/device/client constants — the CLI path's identity. */
export interface MigrationIdentity {
  actorId: string;
  deviceId: string;
  client?: string;
}

export const MIGRATION_IDENTITY: MigrationIdentity = {
  actorId: "01920000-0000-7000-8000-0000000000a3",
  deviceId: "system-wire-fields-migration",
  client: "migrate-cover-banner-alias",
};

/** One migration write in its wire-neutral triple form (the client-side
 *  executor stamps these with its session constants through the normal
 *  write path — no new crypto, no wire change). */
export interface MigrationOp {
  opType: string;
  payload: Record<string, unknown>;
  affected: string[];
}

const MOVES: ReadonlyArray<{
  schemaKey: "cover" | "banner" | "aliasOf";
  field: "coverAssetId" | "bannerAssetId" | "aliasedNodeId";
}> = [
  { schemaKey: "cover", field: "coverAssetId" },
  { schemaKey: "banner", field: "bannerAssetId" },
  { schemaKey: "aliasOf", field: "aliasedNodeId" },
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- planning -------------------------------------------------------------------

export interface VisibleRow {
  /** The element id (== the row id; the positional rows' deterministic id). */
  id: string;
  nodeId: string;
  schemaId: string;
  value: unknown;
  idx: number;
  hlcPhysical: number;
  hlcLogical: number;
  actorId: string | null;
}

export interface PlannedMove {
  nodeId: string;
  schemaId: string;
  field: "coverAssetId" | "bannerAssetId" | "aliasedNodeId";
  /** The wire-field target (the winning visible row's resolution). */
  targetId: string;
  /** One unset per visible row of the (node, schema) pair: an ELEMENT
   * remove for element-authored rows (uuid row id), a SLOT unset for the
   * legacy positional rows (the deterministic `node:schema:idx` id is not a
   * uuid, so it cannot ride elementId — the positional unset tombstones the
   * whole idx slot, which the visible-set derivation honors). */
  unsets: ReadonlyArray<{ elementId: string } | { idx: number }>;
  /** Human-readable row count for the dry-run print. */
  rows: number;
}

export interface SkippedMove {
  nodeId: string;
  schemaId: string;
  reason: string;
}

/**
 * The PG5 visible-set suppression (effective.ts/compiler parity): no winning
 * slot tombstone, no strictly-newer element tombstone.
 */
export const VISIBLE_PREDICATE = `
  NOT EXISTS (
    SELECT 1 FROM property_value_tombstone t
    WHERE t.node_id = pv.node_id AND t.property_schema_id = pv.property_schema_id
      AND t.idx = pv.idx
      AND (t.hlc_physical, t.hlc_logical, COALESCE(t.actor_id, '')) >=
          (pv.hlc_physical, pv.hlc_logical, COALESCE(pv.actor_id, ''))
  )
  AND NOT EXISTS (
    SELECT 1 FROM property_value_element_tombstone et
    WHERE et.element_id = pv.id
      AND (et.hlc_physical, et.hlc_logical) >
          (pv.hlc_physical, pv.hlc_logical)
  )`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve a retired-schema value to a node id. Canonical: { nodeId };
 * defensive: a bare uuid string; v1-migrated cover/banner: { hash } resolved
 * through the derived node_asset table. Returns the skip reason when nothing
 * resolves.
 */
export function resolveTarget(
  value: unknown,
  resolveAssetByHash: (hash: string) => string | undefined,
): { id: string } | { skip: string } {
  if (isRecord(value) && typeof value.nodeId === "string" && UUID_PATTERN.test(value.nodeId)) {
    return { id: value.nodeId };
  }
  if (typeof value === "string" && UUID_PATTERN.test(value)) {
    return { id: value };
  }
  if (isRecord(value) && typeof value.hash === "string") {
    const nodeId = resolveAssetByHash(value.hash);
    if (nodeId !== undefined) return { id: nodeId };
    return { skip: `v1 asset hash ${value.hash} has no asset node in the derived store` };
  }
  return { skip: `unrecognized value shape ${JSON.stringify(value)}` };
}

/**
 * Plan the moves from a converged derived store. Structural over the Store
 * class (the src/dist split under the dev-condition exports makes the class
 * itself import-fragile; only `database` is read).
 */
export function planMoves(
  store: Pick<Store, "database">,
): { moves: PlannedMove[]; skipped: SkippedMove[] } {
  const db = store.database;
  const schemaIds = MOVES.map((move) => SYSTEM_PROPERTY_UUIDS[move.schemaKey]);
  const fieldBySchema = new Map<string, "coverAssetId" | "bannerAssetId" | "aliasedNodeId">(
    MOVES.map((move) => [SYSTEM_PROPERTY_UUIDS[move.schemaKey], move.field]),
  );
  const rows = db
    .prepare(
      `SELECT pv.id, pv.node_id, pv.property_schema_id, pv.value, pv.idx,
              pv.hlc_physical, pv.hlc_logical, pv.actor_id
       FROM property_value pv
       WHERE pv.property_schema_id IN (?, ?, ?)
         AND ${VISIBLE_PREDICATE}
       ORDER BY pv.node_id, pv.property_schema_id,
                pv.hlc_physical, pv.hlc_logical, COALESCE(pv.actor_id, '')`,
    )
    .all(schemaIds[0], schemaIds[1], schemaIds[2]) as Array<Record<string, unknown>>;

  const assetNodeByHash = db.prepare(
    "SELECT node_id FROM node_asset WHERE hash = ? ORDER BY uploaded_at DESC LIMIT 1",
  );
  const resolveAssetByHash = (hash: string): string | undefined => {
    const row = assetNodeByHash.get(hash) as { node_id: string } | undefined;
    return row?.node_id;
  };

  // Group the visible rows per (node, schema): the field takes the LAST
  // row's resolution (the (hlc, actor) winner — the query orders ascending),
  // and every visible row gets its own unset.
  const groups = new Map<string, VisibleRow[]>();
  for (const raw of rows) {
    const row: VisibleRow = {
      id: String(raw.id),
      nodeId: String(raw.node_id),
      schemaId: String(raw.property_schema_id),
      value: JSON.parse(String(raw.value)) as unknown,
      idx: Number(raw.idx),
      hlcPhysical: Number(raw.hlc_physical),
      hlcLogical: Number(raw.hlc_logical),
      actorId: raw.actor_id === null || raw.actor_id === undefined ? null : String(raw.actor_id),
    };
    const key = `${row.nodeId}|${row.schemaId}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const moves: PlannedMove[] = [];
  const skipped: SkippedMove[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [nodeId, schemaId] = key.split("|") as [string, string];
    const field = fieldBySchema.get(schemaId)!;
    const winner = group[group.length - 1]!;
    const resolved = resolveTarget(winner.value, resolveAssetByHash);
    if ("skip" in resolved) {
      skipped.push({ nodeId, schemaId, reason: resolved.skip });
      continue;
    }
    moves.push({
      nodeId,
      schemaId,
      field,
      targetId: resolved.id,
      unsets: group.map((row) =>
        UUID_PATTERN.test(row.id) ? { elementId: row.id } : { idx: row.idx },
      ),
      rows: group.length,
    });
  }
  return { moves, skipped };
}


/**
 * The pending probe the client-side surface lists by: the migration needs
 * a run exactly when the planner finds a move.
 */
export function isPending(store: Pick<Store, "database">): boolean {
  return planMoves(store).moves.length > 0;
}

// --- ops + envelopes ------------------------------------------------------------

export function buildOps(moves: PlannedMove[]): MigrationOp[] {
  const ops: MigrationOp[] = [];
  for (const move of moves) {
    ops.push({
      opType: "object.update",
      payload: { objectId: move.nodeId, [move.field]: move.targetId },
      affected: [move.nodeId],
    });
    for (const unset of move.unsets) {
      ops.push({
        opType: "property.unset",
        payload: {
          objectId: move.nodeId,
          propertySchemaId: move.schemaId,
          ...unset,
        },
        affected: [move.nodeId],
      });
    }
  }
  return ops;
}

/**
 * The envelope builder: the moves as fully-stamped protocol envelopes, in
 * plan order (the object.update, then its unsets, per move). `stamp` is the
 * HLC physical clock (the CLI passes `Date.now()`); `identity` defaults to
 * {@link MIGRATION_IDENTITY}.
 */
export function buildEnvelopes(
  workspaceId: string,
  moves: PlannedMove[],
  stamp: number,
  identity: MigrationIdentity = MIGRATION_IDENTITY,
): Envelope[] {
  const ops = buildOps(moves);
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
