import { describe, it, expect } from 'vitest';
import { parseDate, generateDateUuid } from './dateParser';

describe('parseDate', () => {
  it('parses ISO basic format YYYYMMDD', () => {
    const result = parseDate('20260804');
    expect(result).toEqual({
      type: 'day',
      year: 2026,
      month: 8,
      day: 4,
      label: 'August 4, 2026',
    });
  });

  it('parses ISO basic format for year boundaries', () => {
    expect(parseDate('20231231')).toEqual({
      type: 'day',
      year: 2023,
      month: 12,
      day: 31,
      label: 'December 31, 2023',
    });
    expect(parseDate('20240101')).toEqual({
      type: 'day',
      year: 2024,
      month: 1,
      day: 1,
      label: 'January 1, 2024',
    });
  });

  it('rejects invalid YYYYMMDD dates', () => {
    expect(parseDate('20261304')).toBeNull(); // invalid month
    expect(parseDate('20260832')).toBeNull(); // invalid day
    expect(parseDate('20260229')).toBeNull(); // not a leap year
    expect(parseDate('99999999')).toBeNull();
  });

  it('still parses ISO extended formats', () => {
    expect(parseDate('2026-08-04')).toEqual({
      type: 'day',
      year: 2026,
      month: 8,
      day: 4,
      label: 'August 4, 2026',
    });
    expect(parseDate('2026/08/04')).toEqual({
      type: 'day',
      year: 2026,
      month: 8,
      day: 4,
      label: 'August 4, 2026',
    });
  });

  it('parses ISO basic month format YYYYMM', () => {
    const result = parseDate('202604');
    expect(result).toEqual({
      type: 'month',
      year: 2026,
      month: 4,
      label: 'April 2026',
    });
  });

  it('rejects invalid YYYYMM dates', () => {
    expect(parseDate('202613')).toBeNull(); // invalid month
    expect(parseDate('202600')).toBeNull(); // invalid month
  });

  it('does not parse arbitrary 8-digit strings as dates', () => {
    expect(parseDate('12345678')).toBeNull();
  });
});

describe('generateDateUuid', () => {
  it('generates deterministic UUIDs for YYYYMMDD parsed dates', () => {
    const parsed = parseDate('20260804')!;
    expect(generateDateUuid(parsed)).toBe('00000000-0000-0000-00dd-202608040000');
  });
});
