/**
 * taskSections — the tasks hub's query sections (2026-11-25): the retired
 * Buckets/Review views return as STACKED LIVE-QUERY SECTIONS. Each section
 * is a QueryAST over the task class, executed through the query-run seam
 * (`{today}` placeholders resolve at compile time) and intersected with the
 * hub's filtered item set — "overdue is a query, unscheduled another query
 * section".
 *
 * The bucket semantics survive verbatim, expressed in the grammar's
 * OR/NOT arms over the two date properties. The driving day is the EARLIEST
 * of Scheduled/Deadline, so:
 *   driving <  today  ⇔  scheduled < today OR deadline < today
 *   driving == today  ⇔  (scheduled == today OR deadline == today)
 *                        AND NOT (driving < today)
 *   driving >  today  ⇔  (scheduled exists OR deadline exists)
 *                        AND NOT (driving <= today)
 * Open = the status rides NO closed option (the derived Pending default
 * reads through the effective-values model — includeDefaults stays on).
 * Review is the overdue set minus recurring tasks (a missed occurrence
 * rolls forward — nothing to review) and minus nothing else: the retired
 * Review view's day-grouped bulk "Push to today" retired with it (the
 * per-row postpone + the date pill cover rescheduling).
 */

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_STATUS_OPTION_UUIDS,
} from "@notees/domain";
import type { Child, Condition, Group, QueryAst } from "@notees/query";

import type { AnyClient, TableColumn } from "../collection/types.js";

/** Task property columns, in display order (schemas may not exist yet —
 *  the task family is authored on demand, so missing schemas drop out). */
const TASK_PROPERTY_COLUMNS: Array<{ id: string; fallback: string }> = [
  { id: SYSTEM_PROPERTY_UUIDS.taskStatus, fallback: "Status" },
  { id: SYSTEM_PROPERTY_UUIDS.taskPriority, fallback: "Priority" },
  { id: SYSTEM_PROPERTY_UUIDS.taskScheduled, fallback: "Scheduled" },
  { id: SYSTEM_PROPERTY_UUIDS.taskDeadline, fallback: "Deadline" },
];

/** The tasks table's column set (the hub's table mode + every section's). */
export function taskTableColumns(client: AnyClient): TableColumn[] {
  const schemas = client.listPropertySchemas();
  return [
    { id: "name", kind: "name", label: "Name", sortable: true },
    ...TASK_PROPERTY_COLUMNS.filter((col) => schemas.some((s) => s.id === col.id)).map((col) => ({
      id: col.id,
      kind: "property" as const,
      label: schemas.find((s) => s.id === col.id)?.name ?? col.fallback,
      propertySchemaId: col.id,
      sortable: true,
    })),
    { id: "created", kind: "created", label: "Created", sortable: true },
  ];
}

export interface TaskSectionDef {
  id: string;
  label: string;
  icon: string;
  ast: QueryAst;
}

const TASK_MEMBER: Child = {
  type: "member",
  family: "class",
  op: "in",
  target: { mode: "ids", ids: [SYSTEM_CLASS_UUIDS.task] },
};

const statusIs = (optionId: string): Child => ({
  type: "property",
  schemaId: SYSTEM_PROPERTY_UUIDS.taskStatus,
  op: "eq",
  value: optionId,
});

/** Open = the status rides no closed option (Done/Cancelled). */
const OPEN: Child = {
  type: "not",
  child: {
    type: "group",
    logic: "or",
    children: [statusIs(TASK_STATUS_OPTION_UUIDS.done), statusIs(TASK_STATUS_OPTION_UUIDS.cancelled)],
  },
};

type DateOp = "eq" | "lt" | "lte" | "exists";

const dateIs = (schemaId: string, op: DateOp): Condition => ({
  type: "property",
  schemaId,
  op,
  ...(op === "exists" ? {} : { value: "{today}" }),
});

const SCHEDULED = SYSTEM_PROPERTY_UUIDS.taskScheduled;
const DEADLINE = SYSTEM_PROPERTY_UUIDS.taskDeadline;

/** driving day < today ⇔ either date is past. */
const DRIVING_PAST: Child = {
  type: "group",
  logic: "or",
  children: [dateIs(SCHEDULED, "lt"), dateIs(DEADLINE, "lt")],
};

/** driving day <= today ⇔ either date is past-or-today. */
const DRIVING_PAST_OR_TODAY: Child = {
  type: "group",
  logic: "or",
  children: [dateIs(SCHEDULED, "lte"), dateIs(DEADLINE, "lte")],
};

const DRIVING_TODAY: Child = {
  type: "group",
  logic: "or",
  children: [dateIs(SCHEDULED, "eq"), dateIs(DEADLINE, "eq")],
};

const HAS_DATE: Child = {
  type: "group",
  logic: "or",
  children: [dateIs(SCHEDULED, "exists"), dateIs(DEADLINE, "exists")],
};

const NOT_RECURRING: Child = {
  type: "not",
  child: { type: "property", schemaId: SYSTEM_PROPERTY_UUIDS.repeat, op: "exists" },
};

const CLOSED: Child = {
  type: "group",
  logic: "or",
  children: [statusIs(TASK_STATUS_OPTION_UUIDS.done), statusIs(TASK_STATUS_OPTION_UUIDS.cancelled)],
};

function sectionAst(...children: Child[]): QueryAst {
  const root: Group = { type: "group", logic: "and", children: [TASK_MEMBER, ...children] };
  return { version: 2, scope: { type: "entire_workspace" }, root };
}

/** The hub's stacked sections, in render order. */
export const TASK_SECTIONS: readonly TaskSectionDef[] = [
  {
    id: "overdue",
    label: "Overdue",
    icon: "mdi-calendar-alert",
    ast: sectionAst(OPEN, DRIVING_PAST),
  },
  {
    id: "today",
    label: "Today",
    icon: "mdi-calendar-today",
    ast: sectionAst(OPEN, DRIVING_TODAY, { type: "not", child: DRIVING_PAST }),
  },
  {
    id: "upcoming",
    label: "Upcoming",
    icon: "mdi-calendar-clock",
    ast: sectionAst(OPEN, HAS_DATE, { type: "not", child: DRIVING_PAST_OR_TODAY }),
  },
  {
    id: "unscheduled",
    label: "Unscheduled",
    icon: "mdi-calendar-remove",
    ast: sectionAst(OPEN, { type: "not", child: dateIs(SCHEDULED, "exists") }, { type: "not", child: dateIs(DEADLINE, "exists") }),
  },
  {
    id: "completed",
    label: "Completed",
    icon: "mdi-check-circle-outline",
    ast: sectionAst(CLOSED),
  },
  {
    id: "review",
    label: "Review",
    icon: "mdi-clipboard-check-outline",
    ast: sectionAst(OPEN, NOT_RECURRING, DRIVING_PAST),
  },
];
