/**
 * task-closed-sync — the taskStatus ↔ taskClosedDate write-time invariant.
 * The op log carries no trigger machinery (semantic state only — device-side
 * automation is never an op), so the invariant is authored by the client's
 * write seam: EVERY taskStatus property write/unset/empty funnels through the
 * WorkspaceClient facade (taskCycle, setTaskDone, the bullet picker, panel,
 * table cells, cards board, quick-create, workflows), which stamps — or
 * clears — the family's `Closed` datetime in the SAME undo-journal batch as
 * the status write (one undo reverts both).
 *
 * The invariant: a task's Closed value is set exactly when its Status rides
 * a closed option (Done/Cancelled — TASK_CLOSED_STATUSES), stamped with the
 * local day + wall-clock time of the transition; leaving the closed set
 * (reopen, unset, "not a task") clears it. One timestamp covers both closed
 * states — the Status value says which; this is the seeded taskClosedDate
 * ("Closed", …0003-…0005) finally auto-maintained, not a new property.
 *
 * Guards (never fail loud, always honest no-ops): the family schemas are
 * absent (Closed schema missing — nothing to write against), the written
 * value is not a stored option id (a schema-less/foreign write — no label,
 * no closedness to derive), and a rewrite of the SAME closed option (no
 * transition — the original stamp is kept, never bumped).
 */

import { SYSTEM_PROPERTY_UUIDS, TASK_CLOSED_STATUSES } from "@notees/domain";

import type { WorkspaceClientReadsProps } from "./client-reads-props.js";
import type { WorkspaceClientDates } from "./client-dates.js";
import type { WorkspaceClientWrites } from "./client-writes.js";

export interface TaskClosedSyncDeps {
  props: Pick<WorkspaceClientReadsProps, "listPropertySchemas" | "getPropertyRowShells">;
  dates: Pick<WorkspaceClientDates, "setDatetimeProperty">;
  writes: Pick<WorkspaceClientWrites, "unsetProperty">;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The local ISO day + wall-clock stamp of a transition (`at` is injectable
 *  for the specs — the default is the real now). */
export function localStampOf(at: Date): { iso: string; time: string } {
  return {
    iso: `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`,
    time: `${pad2(at.getHours())}:${pad2(at.getMinutes())}`,
  };
}

/**
 * Reconcile `Closed` after a taskStatus write. `statusValue` is the written
 * option id, or null for the unset/empty arms (the row is gone — the task
 * left whatever status it had); `priorStatusValue` is the row's value
 * captured BEFORE the status write applied — the only honest transition
 * test, since a post-write read always equals the written value. Runs AFTER
 * the status write applied, so the Closed row shells read fresh. Returns
 * true when a compensating Closed write was authored.
 */
export async function syncTaskClosedDate(
  deps: TaskClosedSyncDeps,
  objectId: string,
  statusValue: unknown,
  priorStatusValue: unknown,
  at: Date = new Date(),
): Promise<boolean> {
  const schemas = deps.props.listPropertySchemas();
  const statusSchema = schemas.find((s) => s.id === SYSTEM_PROPERTY_UUIDS.taskStatus);
  const closedSchema = schemas.find((s) => s.id === SYSTEM_PROPERTY_UUIDS.taskClosedDate);
  if (statusSchema === undefined || closedSchema === undefined) return false;

  let enteringClosed: boolean;
  if (typeof statusValue === "string") {
    const label = statusSchema.options?.find((option) => option.id === statusValue)?.label;
    if (label === undefined) return false; // not a stored option — no closedness to derive
    enteringClosed = TASK_CLOSED_STATUSES.has(label);
  } else {
    enteringClosed = false; // unset/empty — the status row is gone
  }

  const shells = deps.props.getPropertyRowShells(objectId);
  const closedRow = shells.find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskClosedDate);

  if (enteringClosed) {
    // A rewrite of the SAME closed option is not a transition — keep the
    // original stamp. (A drifted row — closed status, missing Closed —
    // stamps now: the heal arm.)
    if (priorStatusValue === statusValue && closedRow?.value != null) return false;
    const { iso, time } = localStampOf(at);
    await deps.dates.setDatetimeProperty(
      objectId,
      SYSTEM_PROPERTY_UUIDS.taskClosedDate,
      { iso, time },
      closedRow?.idx ?? 0,
    );
    return true;
  }

  if (closedRow?.value == null) return false;
  await deps.writes.unsetProperty(objectId, SYSTEM_PROPERTY_UUIDS.taskClosedDate, closedRow.idx ?? 0);
  return true;
}
