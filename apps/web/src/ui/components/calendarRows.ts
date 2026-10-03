/**
 * calendarRows — the client-side row derivation behind every calendar/day
 * surface (the Calendar day view, the day-page sections, the tasks-hub
 * buckets). One implementation so the three never drift: task rows read the
 * effective scheduled/deadline/status values (sync on both client kinds —
 * WorkerClient mirrors them through its read cache), and the done-toggle is
 * the tasks hub's exact write (property.set of the status option id, never
 * a taskClosedDate). Dated rows are the day node's existing backlink set
 * minus date-chain sources and tasks (§34.28 #4a — zero model work).
 */

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  TASK_DEFAULT_STATUS,
  parseDateNodeId,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, ClientPropertySchema, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameFromClient } from "../dateDisplay.js";
import { scheduledIsoOf, type TaskBucketRow } from "./calendarViewUtils.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Resolve a taskStatus value (an option id) to its label; null when unset/unknown. */
export function taskStatusLabel(
  statusSchema: ClientPropertySchema | undefined,
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  return statusSchema?.options?.find((option) => option.id === value)?.label ?? value;
}

/** One task node's bucket facts: scheduled/deadline days + closed state. */
export function taskRowFacts(
  client: AnyClient,
  statusSchema: ClientPropertySchema | undefined,
  id: string,
): TaskBucketRow {
  const props = client.getEffectiveProperties(id);
  const scheduledIso = scheduledIsoOf(
    props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled)?.value,
  );
  const deadlineIso = scheduledIsoOf(
    props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskDeadline)?.value,
  );
  const statusLabel = taskStatusLabel(
    statusSchema,
    props.find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value,
  );
  return {
    id,
    scheduledIso,
    deadlineIso,
    drivingIso: null,
    closed: statusLabel !== null && TASK_CLOSED_STATUSES.has(statusLabel as "Done" | "Cancelled"),
  };
}

/** Bucket facts for every member of a list, in input order. */
export function taskRowsOf(
  client: AnyClient,
  statusSchema: ClientPropertySchema | undefined,
  ids: readonly string[],
): TaskBucketRow[] {
  return ids.map((id) => taskRowFacts(client, statusSchema, id));
}

/**
 * The done-toggle every task row shares: property.set of the Done/default
 * option id — exactly the tasks hub's write (§34.28 #4b note; no
 * taskClosedDate anywhere).
 */
export async function setTaskDone(
  client: AnyClient,
  statusSchema: ClientPropertySchema | undefined,
  id: string,
  done: boolean,
): Promise<void> {
  if (statusSchema === undefined || statusSchema.options === null) return;
  const targetLabel = done ? ("Done" as const) : TASK_DEFAULT_STATUS;
  const target = statusSchema.options.find((option) => option.label === targetLabel);
  if (target === undefined) return;
  const prop = client
    .getEffectiveProperties(id)
    .find((entry) => entry.propertySchemaId === statusSchema.id);
  await client.setProperty(id, statusSchema.id, target.id, prop?.idx ?? 0);
}

/**
 * The day node's dated-reference rows (§34.28 #4a): its existing backlink
 * set, deduped, minus date-chain sources (the month/year fan-in) and tasks
 * (their own section), sorted by display name. One materialized read — no
 * query.
 */
export function datedRowNodes(client: AnyClient, dayId: string): ClientNode[] {
  const seen = new Set<string>();
  const rows: ClientNode[] = [];
  for (const edge of client.getBacklinks(dayId)) {
    if (seen.has(edge.sourceId)) continue;
    seen.add(edge.sourceId);
    if (parseDateNodeId(edge.sourceId) !== null) continue;
    const node = client.getNode(edge.sourceId);
    if (node === undefined) continue;
    if (node.classIds.includes(SYSTEM_CLASS_UUIDS.task)) continue; // own section
    rows.push(node);
  }
  rows.sort(
    (a, b) =>
      (displayNameFromClient(client, a.id) ?? a.id).localeCompare(
        displayNameFromClient(client, b.id) ?? b.id,
      ) || a.id.localeCompare(b.id),
  );
  return rows;
}
