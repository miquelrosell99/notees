/**
 * Task family authoring — the designed fix. The six task property schemas
 * (fixed UUIDs + canonical options in @notees/domain seeds) exist as
 * constants + migration mappings only: nothing authored them, so a
 * fresh workspace's tasks hub silently dropped the Scheduled/Deadline
 * columns and no surface could schedule a task. The register's sanctioned
 * fix: author the six schemas idempotently on first tasks-hub open (and,
 * per the Calendar day view, on first calendar open).
 *
 * ensureTaskFamily authors the six property schemas at their reserved ids
 * (the propertySchema.create upsert is a no-op when the row exists) plus the
 * task-class bindings when missing, and is a complete no-op once present.
 * Safe under both WorkspaceClient and WorkerClient — it composes only the
 * shared write surface (createPropertySchema / setClassProperty /
 * updatePropertySchema) and sync reads (listPropertySchemas /
 * getClassBindings), all RPC-mirrored.
 *
 * The status/priority option ids are the deterministic
 * TASK_STATUS/PRIORITY_OPTION_UUIDS (the applier-side seed-ensure authors
 * the same fixed ids, so either seed path converges to identical rows), the
 * status options carry the designed circle icons + preset colors, and a
 * restyle pass upgrades workspaces whose family was authored before the
 * styles existed (styleTaskStatusOptions preserves stored ids and leaves
 * user-renamed/added options untouched; null once converged — the common
 * case is a pure read, no write).
 */

import {
  styleTaskStatusOptions,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_PRIORITY_OPTIONS,
  TASK_PRIORITY_OPTION_UUIDS,
  TASK_STATUS_OPTIONS,
  TASK_STATUS_OPTION_UUIDS,
} from "@notees/domain";

import type { ClientPropertySchema, WorkspaceClient } from "@/core/workspace-client.js";

/** The composed write/read surface both full clients (and the outliner
 *  context's `OutlinerClient & OutlinerReader`, which the full client
 *  satisfies) implement — RPC-mirrored, so the structural pick is safe. */
export type TaskFamilyClient = Pick<
  WorkspaceClient,
  | "listPropertySchemas"
  | "getClassBindings"
  | "getNodeRaw"
  | "createClass"
  | "createPropertySchema"
  | "setClassProperty"
  | "updatePropertySchema"
>;

/** Deterministic status option ids, keyed by the designed option name (the
 *  applier-side seed-ensure authors the same fixed ids — INSERT-or-ignore
 *  first-writer-wins converges both seed paths to identical rows). */
const TASK_STATUS_OPTION_IDS: Record<(typeof TASK_STATUS_OPTIONS)[number]["name"], string> = {
  Backlog: TASK_STATUS_OPTION_UUIDS.backlog,
  Pending: TASK_STATUS_OPTION_UUIDS.pending,
  Doing: TASK_STATUS_OPTION_UUIDS.doing,
  Reviewing: TASK_STATUS_OPTION_UUIDS.reviewing,
  Done: TASK_STATUS_OPTION_UUIDS.done,
  Cancelled: TASK_STATUS_OPTION_UUIDS.cancelled,
};

const TASK_PRIORITY_OPTION_IDS: Record<(typeof TASK_PRIORITY_OPTIONS)[number], string> = {
  Low: TASK_PRIORITY_OPTION_UUIDS.low,
  Medium: TASK_PRIORITY_OPTION_UUIDS.medium,
  High: TASK_PRIORITY_OPTION_UUIDS.high,
  Urgent: TASK_PRIORITY_OPTION_UUIDS.urgent,
};

/** The six schemas in task-panel display order (sequence rides authoring order). */
const TASK_FAMILY: Array<{
  id: string;
  name: string;
  type: "select" | "date";
  options?: () => Array<{ id: string; label: string; icon?: string; color?: string }>;
}> = [
  {
    id: SYSTEM_PROPERTY_UUIDS.taskStatus,
    name: "Status",
    type: "select",
    options: () =>
      TASK_STATUS_OPTIONS.map((option) => ({
        id: TASK_STATUS_OPTION_IDS[option.name],
        label: option.name,
        icon: option.icon,
        color: option.color,
      })),
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
      TASK_PRIORITY_OPTIONS.map((label) => ({ id: TASK_PRIORITY_OPTION_IDS[label], label })),
  },
  {
    id: SYSTEM_PROPERTY_UUIDS.taskClosedDate,
    name: "Closed",
    type: "date",
  },
  {
    // The migration imported recurrence as a plain select (no engine executes it);
    // authored optionless until the recurrence spec lands.
    id: SYSTEM_PROPERTY_UUIDS.taskRecurrence,
    name: "Recurrence",
    type: "select",
    options: () => [],
  },
];

/** True when every task schema is present and bound to the task class. */
export function taskFamilyPresent(
  client: Pick<TaskFamilyClient, "listPropertySchemas" | "getClassBindings">,
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
 * a no-op when present (idempotent — safe to call on every open). Also runs
 * the status-restyle upgrade on every call (itself a no-op once the
 * stored options carry the designed icons/colors).
 *
 * The task class NODE is expected from the server seed; a workspace that
 * never got one (offline-first devices) self-heals it here at the reserved
 * id — without the node, getClassBindings can't see the binding rows and
 * every open would re-author them (op-log noise). Server-seeded workspaces
 * skip the branch (idempotent re-create converges anyway).
 */
export async function ensureTaskFamily(client: TaskFamilyClient): Promise<void> {
  if (!taskFamilyPresent(client)) {
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
  // Upgrade pass: restyle the status options with the designed
  // circle icons/colors (stored ids preserved — authored values reference
  // them) and move the value display to the property schema (render
  // contracts are property-level — "bullet" = the status rides
  // the block bullet). ONE updatePropertySchema carries both keys when
  // either needs writing; runs on every call, a read-only no-op once
  // converged.
  const status = client
    .listPropertySchemas()
    .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);
  if (status !== undefined) {
    const restyled = status.options != null ? styleTaskStatusOptions(status.options) : null;
    const display = status.display ?? null;
    const patch: Parameters<TaskFamilyClient["updatePropertySchema"]>[1] = {};
    if (restyled !== null) patch.options = restyled;
    if (display === null || display === "panel") patch.display = "bullet";
    if (Object.keys(patch).length > 0) {
      await client.updatePropertySchema(status.id, patch);
    }
  }
}
