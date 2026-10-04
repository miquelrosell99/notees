/**
 * Meeting family — §34.36 (owner ruling 2026-10-04: PLAIN SEEDS, zero wire
 * cost — seed convergence only, no lockstep). The `meeting` system class
 * (fixed UUID + icon in @notees/domain seeds) plus its property family
 * (meetingDate — date-typed per the §34.28 whole-day law: NO clock times; text
 * location/agenda per the section's family list) is plain seed vocabulary:
 * NEW workspaces receive the class node + schemas + bindings from the server
 * seed, and every replica converges by id — the op set is untouched.
 *
 * Declaration-first (owner ruling): nothing calls ensureMeetingFamily
 * automatically — configure now, wire later. The calendar quick-create needs
 * no code change: dateChipCandidates qualifies ANY class with a date-typed
 * binding (calendarViewUtils), so the meeting chip appears on its own once
 * the family exists in a workspace (server seed for new ones, an ensure call
 * for the rest). scripts/remap-reunion-evento.mts ensures the family across
 * the objects API before assigning the live workspace's reunión/evento
 * members.
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
  createClass(name: string, opts?: { icon?: string; color?: string; id?: string }): Promise<string>;
  createPropertySchema(input: CreatePropertySchemaInput): Promise<string>;
  setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): Promise<void>;
}

/** The meeting class id — the domain seed's fixed vocabulary. */
export const MEETING_CLASS_ID = SYSTEM_CLASS_UUIDS.meeting;

/**
 * The family in seed order (the binding sequence is the array index, exactly
 * what the server seed's per-class binding counter produces on a fresh
 * class). Schema names are the spec keys verbatim, so an offline-first
 * workspace that self-heals converges name-for-name with a server-seeded one
 * (the ensureCitationFamily precedent — ensureTaskFamily's display-name
 * divergence is deliberately not replicated).
 */
export const MEETING_FAMILY: ReadonlyArray<{ id: string; name: string; type: "date" | "text" }> = [
  { id: SYSTEM_PROPERTY_UUIDS.meetingDate, name: "meetingDate", type: "date" },
  { id: SYSTEM_PROPERTY_UUIDS.location, name: "location", type: "text" },
  { id: SYSTEM_PROPERTY_UUIDS.agenda, name: "agenda", type: "text" },
];

/** True when every family schema is present and bound to the meeting class. */
export async function meetingFamilyPresent(surface: MeetingFamilySurface): Promise<boolean> {
  const have = new Set((await surface.listPropertySchemas()).map((schema) => schema.id));
  const bound = new Set(
    (await surface.getClassBindings(MEETING_CLASS_ID)).map((binding) => binding.propertySchemaId),
  );
  return MEETING_FAMILY.every((spec) => have.has(spec.id) && bound.has(spec.id));
}

/**
 * Author the meeting class node + the three property schemas + bindings when
 * missing; a complete no-op once present (idempotent — safe to call on every
 * open). The class node is expected from the server seed; a workspace that
 * never got one (offline-first devices, or an existing workspace before the
 * remap script runs) self-heals it here at the reserved id — without the
 * node, getClassBindings can't see the binding rows and every call would
 * re-author them (op-log noise).
 */
export async function ensureMeetingFamily(surface: MeetingFamilySurface): Promise<void> {
  if (await meetingFamilyPresent(surface)) return;
  if ((await surface.getNodeRaw(MEETING_CLASS_ID)) === undefined) {
    await surface.createClass("meeting", { id: MEETING_CLASS_ID, icon: SYSTEM_CLASS_ICONS.meeting });
  }
  const have = new Set((await surface.listPropertySchemas()).map((schema) => schema.id));
  for (const spec of MEETING_FAMILY) {
    if (have.has(spec.id)) continue;
    await surface.createPropertySchema({
      id: spec.id,
      name: spec.name,
      type: spec.type,
      scope: "class",
    });
  }
  const bound = new Set(
    (await surface.getClassBindings(MEETING_CLASS_ID)).map((binding) => binding.propertySchemaId),
  );
  for (const [index, spec] of MEETING_FAMILY.entries()) {
    if (bound.has(spec.id)) continue;
    await surface.setClassProperty(MEETING_CLASS_ID, spec.id, { sequence: index });
  }
}
