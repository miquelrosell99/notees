/**
 * Authors object→text (source-library slice 1 task 8):
 * live workspaces converge to the task-8 seed change — the `authors`
 * property (…0000-000000000012) retyped in the SPEC from object-multi to
 * text-multi, its object {nodeId} values rewritten to "Family, Given"
 * strings, and the SAME {nodeId} refs copied to `linkedAuthors`
 * (…0006-000000000001, seeded object-multi→agent) so the people-graph
 * backlinks survive. Migrations.md Path A — the immutable relay log is never
 * edited; one ordered ingest of appended envelopes per workspace.
 *
 * THE ORDERING CONSTRAINT (review focus #1): a replica converging from a
 * pre-migration snapshot + migrated tail must NEVER validate an object
 * {nodeId} value against a text schema. The plan therefore CANNOT rewrite
 * values before the flip — `assertValueShapeForType` (packages/store
 * property-values.ts) rejects a plain string under an object schema, so a
 * replay would throw at the first rewrite. The sanctioned fallback ruling
 * applies, all inside ONE ingest whose replay order is the write order:
 *
 *  (1) `property.set` ADDS on linkedAuthors (…0006-…0001) copying every
 *      still-object {nodeId} ref whose target EXISTS (object values under
 *      the untouched object linkedAuthors schema — validated exactly like
 *      the original writes; a ref already linked is existence-skipped);
 *  (2) the `authors` schema flip — a `propertySchema.create` UPSERT, the
 *      ONLY wire path that changes a schema's type (`propertySchema.update`
 *      deliberately carries no type — op-types.ts; the
 *      migrate-attachments-asset-type.mts precedent). The stored row's
 *      name/icon/scope/options/filter/date/number/render/default columns
 *      ride VERBATIM — the retype changes type + multi only — so nothing
 *      the owner tuned is clobbered (scope included);
 *  (3) `property.set` REWRITES of every visible …0012 element to its text
 *      value, each REUSING the element's own identity: a PG5 row id IS the
 *      element id, so a rewrite with the same elementId is an in-place LWW
 *      value swap (applyElementAdd, appliers.ts — the old object value was
 *      validated when authored, under the object schema, and is never
 *      re-validated; the incoming string validates against the now-text
 *      schema). Legacy positional rows (deterministic `node:schema:idx`
 *      ids) rewrite through the positional carrier at their idx.
 *      Broken refs (target node row gone) KEEP their value — a text schema
 *      still accepts a {nodeId} shape (property-values.ts text branch), so
 *      convergence is not blocked; each is reported line by line.
 *
 * Replay safety: between (2) and (3) a replica's derived store momentarily
 * holds text-schema rows with {nodeId} values, but validation runs ONLY on
 * incoming writes (appliers.ts applyPropertySet) — no tail envelope re-touches
 * those rows with an object value, so no replay ever validates an object
 * value against the text schema. The pre-ingest testApplyEnvelopes gate
 * (task-7 pattern) proves the exact ingest applies throw-free IN ORDER, and
 * the post-ingest verification replays [latest snapshot + full tail] from a
 * FRESH store (zero StoreError) — the snapshot+tail convergence scenario.
 *
 * Value derivation per element: the target agent's familyName (…0022) +
 * givenName (…0021) property values (effective idx-0 read), formatted
 * "Family, Given" (single-part values keep the one part); when neither is
 * authored, the agent node's flattened title (fullTitleOf — title-is-
 * content); an EMPTY flatten keeps the value (reported). Metadata on the
 * old element rides verbatim.
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail
 * — the hydration shape the sync server uses), so every existence check
 * sees the converged log state and a second run plans NOTHING (values are
 * strings, refs are linked, the schema is text). Every envelope is
 * zod-validated BEFORE anything is inserted.
 *
 * DRY RUN BY DEFAULT: prints the full plan — per-element rewrites (old →
 * new), kept broken refs, linkedAuthors adds, the flip's before→after, and
 * the MEANING-FLIP REPORT: every saved view / content query token carrying
 * a property condition on …0012 keeps matching by UUID but reads
 * name-strings after the flip (listed + counted, never written). Runs the
 * same pre-ingest test-apply gate, writes nothing. --apply ingests through
 * RelayStorage.ingest (one transaction) and verifies from the persisted
 * log.
 *
 * NEVER point --data-dir at a real relay data dir during development: seed
 * a scratch dir (scripts/migrated-verify/seed-authors-scratch.mts points at
 * /tmp only) and pass it here.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-authors-to-text.mts \
 *     --data-dir /tmp/notees-authors-scratch [--workspace <uuid> | --all] [--apply]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { envelopeSchema, payloadSchemaFor } from "../packages/protocol/src/index.ts";
import { parseQueryAst } from "../packages/protocol/src/index.ts";
import { Store, nodeRefOfValue, visiblePropertyValueRows } from "../packages/store/src/index.ts";
import { runQuery } from "../packages/query/src/index.ts";

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
// delegating; its rehearsal suite stays green as the pin.
import {
  AUTHORS_ID,
  buildEnvelopes,
  LINKED_AUTHORS_ID,
  MIGRATION_IDENTITY,
  planIsEmpty,
  planWorkspace,
  testApplyEnvelopes,
  UUID_RE,
  validateEnvelopes,
  type WorkspacePlan,
} from "./lib/migrations/authors-to-text.ts";

export {
  buildEnvelopes,
  planIsEmpty,
  planWorkspace,
  testApplyEnvelopes,
  validateEnvelopes,
} from "./lib/migrations/authors-to-text.ts";

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
// planWorkspace / planIsEmpty / buildEnvelopes / validateEnvelopes /
// testApplyEnvelopes live in the node-free core, re-exported above. The op-
// triple primitive behind the envelope builder is the shape a client-side
// executor stamps with its session constants through the normal write path.

// --- verification -------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log:
 *  1. read the new envelopes back (count + protocol validation),
 *  2. build a FRESH scratch store from the latest snapshot + the full tail
 *     INCLUDING the new envelopes — the [pre-migration snapshot + migrated
 *     tail] convergence replay: zero StoreError throws (review focus #1),
 *  3. assert the converged state: …0012 is text-multi with its stored scope
 *     preserved, every planned rewrite reads back as its text value (with
 *     metadata), kept broken refs still hold their value, every copied ref
 *     is present on linkedAuthors,
 *  4. the pre-migration saved views still run (the UUID-keyed property
 *     conditions match name-strings now — the meaning flip).
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
  plan: WorkspacePlan,
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

  // Review focus #1: the fresh store replays the tail since the snapshot —
  // a replica converging from pre-migration state. Any StoreError throws.
  const store = buildScratchStore(relay, workspaceId);
  try {
    const db = store.database;

    if (plan.flip) {
      const row = db
        .prepare("SELECT type, multi, scope_class_ids FROM property_schema WHERE id = ?")
        .get(AUTHORS_ID) as { type: string; multi: number; scope_class_ids: string | null } | undefined;
      if (row === undefined) {
        throw new Error("verification failed: the authors schema (…0012) row is absent after the migration");
      }
      if (row.type !== "text" || row.multi !== 1) {
        throw new Error(
          `verification failed: authors schema converged to type=${row.type} multi=${row.multi}, expected text/1`,
        );
      }
      const beforeScope = plan.schemaRow?.scope_class_ids ?? null;
      if (row.scope_class_ids !== beforeScope) {
        throw new Error(
          `verification failed: the authors scope drifted in the flip — before ${JSON.stringify(beforeScope)}, after ${JSON.stringify(row.scope_class_ids)}`,
        );
      }
    }

    const visibleAuthors = visiblePropertyValueRows(db).filter(
      (row) => row.property_schema_id === AUTHORS_ID,
    );
    for (const rewrite of plan.rewrites) {
      const row = visibleAuthors.find(
        (candidate) =>
          candidate.node_id === rewrite.sourceId &&
          (rewrite.elementId !== undefined
            ? candidate.id === rewrite.elementId
            : candidate.idx === rewrite.idx && !UUID_RE.test(candidate.id)),
      );
      if (row === undefined) {
        throw new Error(
          `verification failed: the rewritten authors element on ${rewrite.sourceId} (idx ${rewrite.idx}) is gone`,
        );
      }
      const value: unknown = JSON.parse(row.value);
      if (value !== rewrite.newValue) {
        throw new Error(
          `verification failed: authors on ${rewrite.sourceId} converged to ${JSON.stringify(value)}, expected ${JSON.stringify(rewrite.newValue)}`,
        );
      }
      if (rewrite.metadata !== null && row.metadata !== rewrite.metadata) {
        throw new Error(
          `verification failed: the metadata on ${rewrite.sourceId} idx ${rewrite.idx} did not ride verbatim`,
        );
      }
    }
    for (const kept of plan.kept) {
      const row = visibleAuthors.find(
        (candidate) =>
          candidate.node_id === kept.sourceId &&
          (kept.elementId !== undefined
            ? candidate.id === kept.elementId
            : candidate.idx === kept.idx && !UUID_RE.test(candidate.id)),
      );
      if (row === undefined) {
        throw new Error(
          `verification failed: the kept authors element on ${kept.sourceId} (idx ${kept.idx}) is gone`,
        );
      }
      if (JSON.stringify(JSON.parse(row.value)) !== JSON.stringify(kept.oldValue)) {
        throw new Error(
          `verification failed: the kept ${kept.reason} element on ${kept.sourceId} idx ${kept.idx} changed value`,
        );
      }
    }

    const linkedRefs = new Map<string, Set<string>>();
    for (const row of visiblePropertyValueRows(db)) {
      if (row.property_schema_id !== LINKED_AUTHORS_ID) continue;
      const ref = nodeRefOfValue(JSON.parse(row.value));
      if (ref === null) continue;
      if (!linkedRefs.has(row.node_id)) linkedRefs.set(row.node_id, new Set());
      linkedRefs.get(row.node_id)!.add(ref);
    }
    for (const add of plan.adds) {
      if (!(linkedRefs.get(add.sourceId) ?? new Set()).has(add.refId)) {
        throw new Error(
          `verification failed: the linkedAuthors copy of ${add.refId} onto ${add.sourceId} is missing`,
        );
      }
    }

    // The meaning flip: the pre-migration saved views still run — the UUID
    // condition now matches name-strings.
    for (const view of plan.savedViews) {
      const host = db.prepare("SELECT content FROM node WHERE id = ?").get(view.hostId) as
        | { content: string }
        | undefined;
      if (host === undefined) continue;
      let tokens: unknown[] = [];
      try {
        tokens = JSON.parse(host.content) as unknown[];
      } catch {
        continue;
      }
      for (const token of tokens) {
        if (
          typeof token !== "object" ||
          token === null ||
          (token as { type?: unknown }).type !== "query"
        ) {
          continue;
        }
        try {
          const ast = parseQueryAst((token as { queryAst: unknown }).queryAst);
          const result = runQuery(store, ast);
          console.log(
            `  meaning-flip view ${view.hostId} (${JSON.stringify(view.hostTitle)}): ` +
              `${view.conditions.join(", ")} — still runs, ${result.ids.length} node(s) match by UUID`,
          );
        } catch {
          // A legacy pre-strict AST sharing the host — never aborts verify.
          console.log(
            `  unparseable saved view (skipped): ${view.hostId} (${JSON.stringify(view.hostTitle)})`,
          );
        }
      }
    }
    for (const skipped of plan.unparseableViews) {
      console.log(
        `  unparseable saved view (skipped): ${skipped.hostId} (${JSON.stringify(skipped.hostTitle)})`,
      );
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
    `verify: ${rows.length} new envelope(s) read back (${ops}); tail applied clean since seq ${snapshotSeq} ` +
      "from a fresh store (snapshot+tail replay — review focus #1); text-multi + scope preserved, " +
      "rewrites/metadata/linkedAuthors copies all read back clean.",
  );
}

// --- main ---------------------------------------------------------------------

export interface MigrationResult {
  plan: WorkspacePlan;
  envelopeCount: number;
  applied: boolean;
}

export function migrateWorkspace(
  relay: RelayStorage,
  workspaceId: string,
  apply: boolean,
): MigrationResult {
  const snapshot = relay.latestSnapshot(workspaceId);
  const snapshotSeq = snapshot?.up_to_seq ?? 0;
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  try {
    const plan = planWorkspace(store);

    console.log("planned authors→text convergence:");
    if (plan.schemaRow === null) {
      console.log("  authors schema (…0012): no row — the flip is task-7 materialization's job (it seeds the text spec); value rewrites below ride schema-less.");
    } else if (plan.flip) {
      console.log(
        `  (2) schema flip: propertySchema.create UPSERT …0012 ${plan.schemaRow.type}/multi=${plan.schemaRow.multi} → text/multi=true ` +
          "(every other stored column — name, icon, scope, options, filter, date/number/render flags — rides verbatim)",
      );
    } else {
      console.log(`  (2) schema flip: not needed — stored type is already "text".`);
    }
    console.log(`  (1) linkedAuthors adds: ${plan.adds.length}`);
    for (const add of plan.adds) {
      console.log(`      ${add.sourceId} += { nodeId: ${add.refId} } (idx ${add.idx})`);
    }
    if (plan.linkedSchemaMissing) {
      console.log(
        "  warning: the linkedAuthors schema (…0006-…0001) has no row here — the copy is SKIPPED " +
          "(run the task-7 roster migration first; it seeds the pool schemas). The value rewrites still land.",
      );
    }
    console.log(`  (3) value rewrites: ${plan.rewrites.length} (already-text elements: ${plan.alreadyText})`);
    for (const rewrite of plan.rewrites) {
      console.log(
        `      ${rewrite.sourceId} [${rewrite.elementId ?? `idx ${rewrite.idx}`}] ` +
          `${JSON.stringify(rewrite.oldValue)} → ${JSON.stringify(rewrite.newValue)} ` +
          `(${rewrite.derivedFrom === "names" ? "familyName/givenName" : "title fallback"}, target ${rewrite.targetId}` +
          `${rewrite.targetTitle !== "" ? ` "${rewrite.targetTitle}"` : ""})`,
      );
    }
    for (const kept of plan.kept) {
      console.log(
        `      KEPT ${kept.reason}: ${kept.sourceId} [${kept.elementId ?? `idx ${kept.idx}`}] ` +
          `${JSON.stringify(kept.oldValue)}${kept.targetId !== "" ? ` (target ${kept.targetId} gone)` : ""} — value untouched`,
      );
    }
    if (plan.savedViews.length === 0) {
      console.log("  meaning-flip report: no saved views carry a property condition on …0012.");
    } else {
      console.log(
        `  meaning-flip report: ${plan.savedViews.length} saved view(s) carry a property condition on …0012 ` +
          "— they keep matching by UUID but read NAME-STRINGS after the flip (owner decides per view; no writes):",
      );
      for (const view of plan.savedViews) {
        console.log(
          `      ${view.hostId} (${JSON.stringify(view.hostTitle)}): ${view.conditions.join(", ")}`,
        );
      }
    }
    for (const skipped of plan.unparseableViews) {
      console.log(
        `  unparseable saved view (skipped): ${skipped.hostId} (${JSON.stringify(skipped.hostTitle)})` +
          " — its stored AST predates the strict query-ast schema; left untouched",
      );
    }

    if (planIsEmpty(plan)) {
      console.log("\nnothing to migrate — this workspace already carries the authors text state.");
      return { plan, envelopeCount: 0, applied: false };
    }

    const envelopes = buildEnvelopes(workspaceId, plan, Date.now());
    validateEnvelopes(envelopes);
    console.log(`${envelopes.length} envelope(s) built and protocol-validated.`);

    // The replay gate BEFORE anything is written (dry-run included).
    testApplyEnvelopes(store, envelopes);
    console.log(
      `pre-ingest test-apply: all ${envelopes.length} envelope(s) applied clean in order against the scratch store.`,
    );

    if (!apply) {
      console.log("dry run — re-run with --apply to append these envelopes to the relay log.");
      return { plan, envelopeCount: envelopes.length, applied: false };
    }

    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);

    verify(relay, workspaceId, snapshotSeq, envelopes.length, plan);
    return { plan, envelopeCount: envelopes.length, applied: true };
  } finally {
    store.close();
  }
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
      `authors→text migration: ${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"})`,
    );
    for (const workspaceId of workspaces) {
      refuseIfContentOnKeyed(options.dataDir, workspaceId, CONTENT_CLASS, "migrate-authors-to-text.mts");
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
