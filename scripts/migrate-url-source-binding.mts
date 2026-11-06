/**
 * url→source binding: the `url`
 * property's binding row moves from web_page-only (the class then keyed
 * `weblink`, renamed to `web_page`) to the `source` family base
 * (the SCHEMA stays global per the 2026-10-20 seed-scope audit; only the
 * binding row's class changes — SYSTEM_PROPERTY_SPECS.url bindTo "source" +
 * the url→web_page row in SYSTEM_EXTRA_CLASS_BINDINGS, packages/domain).
 *
 * Seeds only shape NEW workspaces; live workspaces converge by APPENDED
 * envelopes (migrations.md Path A — the immutable relay log is never
 * edited): one `class.property.set { classId: <source>, propertySchemaId: <url> }`
 * per workspace whose converged rows carry the url schema WITHOUT a source
 * binding row (the web_page row may exist — own-first resolution is
 * unaffected). When the stored schema's scope still drifts from the seed
 * (a pre-scope-flips [web_page]-local row — migrate-seed-scope-flips.mts
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

import { envelopeSchema, payloadSchemaFor } from "../packages/protocol/src/index.ts";
import { SYSTEM_PROPERTY_UUIDS } from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";

const URL_ID = SYSTEM_PROPERTY_UUIDS.url;

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
// delegating.
import {
  buildEnvelopes,
  MIGRATION_IDENTITY,
  planBinding,
  validateEnvelopes,
  type BindingPlan,
} from "./lib/migrations/url-source-binding.ts";

export {
  buildEnvelopes,
  planBinding,
  type BindingPlan,
} from "./lib/migrations/url-source-binding.ts";


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
// planBinding / buildEnvelopes / validateEnvelopes live in the node-free core,
// re-exported above. The op-triple primitive behind the envelope builder is the
// shape a client-side executor stamps with its session constants through the
// normal write path.

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
      `${plan.webPageBound ? "  (the web_page row stays — own-first resolution)" : ""}`,
  );
  if (plan.currentScope !== null) {
    console.log(
      `  propertySchema.update { propertySchemaId: <url>, scopeClassIds: null } FIRST — stored scope drifted: ` +
        JSON.stringify(plan.currentScope),
    );
  }

  const envelopes = buildEnvelopes(workspaceId, plan, Date.now());
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
      refuseIfContentOnKeyed(options.dataDir, workspaceId, CONTENT_CLASS, "migrate-url-source-binding.mts");
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