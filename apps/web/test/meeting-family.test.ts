/**
 * ensureMeetingFamily tests (§34.36, owner ruling 2026-10-04: plain seeds).
 * A fresh/offline workspace authors the meeting class node + the
 * meetingDate/location/agenda schemas at their reserved ids plus the class
 * bindings on first call; the call is a complete no-op once present. The
 * server-seed shape (same ids, key names, binding sequences) is recognized
 * without re-authoring, so a server-seeded workspace and a self-healed one
 * converge. Calendar breadth: after ensure, the Calendar view's exact
 * chip-qualification call (listClasses + displayNameFromClient →
 * dateChipCandidates) yields the meeting chip with meetingDate as the
 * driving date schema — no calendar code change needed.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  deriveDisplayName,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { displayNameFromClient } from "../src/ui/dateDisplay.js";
import { dateChipCandidates } from "../src/ui/components/calendarViewUtils.js";
import {
  ensureMeetingFamily,
  MEETING_CLASS_ID,
  MEETING_FAMILY,
  meetingFamilyPresent,
} from "../src/ui/components/meetingFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000c1";
const ACTOR = "0192a000-0000-7000-8000-0000000000c2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

/** Server-style seed envelope the relay holds before the client bootstraps. */
function seedEnvelope(
  opType: string,
  payload: Record<string, unknown>,
  affected: string[],
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: DEVICE,
    client: "seed",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

/** The server-seed shape for the meeting family (apps/server/src/seed.ts). */
function serverSeededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  const envelopes: Envelope[] = [
    seedEnvelope(
      "class.create",
      {
        classId: SYSTEM_CLASS_UUIDS.meeting,
        contentAst: [{ type: "text", text: "meeting" }],
        icon: SYSTEM_CLASS_ICONS.meeting,
      },
      [SYSTEM_CLASS_UUIDS.meeting],
    ),
  ];
  MEETING_FAMILY.forEach((spec, index) => {
    envelopes.push(
      seedEnvelope(
        "propertySchema.create",
        {
          propertySchemaId: spec.id,
          name: spec.name,
          type: spec.type,
          multi: false,
          scope: "class",
        },
        [],
      ),
      seedEnvelope(
        "class.property.set",
        { classId: SYSTEM_CLASS_UUIDS.meeting, propertySchemaId: spec.id, sequence: index },
        [SYSTEM_CLASS_UUIDS.meeting],
      ),
    );
  });
  relay.ingest(envelopes);
  return relay;
}

async function seedClient(relay: MemoryRelay = new MemoryRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

describe("ensureMeetingFamily", () => {
  it("self-heals the family at the reserved ids on an unseeded (offline-first) workspace", async () => {
    const client = await seedClient();
    expect(await meetingFamilyPresent(client)).toBe(false);

    await ensureMeetingFamily(client);

    const meetingClass = client.getNodeRaw(MEETING_CLASS_ID);
    expect(meetingClass?.isClass).toBe(true);
    expect(deriveDisplayName(meetingClass!)).toBe("meeting");

    const schemas = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.meetingDate)).toMatchObject({
      name: "meetingDate",
      type: "date",
      scope: "class",
    });
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.location)).toMatchObject({
      name: "location",
      type: "text",
    });
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.agenda)).toMatchObject({
      name: "agenda",
      type: "text",
    });

    const bindings = client.getClassBindings(MEETING_CLASS_ID);
    expect(bindings.map((binding) => binding.propertySchemaId)).toEqual(
      MEETING_FAMILY.map((spec) => spec.id),
    );
    expect(bindings.map((binding) => binding.sequence)).toEqual([0, 1, 2]);
    expect(await meetingFamilyPresent(client)).toBe(true);
  });

  it("is idempotent: a second call authors nothing", async () => {
    const client = await seedClient();
    await ensureMeetingFamily(client);
    const schemasAfterFirst = client.listPropertySchemas().length;
    const bindingsAfterFirst = client.getClassBindings(MEETING_CLASS_ID).length;

    await ensureMeetingFamily(client);
    await ensureMeetingFamily(client);

    expect(client.listPropertySchemas()).toHaveLength(schemasAfterFirst);
    expect(client.getClassBindings(MEETING_CLASS_ID)).toHaveLength(bindingsAfterFirst);
  });

  it("recognizes the server-seed shape and re-authors nothing (convergence by id)", async () => {
    const client = await seedClient(serverSeededRelay());
    expect(await meetingFamilyPresent(client)).toBe(true);

    const schemas = client.listPropertySchemas().length;
    const bindings = client.getClassBindings(MEETING_CLASS_ID).length;
    await ensureMeetingFamily(client);

    expect(client.listPropertySchemas()).toHaveLength(schemas);
    expect(client.getClassBindings(MEETING_CLASS_ID)).toHaveLength(bindings);
    expect(client.getNodeRaw(MEETING_CLASS_ID)?.icon).toBe(SYSTEM_CLASS_ICONS.meeting);
  });

  it("does not overwrite pre-authored schemas (a workspace that renamed a schema keeps its name)", async () => {
    const client = await seedClient();
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.meetingDate,
      name: "When",
      type: "date",
      scope: "class",
    });
    await client.setClassProperty(MEETING_CLASS_ID, SYSTEM_PROPERTY_UUIDS.meetingDate, {});

    await ensureMeetingFamily(client);

    const schema = client
      .listPropertySchemas()
      .find((entry) => entry.id === SYSTEM_PROPERTY_UUIDS.meetingDate);
    expect(schema?.name).toBe("When");
  });

  it("makes the meeting class calendar quick-create eligible through the date binding (Calendar breadth)", async () => {
    const client = await seedClient();
    await ensureMeetingFamily(client);

    // The Calendar view's exact chip-qualification call (CalendarView.tsx).
    const classes = client
      .listClasses()
      .map((cls) => ({ id: cls.id, name: displayNameFromClient(client, cls.id) }));
    const chips = dateChipCandidates(classes, (classId) => client.getClassBindings(classId));

    const meetingChip = chips.find((chip) => chip.classId === MEETING_CLASS_ID);
    expect(meetingChip).toBeDefined();
    expect(meetingChip?.schemaId).toBe(SYSTEM_PROPERTY_UUIDS.meetingDate);
    expect(meetingChip?.label).toBe("meeting");
    // The family contributes exactly one chip (one date binding).
    expect(chips.filter((chip) => chip.classId === MEETING_CLASS_ID)).toHaveLength(1);
  });

  it("a meeting created through the calendar create flow answers the class+date query", async () => {
    const client = await seedClient();
    await ensureMeetingFamily(client);

    // CalendarView.createClassed: create classed → set the driving date.
    const id = await client.createObject({ presentAsMain: true, classIds: [MEETING_CLASS_ID] });
    await client.setDateProperty(id, SYSTEM_PROPERTY_UUIDS.meetingDate, "2026-10-06");

    const result = client.runQueryAst({
      version: 1,
      scope: { type: "entire_workspace" },
      root: {
        type: "group",
        logic: "and",
        children: [
          { type: "class", classId: MEETING_CLASS_ID },
          { type: "property", schemaId: SYSTEM_PROPERTY_UUIDS.meetingDate, op: "exists" },
        ],
      },
    });
    expect(result.ids).toContain(id);
  });
});
