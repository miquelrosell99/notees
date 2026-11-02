/**
 * The Zotero RDF importer's date parser (scripts/import-zotero-rdf.mts,
 * parseRdfDate) — the tiers between strict ISO and hand-resolution.
 *
 * Zotero exports `dc:date` verbatim from the user's library, so real files
 * carry human dates the strict ISO tier rejected (~8% of one real library).
 * Rules pinned here:
 *  - strict ISO unchanged: "2022" / "2022-03" / "2022-03-15" at their
 *    precisions; invalid calendars ("2016-13-01") still rejected; the tier
 *    is end-anchored — trailing garbage ("2022-03-15foo", "2023/09/07")
 *    rejects instead of silently reading a year prefix; bibliographic
 *    DECORATIONS are not garbage: a sanitation pre-pass (whitespace, one
 *    trailing period — twice for "2022.." — trailing comma, whole-string
 *    "(...)" / "[...]" wrappers, leading circa markers "c2022" / "ca. 2022")
 *    strips them before the tiers, so "2022.", "(2022)", "June 2016." parse
 *    while infix garbage ("2022 (repr.)") stays null;
 *  - full month name + year, case-insensitive, optional comma ("June 2016",
 *    "JUNE 2022", "June, 2016") → month precision; English AND Spanish full
 *    names (the owner's library is ES/EN); abbreviations stay rejected;
 *  - day + month name + year ("14 June 2024", "26 April 2024",
 *    "14 junio 2024") → day precision, real-calendar validated
 *    ("31 June 2024" has no June 31st — rejected);
 *  - numeric MM/YYYY ("01/2022", "4/1997") → month precision, MM must be
 *    01-12 ("13/2022" rejected);
 *  - owner-locale tiers (single-owner deployment, owner-locale Spanish —
 *    the rulings are explicit, not inferred): all-numeric three-part
 *    DD/MM/YYYY and DD-MM-YYYY at day precision ("07/09/2023",
 *    "12-06-2023", single-digit days like "8/05/2015"), real-calendar
 *    validated; day ranges "D-D Month YYYY" take the start day ("2-6 July
 *    2023"); Spanish "de" long form with the second de optional
 *    ("28 de julio de 2023", "28 de julio 2023"); month-first
 *    ("March 13 2013", "March 13, 2013") — EN or ES month names, both
 *    deliberate; PubMed/MEDLINE year-first "YYYY Mon [D]" with exactly
 *    3-letter English abbreviations ("2023 Sep" → month, "2024 Dec 11" →
 *    day; "2023 Sept" rejects), real-calendar validated; year-first month
 *    ranges "YYYY Mon-Mon" take the start month ("2023 Mar-Apr" →
 *    2023-03; "2023 Dec-Jan" rejects like the day-range ruling); ISO
 *    datetimes ("2023-10-05 18:10:23", "2025-08-15T11:49:34+00:00")
 *    strip the time part and parse the leading date; non-padded ISO
 *    ("2010-2-24", "2025-8") and year-first slashes ("2012/1", "2012/1/24")
 *    zero-pad into the iso;
 *  - STILL rejected for hand-resolution: ambiguous shapes stay out
 *    ("31/02/2024" is not a real date), empty, garbage.
 */

import { describe, expect, it } from "vitest";

import { parseRdfDate } from "../../../scripts/import-zotero-rdf.mts";

describe("parseRdfDate", () => {
  it("keeps the strict ISO tier at its precisions", () => {
    expect(parseRdfDate("2022")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("2022-03")).toEqual({ iso: "2022-03-01", precision: "month" });
    expect(parseRdfDate("2022-03-15")).toEqual({ iso: "2022-03-15", precision: "day" });
  });

  it("rejects strict ISO prefixes with trailing garbage (end-anchored)", () => {
    expect(parseRdfDate("2022-03-15foo")).toBeNull();
    expect(parseRdfDate("2022 (repr.)")).toBeNull(); // infix garbage — a year prefix is not a year.
    expect(parseRdfDate("2022-03-15 (print)")).toBeNull(); // same, at day precision.
  });

  it("parses 4-digit-first slash dates as year-first (the YYYY/M[/D] tier)", () => {
    // Formerly rejected ("no tier claimed this") — now deliberately claimed:
    // a 4-digit-first three-part slash date is unambiguously year-first.
    expect(parseRdfDate("2023/09/07")).toEqual({ iso: "2023-09-07", precision: "day" });
  });

  it("sanitizes decorated dates before the tiers", () => {
    // Trailing period (once, twice), whole-string wrappers, circa markers.
    expect(parseRdfDate("2022.")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("2022..")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("(2022)")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("[2022]")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("June 2016.")).toEqual({ iso: "2016-06-01", precision: "month" });
    expect(parseRdfDate("(June 2016)")).toEqual({ iso: "2016-06-01", precision: "month" });
    expect(parseRdfDate("c2022")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("C2022")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("ca. 2022")).toEqual({ iso: "2022-01-01", precision: "year" });
    expect(parseRdfDate("ca 2022")).toEqual({ iso: "2022-01-01", precision: "year" });
  });

  it("parses PubMed year-first 'YYYY Mon [D]' at month/day precision", () => {
    expect(parseRdfDate("2023 Sep")).toEqual({ iso: "2023-09-01", precision: "month" });
    expect(parseRdfDate("2022 Aug")).toEqual({ iso: "2022-08-01", precision: "month" });
    expect(parseRdfDate("2023 SEP")).toEqual({ iso: "2023-09-01", precision: "month" });
    expect(parseRdfDate("2024 Dec 11")).toEqual({ iso: "2024-12-11", precision: "day" });
  });

  it("keeps the PubMed tier minimal: exactly 3-letter abbreviations", () => {
    expect(parseRdfDate("2023 Sept")).toBeNull(); // 4 letters — out of scope.
    expect(parseRdfDate("2023 Se")).toBeNull(); // 2 letters — out of scope.
    expect(parseRdfDate("2023 Sep 31")).toBeNull(); // September has 30 days.
  });

  it("parses ISO datetimes at the leading date's precision", () => {
    expect(parseRdfDate("2023-10-05 18:10:23")).toEqual({ iso: "2023-10-05", precision: "day" });
    expect(parseRdfDate("2025-08-15T11:49:34+00:00")).toEqual({ iso: "2025-08-15", precision: "day" });
    expect(parseRdfDate("2023-10-05T18:10Z")).toEqual({ iso: "2023-10-05", precision: "day" });
  });

  it("rejects datetimes with an invalid time or date part", () => {
    expect(parseRdfDate("2023-10-05 25:99:99")).toBeNull(); // no such time.
    expect(parseRdfDate("2023-10-05 xyz")).toBeNull(); // junk after the date.
    expect(parseRdfDate("2023-13-05 18:10:23")).toBeNull(); // invalid month in the date part.
  });

  it("accepts non-padded strict ISO month/day, zero-padded in the iso", () => {
    expect(parseRdfDate("2010-2-24")).toEqual({ iso: "2010-02-24", precision: "day" });
    expect(parseRdfDate("2025-8")).toEqual({ iso: "2025-08-01", precision: "month" });
    expect(parseRdfDate("2010-13-24")).toBeNull(); // calendar-validated.
  });

  it("accepts year-first slash YYYY/M and YYYY/M/D", () => {
    expect(parseRdfDate("2012/1")).toEqual({ iso: "2012-01-01", precision: "month" });
    expect(parseRdfDate("2012/1/24")).toEqual({ iso: "2012-01-24", precision: "day" });
    expect(parseRdfDate("2012/13")).toBeNull(); // MM must be 01-12.
    expect(parseRdfDate("2012/1/32")).toBeNull(); // calendar-validated.
  });

  it("parses year-first month ranges at the start month", () => {
    expect(parseRdfDate("2023 Mar-Apr")).toEqual({ iso: "2023-03-01", precision: "month" });
    expect(parseRdfDate("2021 Oct-Dec")).toEqual({ iso: "2021-10-01", precision: "month" });
    expect(parseRdfDate("2023 Jan-Mar")).toEqual({ iso: "2023-01-01", precision: "month" });
    expect(parseRdfDate("2023 MAR-APR")).toEqual({ iso: "2023-03-01", precision: "month" });
    expect(parseRdfDate("2023 Dec-Jan")).toBeNull(); // range folds the year — start > end, like the day-range ruling.
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

  it("parses owner-locale all-numeric DD/MM/YYYY at day precision", () => {
    expect(parseRdfDate("07/09/2023")).toEqual({ iso: "2023-09-07", precision: "day" });
    expect(parseRdfDate("15/02/2023")).toEqual({ iso: "2023-02-15", precision: "day" });
    expect(parseRdfDate("11/03/2020")).toEqual({ iso: "2020-03-11", precision: "day" });
    expect(parseRdfDate("22/05/2024")).toEqual({ iso: "2024-05-22", precision: "day" });
    expect(parseRdfDate("8/05/2015")).toEqual({ iso: "2015-05-08", precision: "day" });
    expect(parseRdfDate("01/12/2025")).toEqual({ iso: "2025-12-01", precision: "day" });
  });

  it("parses owner-locale all-numeric DD-MM-YYYY at day precision", () => {
    expect(parseRdfDate("12-06-2023")).toEqual({ iso: "2023-06-12", precision: "day" });
  });

  it("calendar-validates the all-numeric tier and keeps MM/YYYY at month", () => {
    expect(parseRdfDate("31/02/2024")).toBeNull(); // February has no 31st.
    expect(parseRdfDate("01/2022")).toEqual({ iso: "2022-01-01", precision: "month" });
    expect(parseRdfDate("13/2022")).toBeNull(); // two-part MM/YYYY, MM 13 — rejected, not day 13.
  });

  it("parses day ranges 'D-D Month YYYY' at the start day", () => {
    expect(parseRdfDate("2-6 July 2023")).toEqual({ iso: "2023-07-02", precision: "day" });
    expect(parseRdfDate("2-6 julio 2023")).toEqual({ iso: "2023-07-02", precision: "day" });
  });

  it("parses the Spanish 'de' long form, second de optional, case-insensitive", () => {
    expect(parseRdfDate("28 de julio de 2023")).toEqual({ iso: "2023-07-28", precision: "day" });
    expect(parseRdfDate("28 de julio 2023")).toEqual({ iso: "2023-07-28", precision: "day" });
    expect(parseRdfDate("18 de diciembre de 2023")).toEqual({ iso: "2023-12-18", precision: "day" });
    expect(parseRdfDate("28 DE JULIO DE 2023")).toEqual({ iso: "2023-07-28", precision: "day" });
  });

  it("parses month-first 'Month D YYYY' (EN or ES month names) at day precision", () => {
    expect(parseRdfDate("March 13 2013")).toEqual({ iso: "2013-03-13", precision: "day" });
    expect(parseRdfDate("March 13, 2013")).toEqual({ iso: "2013-03-13", precision: "day" });
    expect(parseRdfDate("marzo 13 2013")).toEqual({ iso: "2013-03-13", precision: "day" });
  });

  it("still rejects the hand-resolution shapes", () => {
    expect(parseRdfDate("2016-13-01")).toBeNull(); // invalid month in the ISO tier.
    expect(parseRdfDate("")).toBeNull();
    expect(parseRdfDate("not a date")).toBeNull();
    expect(parseRdfDate("Jun 2016")).toBeNull(); // abbreviations stay out of scope.
    expect(parseRdfDate("June")).toBeNull(); // a name without a year is nothing.
  });
});
