/**
 * CalendarView helpers — the pure logic behind the Calendar day view,
 * extracted for direct testing (partition, AST bounds, chip qualification).
 * No client, no React: every function takes plain values.
 */

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
} from "@notees/domain";
import type { QueryAst } from "@notees/query";

// Re-exported for callers that want the canonical import site alongside the
// other day-view helpers.
export { chainNodeIds, dayNodeId } from "@notees/domain";

/** Local `YYYY-MM-DD` for today — the §34.28 #1 rule: always local midnight, never UTC .slice. */
export function todayIsoLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * ±N days over a local ISO date with a noon anchor, so DST transitions never
 * shift the calendar day (the journal test-suite idiom).
 */
export function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!, 12);
  date.setDate(date.getDate() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** ISO-8601 week number (Mon-first) for a local ISO date. */
export function isoWeekNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const dayNum = date.getUTCDay() || 7;
  // The Thursday of this week belongs to the ISO week year.
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Long weekday name for a local ISO date (locale-sensitive display). */
export function weekdayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { weekday: "long" });
}

/**
 * The created-today window: node.created_at is a UTC ISO-8601 string compared
 * lexicographically by the query arms, so the bounds are the selected LOCAL
 * day's start/end converted to UTC (`new Date(iso+"T00:00:00.000").toISOString()`
 * / end-of-day 23:59:59.999) — a node created anywhere in the local day matches.
 */
export function createdTodayBounds(iso: string): { after: string; before: string } {
  return {
    after: new Date(`${iso}T00:00:00.000`).toISOString(),
    before: new Date(`${iso}T23:59:59.999`).toISOString(),
  };
}

/**
 * The open-task query: class:task AND property taskScheduled "exists" AND NOT
 * (property taskStatus eq <done>) AND NOT (… eq <cancelled>). The §34.28 #4b
 * compiler caveat is load-bearing: never op "neq" for open filtering — nodes
 * with no value don't match neq — so each closed status is a negated eq arm.
 * `closedOptionIds` are the taskStatus select-option ids whose labels are the
 * TASK_CLOSED_STATUSES names, resolved from the authored schema at runtime.
 */
export function buildOpenTasksAst(
  closedOptionIds: readonly string[],
): QueryAst {
  const children: QueryAst["root"]["children"] = [
    { type: "class", classId: SYSTEM_CLASS_UUIDS.task },
    { type: "property", schemaId: SYSTEM_PROPERTY_UUIDS.taskScheduled, op: "exists" },
  ];
  for (const optionId of closedOptionIds) {
    children.push({
      type: "not",
      child: {
        type: "property",
        schemaId: SYSTEM_PROPERTY_UUIDS.taskStatus,
        op: "eq",
        value: optionId,
      },
    });
  }
  return {
    version: 1,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children },
  };
}

/** The created-today query over node.created_at (UTC ISO-8601 bounds). */
export function buildCreatedTodayAst(iso: string): QueryAst {
  const { after, before } = createdTodayBounds(iso);
  return {
    version: 1,
    scope: { type: "entire_workspace" },
    root: {
      type: "group",
      logic: "and",
      children: [
        { type: "createdAfter", timestamp: after },
        { type: "createdBefore", timestamp: before },
      ],
    },
  };
}

/** One open-task row's client-side facts (derived from effective properties). */
export interface OpenTaskRow {
  id: string;
  /** The taskScheduled value's calendar day (local ISO), null when unparsable. */
  scheduledIso: string | null;
  /** True when the status label is a TASK_CLOSED_STATUSES name. */
  closed: boolean;
}

export interface PartitionedTasks {
  /** Selected day is AFTER the scheduled day — rendered above scheduled, muted. */
  overdue: OpenTaskRow[];
  /** Scheduled exactly on the selected day. */
  scheduled: OpenTaskRow[];
}

/**
 * Client-side partition of the open-task query rows against the selected day.
 * Future rows (selected day before the scheduled day) are dropped; closed
 * rows are dropped too (the query already excludes them — this is the
 * fallback for the window before ensureTaskFamily's write lands).
 */
export function partitionOpenTasks(
  rows: readonly OpenTaskRow[],
  selectedIso: string,
): PartitionedTasks {
  const overdue: OpenTaskRow[] = [];
  const scheduled: OpenTaskRow[] = [];
  for (const row of rows) {
    if (row.closed || row.scheduledIso === null) continue;
    if (row.scheduledIso === selectedIso) scheduled.push(row);
    else if (row.scheduledIso < selectedIso) overdue.push(row);
  }
  const byDay = (a: OpenTaskRow, b: OpenTaskRow) =>
    (a.scheduledIso ?? "").localeCompare(b.scheduledIso ?? "") || a.id.localeCompare(b.id);
  overdue.sort(byDay);
  scheduled.sort(byDay);
  return { overdue, scheduled };
}

// --- quick-create chips (§34.28 #10) -----------------------------------------

/** The option ids whose labels name closed statuses (labels, never colors —
 * select options carry no color on the wire). */
export function closedStatusOptionIds(
  schema: { options: Array<{ id: string; label: string }> | null } | undefined,
): string[] {
  return (schema?.options ?? [])
    .filter((option) => TASK_CLOSED_STATUSES.has(option.label as "Done" | "Cancelled"))
    .map((option) => option.id);
}

/** One class's chip candidacy input (resolved by the view from the client). */
export interface ChipCandidateInput {
  classId: string;
  bindings: ReadonlyArray<{ propertySchemaId: string; type: string; name?: string }>;
}

/**
 * Classes that qualify for a quick-create chip: any bound property schema
 * with type "date". The task class prefers its taskScheduled schema; other
 * classes with several date bindings take the first by sorted schema id.
 * Excluded by design: the year/month/day date-chain classes (a chip there
 * would fight the deterministic chain ids) and the `class` system class
 * (classes are authored by class.create, not object.create). Every other
 * class rides on its bindings — that is what makes a meeting-classed page
 * one click away. The Calendar view and the workspace-settings editor share
 * this helper so the two surfaces never drift; `propertyName` names the
 * driving date property for settings rows (null for nameless inputs).
 */
export function dateChipCandidates(
  classes: ReadonlyArray<{ id: string; name: string | null }>,
  bindingsOf: (classId: string) => ReadonlyArray<{ propertySchemaId: string; type: string; name?: string }>,
): Array<{ classId: string; schemaId: string; label: string; propertyName: string | null }> {
  const excluded = new Set<string>([
    SYSTEM_CLASS_UUIDS.year,
    SYSTEM_CLASS_UUIDS.month,
    SYSTEM_CLASS_UUIDS.day,
    SYSTEM_CLASS_UUIDS.class,
  ]);
  const chips: Array<{ classId: string; schemaId: string; label: string; propertyName: string | null }> = [];
  for (const cls of classes) {
    if (excluded.has(cls.id)) continue;
    const dateBindings = bindingsOf(cls.id).filter((binding) => binding.type === "date");
    if (dateBindings.length === 0) continue;
    const pick =
      cls.id === SYSTEM_CLASS_UUIDS.task
        ? (dateBindings
            .map((binding) => binding.propertySchemaId)
            .sort()
            .find((id) => id === SYSTEM_PROPERTY_UUIDS.taskScheduled) ??
          [...dateBindings.map((binding) => binding.propertySchemaId)].sort()[0]!)
        : [...dateBindings.map((binding) => binding.propertySchemaId)].sort()[0]!;
    const driving = dateBindings.find((binding) => binding.propertySchemaId === pick);
    chips.push({
      classId: cls.id,
      schemaId: pick,
      label: cls.name ?? cls.id,
      propertyName: driving?.name ?? null,
    });
  }
  chips.sort((a, b) => a.label.localeCompare(b.label) || a.classId.localeCompare(b.classId));
  return chips;
}
