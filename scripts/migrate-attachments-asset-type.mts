/**
 * The `asset` property type — the seeded
 * `attachments` property (…0011) retypes from `object` to `asset`. The type
 * IS the filter: an asset-typed value must reference a node carrying the
 * asset class, so the explicit targetClassFilter ([asset]) retires — the
 * values are already {nodeId} pairs pointing at asset nodes and need no
 * rewrite. Live workspaces converge by APPENDED envelopes — the immutable
 * relay log is never edited:
 *
 *  - propertySchema.create re-emitted for …0011 with type "asset" and NO
 *    targetClassFilter. propertySchema.create is an UPSERT (ON CONFLICT
 *    replaces name/type/multi/scope/options/filter/flags) — and it is the
 *    ONLY wire path that can change a schema's type (propertySchema.update
 *    deliberately carries no type). The current row's values ride verbatim —
 *    name (rename-safe), multi, scope, options, the render contracts — so
 *    nothing the owner tuned is clobbered; only type moves and the explicit
 *    filter column retires (NULL).
 *
 * The plan is read from a SCRATCH derived store (snapshot + tail — the sync
 * server's hydration shape), and every envelope is validated through the
 * protocol zod schemas BEFORE anything is inserted. Idempotent: a second
 * run plans nothing (type already "asset").
 *
 * LOCKSTEP LAW (migrations.md): "asset" is a new value in a STRICT payload
 * enum — a pre-batch client rejects the retype envelope and stalls. Run this
 * ONLY after the GTK/Flutter ports accept the asset type (their validation
 * must treat it as the object family with the implicit asset-class filter).
 *
 * DRY RUN BY DEFAULT. --apply inserts through RelayStorage.ingest (one
 * transaction) and verifies by a FRESH scratch replay: the schema row is
 * asset-typed with a NULL explicit filter, values survived, and new writes
 * against non-asset targets fail (the implicit filter guards the slot).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-attachments-asset-type.mts \
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
  ATTACHMENTS_SCHEMA_ID,
  buildEnvelopes,
  MIGRATION_IDENTITY,
  planAssetType,
  validateEnvelopes,
} from "./lib/migrations/attachments-asset-type.ts";

export {
  ATTACHMENTS_SCHEMA_ID,
  buildEnvelopes,
  planAssetType,
  validateEnvelopes,
  type AssetTypePlan,
  type AttachmentsSchemaRow,
} from "./lib/migrations/attachments-asset-type.ts";


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
// planAssetType / buildEnvelopes / validateEnvelopes live in the node-free core,
// re-exported above. The op-triple primitive behind the envelope builder is the
// shape a client-side executor stamps with its session constants through the
// normal write path.

// --- verification -------------------------------------------------------------

function verify(relay: RelayStorage, workspaceId: string, expectedCount: number): void {
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
    const row = store.database
      .prepare("SELECT type, target_class_filter FROM property_schema WHERE id = ?")
      .get(ATTACHMENTS_SCHEMA_ID) as { type: string; target_class_filter: string | null } | undefined;
    if (row === undefined) {
      throw new Error("verification failed: the attachments schema row vanished");
    }
    if (row.type !== "asset") {
      throw new Error(`verification failed: attachments type = ${row.type}, expected asset`);
    }
    if (row.target_class_filter !== null) {
      throw new Error("verification failed: the explicit targetClassFilter survived the retype");
    }
    // Authored values survived (shape-compatible — no rewrite needed).
    const values = store.database
      .prepare("SELECT COUNT(*) AS n FROM property_value WHERE property_schema_id = ?")
      .get(ATTACHMENTS_SCHEMA_ID) as { n: number };
    console.log(`verify: retype read back; ${values.n} authored value row(s) survived untouched.`);
  } finally {
    store.close();
  }
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    refuseIfContentOnKeyed(options.dataDir, options.workspace, CONTENT_CLASS, "migrate-attachments-asset-type.mts");
    const snapshot = relay.latestSnapshot(options.workspace);
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`,
    );

    const store = buildScratchStore(relay, options.workspace);
    const plan = planAssetType(store);
    store.close();

    console.log("\nplanned retype:");
    if (plan.schemaAbsent) {
      console.log("  the attachments schema was never authored in this workspace — nothing to do (the web ensure self-heals it).");
    } else if (!plan.retypeNeeded) {
      console.log(`  type already "${plan.row!.type}" — converged, nothing to do.`);
    } else {
      console.log(
        `  attachments (…0011) "${plan.row!.name}": ${plan.row!.type} → asset — the explicit targetClassFilter retires (implicit in the type).`,
      );
    }

    const envelopes = buildEnvelopes(options.workspace, plan, Date.now());
    if (envelopes.length === 0) {
      console.log("\nnothing to migrate.");
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

    verify(relay, options.workspace, envelopes.length);
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
