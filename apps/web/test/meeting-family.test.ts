/**
 * ensureMeetingFamily tests (owner reshape directive 2026-10-04:
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
  BIRTHDAY_CLASS_ID,
  BIRTHDAY_FAMILY,
  birthdayFamilyPresent,
  ensureBirthdayFamily,
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
  family: ReadonlyArray<{ id: string; name: string; type: string; targetClassFilter?: string[] }>,
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
        {
          propertySchemaId: spec.id,
          name: spec.name,
          type: spec.type,
          multi: false,
          scope: "class",
          ...(spec.targetClassFilter !== undefined
            ? { targetClassFilter: spec.targetClassFilter }
            : {}),
        },
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
    ...classSeedEnvelopes("birthday", BIRTHDAY_CLASS_ID, BIRTHDAY_FAMILY),
    seedEnvelope(
      "class.setExtends",
      { classId: MEETING_CLASS_ID, parentClassIds: [EVENT_CLASS_ID] },
      [MEETING_CLASS_ID, EVENT_CLASS_ID],
    ),
    seedEnvelope(
      "class.setExtends",
      { classId: BIRTHDAY_CLASS_ID, parentClassIds: [EVENT_CLASS_ID] },
      [BIRTHDAY_CLASS_ID, EVENT_CLASS_ID],
    ),
    // The SYSTEM_EXTRA_CLASS_BINDINGS emission: eventDate re-bound on
    // birthday (the chip-eligibility row).
    seedEnvelope(
      "class.property.set",
      { classId: BIRTHDAY_CLASS_ID, propertySchemaId: SYSTEM_PROPERTY_UUIDS.eventDate, sequence: 0 },
      [BIRTHDAY_CLASS_ID],
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
    expect(deriveDisplayName(eventClass!)).toBe("Event");
    const schemas = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.eventDate)).toMatchObject({
      name: "Event date",
      type: "datetime",
      scope: "class",
    });
    expect(client.getClassBindings(EVENT_CLASS_ID).map((binding) => binding.propertySchemaId)).toEqual(
      [SYSTEM_PROPERTY_UUIDS.eventDate],
    );

    // The meeting subclass: node + family + the extends edge.
    const meetingClass = client.getNodeRaw(MEETING_CLASS_ID);
    expect(meetingClass?.isClass).toBe(true);
    expect(deriveDisplayName(meetingClass!)).toBe("Meeting");
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.meetingDate)).toMatchObject({
      name: "Meeting date",
      type: "datetime",
      scope: "class",
    });
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.location)).toMatchObject({
      name: "Location",
      type: "text",
    });
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.agenda)).toMatchObject({
      name: "Agenda",
      type: "text",
    });
    const bindings = client.getClassBindings(MEETING_CLASS_ID);
    // The meeting family rides the seed-spec fallback (read-synthesized at
    // the reserved ids — the ensure's bound-check sees them and authors no
    // duplicate rows).
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
      type: "datetime",
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
      label: "Event",
    });
    const meetingChip = chips.find((chip) => chip.classId === MEETING_CLASS_ID);
    expect(meetingChip).toMatchObject({
      schemaId: SYSTEM_PROPERTY_UUIDS.meetingDate,
      label: "Meeting",
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
    await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.meetingDate, { iso: "2026-10-06" });

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

describe("ensureBirthdayFamily (birthday extends event, for persons)", () => {
  it("self-heals the birthday family at the reserved ids on an unseeded workspace", async () => {
    const client = await seedClient();
    expect(await birthdayFamilyPresent(client)).toBe(false);

    await ensureBirthdayFamily(client);

    // The event root exists (the date's home via the extends chain).
    expect(client.getNodeRaw(EVENT_CLASS_ID)?.isClass).toBe(true);
    // The birthday class + the person-typed schema…
    const birthdayClass = client.getNodeRaw(BIRTHDAY_CLASS_ID);
    expect(birthdayClass?.isClass).toBe(true);
    expect(deriveDisplayName(birthdayClass!)).toBe("Birthday");
    const schema = client
      .listPropertySchemas()
      .find((entry) => entry.id === SYSTEM_PROPERTY_UUIDS.birthdayPerson);
    expect(schema).toMatchObject({ name: "Birthday person", type: "object", scope: "class" });
    expect(schema?.targetClassFilter).toEqual([SYSTEM_CLASS_UUIDS.person]);
    // …its binding, the eventDate chip-eligibility row, and the edge.
    const bound = client
      .getClassBindings(BIRTHDAY_CLASS_ID)
      .map((binding) => binding.propertySchemaId);
    expect(bound).toContain(SYSTEM_PROPERTY_UUIDS.birthdayPerson);
    expect(bound).toContain(SYSTEM_PROPERTY_UUIDS.eventDate);
    expect(client.getClassParents(BIRTHDAY_CLASS_ID)).toContain(EVENT_CLASS_ID);
    expect(await birthdayFamilyPresent(client)).toBe(true);
  });

  it("is idempotent: repeated calls author nothing (no birthdayDate anywhere)", async () => {
    const client = await seedClient();
    await ensureBirthdayFamily(client);
    const schemas = client.listPropertySchemas().length;
    const bindings = client.getClassBindings(BIRTHDAY_CLASS_ID).length;
    const parents = client.getClassParents(BIRTHDAY_CLASS_ID);

    await ensureBirthdayFamily(client);
    await ensureBirthdayFamily(client);

    expect(client.listPropertySchemas()).toHaveLength(schemas);
    expect(client.getClassBindings(BIRTHDAY_CLASS_ID)).toHaveLength(bindings);
    expect(client.getClassParents(BIRTHDAY_CLASS_ID)).toEqual(parents);
    // The date rides eventDate — a birthdayDate schema must never appear.
    expect(
      client.listPropertySchemas().some((entry) => entry.name === "birthdayDate"),
    ).toBe(false);
  });

  it("recognizes the server-seed shape and re-authors nothing", async () => {
    const client = await seedClient(serverSeededRelay());
    expect(await birthdayFamilyPresent(client)).toBe(true);

    const schemas = client.listPropertySchemas().length;
    await ensureBirthdayFamily(client);

    expect(client.listPropertySchemas()).toHaveLength(schemas);
    expect(client.getClassParents(BIRTHDAY_CLASS_ID)).toEqual([EVENT_CLASS_ID]);
    expect(client.getNodeRaw(BIRTHDAY_CLASS_ID)?.icon).toBe(SYSTEM_CLASS_ICONS.birthday);
  });

  it("re-heals a dropped extends edge (the present-gate covers the edge)", async () => {
    const client = await seedClient();
    await ensureBirthdayFamily(client);
    client.store.database
      .prepare("DELETE FROM class_extends WHERE class_id = ?")
      .run(BIRTHDAY_CLASS_ID);
    expect(await birthdayFamilyPresent(client)).toBe(false);

    await ensureBirthdayFamily(client);

    expect(client.getClassParents(BIRTHDAY_CLASS_ID)).toEqual([EVENT_CLASS_ID]);
  });

  it("makes the birthday class calendar quick-create eligible (eventDate drives the chip)", async () => {
    const client = await seedClient();
    await ensureBirthdayFamily(client);

    // The Calendar view's exact chip-qualification call (CalendarView.tsx).
    const classes = client
      .listClasses()
      .map((cls) => ({ id: cls.id, name: displayNameFromClient(client, cls.id) }));
    const chips = dateChipCandidates(classes, (classId) => client.getClassBindings(classId));

    const birthdayChip = chips.find((chip) => chip.classId === BIRTHDAY_CLASS_ID);
    expect(birthdayChip).toMatchObject({
      schemaId: SYSTEM_PROPERTY_UUIDS.eventDate,
      label: "Birthday",
    });
    expect(chips.filter((chip) => chip.classId === BIRTHDAY_CLASS_ID)).toHaveLength(1);
  });

  it("a birthday answers BOTH the class:birthday and the class:event queries (extends chain)", async () => {
    const client = await seedClient();
    await ensureBirthdayFamily(client);

    const id = await client.createObject({ presentAsMain: true, classIds: [BIRTHDAY_CLASS_ID] });
    await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.eventDate, { iso: "2026-10-06" });

    const asBirthday = client.runQueryAst({
      version: 1,
      scope: { type: "entire_workspace" },
      root: {
        type: "group",
        logic: "and",
        children: [{ type: "class", classId: BIRTHDAY_CLASS_ID }],
      },
    });
    expect(asBirthday.ids).toContain(id);
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

  it("birthdayPerson accepts a person and rejects an organization (extends-aware filter)", async () => {
    const client = await seedClient();
    await ensureBirthdayFamily(client);
    const personId = await client.createObject({
      presentAsMain: true,
      name: "Ada Lovelace",
      classIds: [SYSTEM_CLASS_UUIDS.person],
    });
    const orgId = await client.createObject({
      presentAsMain: true,
      name: "Analytical Engines Inc",
      classIds: [SYSTEM_CLASS_UUIDS.organization],
    });
    const birthday = await client.createObject({
      presentAsMain: true,
      classIds: [BIRTHDAY_CLASS_ID],
    });

    // A person is a valid birthday target…
    await client.setProperty(birthday, SYSTEM_PROPERTY_UUIDS.birthdayPerson, { nodeId: personId }, 0);
    expect(
      client
        .getEffectiveProperties(birthday)
        .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.birthdayPerson)?.value,
    ).toEqual({ nodeId: personId });

    // …an organization is NOT (person-rooted filter; org founding days are
    // ordinary events). The write fails loud per the loud-failure rule.
    await expect(
      client.setProperty(birthday, SYSTEM_PROPERTY_UUIDS.birthdayPerson, { nodeId: orgId }, 1),
    ).rejects.toThrow();
  });

  it("a person's standard backlinks section already renders their birthdays (no bespoke section)", async () => {
    const client = await seedClient();
    await ensureBirthdayFamily(client);
    const personId = await client.createObject({
      presentAsMain: true,
      name: "Ada Lovelace",
      classIds: [SYSTEM_CLASS_UUIDS.person],
    });
    const birthday = await client.createObject({
      presentAsMain: true,
      name: "Ada's birthday",
      classIds: [BIRTHDAY_CLASS_ID],
    });
    await client.setProperty(birthday, SYSTEM_PROPERTY_UUIDS.birthdayPerson, { nodeId: personId }, 0);

    // The page-bottom references read (SystemSections' linked-references
    // section) lists the birthday on the PERSON's page — the person-typed
    // value fans out as a birthday→person edge, so the person's backlinks
    // render their birthdays with zero bespoke section work. (The edge is
    // one-directional, like a date's: the birthday links TO the person.)
    const personRefs = client.getLinkedReferences(personId).map((entry) => entry.source.id);
    expect(personRefs).toContain(birthday);
  });
});
