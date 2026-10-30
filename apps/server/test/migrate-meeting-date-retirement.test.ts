/**
 * Meeting-date retirement migration (scripts/migrate-meeting-date-retirement.mts).
 *
 * End-to-end harness in the migrate-seed-pins shape: the test builds a
 * scratch relay whose workspace predates the retirement — the meeting class
 * carries the meetingDate schema + binding (plus the event root with
 * eventDate and the meeting→event extends edge), one meeting node holds a
 * meetingDate value, a second holds BOTH a meetingDate and an eventDate
 * value (the conflict arm), a meeting node holds a bare declaration (no
 * value) — then:
 *
 *  1. spawns the script WITHOUT --apply — the dry run must print the plan
 *     (including the KEEP line for the conflicted node) and write nothing;
 *  2. exercises the exported plan/envelope functions in-process against the
 *     sync server's hydration shape: exactly the copy + removal + unassign +
 *     binding unset + schema delete are planned, the conflict is reported
 *     (not written), and applying the built envelopes makes the plan empty
 *     (idempotency at the store level);
 *  3. spawns the script WITH --apply — the appended envelopes replay clean
 *     through a fresh hydration: the value landed on eventDate, the
 *     meetingDate value/binding/declaration are gone, the schema is
 *     soft-deleted (active = 0, the row survives), and the conflicted node's
 *     state is untouched;
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
  buildRetirementEnvelopes,
  MEETING_DATE_ID,
  planMeetingDateRetirement,
} from "../../../scripts/migrate-meeting-date-retirement.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-meeting-date-retirement.mts";

const WORKSPACE = "4b7d1a00-3333-4000-8000-000000000001";
const ACTOR = "51000000-0000-4000-8000-000000000099";
const DEVICE = "meeting-date-test-device";

const EVENT_ID = SYSTEM_CLASS_UUIDS.event;
const MEETING_ID = SYSTEM_CLASS_UUIDS.meeting;
const EVENT_DATE_ID = SYSTEM_PROPERTY_UUIDS.eventDate;

/** The node ids and day anchors of the fixture workspace. */
const NODE_COPY = "0192a000-0000-7000-8000-00000000d101";
const NODE_CONFLICT = "0192a000-0000-7000-8000-00000000d102";
const NODE_DECLARED = "0192a000-0000-7000-8000-00000000d103";
const NODE_UNTOUCHED = "0192a000-0000-7000-8000-00000000d104";
const DAY_A = "00000000-0000-0000-00dd-202607010000";
const DAY_B_MEETING = "00000000-0000-0000-00dd-202608150000";
const DAY_B_EVENT = "00000000-0000-0000-00dd-202609010000";
const CHAINS = [
  chainNodeIds("2026-07-01"),
  chainNodeIds("2026-08-15"),
  chainNodeIds("2026-09-01"),
];

/**
 * The pre-retirement fixture: the event root + the meeting subclass with the
 * meetingDate schema/binding, four nodes covering the copy, conflict,
 * declaration-only, and untouched arms.
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
  push("class.create", { classId: MEETING_ID, contentAst: text("Meeting") }, [MEETING_ID]);
  push("class.setExtends", { classId: MEETING_ID, parentClassIds: [EVENT_ID] }, [MEETING_ID]);

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
  push(
    "propertySchema.create",
    {
      propertySchemaId: MEETING_DATE_ID,
      name: "Meeting date",
      type: "datetime",
      scopeClassIds: [MEETING_ID],
    },
    [],
  );
  push("class.property.set", { classId: MEETING_ID, propertySchemaId: MEETING_DATE_ID }, [MEETING_ID]);

  // Date refs must resolve (PG6 target-existence): materialize the chains the
  // values link to (the ensureDateChain shape: year root, month under it,
  // day under that).
  for (const chain of CHAINS) {
    push("object.create", { objectId: chain.year }, [chain.year]);
    push("object.create", { objectId: chain.month, parentId: chain.year }, [chain.month]);
    push("object.create", { objectId: chain.day, parentId: chain.month }, [chain.day]);
  }

  const meetingNode = (nodeId: string) =>
    push(
      "object.create",
      { objectId: nodeId, isEmbedded: false, classIds: [MEETING_ID], contentAst: text("M") },
      [nodeId],
    );
  meetingNode(NODE_COPY);
  push(
    "property.set",
    { objectId: NODE_COPY, propertySchemaId: MEETING_DATE_ID, value: { nodeId: DAY_A }, idx: 0 },
    [NODE_COPY],
  );

  meetingNode(NODE_CONFLICT);
  push(
    "property.set",
    {
      objectId: NODE_CONFLICT,
      propertySchemaId: MEETING_DATE_ID,
      value: { nodeId: DAY_B_MEETING },
      idx: 0,
    },
    [NODE_CONFLICT],
  );
  push(
    "property.set",
    {
      objectId: NODE_CONFLICT,
      propertySchemaId: EVENT_DATE_ID,
      value: { nodeId: DAY_B_EVENT },
      idx: 0,
    },
    [NODE_CONFLICT],
  );

  meetingNode(NODE_DECLARED);
  push("property.assign", { objectId: NODE_DECLARED, propertySchemaId: MEETING_DATE_ID }, [NODE_DECLARED]);

  meetingNode(NODE_UNTOUCHED);
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

describe("migrate-meeting-date-retirement.mts", () => {
  let dataDir: string;
  let relay: RelayStorage;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-meeting-date-test-"));
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

  it("plans the copy + removal + unassign + binding unset + schema delete; the conflict is reported, not written", () => {
    const plan = planMeetingDateRetirement(store);
    expect(plan.copies).toEqual([{ nodeId: NODE_COPY, value: { nodeId: DAY_A }, metadata: null }]);
    expect(plan.removals).toEqual([
      { nodeId: NODE_COPY, idx: 0, elementId: `${NODE_COPY}:${MEETING_DATE_ID}:0` },
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.nodeId).toBe(NODE_CONFLICT);
    expect(plan.conflicts[0]!.reason).toContain("eventDate");
    expect(plan.unassigns).toEqual([{ nodeId: NODE_DECLARED }]);
    expect(plan.bindingUnset).toBe(true);
    expect(plan.schemaDelete).toBe(true);

    // The built envelopes are protocol-valid…
    const envelopes = buildRetirementEnvelopes(WORKSPACE, plan);
    const opTypes = envelopes.map((envelope) => envelope.opType);
    expect(opTypes).toEqual([
      "property.set",
      "property.unset",
      "property.unassign",
      "class.property.unset",
      "propertySchema.delete",
    ]);
    for (const envelope of envelopes) {
      expect(envelopeSchema.safeParse(envelope).success).toBe(true);
      expect(payloadSchemaFor(envelope.opType)!.safeParse(envelope.payload).success).toBe(true);
    }
    // …and applying them makes the plan empty (idempotency at the store level).
    for (const envelope of envelopes) store.apply(envelope);
    const after = planMeetingDateRetirement(store);
    expect(after.copies).toHaveLength(0);
    expect(after.removals).toHaveLength(0);
    expect(after.unassigns).toHaveLength(0);
    expect(after.bindingUnset).toBe(false);
    expect(after.schemaDelete).toBe(false);
    // The conflicted node still reports (deterministically).
    expect(after.conflicts.map((conflict) => conflict.nodeId)).toEqual([NODE_CONFLICT]);
  });

  it("dry run prints the plan (with the KEEP line) and writes nothing", () => {
    const seqBefore = relay.latestSeq(WORKSPACE);
    const result = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned meetingDate retirement:");
    expect(result.stdout).toContain(`copy   ${NODE_COPY}`);
    expect(result.stdout).toContain(`KEEP   ${NODE_CONFLICT}`);
    expect(result.stdout).toContain("dry run");
    expect(relay.latestSeq(WORKSPACE)).toBe(seqBefore);
  });

  it("--apply copies to eventDate, strips the meetingDate state, soft-deletes the schema; a second run plans nothing", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("ingested 5 envelope(s)");

    // Fresh hydration (the shape every replica replays).
    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);

      // The copy landed on the inherited property; the meetingDate value is gone.
      expect(valuesOf(fresh, NODE_COPY, EVENT_DATE_ID)).toEqual([{ nodeId: DAY_A }]);
      expect(valuesOf(fresh, NODE_COPY, MEETING_DATE_ID)).toEqual([]);

      // The conflicted node is untouched — both values survive, eventDate wins.
      expect(valuesOf(fresh, NODE_CONFLICT, MEETING_DATE_ID)).toEqual([{ nodeId: DAY_B_MEETING }]);
      expect(valuesOf(fresh, NODE_CONFLICT, EVENT_DATE_ID)).toEqual([{ nodeId: DAY_B_EVENT }]);

      // The bare declaration is gone; the untouched meeting node has nothing.
      const declaration = fresh.database
        .prepare("SELECT 1 FROM node_property WHERE node_id = ? AND property_schema_id = ?")
        .get(NODE_DECLARED, MEETING_DATE_ID);
      expect(declaration).toBeUndefined();
      expect(valuesOf(fresh, NODE_UNTOUCHED, MEETING_DATE_ID)).toEqual([]);

      // The binding row is gone; the schema row survives soft-deleted.
      const binding = fresh.database
        .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(MEETING_ID, MEETING_DATE_ID);
      expect(binding).toBeUndefined();
      const schema = fresh.database
        .prepare("SELECT active FROM property_schema WHERE id = ?")
        .get(MEETING_DATE_ID) as { active: number };
      expect(schema.active).toBe(0);
    } finally {
      fresh.close();
    }

    // Idempotent: the second run plans nothing.
    const second = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to migrate");
  });
});
