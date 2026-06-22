/**
 * Tests for date range utility functions.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDateRange,
  formatDateRange,
  dateUuidToIso,
  dateUuidGranularity,
  buildDateRangeValue,
} from './dateRange';
import { generateDateUuid } from './dateParser';
function dayUuid(year: number, month: number, day: number): string {
  return generateDateUuid({ type: 'day', year, month, day, label: '' });
}

function monthUuid(year: number, month: number): string {
  return generateDateUuid({ type: 'month', year, month, label: '' });
}

function yearUuid(year: number): string {
  return generateDateUuid({ type: 'year', year, label: '' });
}

describe('normalizeDateRange', () => {
  it('keeps day ranges unchanged', () => {
    const result = normalizeDateRange('2025-06-10', '2025-06-15', 'day');
    expect(result).toEqual({
      start: '2025-06-10',
      end: '2025-06-15',
      granularity: 'day',
      start_uuid: dayUuid(2025, 6, 10),
      end_uuid: dayUuid(2025, 6, 15),
    });
  });

  it('canonicalizes month ranges', () => {
    const result = normalizeDateRange('2025-06-10', '2025-08-20', 'month');
    expect(result.start).toBe('2025-06-01');
    expect(result.end).toBe('2025-08-31');
    expect(result.granularity).toBe('month');
    expect(result.start_uuid).toBe(monthUuid(2025, 6));
    expect(result.end_uuid).toBe(monthUuid(2025, 8));
  });

  it('canonicalizes year ranges', () => {
    const result = normalizeDateRange('2025-03-15', '2027-01-10', 'year');
    expect(result.start).toBe('2025-01-01');
    expect(result.end).toBe('2027-12-31');
    expect(result.granularity).toBe('year');
    expect(result.start_uuid).toBe(yearUuid(2025));
    expect(result.end_uuid).toBe(yearUuid(2027));
  });

  it('throws when start is after end', () => {
    expect(() => normalizeDateRange('2025-06-15', '2025-06-10', 'day')).toThrow(
      'Start date must be before or equal to end date',
    );
  });

  it('throws for invalid granularity', () => {
    expect(() => normalizeDateRange('2025-06-10', '2025-06-15', 'week' as 'day')).toThrow(
      'Invalid granularity',
    );
  });
});

describe('formatDateRange', () => {
  it('formats a single day', () => {
    expect(formatDateRange({
      start: '2025-06-10',
      end: '2025-06-10',
      granularity: 'day',
      start_uuid: '',
      end_uuid: '',
    })).toBe('June 10, 2025');
  });

  it('formats a day range', () => {
    expect(formatDateRange({
      start: '2025-06-10',
      end: '2025-06-15',
      granularity: 'day',
      start_uuid: '',
      end_uuid: '',
    })).toBe('June 10, 2025 – June 15, 2025');
  });

  it('formats a single month', () => {
    expect(formatDateRange({
      start: '2025-06-01',
      end: '2025-06-30',
      granularity: 'month',
      start_uuid: '',
      end_uuid: '',
    })).toBe('June 2025');
  });

  it('formats a month range', () => {
    expect(formatDateRange({
      start: '2025-06-01',
      end: '2025-08-31',
      granularity: 'month',
      start_uuid: '',
      end_uuid: '',
    })).toBe('June 2025 – August 2025');
  });

  it('formats a single year', () => {
    expect(formatDateRange({
      start: '2025-01-01',
      end: '2025-12-31',
      granularity: 'year',
      start_uuid: '',
      end_uuid: '',
    })).toBe('2025');
  });

  it('formats a year range', () => {
    expect(formatDateRange({
      start: '2025-01-01',
      end: '2027-12-31',
      granularity: 'year',
      start_uuid: '',
      end_uuid: '',
    })).toBe('2025 – 2027');
  });

  it('returns empty string for null', () => {
    expect(formatDateRange(null)).toBe('');
  });
});

describe('dateUuidToIso', () => {
  it('parses day UUIDs', () => {
    expect(dateUuidToIso(dayUuid(2025, 6, 10))).toBe('2025-06-10');
  });

  it('parses month UUIDs', () => {
    expect(dateUuidToIso(monthUuid(2025, 6))).toBe('2025-06-01');
  });

  it('parses year UUIDs', () => {
    expect(dateUuidToIso(yearUuid(2025))).toBe('2025-01-01');
  });

  it('returns null for non-date UUIDs', () => {
    expect(dateUuidToIso('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('dateUuidGranularity', () => {
  it('detects day granularity', () => {
    expect(dateUuidGranularity(dayUuid(2025, 6, 10))).toBe('day');
  });

  it('detects month granularity', () => {
    expect(dateUuidGranularity(monthUuid(2025, 6))).toBe('month');
  });

  it('detects year granularity', () => {
    expect(dateUuidGranularity(yearUuid(2025))).toBe('year');
  });

  it('returns null for non-date UUIDs', () => {
    expect(dateUuidGranularity('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('buildDateRangeValue', () => {
  it('normalizes raw inputs into a DateRangeValue', () => {
    const result = buildDateRangeValue('2025-06-10', '2025-06-15', 'day');
    expect(result.start).toBe('2025-06-10');
    expect(result.end).toBe('2025-06-15');
    expect(result.granularity).toBe('day');
    expect(result.start_uuid).toBe(dayUuid(2025, 6, 10));
    expect(result.end_uuid).toBe(dayUuid(2025, 6, 15));
  });
});
