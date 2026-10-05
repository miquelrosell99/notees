/**
 * Meeting/event family — §34.36 + the owner's reshape directive (2026-10-04:
 * PLAIN SEEDS, zero wire cost — seed convergence only, no lockstep).
 *
 * `event` is the CALENDAR family root: a date-only base class (its single
 * `eventDate` date binding is what makes a class calendar quick-create
 * eligible — any class with a date-typed binding per dateChipCandidates).
 * `meeting` IS-A event (SYSTEM_CLASS_EXTENDS): a meeting is an event with a
 * meeting-specific family on top (meetingDate — still whole-day per the
 * §34.28 law, no clock times — plus text location/agenda). `birthday` IS-A
 * event too (§34.36.3, owner directive 2026-10-04): a person's birthday is an
 * event on the calendar — the date rides eventDate through the extends chain,
 * and the family is person-typed (birthdayPerson links the event TO the
 * person; filter rooted at `person`, so orgs don't carry birthdays). Gating
 * semantics for the future Features tab (the tab is another wave's surface):
 * disabling `event` disables `meeting` AND `birthday` with it; disabling a
 * child alone leaves the parent live — `systemClassAncestors` in
 * @notees/domain is the shared read. Persons stay always-on regardless: a
 * person without the birthday family simply has no birthdays.
 *
 * All classes are fixed-UUID domain seeds: NEW workspaces receive the class
 * nodes + schemas + bindings + the extends edges from the server seed, and
 * every replica converges by id — the op set is untouched. Existing
 * workspaces materialize the families idempotently through
 * ensureMeetingFamily / ensureBirthdayFamily — the ensureTaskFamily precedent
 * (both ensure the event ROOT first: the extends edges are unrepresentable
 * without the event class row).
 *
 * Declaration-first (owner ruling): nothing calls these ensures
 * automatically — configure now, wire later. The calendar quick-create needs
 * no code change: dateChipCandidates qualifies ANY class with a date-typed
 * binding, so the event, meeting and birthday chips appear on their own once
 * the family exists in a workspace (server seed for new ones, an ensure call
 * for the rest). scripts/remap-reunion-evento.mts ensures the family across
 * the objects API before assigning members (reunión → meeting, evento →
 * event); birthdays have no remap source.
 *
 * The surface reads are MaybePromise so the same ensure runs over the sync
 * web clients (WorkspaceClient, WorkerClient — both satisfy the interface
 * structurally) and over the remap script's async HTTP adapter, no casts.
 * Type-only client imports keep the module runtime-import-free beyond
 * @notees/domain, so node-side consumers (the script under tsx) can import it.
 */

import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import type {
  ClientPropertySchema,
  CreatePropertySchemaInput,
  SetClassPropertyInput,
} from "@/core/workspace-client.js";

type MaybePromise<T> = T | Promise<T>;

export interface MeetingFamilySurface {
  /**
   * Existence probe only — the ensure compares the result to undefined and
   * never reads fields, so the surface may return any node-shaped value
   * (ClientNode client-side, the class detail body over HTTP).
   */
  getNodeRaw(id: string): MaybePromise<unknown>;
  listPropertySchemas(): MaybePromise<readonly ClientPropertySchema[]>;
  getClassBindings(classId: string): MaybePromise<readonly { propertySchemaId: string }[]>;
  /** The class's extends parents (class_extends rows) — the edge read. */
  getClassParents(classId: string): MaybePromise<readonly string[]>;
  createClass(name: string, opts?: { icon?: string; color?: string; id?: string }): Promise<string>;
  createPropertySchema(input: CreatePropertySchemaInput): Promise<string>;
  setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): Promise<void>;
  /** Replace the full extends parent set (class.setExtends — replace semantics). */
  setClassExtends(classId: string, parentClassIds: string[]): Promise<void>;
}

/** The family ids — the domain seed's fixed vocabulary. */
export const MEETING_CLASS_ID = SYSTEM_CLASS_UUIDS.meeting;
export const EVENT_CLASS_ID = SYSTEM_CLASS_UUIDS.event;
export const BIRTHDAY_CLASS_ID = SYSTEM_CLASS_UUIDS.birthday;

/** The event root's minimal family: the date binding the calendar rides on. */
export const EVENT_FAMILY: ReadonlyArray<{ id: string; name: string; type: "date" }> = [
  { id: SYSTEM_PROPERTY_UUIDS.eventDate, name: SYSTEM_PROPERTY_DISPLAY_NAMES.eventDate, type: "date" },
];

/**
 * The birthday family: ONE own property — the person the birthday is for.
 * The DATE rides event's eventDate through the extends chain (the store's
 * binding resolution is extends-aware), so there is deliberately no
 * birthdayDate; the ensure additionally authors the (birthday, eventDate)
 * BINDING ROW (mirroring SYSTEM_EXTRA_CLASS_BINDINGS) because the calendar
 * quick-create eligibility walk reads class-local binding rows.
 */
export const BIRTHDAY_FAMILY: ReadonlyArray<{
  id: string;
  name: string;
  type: "object";
  targetClassFilter: string[];
}> = [
  {
    id: SYSTEM_PROPERTY_UUIDS.birthdayPerson,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.birthdayPerson,
    type: "object",
    targetClassFilter: [SYSTEM_CLASS_UUIDS.person],
  },
];

/**
 * The meeting family in seed order (the binding sequence is the array index,
 * exactly what the server seed's per-class binding counter produces on a
 * fresh class). Schema names ride SYSTEM_PROPERTY_DISPLAY_NAMES (normal
 * wording), so an offline-first workspace that self-heals converges
 * name-for-name with a server-seeded one (the system-names pass,
 * 2026-10-05).
 */
export const MEETING_FAMILY: ReadonlyArray<{ id: string; name: string; type: "date" | "text" }> = [
  { id: SYSTEM_PROPERTY_UUIDS.meetingDate, name: SYSTEM_PROPERTY_DISPLAY_NAMES.meetingDate, type: "date" },
  { id: SYSTEM_PROPERTY_UUIDS.location, name: SYSTEM_PROPERTY_DISPLAY_NAMES.location, type: "text" },
  { id: SYSTEM_PROPERTY_UUIDS.agenda, name: SYSTEM_PROPERTY_DISPLAY_NAMES.agenda, type: "text" },
];

async function familyPresent(
  surface: MeetingFamilySurface,
  classId: string,
  family: ReadonlyArray<{ id: string }>,
): Promise<boolean> {
  const have = new Set((await surface.listPropertySchemas()).map((schema) => schema.id));
  const bound = new Set(
    (await surface.getClassBindings(classId)).map((binding) => binding.propertySchemaId),
  );
  return family.every((spec) => have.has(spec.id) && bound.has(spec.id));
}

/** True when the event root's schema + binding exist. */
export function eventFamilyPresent(surface: MeetingFamilySurface): Promise<boolean> {
  return familyPresent(surface, EVENT_CLASS_ID, EVENT_FAMILY);
}

/**
 * True when the WHOLE family is present: event root (schema + binding), the
 * meeting family, and the meeting→event extends edge. The single gate the
 * ensure re-checks — any missing piece (including a dropped edge) re-runs
 * the idempotent authoring.
 */
export async function meetingFamilyPresent(surface: MeetingFamilySurface): Promise<boolean> {
  if (!(await familyPresent(surface, EVENT_CLASS_ID, EVENT_FAMILY))) return false;
  if (!(await familyPresent(surface, MEETING_CLASS_ID, MEETING_FAMILY))) return false;
  const parents = await surface.getClassParents(MEETING_CLASS_ID);
  return parents.includes(EVENT_CLASS_ID);
}

/** Author one class's schemas + bindings when missing (shared loop). */
async function ensureFamilySchemas(
  surface: MeetingFamilySurface,
  classId: string,
  family: ReadonlyArray<{
    id: string;
    name: string;
    type: "date" | "text" | "object";
    targetClassFilter?: string[];
  }>,
): Promise<void> {
  const have = new Set((await surface.listPropertySchemas()).map((schema) => schema.id));
  for (const spec of family) {
    if (have.has(spec.id)) continue;
    await surface.createPropertySchema({
      id: spec.id,
      name: spec.name,
      type: spec.type,
      scope: "class",
      ...(spec.targetClassFilter !== undefined
        ? { targetClassFilter: spec.targetClassFilter }
        : {}),
    });
  }
  const bound = new Set(
    (await surface.getClassBindings(classId)).map((binding) => binding.propertySchemaId),
  );
  for (const [index, spec] of family.entries()) {
    if (bound.has(spec.id)) continue;
    await surface.setClassProperty(classId, spec.id, { sequence: index });
  }
}

/** Author the event root (class node + eventDate schema/binding) when missing. */
async function ensureEventRoot(surface: MeetingFamilySurface): Promise<void> {
  if ((await surface.getNodeRaw(EVENT_CLASS_ID)) === undefined) {
    await surface.createClass(SYSTEM_CLASS_DISPLAY_NAMES.event, { id: EVENT_CLASS_ID, icon: SYSTEM_CLASS_ICONS.event });
  }
  await ensureFamilySchemas(surface, EVENT_CLASS_ID, EVENT_FAMILY);
}

/**
 * Author the event root + the meeting subclass (node, family, extends edge)
 * when missing; a complete no-op once present (idempotent — safe to call on
 * every open). The class nodes are expected from the server seed; a workspace
 * that never got one (offline-first devices, or an existing workspace before
 * the remap script runs) self-heals them here at the reserved ids — without
 * the node rows, getClassBindings can't see the binding rows (every call
 * would re-author them, op-log noise) and the extends edge has nothing to
 * attach to. The edge is replace-semantics [event] — exactly the seeded
 * parent set, so a re-run converges with the server seed.
 */
export async function ensureMeetingFamily(surface: MeetingFamilySurface): Promise<void> {
  if (await meetingFamilyPresent(surface)) return;
  await ensureEventRoot(surface);
  if ((await surface.getNodeRaw(MEETING_CLASS_ID)) === undefined) {
    await surface.createClass(SYSTEM_CLASS_DISPLAY_NAMES.meeting, { id: MEETING_CLASS_ID, icon: SYSTEM_CLASS_ICONS.meeting });
  }
  await ensureFamilySchemas(surface, MEETING_CLASS_ID, MEETING_FAMILY);
  const parents = await surface.getClassParents(MEETING_CLASS_ID);
  if (!parents.includes(EVENT_CLASS_ID)) {
    await surface.setClassExtends(MEETING_CLASS_ID, [EVENT_CLASS_ID]);
  }
}

/** True when the birthday shape is whole (family + edge + the eventDate row). */
export async function birthdayFamilyPresent(surface: MeetingFamilySurface): Promise<boolean> {
  if (!(await familyPresent(surface, EVENT_CLASS_ID, EVENT_FAMILY))) return false;
  if (!(await familyPresent(surface, BIRTHDAY_CLASS_ID, BIRTHDAY_FAMILY))) return false;
  const bound = new Set(
    (await surface.getClassBindings(BIRTHDAY_CLASS_ID)).map(
      (binding) => binding.propertySchemaId,
    ),
  );
  // The calendar chip rides this class-local row (eventDate re-bound on
  // birthday, mirroring SYSTEM_EXTRA_CLASS_BINDINGS) — absent means no chip.
  if (!bound.has(SYSTEM_PROPERTY_UUIDS.eventDate)) return false;
  const parents = await surface.getClassParents(BIRTHDAY_CLASS_ID);
  return parents.includes(EVENT_CLASS_ID);
}

/**
 * Author the event root + the birthday subclass (node, person-typed schema,
 * the eventDate binding row, the extends edge) when missing; idempotent no-op
 * once present, with the same dropped-edge re-heal as the meeting ensure. The
 * date value itself resolves through the extends chain at read time — this
 * ensure never authors a birthdayDate schema.
 */
export async function ensureBirthdayFamily(surface: MeetingFamilySurface): Promise<void> {
  if (await birthdayFamilyPresent(surface)) return;
  await ensureEventRoot(surface);
  if ((await surface.getNodeRaw(BIRTHDAY_CLASS_ID)) === undefined) {
    await surface.createClass(SYSTEM_CLASS_DISPLAY_NAMES.birthday, {
      id: BIRTHDAY_CLASS_ID,
      icon: SYSTEM_CLASS_ICONS.birthday,
    });
  }
  await ensureFamilySchemas(surface, BIRTHDAY_CLASS_ID, BIRTHDAY_FAMILY);
  // The chip-eligibility row: eventDate re-bound on birthday, sequence 0
  // exactly as the server seed emits it (SYSTEM_EXTRA_CLASS_BINDINGS).
  const bound = new Set(
    (await surface.getClassBindings(BIRTHDAY_CLASS_ID)).map(
      (binding) => binding.propertySchemaId,
    ),
  );
  if (!bound.has(SYSTEM_PROPERTY_UUIDS.eventDate)) {
    await surface.setClassProperty(BIRTHDAY_CLASS_ID, SYSTEM_PROPERTY_UUIDS.eventDate, {
      sequence: 0,
    });
  }
  const parents = await surface.getClassParents(BIRTHDAY_CLASS_ID);
  if (!parents.includes(EVENT_CLASS_ID)) {
    await surface.setClassExtends(BIRTHDAY_CLASS_ID, [EVENT_CLASS_ID]);
  }
}
