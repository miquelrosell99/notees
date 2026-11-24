/**
 * TaskReview — the unreviewed-days queue: every PAST day that still carries
 * open work, oldest first, grouped by the day the work was driving toward
 * (groupSlippedTasksByDay — the buckets' exact driving-day rule; recurring
 * tasks never list, a missed occurrence rolls forward). The queue is fully
 * derived: a day leaves it the moment its open tasks are closed or
 * rescheduled out of the past — no stored "reviewed" bit anywhere (device
 * state is never an op, and the model needs no cross-device review marker).
 *
 * Gestures: the checkbox is the hub's exact done write; the day header opens
 * the day page (the chain is ensured first — an imported/CLI-authored value
 * may reference a day node that was never materialized); **Push to today**
 * reschedules the day's SCHEDULED-driven tasks to today as ONE undo entry
 * (applyOps) — a deadline is a commitment, so deadline-driven rows are never
 * bulk-pushed (rescheduling one is a per-task decision on the task itself).
 *
 * Renders as the tasks hub's registered "review" collection view
 * (reviewView.ts): the ids ride the collection's item set, so the hub's
 * transient filter narrows the queue like every other mode.
 */

import { useEffect, useMemo } from "react";

import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { ClientWriteOp } from "@/core/workspace-client/index.js";

import type { AnyClient } from "../../ui/app/Sidebar.js";

import { titleOf } from "../../ui/dateDisplay.js";
import { Icon } from "../../ui/Icon.js";
import {
  dayNodeId,
  groupSlippedTasksByDay,
  todayIsoLocal,
  type SlippedDayGroup,
} from "../calendar/calendarViewUtils.js";
import { setTaskDone, postponeTaskToTomorrow, taskPostponeTargetOf, taskRowsOf, taskStatusLabel } from "../calendar/calendarRows.js";
import { ensureTaskFamily } from "./taskFamily.js";
import { Checkbox } from "../../components/ui/kit/Checkbox.js";
import { ListRow } from "../../components/ui/kit/index.js";
import { Pill } from "../../components/ui/kit/Pill.js";
import { useClientVersion } from "../../components/ui/kit/useClientVersion.js";
import "./TaskReview.css";

export function TaskReview({
  client,
  ids,
  onOpenNode,
}: {
  client: AnyClient;
  /** The collection's item ids (the hub's filtered set) to review. */
  ids: readonly string[];
  onOpenNode: (nodeId: string) => void;
}) {
  const version = useClientVersion(client);

  // Family ensure: idempotent no-op once the six schemas + bindings exist.
  useEffect(() => {
    void ensureTaskFamily(client).catch(() => {});
  }, [client]);

  const statusSchema = client
    .listPropertySchemas()
    .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);

  const groups = useMemo<SlippedDayGroup[]>(() => {
    const rows = taskRowsOf(client, statusSchema, ids);
    return groupSlippedTasksByDay(rows, todayIsoLocal());
    // statusSchema's options feed the closed flags — re-resolve per notify.
  }, [client, ids, statusSchema, version]);

  if (groups.length === 0) {
    return (
      <p className="task-review__empty">
        Nothing to review — no past day is still carrying open tasks.
      </p>
    );
  }

  const statusLabelOf = (id: string): string | null =>
    taskStatusLabel(
      statusSchema,
      client
        .getPropertyRowShells(id)
        .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value,
    );

  const openDay = (dayIso: string) => {
    // Ensure the chain first: a value authored off-app (CLI, import) may
    // reference a day node that was never materialized.
    void client
      .ensureDateChain(dayIso)
      .then(({ day }) => onOpenNode(day))
      .catch(() => {});
  };

  const pushToToday = (group: SlippedDayGroup) => {
    const todayIso = todayIsoLocal();
    // Scheduled-driven rows only — a passed DEADLINE is never bulk-rewritten.
    const pushable = group.rows.filter(
      (row) => row.scheduledIso !== null && row.scheduledIso < todayIso,
    );
    if (pushable.length === 0) return;
    void (async () => {
      await client.ensureDateChain(todayIso);
      const todayId = dayNodeId(todayIso);
      const ops: ClientWriteOp[] = pushable.map((row) => {
        const scheduledRow = client
          .getPropertyRowShells(row.id)
          .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled);
        return {
          kind: "setProperty",
          objectId: row.id,
          propertySchemaId: SYSTEM_PROPERTY_UUIDS.taskScheduled,
          value: { nodeId: todayId },
          idx: scheduledRow?.idx ?? 0,
        };
      });
      await client.applyOps(ops, { verb: "Push to today" });
    })().catch(() => {});
  };

  return (
    <section className="task-review" aria-label="Task review">
      {groups.map((group) => {
        const pushable = group.rows.some(
          (row) => row.scheduledIso !== null && row.scheduledIso < todayIsoLocal(),
        );
        return (
          <div key={group.dayIso} className="task-review__group">
            <div className="task-review__group-header">
              <button
                type="button"
                className="task-review__day"
                onClick={() => openDay(group.dayIso)}
              >
                {group.dayIso}
              </button>
              <span className="task-review__group-count">{group.rows.length}</span>
              {pushable && (
                <button
                  type="button"
                  className="task-review__push"
                  onClick={() => pushToToday(group)}
                >
                  <Icon path="mdi-calendar-arrow-right" size={0.9} />
                  Push to today
                </button>
              )}
            </div>
            <ul className="task-review__rows">
              {group.rows.map((row) => (
                <ListRow
                  key={row.id}
                  className="task-review__row"
                  leading={
                    <Checkbox
                      size="sm"
                      checked={row.closed}
                      disabled={statusSchema === undefined}
                      aria-label={row.closed ? "Reopen task" : "Mark task done"}
                      onChange={(checked) =>
                        void setTaskDone(client, statusSchema, row.id, checked)
                      }
                    />
                  }
                  primary={
                    <button
                      type="button"
                      className="task-review__row-name"
                      onClick={() => onOpenNode(row.id)}
                    >
                      {titleOf(client, row.id, { read: "fallback", empty: "untitled" }) ?? "Untitled"}
                    </button>
                  }
                  trailing={
                    <>
                      {row.scheduledIso !== null &&
                        taskPostponeTargetOf(client, row.id) !== null && (
                          <button
                            type="button"
                            className="task-review__row-postpone"
                            title="Push to tomorrow"
                            aria-label="Push to tomorrow"
                            onClick={() => void postponeTaskToTomorrow(client, row.id)}
                          >
                            <Icon path="mdi-calendar-arrow-right" size={0.9} />
                          </button>
                        )}
                      {row.priority !== null && (
                        <Pill
                          text={row.priority}
                          className={`task-review__row-priority task-review__row-priority--${row.priority.toLowerCase()}`}
                        />
                      )}
                      {statusSchema !== undefined && statusLabelOf(row.id) !== null && (
                        <Pill text={statusLabelOf(row.id)!} />
                      )}
                    </>
                  }
                />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
