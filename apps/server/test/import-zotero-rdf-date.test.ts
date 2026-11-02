/**
 * The Zotero RDF importer's date parser (scripts/import-zotero-rdf.mts,
 * parseRdfDate) — the tiers between strict ISO and hand-resolution.
 *
 * Zotero exports `dc:date` verbatim from the user's library, so real files
 * carry human dates the strict ISO tier rejected (~8% of one real library).
 * Rules pinned here:
 *  - strict ISO unchanged: "2022" / "2022-03" / "2022-03-15" at their
 *    precisions; invalid calendars ("2016-13-01") still rejected;
 *  - full month name + year, case-insensitive, optional comma ("June 2016",
 *    "JUNE 2022", "June, 2016") → month precision; English AND Spanish full
 *    names (the owner's library is ES/EN); abbreviations stay rejected;
 *  - day + month name + year ("14 June 2024", "26 April 2024",
 *    "14 junio 2024") → day precision, real-calendar validated
 *    ("31 June 2024" has no June 31st — rejected);
 *  - numeric MM/YYYY ("01/2022", "4/1997") → month precision, MM must be
 *    01-12 ("13/2022" rejected);
 *  - STILL rejected for hand-resolution: two-slash all-numeric dates
 *    ("01/12/2025" — ambiguous DD/MM vs MM/DD), empty, garbage.
 */

import { describe, expect, it } from "vitest";

import { parseRdfDate } from "../../../scripts/import-zotero-rdf.mts";

describe("parseRdfDate", () => {
  it("keeps the strict ISO tier at its precisions", () => {
    expect(parseRdfDate("2022")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("2022-03")).toEqual({ iso: "2022-03-01", precision: "month" });
    expect(parseRdfDate("2022-03-15")).toEqual({ iso: "2022-03-15", precision: "day" });
  });

  it("accepts full English month name + year, case-insensitive", () => {
    expect(parseRdfDate("June 2016")).toEqual({ iso: "2016-06-01", precision: "month" });
    expect(parseRdfDate("JUNE 2022")).toEqual({ iso: "2022-06-01", precision: "month" });
    expect(parseRdfDate("May 2021")).toEqual({ iso: "2021-05-01", precision: "month" });
  });

  it("accepts the comma form (\"June, 2016\")", () => {
    expect(parseRdfDate("June, 2016")).toEqual({ iso: "2016-06-01", precision: "month" });
  });

  it("accepts Spanish full month names + year", () => {
    expect(parseRdfDate("enero 2020")).toEqual({ iso: "2020-01-01", precision: "month" });
    expect(parseRdfDate("JUNIO 2022")).toEqual({ iso: "2022-06-01", precision: "month" });
    expect(parseRdfDate("diciembre 1997")).toEqual({ iso: "1997-12-01", precision: "month" });
  });

  it("accepts day + month name + year at day precision", () => {
    expect(parseRdfDate("14 June 2024")).toEqual({ iso: "2024-06-14", precision: "day" });
    expect(parseRdfDate("26 April 2024")).toEqual({ iso: "2024-04-26", precision: "day" });
    expect(parseRdfDate("14 junio 2024")).toEqual({ iso: "2024-06-14", precision: "day" });
  });

  it("calendar-validates the day + month name tier", () => {
    expect(parseRdfDate("31 June 2024")).toBeNull(); // June has 30 days.
    expect(parseRdfDate("29 February 2021")).toBeNull(); // not a leap year.
    expect(parseRdfDate("29 February 2024")).toEqual({ iso: "2024-02-29", precision: "day" });
  });

  it("accepts numeric MM/YYYY at month precision", () => {
    expect(parseRdfDate("01/2022")).toEqual({ iso: "2022-01-01", precision: "month" });
    expect(parseRdfDate("04/1997")).toEqual({ iso: "1997-04-01", precision: "month" });
    expect(parseRdfDate("03/2021")).toEqual({ iso: "2021-03-01", precision: "month" });
    expect(parseRdfDate("08/2015")).toEqual({ iso: "2015-08-01", precision: "month" });
    expect(parseRdfDate("02/2007")).toEqual({ iso: "2007-02-01", precision: "month" });
  });

  it("rejects MM/YYYY with MM outside 01-12", () => {
    expect(parseRdfDate("13/2022")).toBeNull();
    expect(parseRdfDate("00/2022")).toBeNull();
  });

  it("still rejects the hand-resolution shapes", () => {
    expect(parseRdfDate("01/12/2025")).toBeNull(); // two-slash all-numeric — ambiguous.
    expect(parseRdfDate("2016-13-01")).toBeNull(); // invalid month in the ISO tier.
    expect(parseRdfDate("")).toBeNull();
    expect(parseRdfDate("not a date")).toBeNull();
    expect(parseRdfDate("Jun 2016")).toBeNull(); // abbreviations stay out of scope.
    expect(parseRdfDate("June")).toBeNull(); // a name without a year is nothing.
  });
});
