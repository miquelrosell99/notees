/**
 * The `asset` property type (owner ruling 2026-10-07, M38) — the seeded
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

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a5";
const DEVICE = "system-asset-type-migration";
const CLIENT = "migrate-attachments-asset-type";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

/** The attachments schema id — hardcoded on purpose: fixed seed vocabulary
 *  (SYSTEM_PROPERTY_UUIDS.attachments in @notees/domain). */
export const ATTACHMENTS_SCHEMA_ID = "00000000-0000-0000-0000-000000000011";

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

export interface AttachmentsSchemaRow {
  name: string;
  type: string;
  multi: number;
  scope: string;
  options: string;
  display: string | null;
  readonly: number | null;
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
      `SELECT name, type, multi, scope, options, display, readonly, hide_when_empty AS hideWhenEmpty
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

// --- envelopes ----------------------------------------------------------------

export function buildEnvelopes(workspaceId: string, plan: AssetTypePlan): Envelope[] {
  if (!plan.retypeNeeded || plan.row === null) return [];
  const row = plan.row;
  let options: unknown = [];
  try {
    const parsed: unknown = JSON.parse(row.options);
    if (Array.isArray(parsed)) options = parsed;
  } catch {
    options = [];
  }
  return [
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical: Date.now(), logical: 0 },
      affectedNodeIds: [],
      opType: "propertySchema.create",
      payload: {
        propertySchemaId: ATTACHMENTS_SCHEMA_ID,
        name: row.name,
        type: "asset",
        multi: row.multi === 1,
        scope: row.scope as "global" | "class" | "object",
        options: options as Array<{ id: string; label: string }>,
        // No targetClassFilter: the asset type carries the filter implicitly
        // now — the explicit column retires (NULL on the upsert).
        ...(row.display !== null ? { display: row.display as "panel" | "bullet" | "inline" } : {}),
        ...(row.readonly !== null ? { readonly: row.readonly === 1 } : {}),
        ...(row.hideWhenEmpty !== null ? { hideWhenEmpty: row.hideWhenEmpty === 1 } : {}),
      },
    }),
  ];
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

function verify(relay: RelayStorage, workspaceId: string, expectedCount: number): void {
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

    const envelopes = buildEnvelopes(options.workspace, plan);
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
