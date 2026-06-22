/**
 * Date range utilities for formatting, validation, and UUID generation.
 *
 * Mirrors the backend normalization so the frontend can build the exact
 * payload stored in property_value_scalar.value_text.
 */

import { generateDateUuid, type ParsedDate } from './dateParser';

export type DateRangeGranularity = 'day' | 'month' | 'year';

export interface DateRangeValue {
  start: string;          // ISO date YYYY-MM-DD
  end: string;
  granularity: DateRangeGranularity;
  start_uuid: string;
  end_uuid: string;
}

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}

function parseIsoDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  // Use local midnight so the displayed date matches the stored string.
  const [year, month, day] = value.split('-').map((p) => parseInt(p, 10));
  return new Date(year, month - 1, day);
}

function canonicalDates(
  start: Date,
  end: Date,
  granularity: DateRangeGranularity,
): { start: Date; end: Date } {
  if (granularity === 'day') {
    return { start, end };
  }

  if (granularity === 'month') {
    const startCanonical = new Date(start.getFullYear(), start.getMonth(), 1);
    const endCanonical = new Date(end.getFullYear(), end.getMonth() + 1, 0);
    return { start: startCanonical, end: endCanonical };
  }

  // year
  return {
    start: new Date(start.getFullYear(), 0, 1),
    end: new Date(end.getFullYear(), 11, 31),
  };
}

function isoString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

function uuidForDate(d: Date, granularity: DateRangeGranularity): string {
  const parsed: ParsedDate = {
    type: granularity,
    year: d.getFullYear(),
    month: granularity !== 'year' ? d.getMonth() + 1 : undefined,
    day: granularity === 'day' ? d.getDate() : undefined,
    label: '',
  };
  return generateDateUuid(parsed);
}

/**
 * Validate and normalize a date range payload.
 */
export function normalizeDateRange(
  start: string,
  end: string,
  granularity: DateRangeGranularity,
): DateRangeValue {
  if (!['day', 'month', 'year'].includes(granularity)) {
    throw new Error(`Invalid granularity: ${granularity}`);
  }

  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);

  if (startDate.getTime() > endDate.getTime()) {
    throw new Error('Start date must be before or equal to end date');
  }

  const { start: startCanonical, end: endCanonical } = canonicalDates(startDate, endDate, granularity);

  return {
    start: isoString(startCanonical),
    end: isoString(endCanonical),
    granularity,
    start_uuid: uuidForDate(startCanonical, granularity),
    end_uuid: uuidForDate(endCanonical, granularity),
  };
}

/**
 * Format a date range for display.
 */
export function formatDateRange(value: DateRangeValue | null): string {
  if (!value) return '';
  const { start, end, granularity } = value;
  const startDate = parseIsoDate(start);
  const endDate = parseIsoDate(end);

  if (granularity === 'day') {
    if (start === end) {
      return formatDay(startDate);
    }
    return `${formatDay(startDate)} – ${formatDay(endDate)}`;
  }

  if (granularity === 'month') {
    if (startDate.getFullYear() === endDate.getFullYear() && startDate.getMonth() === endDate.getMonth()) {
      return formatMonth(startDate);
    }
    return `${formatMonth(startDate)} – ${formatMonth(endDate)}`;
  }

  if (startDate.getFullYear() === endDate.getFullYear()) {
    return String(startDate.getFullYear());
  }
  return `${startDate.getFullYear()} – ${endDate.getFullYear()}`;
}

function formatDay(d: Date): string {
  return `${MONTH_NAMES[d.getMonth() + 1]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatMonth(d: Date): string {
  return `${MONTH_NAMES[d.getMonth() + 1]} ${d.getFullYear()}`;
}

/**
 * Parse a target date UUID (day/month/year journal page) into a canonical ISO date.
 */
export function dateUuidToIso(uuid: string): string | null {
  if (!uuid || uuid.length !== 36) return null;

  // Day UUID: 00000000-0000-0000-00dd-YYYYMMDD0000
  if (uuid.startsWith('00000000-0000-0000-00dd-')) {
    const data = uuid.slice(-12, -4);
    if (/^\d{8}$/.test(data)) {
      const y = data.slice(0, 4);
      const m = data.slice(4, 6);
      const d = data.slice(6, 8);
      return `${y}-${m}-${d}`;
    }
  }

  // Month UUID: 00000000-0000-0000-00aa-YYYYMM000000
  if (uuid.startsWith('00000000-0000-0000-00aa-')) {
    const data = uuid.slice(-12, -6);
    if (/^\d{6}$/.test(data)) {
      const y = data.slice(0, 4);
      const m = data.slice(4, 6);
      return `${y}-${m}-01`;
    }
  }

  // Year UUID: 00000000-0000-0000-00bb-YYYY00000000
  if (uuid.startsWith('00000000-0000-0000-00bb-')) {
    const data = uuid.slice(-12, -8);
    if (/^\d{4}$/.test(data)) {
      return `${data}-01-01`;
    }
  }

  return null;
}

/**
 * Return the granularity of a date UUID, or null if it is not a date UUID.
 */
export function dateUuidGranularity(uuid: string): DateRangeGranularity | null {
  if (!uuid || uuid.length !== 36) return null;
  if (uuid.startsWith('00000000-0000-0000-00dd-')) return 'day';
  if (uuid.startsWith('00000000-0000-0000-00aa-')) return 'month';
  if (uuid.startsWith('00000000-0000-0000-00bb-')) return 'year';
  return null;
}

/**
 * Build a DateRangeValue from raw inputs, suitable for API payloads.
 */
export function buildDateRangeValue(
  start: string,
  end: string,
  granularity: DateRangeGranularity,
): DateRangeValue {
  return normalizeDateRange(start, end, granularity);
}
