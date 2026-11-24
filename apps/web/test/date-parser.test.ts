/**
 * dateParser — the typed/natural-language date grammar behind the date
 * picker and the pickers' typed-date rows. Deterministic: system time is
 * pinned to Tuesday 2026-11-24 14:00 local for every relative arm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseDate } from "../src/features/date-pickers/dateParser.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 24, 14, 0, 0)); // Tuesday
});

afterEach(() => {
  vi.useRealTimers();
});

const day = (year: number, month: number, d: number) => ({ type: "day", year, month, day: d });

describe("parseDate — pre-existing grammar (regression pins)", () => {
  it("ISO / US / EU / named months / year", () => {
    expect(parseDate("2026-12-05")).toMatchObject(day(2026, 12, 5));
    expect(parseDate("20261205")).toMatchObject(day(2026, 12, 5));
    expect(parseDate("12/05/2026")).toMatchObject(day(2026, 12, 5));
    expect(parseDate("05.12.2026")).toMatchObject(day(2026, 12, 5));
    expect(parseDate("February 9, 2026")).toMatchObject(day(2026, 2, 9));
    expect(parseDate("9 Feb 2026")).toMatchObject(day(2026, 2, 9));
    expect(parseDate("Feb 2026")).toMatchObject({ type: "month", year: 2026, month: 2 });
    expect(parseDate("2026")).toMatchObject({ type: "year", year: 2026 });
  });

  it("relatives: today / tomorrow / yesterday / in N / ago / next-last period", () => {
    expect(parseDate("today")).toMatchObject(day(2026, 11, 24));
    expect(parseDate("tomorrow")).toMatchObject(day(2026, 11, 25));
    expect(parseDate("yesterday")).toMatchObject(day(2026, 11, 23));
    expect(parseDate("in 3 days")).toMatchObject(day(2026, 11, 27));
    expect(parseDate("in 2 weeks")).toMatchObject(day(2026, 12, 8));
    expect(parseDate("3 days ago")).toMatchObject(day(2026, 11, 21));
    expect(parseDate("next week")).toMatchObject(day(2026, 12, 1));
    expect(parseDate("last month")).toMatchObject(day(2026, 10, 24));
  });

  it("the 24h trailing time rides the result; a bare time is no date", () => {
    expect(parseDate("tomorrow 14:30")).toMatchObject({ ...day(2026, 11, 25), time: "14:30" });
    expect(parseDate("2026-10-09 09:15")).toMatchObject({ ...day(2026, 10, 9), time: "09:15" });
    expect(parseDate("14:30")).toBeNull();
  });

  it("rejects nonsense honestly", () => {
    expect(parseDate("someday")).toBeNull();
    expect(parseDate("next banana")).toBeNull();
    expect(parseDate("feb 30")).toBeNull();
    expect(parseDate("")).toBeNull();
  });
});

describe("parseDate — the natural-language extension (2026-11-24)", () => {
  it("weekdays: bare = the coming occurrence (today included)", () => {
    expect(parseDate("friday")).toMatchObject(day(2026, 11, 27)); // Tue → Fri
    expect(parseDate("monday")).toMatchObject(day(2026, 11, 30));
    expect(parseDate("tuesday")).toMatchObject(day(2026, 11, 24)); // today IS Tuesday
    expect(parseDate("fri")).toMatchObject(day(2026, 11, 27));
  });

  it("next weekday rolls a today-match out a week; last weekday is the past one", () => {
    expect(parseDate("next friday")).toMatchObject(day(2026, 11, 27)); // coming Friday
    expect(parseDate("next tuesday")).toMatchObject(day(2026, 12, 1)); // today-matched → +7
    expect(parseDate("last friday")).toMatchObject(day(2026, 11, 20));
    expect(parseDate("last tuesday")).toMatchObject(day(2026, 11, 17)); // today excluded
  });

  it("12-hour times, 'at', noon, midnight", () => {
    expect(parseDate("tomorrow at 5pm")).toMatchObject({ ...day(2026, 11, 25), time: "17:00" });
    expect(parseDate("friday 5:30 pm")).toMatchObject({ ...day(2026, 11, 27), time: "17:30" });
    expect(parseDate("tomorrow at 9am")).toMatchObject({ ...day(2026, 11, 25), time: "09:00" });
    expect(parseDate("tomorrow 12am")).toMatchObject({ ...day(2026, 11, 25), time: "00:00" });
    expect(parseDate("tomorrow 12pm")).toMatchObject({ ...day(2026, 11, 25), time: "12:00" });
    expect(parseDate("friday at noon")).toMatchObject({ ...day(2026, 11, 27), time: "12:00" });
    expect(parseDate("tomorrow midnight")).toMatchObject({ ...day(2026, 11, 25), time: "00:00" });
    expect(parseDate("dec 5 at 14:30")).toMatchObject({ ...day(2026, 12, 5), time: "14:30" });
    // 13pm is not a time — the whole string fails honestly.
    expect(parseDate("tomorrow 13pm")).toBeNull();
  });

  it("tonight is today at 20:00 (an explicit time still wins)", () => {
    expect(parseDate("tonight")).toMatchObject({ ...day(2026, 11, 24), time: "20:00" });
    expect(parseDate("tonight 22:15")).toMatchObject({ ...day(2026, 11, 24), time: "22:15" });
  });

  it("ordinal day suffixes ride the named-month arms", () => {
    expect(parseDate("Feb 9th")).toMatchObject(day(2026, 2, 9));
    expect(parseDate("9th February")).toMatchObject(day(2026, 2, 9));
    expect(parseDate("december 1st, 2026")).toMatchObject(day(2026, 12, 1));
    expect(parseDate("3rd March 2027")).toMatchObject(day(2027, 3, 3));
    expect(parseDate("dec 22nd at 6pm")).toMatchObject({ ...day(2026, 12, 22), time: "18:00" });
  });

  it("month names are not swallowed by the weekday arm", () => {
    expect(parseDate("may")).toMatchObject({ type: "month", month: 5 });
    expect(parseDate("march")).toMatchObject({ type: "month", month: 3 });
  });
});
