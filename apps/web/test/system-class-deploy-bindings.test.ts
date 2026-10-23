/**
 * deploySystemClass's binding step vs the seed-spec fallback — the
 * pre-ruling workspace self-heal.
 *
 * getClassBindings read-synthesizes the designed system seeds for system
 * classes (the workspace-client folder module ("Seed-spec fallback")), so a workspace that
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
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  BIRTHDAY_CLASS_ID,
  ensureBirthdayFamily,
  birthdayFamilyPresent,
  EVENT_CLASS_ID,
  eventFamilyPresent,
  MEETING_CLASS_ID,
} from "../src/features/classview/meetingFamily.js";

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
    scopeClassIds: [MEETING_CLASS_ID],
  });
  await client.createPropertySchema({
    id: SYSTEM_PROPERTY_UUIDS.location,
    name: "Location",
    type: "text",
    scopeClassIds: [MEETING_CLASS_ID],
  });
  await client.createPropertySchema({
    id: SYSTEM_PROPERTY_UUIDS.agenda,
    name: "Agenda",
    type: "text",
    scopeClassIds: [MEETING_CLASS_ID],
  });
  await flushSync();
}

describe("deploySystemClass binding self-heal (registry-only existence checks)", () => {
  it("a pre-ruling-shaped workspace self-heals to registry rows", async () => {
    const client = await seedClient();
    await shapePreRulingMeetingWorkspace(client);

    // The fallback read makes the family LOOK configured (ALPHABETICAL by
    // property name — owner ruling 2026-10-21, binding sequence retired)…
    const displayIds = client
      .getClassBindings(MEETING_CLASS_ID)
      .map((binding) => binding.propertySchemaId);
    expect(displayIds).toEqual([
      SYSTEM_PROPERTY_UUIDS.agenda,
      SYSTEM_PROPERTY_UUIDS.location,
      SYSTEM_PROPERTY_UUIDS.meetingDate,
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

    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");
    await deploySystemClass(client, "meeting");
    await flushSync();

    // The registry rows materialize — own rows for the whole family,
    // ALPHABETICAL by property name (owner ruling 2026-10-21 — binding
    // sequence retired): Agenda, Location, Meeting date.
    const registry = client.getRegistryBindings(MEETING_CLASS_ID);
    expect(registry.map((binding) => binding.propertySchemaId)).toEqual([
      SYSTEM_PROPERTY_UUIDS.agenda,
      SYSTEM_PROPERTY_UUIDS.location,
      SYSTEM_PROPERTY_UUIDS.meetingDate,
    ]);
    // The event parent was deployed first: its eventDate row exists too.
    expect(client.getRegistryBindings(EVENT_CLASS_ID).map((b) => b.propertySchemaId)).toEqual([
      SYSTEM_PROPERTY_UUIDS.eventDate,
    ]);

    // The registry-only effective read now BINDS the authored value.
    const authoredAfter = client
      .getEffectiveProperties(member)
      .find((property) => property.propertySchemaId === SYSTEM_PROPERTY_UUIDS.agenda);
    expect(authoredAfter?.boundBy).toBe(MEETING_CLASS_ID);

    // Re-deploying is a complete no-op (the per-step registry checks).
    const snapshot = client.getRegistryBindings(MEETING_CLASS_ID).map((binding) => ({
      id: binding.propertySchemaId,
      active: binding.active,
    }));
    await deploySystemClass(client, "meeting");
    await flushSync();
    expect(
      client.getRegistryBindings(MEETING_CLASS_ID).map((binding) => ({
        id: binding.propertySchemaId,
        active: binding.active,
      })),
    ).toEqual(snapshot);
  });

  it("materializes the birthday class-local eventDate row (not masked by inheritance)", async () => {
    const client = await seedClient();
    // The event parent already carries its registry rows — the shape after
    // a partial seed or an earlier event deploy.
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");
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
    expect(eventDateRow?.active).toBe(true);
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
      scopeClassIds: [EVENT_CLASS_ID],
    });
    await flushSync();

    expect(client.getRegistryBindings(EVENT_CLASS_ID)).toEqual([]);
    expect(await eventFamilyPresent(client)).toBe(true);
    expect(
      client.getClassBindings(EVENT_CLASS_ID).map((binding) => binding.propertySchemaId),
    ).toEqual([SYSTEM_PROPERTY_UUIDS.eventDate]);

    const { ensureMeetingFamily } = await import("../src/features/classview/meetingFamily.js");
    await ensureMeetingFamily(client);
    await flushSync();
    // Still no registry rows on the event root — the family rides the
    // fallback read exactly as before the deploy fix.
    expect(client.getRegistryBindings(EVENT_CLASS_ID)).toEqual([]);
    expect(await eventFamilyPresent(client)).toBe(true);
  });

  it("deploys web_page's url schema at GLOBAL scope with the web_page binding row", async () => {
    const client = await seedClient();
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");
    await deploySystemClass(client, "web_page");
    await flushSync();

    const url = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.url);
    // Owner ruling 2026-10-20 (the seed-scope audit): a url is generically
    // reusable — global scope (NULL scopeClassIds), NOT local to web_page…
    expect(url).toMatchObject({ name: "URL", type: "url", scopeClassIds: null });
    // …while the binding rows land on the web_page class (bindings are
    // per-class config, zero availability semantics): the url row plus the
    // source library's web_page entry (SYSTEM_SOURCE_CLASS_BINDINGS).
    const expected = [
      SYSTEM_PROPERTY_UUIDS.url,
      ...SYSTEM_SOURCE_CLASS_BINDINGS.web_page!.map((property) => SYSTEM_PROPERTY_UUIDS[property]),
    ].sort();
    expect(
      client.getRegistryBindings(SYSTEM_CLASS_UUIDS.web_page).map((b) => b.propertySchemaId).sort(),
    ).toEqual(expected);
  });

  it("composes with the birthday ensure: the calendar chip row rides either path", async () => {
    const client = await seedClient();
    // A workspace where the birthday family was ensured (fallback-only
    // shape: the birthdayPerson binding read-synthesized, the class-local
    // eventDate row authored because the fallback does NOT cover it).
    const { ensureMeetingFamily } = await import("../src/features/classview/meetingFamily.js");
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
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");
    await deploySystemClass(client, "birthday");
    await flushSync();
    const registryAfter = client.getRegistryBindings(BIRTHDAY_CLASS_ID);
    expect(registryAfter.map((binding) => binding.propertySchemaId).sort()).toEqual(
      [SYSTEM_PROPERTY_UUIDS.birthdayPerson, SYSTEM_PROPERTY_UUIDS.eventDate].sort(),
    );
    expect(
      registryAfter.find((binding) => binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.eventDate)
        ?.active,
    ).toBe(true);
  });

  it("deploys a source type-class with its SYSTEM_SOURCE_CLASS_BINDINGS rows", async () => {
    const client = await seedClient();
    const { deploySystemClass } = await import("../src/features/classview/systemClassDeploy.js");
    // book_section is archived-by-default: deploying it is the gallery's
    // enable pick — the class lands active, its parent (source) deploys
    // first (pool schemas + the base's own binding rows).
    await deploySystemClass(client, "book_section");
    await flushSync();

    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.book_section)).toMatchObject({
      isActive: true,
    });
    // The class-local rows are exactly the manifest's table entry — the
    // pool schemas ride the source base (inherited bindings are not own
    // rows, so they never satisfy this registry-only read).
    const expected = SYSTEM_SOURCE_CLASS_BINDINGS.book_section!.map(
      (property) => SYSTEM_PROPERTY_UUIDS[property],
    ).sort();
    const registry = client
      .getRegistryBindings(SYSTEM_CLASS_UUIDS.book_section)
      .map((binding) => binding.propertySchemaId);
    expect(registry.sort()).toEqual(expected);
    // The base's own rows exist on source.
    expect(client.getRegistryBindings(SYSTEM_CLASS_UUIDS.source).length).toBeGreaterThan(0);
    // An archived-by-default sibling keeps its bit: deploying ONE class
    // never touches the others.
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.patent)).toBeUndefined();

    // Re-deploying is a complete no-op.
    const snapshot = client
      .getRegistryBindings(SYSTEM_CLASS_UUIDS.book_section)
      .map((binding) => ({ id: binding.propertySchemaId, active: binding.active }));
    await deploySystemClass(client, "book_section");
    await flushSync();
    expect(
      client
        .getRegistryBindings(SYSTEM_CLASS_UUIDS.book_section)
        .map((binding) => ({ id: binding.propertySchemaId, active: binding.active })),
    ).toEqual(snapshot);
  });
});
