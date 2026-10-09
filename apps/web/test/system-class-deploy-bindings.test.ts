/**
 * deploySystemClass's binding step vs the seed-spec fallback — the
 * pre-ruling workspace self-heal.
 *
 * getClassBindings read-synthesizes the designed system seeds for system
 * classes (workspace-client.ts "Seed-spec fallback"), so a workspace that
 * received a system class NODE but never its class_property registry rows
 * LOOKS configured through every fallback read while the registry-only
 * effective-properties read (store effective.ts — binding rows + defaults)
 * sees nothing. The old deploy path asked getClassBindings "already bound?"
 * — the fallback rows answered yes — and authored no registry rows at all.
 *
 * The fix: the deploy existence checks read the registry only
 * (getRegistryBindings — own class_property rows, no inheritance, no
 * fallback). These tests pin:
 *
 *  - a pre-ruling-shaped workspace (class nodes + extends edge, schemas,
 *    NO binding rows) self-heals to registry rows on deploy, the authored
 *    values on its members become bound (boundBy names the class), and a
 *    re-deploy is a complete no-op;
 *  - the birthday class-local eventDate row materializes even though the
 *    inherited binding becomes visible once the event parent is deployed
 *    (the calendar quick-create eligibility walk reads class-local rows);
 *  - the meeting/birthday families keep working through the fallback —
 *    their present gates and the calendar chip eligibility deliberately
 *    rely on the read-synthesized rows and author nothing.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import {
  BIRTHDAY_CLASS_ID,
  ensureBirthdayFamily,
  birthdayFamilyPresent,
  EVENT_CLASS_ID,
  eventFamilyPresent,
  MEETING_CLASS_ID,
} from "../src/ui/components/meetingFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/**
 * The pre-ruling workspace shape: the family class nodes + the extends edge
 * exist, the family's property SCHEMAS exist, but no class_property binding
 * rows were ever authored. The seed-spec fallback covers the reads — this
 * is exactly the shape that used to defeat the deploy's existence checks.
 */
async function shapePreRulingMeetingWorkspace(client: WorkspaceClient): Promise<void> {
  await client.createClass("Event", { id: EVENT_CLASS_ID });
  await client.createClass("Meeting", { id: MEETING_CLASS_ID });
  await client.setClassExtends(MEETING_CLASS_ID, [EVENT_CLASS_ID]);
  await client.createPropertySchema({
    id: SYSTEM_PROPERTY_UUIDS.meetingDate,
    name: "Meeting date",
    type: "datetime",
    scope: "class",
  });
  await client.createPropertySchema({
    id: SYSTEM_PROPERTY_UUIDS.location,
    name: "Location",
    type: "text",
    scope: "class",
  });
  await client.createPropertySchema({
    id: SYSTEM_PROPERTY_UUIDS.agenda,
    name: "Agenda",
    type: "text",
    scope: "class",
  });
  await flushSync();
}

describe("deploySystemClass binding self-heal (registry-only existence checks)", () => {
  it("a pre-ruling-shaped workspace self-heals to registry rows", async () => {
    const client = await seedClient();
    await shapePreRulingMeetingWorkspace(client);

    // The fallback read makes the family LOOK configured…
    const displayIds = client
      .getClassBindings(MEETING_CLASS_ID)
      .map((binding) => binding.propertySchemaId);
    expect(displayIds).toEqual([
      SYSTEM_PROPERTY_UUIDS.meetingDate,
      SYSTEM_PROPERTY_UUIDS.location,
      SYSTEM_PROPERTY_UUIDS.agenda,
    ]);
    // …while the registry-only read sees nothing (the effective-properties
    // derivation agrees — an authored value on a member is unbound).
    expect(client.getRegistryBindings(MEETING_CLASS_ID)).toEqual([]);

    const member = await client.createObject({ name: "Weekly sync" });
    await client.assignClass(member, MEETING_CLASS_ID);
    await client.setProperty(member, SYSTEM_PROPERTY_UUIDS.agenda, "Roadmap", 0);
    await flushSync();
    const authoredBefore = client
      .getEffectiveProperties(member)
      .find((property) => property.propertySchemaId === SYSTEM_PROPERTY_UUIDS.agenda);
    expect(authoredBefore?.value).toBe("Roadmap");
    expect(authoredBefore?.boundBy).toBeNull();

    const { deploySystemClass } = await import("../src/ui/components/systemClassDeploy.js");
    await deploySystemClass(client, "meeting");
    await flushSync();

    // The registry rows materialize — own rows for the whole family, in
    // manifest order (the sequences the server seed's per-class counter
    // produces on a fresh class).
    const registry = client.getRegistryBindings(MEETING_CLASS_ID);
    expect(registry.map((binding) => binding.propertySchemaId)).toEqual([
      SYSTEM_PROPERTY_UUIDS.meetingDate,
      SYSTEM_PROPERTY_UUIDS.location,
      SYSTEM_PROPERTY_UUIDS.agenda,
    ]);
    expect(registry.map((binding) => binding.sequence)).toEqual([0, 1, 2]);
    // The event parent was deployed first: its eventDate row exists too.
    expect(client.getRegistryBindings(EVENT_CLASS_ID).map((b) => b.propertySchemaId)).toEqual([
      SYSTEM_PROPERTY_UUIDS.eventDate,
    ]);

    // The registry-only effective read now BINDS the authored value.
    const authoredAfter = client
      .getEffectiveProperties(member)
      .find((property) => property.propertySchemaId === SYSTEM_PROPERTY_UUIDS.agenda);
    expect(authoredAfter?.boundBy).toBe(MEETING_CLASS_ID);
    expect(authoredAfter?.sequence).toBe(2);

    // Re-deploying is a complete no-op (the per-step registry checks).
    const snapshot = client.getRegistryBindings(MEETING_CLASS_ID).map((binding) => ({
      id: binding.propertySchemaId,
      sequence: binding.sequence,
    }));
    await deploySystemClass(client, "meeting");
    await flushSync();
    expect(
      client.getRegistryBindings(MEETING_CLASS_ID).map((binding) => ({
        id: binding.propertySchemaId,
        sequence: binding.sequence,
      })),
    ).toEqual(snapshot);
  });

  it("materializes the birthday class-local eventDate row (not masked by inheritance)", async () => {
    const client = await seedClient();
    // The event parent already carries its registry rows — the shape after
    // a partial seed or an earlier event deploy.
    const { deploySystemClass } = await import("../src/ui/components/systemClassDeploy.js");
    await deploySystemClass(client, "event");
    await flushSync();
    expect(client.getRegistryBindings(EVENT_CLASS_ID)).toHaveLength(1);
    // The birthday node + edge exist, nothing else (a workspace seeded
    // before the birthday family joined the manifest).
    await client.createClass("Birthday", { id: BIRTHDAY_CLASS_ID });
    await client.setClassExtends(BIRTHDAY_CLASS_ID, [EVENT_CLASS_ID]);
    await flushSync();

    await deploySystemClass(client, "birthday");
    await flushSync();

    const registry = client.getRegistryBindings(BIRTHDAY_CLASS_ID);
    // birthdayPerson (the own family) + the class-local eventDate row the
    // calendar quick-create eligibility walk reads — the inherited binding
    // from event must NOT satisfy this check.
    expect(registry.map((binding) => binding.propertySchemaId).sort()).toEqual(
      [SYSTEM_PROPERTY_UUIDS.birthdayPerson, SYSTEM_PROPERTY_UUIDS.eventDate].sort(),
    );
    const eventDateRow = registry.find(
      (binding) => binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.eventDate,
    );
    expect(eventDateRow?.sequence).toBe(0);
  });

  it("keeps the fallback read working for the meeting/birthday present gates", async () => {
    const client = await seedClient();
    // Event class node + its eventDate SCHEMA, but no registry rows: the
    // family reads as present through the fallback (the deliberate
    // reliance), and the ensure must not author registry rows for it.
    await client.createClass("Event", { id: EVENT_CLASS_ID });
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.eventDate,
      name: "Event date",
      type: "datetime",
      scope: "class",
    });
    await flushSync();

    expect(client.getRegistryBindings(EVENT_CLASS_ID)).toEqual([]);
    expect(await eventFamilyPresent(client)).toBe(true);
    expect(
      client.getClassBindings(EVENT_CLASS_ID).map((binding) => binding.propertySchemaId),
    ).toEqual([SYSTEM_PROPERTY_UUIDS.eventDate]);

    const { ensureMeetingFamily } = await import("../src/ui/components/meetingFamily.js");
    await ensureMeetingFamily(client);
    await flushSync();
    // Still no registry rows on the event root — the family rides the
    // fallback read exactly as before the deploy fix.
    expect(client.getRegistryBindings(EVENT_CLASS_ID)).toEqual([]);
    expect(await eventFamilyPresent(client)).toBe(true);
  });

  it("composes with the birthday ensure: the calendar chip row rides either path", async () => {
    const client = await seedClient();
    // A workspace where the birthday family was ensured (fallback-only
    // shape: the birthdayPerson binding read-synthesized, the class-local
    // eventDate row authored because the fallback does NOT cover it).
    const { ensureMeetingFamily } = await import("../src/ui/components/meetingFamily.js");
    await ensureMeetingFamily(client);
    await client.createClass("Birthday", { id: BIRTHDAY_CLASS_ID });
    await client.setClassExtends(BIRTHDAY_CLASS_ID, [EVENT_CLASS_ID]);
    await flushSync();
    await ensureBirthdayFamily(client);
    await flushSync();

    expect(await birthdayFamilyPresent(client)).toBe(true);
    const registryBefore = client.getRegistryBindings(BIRTHDAY_CLASS_ID);
    expect(registryBefore.map((binding) => binding.propertySchemaId)).toEqual([
      SYSTEM_PROPERTY_UUIDS.eventDate,
    ]);

    // Deploying the class afterwards converges the registry to the full
    // seeded shape (birthdayPerson row added; the existing row untouched).
    const { deploySystemClass } = await import("../src/ui/components/systemClassDeploy.js");
    await deploySystemClass(client, "birthday");
    await flushSync();
    const registryAfter = client.getRegistryBindings(BIRTHDAY_CLASS_ID);
    expect(registryAfter.map((binding) => binding.propertySchemaId).sort()).toEqual(
      [SYSTEM_PROPERTY_UUIDS.birthdayPerson, SYSTEM_PROPERTY_UUIDS.eventDate].sort(),
    );
    expect(
      registryAfter.find((binding) => binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.eventDate)
        ?.sequence,
    ).toBe(0);
  });
});
