/**
 * dayReviewedProperty — the §34.28 #15 "reviewed" state on day pages.
 * No protocol change: a plain boolean property schema bound to the day
 * system class, authored idempotently at a fixed id (the same self-heal
 * pattern as the task family — fresh/offline workspaces never got the row).
 * The calendar reads it for the reviewed day-cell tint; the day-page date
 * bar is the write surface.
 *
 * The id continues the general system-property sequence
 * (…0000-0000000027 is generatedFrom); §34.28 consolidation may promote it
 * into @notees/domain seeds alongside the other fixed ids — the wire needs
 * nothing new either way (a property schema is ordinary workspace data).
 */

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

export const DAY_REVIEWED_PROPERTY_UUID = "00000000-0000-0000-0000-000000000028";

export const DAY_REVIEWED_PROPERTY_NAME = "Reviewed";

/** The effective reviewed flag of a day page (absent = false). */
export function dayReviewedOf(client: AnyClient, dayId: string): boolean {
  const prop = client
    .getEffectiveProperties(dayId)
    .find((entry) => entry.propertySchemaId === DAY_REVIEWED_PROPERTY_UUID);
  return prop?.value === true;
}

/**
 * Author the boolean schema + day-class binding when missing; a no-op once
 * present (idempotent — safe to call on every calendar/day-page open). The
 * binding carries hideWhenEmpty so the properties panel stays quiet until a
 * day is actually reviewed — the date bar is the primary surface.
 */
export async function ensureDayReviewedProperty(client: AnyClient): Promise<void> {
  if (client.listPropertySchemas().some((schema) => schema.id === DAY_REVIEWED_PROPERTY_UUID)) {
    return;
  }
  // The day class NODE is expected from the server seed; a workspace that
  // never got one (offline-first devices) self-heals it like the task
  // family — without the node, getClassBindings can't see the binding.
  if (client.getNodeRaw(SYSTEM_CLASS_UUIDS.day) === undefined) {
    await client.createClass("day", { id: SYSTEM_CLASS_UUIDS.day });
  }
  await client.createPropertySchema({
    id: DAY_REVIEWED_PROPERTY_UUID,
    name: DAY_REVIEWED_PROPERTY_NAME,
    type: "boolean",
    scope: "class",
  });
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.day, DAY_REVIEWED_PROPERTY_UUID, {
    sequence: client.getClassBindings(SYSTEM_CLASS_UUIDS.day).length,
    hideWhenEmpty: true,
  });
}

/** Write the reviewed flag (the date bar's toggle). */
export async function setDayReviewed(
  client: AnyClient,
  dayId: string,
  reviewed: boolean,
): Promise<void> {
  await client.setProperty(dayId, DAY_REVIEWED_PROPERTY_UUID, reviewed, 0);
}
