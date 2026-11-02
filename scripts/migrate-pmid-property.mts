/**
 * The `pmid` property seed (the resolver's PMID support, 2026-11-02): the
 * PubMed identifier joins the source base family (packages/domain
 * SYSTEM_PROPERTY_SPECS — `pmid: { type: "text", bindTo: "source",
 * pinned: true }`, pool slot …0006-…056, display name "PMID"; the
 * 2026-10-27 pinned roster amendment). A base-family identifier like doi —
 * the schema seeds scoped to [source] with a real, PINNED binding row on the
 * family base.
 *
 * Seeds only shape NEW workspaces (the server seed authors both rows); live
 * workspaces converge by APPENDED envelopes (migrations.md Path A — the
 * immutable relay log is never edited):
 *
 *  - the pmid SCHEMA is missing → one `propertySchema.create` (the seed
 *    shape at the reserved id — name "PMID", type text, scope [source])
 *    followed by one `class.property.set { classId: <source>,
 *    propertySchemaId: <pmid>, pinned: true }`, both in the SAME ingest;
 *  - the schema exists but the source BINDING ROW is missing → the
 *    `class.property.set` alone;
 *  - the binding row EXISTS but is unpinned → `class.property.set
 *    { pinned: true }` (patch semantics — the pin amendment converges);
 *  - the stored scope excludes source (a class-local list that would make
 *    the R5 dead-config check reject the source binding) →
 *    `propertySchema.update { scopeClassIds: [source] }` FIRST, the binding
 *    in the same ingest, ordered after it (the migrate-url-source-binding
 *    precedent). A stored GLOBAL scope (null) is wider than the seed but
 *    legal — reported, never touched (INSERT-or-ignore: first writer wins);
 *  - attribute drift on an EXISTING schema (type/name mismatching the seed)
 *    is REPORTED, never touched — client-authored data is never clobbered;
 *  - the `source` CLASS NODE is absent → nothing to do (a fresh/offline
 *    workspace self-heals the whole citation family via ensureCitationFamily
 *    on the next source create).
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), so the
 * compared rows are the converged log state. Every envelope is validated
 * through the protocol zod schemas BEFORE anything is inserted. Idempotent:
 * a second run plans nothing (the schema + pinned binding rows exist).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, the
 * schema + pinned binding rows present).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-pmid-property.mts \
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
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a7";
const DEVICE = "migrate-pmid-property";
const CLIENT = "migrate-pmid-property";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const PMID_ID = SYSTEM_PROPERTY_UUIDS.pmid;

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
  return relay.listWorkspaceIds();
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

interface PmidPlan {
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

function planPmid(store: Store): PmidPlan {
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

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, plan: PmidPlan): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  let logical = 0;
  const stamp = (opType: string, payload: Record<string, unknown>, affected: string[]): Envelope =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: logical++ },
      affectedNodeIds: affected,
      opType,
      payload,
    });

  if (plan.schemaMissing) {
    // The seed shape at the reserved id: text, scoped [source] (the spec's
    // bindTo — the schema is local to the source family like citekey).
    envelopes.push(
      stamp("propertySchema.create", {
        propertySchemaId: PMID_ID,
        name: SYSTEM_PROPERTY_DISPLAY_NAMES.pmid,
        type: "text",
        scopeClassIds: [SOURCE_ID],
      }, []),
    );
  } else if (plan.scopeBlocksBinding) {
    // R5 dead-config guard: the source binding is only legal on a schema
    // whose scope reaches source — the drifted class-local scope converges
    // to the seed's [source] FIRST, same ingest, ordered before the binding.
    envelopes.push(
      stamp("propertySchema.update", { propertySchemaId: PMID_ID, scopeClassIds: [SOURCE_ID] }, []),
    );
  }
  if (plan.schemaMissing || !plan.sourceBound || !plan.boundPinned) {
    // The binding row with the seed's PIN tier (creates or patches the pin).
    envelopes.push(
      stamp("class.property.set", { classId: SOURCE_ID, propertySchemaId: PMID_ID, pinned: true }, [SOURCE_ID]),
    );
  }
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
 *  3. assert the source↔pmid binding row exists with pinned=1 and the schema
 *     row converged (scope [source], or untouched global when that was the
 *     stored shape).
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
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
    const schema = store.database
      .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
      .get(PMID_ID) as { scope_class_ids: string | null } | undefined;
    if (schema === undefined) {
      throw new Error("verification failed: the pmid schema row is missing after the migration");
    }
    const binding = store.database
      .prepare("SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(SOURCE_ID, PMID_ID) as { pinned: number } | undefined;
    if (binding === undefined) {
      throw new Error("verification failed: the source↔pmid binding row is missing after the migration");
    }
    if (binding.pinned !== 1) {
      throw new Error("verification failed: the source↔pmid binding row is not pinned after the migration");
    }
  } finally {
    store.close();
  }

  console.log(
    `verify: ${rows.length} new envelope(s) read back; tail applied clean; ` +
      "the source↔pmid binding row converges pinned.",
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
  const plan = planPmid(store);
  store.close();

  if (plan.sourceClassMissing) {
    console.log(
      "  source class node not present — nothing to do (the citation ensure self-heals the family on the next source create).",
    );
    return;
  }
  if (!plan.schemaMissing && plan.sourceBound && plan.boundPinned && !plan.scopeBlocksBinding) {
    console.log("  already converged — the pmid schema + the pinned source binding row exist. Nothing to do.");
    return;
  }

  console.log("planned pmid property seed:");
  if (plan.schemaMissing) {
    console.log(
      '  propertySchema.create { propertySchemaId: <pmid …056>, name: "PMID", type: text, scopeClassIds: [<source>] }',
    );
  }
  if (plan.scopeBlocksBinding) {
    console.log(
      "  propertySchema.update { propertySchemaId: <pmid>, scopeClassIds: [<source>] } FIRST — stored scope drifted: " +
        JSON.stringify(plan.currentScope),
    );
  }
  if (plan.schemaMissing || !plan.sourceBound) {
    console.log(
      "  class.property.set { classId: <source>, propertySchemaId: <pmid>, pinned: true }",
    );
  } else if (!plan.boundPinned) {
    console.log("  class.property.set { classId: <source>, propertySchemaId: <pmid>, pinned: true } — pin patch");
  }
  for (const drift of plan.attributeDrift) {
    console.log(`  reported drift (NOT touched): ${drift}`);
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

  verify(relay, workspaceId, envelopes.length);
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
      `pmid property seed: ${workspaces.length} workspace(s) ` +
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

export { buildEnvelopes, planPmid, type PmidPlan };

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
