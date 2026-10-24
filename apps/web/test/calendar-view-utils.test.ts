/**
 * Calendar pure-logic tests: the local-day helpers, the ISO week, the
 * created-today UTC bounds from a local date, the datetime slot helpers
 * (points, ranges, clock times — SCHEMA.md "Datetime"), and the
 * scheduled/overdue/future task partition.
 */

import { describe, expect, it } from "vitest";

import {
  addDaysIso,
  createdTodayBounds,
  dayNodeId,
  isoWeekNumber,
  partitionOpenTasks,
  scheduledIsoOf,
  slotTimeOf,
  timeOfValue,
  timePrefixOfValue,
  todayIsoLocal,
  weekdayLabel,
  type OpenTaskRow,
} from "../src/features/calendar/calendarViewUtils.js";

describe("local-day helpers", () => {
  it("todayIsoLocal is a zero-padded local YYYY-MM-DD", () => {
    expect(todayIsoLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date();
    expect(todayIsoLocal()).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
        now.getDate(),
      ).padStart(2, "0")}`,
    );
  });

  it("addDaysIso steps across month and year boundaries", () => {
    expect(addDaysIso("2026-10-02", 1)).toBe("2026-10-03");
    expect(addDaysIso("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysIso("2024-02-28", 1)).toBe("2024-02-29"); // leap year
  });

  it("isoWeekNumber follows ISO-8601 (Mon-first) week boundaries", () => {
    expect(isoWeekNumber("2026-01-01")).toBe(1);
    expect(isoWeekNumber("2026-10-02")).toBe(40);
    expect(isoWeekNumber("2021-01-01")).toBe(53); // belongs to 2020's last week
    expect(isoWeekNumber("2019-12-30")).toBe(1); // Monday of the new ISO year
  });

  it("weekdayLabel is locale-aware and calendar-consistent", () => {
    const friday = weekdayLabel("2026-10-02");
    expect(friday.length).toBeGreaterThan(0);
    // Seven days apart is always the same weekday, whatever the locale.
    expect(weekdayLabel("2026-10-09")).toBe(friday);
    expect(weekdayLabel("2026-10-03")).not.toBe(friday);
  });
});

describe("createdTodayBounds", () => {
  it("spans the selected local day in UTC ISO-8601 (lexicographic query arms)", () => {
    const iso = "2026-10-02";
    const { after, before } = createdTodayBounds(iso);
    expect(after).toBe(new Date("2026-10-02T00:00:00.000").toISOString());
    expect(before).toBe(new Date("2026-10-02T23:59:59.999").toISOString());
    expect(after < before).toBe(true);
    expect(after.endsWith("Z")).toBe(true);
  });
});

describe("datetime slot helpers (points, ranges, times)", () => {
  const dayA = dayNodeId("2026-10-02");
  const dayB = dayNodeId("2026-10-04");

  it("scheduledIsoOf resolves a point's own day, strictly at day precision", () => {
    expect(scheduledIsoOf({ nodeId: dayA })).toBe("2026-10-02");
    expect(scheduledIsoOf({ nodeId: dayA, time: "14:30" })).toBe("2026-10-02");
    expect(scheduledIsoOf({ nodeId: "00000000-0000-0000-00aa-202610000000" })).toBeNull();
    expect(scheduledIsoOf({ nodeId: "not-a-date" })).toBeNull();
    expect(scheduledIsoOf("2026-10-02")).toBeNull();
    expect(scheduledIsoOf(undefined)).toBeNull();
    expect(scheduledIsoOf(null)).toBeNull();
  });

  it("scheduledIsoOf resolves a range to the start day, falling back to the end's", () => {
    expect(scheduledIsoOf({ start: { nodeId: dayA }, end: { nodeId: dayB } })).toBe("2026-10-02");
    expect(scheduledIsoOf({ start: { nodeId: dayA, time: "14:30" }, end: { nodeId: dayB, time: "16:00" } })).toBe(
      "2026-10-02",
    );
    // An open start lands on the end slot's day.
    expect(scheduledIsoOf({ start: null, end: { nodeId: dayB } })).toBe("2026-10-04");
    // Both sides open (or non-day slots) resolve to nothing.
    expect(scheduledIsoOf({ start: null, end: null })).toBeNull();
  });

  it("timeOfValue reads the start slot's HH:MM — null for untimed values and ranges without a start time", () => {
    expect(timeOfValue({ nodeId: dayA, time: "14:30" })).toBe("14:30");
    expect(timeOfValue({ nodeId: dayA })).toBeNull();
    expect(timeOfValue({ start: { nodeId: dayA, time: "14:30" }, end: { nodeId: dayB, time: "16:00" } })).toBe(
      "14:30",
    );
    expect(timeOfValue({ start: { nodeId: dayA }, end: { nodeId: dayB } })).toBeNull();
    expect(timeOfValue({ start: null, end: { nodeId: dayB } })).toBeNull();
    expect(timeOfValue("junk")).toBeNull();
  });

  it("slotTimeOf reads one slot's time (null for untimed/malformed slots)", () => {
    expect(slotTimeOf({ nodeId: dayA, time: "09:05" })).toBe("09:05");
    expect(slotTimeOf({ nodeId: dayA })).toBeNull();
    expect(slotTimeOf(dayA)).toBeNull();
    expect(slotTimeOf(null)).toBeNull();
  });

  it("timePrefixOfValue pairs both times on the same day; otherwise the start time alone", () => {
    // Same-day timed range: the Google "14:30–16:00" register.
    expect(
      timePrefixOfValue({
        start: { nodeId: dayA, time: "14:30" },
        end: { nodeId: dayA, time: "16:00" },
      }),
    ).toBe("14:30–16:00");
    // A multi-day range shows the start time on its start day only.
    expect(
      timePrefixOfValue({ start: { nodeId: dayA, time: "14:30" }, end: { nodeId: dayB, time: "16:00" } }),
    ).toBe("14:30");
    // An untimed end (or an open end) leaves the bare start time.
    expect(timePrefixOfValue({ start: { nodeId: dayA, time: "14:30" }, end: { nodeId: dayA } })).toBe("14:30");
    // Untimed values carry no prefix.
    expect(timePrefixOfValue({ nodeId: dayA })).toBeNull();
    expect(timePrefixOfValue({ start: { nodeId: dayA }, end: { nodeId: dayB } })).toBeNull();
  });
});

describe("partitionOpenTasks", () => {
  it("buckets scheduled/overdue, drops future and closed rows, sorts by day", () => {
    const fixtures: OpenTaskRow[] = [
      { id: "a", scheduledIso: "2026-10-02", closed: false, repeat: null, completedOccurrences: [], occurrenceDone: false },
      { id: "b", scheduledIso: "2026-09-20", closed: false, repeat: null, completedOccurrences: [], occurrenceDone: false },
      { id: "c", scheduledIso: "2026-09-25", closed: false, repeat: null, completedOccurrences: [], occurrenceDone: false },
      { id: "d", scheduledIso: "2026-10-03", closed: false, repeat: null, completedOccurrences: [], occurrenceDone: false }, // future: ignored
      { id: "e", scheduledIso: "2026-10-02", closed: true, repeat: null, completedOccurrences: [], occurrenceDone: false }, // closed: ignored
      { id: "f", scheduledIso: null, closed: false, repeat: null, completedOccurrences: [], occurrenceDone: false }, // unparsable: ignored
    ];
    const { overdue, scheduled } = partitionOpenTasks(fixtures, "2026-10-02");
    expect(overdue.map((row) => row.id)).toEqual(["b", "c"]);
    expect(scheduled.map((row) => row.id)).toEqual(["a"]);
  });

  it("treats the selected day itself as scheduled, not overdue", () => {
    const { overdue, scheduled } = partitionOpenTasks(
      [{ id: "a", scheduledIso: "2026-10-02", closed: false, repeat: null, completedOccurrences: [], occurrenceDone: false }],
      "2026-10-02",
    );
    expect(overdue).toHaveLength(0);
    expect(scheduled.map((row) => row.id)).toEqual(["a"]);
  });

  it("a repeating task lands in scheduled on every occurrence day, never overdue", () => {
    const weekly = { freq: "weekly" as const, interval: 1 };
    const rows = [
      // Anchored 2026-10-04 (a Sunday); viewed day 2026-10-11 is an occurrence.
      {
        id: "series",
        scheduledIso: "2026-10-04",
        closed: false,
        repeat: weekly,
        completedOccurrences: [],
        occurrenceDone: false,
      },
      // A plain task two days past stays overdue — recurrence changed nothing.
      {
        id: "plain",
        scheduledIso: "2026-10-02",
        closed: false,
        repeat: null,
        completedOccurrences: [],
        occurrenceDone: false,
      },
    ];
    const { overdue, scheduled } = partitionOpenTasks(rows, "2026-10-11");
    expect(scheduled.map((row) => row.id)).toEqual(["series"]);
    expect(overdue.map((row) => row.id)).toEqual(["plain"]);

    // On a non-occurrence day after the anchor the series neither schedules
    // nor goes overdue (missed occurrences roll forward).
    const between = partitionOpenTasks(rows, "2026-10-08");
    expect(between.scheduled.map((row) => row.id)).toEqual([]);
    expect(between.overdue.map((row) => row.id)).toEqual(["plain"]);
  });

  it("an occurrence recorded done lists checked on its day and reopens nowhere else", () => {
    const weekly = { freq: "weekly" as const, interval: 1 };
    const rows = [
      {
        id: "series",
        scheduledIso: "2026-10-04",
        closed: false,
        repeat: weekly,
        completedOccurrences: ["2026-10-11"],
        occurrenceDone: false,
      },
    ];
    // The recorded day: still one row, flagged done.
    const onDoneDay = partitionOpenTasks(rows, "2026-10-11");
    expect(onDoneDay.scheduled.map((row) => row.id)).toEqual(["series"]);
    expect(onDoneDay.scheduled[0]!.occurrenceDone).toBe(true);
    // The next occurrence is untouched.
    const nextOccurrence = partitionOpenTasks(rows, "2026-10-18");
    expect(nextOccurrence.scheduled.map((row) => row.id)).toEqual(["series"]);
    expect(nextOccurrence.scheduled[0]!.occurrenceDone).toBe(false);
  });
});
