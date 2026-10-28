/**
 * dateValue — the shared calendar-date seam for the collection views. The
 * unified datetime property shape (SCHEMA.md "Datetime") resolves here
 * ONCE: point `{nodeId}` refs, v1 bare-uuid refs, and ranges `{start, end}`
 * whose slots are refs — every slot resolves through the deterministic
 * date-chain id (no client lookups). The gantt and the collection calendar
 * both build their models on these ordinals; the calendar feature's own
 * helpers (calendarViewUtils `scheduledIsoOf` et al) stay the calendar
 * SURFACE's seam — this one is the collection lenses'.
 */

import { parseDateNodeId } from "@notees/domain";

/** A calendar date at day precision. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const MS_PER_DAY = 86_400_000;

/** Days since epoch (UTC) — the single ordering key. */
export function dateOrdinal(date: CalendarDate): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / MS_PER_DAY);
}

/** The calendar date of a day ordinal (UTC round-trip). */
export function ordinalDate(ordinal: number): CalendarDate {
  const stamp = new Date(ordinal * MS_PER_DAY);
  return { year: stamp.getUTCFullYear(), month: stamp.getUTCMonth() + 1, day: stamp.getUTCDate() };
}

/** The local `YYYY-MM-DD` of a day ordinal. */
export function ordinalIso(ordinal: number): string {
  const date = ordinalDate(ordinal);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** The day ordinal of a local `YYYY-MM-DD`; null unless the shape parses. */
export function isoOrdinal(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  return dateOrdinal({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
}

/** Today's ordinal (the local calendar day). */
export function todayOrdinal(now: Date = new Date()): number {
  return dateOrdinal({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

function slotDate(slot: unknown): { date: CalendarDate; precision: string } | null {
  const nodeId =
    typeof slot === "string"
      ? slot.length > 0
        ? slot
        : null
      : typeof slot === "object" && slot !== null && typeof (slot as { nodeId?: unknown }).nodeId === "string"
        ? (slot as { nodeId: string }).nodeId
        : null;
  if (nodeId === null) return null;
  const parsed = parseDateNodeId(nodeId);
  if (parsed === null) return null;
  return { date: { year: parsed.year, month: parsed.month, day: parsed.day }, precision: parsed.precision };
}

function isRangeValue(value: unknown): value is { start?: unknown; end?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("start" in value || "end" in value)
  );
}

/**
 * Resolve one datetime VALUE to its calendar date for the picked side: a
 * point renders its single date; a range renders its own side, falling
 * back to the other side when that side is open (`{start, end: null}`
 * reads as a same-day range). Year/month-precision refs normalize to the
 * first day — unless `dayPrecisionOnly` is set, in which case they read as
 * no date at all (the calendar grid's strictness: a month ref is not a
 * point in time). Null when no date ref rides the value.
 */
export function dateValueDay(
  value: unknown,
  side: "start" | "end",
  opts?: { dayPrecisionOnly?: boolean },
): CalendarDate | null {
  if (value === null || value === undefined) return null;
  const pick = (slot: unknown): CalendarDate | null => {
    const resolved = slotDate(slot);
    if (resolved === null) return null;
    if (opts?.dayPrecisionOnly === true && resolved.precision !== "day") return null;
    return resolved.date;
  };
  if (isRangeValue(value)) {
    const primary = side === "start" ? value.start : value.end;
    const fallback = side === "start" ? value.end : value.start;
    return pick(primary) ?? pick(fallback);
  }
  return pick(value);
}
