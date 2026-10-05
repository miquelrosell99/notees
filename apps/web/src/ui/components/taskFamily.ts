/**
 * Task family authoring — the §34.28 #2 fix. The six task property schemas
 * (fixed UUIDs + canonical options in @notees/domain seeds) exist as
 * constants + v1-migration mappings only: nothing in v2 authored them, so a
 * fresh workspace's tasks hub silently dropped the Scheduled/Deadline
 * columns and no surface could schedule a task. The register's sanctioned
 * fix: author the six schemas idempotently on first tasks-hub open (and,
 * per the Calendar day view, on first calendar open).
 *
 * ensureTaskFamily authors the six property schemas at their reserved ids
 * (the propertySchema.create upsert is a no-op when the row exists) plus the
 * task-class bindings when missing, and is a complete no-op once present.
 * Safe under both WorkspaceClient and WorkerClient — it composes only the
 * shared write surface (createPropertySchema / setClassProperty) and sync
 * reads (listPropertySchemas / getClassBindings), all RPC-mirrored.
 */

import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_PRIORITY_OPTIONS,
  TASK_STATUS_OPTIONS,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientPropertySchema, WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** The six schemas in task-panel display order (sequence rides authoring order). */
const TASK_FAMILY: Array<{
  id: string;
  name: string;
  type: "select" | "date";
  options?: () => Array<{ id: string; label: string }>;
}> = [
  {
    id: SYSTEM_PROPERTY_UUIDS.taskStatus,
    name: "Status",
    type: "select",
    options: () =>
      TASK_STATUS_OPTIONS.map((option) => ({ id: crypto.randomUUID(), label: option.name })),
  },
  {
    id: SYSTEM_PROPERTY_UUIDS.taskScheduled,
    name: "Scheduled",
    type: "date",
  },
  {
    id: SYSTEM_PROPERTY_UUIDS.taskDeadline,
    name: "Deadline",
    type: "date",
  },
  {
    id: SYSTEM_PROPERTY_UUIDS.taskPriority,
    name: "Priority",
    type: "select",
    options: () =>
      TASK_PRIORITY_OPTIONS.map((label) => ({ id: crypto.randomUUID(), label })),
  },
  {
    id: SYSTEM_PROPERTY_UUIDS.taskClosedDate,
    name: "Closed",
    type: "date",
  },
  {
    // v1 migrated recurrence as a plain select (no engine executes it — §34.28 #6);
    // authored optionless until the recurrence spec lands.
    id: SYSTEM_PROPERTY_UUIDS.taskRecurrence,
    name: "Recurrence",
    type: "select",
    options: () => [],
  },
];

/** True when every task schema is present and bound to the task class. */
export function taskFamilyPresent(
  client: Pick<AnyClient, "listPropertySchemas" | "getClassBindings">,
): boolean {
  const schemas = client.listPropertySchemas();
  const have = new Set<string>(schemas.map((schema: ClientPropertySchema) => schema.id));
  const bound = new Set(
    client.getClassBindings(SYSTEM_CLASS_UUIDS.task).map((binding) => binding.propertySchemaId),
  );
  return TASK_FAMILY.every((spec) => have.has(spec.id) && bound.has(spec.id));
}

/**
 * Author the six task property schemas + task-class bindings when missing;
 * a no-op when present (idempotent — safe to call on every open).
 *
 * The task class NODE is expected from the server seed; a workspace that
 * never got one (offline-first devices) self-heals it here at the reserved
 * id — without the node, getClassBindings can't see the binding rows and
 * every open would re-author them (op-log noise). Server-seeded workspaces
 * skip the branch (idempotent re-create converges anyway).
 */
export async function ensureTaskFamily(client: AnyClient): Promise<void> {
  if (taskFamilyPresent(client)) return;
  if (client.getNodeRaw(SYSTEM_CLASS_UUIDS.task) === undefined) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES.task, {
      id: SYSTEM_CLASS_UUIDS.task,
      icon: "mdiCheckboxMarkedCircleOutline",
    });
  }
  const have = new Set(client.listPropertySchemas().map((schema) => schema.id));
  for (const spec of TASK_FAMILY) {
    if (!have.has(spec.id)) {
      const options = spec.options?.();
      await client.createPropertySchema({
        id: spec.id,
        name: spec.name,
        type: spec.type,
        scope: "class",
        ...(options !== undefined ? { options } : {}),
      });
    }
  }
  const bound = new Set(
    client.getClassBindings(SYSTEM_CLASS_UUIDS.task).map((binding) => binding.propertySchemaId),
  );
  // Sequences run after any existing rows' authored values; the read model
  // sorts by (sequence, schema id), so ties order deterministically.
  let sequence = client.getClassBindings(SYSTEM_CLASS_UUIDS.task).length;
  for (const spec of TASK_FAMILY) {
    if (bound.has(spec.id)) continue;
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.task, spec.id, { sequence: sequence++ });
  }
}
