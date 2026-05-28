/**
 * Date UUID utilities
 *
 * Daily, monthly, and yearly nodes use deterministic UUIDs:
 * - Day:   00000000-0000-0000-00dd-YYYYMMDD0000
 * - Month: 00000000-0000-0000-00aa-YYYYMM000000
 * - Year:  00000000-0000-0000-00bb-YYYY00000000
 *
 * These helpers parse, compare, and generate date UUIDs for use in
 * task scheduling, journal navigation, and date-based queries.
 */

const DAY_PREFIX = '00000000-0000-0000-00dd-';
const MONTH_PREFIX = '00000000-0000-0000-00aa-';
const YEAR_PREFIX = '00000000-0000-0000-00bb-';

/**
 * Check if a UUID is a daily (day) node UUID.
 */
export function isDayUuid(uuid: string | null | undefined): boolean {
  return !!uuid && uuid.startsWith(DAY_PREFIX);
}

/**
 * Check if a UUID is a monthly node UUID.
 */
export function isMonthUuid(uuid: string | null | undefined): boolean {
  return !!uuid && uuid.startsWith(MONTH_PREFIX);
}

/**
 * Check if a UUID is a yearly node UUID.
 */
export function isYearUuid(uuid: string | null | undefined): boolean {
  return !!uuid && uuid.startsWith(YEAR_PREFIX);
}

/**
 * Parse a day UUID into a Date object (local time, midnight).
 * Returns null if the UUID is not a valid day UUID.
 */
export function dayUuidToDate(uuid: string | null | undefined): Date | null {
  if (!isDayUuid(uuid)) return null;

  const datePart = uuid!.slice(DAY_PREFIX.length, DAY_PREFIX.length + 8);
  const year = parseInt(datePart.slice(0, 4), 10);
  const month = parseInt(datePart.slice(4, 6), 10);
  const day = parseInt(datePart.slice(6, 8), 10);

  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  // Validate the date actually matches (e.g. not Feb 30)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return date;
}

/**
 * Generate a day UUID for a given Date.
 */
export function dateToDayUuid(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${DAY_PREFIX}${y}${m}${d}0000`;
}

/**
 * Generate a day UUID for today.
 */
export function getTodayDayUuid(): string {
  return dateToDayUuid(new Date());
}

/**
 * Compare two day UUIDs.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Falls back to string comparison for non-day UUIDs.
 */
export function compareDayUuids(a: string, b: string): number {
  const dateA = dayUuidToDate(a);
  const dateB = dayUuidToDate(b);
  if (dateA && dateB) {
    return dateA.getTime() - dateB.getTime();
  }
  return a.localeCompare(b);
}

/**
 * Check if a day UUID is before another day UUID.
 */
export function isDayUuidBefore(a: string, b: string): boolean {
  return compareDayUuids(a, b) < 0;
}

/**
 * Check if a day UUID is after another day UUID.
 */
export function isDayUuidAfter(a: string, b: string): boolean {
  return compareDayUuids(a, b) > 0;
}

/**
 * Check if a day UUID represents today.
 */
export function isTodayDayUuid(uuid: string): boolean {
  return uuid === getTodayDayUuid();
}

/**
 * Check if a day UUID is in the past (before today).
 */
export function isPastDayUuid(uuid: string): boolean {
  return isDayUuidBefore(uuid, getTodayDayUuid());
}

/**
 * Check if a day UUID is in the future (after today).
 */
export function isFutureDayUuid(uuid: string): boolean {
  return isDayUuidAfter(uuid, getTodayDayUuid());
}

/**
 * Extract a display date string from a day UUID.
 * Returns the UUID unchanged if it is not a valid day UUID.
 */
export function dayUuidToDisplay(uuid: string): string {
  const date = dayUuidToDate(uuid);
  if (!date) return uuid;
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
