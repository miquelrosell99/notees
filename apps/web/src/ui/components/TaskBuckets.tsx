/**
 * TaskBuckets — the §34.28 #5 bucketed tasks surface: Overdue / Today /
 * Upcoming / Unscheduled / Completed over the tasks-hub members (pages AND
 * blocks, the owner rule), computed client-side from the effective
 * scheduled/deadline/status values — the same derived reads the hub's table
 * renders from, so no query ever runs. A task's driving day is its earliest
 * scheduled/deadline day; the bucket priority Overdue → Today → Upcoming
 * keeps every open task in exactly one bucket and Completed holds the whole
 * closed set (the register's "computed from taskScheduled/taskDeadline +
 * closed state"). Renders as a hub section above the tasks collection; the
 * collapse flag is device-local (never an op).
 */

import { useEffect, useMemo, useState } from "react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { AnyClient } from "./Sidebar.js";

import { displayNameFromClient } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { partitionTasksIntoBuckets, todayIsoLocal, type TaskBuckets as Buckets } from "./calendarViewUtils.js";
import { setTaskDone, taskRowsOf, taskStatusLabel } from "./calendarRows.js";
import { ensureTaskFamily } from "./taskFamily.js";
import { useDeviceSetting } from "./modals/deviceSettings.js";
import { Checkbox } from "./ui/Checkbox.js";
import { Pill } from "./ui/Pill.js";
import "./TaskBuckets.css";

const BUCKET_ORDER: Array<{
  key: keyof Buckets;
  label: string;
  /** Day chip: the driving day, for the date-scoped buckets. */
  showDay: boolean;
  overdueStyle?: boolean;
}> = [
  { key: "overdue", label: "Overdue", showDay: true, overdueStyle: true },
  { key: "today", label: "Today", showDay: false },
  { key: "upcoming", label: "Upcoming", showDay: true },
  { key: "unscheduled", label: "Unscheduled", showDay: false },
  { key: "completed", label: "Completed", showDay: false },
];

export function TaskBuckets({
  client,
  onOpenNode,
}: {
  client: AnyClient;
  onOpenNode: (nodeId: string) => void;
}) {
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // §34.28 #2 — idempotent no-op once the six schemas + bindings exist.
  useEffect(() => {
    void ensureTaskFamily(client);
  }, [client]);

  const [collapsed, setCollapsed] = useDeviceSetting("tasksHubBucketsCollapsed", false);

  const statusSchema = client
    .listPropertySchemas()
    .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);

  const buckets = useMemo<Buckets>(() => {
    const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.task);
    const rows = taskRowsOf(
      client,
      statusSchema,
      members.map((member) => member.id),
    );
    return partitionTasksIntoBuckets(rows, todayIsoLocal());
    // statusSchema's options feed the closed flags — re-resolve per notify.
  }, [client, statusSchema, version]);

  const total =
    buckets.overdue.length +
    buckets.today.length +
    buckets.upcoming.length +
    buckets.unscheduled.length +
    buckets.completed.length;
  // Nothing to bucket: the hub collection's own empty state covers it.
  if (total === 0) return null;
  const openCount = total - buckets.completed.length;

  const statusLabelOf = (id: string): string | null =>
    taskStatusLabel(
      statusSchema,
      client
        .getEffectiveProperties(id)
        .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value,
    );

  return (
    <section className="task-buckets" aria-label="Task buckets">
      <button
        type="button"
        className="task-buckets__header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <Icon
          path={collapsed ? "mdi-chevron-right" : "mdi-chevron-down"}
          size={0.9}
          className="task-buckets__chevron"
        />
        <span className="task-buckets__title">Buckets</span>
        <span className="task-buckets__count">{openCount} open</span>
      </button>
      {!collapsed &&
        BUCKET_ORDER.map(({ key, label, showDay, overdueStyle }) => {
          const rows = buckets[key];
          if (rows.length === 0) return null;
          return (
            <div key={key} className="task-buckets__group">
              <h3
                className={`task-buckets__group-title${
                  overdueStyle === true ? " task-buckets__group-title--overdue" : ""
                }`}
              >
                {label}
                <span className="task-buckets__group-count">{rows.length}</span>
              </h3>
              <ul className="task-buckets__rows">
                {rows.map((row) => (
                  <li key={row.id} className="task-buckets__row">
                    <Checkbox
                      size="sm"
                      checked={row.closed}
                      disabled={statusSchema === undefined}
                      aria-label={row.closed ? "Reopen task" : "Mark task done"}
                      onChange={(event) =>
                        void setTaskDone(client, statusSchema, row.id, event.target.checked)
                      }
                    />
                    <button
                      type="button"
                      className="task-buckets__row-name"
                      onClick={() => onOpenNode(row.id)}
                    >
                      {displayNameFromClient(client, row.id) ?? row.id}
                    </button>
                    {statusSchema !== undefined && statusLabelOf(row.id) !== null && (
                      <Pill text={statusLabelOf(row.id)!} />
                    )}
                    {showDay && row.drivingIso !== null && (
                      <span className="task-buckets__row-day">{row.drivingIso}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
    </section>
  );
}
