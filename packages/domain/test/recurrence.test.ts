/**
 * Recurrence grammar + expansion tests (§34.28 #6, compute-on-read ruling):
 * canonical-string round-trips, fail-loud garbage, month-boundary / leap-year
 * / cap behavior of occurrenceIsosOf.
 */

import { describe, expect, it } from "vitest";

import {
  completedOccurrencesOf,
  formatRecurrenceRule,
  occurrenceIsosOf,
  parseRecurrenceRule,
  RECURRENCE_DEFAULT_CAP,
  recurrenceRuleOf,
  withCompletedOccurrence,
  type RecurrenceRule,
} from "../src/index.js";

describe("parseRecurrenceRule / formatRecurrenceRule", () => {
  it("parses every bare freq", () => {
    expect(parseRecurrenceRule("daily")).toEqual({ freq: "daily", interval: 1 });
    expect(parseRecurrenceRule("weekly")).toEqual({ freq: "weekly", interval: 1 });
    expect(parseRecurrenceRule("weekdays")).toEqual({ freq: "weekdays", interval: 1 });
    expect(parseRecurrenceRule("monthly")).toEqual({ freq: "monthly", interval: 1 });
    expect(parseRecurrenceRule("yearly")).toEqual({ freq: "yearly", interval: 1 });
  });

  it("parses an explicit interval", () => {
    expect(parseRecurrenceRule("daily/3")).toEqual({ freq: "daily", interval: 3 });
    expect(parseRecurrenceRule("weekly/2")).toEqual({ freq: "weekly", interval: 2 });
    expect(parseRecurrenceRule("monthly/12")).toEqual({ freq: "monthly", interval: 12 });
    expect(parseRecurrenceRule("yearly/5")).toEqual({ freq: "yearly", interval: 5 });
  });

  it("accepts and normalizes interval 1 and leading zeros", () => {
    expect(parseRecurrenceRule("daily/1")).toEqual({ freq: "daily", interval: 1 });
    expect(parseRecurrenceRule("weekly/02")).toEqual({ freq: "weekly", interval: 2 });
    expect(formatRecurrenceRule({ freq: "daily", interval: 1 })).toBe("daily");
    expect(formatRecurrenceRule({ freq: "weekly", interval: 2 })).toBe("weekly/2");
  });

  it("trims surrounding whitespace", () => {
    expect(parseRecurrenceRule("  weekly  ")).toEqual({ freq: "weekly", interval: 1 });
  });

  it("round-trips every freq × interval through format→parse", () => {
    const rules: RecurrenceRule[] = [
      { freq: "daily", interval: 1 },
      { freq: "weekly", interval: 1 },
      { freq: "weekdays", interval: 1 },
      { freq: "monthly", interval: 1 },
      { freq: "yearly", interval: 1 },
      { freq: "daily", interval: 4 },
      { freq: "weekly", interval: 2 },
      { freq: "monthly", interval: 6 },
      { freq: "yearly", interval: 3 },
    ];
    for (const rule of rules) {
      expect(parseRecurrenceRule(formatRecurrenceRule(rule))).toEqual(rule);
    }
  });

  it("fails loud on garbage", () => {
    for (const garbage of [
      "",
      "hourly",
      "DAILY",
      "week",
      "weekly/0",
      "weekly/-2",
      "weekly/2.5",
      "weekly/1000",
      "weekly/",
      "daily/2/extra",
      "weekdays/2",
      "every day",
      null,
      42,
      {},
      ["daily"],
    ]) {
      expect(() => parseRecurrenceRule(garbage), JSON.stringify(garbage)).toThrow(
        /invalid recurrence rule/,
      );
    }
  });

  it("rejects interval above the cap with the bound in the message", () => {
    expect(() => parseRecurrenceRule("daily/1000")).toThrow(/999/);
  });
});

describe("recurrenceRuleOf (metadata read)", () => {
  it("returns null when metadata is absent or the key is missing/null", () => {
    expect(recurrenceRuleOf(null)).toBeNull();
    expect(recurrenceRuleOf(undefined)).toBeNull();
    expect(recurrenceRuleOf({})).toBeNull();
    expect(recurrenceRuleOf({ startDate: "2026-01-01" })).toBeNull();
    expect(recurrenceRuleOf({ repeat: null })).toBeNull();
  });

  it("parses the stored string", () => {
    expect(recurrenceRuleOf({ repeat: "monthly" })).toEqual({ freq: "monthly", interval: 1 });
  });

  it("fails loud on a present-but-corrupt rule", () => {
    expect(() => recurrenceRuleOf({ repeat: "whenever" })).toThrow(/invalid recurrence rule/);
  });
});

describe("occurrenceIsosOf", () => {
  it("daily: every day across a month boundary", () => {
    expect(
      occurrenceIsosOf({ rule: { freq: "daily", interval: 1 }, anchorIso: "2026-10-30" },
        "2026-10-30", "2026-11-02"),
    ).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("daily with an interval", () => {
    expect(
      occurrenceIsosOf({ rule: { freq: "daily", interval: 3 }, anchorIso: "2026-10-01" },
        "2026-10-01", "2026-10-10"),
    ).toEqual(["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"]);
  });

  it("weekly: same weekday, stepping 7×interval days", () => {
    // 2026-10-04 is a Sunday.
    expect(
      occurrenceIsosOf({ rule: { freq: "weekly", interval: 1 }, anchorIso: "2026-10-04" },
        "2026-10-04", "2026-10-25"),
    ).toEqual(["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"]);
    expect(
      occurrenceIsosOf({ rule: { freq: "weekly", interval: 2 }, anchorIso: "2026-10-04" },
        "2026-10-04", "2026-11-30"),
    ).toEqual(["2026-10-04", "2026-10-18", "2026-11-01", "2026-11-15", "2026-11-29"]);
  });

  it("weekdays: Mon–Fri only, weekends skipped", () => {
    // 2026-10-02 is a Friday; 10-03/10-04 are the weekend.
    expect(
      occurrenceIsosOf({ rule: { freq: "weekdays", interval: 1 }, anchorIso: "2026-10-01" },
        "2026-10-01", "2026-10-08"),
    ).toEqual(["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
  });

  it("monthly: same day-of-month, skipping months that lack it", () => {
    expect(
      occurrenceIsosOf({ rule: { freq: "monthly", interval: 1 }, anchorIso: "2026-01-31" },
        "2026-01-31", "2026-06-30"),
    ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });

  it("monthly with an interval", () => {
    expect(
      occurrenceIsosOf({ rule: { freq: "monthly", interval: 2 }, anchorIso: "2026-01-15" },
        "2026-01-15", "2026-07-15"),
    ).toEqual(["2026-01-15", "2026-03-15", "2026-05-15", "2026-07-15"]);
  });

  it("yearly: leap-day anchors skip non-leap years", () => {
    expect(
      occurrenceIsosOf({ rule: { freq: "yearly", interval: 1 }, anchorIso: "2024-02-29" },
        "2024-02-29", "2032-12-31"),
    ).toEqual(["2024-02-29", "2028-02-29", "2032-02-29"]);
  });

  it("yearly from a fixed date", () => {
    expect(
      occurrenceIsosOf({ rule: { freq: "yearly", interval: 1 }, anchorIso: "2026-10-04" },
        "2026-10-04", "2029-12-31"),
    ).toEqual(["2026-10-04", "2027-10-04", "2028-10-04", "2029-10-04"]);
  });

  it("the anchor itself is occurrence #0; windows before it are empty", () => {
    expect(
      occurrenceIsosOf({ rule: { freq: "daily", interval: 1 }, anchorIso: "2026-10-04" },
        "2026-10-01", "2026-10-03"),
    ).toEqual([]);
    expect(
      occurrenceIsosOf({ rule: { freq: "daily", interval: 1 }, anchorIso: "2026-10-04" },
        "2026-10-05", "2026-10-06"),
    ).toEqual(["2026-10-05", "2026-10-06"]);
    expect(
      occurrenceIsosOf({ rule: { freq: "daily", interval: 1 }, anchorIso: "2026-10-04" },
        "2026-09-01", "2026-10-04"),
    ).toEqual(["2026-10-04"]);
  });

  it("starts a far future window analytically (no per-day walk from the anchor)", () => {
    expect(
      occurrenceIsosOf({ rule: { freq: "daily", interval: 7 }, anchorIso: "2026-01-01" },
        "2026-12-01", "2026-12-20"),
    ).toEqual(["2026-12-03", "2026-12-10", "2026-12-17"]);
    expect(
      occurrenceIsosOf({ rule: { freq: "monthly", interval: 1 }, anchorIso: "2020-01-31" },
        "2026-10-01", "2026-12-31"),
    ).toEqual(["2026-10-31", "2026-12-31"]);
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

describe("completedOccurrencesOf / withCompletedOccurrence (§34.69)", () => {
  it("absent or null metadata reads as no completed occurrences", () => {
    expect(completedOccurrencesOf(null)).toEqual([]);
    expect(completedOccurrencesOf(undefined)).toEqual([]);
    expect(completedOccurrencesOf({ repeat: "weekly" })).toEqual([]);
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
    const meta = { repeat: "weekly" };
    const done = withCompletedOccurrence(meta, "2026-10-06", true);
    expect(done).toEqual({ repeat: "weekly", completedOccurrences: ["2026-10-06"] });
    // Sorted accumulation, other keys untouched.
    const twice = withCompletedOccurrence(done, "2026-10-13", true);
    expect(twice).toEqual({ repeat: "weekly", completedOccurrences: ["2026-10-06", "2026-10-13"] });
    // Reopening removes only that date; clearing the list drops the key.
    const reopened = withCompletedOccurrence(twice, "2026-10-06", false);
    expect(reopened).toEqual({ repeat: "weekly", completedOccurrences: ["2026-10-13"] });
    expect(withCompletedOccurrence(reopened, "2026-10-13", false)).toEqual({ repeat: "weekly" });
    // The input is never mutated.
    expect(meta).toEqual({ repeat: "weekly" });
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
