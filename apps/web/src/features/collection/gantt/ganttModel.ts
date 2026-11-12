/**
 * ganttModel — the pure model behind the gantt collection view: items as
 * bars on a shared time axis. The view maps the collection's items INTO
 * the minimal GanttInputRow at its boundary (name, color, and the resolved
 * calendar dates of the picked start/end date properties — the same
 * effective-property read the table/pivot use); the model orders the lanes,
 * computes the bar segments, and derives the visible window. Date values
 * ride the unified datetime shape (SCHEMA.md "Datetime"): point `{nodeId}`
 * refs, v1 bare-uuid refs, and ranges `{start, end}` whose slots are refs —
 * every slot resolves through the deterministic date-chain id (no client
 * lookups in the model).
 */

import {
  dateOrdinal,
  dateValueDay,
  ordinalDate,
  todayOrdinal,
  type CalendarDate,
} from "../dateValue.js";

/** A calendar date at day precision (year/month-precision refs normalize
 *  to the first day — the axis is day-granular). The shared seam lives in
 *  `../dateValue.js`; the gantt's public names stand (re-exported below). */
export type GanttDate = CalendarDate;

export { dateOrdinal, ordinalDate, todayOrdinal };

/** The minimal row the model needs — the view resolves the picked date
 *  properties' effective values into `start`/`end` before calling in. */
export interface GanttInputRow {
  id: string;
  name: string;
  color: string | null;
  /** The resolved start date; null = the Unscheduled lane. */
  start: GanttDate | null;
  /** The resolved end date; null = a point-in-time bar. Ignored when
   *  `start` is null. */
  end: GanttDate | null;
}

export interface GanttBar {
  id: string;
  name: string;
  color: string | null;
  start: GanttDate;
  end: GanttDate | null;
  /** Day ordinals (days since epoch) — the view maps them to fractions. */
  startOrdinal: number;
  endOrdinal: number | null;
}

export interface GanttChart {
  /** Scheduled items, one bar each — start-ordered, name tiebreak. */
  bars: GanttBar[];
  /** Items with no start date, alphabetical. */
  unscheduled: Array<{ id: string; name: string; color: string | null }>;
  /** The visible window [from, to) in day ordinals; null when nothing is
   *  scheduled (the lane may still carry rows). */
  window: { from: number; to: number } | null;
  /** Month-start ordinals covering the window (the axis ticks). */
  ticks: number[];
}

/** The month bucket key (year × 12 + month) — window math stays calendar-
 *  honest across year boundaries. */
function monthIndex(date: GanttDate): number {
  return date.year * 12 + (date.month - 1);
}

function firstDayOf(month: number): GanttDate {
  return { year: Math.floor(month / 12), month: (month % 12) + 1, day: 1 };
}

/** The axis tick label of a month-start ordinal: the canonical `YYYY/MM`. */
export function ganttMonthLabel(monthStartOrdinal: number): string {
  const date = ordinalDate(monthStartOrdinal);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.year}/${pad(date.month)}`;
}

// --- datetime value resolution ------------------------------------------------

/**
 * Resolve one datetime VALUE for the gantt: the shared `dateValueDay`
 * (point refs / v1 bare uuids / ranges with side fallback — see
 * `../dateValue.js`). Year/month-precision refs normalize to the first
 * day; the calendar grid's day-only strictness does not apply here.
 */
export function ganttDateOf(value: unknown, side: "start" | "end"): GanttDate | null {
  return dateValueDay(value, side);
}

// --- the chart ----------------------------------------------------------------

/**
 * Build the chart: scheduled bars (start-ordered, name tiebreak), the
 * Unscheduled lane (alphabetical), and the visible window — [first day of
 * the month BEFORE the earliest start, first day of the month AFTER
 * (max(end ?? start) + 1 month)) — one axis tick per month in between.
 * Counts read the full set; nothing is windowed away.
 */
export function buildGantt(rows: readonly GanttInputRow[]): GanttChart {
  const scheduled: GanttBar[] = [];
  const unscheduled: GanttChart["unscheduled"] = [];
  for (const row of rows) {
    if (row.start === null) {
      unscheduled.push({ id: row.id, name: row.name, color: row.color });
      continue;
    }
    scheduled.push({
      id: row.id,
      name: row.name,
      color: row.color,
      start: row.start,
      end: row.end,
      startOrdinal: dateOrdinal(row.start),
      endOrdinal: row.end === null ? null : dateOrdinal(row.end),
    });
  }
  scheduled.sort((a, b) => {
    if (a.startOrdinal !== b.startOrdinal) return a.startOrdinal - b.startOrdinal;
    const aEnd = a.endOrdinal ?? a.startOrdinal;
    const bEnd = b.endOrdinal ?? b.startOrdinal;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.name.localeCompare(b.name);
  });
  unscheduled.sort((a, b) => a.name.localeCompare(b.name));

  if (scheduled.length === 0) {
    return { bars: [], unscheduled, window: null, ticks: [] };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const bar of scheduled) {
    min = Math.min(min, bar.startOrdinal);
    max = Math.max(max, bar.endOrdinal ?? bar.startOrdinal);
  }
  const fromMonth = monthIndex(ordinalDate(min)) - 1;
  const toMonth = monthIndex(ordinalDate(max)) + 1;
  const from = dateOrdinal(firstDayOf(fromMonth));
  const to = dateOrdinal(firstDayOf(toMonth + 1));
  const ticks: number[] = [];
  for (let month = fromMonth; month <= toMonth; month += 1) {
    ticks.push(dateOrdinal(firstDayOf(month)));
  }
  return { bars: scheduled, unscheduled, window: { from, to }, ticks };
}
