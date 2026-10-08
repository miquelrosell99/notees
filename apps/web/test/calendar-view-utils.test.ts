/**
 * CalendarView pure-logic tests: the local-day helpers, the ISO week, the
 * created-today UTC bounds from a local date, the open-task AST (negated-eq
 * arms — never neq), the scheduled/overdue/future partition, and the
 * quick-create chip qualification (task prefers taskScheduled; date-chain
 * and class system classes excluded).
 */

import { describe, expect, it } from "vitest";

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import {
  addDaysIso,
  buildCreatedTodayAst,
  buildOpenTasksAst,
  closedStatusOptionIds,
  createdTodayBounds,
  dateChipCandidates,
  isoWeekNumber,
  partitionOpenTasks,
  todayIsoLocal,
  weekdayLabel,
  type OpenTaskRow,
} from "../src/ui/components/calendarViewUtils.js";

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

  it("buildCreatedTodayAst carries the window over createdAfter/createdBefore and keeps main nodes only", () => {
    const ast = buildCreatedTodayAst("2026-10-02");
    expect(ast.root.logic).toBe("and");
    const children = ast.root.children;
    expect(children).toHaveLength(3);
    const after = children[0] as { type: string; timestamp: string };
    const before = children[1] as { type: string; timestamp: string };
    expect(after.type).toBe("createdAfter");
    expect(before.type).toBe("createdBefore");
    expect(after.timestamp).toBe(createdTodayBounds("2026-10-02").after);
    expect(before.timestamp).toBe(createdTodayBounds("2026-10-02").before);
    // Main nodes only: classes or present-as-main — blocks never list.
    expect(children[2]).toEqual({
      type: "group",
      logic: "or",
      children: [
        { type: "isClass", isClass: true },
        { type: "presentAsMain", presentAsMain: true },
      ],
    });
  });
});

describe("buildOpenTasksAst", () => {
  it("is class:task AND scheduled exists AND one negated-eq arm per closed status — never neq", () => {
    const ast = buildOpenTasksAst(["opt-done", "opt-cancelled"]);
    expect(ast.scope).toEqual({ type: "entire_workspace" });
    const children = ast.root.children;
    expect(children[0]).toEqual({ type: "class", classId: SYSTEM_CLASS_UUIDS.task });
    expect(children[1]).toEqual({
      type: "property",
      schemaId: SYSTEM_PROPERTY_UUIDS.taskScheduled,
      op: "exists",
    });
    expect(children[2]).toEqual({
      type: "not",
      child: {
        type: "property",
        schemaId: SYSTEM_PROPERTY_UUIDS.taskStatus,
        op: "eq",
        value: "opt-done",
      },
    });
    expect(children[3]).toEqual({
      type: "not",
      child: {
        type: "property",
        schemaId: SYSTEM_PROPERTY_UUIDS.taskStatus,
        op: "eq",
        value: "opt-cancelled",
      },
    });
    // The compiler caveat in code: no neq anywhere in the tree.
    expect(JSON.stringify(ast)).not.toContain('"neq"');
  });

  it("closedStatusOptionIds resolves only Done/Cancelled labels", () => {
    const ids = closedStatusOptionIds({
      options: [
        { id: "a", label: "Backlog" },
        { id: "b", label: "Doing" },
        { id: "c", label: "Done" },
        { id: "d", label: "Cancelled" },
      ],
    });
    expect(ids).toEqual(["c", "d"]);
    expect(closedStatusOptionIds({ options: null })).toEqual([]);
    expect(closedStatusOptionIds(undefined)).toEqual([]);
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

describe("dateChipCandidates", () => {
  const bindingsOf =
    (map: Record<string, Array<{ propertySchemaId: string; type: string; name?: string }>>) =>
    (classId: string) =>
      map[classId] ?? [];

  it("qualifies classes with a date-typed binding and sorts by label", () => {
    const chips = dateChipCandidates(
      [
        { id: "cls-b", name: "Meeting" },
        { id: "cls-a", name: "Booking" },
        { id: "cls-c", name: "Plain" },
      ],
      bindingsOf({
        "cls-b": [{ propertySchemaId: "sch-when", type: "date", name: "When" }],
        "cls-a": [{ propertySchemaId: "sch-date", type: "date", name: "Date" }],
        "cls-c": [{ propertySchemaId: "sch-note", type: "text" }],
      }),
    );
    expect(chips).toEqual([
      { classId: "cls-a", schemaId: "sch-date", label: "Booking", propertyName: "Date" },
      { classId: "cls-b", schemaId: "sch-when", label: "Meeting", propertyName: "When" },
    ]);
  });

  it("task prefers taskScheduled over other date bindings", () => {
    const chips = dateChipCandidates(
      [{ id: SYSTEM_CLASS_UUIDS.task, name: "task" }],
      bindingsOf({
        [SYSTEM_CLASS_UUIDS.task]: [
          { propertySchemaId: "sch-other-date", type: "date" },
          { propertySchemaId: SYSTEM_PROPERTY_UUIDS.taskScheduled, type: "date" },
          { propertySchemaId: "sch-aaa", type: "date" },
        ],
      }),
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]!.schemaId).toBe(SYSTEM_PROPERTY_UUIDS.taskScheduled);
    expect(chips[0]!.propertyName).toBeNull();
  });

  it("other classes with several date bindings take the first sorted schema id", () => {
    const chips = dateChipCandidates(
      [{ id: "cls-x", name: "X" }],
      bindingsOf({
        "cls-x": [
          { propertySchemaId: "sch-zzz", type: "date" },
          { propertySchemaId: "sch-aaa", type: "date" },
        ],
      }),
    );
    expect(chips[0]!.schemaId).toBe("sch-aaa");
  });

  it("excludes the date-chain classes", () => {
    const chips = dateChipCandidates(
      [
        { id: SYSTEM_CLASS_UUIDS.year, name: "year" },
        { id: SYSTEM_CLASS_UUIDS.month, name: "month" },
        { id: SYSTEM_CLASS_UUIDS.day, name: "day" },
        { id: "cls-ok", name: "OK" },
      ],
      () => [{ propertySchemaId: "sch-date", type: "date" }],
    );
    expect(chips.map((chip) => chip.classId)).toEqual(["cls-ok"]);
  });
});
