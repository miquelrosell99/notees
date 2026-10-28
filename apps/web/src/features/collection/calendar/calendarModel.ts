/**
 * calendarModel — the pure model behind the calendar collection view: the
 * collection's items placed on a month grid. The view maps the items INTO
 * the minimal CalendarInputRow at its boundary (name, color, and the
 * resolved day of the picked date property — day-precision strict, via the
 * shared `dateValueDay`); the model computes the grid cells, the item
 * placement, and the month-navigation bounds. One page per month (a
 * collection lens, not the journal's infinite feed). Items with no date
 * value stay OFF the grid — a point in time IS the calendar's unit; the
 * Unscheduled lane is the gantt's concern.
 */

import {
  dateOrdinal,
  dateValueDay,
  ordinalDate,
  ordinalIso,
  type CalendarDate,
} from "../dateValue.js";

export type { CalendarDate };

/** The minimal row the model needs — the view resolves the picked date
 *  property's effective value into `day` before calling in. */
export interface CalendarInputRow {
  id: string;
  name: string;
  color: string | null;
  /** The item's day (day precision); null = excluded from the grid. */
  day: CalendarDate | null;
}

export interface CalendarItemRef {
  id: string;
  name: string;
  color: string | null;
}

export interface CalendarCell {
  /** The cell's day ordinal (UTC days since epoch). */
  ordinal: number;
  /** The cell's local ISO day `YYYY-MM-DD`. */
  iso: string;
  /** Day-of-month number (out-of-month padding carries its own). */
  day: number;
  /** True when the cell belongs to the visible month. */
  inMonth: boolean;
  isToday: boolean;
  /** The items on this day, name-sorted (the full set — counts never
   *  window). */
  items: CalendarItemRef[];
}

export interface CalendarMonthGrid {
  year: number;
  /** 1-indexed. */
  month: number;
  /** The visible month keyed by its first day: `YYYY-MM`. */
  monthKey: string;
  /** The grid's weeks — 7 cells each, `firstDayOfWeek` aligned. */
  weeks: CalendarCell[][];
}

export interface CalendarMonthRef {
  year: number;
  /** 1-indexed. */
  month: number;
}

export interface CalendarMonthBounds {
  earliest: CalendarMonthRef | null;
  latest: CalendarMonthRef | null;
}

/** The month bucket key (year × 12 + month) — honest across year boundaries. */
function monthKeyOf(date: { year: number; month: number }): number {
  return date.year * 12 + (date.month - 1);
}

function monthRefOf(key: number): CalendarMonthRef {
  return { year: Math.floor(key / 12), month: (key % 12) + 1 };
}

/** Whole-month stride across year boundaries. */
export function shiftCalendarMonth(year: number, month: number, delta: number): CalendarMonthRef {
  return monthRefOf(year * 12 + (month - 1) + delta);
}

/**
 * The dated items' month span (undated rows ignored): the navigation
 * bounds. Null arms when nothing is dated — no bounds, no clamping.
 */
export function calendarMonthBounds(rows: readonly CalendarInputRow[]): CalendarMonthBounds {
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const row of rows) {
    if (row.day === null) continue;
    const key = monthKeyOf(row.day);
    earliest = earliest === null ? key : Math.min(earliest, key);
    latest = latest === null ? key : Math.max(latest, key);
  }
  return {
    earliest: earliest === null ? null : monthRefOf(earliest),
    latest: latest === null ? null : monthRefOf(latest),
  };
}

/**
 * Clamp a requested month into the data's span: outside the bounds the
 * nearest bound month stands (a dead page never renders — the same fail-
 * soft ruling as the persisted-mode sanitize). Null bounds never clamp.
 */
export function clampCalendarMonth(
  year: number,
  month: number,
  bounds: CalendarMonthBounds,
): CalendarMonthRef {
  const requested = year * 12 + (month - 1);
  if (bounds.earliest !== null && requested < monthKeyOf(bounds.earliest)) {
    return { year: bounds.earliest.year, month: bounds.earliest.month };
  }
  if (bounds.latest !== null && requested > monthKeyOf(bounds.latest)) {
    return { year: bounds.latest.year, month: bounds.latest.month };
  }
  return { year, month };
}

/**
 * Build the visible month's grid: weekday-aligned weeks (`firstDayOfWeek`,
 * 0 = Sunday — the device setting's vocabulary), padded with the adjacent
 * months' days, the items placed on their day cells.
 */
export function buildCalendarMonth(
  rows: readonly CalendarInputRow[],
  year: number,
  month: number,
  opts?: { firstDayOfWeek?: number; today?: number },
): CalendarMonthGrid {
  const firstDayOfWeek = opts?.firstDayOfWeek ?? 0;
  const today = opts?.today ?? null;

  /** ordinal → items (the placement map). */
  const byOrdinal = new Map<number, CalendarItemRef[]>();
  for (const row of rows) {
    if (row.day === null) continue;
    const ordinal = dateOrdinal(row.day);
    const list = byOrdinal.get(ordinal);
    const ref = { id: row.id, name: row.name, color: row.color };
    if (list === undefined) byOrdinal.set(ordinal, [ref]);
    else list.push(ref);
  }
  for (const list of byOrdinal.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const lead = (firstWeekday - firstDayOfWeek + 7) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const cellCount = Math.ceil((lead + daysInMonth) / 7) * 7;

  const cells: CalendarCell[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    const dayNumber = index - lead + 1;
    const date =
      dayNumber >= 1 && dayNumber <= daysInMonth
        ? { year, month, day: dayNumber }
        : ordinalDate(dateOrdinal({ year, month, day: 1 }) + (dayNumber - 1));
    const ordinal = dateOrdinal(date);
    cells.push({
      ordinal,
      iso: ordinalIso(ordinal),
      day: date.day,
      inMonth: date.month === month && date.year === year,
      isToday: today !== null && ordinal === today,
      items: byOrdinal.get(ordinal) ?? [],
    });
  }
  const weeks: CalendarCell[][] = [];
  for (let offset = 0; offset < cells.length; offset += 7) {
    weeks.push(cells.slice(offset, offset + 7));
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return { year, month, monthKey: `${year}-${pad(month)}`, weeks };
}

/** The view's boundary resolver: one effective value → the item's day
 *  (day precision strictly — a year/month ref is not a point in time). */
export function calendarDayOf(value: unknown): CalendarDate | null {
  return dateValueDay(value, "start", { dayPrecisionOnly: true });
}
