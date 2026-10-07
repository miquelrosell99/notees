/**
 * Cover/banner/alias property retirement (owner 2026-10-07 — the wire node
 * fields ruling): the three node fundamentals move OFF the retired property
 * assertions ONTO object.update wire fields, and live workspaces converge by
 * APPENDED envelopes — the immutable relay log is never edited:
 *
 *  - cover  (…000000000005, image-typed)  → `coverAssetId`
 *  - banner (…000000000006, image-typed)  → `bannerAssetId`
 *  - aliasOf (…000000000029, object-typed) → `aliasedNodeId`
 *
 * The retired schemas stay in SYSTEM_PROPERTY_UUIDS (history never reuses
 * ids) but nothing seeds or binds them anymore; the wire fields are the
 * authority going forward (SCHEMA.md "Node structure"). This script rewrites
 * every live property assertion on the three schemas into the new field and
 * then unsets the assertion, per carrier node:
 *
 *  - object.update { objectId, <field>: <target> } — the field takes the
 *    target of the LATEST visible value row (a single-value slot by design);
 *  - property.unset for EVERY visible row of the (node, schema) pair: an
 *    ELEMENT remove ({elementId}) for element-authored rows (a uuid row id),
 *    a SLOT unset ({idx}, no elementId) for legacy positional rows — the
 *    deterministic `node:schema:idx` row id is not a uuid and cannot ride
 *    elementId; the slot tombstone retires the whole idx slot.
 *
 * Value shapes (the v1-migration wrinkle): the canonical carrier is the
 * node-reference record { nodeId }; a bare uuid string is accepted
 * defensively; v1-migrated cover/banner data references the asset by CAS
 * hash ({ hash, filename }) with no node id — the script resolves the hash
 * through the derived node_asset table (the v1 asset copy attaches the
 * bytes to an asset node). Anything unresolvable is SKIPPED with a note: its
 * assertion stays untouched so a fixed re-run picks it up.
 *
 * The plan is read from a SCRATCH derived store: the workspace's latest
 * snapshot restored into memory + the log tail applied on top (the sync
 * server's hydration shape), so the values rewritten are the converged log
 * state, not a possibly stale replica. Every envelope is validated through
 * the protocol zod schemas (envelope + per-op payload) BEFORE anything is
 * inserted. Idempotent: a second run plans nothing (the unsets consumed the
 * assertions).
 *
 * LOCKSTEP LAW (migrations.md): object.update's new keys are additive fields
 * on a STRICT payload — a pre-batch client rejects the envelopes and stalls.
 * Run this ONLY after the GTK/Flutter ports accept the wire fields (and the
 * alias read-paths ride them); until then the old property reads keep
 * serving the data.
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan
 * (per node: field, target, visible rows) and writes nothing. --apply
 * inserts through RelayStorage.ingest (one transaction) and then verifies:
 * the new envelopes read back from the log, a FRESH scratch store applies
 * the tail since the snapshot with zero StoreError throws, every planned
 * node carries the field, and no visible assertion on the three schemas
 * remains.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-cover-banner-alias.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

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
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a3";
const DEVICE = "system-wire-fields-migration";
const CLIENT = "migrate-cover-banner-alias";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

/** The retired schema → wire field mapping (the whole migration in one table). */
const MOVES: ReadonlyArray<{
  schemaKey: "cover" | "banner" | "aliasOf";
  field: "coverAssetId" | "bannerAssetId" | "aliasedNodeId";
}> = [
  { schemaKey: "cover", field: "coverAssetId" },
  { schemaKey: "banner", field: "bannerAssetId" },
  { schemaKey: "aliasOf", field: "aliasedNodeId" },
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const VISIBLE_PREDICATE = `
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

// --- envelopes ----------------------------------------------------------------

export function buildEnvelopes(workspaceId: string, moves: PlannedMove[]): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  for (const move of moves) {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: envelopes.length },
        affectedNodeIds: [move.nodeId],
        opType: "object.update",
        payload: { objectId: move.nodeId, [move.field]: move.targetId },
      }),
    );
    for (const unset of move.unsets) {
      envelopes.push(
        newEnvelope({
          workspaceId,
          actorId: ACTOR,
          deviceId: DEVICE,
          client: CLIENT,
          hlc: { physical, logical: envelopes.length },
          affectedNodeIds: [move.nodeId],
          opType: "property.unset",
          payload: {
            objectId: move.nodeId,
            propertySchemaId: move.schemaId,
            ...unset,
          },
        }),
      );
    }
  }
  return envelopes;
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

// --- verification -------------------------------------------------------------

function verify(
  relay: RelayStorage,
  workspaceId: string,
  moves: PlannedMove[],
  expectedCount: number,
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
    for (const move of moves) {
      const row = store.database
        .prepare("SELECT cover_asset_id, banner_asset_id, aliased_node_id FROM node WHERE id = ?")
        .get(move.nodeId) as Record<string, unknown> | undefined;
      const column = {
        coverAssetId: "cover_asset_id",
        bannerAssetId: "banner_asset_id",
        aliasedNodeId: "aliased_node_id",
      }[move.field];
      if (row === undefined || row[column] !== move.targetId) {
        throw new Error(
          `verification failed: node ${move.nodeId} field ${move.field} = ${JSON.stringify(row?.[column])}, expected ${move.targetId}`,
        );
      }
      // The assertion is gone: no visible row of the retired schema remains.
      const remaining = store.database
        .prepare(
          `SELECT COUNT(*) AS n FROM property_value pv
           WHERE pv.node_id = ? AND pv.property_schema_id = ? AND ${VISIBLE_PREDICATE}`,
        )
        .get(move.nodeId, move.schemaId) as { n: number };
      if (remaining.n !== 0) {
        throw new Error(
          `verification failed: node ${move.nodeId} still carries ${remaining.n} visible row(s) of ${move.schemaId}`,
        );
      }
    }
  } finally {
    store.close();
  }

  const byOp = new Map<string, number>();
  for (const envelope of rows) {
    byOp.set(envelope.opType, (byOp.get(envelope.opType) ?? 0) + 1);
  }
  const ops = [...byOp.entries()].map(([op, n]) => `${op}×${n}`).join(", ");
  console.log(
    `verify: ${rows.length} new envelope(s) read back (${ops}); tail applied clean; ` +
      `${moves.length} node(s) carry the wire field and no retired assertion remains.`,
  );
}

// --- main ---------------------------------------------------------------------

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
    const { moves, skipped } = planMoves(store);
    store.close();

    console.log("\nplanned moves:");
    if (moves.length === 0) console.log("  (none — no live cover/banner/aliasOf assertions)");
    for (const move of moves) {
      console.log(
        `  ${move.nodeId}  ${move.field} = ${move.targetId}` +
          `  (retires ${move.rows} assertion row(s) of ${move.schemaId})`,
      );
    }
    for (const skip of skipped) {
      console.log(`  SKIPPED ${skip.nodeId} (${skip.schemaId}): ${skip.reason}`);
    }

    const envelopes = buildEnvelopes(options.workspace, moves);
    if (envelopes.length === 0) {
      console.log("\nnothing to migrate — the workspace carries no retired assertions.");
      return;
    }
    validateEnvelopes(envelopes);
    console.log(`\n${envelopes.length} envelope(s) built and protocol-validated.`);

    if (!options.apply) {
      console.log("\ndry run — re-run with --apply to append these envelopes to the relay log.");
      return;
    }

    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`\ningested ${savedIds.length} envelope(s) into the relay log.`);

    verify(relay, options.workspace, moves, envelopes.length);
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
