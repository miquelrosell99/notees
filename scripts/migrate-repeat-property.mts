/**
 * Repeat-property migration (2026-11-06, the recurrence redesign): the
 * date-value recurrence model retires — a datetime value carries NO
 * recurrence metadata at all (SCHEMA.md "Recurrence", the legacy-convergence
 * ruling). Live workspaces written under the old model carry the recurrence
 * on their date values' metadata — `metadata.repeat` in the retired
 * `<freq>[/<n>]` grammar (`daily`/`weekly`/`weekdays`/`monthly`/`yearly`,
 * optional `/<interval>`), with the exception state beside it
 * (`exdates`/`until`, the Google-calendar semantics, and
 * `completedOccurrences`, the per-occurrence task completion) — plus the
 * withdrawn `taskRecurrence` placeholder (…0003-…0006, the optionless select
 * that never carried an executable grammar). This script converges them by
 * APPENDED envelopes (migrations.md Path A — the immutable relay log is never
 * edited):
 *
 *  1. SOFT-DELETE the taskRecurrence schema (propertySchema.delete — the
 *     …006 UUID stays burned, the row survives so history still validates);
 *  2. CREATE the dedicated Repeat schema (…0003-…0013) at the seed shape —
 *     name "Repeat", type text, scopeClassIds [event, task] (the multi-class
 *     bind; meeting inherits the eligibility through the extends chain) —
 *     when the workspace lacks it;
 *  3. BIND the repeat property on event and task (one class.property.set per
 *     missing binding row);
 *  4. MOVE each ELIGIBLE node's recurrence onto the Repeat property: one
 *     `property.set` at idx 0 whose text is the canonical RRULE
 *     (`legacyRecurrenceToRRule`, deriving what the bare freqs implied from
 *     the anchor day — the driving date value's OWN day, read off its
 *     {nodeId} day-node ref: weekly → BYDAY on the anchor's weekday,
 *     weekdays → BYDAY=MO,TU,WE,TH,FR, monthly → BYMONTHDAY on the anchor's
 *     day-of-month), carrying the validated `exdates`/`until`/
 *     `completedOccurrences` moved from the date value's metadata;
 *  5. STRIP every migrated date value: `property.set` re-committing the value
 *     VERBATIM with the four recurrence keys removed from its metadata
 *     (unrelated authored keys ride through untouched; an empty remainder
 *     stores no metadata at all).
 *
 * THE SCOPE LAW: the Repeat schema is class-local to event+task, so a
 * `property.set` of it is only ever emitted for a node whose class closure
 * (its classes + extends ancestors, the applier's R3 walk) reaches event or
 * task — the applier would refuse anything else. An ineligible node (arm:
 * any other class carrying a legacy `metadata.repeat` date value) gets ONLY
 * the metadata-strip envelope and is NAMED in the plan's report output —
 * reported, never silently dropped. Nodes whose metadata can't convert
 * (unparseable grammar, a non-day anchor, an already-valued Repeat slot,
 * several repeat-carrying values on one node) are conflicts: the node is
 * left untouched and reported for manual review.
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the hydration shape the sync server uses), so the compared rows are the
 * converged log state. Every envelope is validated through the protocol zod
 * schemas BEFORE anything is inserted, then replayed on a throwaway scratch
 * store (the applier gate — an applier-rejected envelope drops WITH its
 * node's whole arm, nothing is half-migrated). Idempotent: a second run
 * plans nothing (the schemas/bindings exist, the metadata keys are gone).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply backs up relay.db, ingests through
 * RelayStorage.ingest, then verifies from the persisted log: the new
 * envelopes read back + protocol-validate, and a FRESH scratch replay
 * (snapshot + FULL tail) asserts the Task-6 end state.
 *
 * THE LIVE-STACK PATH (recommended): `--apply --server http://localhost:8377`
 * posts the batch to the sync server's `POST /api/admin/append` (operator
 * key from `<data-dir>/api_key.txt`, or `--api-key`) — the ONE write path
 * (relay ingest + derived apply), so the server's own stores converge before
 * the response: no restart, no derived-cache wipe, no side-channel relay.db
 * writes under a running server. Idempotent either way.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-repeat-property.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid> | --all] [--apply] \
 *     [--server http://localhost:8377] [--api-key <operator key>]
 */

import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  completedOccurrencesOf,
  exdatesOf,
  legacyRecurrenceToRRule,
  parseDateNodeId,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
  untilOf,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000c1";
const DEVICE = "migrate-repeat-property";
const CLIENT = "migrate-repeat-property";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const EVENT_ID = SYSTEM_CLASS_UUIDS.event;
const TASK_ID = SYSTEM_CLASS_UUIDS.task;
const REPEAT_ID = SYSTEM_PROPERTY_UUIDS.repeat;
const TASK_RECURRENCE_ID = SYSTEM_PROPERTY_UUIDS.taskRecurrence;

/** The four legacy metadata keys a date value sheds (SCHEMA.md "Recurrence"). */
const LEGACY_METADATA_KEYS = ["repeat", "exdates", "until", "completedOccurrences"] as const;

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

export interface RepeatReport {
  nodeId: string;
  reason: string;
}

export interface RepeatMove {
  nodeId: string;
  /** The date property whose value carries the legacy metadata. */
  dateSchemaId: string;
  idx: number;
  /** The legacy `<freq>[/<n>]` grammar string. */
  grammar: string;
  /** The driving date value's own day (the series anchor). */
  anchorIso: string;
  /** The canonical RR5 RRULE (`legacyRecurrenceToRRule`). */
  rrule: string;
  /** The exception keys moved onto the Repeat value ({} = none). */
  repeatMetadata: Record<string, unknown>;
  /** The date value, re-committed verbatim. */
  dateValue: unknown;
  /** The date metadata minus the four keys ({} = nothing survives). */
  strippedMetadata: Record<string, unknown>;
}

export interface RepeatStrip {
  nodeId: string;
  dateSchemaId: string;
  idx: number;
  dateValue: unknown;
  strippedMetadata: Record<string, unknown>;
}

export interface RepeatPlan {
  /** The …006 schema row exists and is active — soft-delete it. */
  schemaDelete: boolean;
  /** The …0013 schema row is absent — create it at the seed shape. */
  schemaCreate: boolean;
  /** Attribute drift on an EXISTING repeat schema — reported, never touched. */
  attributeDrift: string[];
  /** The (event, …0013) binding row is missing. */
  eventBinding: boolean;
  /** The (task, …0013) binding row is missing. */
  taskBinding: boolean;
  /** Eligible nodes whose recurrence moves onto the Repeat property. */
  moves: RepeatMove[];
  /** Ineligible nodes getting ONLY the metadata strip. */
  strips: RepeatStrip[];
  /** The ineligible arms — named in the report output, stripped only. */
  ineligible: RepeatReport[];
  /** Nodes left untouched — reported for manual review, never dropped. */
  conflicts: RepeatReport[];
}

/** The date metadata minus the four recurrence keys (order preserved). */
function stripLegacyMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!(LEGACY_METADATA_KEYS as readonly string[]).includes(key)) stripped[key] = value;
  }
  return stripped;
}

/**
 * True when the node's class closure (its classes + extends ancestors, the
 * applier's R3 walk idiom) reaches event or task — the only nodes a Repeat
 * `property.set` may target.
 */
function closureReachesEventOrTask(db: Store["database"], classIdsJson: string | null): boolean {
  if (classIdsJson === null || classIdsJson === "[]") return false;
  const carried = JSON.parse(classIdsJson) as string[];
  const allowed = new Set<string>(carried);
  const ancestors = db
    .prepare(
      "SELECT ancestor_id FROM class_hierarchy WHERE class_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(carried)) as Array<{ ancestor_id: string }>;
  for (const row of ancestors) allowed.add(row.ancestor_id);
  return allowed.has(EVENT_ID) || allowed.has(TASK_ID);
}

/**
 * Plan from the converged scratch store. The value scan reads every
 * property_value row whose metadata JSON carries a `repeat` key (SQLite JSON
 * functions — the meeting-date script's metadata idiom); each row groups
 * under its node for the eligibility walk and the conflict arms.
 */
export function planRepeatPropertyMigration(store: Store): RepeatPlan {
  const db = store.database;
  const plan: RepeatPlan = {
    schemaDelete: false,
    schemaCreate: false,
    attributeDrift: [],
    eventBinding: false,
    taskBinding: false,
    moves: [],
    strips: [],
    ineligible: [],
    conflicts: [],
  };

  const legacySchema = db
    .prepare("SELECT active FROM property_schema WHERE id = ?")
    .get(TASK_RECURRENCE_ID) as { active: number } | undefined;
  plan.schemaDelete = legacySchema !== undefined && legacySchema.active === 1;

  const repeatSchema = db
    .prepare("SELECT name, type, scope_class_ids FROM property_schema WHERE id = ?")
    .get(REPEAT_ID) as
    | { name: string; type: string; scope_class_ids: string | null }
    | undefined;
  plan.schemaCreate = repeatSchema === undefined;
  if (repeatSchema !== undefined) {
    if (repeatSchema.type !== "text") {
      plan.attributeDrift.push(`type=${repeatSchema.type} (seed: text)`);
    }
    if (repeatSchema.name !== SYSTEM_PROPERTY_DISPLAY_NAMES.repeat) {
      plan.attributeDrift.push(
        `name=${repeatSchema.name} (seed: ${SYSTEM_PROPERTY_DISPLAY_NAMES.repeat})`,
      );
    }
    const scope =
      repeatSchema.scope_class_ids === null
        ? null
        : (JSON.parse(repeatSchema.scope_class_ids) as string[]);
    if (
      scope === null ||
      scope.length !== 2 ||
      !scope.includes(EVENT_ID) ||
      !scope.includes(TASK_ID)
    ) {
      plan.attributeDrift.push(
        `scope=${JSON.stringify(scope)} (seed: [${EVENT_ID}, ${TASK_ID}])`,
      );
    }
  }

  const bindingStmt = db.prepare(
    "SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?",
  );
  plan.eventBinding = bindingStmt.get(EVENT_ID, REPEAT_ID) === undefined;
  plan.taskBinding = bindingStmt.get(TASK_ID, REPEAT_ID) === undefined;

  const rows = db
    .prepare(
      `SELECT node_id, property_schema_id, idx, value, metadata FROM property_value
       WHERE metadata IS NOT NULL AND json_type(metadata, '$.repeat') IS NOT NULL
       ORDER BY node_id, property_schema_id, idx, id`,
    )
    .all() as Array<{
    node_id: string;
    property_schema_id: string;
    idx: number;
    value: string;
    metadata: string;
  }>;

  const byNode = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byNode.get(row.node_id) ?? [];
    list.push(row);
    byNode.set(row.node_id, list);
  }

  const nodeStmt = db.prepare("SELECT class_ids FROM node WHERE id = ?");
  const repeatValued = db.prepare(
    "SELECT 1 FROM property_value WHERE node_id = ? AND property_schema_id = ? LIMIT 1",
  );

  for (const [nodeId, nodeRows] of byNode) {
    const node = nodeStmt.get(nodeId) as { class_ids: string | null } | undefined;
    if (node === undefined) {
      plan.conflicts.push({ nodeId, reason: "the node row is missing — manual review" });
      continue;
    }
    if (nodeRows.length > 1) {
      plan.conflicts.push({
        nodeId,
        reason: `${nodeRows.length} datetime values carry repeat metadata — manual review (the Repeat slot is single-value)`,
      });
      continue;
    }
    const row = nodeRows[0]!;
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    const dateValue = JSON.parse(row.value) as unknown;
    const strippedMetadata = stripLegacyMetadata(metadata);

    if (!closureReachesEventOrTask(db, node.class_ids)) {
      // Out of scope: the Repeat property's R3 check would refuse the write,
      // so only the metadata strips — and the node is NAMED, not dropped.
      plan.strips.push({
        nodeId,
        dateSchemaId: row.property_schema_id,
        idx: row.idx,
        dateValue,
        strippedMetadata,
      });
      plan.ineligible.push({
        nodeId,
        reason:
          "class closure reaches neither event nor task — the Repeat property stays off this node (R3); only the recurrence metadata strips",
      });
      continue;
    }

    if (repeatValued.get(nodeId, REPEAT_ID) !== undefined) {
      plan.conflicts.push({
        nodeId,
        reason: "a Repeat value already exists — the authored value wins, manual review",
      });
      continue;
    }

    const dayRef =
      typeof dateValue === "object" && dateValue !== null
        ? (dateValue as { nodeId?: unknown }).nodeId
        : undefined;
    const anchor = typeof dayRef === "string" ? parseDateNodeId(dayRef) : null;
    if (anchor === null || anchor.precision !== "day") {
      plan.conflicts.push({
        nodeId,
        reason:
          "the date value is not a {nodeId} day ref — the series anchor cannot be derived, manual review",
      });
      continue;
    }
    const pad = (n: number): string => String(n).padStart(2, "0");
    const anchorIso = `${String(anchor.year).padStart(4, "0")}-${pad(anchor.month)}-${pad(anchor.day)}`;

    try {
      const rrule = legacyRecurrenceToRRule(metadata.repeat as string, anchorIso);
      // The moved keys are validated through the domain readers (fail loud —
      // corrupt exception metadata never rides onto the Repeat value).
      const repeatMetadata: Record<string, unknown> = {};
      if (metadata.exdates !== undefined) {
        repeatMetadata.exdates = exdatesOf(metadata);
      }
      if (metadata.until !== undefined) {
        const until = untilOf(metadata);
        if (until !== null) repeatMetadata.until = until;
      }
      if (metadata.completedOccurrences !== undefined) {
        repeatMetadata.completedOccurrences = completedOccurrencesOf(metadata);
      }
      plan.moves.push({
        nodeId,
        dateSchemaId: row.property_schema_id,
        idx: row.idx,
        grammar: metadata.repeat as string,
        anchorIso,
        rrule,
        repeatMetadata,
        dateValue,
        strippedMetadata,
      });
    } catch (error) {
      plan.conflicts.push({
        nodeId,
        reason: `unconvertible recurrence metadata — ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  return plan;
}

/** The reports never block emptiness — a conflicted workspace re-reports deterministically. */
export function planIsEmpty(plan: RepeatPlan): boolean {
  return (
    !plan.schemaDelete &&
    !plan.schemaCreate &&
    !plan.eventBinding &&
    !plan.taskBinding &&
    plan.moves.length === 0 &&
    plan.strips.length === 0
  );
}

// --- envelopes ----------------------------------------------------------------

/** One HLC clock shared across the whole batch (fresh ids per envelope). */
export interface EnvelopeStamp {
  (opType: string, payload: Record<string, unknown>, affected: string[]): Envelope;
}

export function makeEnvelopeStamp(workspaceId: string): EnvelopeStamp {
  const physical = Date.now();
  let logical = 0;
  return (opType, payload, affected) =>
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
}

/** The strip re-commit payload: the value verbatim, metadata minus the four keys. */
function stripPayload(strip: { nodeId: string; dateSchemaId: string; idx: number; dateValue: unknown; strippedMetadata: Record<string, unknown> }): Record<string, unknown> {
  return {
    objectId: strip.nodeId,
    propertySchemaId: strip.dateSchemaId,
    value: strip.dateValue,
    idx: strip.idx,
    ...(Object.keys(strip.strippedMetadata).length > 0
      ? { metadata: strip.strippedMetadata }
      : {}),
  };
}

/**
 * The envelope batch, ordered so every prerequisite lands first: the …006
 * delete, the …0013 create, the two binding rows, then per eligible node the
 * Repeat set followed by its date strip, then the ineligible strips. One HLC
 * clock via the stamp; the Repeat `property.set`s reach only eligible nodes,
 * so the applier's R3 check never fires.
 */
export function buildRepeatPropertyEnvelopes(plan: RepeatPlan, stamp: EnvelopeStamp): Envelope[] {
  const envelopes: Envelope[] = [];
  const push = (opType: string, payload: Record<string, unknown>, affected: string[]) =>
    envelopes.push(stamp(opType, payload, affected));

  if (plan.schemaDelete) {
    push("propertySchema.delete", { propertySchemaId: TASK_RECURRENCE_ID }, []);
  }
  if (plan.schemaCreate) {
    push(
      "propertySchema.create",
      {
        propertySchemaId: REPEAT_ID,
        name: SYSTEM_PROPERTY_DISPLAY_NAMES.repeat,
        type: "text",
        scopeClassIds: [EVENT_ID, TASK_ID],
      },
      [],
    );
  }
  if (plan.eventBinding) {
    push("class.property.set", { classId: EVENT_ID, propertySchemaId: REPEAT_ID }, [EVENT_ID]);
  }
  if (plan.taskBinding) {
    push("class.property.set", { classId: TASK_ID, propertySchemaId: REPEAT_ID }, [TASK_ID]);
  }
  for (const move of plan.moves) {
    push(
      "property.set",
      {
        objectId: move.nodeId,
        propertySchemaId: REPEAT_ID,
        value: move.rrule,
        idx: 0,
        ...(Object.keys(move.repeatMetadata).length > 0
          ? { metadata: move.repeatMetadata }
          : {}),
      },
      [move.nodeId],
    );
    push("property.set", stripPayload(move), [move.nodeId]);
  }
  for (const strip of plan.strips) {
    push("property.set", stripPayload(strip), [strip.nodeId]);
  }
  return envelopes;
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema BEFORE anything is inserted.
 */
function validateEnvelopes(envelopes: Envelope[]): void {
  const failures: string[] = [];
  for (const envelope of envelopes) {
    if (!envelopeSchema.safeParse(envelope).success) {
      failures.push(`${envelope.opType} ${envelope.id}: envelope invalid`);
      continue;
    }
    const schema = payloadSchemaFor(envelope.opType);
    if (schema === undefined || !schema.safeParse(envelope.payload).success) {
      failures.push(`${envelope.opType} ${envelope.id}: payload invalid`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`refusing to insert: ${failures.length} invalid envelope(s):\n  ${failures.join("\n  ")}`);
  }
}

/**
 * The applier gate: replay the plan's envelopes on a THROWAWAY scratch store
 * (a fresh hydration of the CURRENT log) and drop the ones the applier
 * rejects — a rejected envelope drops its node's WHOLE arm (the Repeat set
 * and the date strip migrate together or not at all — nothing is
 * half-migrated). Node-less envelopes (the schema/binding ops) must never
 * fail on a converged log — surface those loud. Returns the surviving
 * envelopes plus a report per dropped node.
 */
export function simulateRepeatPropertyEnvelopes(
  relay: RelayStorage,
  workspaceId: string,
  envelopes: Envelope[],
): { envelopes: Envelope[]; rejected: RepeatReport[] } {
  const store = buildScratchStore(relay, workspaceId);
  const rejected: RepeatReport[] = [];
  const blockedNodes = new Set<string>();
  const surviving: Envelope[] = [];
  try {
    for (const envelope of envelopes) {
      const payload = envelope.payload as { objectId?: string };
      const nodeId = payload.objectId;
      if (nodeId !== undefined && blockedNodes.has(nodeId)) continue;
      try {
        store.apply(envelope);
        surviving.push(envelope);
      } catch (error) {
        if (nodeId === undefined) throw error;
        blockedNodes.add(nodeId);
        rejected.push({
          nodeId,
          reason: `applier rejected the envelope: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } finally {
    store.close();
  }
  return { envelopes: surviving, rejected };
}

// --- verification ---------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log: the new
 * envelopes read back + protocol-validate, and a FRESH scratch store
 * (snapshot + FULL tail, the appended envelopes included) replays clean into
 * the converged end state: the Repeat value carries the canonical RRULE with
 * the moved exceptions, the date metadata has none of the four legacy keys
 * anywhere outside the reported nodes, the …006 schema is soft-deleted, the
 * …0013 schema stands at the seed shape with both binding rows.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  expectedCount: number,
  plan: RepeatPlan,
  rejected: RepeatReport[],
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

  const blocked = new Set([...plan.conflicts, ...rejected].map((report) => report.nodeId));

  const store = buildScratchStore(relay, workspaceId);
  try {
    const db = store.database;

    if (plan.schemaDelete) {
      const legacy = db
        .prepare("SELECT active FROM property_schema WHERE id = ?")
        .get(TASK_RECURRENCE_ID) as { active: number } | undefined;
      if (legacy === undefined || legacy.active !== 0) {
        throw new Error("verification failed: the taskRecurrence schema is not soft-deleted");
      }
    }
    if (plan.schemaCreate) {
      const repeat = db
        .prepare("SELECT active, type, scope_class_ids FROM property_schema WHERE id = ?")
        .get(REPEAT_ID) as
        | { active: number; type: string; scope_class_ids: string | null }
        | undefined;
      if (repeat === undefined || repeat.active !== 1 || repeat.type !== "text") {
        throw new Error("verification failed: the Repeat schema row is missing or not text/active");
      }
      if (repeat.scope_class_ids === null) {
        throw new Error("verification failed: the Repeat schema scope is not [event, task]");
      }
      const scope = JSON.parse(repeat.scope_class_ids) as string[];
      if (scope.length !== 2 || !scope.includes(EVENT_ID) || !scope.includes(TASK_ID)) {
        throw new Error("verification failed: the Repeat schema scope is not [event, task]");
      }
    }
    for (const [planned, classId] of [
      [plan.eventBinding, EVENT_ID],
      [plan.taskBinding, TASK_ID],
    ] as const) {
      if (!planned) continue;
      const binding = db
        .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(classId, REPEAT_ID);
      if (binding === undefined) {
        throw new Error(`verification failed: the (${classId}, repeat) binding row is missing`);
      }
    }

    // The moved arms: the Repeat value carries the canonical RRULE + the
    // moved exceptions; the date value is verbatim with the four keys gone.
    const repeatRow = db.prepare(
      "SELECT value, metadata FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id LIMIT 1",
    );
    const dateRow = db.prepare(
      "SELECT value, metadata FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id LIMIT 1",
    );
    const survivingMoves = plan.moves.filter((move) => !blocked.has(move.nodeId));
    for (const move of survivingMoves) {
      const repeat = repeatRow.get(move.nodeId, REPEAT_ID) as
        | { value: string; metadata: string | null }
        | undefined;
      if (repeat === undefined || JSON.parse(repeat.value) !== move.rrule) {
        throw new Error(`verification failed: the Repeat RRULE did not land on ${move.nodeId}`);
      }
      const repeatMetadata = repeat.metadata === null ? {} : (JSON.parse(repeat.metadata) as Record<string, unknown>);
      if (JSON.stringify(repeatMetadata) !== JSON.stringify(move.repeatMetadata)) {
        throw new Error(`verification failed: the moved exception metadata mismatch on ${move.nodeId}`);
      }
      const date = dateRow.get(move.nodeId, move.dateSchemaId) as
        | { value: string; metadata: string | null }
        | undefined;
      if (date === undefined || JSON.stringify(JSON.parse(date.value)) !== JSON.stringify(move.dateValue)) {
        throw new Error(`verification failed: the date value did not survive verbatim on ${move.nodeId}`);
      }
      const dateMetadata = date.metadata === null ? {} : (JSON.parse(date.metadata) as Record<string, unknown>);
      for (const key of LEGACY_METADATA_KEYS) {
        if (key in dateMetadata) {
          throw new Error(`verification failed: the date metadata still carries ${key} on ${move.nodeId}`);
        }
      }
    }

    // The stripped arms (moves ride their strip inside the loop above): the
    // four keys are gone from every strip envelope's target.
    const survivingStrips = [
      ...plan.strips.filter((strip) => !blocked.has(strip.nodeId)),
      ...survivingMoves,
    ];
    for (const strip of survivingStrips) {
      const date = dateRow.get(strip.nodeId, strip.dateSchemaId) as
        | { metadata: string | null }
        | undefined;
      if (date === undefined) continue;
      const metadata = date.metadata === null ? {} : (JSON.parse(date.metadata) as Record<string, unknown>);
      for (const key of LEGACY_METADATA_KEYS) {
        if (key in metadata) {
          throw new Error(`verification failed: the date metadata still carries ${key} on ${strip.nodeId}`);
        }
      }
    }

    // No legacy `repeat` key survives anywhere outside the reported nodes.
    const stragglers = db
      .prepare(
        `SELECT node_id FROM property_value
         WHERE metadata IS NOT NULL AND json_type(metadata, '$.repeat') IS NOT NULL`,
      )
      .all() as Array<{ node_id: string }>;
    for (const row of stragglers) {
      if (!blocked.has(row.node_id)) {
        throw new Error(`verification failed: a legacy repeat key survives on ${row.node_id}`);
      }
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: ${rows.length} new envelope(s) read back and protocol-valid; fresh scratch replay clean — ` +
      "the RRULEs landed on Repeat with the moved exceptions, the four legacy keys are stripped, the schema swap converges.",
  );
}

// --- main -------------------------------------------------------------------------

async function migrateWorkspace(
  relay: RelayStorage,
  options: CliOptions,
  workspaceId: string,
): Promise<void> {
  const apply = options.apply;
  const snapshot = relay.latestSnapshot(workspaceId);
  const snapshotSeq = snapshot?.up_to_seq ?? 0;
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  const plan = planRepeatPropertyMigration(store);
  store.close();

  console.log("planned repeat property migration:");
  if (plan.schemaDelete) {
    console.log("  delete the taskRecurrence schema (…0006 — soft, active = 0)");
  }
  if (plan.schemaCreate) {
    console.log(
      '  create the Repeat schema (…0013 — name "Repeat", type text, scopeClassIds [event, task])',
    );
  }
  if (plan.eventBinding) console.log("  bind   repeat on event");
  if (plan.taskBinding) console.log("  bind   repeat on task");
  for (const move of plan.moves) {
    console.log(
      `  repeat   ${move.nodeId}  ${move.grammar} @ ${move.anchorIso} → ${move.rrule} ` +
        `(${Object.keys(move.repeatMetadata).join(", ") || "no exceptions"})`,
    );
    console.log(`  strip    ${move.nodeId}  ${move.dateSchemaId} [${move.idx}]`);
  }
  for (const strip of plan.strips) {
    console.log(`  strip    ${strip.nodeId}  ${strip.dateSchemaId} [${strip.idx}]`);
  }
  for (const report of plan.ineligible) {
    console.log(`  KEEP   ${report.nodeId}  (ineligible — ${report.reason})`);
  }
  for (const conflict of plan.conflicts) {
    console.log(`  KEEP   ${conflict.nodeId}  (${conflict.reason})`);
  }
  for (const drift of plan.attributeDrift) {
    console.log(`  reported drift (NOT touched): ${drift}`);
  }
  if (planIsEmpty(plan)) {
    console.log("\nnothing to migrate — the workspace already converged.");
    return;
  }

  const envelopes = buildRepeatPropertyEnvelopes(plan, makeEnvelopeStamp(workspaceId));
  validateEnvelopes(envelopes);
  const simulation = simulateRepeatPropertyEnvelopes(relay, workspaceId, envelopes);
  for (const rejection of simulation.rejected) {
    console.log(`  KEEP   ${rejection.nodeId}  (${rejection.reason})`);
  }
  console.log(
    `\n${simulation.envelopes.length} envelope(s) built, protocol-validated, and applier-simulated clean (${envelopes.length - simulation.envelopes.length} dropped by simulation).`,
  );

  if (simulation.envelopes.length === 0) {
    console.log("\nnothing safe to append — every candidate was dropped (see KEEP lines above).");
    return;
  }

  if (!apply) {
    console.log("\ndry run — re-run with --apply to append these envelopes to the relay log.");
    return;
  }

  if (options.server !== null) {
    // The live-stack path: the server is the writer (relay ingest + derived
    // apply in one step). An empty savedIds is the idempotent re-run case —
    // the batch is already applied, not an error.
    const { savedIds, pending } = await appendViaServer(options, workspaceId, simulation.envelopes);
    console.log(
      savedIds.length === 0
        ? "  already applied on the server (idempotent re-run) — nothing to append."
        : `  applied ${savedIds.length} envelope(s) through the server (pending skips: ${pending}). ` +
            "The server's derived stores converged before the response — no restart needed.",
    );
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-repeat-property-${stamp}`);
  console.log(`\nbackup: /tmp/relay.db.bak-repeat-property-${stamp}`);

  const { savedIds } = relay.ingest(simulation.envelopes);
  if (savedIds.length !== simulation.envelopes.length) {
    throw new Error(`ingest saved ${savedIds.length}/${simulation.envelopes.length} envelopes (duplicate ids?)`);
  }
  console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);

  verify(relay, workspaceId, simulation.envelopes.length, plan, simulation.rejected);
  console.log("done.");
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
      `repeat property migration: ${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"}${options.server !== null ? ` via ${options.server}` : ""})`,
    );
    for (const workspaceId of workspaces) {
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
