/**
 * url→source binding (owner 2026-10-22 — the url seed change): the `url`
 * property's binding row moves from weblink-only to the `source` family base
 * (the SCHEMA stays global per the 2026-10-20 seed-scope audit; only the
 * binding row's class changes — SYSTEM_PROPERTY_SPECS.url bindTo "source" +
 * the url→weblink row in SYSTEM_EXTRA_CLASS_BINDINGS, packages/domain).
 *
 * Seeds only shape NEW workspaces; live workspaces converge by APPENDED
 * envelopes (migrations.md Path A — the immutable relay log is never
 * edited): one `class.property.set { classId: <source>, propertySchemaId: <url> }`
 * per workspace whose converged rows carry the url schema WITHOUT a source
 * binding row (the weblink row may exist — own-first resolution is
 * unaffected). When the stored schema's scope still drifts from the seed
 * (a pre-scope-flips [weblink]-local row — migrate-seed-scope-flips.mts
 * territory, R5 would reject the source binding as dead config), the scope
 * clears FIRST (`propertySchema.update { scopeClassIds: null }`) and the
 * binding lands in the SAME ingest, ordered after it.
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), so the
 * compared rows are the converged log state. Every envelope is validated
 * through the protocol zod schemas BEFORE anything is inserted. Idempotent:
 * a second run plans nothing (the source binding row exists).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, the
 * source binding row present, the schema scope NULL when it drifted).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-url-source-binding.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid> | --all] [--apply]
 */

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

const ACTOR = "01920000-0000-7000-8000-0000000000a3";
const DEVICE = "migrate-url-source-binding";
const CLIENT = "migrate-url-source-binding";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const URL_ID = SYSTEM_PROPERTY_UUIDS.url;

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  all: boolean;
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
    all: argv.includes("--all"),
    apply: argv.includes("--apply"),
  };
}

/** Every workspace id the relay log carries. */
function listWorkspaces(relay: RelayStorage): string[] {
  const rows = relay.db
    .prepare("SELECT DISTINCT workspace_id FROM envelope ORDER BY workspace_id")
    .all() as Array<{ workspace_id: string }>;
  return rows.map((row) => row.workspace_id);
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

// --- planning -----------------------------------------------------------------

interface BindingPlan {
  /** The url schema row is absent from this workspace entirely. */
  schemaMissing: boolean;
  /** A source↔url binding row already exists — nothing to do. */
  sourceBound: boolean;
  /** The weblink↔url row exists (reported, never touched). */
  weblinkBound: boolean;
  /** The converged scope list (non-null = drifted from the global seed). */
  currentScope: string[] | null;
}

function planBinding(store: Store): BindingPlan {
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
    weblinkBound: binding(SYSTEM_CLASS_UUIDS.weblink),
    currentScope:
      schema === undefined || schema.scope_class_ids === null
        ? null
        : (JSON.parse(schema.scope_class_ids) as string[]),
  };
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, plan: BindingPlan): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  let logical = 0;
  if (plan.currentScope !== null) {
    // R5 dead-config guard: the source binding is only legal on a schema
    // whose scope reaches source — the drifted local scope clears FIRST,
    // same ingest, ordered before the binding.
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: logical++ },
        affectedNodeIds: [],
        opType: "propertySchema.update",
        payload: { propertySchemaId: URL_ID, scopeClassIds: null },
      }),
    );
  }
  envelopes.push(
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: logical++ },
      affectedNodeIds: [SOURCE_ID],
      opType: "class.property.set",
      payload: { classId: SOURCE_ID, propertySchemaId: URL_ID },
    }),
  );
  return envelopes;
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
function validateEnvelopes(envelopes: Envelope[]): void {
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

/**
 * Post-insert verification, straight from the persisted log:
 *  1. read the new envelopes back (count + protocol validation),
 *  2. build a FRESH scratch store from the same snapshot and apply the tail
 *     INCLUDING the new envelopes — zero StoreError throws,
 *  3. assert the source↔url binding row exists and the scope converged NULL
 *     when it drifted.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
  plan: BindingPlan,
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
    const bound =
      store.database
        .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(SOURCE_ID, URL_ID) !== undefined;
    if (!bound) {
      throw new Error("verification failed: the source↔url binding row is missing after the migration");
    }
    if (plan.currentScope !== null) {
      const row = store.database
        .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
        .get(URL_ID) as { scope_class_ids: string | null } | undefined;
      if (row === undefined || row.scope_class_ids !== null) {
        throw new Error("verification failed: the url schema scope did not converge to NULL");
      }
    }
  } finally {
    store.close();
  }

  console.log(
    `verify: ${rows.length} new envelope(s) read back; tail applied clean since seq ${snapshotSeq}; ` +
      "the source↔url binding row converges.",
  );
}

// --- main ---------------------------------------------------------------------

function migrateWorkspace(relay: RelayStorage, workspaceId: string, apply: boolean): void {
  const snapshot = relay.latestSnapshot(workspaceId);
  const snapshotSeq = snapshot?.up_to_seq ?? 0;
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  const plan = planBinding(store);
  store.close();

  if (plan.schemaMissing) {
    console.log(
      "  url schema not authored in this workspace — nothing to do (the deploy self-heal seeds the schema + binding together).",
    );
    return;
  }
  if (plan.sourceBound) {
    console.log("  already bound — the source↔url row exists. Nothing to do.");
    return;
  }

  console.log("planned url→source binding:");
  console.log(
    `  class.property.set { classId: <source>, propertySchemaId: <url> }` +
      `${plan.weblinkBound ? "  (the weblink row stays — own-first resolution)" : ""}`,
  );
  if (plan.currentScope !== null) {
    console.log(
      `  propertySchema.update { propertySchemaId: <url>, scopeClassIds: null } FIRST — stored scope drifted: ` +
        JSON.stringify(plan.currentScope),
    );
  }

  const envelopes = buildEnvelopes(workspaceId, plan);
  validateEnvelopes(envelopes);
  console.log(`${envelopes.length} envelope(s) built and protocol-validated.`);

  if (!apply) {
    console.log("dry run — re-run with --apply to append these envelopes to the relay log.");
    return;
  }

  const { savedIds } = relay.ingest(envelopes);
  if (savedIds.length !== envelopes.length) {
    throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
  }
  console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);

  verify(relay, workspaceId, snapshotSeq, envelopes.length, plan);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const workspaces = options.all ? listWorkspaces(relay) : [options.workspace];
    console.log(
      `url→source binding: ${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"})`,
    );
    for (const workspaceId of workspaces) {
      migrateWorkspace(relay, workspaceId, options.apply);
    }
    if (options.apply) {
      console.log(
        "\ndone. The appended envelopes flow to every device through ordinary catch-up — " +
          "no restart or epoch bump needed (Path A append, not a log rewrite).",
      );
    }
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
