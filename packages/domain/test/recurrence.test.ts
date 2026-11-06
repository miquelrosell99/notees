/**
 * RR5 recurrence grammar + expansion tests: canonical RRULE round-trips,
 * the fail-loud rejection corpus, RR5 expansion pins (interval, BYDAY,
 * BYMONTHDAY, COUNT/UNTIL ends, exdates), and the legacy-grammar converter.
 */

import { describe, expect, it } from "vitest";

import {
  completedOccurrencesOf,
  exdatesOf,
  formatRecurrenceRule,
  legacyRecurrenceToRRule,
  occurrenceIsosOf,
  parseRecurrenceRule,
  RECURRENCE_DEFAULT_CAP,
  RECURRENCE_WEEKDAYS,
  recurrenceRuleOf,
  recurrenceSeriesOf,
  spanEndOf,
  untilOf,
  weekdayOfIso,
  withCompletedOccurrence,
  withExdate,
  withSpanEnd,
  withUntil,
  RecurrenceParseError,
  type RecurrenceRule,
} from "../src/index.js";

describe("parseRecurrenceRule / formatRecurrenceRule (RR5)", () => {
  const canonical: Array<[RecurrenceRule, string]> = [
    [{ freq: "weekly", interval: 1 }, "RRULE:FREQ=WEEKLY"],
    [{ freq: "daily", interval: 2 }, "RRULE:FREQ=DAILY;INTERVAL=2"],
    [
      { freq: "weekly", interval: 1, byday: ["MO", "TU", "FR"] },
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,FR",
    ],
    [
      { freq: "monthly", interval: 1, bymonthday: [3, 15] },
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=3,15",
    ],
    [{ freq: "daily", interval: 1, count: 10 }, "RRULE:FREQ=DAILY;COUNT=10"],
    [
      { freq: "monthly", interval: 1, until: "2026-12-31" },
      "RRULE:FREQ=MONTHLY;UNTIL=20261231",
    ],
    [
      { freq: "weekly", interval: 2, byday: ["WE"], count: 10 },
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=10",
    ],
  ];

  it("round-trips the canonical table through format→parse", () => {
    for (const [rule, text] of canonical) {
      expect(formatRecurrenceRule(rule)).toBe(text);
      expect(parseRecurrenceRule(text)).toEqual(rule);
    }
  });

  it("normalizes unsorted BYDAY / BYMONTHDAY to canonical order", () => {
    expect(parseRecurrenceRule("RRULE:FREQ=WEEKLY;BYDAY=FR,MO,TU")).toEqual({
      freq: "weekly",
      interval: 1,
      byday: ["MO", "TU", "FR"],
    });
    expect(parseRecurrenceRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=15,3")).toEqual({
      freq: "monthly",
      interval: 1,
      bymonthday: [3, 15],
    });
    // Format emits the canonical order even from an unsorted rule object.
    expect(formatRecurrenceRule({ freq: "weekly", interval: 1, byday: ["FR", "MO"] })).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=MO,FR",
    );
  });

  it("parses UNTIL into an inclusive ISO day", () => {
    expect(parseRecurrenceRule("RRULE:FREQ=YEARLY;UNTIL=20280229")).toEqual({
      freq: "yearly",
      interval: 1,
      until: "2028-02-29",
    });
  });

  it("accepts an explicit INTERVAL=1 and leading zeros, normalizing both away", () => {
    expect(parseRecurrenceRule("RRULE:FREQ=DAILY;INTERVAL=1")).toEqual({
      freq: "daily",
      interval: 1,
    });
    expect(parseRecurrenceRule("RRULE:FREQ=WEEKLY;INTERVAL=02")).toEqual({
      freq: "weekly",
      interval: 2,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseRecurrenceRule("  RRULE:FREQ=WEEKLY  ")).toEqual({ freq: "weekly", interval: 1 });
  });

  it("rejects the rejection corpus with RecurrenceParseError", () => {
    for (const bad of [
      // legacy forms (the retired <freq>[/<n>] grammar)
      "daily",
      "weekly/2",
      "weekdays",
      // COUNT + UNTIL together
      "RRULE:FREQ=DAILY;COUNT=3;UNTIL=20260101",
      // invalid values
      "RRULE:FREQ=WEEKLY;BYDAY=XX",
      "RRULE:FREQ=HOURLY",
      "RRULE:FREQ=daily",
      "RRULE:FREQ=DAILY;INTERVAL=0",
      "RRULE:FREQ=DAILY;INTERVAL=1000",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=0",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=32",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=3,",
      "RRULE:FREQ=DAILY;COUNT=0",
      "RRULE:FREQ=DAILY;UNTIL=20260230",
      "RRULE:FREQ=DAILY;UNTIL=20261301",
      "RRULE:FREQ=DAILY;UNTIL=2026-01-01",
      // unknown keys / malformed segments / non-canonical key order
      "RRULE:FREQ=DAILY;BYSETPOS=1",
      "RRULE:FREQ=DAILY;FREQ=WEEKLY",
      "RRULE:FREQ=DAILY;",
      "RRULE:BYDAY=MO;FREQ=WEEKLY",
      "RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=2",
      "RRULE:FREQ=WEEKLY;UNTIL=20261231;BYDAY=MO",
      // FREQ missing
      "RRULE:INTERVAL=2",
      "RRULE:",
      "",
      // non-strings
      null,
      42,
      {},
      ["RRULE:FREQ=DAILY"],
    ]) {
      expect(() => parseRecurrenceRule(bad), JSON.stringify(bad)).toThrow(RecurrenceParseError);
    }
  });

  it("rejects an interval above the cap with the bound in the message", () => {
    expect(() => parseRecurrenceRule("RRULE:FREQ=DAILY;INTERVAL=1000")).toThrow(/999/);
  });
});

describe("weekdayOfIso / RECURRENCE_WEEKDAYS", () => {
  it("exposes the canonical weekday order and maps ISO days to codes", () => {
    // 2026-10-04 is a Sunday.
    expect(RECURRENCE_WEEKDAYS).toEqual(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
    expect(weekdayOfIso("2026-10-04")).toBe("SU");
    expect(weekdayOfIso("2026-10-05")).toBe("MO");
    expect(weekdayOfIso("2026-10-07")).toBe("WE");
    expect(weekdayOfIso("2026-10-10")).toBe("SA");
  });
});

describe("legacyRecurrenceToRRule", () => {
  it("converts the five legacy freqs using the anchor", () => {
    expect(legacyRecurrenceToRRule("daily", "2026-10-07")).toBe("RRULE:FREQ=DAILY");
    expect(legacyRecurrenceToRRule("weekly", "2026-10-07")).toBe("RRULE:FREQ=WEEKLY;BYDAY=WE");
    expect(legacyRecurrenceToRRule("weekdays", "2026-10-07")).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    );
    expect(legacyRecurrenceToRRule("monthly", "2026-10-07")).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=7",
    );
    expect(legacyRecurrenceToRRule("yearly", "2026-10-07")).toBe("RRULE:FREQ=YEARLY");
  });

  it("carries an explicit interval", () => {
    expect(legacyRecurrenceToRRule("weekly/2", "2026-10-07")).toBe(
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
    );
    expect(legacyRecurrenceToRRule("daily/3", "2026-10-07")).toBe("RRULE:FREQ=DAILY;INTERVAL=3");
  });

  it("derives the weekday / day-of-month from the anchor day", () => {
    expect(legacyRecurrenceToRRule("weekly", "2026-10-05")).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(legacyRecurrenceToRRule("monthly", "2026-01-31")).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=31",
    );
  });

  it("converts to strings the RR5 parser accepts", () => {
    for (const grammar of ["daily", "weekly", "weekdays", "monthly", "yearly", "weekly/2"]) {
      expect(() => parseRecurrenceRule(legacyRecurrenceToRRule(grammar, "2026-10-07"))).not.toThrow();
    }
  });

  it("throws on unknown grammar", () => {
    for (const bad of ["fortnightly", "weekly/0", "weekdays/2", "weekly/", "DAILY", "", "whenever"]) {
      expect(() => legacyRecurrenceToRRule(bad, "2026-10-07"), JSON.stringify(bad)).toThrow(
        RecurrenceParseError,
      );
    }
  });
});

describe("recurrenceRuleOf (repeat value read)", () => {
  it("returns null when the value is absent", () => {
    expect(recurrenceRuleOf(null)).toBeNull();
    expect(recurrenceRuleOf(undefined)).toBeNull();
  });

  it("parses the stored RRULE string", () => {
    expect(recurrenceRuleOf("RRULE:FREQ=MONTHLY")).toEqual({ freq: "monthly", interval: 1 });
    expect(recurrenceRuleOf("RRULE:FREQ=WEEKLY;BYDAY=MO,FR")).toEqual({
      freq: "weekly",
      interval: 1,
      byday: ["MO", "FR"],
    });
  });

  it("fails loud on a present-but-corrupt value", () => {
    expect(() => recurrenceRuleOf("daily")).toThrow(RecurrenceParseError); // legacy form
    expect(() => recurrenceRuleOf("whenever")).toThrow(RecurrenceParseError);
    expect(() => recurrenceRuleOf(42)).toThrow(RecurrenceParseError);
  });

  it("a {nodeId} carrier must be resolved by the caller before reading", () => {
    expect(() => recurrenceRuleOf({ nodeId: "00000000-0000-0000-0000-000000000000" })).toThrow(
      RecurrenceParseError,
    );
  });
});

describe("occurrenceIsosOf (RR5 expansion)", () => {
  it("daily: every day across a month boundary", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 1 }, anchorIso: "2026-10-30" },
        "2026-10-30",
        "2026-11-02",
      ),
    ).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("every 2 days over a 10-day window", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 2 }, anchorIso: "2026-10-01" },
        "2026-10-01",
        "2026-10-10",
      ),
    ).toEqual(["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-07", "2026-10-09"]);
  });

  it("daily with an interval: the anchor day is occurrence #1", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 3 }, anchorIso: "2026-10-01" },
        "2026-10-01",
        "2026-10-10",
      ),
    ).toEqual(["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"]);
  });

  it("weekly without BYDAY recurs on the anchor's weekday", () => {
    // Anchor Wednesday 2026-10-07; the window starts on the Monday before.
    expect(
      occurrenceIsosOf(
        { rule: { freq: "weekly", interval: 1 }, anchorIso: "2026-10-07" },
        "2026-10-05",
        "2026-10-19",
      ),
    ).toEqual(["2026-10-07", "2026-10-14"]);
  });

  it("weekly with BYDAY=MO,FR — every Monday and Friday of each week", () => {
    // Anchor Monday 2026-10-05.
    expect(
      occurrenceIsosOf(
        { rule: { freq: "weekly", interval: 1, byday: ["MO", "FR"] }, anchorIso: "2026-10-05" },
        "2026-10-05",
        "2026-10-18",
      ),
    ).toEqual(["2026-10-05", "2026-10-09", "2026-10-12", "2026-10-16"]);
  });

  it("weekdays Mon–Fri via BYDAY (the retired 'weekdays' freq)", () => {
    // 2026-10-02 is a Friday; 10-03/10-04 are the weekend.
    expect(
      occurrenceIsosOf(
        {
          rule: { freq: "weekly", interval: 1, byday: ["MO", "TU", "WE", "TH", "FR"] },
          anchorIso: "2026-10-01",
        },
        "2026-10-01",
        "2026-10-08",
      ),
    ).toEqual(["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
  });

  it("weekly interval 2 steps whole weeks — BYDAY days in skipped weeks never occur", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "weekly", interval: 2, byday: ["MO", "FR"] }, anchorIso: "2026-10-05" },
        "2026-10-05",
        "2026-10-31",
      ),
    ).toEqual(["2026-10-05", "2026-10-09", "2026-10-19", "2026-10-23"]);
  });

  it("monthly on the anchor's day-of-month, skipping months that lack it", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "monthly", interval: 1 }, anchorIso: "2026-01-31" },
        "2026-01-31",
        "2026-06-30",
      ),
    ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });

  it("monthly with BYMONTHDAY=3 across a February boundary", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "monthly", interval: 1, bymonthday: [3] }, anchorIso: "2025-12-03" },
        "2025-12-01",
        "2026-03-31",
      ),
    ).toEqual(["2025-12-03", "2026-01-03", "2026-02-03", "2026-03-03"]);
  });

  it("a BYMONTHDAY the month lacks never occurs (day 31 in February)", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "monthly", interval: 1, bymonthday: [31] }, anchorIso: "2026-01-31" },
        "2026-01-31",
        "2026-05-31",
      ),
    ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });

  it("monthly with an interval", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "monthly", interval: 2 }, anchorIso: "2026-01-15" },
        "2026-01-15",
        "2026-07-15",
      ),
    ).toEqual(["2026-01-15", "2026-03-15", "2026-05-15", "2026-07-15"]);
  });

  it("yearly: a Feb 29 anchor occurs only in leap years, never clamped", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "yearly", interval: 1 }, anchorIso: "2024-02-29" },
        "2023-01-01",
        "2028-12-31",
      ),
    ).toEqual(["2024-02-29", "2028-02-29"]);
  });

  it("yearly with an interval counts years, skipping non-leap ones", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "yearly", interval: 2 }, anchorIso: "2024-02-29" },
        "2024-01-01",
        "2032-12-31",
      ),
    ).toEqual(["2024-02-29", "2028-02-29", "2032-02-29"]);
  });

  it("COUNT ends the series after N generated occurrences — the anchor counts", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 1, count: 3 }, anchorIso: "2026-10-01" },
        "2026-10-01",
        "2026-11-30",
      ),
    ).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("COUNT counts every BYDAY occurrence in order", () => {
    expect(
      occurrenceIsosOf(
        {
          rule: { freq: "weekly", interval: 1, byday: ["MO", "FR"], count: 5 },
          anchorIso: "2026-10-05",
        },
        "2026-10-01",
        "2026-11-30",
      ),
    ).toEqual(["2026-10-05", "2026-10-09", "2026-10-12", "2026-10-16", "2026-10-19"]);
  });

  it("UNTIL is an inclusive bound", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 1, until: "2026-10-03" }, anchorIso: "2026-10-01" },
        "2026-10-01",
        "2026-10-10",
      ),
    ).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("exdates remove occurrences and do NOT shift COUNT indices", () => {
    expect(
      occurrenceIsosOf(
        {
          rule: { freq: "daily", interval: 1, count: 3 },
          anchorIso: "2026-10-01",
          exdates: ["2026-10-02"],
        },
        "2026-10-01",
        "2026-10-31",
      ),
    ).toEqual(["2026-10-01", "2026-10-03"]);
  });

  it("the rule's UNTIL and the metadata until both bound the series", () => {
    expect(
      occurrenceIsosOf(
        {
          rule: { freq: "daily", interval: 1, until: "2026-10-02" },
          anchorIso: "2026-10-01",
          until: "2026-10-03",
        },
        "2026-10-01",
        "2026-10-10",
      ),
    ).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("windows ending before the anchor are empty; the anchor is occurrence #1", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 1 }, anchorIso: "2026-10-04" },
        "2026-10-01",
        "2026-10-03",
      ),
    ).toEqual([]);
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 1 }, anchorIso: "2026-10-04" },
        "2026-09-01",
        "2026-10-04",
      ),
    ).toEqual(["2026-10-04"]);
  });

  it("expands a far-future window bounded by the window, not the anchor gap", () => {
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 7 }, anchorIso: "2026-01-01" },
        "2026-12-01",
        "2026-12-20",
      ),
    ).toEqual(["2026-12-03", "2026-12-10", "2026-12-17"]);
    expect(
      occurrenceIsosOf(
        { rule: { freq: "monthly", interval: 1 }, anchorIso: "2020-01-31" },
        "2026-10-01",
        "2026-12-31",
      ),
    ).toEqual(["2026-10-31", "2026-12-31"]);
  });

  it("COUNT reaches back across the anchor-to-window gap (indices count from the anchor)", () => {
    // Daily COUNT=3 ends the series on 2026-10-03 — long before the window.
    expect(
      occurrenceIsosOf(
        { rule: { freq: "daily", interval: 1, count: 3 }, anchorIso: "2026-10-01" },
        "2026-12-01",
        "2026-12-31",
      ),
    ).toEqual([]);
    // Monthly BYMONTHDAY=31 skips February — the COUNT index does not count
    // the skipped month as an occurrence.
    expect(
      occurrenceIsosOf(
        { rule: { freq: "monthly", interval: 1, bymonthday: [31], count: 3 }, anchorIso: "2026-01-31" },
        "2026-01-31",
        "2026-12-31",
      ),
    ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });

  it("weekly COUNT pre-counts a block-0 BYDAY weekday preceding the anchor's", () => {
    // Anchor Wednesday 2026-10-07; BYDAY=MO,WE ⇒ #1 Wed 10-07, #2 Mon 10-12,
    // #3 Wed 10-14, #4 Mon 10-19. The window starts after #2, so the
    // pre-count must account for both block-0 occurrences — 10-19 is #4,
    // past COUNT=3.
    expect(
      occurrenceIsosOf(
        {
          rule: { freq: "weekly", interval: 1, byday: ["MO", "WE"], count: 3 },
          anchorIso: "2026-10-07",
        },
        "2026-10-13",
        "2026-10-31",
      ),
    ).toEqual(["2026-10-14"]);
  });

  it("weekly INTERVAL=2 + COUNT: block 0 counts exactly, skipped weeks give no index", () => {
    // Anchor Tuesday 2026-10-20; BYDAY=MO,WE ⇒ block 0: Wed 10-21 (#1),
    // Mon 10-26 (#2); block 2: Wed 11-04 (#3), Mon 11-09 (#4). COUNT=4 ends
    // the series — Wed 12-02 (block 4) is #5 and must not appear.
    expect(
      occurrenceIsosOf(
        {
          rule: { freq: "weekly", interval: 2, byday: ["MO", "WE"], count: 4 },
          anchorIso: "2026-10-20",
        },
        "2026-11-01",
        "2026-12-31",
      ),
    ).toEqual(["2026-11-04", "2026-11-09"]);
  });

  it("an in-window occurrence of the anchor-weekday-preceding BYDAY still consumes its COUNT index", () => {
    // Same series with COUNT=3: #3 = Wed 11-04, so Mon 11-09 — the in-window
    // occurrence of the weekday preceding the anchor's — is #4 and is
    // dropped even though the walk sees it.
    expect(
      occurrenceIsosOf(
        {
          rule: { freq: "weekly", interval: 2, byday: ["MO", "WE"], count: 3 },
          anchorIso: "2026-10-20",
        },
        "2026-10-27",
        "2026-12-31",
      ),
    ).toEqual(["2026-11-04"]);
  });

  it("truncates at the cap and honors an explicit cap", () => {
    const wide = occurrenceIsosOf(
      { rule: { freq: "daily", interval: 1 }, anchorIso: "2026-01-01" },
      "2026-01-01",
      "2027-12-31",
    );
    expect(wide).toHaveLength(RECURRENCE_DEFAULT_CAP);
    expect(wide[0]).toBe("2026-01-01");
    expect(wide.at(-1)).toBe("2027-01-01"); // 366th day of a daily series

    const capped = occurrenceIsosOf(
      { rule: { freq: "daily", interval: 1 }, anchorIso: "2026-01-01" },
      "2026-01-01",
      "2026-01-10",
      3,
    );
    expect(capped).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  it("fails loud on a reversed window, a bad cap, or a bad anchor", () => {
    const series = { rule: { freq: "daily" as const, interval: 1 }, anchorIso: "2026-01-01" };
    expect(() => occurrenceIsosOf(series, "2026-01-02", "2026-01-01")).toThrow(
      /invalid recurrence window/,
    );
    expect(() => occurrenceIsosOf(series, "2026-01-01", "2026-01-02", 0)).toThrow(
      /invalid recurrence cap/,
    );
    expect(() => occurrenceIsosOf(series, "2026-01-01", "2026-01-02", 1.5)).toThrow(
      /invalid recurrence cap/,
    );
    expect(() =>
      occurrenceIsosOf({ ...series, anchorIso: "not-a-date" }, "2026-01-01", "2026-01-02"),
    ).toThrow(/invalid ISO date/);
  });
});

describe("completedOccurrencesOf / withCompletedOccurrence", () => {
  it("absent or null metadata reads as no completed occurrences", () => {
    expect(completedOccurrencesOf(null)).toEqual([]);
    expect(completedOccurrencesOf(undefined)).toEqual([]);
    expect(completedOccurrencesOf({ completedOccurrences: null })).toEqual([]);
  });

  it("reads the list sorted and deduped", () => {
    expect(
      completedOccurrencesOf({ completedOccurrences: ["2026-10-10", "2026-10-03", "2026-10-03"] }),
    ).toEqual(["2026-10-03", "2026-10-10"]);
  });

  it("fails loud on a corrupt list — never reads as 'nothing completed'", () => {
    expect(() => completedOccurrencesOf({ completedOccurrences: "2026-10-04" })).toThrow(
      /invalid completedOccurrences/,
    );
    expect(() => completedOccurrencesOf({ completedOccurrences: [42] })).toThrow(
      /invalid completedOccurrences entry/,
    );
    expect(() =>
      completedOccurrencesOf({ completedOccurrences: ["2026-10-04", "not-a-date"] }),
    ).toThrow(/invalid completedOccurrences entry/);
    expect(() => completedOccurrencesOf({ completedOccurrences: ["2026-02-30"] })).toThrow(
      /invalid completedOccurrences entry/,
    );
  });

  it("withCompletedOccurrence records and reopens one occurrence", () => {
    const meta = { until: "2026-11-30" };
    const done = withCompletedOccurrence(meta, "2026-10-06", true);
    expect(done).toEqual({ until: "2026-11-30", completedOccurrences: ["2026-10-06"] });
    // Sorted accumulation, other keys untouched.
    const twice = withCompletedOccurrence(done, "2026-10-13", true);
    expect(twice).toEqual({
      until: "2026-11-30",
      completedOccurrences: ["2026-10-06", "2026-10-13"],
    });
    // Reopening removes only that date; clearing the list drops the key.
    const reopened = withCompletedOccurrence(twice, "2026-10-06", false);
    expect(reopened).toEqual({ until: "2026-11-30", completedOccurrences: ["2026-10-13"] });
    expect(withCompletedOccurrence(reopened, "2026-10-13", false)).toEqual({ until: "2026-11-30" });
    // The input is never mutated.
    expect(meta).toEqual({ until: "2026-11-30" });
  });

  it("withCompletedOccurrence fails loud on a garbage date or corrupt prior list", () => {
    expect(() => withCompletedOccurrence({}, "tomorrow", true)).toThrow(
      /invalid occurrence date/,
    );
    expect(() => withCompletedOccurrence({ completedOccurrences: [1] }, "2026-10-06", true)).toThrow(
      /invalid completedOccurrences entry/,
    );
  });
});

describe("recurrence exceptions (exdates / until)", () => {
  const weekly = { rule: { freq: "weekly" as const, interval: 1 }, anchorIso: "2026-10-05" };

  it("exdatesOf / untilOf read absent as default and throw on malformed", () => {
    expect(exdatesOf(null)).toEqual([]);
    expect(exdatesOf({ exdates: null })).toEqual([]);
    expect(exdatesOf({ exdates: ["2026-10-12", "2026-10-12", "2026-10-05"] })).toEqual([
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(() => exdatesOf({ exdates: "nope" })).toThrow(/invalid exdates/);
    expect(() => exdatesOf({ exdates: ["2026-13-40"] })).toThrow(/invalid exdates entry/);
    expect(untilOf(null)).toBeNull();
    expect(untilOf({ until: "2026-10-19" })).toBe("2026-10-19");
    expect(() => untilOf({ until: 42 })).toThrow(/invalid until/);
  });

  it("recurrenceSeriesOf assembles rule + exceptions from the value metadata; null when no rule", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=WEEKLY");
    expect(recurrenceSeriesOf(rule, {}, "2026-10-05")).toEqual({
      rule: { freq: "weekly", interval: 1 },
      anchorIso: "2026-10-05",
    });
    expect(
      recurrenceSeriesOf(
        parseRecurrenceRule("RRULE:FREQ=WEEKLY;INTERVAL=2"),
        { exdates: ["2026-10-19"], until: "2026-11-30" },
        "2026-10-05",
      ),
    ).toEqual({
      rule: { freq: "weekly", interval: 2 },
      anchorIso: "2026-10-05",
      exdates: ["2026-10-19"],
      until: "2026-11-30",
    });
    expect(recurrenceSeriesOf(null, { exdates: ["2026-10-19"] }, "2026-10-05")).toBeNull();
    expect(() => recurrenceSeriesOf(rule, { exdates: "garbage" }, "2026-10-05")).toThrow();
  });

  it("expansion skips exdates without stopping the walk", () => {
    const isos = occurrenceIsosOf(
      { ...weekly, exdates: ["2026-10-12"] },
      "2026-10-05",
      "2026-10-26",
    );
    expect(isos).toEqual(["2026-10-05", "2026-10-19", "2026-10-26"]);
  });

  it("expansion stops at until (inclusive bound)", () => {
    const isos = occurrenceIsosOf({ ...weekly, until: "2026-10-19" }, "2026-10-05", "2026-11-30");
    expect(isos).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
  });

  it("a series with the anchor past until has no occurrences", () => {
    expect(
      occurrenceIsosOf({ ...weekly, until: "2026-10-01" }, "2026-10-01", "2026-11-30"),
    ).toEqual([]);
  });

  it("withExdate adds sorted and never drops sibling metadata", () => {
    const next = withExdate(
      { until: "2026-11-30", completedOccurrences: ["2026-10-05"] },
      "2026-10-12",
    );
    expect(next).toEqual({
      until: "2026-11-30",
      completedOccurrences: ["2026-10-05"],
      exdates: ["2026-10-12"],
    });
    expect(withExdate(next, "2026-10-05").exdates).toEqual(["2026-10-05", "2026-10-12"]);
    expect(() => withExdate({}, "not-a-date")).toThrow(/invalid occurrence date/);
  });

  it("withUntil sets or clears the bound, keeping sibling metadata", () => {
    expect(withUntil({ completedOccurrences: ["2026-10-05"] }, "2026-10-19")).toEqual({
      completedOccurrences: ["2026-10-05"],
      until: "2026-10-19",
    });
    const cleared = withUntil({ until: "2026-10-19" }, null);
    expect("until" in cleared).toBe(false);
    expect(() => withUntil({}, "2026-10-32")).toThrow(/invalid until/);
  });
});

describe("multi-day spans (the datetime-range ruling)", () => {
  it("spanEndOf reads absent as null and throws on malformed", () => {
    expect(spanEndOf(null)).toBeNull();
    expect(spanEndOf({})).toBeNull();
    expect(spanEndOf({ endDate: "2026-10-08" })).toBe("2026-10-08");
    expect(() => spanEndOf({ endDate: 42 })).toThrow(/invalid endDate/);
    expect(() => spanEndOf({ endDate: "2026-10-32" })).toThrow(/invalid endDate/);
  });

  it("withSpanEnd sets or clears, keeping sibling metadata", () => {
    expect(withSpanEnd({ until: "2026-10-19" }, "2026-10-08")).toEqual({
      until: "2026-10-19",
      endDate: "2026-10-08",
    });
    const cleared = withSpanEnd({ endDate: "2026-10-08" }, null);
    expect("endDate" in cleared).toBe(false);
    expect(() => withSpanEnd({}, "nope")).toThrow(/invalid endDate/);
  });
});
