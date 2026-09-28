/**
 * Deterministic date-node ids — the v1 scheme ported from
 * `app/domain/entities/constants.py` (`generate_day_uuid` and siblings).
 *
 * A date is a node, not a string (SCHEMA.md "Dates"): every ISO date maps to
 * a year / month / day node chain with ids content-addressed from the date,
 * so chain creation is an idempotent no-op on re-create and v1 data locks
 * step with v2. Layout (FIXED — lockstep with v1, never regenerate):
 *
 *   day    00000000-0000-0000-00dd-YYYYMMDD0000
 *   month  00000000-0000-0000-00aa-YYYYMM000000
 *   year   00000000-0000-0000-00bb-YYYY00000000
 *
 * The trailing 12-digit payload orders chronologically across precisions
 * (year < month < day of the same period), which the query compiler relies
 * on for date comparisons.
 */

export type DatePrecision = "year" | "month" | "day";

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** v1 `parse_date_uuid` acceptance window (1900..2200 inclusive). */
export const DATE_UUID_MIN_YEAR = 1900;
export const DATE_UUID_MAX_YEAR = 2200;

const DAY_PREFIX = "00000000-0000-0000-00dd-";
const MONTH_PREFIX = "00000000-0000-0000-00aa-";
const YEAR_PREFIX = "00000000-0000-0000-00bb-";

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Strict `YYYY-MM-DD` parse with real-calendar validation (leap years
 * included). Datetime strings are rejected: date-node ids address whole
 * days; time-of-day has nowhere to go. Fail loud — a malformed date must
 * never silently produce a node id.
 */
export function parseIsoDate(isoDate: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (match === null) {
    throw new Error(`invalid ISO date: ${JSON.stringify(isoDate)} (expected YYYY-MM-DD)`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Days in month via the day-before-first-of-next-month trick (UTC, pure).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new Error(`invalid ISO date: ${JSON.stringify(isoDate)} (no such calendar day)`);
  }
  return { year, month, day };
}

/** `00000000-0000-0000-00bb-YYYY00000000` (v1 `generate_year_uuid`). */
export function yearNodeId(isoDate: string): string {
  const { year } = parseIsoDate(isoDate);
  return `${YEAR_PREFIX}${pad(year, 4)}00000000`;
}

/** `00000000-0000-0000-00aa-YYYYMM000000` (v1 `generate_month_uuid`). */
export function monthNodeId(isoDate: string): string {
  const { year, month } = parseIsoDate(isoDate);
  return `${MONTH_PREFIX}${pad(year, 4)}${pad(month, 2)}000000`;
}

/** `00000000-0000-0000-00dd-YYYYMMDD0000` (v1 `generate_day_uuid`). */
export function dayNodeId(isoDate: string): string {
  const { year, month, day } = parseIsoDate(isoDate);
  return `${DAY_PREFIX}${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}0000`;
}

/** The node id a date property value links at the schema's precision. */
export function dateNodeId(isoDate: string, precision: DatePrecision): string {
  switch (precision) {
    case "year":
      return yearNodeId(isoDate);
    case "month":
      return monthNodeId(isoDate);
    case "day":
      return dayNodeId(isoDate);
  }
}

/** The full chain for a date: year (root) → month (under year) → day (under month). */
export function chainNodeIds(isoDate: string): { year: string; month: string; day: string } {
  return { year: yearNodeId(isoDate), month: monthNodeId(isoDate), day: dayNodeId(isoDate) };
}

/**
 * Node display names — the v1 journal labels (v1 `yearlyNoteIdentity` et al.):
 * year `YYYY0000`, month `YYYYMM00`, day `YYYYMMDD`. Date nodes are named by
 * their compact date so v1's name-based lookups still resolve them.
 */
export function dateNodeLabel(parts: DateParts, precision: DatePrecision): string {
  switch (precision) {
    case "year":
      return `${pad(parts.year, 4)}0000`;
    case "month":
      return `${pad(parts.year, 4)}${pad(parts.month, 2)}00`;
    case "day":
      return `${pad(parts.year, 4)}${pad(parts.month, 2)}${pad(parts.day, 2)}`;
  }
}

export interface ParsedDateNodeId extends DateParts {
  precision: DatePrecision;
}

/**
 * v1 `parse_date_uuid` port: extract precision + date components from a
 * date-node id, or null when the id is not a date UUID (or falls outside
 * the v1 1900..2200 window). Round-trips with the generators above.
 */
export function parseDateNodeId(id: string): ParsedDateNodeId | null {
  if (typeof id !== "string" || id.length !== 36) return null;
  const data = id.slice(24); // trailing 12-digit payload
  const read = (start: number, end: number): number | null => {
    const slice = data.slice(start, end);
    return /^\d+$/.test(slice) ? Number(slice) : null;
  };
  if (id.startsWith(DAY_PREFIX)) {
    const year = read(0, 4);
    const month = read(4, 6);
    const day = read(6, 8);
    if (
      year !== null &&
      month !== null &&
      day !== null &&
      year >= DATE_UUID_MIN_YEAR &&
      year <= DATE_UUID_MAX_YEAR &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return { precision: "day", year, month, day };
    }
    return null;
  }
  if (id.startsWith(MONTH_PREFIX)) {
    const year = read(0, 4);
    const month = read(4, 6);
    if (
      year !== null &&
      month !== null &&
      year >= DATE_UUID_MIN_YEAR &&
      year <= DATE_UUID_MAX_YEAR &&
      month >= 1 &&
      month <= 12
    ) {
      return { precision: "month", year, month, day: 1 };
    }
    return null;
  }
  if (id.startsWith(YEAR_PREFIX)) {
    const year = read(0, 4);
    if (year !== null && year >= DATE_UUID_MIN_YEAR && year <= DATE_UUID_MAX_YEAR) {
      return { precision: "year", year, month: 1, day: 1 };
    }
    return null;
  }
  return null;
}
