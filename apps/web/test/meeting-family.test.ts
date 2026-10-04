/**
 * ensureMeetingFamily tests (§34.36 + owner reshape directive 2026-10-04:
 * plain seeds). `event` is the calendar family root (its single eventDate
 * date binding is the calendar-eligibility anchor); `meeting` extends it
 * with its own family (meetingDate/location/agenda). A fresh/offline
 * workspace authors BOTH classes + schemas + bindings + the extends edge at
 * their reserved ids on first call; the call is a complete no-op once
 * present. The server-seed shape (same ids, key names, sequences, edge) is
 * recognized without re-authoring, so a server-seeded workspace and a
 * self-healed one converge. Calendar breadth: after ensure, the Calendar
 * view's exact chip-qualification call (listClasses + displayNameFromClient
 * → dateChipCandidates) yields BOTH the event chip (driving schema
 * eventDate) and the meeting chip (driving schema meetingDate) — no calendar
 * code change needed. Extends breadth: a class: event query sees
 * meeting-classed nodes via the hierarchy.
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
  EVENT_CLASS_ID,
  EVENT_FAMILY,
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

/** One class.create + family (schemas + bindings) in the server-seed shape. */
function classSeedEnvelopes(
  className: string,
  classId: string,
  family: ReadonlyArray<{ id: string; name: string; type: string }>,
): Envelope[] {
  const envelopes: Envelope[] = [
    seedEnvelope(
      "class.create",
      { classId, contentAst: [{ type: "text", text: className }], icon: SYSTEM_CLASS_ICONS[className as keyof typeof SYSTEM_CLASS_ICONS] },
      [classId],
    ),
  ];
  family.forEach((spec, index) => {
    envelopes.push(
      seedEnvelope(
        "propertySchema.create",
        { propertySchemaId: spec.id, name: spec.name, type: spec.type, multi: false, scope: "class" },
        [],
      ),
      seedEnvelope(
        "class.property.set",
        { classId, propertySchemaId: spec.id, sequence: index },
        [classId],
      ),
    );
  });
  return envelopes;
}

/** The server-seed shape for the whole family (apps/server/src/seed.ts). */
function serverSeededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    ...classSeedEnvelopes("event", EVENT_CLASS_ID, EVENT_FAMILY),
    ...classSeedEnvelopes("meeting", MEETING_CLASS_ID, MEETING_FAMILY),
    seedEnvelope(
      "class.setExtends",
      { classId: MEETING_CLASS_ID, parentClassIds: [EVENT_CLASS_ID] },
      [MEETING_CLASS_ID, EVENT_CLASS_ID],
    ),
  ]);
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

describe("ensureMeetingFamily (event root + meeting subclass)", () => {
  it("self-heals the whole family at the reserved ids on an unseeded (offline-first) workspace", async () => {
    const client = await seedClient();
    expect(await meetingFamilyPresent(client)).toBe(false);

    await ensureMeetingFamily(client);

    // The event root: class node + eventDate schema/binding.
    const eventClass = client.getNodeRaw(EVENT_CLASS_ID);
    expect(eventClass?.isClass).toBe(true);
    expect(deriveDisplayName(eventClass!)).toBe("event");
    const schemas = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.eventDate)).toMatchObject({
      name: "eventDate",
      type: "date",
      scope: "class",
    });
    expect(client.getClassBindings(EVENT_CLASS_ID).map((binding) => binding.propertySchemaId)).toEqual(
      [SYSTEM_PROPERTY_UUIDS.eventDate],
    );

    // The meeting subclass: node + family + the extends edge.
    const meetingClass = client.getNodeRaw(MEETING_CLASS_ID);
    expect(meetingClass?.isClass).toBe(true);
    expect(deriveDisplayName(meetingClass!)).toBe("meeting");
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
    expect(client.getClassParents(MEETING_CLASS_ID)).toContain(EVENT_CLASS_ID);

    expect(await meetingFamilyPresent(client)).toBe(true);
  });

  it("is idempotent: a second call authors nothing (including the extends edge)", async () => {
    const client = await seedClient();
    await ensureMeetingFamily(client);
    const schemasAfterFirst = client.listPropertySchemas().length;
    const meetingBindings = client.getClassBindings(MEETING_CLASS_ID).length;
    const eventBindings = client.getClassBindings(EVENT_CLASS_ID).length;
    const parentsAfterFirst = client.getClassParents(MEETING_CLASS_ID);

    await ensureMeetingFamily(client);
    await ensureMeetingFamily(client);

    expect(client.listPropertySchemas()).toHaveLength(schemasAfterFirst);
    expect(client.getClassBindings(MEETING_CLASS_ID)).toHaveLength(meetingBindings);
    expect(client.getClassBindings(EVENT_CLASS_ID)).toHaveLength(eventBindings);
    expect(client.getClassParents(MEETING_CLASS_ID)).toEqual(parentsAfterFirst);
  });

  it("recognizes the server-seed shape and re-authors nothing (convergence by id)", async () => {
    const client = await seedClient(serverSeededRelay());
    expect(await meetingFamilyPresent(client)).toBe(true);

    const schemas = client.listPropertySchemas().length;
    const meetingBindings = client.getClassBindings(MEETING_CLASS_ID).length;
    const eventBindings = client.getClassBindings(EVENT_CLASS_ID).length;
    await ensureMeetingFamily(client);

    expect(client.listPropertySchemas()).toHaveLength(schemas);
    expect(client.getClassBindings(MEETING_CLASS_ID)).toHaveLength(meetingBindings);
    expect(client.getClassBindings(EVENT_CLASS_ID)).toHaveLength(eventBindings);
    expect(client.getNodeRaw(EVENT_CLASS_ID)?.icon).toBe(SYSTEM_CLASS_ICONS.event);
    expect(client.getNodeRaw(MEETING_CLASS_ID)?.icon).toBe(SYSTEM_CLASS_ICONS.meeting);
    expect(client.getClassParents(MEETING_CLASS_ID)).toEqual([EVENT_CLASS_ID]);
  });

  it("re-heals a dropped extends edge (the present-gate covers the edge, not just schemas)", async () => {
    const client = await seedClient();
    await ensureMeetingFamily(client);
    // Simulate the edge's loss in the derived store (the applier state a
    // damaged replica could hold): re-authoring must restore exactly [event].
    client.store.database
      .prepare("DELETE FROM class_extends WHERE class_id = ?")
      .run(MEETING_CLASS_ID);
    expect(await meetingFamilyPresent(client)).toBe(false);

    await ensureMeetingFamily(client);

    expect(client.getClassParents(MEETING_CLASS_ID)).toEqual([EVENT_CLASS_ID]);
    expect(await meetingFamilyPresent(client)).toBe(true);
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

  it("makes BOTH classes calendar quick-create eligible through their date bindings (Calendar breadth)", async () => {
    const client = await seedClient();
    await ensureMeetingFamily(client);

    // The Calendar view's exact chip-qualification call (CalendarView.tsx).
    const classes = client
      .listClasses()
      .map((cls) => ({ id: cls.id, name: displayNameFromClient(client, cls.id) }));
    const chips = dateChipCandidates(classes, (classId) => client.getClassBindings(classId));

    const eventChip = chips.find((chip) => chip.classId === EVENT_CLASS_ID);
    expect(eventChip).toMatchObject({
      schemaId: SYSTEM_PROPERTY_UUIDS.eventDate,
      label: "event",
    });
    const meetingChip = chips.find((chip) => chip.classId === MEETING_CLASS_ID);
    expect(meetingChip).toMatchObject({
      schemaId: SYSTEM_PROPERTY_UUIDS.meetingDate,
      label: "meeting",
    });
    // Each family contributes exactly one chip (one date binding apiece).
    expect(chips.filter((chip) => chip.classId === EVENT_CLASS_ID)).toHaveLength(1);
    expect(chips.filter((chip) => chip.classId === MEETING_CLASS_ID)).toHaveLength(1);
  });

  it("a meeting created through the calendar create flow answers the class+date query AND the event query via extends", async () => {
    const client = await seedClient();
    await ensureMeetingFamily(client);

    // CalendarView.createClassed: create classed → set the driving date.
    const id = await client.createObject({ presentAsMain: true, classIds: [MEETING_CLASS_ID] });
    await client.setDateProperty(id, SYSTEM_PROPERTY_UUIDS.meetingDate, "2026-10-06");

    const classAndDate = client.runQueryAst({
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
    expect(classAndDate.ids).toContain(id);

    // Extends breadth: meeting IS-A event, so the event class query sees it.
    const asEvent = client.runQueryAst({
      version: 1,
      scope: { type: "entire_workspace" },
      root: {
        type: "group",
        logic: "and",
        children: [{ type: "class", classId: EVENT_CLASS_ID }],
      },
    });
    expect(asEvent.ids).toContain(id);
  });
});
