/**
 * taskCycle — the Cmd/Ctrl+Enter task-state toggle
 * (useTaskActions parity): a Roam/Logseq-style three-state cycle
 *
 *   not a task  ->  task + Pending  ->  task + Done  ->  not a task
 *
 * bound to the chord in BlockTextEditor (the mod+Enter branch). The class and
 * the status property are kept in sync on every transition, mirroring the
 * `/checkbox` slash command: a block is never left with a status but no
 * class, or a class but a dead status pointer.
 *
 * Write paths are the canonical client surface: `assignClass`/`unassignClass`
 * (OR-set membership), `setProperty`/`unsetProperty` (the status option id at
 * the status row's EXISTING idx — never the designed option UUIDs, old
 * workspaces carry random option ids; cycle by option label resolved against
 * the live schema's stored options), and `ensureTaskFamily` before the first
 * status write (fresh/offline workspaces self-heal the family; a no-op once
 * converged). The task class id prefers a live class named "task" over the
 * designed seed id — the `/checkbox` precedent.
 *
 * Read-only is structural: BlockTextEditor only mounts on editable rows, so
 * the chord (and this helper) is unreachable in read-only projections.
 */

import {
  deriveDisplayName,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  TASK_DEFAULT_STATUS,
} from "@notees/domain";

import type { WorkspaceClient } from "@/core/workspace-client.js";

import { ensureTaskFamily, type TaskFamilyClient } from "./taskFamily.js";

/** The cycle's composed client surface: the family ensure plus the direct
 *  reads/writes. Structural pick — satisfied by WorkspaceClient,
 *  WorkerClient, and the outliner context's `OutlinerClient & OutlinerReader`
 *  (the full client, which is what the editor passes). */
type CycleClient = TaskFamilyClient &
  Pick<
    WorkspaceClient,
    | "listClasses"
    | "getNode"
    | "getEffectiveProperties"
    | "assignClass"
    | "unassignClass"
    | "setProperty"
    | "unsetProperty"
  >;

/** Resolve a status option by its live label; undefined when the schema
 *  doesn't carry one (renamed/optionless workspaces — an honest no-op, never
 *  a designed-UUID write). */
function optionByLabel(
  options: Array<{ id: string; label: string }>,
  label: string,
): { id: string; label: string } | undefined {
  return options.find((option) => option.label === label);
}

export async function cycleTaskState(client: CycleClient, id: string): Promise<void> {
  // Title-is-content: a class's name lives in its content, so the live-class
  // lookup compares the DERIVED display name (the `cls.name` convenience
  // column is null on class nodes — the /checkbox command's
  // `cls.name === "task"` probe can never match and always falls back).
  const taskClassId =
    client.listClasses().find((cls) => deriveDisplayName(cls) === "task")?.id ??
    SYSTEM_CLASS_UUIDS.task;
  const node = client.getNode(id) ?? client.getNodeRaw(id);
  if (node === undefined) return;

  const statusSchemaId = SYSTEM_PROPERTY_UUIDS.taskStatus;

  // The status row's existing idx is the write address (a multi-value row
  // lands at idx > 0 — the bullet picker writes idx 0 for its own single-row
  // case; the cycle preserves whatever row the value lives at).
  const statusRowOf = () =>
    client
      .getEffectiveProperties(id)
      .find((row) => row.propertySchemaId === statusSchemaId);

  // Re-read the schema at write time: ensureTaskFamily may have just authored
  // it (fresh workspace), and option sets are workspace data that can change
  // between presses.
  const writeStatus = async (label: string): Promise<void> => {
    const schema = client.listPropertySchemas().find((s) => s.id === statusSchemaId);
    const options = schema?.options ?? [];
    let option = optionByLabel(options, label);
    if (option === undefined && label === TASK_DEFAULT_STATUS) {
      // The "first non-Backlog option" rule: a workspace that renamed Pending
      // still cycles to its second status; only a bare Backlog-only schema
      // declines.
      option = options.find((candidate) => candidate.label !== "Backlog");
    }
    if (option === undefined) {
      console.warn(`[taskCycle] no "${label}" option on the status schema — no-op`);
      return;
    }
    await client.setProperty(id, statusSchemaId, option.id, statusRowOf()?.idx ?? 0);
  };

  if (!node.classIds.includes(taskClassId)) {
    // not a task -> task + Pending: author the family (no-op once present),
    // then class + status like `/checkbox` does.
    await ensureTaskFamily(client);
    await client.assignClass(id, taskClassId);
    await writeStatus(TASK_DEFAULT_STATUS);
    return;
  }

  const row = statusRowOf();
  const options = client.listPropertySchemas().find((s) => s.id === statusSchemaId)?.options ?? [];
  const statusLabel =
    row !== undefined && typeof row.value === "string"
      ? (options.find((option) => option.id === row.value)?.label ?? null)
      : null;

  if (statusLabel !== null && TASK_CLOSED_STATUSES.has(statusLabel)) {
    // task + a closed status (Done/Cancelled) -> not a task: unset the status
    // at its row idx and drop the class (the clearTask pair).
    await client.unsetProperty(id, statusSchemaId, row?.idx ?? 0);
    await client.unassignClass(id, taskClassId);
    return;
  }

  // task + any live open status, or none -> Done.
  await ensureTaskFamily(client);
  await writeStatus("Done");
}
