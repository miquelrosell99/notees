/**
 * Repeat-property migration (scripts/migrate-repeat-property.mts).
 *
 * End-to-end harness in the migrate-meeting-date-retirement shape: the test
 * builds a scratch relay whose workspace predates the recurrence redesign —
 * date values carry the retired recurrence metadata (`metadata.repeat` in the
 * legacy `<freq>[/<n>]` grammar, plus `exdates`/`until`/
 * `completedOccurrences`), the withdrawn taskRecurrence select schema (…006)
 * is still seeded with its (task, …006) binding row, and the dedicated Repeat
 * text schema (…0013, scope [event, task]) does not exist yet. Four seeded
 * arms:
 *
 *  (a) an EVENT whose eventDate value carries `repeat: "weekly"` + `exdates`
 *      + `until` — eligible: the grammar converts to the canonical RRULE
 *      anchored at the value's own day (2026-07-06 is a Monday →
 *      `RRULE:FREQ=WEEKLY;BYDAY=MO`), the exceptions move onto the Repeat
 *      value's metadata, the date value's metadata strips the four keys;
 *  (b) a TASK whose taskScheduled value carries `repeat: "weekdays"` +
 *      `completedOccurrences` + an unrelated authored key (`note`) — the
 *      RRULE is the fixed weekday list, `completedOccurrences` moves, the
 *      `note` key rides through the strip untouched;
 *  (c) a SOURCE whose own date value carries `repeat: "monthly"` — the
 *      out-of-scope arm: the class closure reaches neither event nor task, so
 *      NO `property.set` of the Repeat property is emitted (the applier's R3
 *      check would refuse it); the node gets only the metadata-strip envelope
 *      and is NAMED in the plan's report output;
 *  (d) the legacy taskRecurrence schema (…006) present — soft-deleted — while
 *      the Repeat schema (…0013, text, scope [event, task]) is created with
 *      both binding rows.
 *
 * The four phases (the meeting-date rehearsal's shape):
 *
 *  1. exercises the exported plan/envelope functions in-process: exactly the
 *     schema delete + schema create + two binding rows + the per-node value
 *     moves/strips are planned (the source arm reported, not written), the
 *     envelopes are protocol-valid and ride ONE shared HLC clock, and
 *     applying them makes the plan empty (idempotency at the store level);
 *  2. spawns the script WITHOUT --apply — the dry run prints the plan
 *     (including the ineligible report line) and writes nothing;
 *  3. spawns the script WITH --apply — the appended envelopes replay clean
 *     through a fresh hydration into the converged end state (canonical
 *     RRULEs, exceptions moved, the four keys stripped, the schema swap, both
 *     binding rows);
 *  4. re-runs --apply — idempotent: the second run plans nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, payloadSchemaFor, envelopeSchema, type Envelope } from "@notees/protocol";
import { chainNodeIds, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../src/relay-storage.js";

import {
  buildRepeatPropertyEnvelopes,
  makeEnvelopeStamp,
  planIsEmpty,
  planRepeatPropertyMigration,
} from "../../../scripts/migrate-repeat-property.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-repeat-property.mts";

const WORKSPACE = "4b7d1a00-3333-4000-8000-000000000002";
const ACTOR = "51000000-0000-4000-8000-000000000099";
const DEVICE = "repeat-property-test-device";

const EVENT_ID = SYSTEM_CLASS_UUIDS.event;
const TASK_ID = SYSTEM_CLASS_UUIDS.task;
const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const EVENT_DATE_ID = SYSTEM_PROPERTY_UUIDS.eventDate;
const TASK_SCHEDULED_ID = SYSTEM_PROPERTY_UUIDS.taskScheduled;
const TASK_RECURRENCE_ID = SYSTEM_PROPERTY_UUIDS.taskRecurrence;
const REPEAT_ID = SYSTEM_PROPERTY_UUIDS.repeat;

/** The fixture's own datetime schema for the source arm (scoped to source). */
const SOURCE_DATE_ID = "0192a000-0000-7000-8000-00000000d0f0";

/** The node ids of the fixture workspace. */
const NODE_EVENT = "0192a000-0000-7000-8000-00000000d101";
const NODE_TASK = "0192a000-0000-7000-8000-00000000d102";
const NODE_SOURCE = "0192a000-0000-7000-8000-00000000d103";

const CHAINS = [
  chainNodeIds("2026-07-06"), // a Monday — the weekly anchor's weekday
  chainNodeIds("2026-08-07"),
  chainNodeIds("2026-09-05"),
];
const DAY_EVENT = CHAINS[0]!.day;
const DAY_TASK = CHAINS[1]!.day;
const DAY_SOURCE = CHAINS[2]!.day;

/**
 * The pre-redesign fixture: the event/task/source class roots, the three
 * datetime schemas (eventDate scoped [event], taskScheduled global per the
 * 2026-10-20 seed-scope audit, a source-local one), the withdrawn
 * taskRecurrence select schema + its task binding row, and the three nodes
 * covering the eligible-event, eligible-task, and ineligible-source arms.
 */
function fixtureEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
  const step = () => (t += 1000);
  const text = (s: string) => [{ type: "text", text: s }];
  const push = (opType: string, payload: Record<string, unknown>, affected: string[] = []) =>
    envelopes.push(
      newEnvelope({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        deviceId: DEVICE,
        hlc: { physical: step(), logical: 0 },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );

  push("class.create", { classId: EVENT_ID, contentAst: text("Event") }, [EVENT_ID]);
  push("class.create", { classId: TASK_ID, contentAst: text("Task") }, [TASK_ID]);
  push("class.create", { classId: SOURCE_ID, contentAst: text("Source") }, [SOURCE_ID]);

  push(
    "propertySchema.create",
    {
      propertySchemaId: EVENT_DATE_ID,
      name: "Event date",
      type: "datetime",
      scopeClassIds: [EVENT_ID],
    },
    [],
  );
  push("class.property.set", { classId: EVENT_ID, propertySchemaId: EVENT_DATE_ID }, [EVENT_ID]);
  // The task family's real legacy seed shape: global scope (the 2026-10-20
  // seed-scope audit), no scopeClassIds.
  push(
    "propertySchema.create",
    { propertySchemaId: TASK_SCHEDULED_ID, name: "Scheduled", type: "datetime" },
    [],
  );
  push("class.property.set", { classId: TASK_ID, propertySchemaId: TASK_SCHEDULED_ID }, [TASK_ID]);
  push(
    "propertySchema.create",
    {
      propertySchemaId: SOURCE_DATE_ID,
      name: "Source date",
      type: "datetime",
      scopeClassIds: [SOURCE_ID],
    },
    [],
  );
  push("class.property.set", { classId: SOURCE_ID, propertySchemaId: SOURCE_DATE_ID }, [SOURCE_ID]);

  // The withdrawn placeholder, still seeded on a pre-redesign workspace.
  push(
    "propertySchema.create",
    {
      propertySchemaId: TASK_RECURRENCE_ID,
      name: "Recurrence",
      type: "select",
      options: [],
    },
    [],
  );
  push("class.property.set", { classId: TASK_ID, propertySchemaId: TASK_RECURRENCE_ID }, [TASK_ID]);

  // Date refs must resolve (PG6 target-existence): materialize the chains the
  // values link to (the ensureDateChain shape: year root, month under it,
  // day under that).
  for (const chain of CHAINS) {
    push("object.create", { objectId: chain.year }, [chain.year]);
    push("object.create", { objectId: chain.month, parentId: chain.year }, [chain.month]);
    push("object.create", { objectId: chain.day, parentId: chain.month }, [chain.day]);
  }

  push(
    "object.create",
    { objectId: NODE_EVENT, isEmbedded: false, classIds: [EVENT_ID], contentAst: text("E") },
    [NODE_EVENT],
  );
  push(
    "property.set",
    {
      objectId: NODE_EVENT,
      propertySchemaId: EVENT_DATE_ID,
      value: { nodeId: DAY_EVENT },
      idx: 0,
      metadata: { repeat: "weekly", exdates: ["2026-07-13"], until: "2026-12-31" },
    },
    [NODE_EVENT],
  );

  push(
    "object.create",
    { objectId: NODE_TASK, isEmbedded: false, classIds: [TASK_ID], contentAst: text("T") },
    [NODE_TASK],
  );
  push(
    "property.set",
    {
      objectId: NODE_TASK,
      propertySchemaId: TASK_SCHEDULED_ID,
      value: { nodeId: DAY_TASK },
      idx: 0,
      metadata: {
        repeat: "weekdays",
        completedOccurrences: ["2026-08-10"],
        note: "keep me",
      },
    },
    [NODE_TASK],
  );

  push(
    "object.create",
    { objectId: NODE_SOURCE, isEmbedded: false, classIds: [SOURCE_ID], contentAst: text("S") },
    [NODE_SOURCE],
  );
  push(
    "property.set",
    {
      objectId: NODE_SOURCE,
      propertySchemaId: SOURCE_DATE_ID,
      value: { nodeId: DAY_SOURCE },
      idx: 0,
      metadata: { repeat: "monthly" },
    },
    [NODE_SOURCE],
  );

  return envelopes;
}

interface CliResult {
  stdout: string;
  status: number;
}

/** Spawn the migration script exactly as the runbook documents. */
function runScript(args: string[]): CliResult {
  try {
    const stdout = execFileSync(TSX, [MIGRATION_SCRIPT, ...args], {
      cwd: join(REPO_ROOT, "apps", "server"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
      status: failed.status ?? 1,
    };
  }
}

/** The sync server's hydration shape: snapshot (none here) + full tail. */
function hydrate(relay: RelayStorage, store: Store): void {
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(WORKSPACE, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
}

const valuesOf = (store: Store, nodeId: string, schemaId: string): unknown[] =>
  (
    store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id",
      )
      .all(nodeId, schemaId) as Array<{ value: string }>
  ).map((row) => JSON.parse(row.value));

const metadataOf = (store: Store, nodeId: string, schemaId: string): unknown =>
  (
    store.database
      .prepare(
        "SELECT metadata FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id LIMIT 1",
      )
      .get(nodeId, schemaId) as { metadata: string | null }
  ).metadata === null
    ? null
    : JSON.parse(
        (
          store.database
            .prepare(
              "SELECT metadata FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id LIMIT 1",
            )
            .get(nodeId, schemaId) as { metadata: string | null }
        ).metadata!,
      );

describe("migrate-repeat-property.mts", () => {
  let dataDir: string;
  let relay: RelayStorage;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-repeat-property-test-"));
    relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    relay.ingest(fixtureEnvelopes());
    store = Store.open(betterSqlite3Backend(":memory:"));
    hydrate(relay, store);
  });

  afterEach(() => {
    store.close();
    relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("plans the schema swap + the two binding rows + the value moves; the source arm is reported, not written", () => {
    const plan = planRepeatPropertyMigration(store);
    expect(plan.schemaDelete).toBe(true);
    expect(plan.schemaCreate).toBe(true);
    expect(plan.eventBinding).toBe(true);
    expect(plan.taskBinding).toBe(true);
    expect(plan.attributeDrift).toEqual([]);

    // The eligible arms: (a) weekly → the anchor's weekday; (b) weekdays →
    // the fixed weekday list. Exceptions move onto the Repeat value; the
    // stripped date metadata keeps only the keys the migration didn't touch.
    expect(plan.moves).toEqual([
      {
        nodeId: NODE_EVENT,
        dateSchemaId: EVENT_DATE_ID,
        idx: 0,
        grammar: "weekly",
        anchorIso: "2026-07-06",
        rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
        repeatMetadata: { exdates: ["2026-07-13"], until: "2026-12-31" },
        dateValue: { nodeId: DAY_EVENT },
        strippedMetadata: {},
      },
      {
        nodeId: NODE_TASK,
        dateSchemaId: TASK_SCHEDULED_ID,
        idx: 0,
        grammar: "weekdays",
        anchorIso: "2026-08-07",
        rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
        repeatMetadata: { completedOccurrences: ["2026-08-10"] },
        dateValue: { nodeId: DAY_TASK },
        strippedMetadata: { note: "keep me" },
      },
    ]);

    // The out-of-scope arm: no Repeat property.set is planned for it — only
    // the metadata strip — and it is NAMED in the report output.
    expect(plan.strips).toEqual([
      {
        nodeId: NODE_SOURCE,
        dateSchemaId: SOURCE_DATE_ID,
        idx: 0,
        dateValue: { nodeId: DAY_SOURCE },
        strippedMetadata: {},
      },
    ]);
    expect(plan.ineligible).toHaveLength(1);
    expect(plan.ineligible[0]!.nodeId).toBe(NODE_SOURCE);
    expect(plan.ineligible[0]!.reason).toContain("neither event nor task");
    expect(plan.conflicts).toEqual([]);

    // The built envelopes: schema delete → schema create → the two binding
    // rows → per eligible node the Repeat set + the date strip → the source
    // strip. All protocol-valid, one shared HLC clock, fresh ids.
    const envelopes = buildRepeatPropertyEnvelopes(plan, makeEnvelopeStamp(WORKSPACE));
    expect(envelopes.map((envelope) => envelope.opType)).toEqual([
      "propertySchema.delete",
      "propertySchema.create",
      "class.property.set",
      "class.property.set",
      "property.set",
      "property.set",
      "property.set",
      "property.set",
      "property.set",
    ]);
    expect(envelopes[0]!.payload).toEqual({ propertySchemaId: TASK_RECURRENCE_ID });
    expect(envelopes[1]!.payload).toEqual({
      propertySchemaId: REPEAT_ID,
      name: "Repeat",
      type: "text",
      scopeClassIds: [EVENT_ID, TASK_ID],
    });
    expect(envelopes[2]!.payload).toEqual({
      classId: EVENT_ID,
      propertySchemaId: REPEAT_ID,
    });
    expect(envelopes[3]!.payload).toEqual({
      classId: TASK_ID,
      propertySchemaId: REPEAT_ID,
    });
    expect(envelopes[4]!.payload).toEqual({
      objectId: NODE_EVENT,
      propertySchemaId: REPEAT_ID,
      value: "RRULE:FREQ=WEEKLY;BYDAY=MO",
      idx: 0,
      metadata: { exdates: ["2026-07-13"], until: "2026-12-31" },
    });
    expect(envelopes[5]!.payload).toEqual({
      objectId: NODE_EVENT,
      propertySchemaId: EVENT_DATE_ID,
      value: { nodeId: DAY_EVENT },
      idx: 0,
    });
    expect(envelopes[6]!.payload).toEqual({
      objectId: NODE_TASK,
      propertySchemaId: REPEAT_ID,
      value: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      idx: 0,
      metadata: { completedOccurrences: ["2026-08-10"] },
    });
    expect(envelopes[7]!.payload).toEqual({
      objectId: NODE_TASK,
      propertySchemaId: TASK_SCHEDULED_ID,
      value: { nodeId: DAY_TASK },
      idx: 0,
      metadata: { note: "keep me" },
    });
    expect(envelopes[8]!.payload).toEqual({
      objectId: NODE_SOURCE,
      propertySchemaId: SOURCE_DATE_ID,
      value: { nodeId: DAY_SOURCE },
      idx: 0,
    });
    for (const envelope of envelopes) {
      expect(envelopeSchema.safeParse(envelope).success).toBe(true);
      expect(payloadSchemaFor(envelope.opType)!.safeParse(envelope.payload).success).toBe(true);
    }
    const physical = envelopes[0]!.hlc.physical;
    envelopes.forEach((envelope, index) => {
      expect(envelope.hlc).toEqual({ physical, logical: index });
    });
    expect(new Set(envelopes.map((envelope) => envelope.id)).size).toBe(envelopes.length);

    // …and applying them makes the plan empty (idempotency at the store level).
    for (const envelope of envelopes) store.apply(envelope);
    const after = planRepeatPropertyMigration(store);
    expect(planIsEmpty(after)).toBe(true);
  });

  it("dry run prints the plan (with the ineligible report line) and writes nothing", () => {
    const seqBefore = relay.latestSeq(WORKSPACE);
    const result = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned repeat property migration:");
    expect(result.stdout).toContain(`repeat   ${NODE_EVENT}`);
    expect(result.stdout).toContain(`repeat   ${NODE_TASK}`);
    expect(result.stdout).toContain(`strip    ${NODE_SOURCE}`);
    expect(result.stdout).toContain("ineligible");
    expect(result.stdout).toContain(NODE_SOURCE);
    expect(result.stdout).toContain("dry run");
    expect(relay.latestSeq(WORKSPACE)).toBe(seqBefore);
  });

  it("a SEALED latest snapshot is never restored — the plan reads the plaintext tail replay", () => {
    // An E2EE-keyed workspace's latest checkpoint is a sealed blob the
    // server cannot open ("file is not a database" on restore). The scratch
    // build must skip the restore and rebuild the plaintext prefix from the
    // log — planning the same moves the plaintext rehearsal plans.
    relay.saveSnapshot(
      WORKSPACE,
      "01920000-0000-7000-8000-0000000000d1",
      relay.maxHlc(WORKSPACE),
      relay.latestSeq(WORKSPACE),
      Buffer.from("sealed-garbage-not-a-database"),
      true,
    );
    const result = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("file is not a database");
    expect(result.stdout).toContain(`repeat   ${NODE_EVENT}`);
    expect(result.stdout).toContain(`repeat   ${NODE_TASK}`);
    expect(result.stdout).toContain("dry run");
  });

  it("--apply converges the workspace; a second run plans nothing", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("ingested 9 envelope(s)");

    // Fresh hydration (the shape every replica replays).
    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);

      // (a) The canonical RRULE landed on the Repeat property, exceptions
      // moved onto its value; the date value is verbatim, metadata stripped.
      expect(valuesOf(fresh, NODE_EVENT, REPEAT_ID)).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
      expect(metadataOf(fresh, NODE_EVENT, REPEAT_ID)).toEqual({
        exdates: ["2026-07-13"],
        until: "2026-12-31",
      });
      expect(valuesOf(fresh, NODE_EVENT, EVENT_DATE_ID)).toEqual([{ nodeId: DAY_EVENT }]);
      expect(metadataOf(fresh, NODE_EVENT, EVENT_DATE_ID)).toBeNull();

      // (b) weekdays → the fixed BYDAY list; completedOccurrences moved; the
      // unrelated authored metadata key rides through untouched.
      expect(valuesOf(fresh, NODE_TASK, REPEAT_ID)).toEqual([
        "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      ]);
      expect(metadataOf(fresh, NODE_TASK, REPEAT_ID)).toEqual({
        completedOccurrences: ["2026-08-10"],
      });
      expect(valuesOf(fresh, NODE_TASK, TASK_SCHEDULED_ID)).toEqual([{ nodeId: DAY_TASK }]);
      expect(metadataOf(fresh, NODE_TASK, TASK_SCHEDULED_ID)).toEqual({ note: "keep me" });

      // (c) The source arm: repeat-free, the old keys stripped, nothing on
      // the Repeat property.
      expect(valuesOf(fresh, NODE_SOURCE, REPEAT_ID)).toEqual([]);
      expect(valuesOf(fresh, NODE_SOURCE, SOURCE_DATE_ID)).toEqual([{ nodeId: DAY_SOURCE }]);
      expect(metadataOf(fresh, NODE_SOURCE, SOURCE_DATE_ID)).toBeNull();

      // (d) The schema swap: …006 soft-deleted (the row survives), …0013
      // created text at [event, task] with both binding rows.
      const legacySchema = fresh.database
        .prepare("SELECT active, type FROM property_schema WHERE id = ?")
        .get(TASK_RECURRENCE_ID) as { active: number; type: string };
      expect(legacySchema.active).toBe(0);
      expect(legacySchema.type).toBe("select");
      const repeatSchema = fresh.database
        .prepare("SELECT active, type, scope_class_ids FROM property_schema WHERE id = ?")
        .get(REPEAT_ID) as { active: number; type: string; scope_class_ids: string };
      expect(repeatSchema.active).toBe(1);
      expect(repeatSchema.type).toBe("text");
      expect(JSON.parse(repeatSchema.scope_class_ids)).toEqual([EVENT_ID, TASK_ID]);
      for (const classId of [EVENT_ID, TASK_ID]) {
        const binding = fresh.database
          .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(classId, REPEAT_ID);
        expect(binding).not.toBeUndefined();
      }
    } finally {
      fresh.close();
    }

    // Idempotent: the second run plans nothing.
    const seqAfterFirst = relay.latestSeq(WORKSPACE);
    const second = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to migrate");
    expect(relay.latestSeq(WORKSPACE)).toBe(seqAfterFirst);
  });
});
