/**
 * Calendar helpers — the pure logic behind the calendar surfaces (the
 * grid/agenda read model, the day-page partitions), extracted for direct
 * testing (partition, AST bounds, slot parsing). No client, no React:
 * every function takes plain values.
 */

import {
  occurrenceIsosOf,
  SYSTEM_CLASS_UUIDS,
  parseDateNodeId,
  type RecurrenceRule,
} from "@notees/domain";
import type { QueryAst } from "@notees/query";

// Re-exported for callers that want the canonical import site alongside the
// other calendar helpers.
export { dayNodeId, recurrenceRuleOf } from "@notees/domain";

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

/** Signed day count from one local ISO day to another (noon-anchored). */
export function daysBetweenIsos(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const from = new Date(fy!, fm! - 1, fd!, 12);
  const to = new Date(ty!, tm! - 1, td!, 12);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
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
 * "martes" into an English surface). The day-page header and the calendar
 * date line share this.
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
            { type: "isEmbedded", isEmbedded: false },
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
   * completion: the day-context done-toggle on a recurring task records the
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

// --- datetime value slots (SCHEMA.md "Datetime") ---------------------------------

/**
 * One normalized slot of a datetime value: a day node reference plus an
 * optional wall-clock time ("HH:MM", 24h minute precision — absence IS the
 * full-day register on the wire).
 */
export interface DateValueSlot {
  nodeId: string;
  /** "HH:MM" — null for an untimed (full-day) slot. */
  time: string | null;
}

/**
 * Normalize one slot-ish piece of a datetime value: a point object
 * `{ "nodeId": …, "time"?: … }` or a legacy bare-uuid string (the archived
 * date encoding normalizes to an untimed slot at read time — the store
 * shapes writes, reads stay lenient). Null for anything else.
 */
function slotOf(value: unknown): DateValueSlot | null {
  if (typeof value === "string") return { nodeId: value, time: null };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const nodeId = (value as { nodeId?: unknown }).nodeId;
  if (typeof nodeId !== "string") return null;
  const time = (value as { time?: unknown }).time;
  return { nodeId, time: typeof time === "string" ? time : null };
}

/**
 * The `{ start, end }` view of a RANGE datetime value (either side open).
 * Null for points and non-date shapes — callers branch on the point/range
 * union through this and slotOf.
 */
export function rangeSlotsOf(
  value: unknown,
): { start: DateValueSlot | null; end: DateValueSlot | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!("start" in record) && !("end" in record)) return null;
  const side = (v: unknown): DateValueSlot | null =>
    v === undefined || v === null ? null : slotOf(v);
  return { start: side(record.start), end: side(record.end) };
}

/** The local ISO day of one slot (null unless the target parses at day precision). */
function slotIsoOf(slot: DateValueSlot | null): string | null {
  if (slot === null) return null;
  const parsed = parseDateNodeId(slot.nodeId);
  if (parsed === null || parsed.precision !== "day") return null;
  return isoOfDateParts(parsed);
}

/** The "HH:MM" of one slot (null when absent or untimed). */
export function slotTimeOf(slot: unknown): string | null {
  return slotOf(slot)?.time ?? null;
}

/**
 * The local ISO day a datetime value points at: a POINT's own day; a RANGE's
 * START slot day, falling back to the END slot's day when the start side is
 * open (`{start: null, end: {nodeId}}` lands on its end day). Null unless the
 * resolved slot parses at day precision — the strictness is load-bearing
 * (month/year-precision refs never read as a day). Shared by the calendar
 * grids/agenda, the day-page sections, and the tasks buckets.
 */
export function scheduledIsoOf(value: unknown): string | null {
  const range = rangeSlotsOf(value);
  if (range !== null) return slotIsoOf(range.start) ?? slotIsoOf(range.end);
  return slotIsoOf(slotOf(value));
}

/**
 * The value's clock time: the START slot's "HH:MM" for a range (a range
 * without a start time is untimed — null), the point's own time otherwise.
 * The block/agenda prefix derives from this.
 */
export function timeOfValue(value: unknown): string | null {
  const range = rangeSlotsOf(value);
  if (range !== null) return range.start?.time ?? null;
  return slotOf(value)?.time ?? null;
}

/** The RANGE's end-slot day (strict day precision; null for points and
    open/missing ends) — the span read's canonical end. */
export function rangeEndIsoOf(value: unknown): string | null {
  return slotIsoOf(rangeSlotsOf(value)?.end ?? null);
}

/**
 * The label prefix the grid blocks and the day agenda wear: "HH:MM" for a
 * timed point or a timed range start; "HH:MM–HH:MM" when a timed range's end
 * slot lands the SAME day with its own time (the Google same-day register).
 * Null for untimed values — the label rides bare, exactly as before times.
 */
export function timePrefixOfValue(value: unknown): string | null {
  const startTime = timeOfValue(value);
  if (startTime === null) return null;
  const range = rangeSlotsOf(value);
  if (range === null || range.end === null) return startTime;
  if (range.end.time !== null && slotIsoOf(range.end) === slotIsoOf(range.start)) {
    return `${startTime}–${range.end.time}`;
  }
  return startTime;
}

/** Minutes after midnight for a validated "HH:MM" — malformed throws (fail loud). */
export function minutesOfTime(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (match === null) throw new Error(`Invalid HH:MM time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "HH:MM" for minutes after midnight (the inverse of minutesOfTime). */
export function timeOfMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The overlap clustering behind the time grid's timed cards (the Google
 * register): events are grouped into clusters of TRANSITIVELY overlapping
 * spans (a touches b, b touches c ⇒ one cluster), then each event takes the
 * first free column within its cluster. Widths derive from the cluster's
 * column count, so overlapping events split the day column side by side
 * while a lone event fills its column.
 */
export interface TimedPlacement<T> {
  row: T;
  /** The event's column within its cluster (0-based). */
  column: number;
  /** The cluster's column count — the width divisor. */
  columns: number;
}

export function clusterTimedEvents<
  T extends { startMinutes: number; durationMinutes: number },
>(timed: readonly T[]): Array<TimedPlacement<T>> {
  const sorted = [...timed].sort(
    (a, b) =>
      a.startMinutes - b.startMinutes ||
      b.durationMinutes - a.durationMinutes,
  );
  const placements = new Map<T, TimedPlacement<T>>();
  /** Close a cluster: greedy first-free-column assignment. */
  const assign = (cluster: T[]): void => {
    const lastEnd: number[] = [];
    for (const event of cluster) {
      const end = event.startMinutes + event.durationMinutes;
      let column = lastEnd.findIndex((freeAt) => freeAt <= event.startMinutes);
      if (column === -1) {
        column = lastEnd.length;
        lastEnd.push(end);
      } else {
        lastEnd[column] = end;
      }
      placements.set(event, { row: event, column, columns: 1 });
    }
    const columns = Math.max(1, lastEnd.length);
    for (const event of cluster) placements.get(event)!.columns = columns;
  };
  let cluster: T[] = [];
  let clusterEnd = -1;
  for (const event of sorted) {
    const end = event.startMinutes + event.durationMinutes;
    if (event.startMinutes >= clusterEnd && cluster.length > 0) {
      assign(cluster);
      cluster = [];
    }
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length > 0) assign(cluster);
  return [...placements.values()];
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

/** One class's chip candidacy input (resolved by the view from the client). */
export interface ChipCandidateInput {
  classId: string;
  bindings: ReadonlyArray<{ propertySchemaId: string; type: string; name?: string }>;
}

/**
 * Event-family test: the class IS the system `event` class or extends it
 * transitively (the extends DAG walk, cycle-guarded by the seen set; the
 * DAG law makes cycles impossible, the guard is the depth-safety belt).
 * The quick-create eligibility register (owner 2026-10-23).
 */
export function isEventFamilyClass(
  classId: string,
  parentsOf: (classId: string) => readonly string[],
): boolean {
  if (classId === SYSTEM_CLASS_UUIDS.event) return true;
  const seen = new Set<string>([classId]);
  const queue = [classId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const parent of parentsOf(current)) {
      if (parent === SYSTEM_CLASS_UUIDS.event) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
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
