/**
 * CalendarView helpers — the pure logic behind the Calendar day view,
 * extracted for direct testing (partition, AST bounds, chip qualification).
 * No client, no React: every function takes plain values.
 */

import {
  occurrenceIsosOf,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_CLOSED_STATUSES,
  parseDateNodeId,
  type RecurrenceRule,
} from "@notees/domain";
import type { QueryAst } from "@notees/query";

// Re-exported for callers that want the canonical import site alongside the
// other day-view helpers.
export { chainNodeIds, dayNodeId, recurrenceRuleOf } from "@notees/domain";

/** Local `YYYY-MM-DD` for today — always local midnight, never UTC .slice. */
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

/**
 * Long weekday name for a date (the UI is English-only — the locale is
 * pinned, not `undefined`, so a host/browser es locale can never leak
 * "martes" into an English surface). Day-page header and Calendar day view
 * share this.
 */
export function weekdayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { weekday: "long" });
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
 * (property taskStatus eq <done>) AND NOT (… eq <cancelled>). The
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
  return buildCreatedInPeriodAst(after, before);
}

/**
 * The created-this-period bounds for a month (`YYYYMM00`) or year
 * (`YYYY0000`) date-node id: the period's first local midnight through its
 * last local day, converted to UTC (the same lexicographic-comparison
 * contract as createdTodayBounds).
 */
export function createdPeriodBounds(parts: {
  year: number;
  month: number;
  precision: "year" | "month";
}): { after: string; before: string } {
  const startIso =
    parts.precision === "year"
      ? `${parts.year}-01-01`
      : `${parts.year}-${String(parts.month).padStart(2, "0")}-01`;
  const endIso =
    parts.precision === "year"
      ? `${parts.year}-12-31`
      : (() => {
          // Last day of the month: day 0 of the next month.
          const end = new Date(parts.year, parts.month, 0);
          return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
            end.getDate(),
          ).padStart(2, "0")}`;
        })();
  return {
    after: new Date(`${startIso}T00:00:00.000`).toISOString(),
    before: new Date(`${endIso}T23:59:59.999`).toISOString(),
  };
}

/**
 * The created-in-period query over node.created_at (UTC ISO-8601 bounds).
 * Only main nodes list (owner 2026-10-08): a class or a present-as-main node
 * — blocks created in the window are inline scaffolding, never content.
 */
export function buildCreatedInPeriodAst(after: string, before: string): QueryAst {
  return {
    version: 1,
    scope: { type: "entire_workspace" },
    root: {
      type: "group",
      logic: "and",
      children: [
        { type: "createdAfter", timestamp: after },
        { type: "createdBefore", timestamp: before },
        {
          type: "group",
          logic: "or",
          children: [
            { type: "isClass", isClass: true },
            { type: "presentAsMain", presentAsMain: true },
          ],
        },
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
  /**
   * The taskScheduled value's recurrence rule (metadata.repeat),
   * null for plain tasks. A repeating task OCCURS on every expanded day;
   * it is never "overdue" (missed days roll forward to the next occurrence).
   */
  repeat: RecurrenceRule | null;
  /**
   * The taskScheduled value's completed occurrence days
   * (metadata.completedOccurrences; [] for plain tasks). Per-occurrence
   * completion: the day view's done-toggle on a recurring task records the
   * DATE here instead of the node-level status, so one occurrence closes
   * while the series stays open.
   */
  completedOccurrences: readonly string[];
  /**
   * Set by partitionOpenTasks against the viewed day: this row's
   * occurrence ON THAT DAY is recorded done (a done occurrence still lists,
   * rendered checked, excluded from the open count).
   */
  occurrenceDone: boolean;
}

export interface PartitionedTasks {
  /** Selected day is AFTER the scheduled day — rendered above scheduled, muted. */
  overdue: OpenTaskRow[];
  /** Scheduled exactly on the selected day (a repeating task lands here on every occurrence day). */
  scheduled: OpenTaskRow[];
}

/**
 * Client-side partition of the open-task query rows against the selected day.
 * Future rows (selected day before the scheduled day) are dropped; closed
 * rows are dropped too (the query already excludes them — this is the
 * fallback for the window before ensureTaskFamily's write lands).
 * A repeating task lands in `scheduled` on EVERY occurrence day
 * (its scheduled day is occurrence #0); it never lands in `overdue` —
 * a missed occurrence rolls forward to the next one.
 * An occurrence recorded done (completedOccurrences ∋ selectedIso)
 * still lists in `scheduled`, flagged `occurrenceDone` — it renders checked
 * on that day and reopens from there, while every other occurrence stays
 * open.
 */
export function partitionOpenTasks(
  rows: readonly OpenTaskRow[],
  selectedIso: string,
): PartitionedTasks {
  const overdue: OpenTaskRow[] = [];
  const scheduled: OpenTaskRow[] = [];
  for (const row of rows) {
    if (row.closed || row.scheduledIso === null) continue;
    if (row.repeat !== null && row.completedOccurrences.includes(selectedIso)) {
      scheduled.push({ ...row, occurrenceDone: true });
    } else if (row.scheduledIso === selectedIso) {
      scheduled.push({ ...row, occurrenceDone: false });
    } else if (row.repeat !== null && occursOnDay(row.repeat, row.scheduledIso, selectedIso)) {
      scheduled.push({ ...row, occurrenceDone: false });
    } else if (row.repeat === null && row.scheduledIso < selectedIso) {
      overdue.push({ ...row, occurrenceDone: false });
    }
  }
  const byDay = (a: OpenTaskRow, b: OpenTaskRow) =>
    (a.scheduledIso ?? "").localeCompare(b.scheduledIso ?? "") || a.id.localeCompare(b.id);
  overdue.sort(byDay);
  scheduled.sort(byDay);
  return { overdue, scheduled };
}

// --- day-page derivation --------------------------------------------------------

/** `YYYY-MM-DD` from parsed date-node id parts — the inverse direction of parseIsoDate. */
export function isoOfDateParts(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day,
  ).padStart(2, "0")}`;
}

/**
 * The local ISO day a `{"nodeId": …}` date property value points at (null
 * unless the target parses at day precision). Shared by the Calendar day
 * view, the day-page sections, and the tasks buckets.
 */
export function scheduledIsoOf(value: unknown): string | null {
  const ref = value as { nodeId?: unknown } | undefined;
  if (typeof ref?.nodeId !== "string") return null;
  const parsed = parseDateNodeId(ref.nodeId);
  if (parsed === null || parsed.precision !== "day") return null;
  return isoOfDateParts(parsed);
}

/**
 * The 7 local ISO dates of the visible week containing `iso`, honoring the
 * first-day-of-week setting (noon-anchored via addDaysIso, so DST never
 * shifts the calendar day). Feeds the week strip.
 */
export function weekDaysOfIso(iso: string, firstDayOfWeek: number): string[] {
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = new Date(y!, m! - 1, d!, 12).getDay();
  const offset = (weekday - firstDayOfWeek + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => addDaysIso(iso, i - offset));
}

/**
 * Range-aware day activity: true when the day node's backlink
 * set holds any non-date-chain source. The edge projection fans date refs
 * (and range ends) out to the deterministic day node, so one
 * materialized read answers "objects dated this day" — a day-precision ref
 * lands on its day, a range end lands on its end day. (Qualified-link
 * metadata ranges edge only from their start day — the middle days stay
 * dotless, the same visibility the Dated section has.)
 */
export function hasDatedRefs(backlinks: ReadonlyArray<{ sourceId: string }>): boolean {
  return backlinks.some((edge) => parseDateNodeId(edge.sourceId) === null);
}

// --- bucketed tasks --------------------------------------------------------------

/**
 * One task row's client-side bucket facts (derived from effective
 * properties). `drivingIso` is the earliest scheduled/deadline day — the day
 * the bucket labels and sorts by (null for unscheduled/completed).
 */
export interface TaskBucketRow extends OpenTaskRow {
  deadlineIso: string | null;
  drivingIso: string | null;
}

export interface TaskBuckets {
  /** Driving day before today. */
  overdue: TaskBucketRow[];
  /** Driving day exactly today. */
  today: TaskBucketRow[];
  /** Driving day after today (unbounded — the hub must not drop far-future tasks). */
  upcoming: TaskBucketRow[];
  /** Open, no scheduled/deadline day. */
  unscheduled: TaskBucketRow[];
  /** Closed status — the whole closed set, not just today's completions. */
  completed: TaskBucketRow[];
}

/**
 * The tasks-bucket partition, client-side over the tasks-hub members: a
 * task's driving day is its earliest scheduled/deadline day, and the bucket
 * priority is Overdue → Today → Upcoming, so every open task lands in
 * exactly one bucket. (The original OR-section queries could list one task twice;
 * the hub section keeps rows unique and unbounded-upcoming so nothing
 * scheduled vanishes.)
 */
export function partitionTasksIntoBuckets(
  rows: readonly TaskBucketRow[],
  todayIso: string,
): TaskBuckets {
  const overdue: TaskBucketRow[] = [];
  const today: TaskBucketRow[] = [];
  const upcoming: TaskBucketRow[] = [];
  const unscheduled: TaskBucketRow[] = [];
  const completed: TaskBucketRow[] = [];
  for (const row of rows) {
    if (row.closed) {
      completed.push(row);
      continue;
    }
    const days = [row.scheduledIso, row.deadlineIso]
      .filter((day): day is string => day !== null)
      .sort();
    const drivingIso = days[0] ?? null;
    const withDriving: TaskBucketRow = { ...row, drivingIso };
    if (drivingIso === null) unscheduled.push(withDriving);
    else if (drivingIso < todayIso) overdue.push(withDriving);
    else if (drivingIso === todayIso) today.push(withDriving);
    else upcoming.push(withDriving);
  }
  const byDay = (a: TaskBucketRow, b: TaskBucketRow) =>
    (a.drivingIso ?? "").localeCompare(b.drivingIso ?? "") || a.id.localeCompare(b.id);
  overdue.sort(byDay);
  upcoming.sort(byDay);
  const byId = (a: TaskBucketRow, b: TaskBucketRow) => a.id.localeCompare(b.id);
  today.sort(byId);
  unscheduled.sort(byId);
  completed.sort(byId);
  return { overdue, today, upcoming, unscheduled, completed };
}

// --- quick-create chips ----------------------------------------------------------

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
 * with type "datetime" (the unified date type). The task class prefers its
 * taskScheduled schema; other classes with several datetime bindings take the
 * first by sorted schema id. Excluded by design: the year/month/day
 * date-chain classes (a chip there would fight the deterministic chain
 * ids). Every other class rides on its bindings — that is what makes a
 * meeting-classed page one click away. The Calendar view and the
 * workspace-settings editor share this helper so the two surfaces never
 * drift; `propertyName` names the driving date property for settings rows
 * (null for nameless inputs).
 */
export function dateChipCandidates(
  classes: ReadonlyArray<{ id: string; name: string | null }>,
  bindingsOf: (classId: string) => ReadonlyArray<{ propertySchemaId: string; type: string; name?: string }>,
): Array<{ classId: string; schemaId: string; label: string; propertyName: string | null }> {
  const excluded = new Set<string>([
    SYSTEM_CLASS_UUIDS.year,
    SYSTEM_CLASS_UUIDS.month,
    SYSTEM_CLASS_UUIDS.day,
  ]);
  const chips: Array<{ classId: string; schemaId: string; label: string; propertyName: string | null }> = [];
  for (const cls of classes) {
    if (excluded.has(cls.id)) continue;
    const dateBindings = bindingsOf(cls.id).filter((binding) => binding.type === "datetime");
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

// --- recurrence (compute-on-read) -------------------------------------------------

/** True when `iso` is an occurrence day of the anchored series. */
export function occursOnDay(rule: RecurrenceRule, anchorIso: string, iso: string): boolean {
  return occurrenceIsosOf({ rule, anchorIso }, iso, iso, 1).length === 1;
}

/** Display label for the repeat picker and the day-view marker. */
export function repeatLabelOf(rule: RecurrenceRule): string {
  switch (rule.freq) {
    case "daily":
      return rule.interval >= 2 ? `Every ${rule.interval} days` : "Daily";
    case "weekly":
      return rule.interval >= 2 ? `Every ${rule.interval} weeks` : "Weekly";
    case "weekdays":
      return "Weekdays";
    case "monthly":
      return rule.interval >= 2 ? `Every ${rule.interval} months` : "Monthly";
    case "yearly":
      return rule.interval >= 2 ? `Every ${rule.interval} years` : "Yearly";
  }
}
