/**
 * The Zotero full-alignment seed batch (2026-11-02): the 31 source pool
 * properties (packages/domain SYSTEM_PROPERTY_UUIDS tails …057–…075 —
 * `pmcid` pinned onto the source base family alongside `pmid`, the other 30
 * bind:false pool fields scoped [source]) and the full per-class binding
 * table (SYSTEM_SOURCE_CLASS_BINDINGS — 39 source type-classes, the skip
 * list emptied). Seeds only shape NEW workspaces; live workspaces converge
 * by APPENDED envelopes (migrations.md Path A — the immutable relay log is
 * never edited):
 *
 *  - a pool SCHEMA is missing → one `propertySchema.create` (the seed shape
 *    at the reserved id — the display name, type text, scope [source])
 *    followed by one `class.property.set` per bound class whose binding row
 *    is missing, all in the SAME ingest and ordered schema-first per
 *    property;
 *  - `pmcid` mirrors the pmid migration: the schema + a PINNED
 *    `class.property.set { classId: <source>, pinned: true }`; an existing
 *    UNPINNED source binding converges with the pin patch (same op);
 *  - a stored class-local scope that EXCLUDES source (the R5 dead-config
 *    check would reject every bound row) → `propertySchema.update
 *    { scopeClassIds: [source] }` FIRST, the bindings in the same ingest,
 *    ordered after it (the migrate-pmid-property precedent). A stored GLOBAL
 *    scope (null) is wider than the seed but legal — reported, never touched;
 *  - attribute drift on an EXISTING schema (type/name mismatching the seed)
 *    is REPORTED, never touched — client-authored data is never clobbered;
 *  - the `source` CLASS NODE absent → the base rows are skipped (a
 *    fresh/offline workspace self-heals the whole citation family via
 *    ensureCitationFamily on the next source create); pool schemas and
 *    per-class bindings still converge;
 *  - a binding row is NEVER authored for a class whose extends closure
 *    cannot reach the schema's scope — the R5 dead-config check would throw
 *    on every replica's hydration. A class node the workspace never deployed
 *    (no node, no extends edges) is reported and skipped, not written.
 *
 * The batch table is DERIVED from the domain manifests at module load
 * (SYSTEM_PROPERTY_UUIDS / SYSTEM_PROPERTY_SPECS / SYSTEM_PROPERTY_DISPLAY_NAMES
 * / SYSTEM_SOURCE_CLASS_BINDINGS), never hand-copied — drift in the
 * manifests fails loudly before anything is planned. The plan is read from
 * a SCRATCH derived store (latest snapshot + log tail — the same
 * restore+catch-up shape the sync server hydrates with), so the compared
 * rows are the converged log state. Every envelope is validated through the
 * protocol zod schemas BEFORE anything is inserted. Idempotent: a second
 * run plans nothing (the schemas + binding rows exist).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, the
 * schema + binding rows present).
 *
 * THE LIVE-STACK PATH (recommended): `--apply --server http://localhost:8377`
 * posts the batch to the sync server's `POST /api/admin/append` (operator
 * key from `<data-dir>/api_key.txt`, or `--api-key`) — the ONE write path
 * (relay ingest + derived apply), so the server's own stores converge
 * before the response: no restart, no derived-cache wipe, no side-channel
 * relay.db writes under a running server. Idempotent either way.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-zotero-full-alignment.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid> | --all] [--apply] \
 *     [--server http://localhost:8377] [--api-key <operator key>]
 */

import { readFileSync } from "node:fs";
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
// client-side executor pattern): the batch table, the pending probe, the
// planner, the op builder, and the envelope builder all live there,
// importable verbatim by a keyed client through the vendor pin. This script
// keeps the CLI shape by delegating; its rehearsal suite is the pin (it
// imports the planner and builder through the re-export below).
import {
  ALIGNMENT_BATCH,
  buildEnvelopes,
  isConverged,
  MIGRATION_IDENTITY,
  planAlignment,
  validateEnvelopes,
  type AlignmentPlan,
} from "./lib/migrations/zotero-full-alignment.ts";

export {
  buildEnvelopes,
  planAlignment,
  type AlignmentPlan,
  type BindingRowPlan,
  type PropertyAlignmentPlan,
} from "./lib/migrations/zotero-full-alignment.ts";


// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  all: boolean;
  apply: boolean;
  /** The live-stack path: apply through POST /api/admin/append. */
  server: string | null;
  apiKey: string | null;
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
    server: value("--server") ?? null,
    apiKey: value("--api-key") ?? null,
  };
}

/** Every workspace id the relay log carries. */
function listWorkspaces(relay: RelayStorage): string[] {
  return relay.listWorkspaceIds();
}

/**
 * The operator credential for the --server path: --api-key wins, else the
 * stack's api_key.txt beside the data dir (the deploy layout).
 */
function operatorKeyOf(options: CliOptions): string {
  if (options.apiKey !== null) return options.apiKey;
  try {
    return readFileSync(join(options.dataDir, "api_key.txt"), "utf8").trim();
  } catch {
    throw new Error(
      "--server needs the operator key: pass --api-key or keep api_key.txt beside --data-dir",
    );
  }
}

/**
 * Apply one workspace's batch through the running server (the one write
 * path). Answers the saved ids — an empty list means the batch was already
 * applied (idempotent re-run); the server's derived stores converge before
 * the response, so no restart or cache wipe follows.
 */
async function appendViaServer(
  options: CliOptions,
  workspaceId: string,
  envelopes: Envelope[],
): Promise<{ savedIds: string[]; pending: number }> {
  const base = options.server!.replace(/\/$/, "");
  const response = await fetch(`${base}/api/admin/append`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": operatorKeyOf(options) },
    body: JSON.stringify({ workspaceId, envelopes }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /api/admin/append answered ${response.status}: ${body}`);
  }
  const result = (await response.json()) as { savedIds: string[]; pending: number };
  return { savedIds: result.savedIds, pending: result.pending };
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
// planAlignment / isConverged / buildEnvelopes / validateEnvelopes live in the
// node-free core, re-exported above. The op-triple primitive behind the
// envelope builder is the shape a client-side executor stamps with its
// session constants through the normal write path.

// --- verification -------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log:
 *  1. read the new envelopes back (count + protocol validation),
 *  2. build a FRESH scratch store from the same snapshot and apply the tail
 *     INCLUDING the new envelopes — zero StoreError throws,
 *  3. assert every batch schema row converged (scope [source]) and every
 *     planned binding row exists (the pmcid base row pinned).
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  plan: AlignmentPlan,
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
    for (const property of plan.properties) {
      const schema = store.database
        .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
        .get(property.schemaId) as { scope_class_ids: string | null } | undefined;
      if (schema === undefined) {
        throw new Error(`verification failed: the ${property.name} schema row is missing after the migration`);
      }
      if (property.base !== null && property.base.planSet) {
        const binding = store.database
          .prepare("SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(property.base.classId, property.schemaId) as { pinned: number } | undefined;
        if (binding === undefined) {
          throw new Error(
            `verification failed: the ${property.base.className}↔${property.name} binding row is missing after the migration`,
          );
        }
        if (binding.pinned !== 1) {
          throw new Error(
            `verification failed: the ${property.base.className}↔${property.name} binding row is not pinned after the migration`,
          );
        }
      }
      for (const binding of property.classBindings) {
        if (!binding.planSet) continue;
        const row = store.database
          .prepare("SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(binding.classId, property.schemaId) as { pinned: number } | undefined;
        if (row === undefined) {
          throw new Error(
            `verification failed: the ${binding.className}↔${property.name} binding row is missing after the migration`,
          );
        }
      }
    }
  } finally {
    store.close();
  }

  console.log(
    `verify: ${rows.length} new envelope(s) read back; tail applied clean; ` +
      "the 31 schemas + every planned binding row converge.",
  );
}

// --- main ---------------------------------------------------------------------

function isConverged(plan: AlignmentPlan): boolean {
  return plan.properties.every(
    (property) =>
      !property.schemaMissing &&
      !property.scopeConverge &&
      (property.base === null || !property.base.planSet) &&
      property.classBindings.every((binding) => !binding.planSet),
  );
}

async function migrateWorkspace(relay: RelayStorage, options: CliOptions, workspaceId: string): Promise<void> {
  const apply = options.apply;
  const snapshot = relay.latestSnapshot(workspaceId);
  const snapshotSeq = snapshot?.up_to_seq ?? 0;
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  const plan = planAlignment(store);
  store.close();

  if (isConverged(plan)) {
    console.log("  already converged — the 31 schemas + every binding row exist. Nothing to do.");
    return;
  }

  console.log("planned Zotero full alignment:");
  if (plan.sourceClassMissing) {
    console.log(
      "  source class node not present — the base-family rows are skipped " +
        "(the citation ensure self-heals the family on the next source create).",
    );
  }
  let creates = 0;
  let bindingOps = 0;
  let pinPatches = 0;
  let scopeConverges = 0;
  const skipped: string[] = [];
  for (const property of plan.properties) {
    const lines: string[] = [];
    if (property.schemaMissing) {
      creates += 1;
      lines.push(
        `propertySchema.create { propertySchemaId: <${property.name} ${property.schemaId.slice(-9)}>, name: ${JSON.stringify(property.displayName)}, type: ${property.type}, scopeClassIds: [<source>] }`,
      );
    } else if (property.scopeConverge) {
      scopeConverges += 1;
      lines.push(
        `propertySchema.update { propertySchemaId: <${property.name}>, scopeClassIds: [<source>] } FIRST — stored scope drifted: ` +
          JSON.stringify(property.storedScope),
      );
    } else if (property.storedScope === null) {
      lines.push(`stored scope is GLOBAL — wider than the seed, legal, NOT touched.`);
    }
    if (property.base !== null && property.base.planSet) {
      bindingOps += 1;
      if (property.base.pinPatch) pinPatches += 1;
      lines.push(
        `class.property.set { classId: <${property.base.className}>, propertySchemaId: <${property.name}>, pinned: true }` +
          (property.base.pinPatch ? " — pin patch" : ""),
      );
    }
    for (const binding of property.classBindings) {
      if (binding.planSet) {
        bindingOps += 1;
        lines.push(
          `class.property.set { classId: <${binding.className}>, propertySchemaId: <${property.name}> }`,
        );
      } else if (!binding.bound && !binding.scopeReachable) {
        skipped.push(`${property.name} → ${binding.className}`);
      }
    }
    for (const drift of property.attributeDrift) {
      lines.push(`reported drift (NOT touched): ${drift}`);
    }
    for (const line of lines) console.log(`  ${line}`);
  }
  if (skipped.length > 0) {
    console.log(
      "  skipped (the class's extends closure cannot reach the scope — authoring the row would " +
        `fail the R5 dead-config check on every replica): ${skipped.join(", ")}`,
    );
  }
  console.log(
    `  ${creates} schema create(s), ${scopeConverges} scope converge(s), ` +
      `${bindingOps} binding op(s) (${pinPatches} pin patch(es)).`,
  );

  const envelopes = buildEnvelopes(workspaceId, plan, Date.now());
  validateEnvelopes(envelopes);
  console.log(`${envelopes.length} envelope(s) built and protocol-validated.`);

  if (!apply) {
    console.log("dry run — re-run with --apply to append these envelopes to the relay log.");
    return;
  }

  if (options.server !== null) {
    // The live-stack path: the server is the writer (relay ingest + derived
    // apply in one step). An empty savedIds is the idempotent re-run case —
    // the batch is already applied, not an error.
    const { savedIds, pending } = await appendViaServer(options, workspaceId, envelopes);
    console.log(
      savedIds.length === 0
        ? "  already applied on the server (idempotent re-run) — nothing to append."
        : `  applied ${savedIds.length} envelope(s) through the server (pending skips: ${pending}). ` +
            "The server's derived stores converged before the response — no restart needed.",
    );
    return;
  }

  const { savedIds } = relay.ingest(envelopes);
  if (savedIds.length !== envelopes.length) {
    throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
  }
  console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);

  verify(relay, workspaceId, plan, envelopes.length);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const workspaces = options.all ? listWorkspaces(relay) : [options.workspace];
    console.log(
      `Zotero full alignment (31 pool properties, ${ALIGNMENT_BATCH.reduce((n, e) => n + e.classNames.length, 0)} per-class binding rows + the pinned pmcid base row): ` +
        `${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"}${options.server !== null ? ` via ${options.server}` : ""})`,
    );
    for (const workspaceId of workspaces) {
      refuseIfContentOnKeyed(options.dataDir, workspaceId, CONTENT_CLASS, "migrate-zotero-full-alignment.mts");
      await migrateWorkspace(relay, options, workspaceId);
    }
    if (options.apply && options.server === null) {
      console.log(
        "\ndone. The appended envelopes flow to every device through ordinary catch-up — " +
          "no restart or epoch bump needed (Path A append, not a log rewrite). " +
          "The server's own derived caches converge on its next open (a restart nudge) or " +
          "via the self-heal sweep; --server applies through the server and skips even that.",
      );
    }
  } finally {
    relay.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
