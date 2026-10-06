/**
 * DayPageSections — the §34.28 #4 day-page aggregations: a day page renders
 * (below its own content, ahead of the generic system sections) its tasks
 * (open, scheduled on or before the day — the Calendar day view's exact
 * partition, done-toggle included), its dated references (the day node's
 * materialized backlink set minus date-chain sources and tasks), and
 * everything created that day (the createdAt range query).
 *
 * Lazy per the SCHEMA.md system-sections contract, hidden when empty: the
 * Tasks partition and the Dated rows are cheap derived reads (the same
 * family the tasks hub renders from — no query runs), the Created count is
 * the one structured query and gates the section's existence (the
 * SystemSections unlinked-count precedent: a memoized count read decides
 * hide-when-empty while the collapsed section still loads nothing). Only
 * the Created query runs per notification; Tasks/Dated re-derive from the
 * client notification like every other derived read.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Section } from "../Section.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import {
  createdTodayBounds,
  partitionOpenTasks,
  type OpenTaskRow,
  type PartitionedTasks,
} from "./calendarViewUtils.js";
import {
  datedRowNodes,
  setTaskDone,
  taskRowsOf,
  taskStatusLabel,
} from "./calendarRows.js";
import { ensureTaskFamily } from "./taskFamily.js";
import { Checkbox } from "./ui/Checkbox.js";
import { CreatedSection } from "./CreatedSection.js";
import { Pill } from "./ui/Pill.js";
import "./DayPageSections.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Read-only class chips (the table view's idiom) on a section row. */
function RowClassChips({ client, classIds }: { client: AnyClient; classIds: string[] }) {
  const classes = classIds
    .map((classId) => client.getNode(classId))
    .filter((node): node is ClientNode => node !== undefined);
  if (classes.length === 0) return null;
  return (
    <span className="day-page-sections__chips">
      {classes.map((cls) => (
        <span key={cls.id} className="day-page-sections__chip">
          {displayNameFromClient(client, cls.id) ?? cls.id}
        </span>
      ))}
    </span>
  );
}

/** A dated/created row: name button + class chips. */
function NodeRow({
  client,
  node,
  onOpenPage,
}: {
  client: AnyClient;
  node: ClientNode;
  onOpenPage: ((nodeId: string) => void) | undefined;
}) {
  return (
    <li className="day-page-sections__row">
      <button type="button" className="day-page-sections__row-name" onClick={() => onOpenPage?.(node.id)}>
        {displayNameFromClient(client, node.id) ?? node.id}
      </button>
      <RowClassChips client={client} classIds={node.classIds} />
    </li>
  );
}

export function DayPageSections({
  client,
  pageId,
  iso,
  onOpenPage,
}: {
  client: AnyClient;
  /** The day node's id. */
  pageId: string;
  /** The day node's date (local ISO — derived from the id by the host). */
  iso: string;
  onOpenPage: ((nodeId: string) => void) | undefined;
}) {
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // §34.28 #2 — the open-tasks partition reads the task family; idempotent.
  // Fire-and-forget: a mid-teardown rejection must not go unhandled (the
  // next mount re-runs the deploy).
  useEffect(() => {
    void ensureTaskFamily(client).catch(() => {});
  }, [client]);

  const statusSchema = client
    .listPropertySchemas()
    .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);

  // Tasks: the hub's member read + the Calendar partition, no query.
  const tasksPartition = useMemo<PartitionedTasks>(() => {
    const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.task);
    const rows = taskRowsOf(
      client,
      statusSchema,
      members.map((member) => member.id),
    );
    return partitionOpenTasks(rows, iso);
    // statusSchema's options feed the closed flags — re-resolve per notify.
  }, [client, statusSchema, iso, version]);

  // Dated: the day node's materialized backlink set (minus chain/tasks).
  const datedRows = useMemo(() => datedRowNodes(client, pageId), [client, pageId, version]);

  // Created: delegated to CreatedSection (the same section month and year
  // pages render) — one createdAt range query per notification, the section
  // hidden while empty, cards the default view mode.
  const createdBounds = createdTodayBounds(iso);

  const openCount =
    tasksPartition.overdue.length +
    tasksPartition.scheduled.filter((row) => !row.occurrenceDone).length;

  const statusLabelOf = (id: string): string | null =>
    taskStatusLabel(
      statusSchema,
      client
        .getEffectiveProperties(id)
        .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value,
    );

  const renderTaskRow = (
    row: OpenTaskRow,
    group: "overdue" | "scheduled",
  ): ReactNode => {
    // §34.69: the done-toggle records the occurrence (recurring) — the
    // checkbox reflects this day, not the node-level status.
    const checked = row.closed || row.occurrenceDone;
    return (
    <li
      key={row.id}
      className={`day-page-sections__row${
        group === "overdue" ? " day-page-sections__row--overdue" : ""
      }${row.occurrenceDone ? " day-page-sections__row--done" : ""}`}
    >
      <Checkbox
        size="sm"
        checked={checked}
        disabled={statusSchema === undefined}
        aria-label={checked ? "Reopen task" : "Mark task done"}
        onChange={(event) =>
          void setTaskDone(client, statusSchema, row.id, event.target.checked, iso)
        }
      />
      <button type="button" className="day-page-sections__row-name" onClick={() => onOpenPage?.(row.id)}>
        {displayNameFromClient(client, row.id) ?? row.id}
      </button>
      {statusSchema !== undefined && statusLabelOf(row.id) !== null && (
        <Pill text={statusLabelOf(row.id)!} />
      )}
      {group === "overdue" && row.scheduledIso !== null && (
        <span className="day-page-sections__row-day">{row.scheduledIso}</span>
      )}
    </li>
    );
  };

  return (
    <div className="day-page-sections">
      {openCount > 0 && (
        <Section
          key={`tasks-${pageId}`}
          client={client}
          title="Tasks"
          icon={<Icon path="mdi-format-list-checks" size={0.9} />}
          badge={openCount}
          defaultCollapsed
          load={() => tasksPartition}
          emptyText="Nothing scheduled for this day."
          renderResults={(partition) => (
            <>
              {partition.overdue.length > 0 && (
                <div className="day-page-sections__group">
                  <h3 className="day-page-sections__group-title day-page-sections__group-title--overdue">
                    Overdue
                  </h3>
                  <ul className="day-page-sections__rows">
                    {partition.overdue.map((row) => renderTaskRow(row, "overdue"))}
                  </ul>
                </div>
              )}
              {partition.scheduled.length > 0 && (
                <div className="day-page-sections__group">
                  <h3 className="day-page-sections__group-title">Scheduled</h3>
                  <ul className="day-page-sections__rows">
                    {partition.scheduled.map((row) => renderTaskRow(row, "scheduled"))}
                  </ul>
                </div>
              )}
            </>
          )}
        />
      )}
      {datedRows.length > 0 && (
        <Section
          key={`dated-${pageId}`}
          client={client}
          title="Dated"
          icon={<Icon path="mdi-calendar-range" size={0.9} />}
          badge={datedRows.length}
          defaultCollapsed
          load={() => datedRows}
          emptyText="Nothing references this day yet."
          renderResults={(rows) => (
            <ul className="day-page-sections__rows">
              {rows.map((node) => (
                <NodeRow key={node.id} client={client} node={node} onOpenPage={onOpenPage} />
              ))}
            </ul>
          )}
        />
      )}
      <CreatedSection
        client={client}
        pageId={pageId}
        after={createdBounds.after}
        before={createdBounds.before}
        onOpenPage={onOpenPage}
      />
    </div>
  );
}
