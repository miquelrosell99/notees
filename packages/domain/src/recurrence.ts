/**
 * Recurrence — the RRULE-lite grammar behind repeating calendar events
 * (§34.28 #6, owner ruling 2026-10-04: COMPUTE-ON-READ — no new op, no wire
 * change).
 *
 * A recurrence rule lives as METADATA on the event's date value: the value's
 * `metadata.repeat` key carries the canonical grammar string, exactly like
 * the startDate/endDate qualifier precedent (SCHEMA.md "Dates"). The date
 * value's own day IS the series anchor — the anchor is never stored inside
 * the rule (one source of truth: the linked day node).
 *
 * The calendar expands occurrences at READ time (occurrenceIsosOf); every
 * occurrence is VIRTUAL — no node per occurrence (design law: no hidden
 * objects), so editing the event edits the series and the month grid's dots
 * re-derive from the rule on every render.
 *
 * Canonical string grammar (the stored form):
 *
 *     <freq>            e.g. "daily", "weekdays"
 *     <freq>/<interval> e.g. "weekly/2" (every two weeks)
 *
 *   <freq>    = "daily" | "weekly" | "weekdays" | "monthly" | "yearly"
 *   <interval> = integer 2..999 (1 is the default and is never written)
 *
 * Semantics (documented in SCHEMA.md, pinned by the test suite):
 *   - the anchor day is occurrence #0;
 *   - "daily"   = every <interval> days;
 *   - "weekly"  = every <interval> weeks on the anchor's weekday;
 *   - "weekdays"= every Mon–Fri (interval other than 1 is rejected — the
 *                 picker's minimal vocabulary, fail loud on "weekdays/2");
 *   - "monthly" = the anchor's day-of-month every <interval> months; a month
 *                 that lacks that day (Jan 31 → February) SKIPS, RRULE-style;
 *   - "yearly"  = the anchor's month-day every <interval> years (Feb 29 skips
 *                 non-leap years, the same rule);
 *   - expansion is capped: a window yielding more than `cap` occurrences
 *     TRUNCATES at `cap` (default RECURRENCE_DEFAULT_CAP) — reads stay
 *     bounded, callers size the window instead.
 *
 * Parse is fail-loud (dates.ts idiom): garbage in throws, never a silent
 * non-recurring read.
 */

import { parseIsoDate, type DateParts } from "./dates.js";

export type RecurrenceFreq = "daily" | "weekly" | "weekdays" | "monthly" | "yearly";

export const RECURRENCE_FREQS: readonly RecurrenceFreq[] = [
  "daily",
  "weekly",
  "weekdays",
  "monthly",
  "yearly",
];

/** Largest accepted <interval> (2..999 when written explicitly). */
export const RECURRENCE_MAX_INTERVAL = 999;

/** Default occurrence cap for one expansion window (see occurrenceIsosOf). */
export const RECURRENCE_DEFAULT_CAP = 366;

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Every Nth period; 1 = every period. */
  interval: number;
}

/**
 * A rule anchored at its series' first day — the expansion input. The anchor
 * is the carrying date value's own day (ISO YYYY-MM-DD), supplied by the
 * reader, never stored in the grammar.
 */
export interface RecurrenceSeries {
  rule: RecurrenceRule;
  anchorIso: string;
}

const GRAMMAR =
  /^(daily|weekly|weekdays|monthly|yearly)(?:\/(\d+))?$/;

/**
 * Parse the canonical grammar string. Throws on anything else — unknown
 * freq, malformed interval, interval above RECURRENCE_MAX_INTERVAL, or an
 * interval on "weekdays" — with the valid vocabulary in the message.
 */
export function parseRecurrenceRule(text: unknown): RecurrenceRule {
  if (typeof text !== "string") {
    throw new Error(`invalid recurrence rule: expected a string, got ${JSON.stringify(text)}`);
  }
  const match = GRAMMAR.exec(text.trim());
  if (match === null) {
    throw new Error(
      `invalid recurrence rule: ${JSON.stringify(text)} ` +
        `(expected <freq> or <freq>/<interval>, freq one of: ${RECURRENCE_FREQS.join(", ")})`,
    );
  }
  const freq = match[1] as RecurrenceFreq;
  const interval = match[2] === undefined ? 1 : Number(match[2]);
  if (interval < 1 || interval > RECURRENCE_MAX_INTERVAL) {
    throw new Error(
      `invalid recurrence rule: interval must be 1..${RECURRENCE_MAX_INTERVAL}, got ${JSON.stringify(match[2])}`,
    );
  }
  if (freq === "weekdays" && interval !== 1) {
    throw new Error(`invalid recurrence rule: "weekdays" does not take an interval`);
  }
  return { freq, interval };
}

/** The canonical stored form: `<freq>`, or `<freq>/<interval>` when interval ≥ 2. */
export function formatRecurrenceRule(rule: RecurrenceRule): string {
  return rule.interval >= 2 ? `${rule.freq}/${rule.interval}` : rule.freq;
}

/**
 * Read the rule out of a property value's metadata (the `repeat` key —
 * additive, the startDate/endDate precedent). Returns null when the key is
 * absent or null; a PRESENT but malformed value throws (fail loud — a
 * corrupt rule must never read back as "does not repeat").
 */
export function recurrenceRuleOf(metadata: unknown): RecurrenceRule | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const repeat = (metadata as Record<string, unknown>).repeat;
  if (repeat === undefined || repeat === null) return null;
  return parseRecurrenceRule(repeat);
}

// --- expansion ------------------------------------------------------------------

function partsIso(parts: DateParts): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The month `anchorMonth` + n months shifted, or null when that month lacks the day. */
function shiftMonths(anchor: DateParts, n: number): DateParts | null {
  const zeroBased = anchor.year * 12 + (anchor.month - 1) + n;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  if (anchor.day > daysInMonth(year, month)) return null; // RRULE-style skip
  return { year, month, day: anchor.day };
}

/** Whole UTC days from a to b (b - a), noon-anchored so DST never exists here. */
function dayDiff(a: DateParts, b: DateParts): number {
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

function addDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday (UTC — pure calendar arithmetic, no timezone). */
function utcWeekday(parts: DateParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/**
 * Expand a series into the day isos occurring inside the INCLUSIVE window
 * [fromIso, toIso]. The anchor day is the first occurrence. At most `cap`
 * occurrences are computed and returned — a window wider than the cap
 * TRUNCATES (callers size the window; the default bounds a daily rule at
 * one year). `fromIso > toIso` throws, as does any malformed date.
 */
export function occurrenceIsosOf(
  series: RecurrenceSeries,
  fromIso: string,
  toIso: string,
  cap: number = RECURRENCE_DEFAULT_CAP,
): string[] {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`invalid recurrence cap: ${JSON.stringify(cap)} (expected a positive integer)`);
  }
  const anchor = parseIsoDate(series.anchorIso);
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (partsIso(from) > partsIso(to)) {
    throw new Error(`invalid recurrence window: ${fromIso} is after ${toIso}`);
  }
  const out: string[] = [];
  if (partsIso(anchor) > partsIso(to)) return out;

  const pushFrom = (candidate: DateParts): boolean => {
    // Returns false when the caller must stop (past the window or cap hit).
    const iso = partsIso(candidate);
    if (iso > partsIso(to) || out.length >= cap) return false;
    if (iso >= partsIso(from)) out.push(iso);
    return true;
  };

  switch (series.rule.freq) {
    case "daily":
    case "weekly": {
      const step = series.rule.freq === "daily" ? series.rule.interval : series.rule.interval * 7;
      let current =
        partsIso(anchor) >= partsIso(from)
          ? anchor
          : addDays(anchor, Math.ceil(dayDiff(anchor, from) / step) * step);
      while (pushFrom(current)) current = addDays(current, step);
      return out;
    }
    case "weekdays": {
      let current = partsIso(anchor) > partsIso(from) ? anchor : from;
      while (out.length < cap) {
        const weekday = utcWeekday(current);
        if (weekday >= 1 && weekday <= 5 && !pushFrom(current)) return out;
        if (partsIso(current) > partsIso(to)) return out;
        current = addDays(current, 1);
      }
      return out;
    }
    case "monthly":
    case "yearly": {
      const step =
        series.rule.freq === "monthly" ? series.rule.interval : series.rule.interval * 12;
      let k =
        partsIso(anchor) >= partsIso(from)
          ? 0
          : Math.max(0, Math.ceil(monthDiff(anchor, from) / step));
      for (; ; k += 1) {
        const candidate = shiftMonths(anchor, k * step);
        if (candidate === null) continue; // month lacks the anchor day — RRULE-style skip
        if (!pushFrom(candidate)) return out;
      }
    }
  }
}

/** Whole months from a to b (b - a). */
function monthDiff(a: DateParts, b: DateParts): number {
  return (b.year - a.year) * 12 + (b.month - a.month);
}
