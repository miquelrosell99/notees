/**
 * Meeting/event family — §34.36 + the owner's reshape directive (2026-10-04:
 * PLAIN SEEDS, zero wire cost — seed convergence only, no lockstep).
 *
 * `event` is the CALENDAR family root: a date-only base class (its single
 * `eventDate` date binding is what makes a class calendar quick-create
 * eligible — any class with a date-typed binding per dateChipCandidates).
 * `meeting` IS-A event (SYSTEM_CLASS_EXTENDS): a meeting is an event with a
 * meeting-specific family on top (meetingDate — still whole-day per the
 * §34.28 law, no clock times — plus text location/agenda). Gating semantics
 * for the future Features tab (the tab is another wave's surface): disabling
 * `event` disables `meeting` WITH it; disabling `meeting` alone leaves
 * `event` live — `systemClassAncestors` in @notees/domain is the shared read.
 *
 * Both classes are fixed-UUID domain seeds: NEW workspaces receive the class
 * nodes + schemas + bindings + the extends edge from the server seed, and
 * every replica converges by id — the op set is untouched. Existing
 * workspaces materialize the family idempotently through
 * ensureMeetingFamily — the ensureTaskFamily precedent (it ensures the event
 * ROOT first: the meeting extends edge is unrepresentable without the event
 * class row).
 *
 * Declaration-first (owner ruling): nothing calls ensureMeetingFamily
 * automatically — configure now, wire later. The calendar quick-create needs
 * no code change: dateChipCandidates qualifies ANY class with a date-typed
 * binding, so BOTH the event and meeting chips appear on their own once the
 * family exists in a workspace (server seed for new ones, an ensure call for
 * the rest). scripts/remap-reunion-evento.mts ensures the family across the
 * objects API before assigning members (reunión → meeting, evento → event).
 *
 * The surface reads are MaybePromise so the same ensure runs over the sync
 * web clients (WorkspaceClient, WorkerClient — both satisfy the interface
 * structurally) and over the remap script's async HTTP adapter, no casts.
 * Type-only client imports keep the module runtime-import-free beyond
 * @notees/domain, so node-side consumers (the script under tsx) can import it.
 */

import { SYSTEM_CLASS_ICONS, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

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

/** The event root's minimal family: the date binding the calendar rides on. */
export const EVENT_FAMILY: ReadonlyArray<{ id: string; name: string; type: "date" }> = [
  { id: SYSTEM_PROPERTY_UUIDS.eventDate, name: "eventDate", type: "date" },
];

/**
 * The meeting family in seed order (the binding sequence is the array index,
 * exactly what the server seed's per-class binding counter produces on a
 * fresh class). Schema names are the spec keys verbatim, so an offline-first
 * workspace that self-heals converges name-for-name with a server-seeded one
 * (the ensureCitationFamily precedent — ensureTaskFamily's display-name
 * divergence is deliberately not replicated).
 */
export const MEETING_FAMILY: ReadonlyArray<{ id: string; name: string; type: "date" | "text" }> = [
  { id: SYSTEM_PROPERTY_UUIDS.meetingDate, name: "meetingDate", type: "date" },
  { id: SYSTEM_PROPERTY_UUIDS.location, name: "location", type: "text" },
  { id: SYSTEM_PROPERTY_UUIDS.agenda, name: "agenda", type: "text" },
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
  family: ReadonlyArray<{ id: string; name: string; type: "date" | "text" }>,
): Promise<void> {
  const have = new Set((await surface.listPropertySchemas()).map((schema) => schema.id));
  for (const spec of family) {
    if (have.has(spec.id)) continue;
    await surface.createPropertySchema({
      id: spec.id,
      name: spec.name,
      type: spec.type,
      scope: "class",
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
  if ((await surface.getNodeRaw(EVENT_CLASS_ID)) === undefined) {
    await surface.createClass("event", { id: EVENT_CLASS_ID, icon: SYSTEM_CLASS_ICONS.event });
  }
  await ensureFamilySchemas(surface, EVENT_CLASS_ID, EVENT_FAMILY);
  if ((await surface.getNodeRaw(MEETING_CLASS_ID)) === undefined) {
    await surface.createClass("meeting", { id: MEETING_CLASS_ID, icon: SYSTEM_CLASS_ICONS.meeting });
  }
  await ensureFamilySchemas(surface, MEETING_CLASS_ID, MEETING_FAMILY);
  const parents = await surface.getClassParents(MEETING_CLASS_ID);
  if (!parents.includes(EVENT_CLASS_ID)) {
    await surface.setClassExtends(MEETING_CLASS_ID, [EVENT_CLASS_ID]);
  }
}
