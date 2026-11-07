/**
 * Cover/banner/alias property retirement: the three node fundamentals move OFF the retired property
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

import { envelopeSchema, payloadSchemaFor } from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

import {
  buildScratchStore as scratchStoreBuild,
  refuseIfContentOnKeyed,
  type MigrationContentClass,
} from "./lib/scratch-store.ts";

/**
 * This migration's content class (the dev-ops contract, scripts/lib/scratch-store.ts):
 * "content" plans against the object graph — refused server-side on a keyed workspace (run it through a keyed client).
 */
export const CONTENT_CLASS: MigrationContentClass = "content";


// The migration's planning core is NODE-FREE (scripts/lib/migrations/ — the
// client-side executor pattern): the pending probe, the planner, the op
// builder, and the envelope builder all live there, importable verbatim by
// a keyed client through the vendor pin. This script keeps the CLI shape by
// delegating; the web repo's vendor-pinned rehearsal suite imports the
// planner/builder through the re-export below.
import {
  buildEnvelopes,
  MIGRATION_IDENTITY,
  planMoves,
  validateEnvelopes,
  VISIBLE_PREDICATE,
  type PlannedMove,
} from "./lib/migrations/cover-banner-alias.ts";

export {
  buildEnvelopes,
  planMoves,
  validateEnvelopes,
  type PlannedMove,
  type SkippedMove,
  type VisibleRow,
} from "./lib/migrations/cover-banner-alias.ts";


// --- CLI ----------------------------------------------------------------------

const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

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
// planMoves / buildEnvelopes / validateEnvelopes live in the node-free core,
// re-exported above. The op-triple primitive behind the envelope builder is the
// shape a client-side executor stamps with its session constants through the
// normal write path.

// --- verification -------------------------------------------------------------

function verify(
  relay: RelayStorage,
  workspaceId: string,
  moves: PlannedMove[],
  expectedCount: number,
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
    refuseIfContentOnKeyed(options.dataDir, options.workspace, CONTENT_CLASS, "migrate-cover-banner-alias.mts");
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

    const envelopes = buildEnvelopes(options.workspace, moves, Date.now());
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
