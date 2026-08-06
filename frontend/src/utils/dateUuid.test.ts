import { describe, it, expect } from 'vitest';
import {
  dateToDayUuid,
  dayUuidToWeekday,
  monthUuidToMonthName,
  yearMonthToMonthUuid,
} from './dateUuid';

describe('dayUuidToWeekday', () => {
  it('returns the weekday name for a day UUID', () => {
    // 2026-08-06 is a Thursday
    const uuid = dateToDayUuid(new Date(2026, 7, 6));
    expect(dayUuidToWeekday(uuid, 'en-US')).toBe('Thursday');
  });

  it('returns null for a non-day UUID', () => {
    expect(dayUuidToWeekday('00000000-0000-0000-00aa-202608000000', 'en-US')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(dayUuidToWeekday(null, 'en-US')).toBeNull();
    expect(dayUuidToWeekday('', 'en-US')).toBeNull();
  });
});

describe('monthUuidToMonthName', () => {
  it('returns the month name for a month UUID', () => {
    const uuid = yearMonthToMonthUuid(2026, 6);
    expect(monthUuidToMonthName(uuid, 'en-US')).toBe('June');
  });

  it('returns null for a non-month UUID', () => {
    expect(monthUuidToMonthName('00000000-0000-0000-00dd-202608060000', 'en-US')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(monthUuidToMonthName(null, 'en-US')).toBeNull();
    expect(monthUuidToMonthName('', 'en-US')).toBeNull();
  });
});
