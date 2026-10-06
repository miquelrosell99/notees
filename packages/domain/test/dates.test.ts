/**
 * Date-node id vectors, locked against the reference implementations in
 * `app/domain/entities/constants.py` (generate_day_uuid / generate_month_uuid
 * / generate_year_uuid / parse_date_uuid). Expected values below were
 * produced by running those Python functions; the scheme is frozen, so these
 * vectors guard the cross-client lockstep.
 */

import { describe, expect, it } from "vitest";
import {
  chainNodeIds,
  dateNodeId,
  dateNodeLabel,
  dayNodeId,
  monthNodeId,
  parseDateNodeId,
  parseIsoDate,
  yearNodeId,
} from "../src/index.js";

// Computed from the Python source:
//   generate_day_uuid(date(2026, 9, 27))    -> 00000000-0000-0000-00dd-202609270000
//   generate_month_uuid(2026, 9)            -> 00000000-0000-0000-00aa-202609000000
//   generate_year_uuid(2026)                -> 00000000-0000-0000-00bb-202600000000
// (full vector table in the it() bodies below)
const V1_VECTORS = [
  {
    iso: "2026-09-27",
    day: "00000000-0000-0000-00dd-202609270000",
    month: "00000000-0000-0000-00aa-202609000000",
    year: "00000000-0000-0000-00bb-202600000000",
  },
  {
    iso: "1999-01-01",
    day: "00000000-0000-0000-00dd-199901010000",
    month: "00000000-0000-0000-00aa-199901000000",
    year: "00000000-0000-0000-00bb-199900000000",
  },
  {
    iso: "2000-12-31",
    day: "00000000-0000-0000-00dd-200012310000",
    month: "00000000-0000-0000-00aa-200012000000",
    year: "00000000-0000-0000-00bb-200000000000",
  },
  {
    iso: "2024-02-29",
    day: "00000000-0000-0000-00dd-202402290000",
    month: "00000000-0000-0000-00aa-202402000000",
    year: "00000000-0000-0000-00bb-202400000000",
  },
] as const;

describe("date node ids (scheme port)", () => {
  it("matches the reference generators' outputs for known dates", () => {
    for (const v of V1_VECTORS) {
      expect(dayNodeId(v.iso)).toBe(v.day);
      expect(monthNodeId(v.iso)).toBe(v.month);
      expect(yearNodeId(v.iso)).toBe(v.year);
    }
  });

  it("dateNodeId dispatches on precision; chainNodeIds returns the year→month→day triple", () => {
    const v = V1_VECTORS[0]!;
    expect(dateNodeId(v.iso, "day")).toBe(v.day);
    expect(dateNodeId(v.iso, "month")).toBe(v.month);
    expect(dateNodeId(v.iso, "year")).toBe(v.year);
    expect(chainNodeIds(v.iso)).toEqual({ year: v.year, month: v.month, day: v.day });
    // Zero-padding: single-digit months/days stay two digits (%02d).
    expect(chainNodeIds("1999-01-01")).toEqual({
      year: "00000000-0000-0000-00bb-199900000000",
      month: "00000000-0000-0000-00aa-199901000000",
      day: "00000000-0000-0000-00dd-199901010000",
    });
  });

  it("parses ISO dates strictly (leap years in, impossible dates out)", () => {
    expect(parseIsoDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(() => parseIsoDate("2026-02-30")).toThrow(/no such calendar day/);
    expect(() => parseIsoDate("2026-13-01")).toThrow(/no such calendar day/);
    expect(() => parseIsoDate("2026-09-27T10:00:00")).toThrow(/invalid ISO date/);
    expect(() => parseIsoDate("not a date")).toThrow(/invalid ISO date/);
  });

  it("parseDateNodeId round-trips the generators (parse_date_uuid port)", () => {
    for (const v of V1_VECTORS) {
      expect(parseDateNodeId(v.day)).toEqual({
        precision: "day",
        year: Number(v.iso.slice(0, 4)),
        month: Number(v.iso.slice(5, 7)),
        day: Number(v.iso.slice(8, 10)),
      });
      expect(parseDateNodeId(v.month)).toMatchObject({ precision: "month" });
      expect(parseDateNodeId(v.year)).toMatchObject({ precision: "year" });
    }
  });

  it("parseDateNodeId returns null for non-date ids and the year window", () => {
    expect(parseDateNodeId("0192a000-0000-7000-8000-000000000001")).toBeNull();
    expect(parseDateNodeId("not-a-uuid")).toBeNull();
    // parse_date_uuid accepts only 1900..2200.
    expect(parseDateNodeId("00000000-0000-0000-00bb-185000000000")).toBeNull();
    expect(parseDateNodeId("00000000-0000-0000-00bb-230100000000")).toBeNull();
    expect(parseDateNodeId(yearNodeId("1900-06-15"))).toMatchObject({ precision: "year", year: 1900 });
    expect(parseDateNodeId(yearNodeId("2200-06-15"))).toMatchObject({ precision: "year", year: 2200 });
  });

  it("labels mirror the journal names (year YYYY0000, month YYYYMM00, day YYYYMMDD)", () => {
    const parts = { year: 2026, month: 9, day: 27 };
    expect(dateNodeLabel(parts, "year")).toBe("20260000");
    expect(dateNodeLabel(parts, "month")).toBe("20260900");
    expect(dateNodeLabel(parts, "day")).toBe("20260927");
  });
});
