/**
 * Task-status styles migration (§34.89, 2026-10-05): the designed task-status
 * options gained circle-family icons + §34.43 colors (yellow pending, blue
 * review, red cancel, green done — owner-mandated), and the task class's
 * Status binding gained the "bullet" value-display position (the status value
 * rides the block bullet as an icon button — the Logseq-DB "beginning of the
 * block" behavior, a port of v1's icon_visibility). Seeds only shape NEW
 * workspaces; live workspaces converge by APPENDED envelopes — the immutable
 * relay log is never edited:
 *
 *  - propertySchema.update { propertySchemaId, options } restyling the stored
 *    status options (@notees/domain's styleTaskStatusOptions — matched BY
 *    LABEL, stored option ids PRESERVED because authored property values
 *    reference them; user-renamed/added options pass through untouched).
 *    An optionless status schema (never authored with options) gets the
 *    designed fixed-uuid option set instead;
 *  - propertySchema.update { propertySchemaId: taskStatus, display: "bullet" }
 *    (§34.90: the position is a PROPERTY-level field — moved off the class
 *    binding in the owner review) when the schema carries no position yet
 *    (NULL/'panel'). A user-chosen position is never overwritten.
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), so the
 * compared options/display are the converged log state. Every envelope is
 * validated through the protocol zod schemas BEFORE anything is inserted.
 * Idempotent: a second run plans nothing.
 *
 * LOCKSTEP NOTE: both envelopes are propertySchema.update — accepted by
 * any client whose propertySchema.update validator allows additive display
 * keys (§34.90 TS reference first; GTK/Flutter v3.1.1+). Older strict
 * validators reject them — update clients before running --apply.
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, the
 * styles + the display position converge).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-task-status-styles.mts \
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
import {
  styleTaskStatusOptions,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_STATUS_OPTION_UUIDS,
  TASK_STATUS_OPTIONS,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a1";
const DEVICE = "migrate-task-status-styles";
const CLIENT = "migrate-task-status-styles";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const TASK_CLASS_ID = SYSTEM_CLASS_UUIDS.task;
const STATUS_SCHEMA_ID = SYSTEM_PROPERTY_UUIDS.taskStatus;

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

// --- planning -----------------------------------------------------------------

interface OptionRow {
  id: string;
  label: string;
  icon?: string | null;
  color?: string | null;
}

interface Plan {
  /** The full replacement options array (settings-freeze contract). */
  styledOptions: OptionRow[] | null;
  /** True when the status schema exists but carries no options at all. */
  optionless: boolean;
  /** The SCHEMA row's current display (NULL/'panel'/'bullet'/'inline'). */
  schemaDisplay: string | null;
  /** True when no stored option matched a designed label (left alone). */
  unmatchedLabels: boolean;
  /** True when the status schema row is missing entirely. */
  schemaMissing: boolean;
  /** The option ids found in the converged store (verified preserved). */
  storedOptionIds: string[];
}

function planStyles(store: Store): Plan {
  const db = store.database;
  const schema = db
    .prepare("SELECT options FROM property_schema WHERE id = ?")
    .get(STATUS_SCHEMA_ID) as { options: string } | undefined;
  if (schema === undefined) {
    return {
      styledOptions: null,
      optionless: false,
      schemaDisplay: null,
      unmatchedLabels: false,
      schemaMissing: true,
      storedOptionIds: [],
    };
  }
  const stored = JSON.parse(schema.options) as OptionRow[];
  const styled = styleTaskStatusOptions(stored);
  const designedLabels = new Set(TASK_STATUS_OPTIONS.map((option) => option.name));
  const unmatchedLabels =
    stored.length > 0 && !stored.some((option) => designedLabels.has(option.label));
  const binding = db
    .prepare("SELECT display FROM property_schema WHERE id = ?")
    .get(STATUS_SCHEMA_ID) as { display: string | null } | undefined;
  return {
    styledOptions: styled,
    optionless: stored.length === 0,
    schemaDisplay: binding?.display ?? null,
    unmatchedLabels,
    schemaMissing: false,
    storedOptionIds: stored.map((option) => option.id),
  };
}

/** The designed fixed-uuid option set for an optionless status schema. */
function designedOptions(): OptionRow[] {
  return TASK_STATUS_OPTIONS.map((option) => ({
    id: TASK_STATUS_OPTION_UUIDS[option.name.toLowerCase() as keyof typeof TASK_STATUS_OPTION_UUIDS],
    label: option.name,
    icon: option.icon,
    color: option.color,
  }));
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, plan: Plan): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  const options =
    plan.styledOptions ?? (plan.optionless ? designedOptions() : null);
  if (options !== null) {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: envelopes.length },
        affectedNodeIds: [],
        opType: "propertySchema.update",
        payload: { propertySchemaId: STATUS_SCHEMA_ID, options },
      }),
    );
  }
  if (plan.schemaDisplay === null || plan.schemaDisplay === "panel") {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: envelopes.length },
        affectedNodeIds: [],
        opType: "propertySchema.update",
        payload: { propertySchemaId: STATUS_SCHEMA_ID, display: "bullet" },
      }),
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
 *  3. assert the converged status options carry the designed styles with the
 *     stored option ids preserved, and the binding display is "bullet".
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
  plan: Plan,
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
    const db = store.database;
    const schema = db
      .prepare("SELECT options FROM property_schema WHERE id = ?")
      .get(STATUS_SCHEMA_ID) as { options: string } | undefined;
    if (schema === undefined) {
      throw new Error("verification failed: the task status schema is missing after the migration");
    }
    const options = JSON.parse(schema.options) as OptionRow[];
    const designed = new Map(TASK_STATUS_OPTIONS.map((option) => [option.name, option]));
    const byLabel = new Map(options.map((option) => [option.label, option]));
    for (const [name, style] of designed) {
      const option = byLabel.get(name);
      if (option === undefined) continue; // user-deleted designed option
      if (option.icon !== style.icon || option.color !== style.color) {
        throw new Error(
          `verification failed: option ${JSON.stringify(name)} styles ` +
            `${JSON.stringify([option.icon, option.color])} != ${JSON.stringify([style.icon, style.color])}`,
        );
      }
    }
    // Stored option ids must have survived the wholesale replace (values
    // reference them); designed additions (an optionless schema) are extra.
    const convergedIds = new Set(options.map((option) => option.id));
    for (const id of plan.storedOptionIds) {
      if (!convergedIds.has(id)) {
        throw new Error(`verification failed: stored option id ${id} did not survive the options replace`);
      }
    }
    const binding = db
      .prepare("SELECT display FROM property_schema WHERE id = ?")
      .get(STATUS_SCHEMA_ID) as { display: string | null } | undefined;
    if (binding === undefined) {
      throw new Error("verification failed: the task Status schema row is missing");
    }
    if (binding.display !== "bullet") {
      throw new Error(`verification failed: schema display ${JSON.stringify(binding.display)} != "bullet"`);
    }
  } finally {
    store.close();
  }

  const byOp = new Map<string, number>();
  for (const envelope of rows) {
    byOp.set(envelope.opType, (byOp.get(envelope.opType) ?? 0) + 1);
  }
  const ops = [...byOp.entries()].map(([op, n]) => `${op}×${n}`).join(", ");
  console.log(`verify: ${rows.length} new envelope(s) read back (${ops}); tail applied clean since seq ${snapshotSeq}; status styles + the bullet display converge.`);
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
    const snapshotSeq = snapshot?.up_to_seq ?? 0;
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
    );

    const store = buildScratchStore(relay, options.workspace);
    const plan = planStyles(store);
    store.close();

    console.log("\nplanned task-status styles migration:");
    if (plan.schemaMissing) {
      console.log("  the task status schema was never authored in this workspace —");
      console.log("  nothing to append (the family self-heal authors it with styles).");
    } else {
      if (plan.optionless) {
        console.log("  status schema is optionless — the designed fixed-uuid option set will be authored");
      } else if (plan.styledOptions !== null) {
        console.log("  restyle the stored options (ids preserved, matched by label):");
        for (const option of plan.styledOptions) {
          console.log(
            `    ${option.id}  ${JSON.stringify(option.label)}  icon=${option.icon ?? "(none)"} color=${option.color ?? "(none)"}`,
          );
        }
      } else if (plan.unmatchedLabels) {
        console.log("  no stored option matches a designed label (all renamed) — options left untouched");
      } else {
        console.log("  status options already carry the designed styles");
      }
      console.log(
        `  Status schema display: ${plan.schemaDisplay ?? "(null)"} → ` +
          (plan.schemaDisplay === null || plan.schemaDisplay === "panel"
            ? '"bullet"'
            : "kept (user-chosen)"),
      );
    }

    const envelopes = buildEnvelopes(options.workspace, plan);
    if (envelopes.length === 0) {
      console.log("\nnothing to migrate — the workspace already carries the styles + the bullet display.");
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

    verify(relay, options.workspace, snapshotSeq, envelopes.length, plan);
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
