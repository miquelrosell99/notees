/**
 * Dates & daily-notes feature tests (day-page branch, bucketed
 * tasks, date bars, Ctrl+Shift+T, calendar breadth):
 *
 *  - pure helpers: partitionTasksIntoBuckets, weekDaysOfIso, isoOfDateParts,
 *    scheduledIsoOf.
 *  - openTodayKeyHandler: the Ctrl/Cmd+Shift+T chord (text-field guard).
 *  - PageView day branch: the DayPageHeader (weekday line above the title,
 *    the Today pill when the day is today, the Week-N flag after the
 *    dateFormat-formatted title; the ±1-day date bar is gone), the three
 *    lazy sections (hidden when empty, rows only after expand, the
 *    done-toggle write), embedded suppression.
 *  - TaskBuckets over HubView nav=tasks: the five buckets + counts, the
 *    done-toggle moving rows, the device-local collapse, the empty hub.
 *  - CalendarView breadth: event blocks mark the days that carry them.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  dayNodeId,
  parseDateNodeId,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { HubView } from "../src/ui/app/HubView.js";
import { openTodayKeyHandler } from "../src/ui/app/keymap.js";
import { CalendarView } from "../src/features/calendar/CalendarView.js";
import {
  addDaysIso,
  isoOfDateParts,
  partitionTasksIntoBuckets,
  scheduledIsoOf,
  todayIsoLocal,
  weekDaysOfIso,
  weekdayLabel,
  type TaskBucketRow,
} from "../src/features/calendar/calendarViewUtils.js";
import { DayStepper } from "../src/features/calendar/DayPageHeader.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  // jsdom lacks ResizeObserver; CalendarView's Tabs.List uses it.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** Server-style seed op the relay holds before the client bootstraps. */
type SeedPayload = { [key: string]: unknown };

function seedEnvelope(
  opType: string,
  payload: SeedPayload,
  affected: string[],
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: DEVICE,
    client: "seed",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

function seedClass(classId: string, name: string): Envelope {
  return seedEnvelope(
    "class.create",
    { classId, contentAst: [{ type: "text", text: name }] },
    [classId],
  );
}

/** A real workspace is server-seeded: task + date-chain system classes. */
function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedClass(SYSTEM_CLASS_UUIDS.task, "task"),
    seedClass(SYSTEM_CLASS_UUIDS.day, "day"),
    seedClass(SYSTEM_CLASS_UUIDS.month, "month"),
    seedClass(SYSTEM_CLASS_UUIDS.year, "year"),
  ]);
  return relay;
}

async function seedClient(relay: MemoryRelay = seededRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** The authored status schema + option-id resolver (after ensureTaskFamily). */
async function taskStatus(client: WorkspaceClient) {
  await ensureTaskFamily(client);
  const status = client
    .listPropertySchemas()
    .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
  return {
    schema: status,
    optionId: (label: string) => status.options!.find((option) => option.label === label)!.id,
  };
}

/** A task-classed page named `name`, optionally scheduled/deadlined/done. */
async function createTask(
  client: WorkspaceClient,
  name: string,
  opts: { scheduled?: string; deadline?: string; done?: boolean; priority?: string } = {},
): Promise<string> {
  const id = await client.createObject({
    isEmbedded: false,
    name,
    classIds: [SYSTEM_CLASS_UUIDS.task],
  });
  if (opts.scheduled !== undefined) {
    await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, { iso: opts.scheduled });
  }
  if (opts.deadline !== undefined) {
    await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskDeadline, { iso: opts.deadline });
  }
  if (opts.priority !== undefined) {
    const priority = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskPriority)!;
    await client.setProperty(
      id,
      priority.id,
      priority.options!.find((option) => option.label === opts.priority)!.id,
    );
  }
  if (opts.done === true) {
    const { schema, optionId } = await taskStatus(client);
    await client.setProperty(id, schema.id, optionId("Done"));
  }
  return id;
}

/** A titled class with a date-typed binding, and one instance dated `iso`. */
async function createDatedMeeting(
  client: WorkspaceClient,
  name: string,
  iso: string,
): Promise<string> {
  const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
  const classId = await client.createClass("meeting");
  await client.updateObject(classId, { contentAst: [{ type: "text", text: "meeting" }] });
  // The event family: the calendar's events element lists event-family
  // nodes. The event root may be absent from this spec's seed — author it
  // at its reserved id first (the ensureTaskFamily precedent).
  if (client.getNodeRaw(SYSTEM_CLASS_UUIDS.event) === undefined) {
    await client.createClass("event", { id: SYSTEM_CLASS_UUIDS.event });
  }
  await client.setClassExtends(classId, [SYSTEM_CLASS_UUIDS.event]);
  await client.setClassProperty(classId, schemaId, {});
  const id = await client.createObject({ isEmbedded: false, name, classIds: [classId] });
  await client.setDatetimeProperty(id, schemaId, { iso });
  return id;
}

/** The grid CELL (background click selects) for the given day of month —
    the day-NUMBER is the open-page affordance, not the selection. */
function dayCell(container: HTMLElement, dayNumber: string): HTMLElement {
  const suffix = `-${dayNumber.padStart(2, "0")}`;
  const matches = Array.from(
    container.querySelectorAll(`.cal-grid__cell[data-day$="${suffix}"]`),
  );
  const cell =
    matches.find((el) => !el.classList.contains("cal-grid__cell--outside")) ?? matches[0];
  expect(cell, `day cell ${dayNumber}`).toBeDefined();
  return cell as HTMLElement;
}

/**
 * The day-page aggregation sections wrapper — section queries scope to it:
 * the page footer's Created/Updated stamps also match loose name regexes.
 */
function daySections(): HTMLElement {
  const el = document.querySelector(".day-page-sections");
  expect(el, "day-page sections wrapper").not.toBeNull();
  return el as HTMLElement;
}

// --- pure helpers --------------------------------------------------------------

describe("calendarViewUtils day helpers", () => {
  it("isoOfDateParts round-trips with the deterministic id parse", () => {
    const iso = "2026-06-15";
    const parsed = parseDateNodeId(dayNodeId(iso));
    expect(parsed).not.toBeNull();
    expect(isoOfDateParts(parsed!)).toBe(iso);
  });

  it("scheduledIsoOf resolves day-precision refs only", () => {
    expect(scheduledIsoOf({ nodeId: dayNodeId("2026-06-15") })).toBe("2026-06-15");
    expect(
      scheduledIsoOf({ nodeId: "00000000-0000-0000-00aa-202606000000" }),
    ).toBeNull();
    expect(scheduledIsoOf({ nodeId: "not-a-date" })).toBeNull();
    expect(scheduledIsoOf("2026-06-15")).toBeNull();
    expect(scheduledIsoOf(undefined)).toBeNull();
  });

  it("weekDaysOfIso returns the containing week, honoring the first day", () => {
    // 2026-10-04 is a Sunday.
    const monFirst = weekDaysOfIso("2026-10-04", 1);
    expect(monFirst).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    const sunFirst = weekDaysOfIso("2026-10-04", 0);
    expect(sunFirst[0]).toBe("2026-10-04");
    expect(sunFirst).toHaveLength(7);
  });

  it("partitionTasksIntoBuckets places every row in exactly one bucket", () => {
    const row = (id: string, scheduledIso: string | null, deadlineIso: string | null, closed = false): TaskBucketRow => ({
      id,
      scheduledIso,
      deadlineIso,
      closed,
      drivingIso: null,
      priority: null,
      repeat: null,
      completedOccurrences: [],
      occurrenceDone: false,
    });
    const today = "2026-10-04";
    const buckets = partitionTasksIntoBuckets(
      [
        row("overdue-sched", "2026-10-01", null),
        row("overdue-deadline", null, "2026-10-03"),
        row("earliest-wins", "2026-10-04", "2026-10-01"), // deadline before scheduled
        row("today", today, null),
        row("upcoming-near", "2026-10-05", null),
        row("upcoming-far", "2027-03-10", null), // unbounded: never dropped
        row("unscheduled", null, null),
        row("done", "2026-10-01", null, true),
      ],
      today,
    );
    // Overdue/upcoming sort by the driving day, then id (earliest-wins'
    // deadline 10-01 ties overdue-sched's scheduled 10-01).
    expect(buckets.overdue.map((r) => r.id)).toEqual(["earliest-wins", "overdue-sched", "overdue-deadline"]);
    expect(buckets.today.map((r) => r.id)).toEqual(["today"]);
    expect(buckets.upcoming.map((r) => r.id)).toEqual(["upcoming-near", "upcoming-far"]);
    expect(buckets.upcoming[0]!.drivingIso).toBe("2026-10-05");
    expect(buckets.unscheduled.map((r) => r.id)).toEqual(["unscheduled"]);
    expect(buckets.completed.map((r) => r.id)).toEqual(["done"]);
    expect(buckets.overdue[0]!.drivingIso).toBe("2026-10-01");
  });

  it("partitionTasksIntoBuckets sorts open buckets priority-first (Urgent → Low, unprioritized last), completed stays id-ordered", () => {
    const row = (
      id: string,
      scheduledIso: string | null,
      priority: string | null,
      closed = false,
    ): TaskBucketRow => ({
      id,
      scheduledIso,
      deadlineIso: null,
      closed,
      drivingIso: null,
      priority,
      repeat: null,
      completedOccurrences: [],
      occurrenceDone: false,
    });
    const today = "2026-10-04";
    const buckets = partitionTasksIntoBuckets(
      [
        // Overdue: priority beats the driving day (Urgent 10-03 before Low 10-01).
        row("overdue-low", "2026-10-01", "Low"),
        row("overdue-urgent", "2026-10-03", "Urgent"),
        row("overdue-none", "2026-09-30", null),
        // Today: priority beats id.
        row("today-a-low", today, "Low"),
        row("today-z-high", today, "High"),
        // Upcoming: same priority falls back to the driving day.
        row("upcoming-high-late", "2026-10-09", "High"),
        row("upcoming-high-early", "2026-10-06", "High"),
        row("upcoming-medium", "2026-10-05", "Medium"),
        // Unscheduled: priority beats id; unknown labels rank unprioritized.
        row("unsched-a", null, null),
        row("unsched-z-urgent", null, "Urgent"),
        row("unsched-renamed", null, "P1"),
        // Completed: priority is an open-work signal — id order holds.
        row("done-z-urgent", "2026-10-01", "Urgent", true),
        row("done-a-low", "2026-10-01", "Low", true),
      ],
      today,
    );
    expect(buckets.overdue.map((r) => r.id)).toEqual(["overdue-urgent", "overdue-low", "overdue-none"]);
    expect(buckets.today.map((r) => r.id)).toEqual(["today-z-high", "today-a-low"]);
    expect(buckets.upcoming.map((r) => r.id)).toEqual([
      "upcoming-high-early",
      "upcoming-high-late",
      "upcoming-medium",
    ]);
    expect(buckets.unscheduled.map((r) => r.id)).toEqual(["unsched-z-urgent", "unsched-a", "unsched-renamed"]);
    expect(buckets.completed.map((r) => r.id)).toEqual(["done-a-low", "done-z-urgent"]);
  });

  it("taskPriorityRank: designed order reversed, null and unknown labels last", async () => {
    const { taskPriorityRank } = await import("../src/features/calendar/calendarViewUtils.js");
    expect(taskPriorityRank("Urgent")).toBeLessThan(taskPriorityRank("High"));
    expect(taskPriorityRank("High")).toBeLessThan(taskPriorityRank("Medium"));
    expect(taskPriorityRank("Medium")).toBeLessThan(taskPriorityRank("Low"));
    expect(taskPriorityRank("Low")).toBeLessThan(taskPriorityRank(null));
    expect(taskPriorityRank("P1")).toBe(taskPriorityRank(null));
  });
});

// --- #8 Ctrl+Shift+T -------------------------------------------------------------

describe("openTodayKeyHandler (Ctrl/Cmd+Shift+T)", () => {
  function press(init: KeyboardEventInit & { key: string }) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(event);
    return event;
  }

  it("opens today's day page via the ensure-chain read", async () => {
    const ensureDateChain = vi.fn(async (iso: string) => {
      expect(iso).toBe(todayIsoLocal());
      return { year: "y", month: "m", day: dayNodeId(iso) };
    });
    const openPage = vi.fn();
    const handler = openTodayKeyHandler({
      client: () => ({ ensureDateChain }) as never,
      openPage,
    });
    document.addEventListener("keydown", handler);
    try {
      const event = press({ key: "T", ctrlKey: true, shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(openPage).toHaveBeenCalledWith(dayNodeId(todayIsoLocal())));
    } finally {
      document.removeEventListener("keydown", handler);
    }
  });

  it("ignores the keystroke inside text fields and without the chord", async () => {
    const ensureDateChain = vi.fn();
    const openPage = vi.fn();
    const handler = openTodayKeyHandler({
      client: () => ({ ensureDateChain }) as never,
      openPage,
    });
    document.addEventListener("keydown", handler);
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      // The full chord aimed at a text field: kept for the editor.
      const fieldEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "T",
        ctrlKey: true,
        shiftKey: true,
      });
      input.dispatchEvent(fieldEvent);
      expect(fieldEvent.defaultPrevented).toBe(false);
      // Plain "t" (no modifiers) on the document: not the chord.
      press({ key: "t" });
      press({ key: "t", shiftKey: true });
      await flushWrites();
      expect(ensureDateChain).not.toHaveBeenCalled();
      expect(openPage).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", handler);
      input.remove();
    }
  });
});

// --- #4/#7/#15 the day-page branch ------------------------------------------------

describe("PageView day branch", () => {
  it("renders the DayPageHeader: weekday flag above the date title, the Week flag after it — the stepping lives in the top bar now", async () => {
    const client = await seedClient();
    const iso = "2026-06-15";
    const { day } = await client.ensureDateChain(iso);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} />);

    // The ‹ / › stepping moved to the MAIN TOP BAR (DayStepper); the header
    // stays the date's own chrome.
    expect(screen.queryByRole("button", { name: "Previous day" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next day" })).toBeNull();

    // The header IS the date header: the weekday flag rides a small line
    // above the title; the title is the user's dateFormat-formatted date
    // with the ISO week flag after it.
    const header = container.querySelector(".day-page-header") as HTMLElement;
    expect(header).not.toBeNull();
    expect(within(header).getByText(weekdayLabel(iso))).not.toBeNull();
    const heading = within(header).getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("2026-06-15"); // default YYYY-MM-DD
    expect(within(heading).getByText("Week 25")).not.toBeNull();
    // The "Today" PILL rides the flags line only when the day IS today
    // (the stepping bar's Today BUTTON is separate chrome).
    expect(header.querySelector(".day-page-header__today")).toBeNull();
  });

  it("renders the Today pill on today's day page", async () => {
    const client = await seedClient();
    const { day } = await client.ensureDateChain(todayIsoLocal());
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} />);
    const header = container.querySelector(".day-page-header") as HTMLElement;
    expect(header).not.toBeNull();
    // The Today PILL rides the flags; the Today BUTTON hides on today itself.
    expect(within(header).getByText("Today")).not.toBeNull();
    expect(within(header).queryByRole("button", { name: "Jump to today" })).toBeNull();
  });

  it("the DayStepper: chevrons around the bordered Today, stepping one day either side", async () => {
    const onNavigate = vi.fn();
    render(<DayStepper iso="2026-06-15" onNavigateDay={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(onNavigate).toHaveBeenLastCalledWith("2026-06-14");
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(onNavigate).toHaveBeenLastCalledWith("2026-06-16");
    fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));
    expect(onNavigate).toHaveBeenLastCalledWith(todayIsoLocal());
    // Today is the BORDERED variant between the ghost chevrons — and stays
    // visible on today itself (the calendar navigator's register).
    const today = within(screen.getByRole("group", { name: "Day navigation" }));
    const todayButton = today.getByRole("button", { name: "Jump to today" });
    expect(todayButton.className).toContain("border");
    render(<DayStepper iso={todayIsoLocal()} onNavigateDay={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Jump to today" }).length).toBeGreaterThan(0);
  });

  it("hides all three sections on an empty day page", async () => {
    const client = await seedClient();
    const { day } = await client.ensureDateChain("2026-06-15");
    await flushWrites();

    render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} />);
    await flushWrites();
    const sections = within(daySections());
    expect(sections.queryByRole("button", { name: /^tasks( \d+)?$/i })).toBeNull();
    expect(sections.queryByRole("button", { name: /dated/i })).toBeNull();
    expect(sections.queryByRole("button", { name: /created/i })).toBeNull();
    // The day header still renders (it is chrome, not an aggregation)…
    expect(screen.getByText(weekdayLabel("2026-06-15"))).toBeDefined();
    // …and the deleted date bar's stepping buttons stay gone.
    // The stepping lives in the main top bar (DayStepper) — not in the
    // page chrome.
    expect(screen.queryByRole("button", { name: "Previous day" })).toBeNull();
  });

  it("shows the Tasks section lazily and the done-toggle writes the status", async () => {
    const client = await seedClient();
    const iso = "2026-06-15";
    const { day } = await client.ensureDateChain(iso);
    const { schema, optionId } = await taskStatus(client);
    const taskId = await createTask(client, "Water the plants", { scheduled: iso });
    await flushWrites();

    render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} />);
    const toggle = within(daySections()).getByRole("button", { name: /^tasks( \d+)?$/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Lazy: no rows while collapsed. (Scope to the day sections: the
    // page-level backlinks strip loads on mount and lists the task too —
    // its scheduled date backlinks the day page.)
    expect(within(daySections()).queryByText("Water the plants")).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(within(daySections()).getByText("Water the plants")).toBeDefined(),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Mark task done" }));
    await flushWrites();
    await waitFor(() => {
      const value = client
        .getEffectiveProperties(taskId)
        .find((entry) => entry.propertySchemaId === schema.id)?.value;
      expect(value).toBe(optionId("Done"));
    });
    // The row leaves the open partition after the write lands (the backlinks
    // strip still lists it — the scheduled date edge is untouched by the
    // status write).
    await waitFor(() =>
      expect(within(daySections()).queryByText("Water the plants")).toBeNull(),
    );
  });

  it("shows the Dated section from the backlink set, tasks excluded", async () => {
    const client = await seedClient();
    const iso = "2026-06-15";
    const { day } = await client.ensureDateChain(iso);
    await createDatedMeeting(client, "Sync with Ada", iso);
    await createTask(client, "Task dated same day", { scheduled: iso });
    await flushWrites();

    render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} />);
    const toggle = within(daySections()).getByRole("button", { name: /dated/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    // Scope to the opened Dated section: the mount-loaded backlinks strip
    // lists both rows too (the dated objects backlink the day page).
    const dated = toggle.closest("section") as HTMLElement;
    await waitFor(() => expect(within(dated).getByText("Sync with Ada")).toBeDefined());
    // Tasks carry their own section — never a Dated row.
    expect(within(dated).queryByText("Task dated same day")).toBeNull();
  });

  it("shows the Created section for today, chain nodes excluded", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Fresh today" });
    const { day } = await client.ensureDateChain(todayIsoLocal());
    await flushWrites();

    render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} />);
    // The async count query lands, then the section appears.
    const toggle = await within(daySections()).findByRole(
      "button",
      { name: /created/i },
      { timeout: 3000 },
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Fresh today")).toBeDefined());
  });

  it("renders the date header and the sections when embedded", async () => {
    const client = await seedClient();
    const iso = "2026-06-15";
    const { day } = await client.ensureDateChain(iso);
    await taskStatus(client);
    await createTask(client, "Embedded task", { scheduled: iso });
    await flushWrites();

    render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} embedded />);
    await flushWrites();
    // Embedded day entries wear the date header too (the journal date-header
    // register: weekday, Today flag, ISO week on every day page) — and still
    // carry the day sections: the journal feed IS the day-page context.
    expect(document.querySelector(".day-page-header")).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^tasks( \d+)?$/i })).not.toBeNull(),
    );
  });
});

// --- #5 the bucketed tasks surface -------------------------------------------------

describe("TaskBuckets (tasks hub)", () => {
  it("partitions the hub members into the five buckets", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    await taskStatus(client);
    await createTask(client, "Overdue task", { scheduled: addDaysIso(today, -1) });
    await createTask(client, "Today task", { scheduled: today });
    await createTask(client, "Future task", { scheduled: addDaysIso(today, 4) });
    await createTask(client, "Undated task");
    await createTask(client, "Done task", { scheduled: today, done: true });
    await flushWrites();

    render(<HubView client={client} nav="tasks" onOpenNode={vi.fn()} />);
    const buckets = within(await screen.findByLabelText("Task buckets"));
    expect(buckets.getByText("4 open")).toBeDefined();
    for (const label of ["Overdue", "Today", "Upcoming", "Unscheduled", "Completed"]) {
      expect(buckets.getByText(label)).toBeDefined();
    }
    expect(buckets.getByText("Overdue task")).toBeDefined();
    expect(buckets.getByText("Today task")).toBeDefined();
    expect(buckets.getByText("Future task")).toBeDefined();
    expect(buckets.getByText("Undated task")).toBeDefined();
    expect(buckets.getByText("Done task")).toBeDefined();
  });

  it("renders the priority pill and orders each open bucket priority-first", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    await taskStatus(client);
    await createTask(client, "Plain today", { scheduled: today });
    await createTask(client, "Urgent today", { scheduled: today, priority: "Urgent" });
    await createTask(client, "Low today", { scheduled: today, priority: "Low" });
    await flushWrites();

    render(<HubView client={client} nav="tasks" onOpenNode={vi.fn()} />);
    const section = await screen.findByLabelText("Task buckets");
    const buckets = within(section);
    const names = [...section.querySelectorAll(".task-buckets__row-name")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Urgent today", "Low today", "Plain today"]);
    const urgentPill = buckets.getByText("Urgent");
    expect(urgentPill.closest(".pill")?.className).toContain("task-buckets__row-priority--urgent");
    expect(buckets.getByText("Low")).toBeDefined();
    // The unprioritized row renders no priority pill at all.
    expect(section.querySelectorAll(".task-buckets__row-priority")).toHaveLength(2);
  });

  it("the done-toggle moves the row into Completed", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { schema, optionId } = await taskStatus(client);
    const id = await createTask(client, "Toggle me", { scheduled: today });
    await flushWrites();

    render(<HubView client={client} nav="tasks" onOpenNode={vi.fn()} />);
    const buckets = within(await screen.findByLabelText("Task buckets"));
    fireEvent.click(buckets.getByRole("checkbox", { name: "Mark task done" }));
    await flushWrites();
    await waitFor(() => {
      const value = client
        .getEffectiveProperties(id)
        .find((entry) => entry.propertySchemaId === schema.id)?.value;
      expect(value).toBe(optionId("Done"));
    });
    // The row left the open buckets and re-renders checked under Completed.
    expect(buckets.queryByRole("checkbox", { name: "Mark task done" })).toBeNull();
    expect(buckets.getByRole("checkbox", { name: "Reopen task" })).toBeDefined();
    expect(buckets.getByText("Toggle me")).toBeDefined();
  });

  it("collapses device-locally and hides entirely when there are no tasks", async () => {
    const busy = await seedClient();
    await taskStatus(busy);
    await createTask(busy, "Only task", { scheduled: todayIsoLocal() });
    await flushWrites();
    const { unmount } = render(<HubView client={busy} nav="tasks" onOpenNode={vi.fn()} />);
    const header = (await screen.findByLabelText("Task buckets")).querySelector(
      ".task-buckets__header",
    ) as HTMLElement;
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(
      (await screen.findByLabelText("Task buckets")).querySelector(".task-buckets__rows"),
    ).toBeNull();
    unmount();

    const empty = await seedClient();
    await taskStatus(empty);
    await flushWrites();
    render(<HubView client={empty} nav="tasks" onOpenNode={vi.fn()} />);
    await flushWrites();
    expect(screen.queryByLabelText("Task buckets")).toBeNull();
  });
});

// --- #5a the one-tap postpone -----------------------------------------------------

describe("postponeTaskToTomorrow (one-tap push)", () => {
  it("moves the scheduled point to tomorrow, preserving the clock time — one write", async () => {
    const { postponeTaskToTomorrow } = await import("../src/features/calendar/calendarRows.js");
    const { timeOfValue } = await import("../src/features/calendar/calendarViewUtils.js");
    const client = await seedClient();
    const today = todayIsoLocal();
    await taskStatus(client);
    const id = await createTask(client, "Timed", { scheduled: addDaysIso(today, -1) });
    await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, {
      iso: addDaysIso(today, -1),
      time: "14:30",
    });
    await flushWrites();

    const moved = await postponeTaskToTomorrow(client, id);
    await flushWrites();
    expect(moved).toBe(true);
    const value = client
      .getPropertyRowShells(id)
      .find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled)?.value;
    expect(scheduledIsoOf(value)).toBe(addDaysIso(today, 1));
    expect(timeOfValue(value)).toBe("14:30");
  });

  it("refuses honestly: deadline-only, recurring, and range-scheduled tasks are not one-tap targets", async () => {
    const { postponeTaskToTomorrow, taskPostponeTargetOf } = await import(
      "../src/features/calendar/calendarRows.js"
    );
    const client = await seedClient();
    const today = todayIsoLocal();
    await taskStatus(client);

    const deadlineOnly = await createTask(client, "Deadline only", {
      deadline: addDaysIso(today, -1),
    });
    expect(taskPostponeTargetOf(client, deadlineOnly)).toBeNull();
    expect(await postponeTaskToTomorrow(client, deadlineOnly)).toBe(false);

    const ranged = await createTask(client, "Ranged", {});
    await client.setDatetimeProperty(ranged, SYSTEM_PROPERTY_UUIDS.taskScheduled, {
      start: { iso: addDaysIso(today, -2) },
      end: { iso: addDaysIso(today, -1) },
    });
    expect(taskPostponeTargetOf(client, ranged)).toBeNull();

    // A recurring task's series rolls forward — never a one-tap postpone.
    const recurring = await createTask(client, "Recurring", { scheduled: addDaysIso(today, -3) });
    await client.setProperty(recurring, SYSTEM_PROPERTY_UUIDS.repeat, "RRULE:FREQ=DAILY", 0);
    expect(taskPostponeTargetOf(client, recurring)).toBeNull();
  });

  it("the bucket row shows the hover postpone action and the click re-buckets the task", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    await taskStatus(client);
    await createTask(client, "Slipped", { scheduled: addDaysIso(today, -1) });
    await createTask(client, "Deadline only", { deadline: addDaysIso(today, -1) });
    await flushWrites();

    render(<HubView client={client} nav="tasks" onOpenNode={vi.fn()} />);
    const section = await screen.findByLabelText("Task buckets");
    // Only the scheduled row carries the action (the deadline-driven row
    // never does).
    const actions = section.querySelectorAll(".task-buckets__row-postpone");
    expect(actions).toHaveLength(1);
    const groupOf = (text: string) =>
      within(section).getByText(text).closest(".task-buckets__group");
    expect(groupOf("Slipped")?.textContent).toContain("Overdue");
    fireEvent.click(actions[0]!);
    await flushWrites();
    await waitFor(() => {
      expect(groupOf("Slipped")?.textContent).toContain("Upcoming");
    });
    // The deadline-driven row stays overdue, still without the affordance.
    expect(groupOf("Deadline only")?.textContent).toContain("Overdue");
    expect(
      groupOf("Deadline only")?.querySelector(".task-buckets__row-postpone"),
    ).toBeNull();
  });

  it("the Review row carries the same action", async () => {
    window.localStorage.setItem("notees.settings.viewMode.hub.tasks", JSON.stringify("review"));
    try {
      const client = await seedClient();
      const today = todayIsoLocal();
      await taskStatus(client);
      await createTask(client, "Review me", { scheduled: addDaysIso(today, -2) });
      await flushWrites();

      render(<HubView client={client} nav="tasks" onOpenNode={vi.fn()} />);
      const section = await screen.findByLabelText("Task review");
      const action = section.querySelector(".task-review__row-postpone");
      expect(action).not.toBeNull();
      fireEvent.click(action!);
      await flushWrites();
      await waitFor(() => {
        expect(screen.queryByText("Review me")).toBeNull(); // tomorrow is not reviewable
      });
    } finally {
      window.localStorage.removeItem("notees.settings.viewMode.hub.tasks");
    }
  });
});

// --- #5b the unreviewed-days queue -------------------------------------------------

describe("TaskReview (tasks hub)", () => {
  afterEach(() => {
    window.localStorage.removeItem("notees.settings.viewMode.hub.tasks");
  });

  it("groupSlippedTasksByDay groups past open work by driving day, priority-first within the day", async () => {
    const { groupSlippedTasksByDay } = await import(
      "../src/features/calendar/calendarViewUtils.js"
    );
    const row = (
      id: string,
      scheduledIso: string | null,
      deadlineIso: string | null,
      priority: string | null = null,
      closed = false,
      repeat: TaskBucketRow["repeat"] = null,
    ): TaskBucketRow => ({
      id,
      scheduledIso,
      deadlineIso,
      closed,
      drivingIso: null,
      priority,
      repeat,
      completedOccurrences: [],
      occurrenceDone: false,
    });
    const today = "2026-10-04";
    const groups = groupSlippedTasksByDay(
      [
        row("b-urgent", "2026-10-02", null, "Urgent"),
        row("a-none", "2026-10-01", null),
        row("b-low", null, "2026-10-02", "Low"), // deadline-driven groups under its deadline day
        row("closed", "2026-10-01", null, null, true), // closed never lists
        row("recurring", "2026-09-28", null, null, false, { freq: "daily", interval: 1 }), // rolls forward
        row("today", today, null), // not past
        row("future", "2026-10-09", null),
        row("unscheduled", null, null),
      ],
      today,
    );
    expect(groups.map((group) => group.dayIso)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["a-none"]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["b-urgent", "b-low"]);
    expect(groups[1]!.rows[0]!.drivingIso).toBe("2026-10-02");
  });

  it("lists slipped days oldest-first and the checkbox completes a task out of the queue", async () => {
    window.localStorage.setItem("notees.settings.viewMode.hub.tasks", JSON.stringify("review"));
    const client = await seedClient();
    const today = todayIsoLocal();
    await taskStatus(client);
    await createTask(client, "Slipped yesterday", { scheduled: addDaysIso(today, -1) });
    await createTask(client, "Slipped last week", {
      scheduled: addDaysIso(today, -6),
      priority: "High",
    });
    await createTask(client, "On track", { scheduled: today });
    await flushWrites();

    render(<HubView client={client} nav="tasks" onOpenNode={vi.fn()} />);
    const section = await screen.findByLabelText("Task review");
    const review = within(section);
    // Oldest day first; the on-track task never lists.
    const days = [...section.querySelectorAll(".task-review__day")].map((el) => el.textContent);
    expect(days).toEqual([addDaysIso(today, -6), addDaysIso(today, -1)]);
    expect(review.getByText("Slipped last week")).toBeDefined();
    expect(review.getByText("High")).toBeDefined();
    expect(review.queryByText("On track")).toBeNull();

    // The checkbox is the hub's exact write: closing the task empties its day.
    const yesterdayGroup = review.getByText("Slipped yesterday").closest(".task-review__group")!;
    fireEvent.click(
      within(yesterdayGroup as HTMLElement).getByRole("checkbox", { name: "Mark task done" }),
    );
    await flushWrites();
    await waitFor(() => {
      expect(screen.queryByText("Slipped yesterday")).toBeNull();
    });
    expect(screen.getByText("Slipped last week")).toBeDefined();
  });

  it("push to today reschedules the day's scheduled-driven tasks only — a passed deadline is never bulk-rewritten", async () => {
    window.localStorage.setItem("notees.settings.viewMode.hub.tasks", JSON.stringify("review"));
    const client = await seedClient();
    const today = todayIsoLocal();
    await taskStatus(client);
    const scheduledId = await createTask(client, "Push me", {
      scheduled: addDaysIso(today, -2),
    });
    const deadlineId = await createTask(client, "Deadline only", {
      deadline: addDaysIso(today, -2),
    });
    await flushWrites();

    render(<HubView client={client} nav="tasks" onOpenNode={vi.fn()} />);
    const review = within(await screen.findByLabelText("Task review"));
    fireEvent.click(review.getByRole("button", { name: /Push to today/ }));
    await flushWrites();

    const scheduledIsoOfRow = (id: string, schemaId: string): string | null =>
      scheduledIsoOf(
        client.getPropertyRowShells(id).find((entry) => entry.propertySchemaId === schemaId)?.value,
      );
    await waitFor(() => {
      expect(
        scheduledIsoOfRow(scheduledId, SYSTEM_PROPERTY_UUIDS.taskScheduled),
      ).toBe(today);
    });
    // The rescheduled task left the queue; the deadline-driven one stays,
    // its deadline untouched.
    expect(screen.queryByText("Push me")).toBeNull();
    expect(screen.getByText("Deadline only")).toBeDefined();
    expect(scheduledIsoOfRow(deadlineId, SYSTEM_PROPERTY_UUIDS.taskDeadline)).toBe(
      addDaysIso(today, -2),
    );
  });

  it("renders the honest empty line when nothing slipped", async () => {
    window.localStorage.setItem("notees.settings.viewMode.hub.tasks", JSON.stringify("review"));
    const client = await seedClient();
    await taskStatus(client);
    await createTask(client, "On track", { scheduled: todayIsoLocal() });
    await flushWrites();

    render(<HubView client={client} nav="tasks" onOpenNode={vi.fn()} />);
    expect(await screen.findByText(/Nothing to review/)).toBeDefined();
  });
});

// --- #11/#15 calendar breadth -------------------------------------------------------

describe("CalendarView breadth (dots, agenda)", () => {
  it("marks days with dated objects (range-aware dots)", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const future = addDaysIso(today, 2);
    const bare = addDaysIso(today, 4); // chain only — nothing references it
    await createDatedMeeting(client, "Range meeting", future);
    const { day: bareDay } = await client.ensureDateChain(bare);
    expect(client.getNodeRaw(bareDay)).toBeDefined();
    const { day: _todayDay } = await client.ensureDateChain(today);
    await flushWrites();

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    // Navigate the month grid when the targets land in the next month.
    if (future.slice(0, 7) !== today.slice(0, 7)) {
      fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    }
    // A day some object references blocks its event (the grid's mark
    // register — the retired dots' honest successor); the chain exists
    // too (setting the date auto-created it).
    const target = dayCell(container, String(Number(future.slice(8))));
    await waitFor(() => {
      expect(target.querySelector(".cal-block")).not.toBeNull();
    });
    // A bare chain day: a page exists but nothing references it — no block.
    if (bare.slice(0, 7) !== future.slice(0, 7)) {
      fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    }
    const bareCell = dayCell(container, String(Number(bare.slice(8))));
    expect(bareCell.querySelector(".cal-block")).toBeNull();
  });

  it("renders the dated meeting as a grid block around the selected day", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const future = addDaysIso(today, 2);
    await createDatedMeeting(client, "Agenda meeting", future);
    await flushWrites();

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    // The block rides the same cell register as the selection.
    await waitFor(() => {
      expect(grid.textContent).toContain("Agenda meeting");
    });
    // Select the meeting's day: the grid's outlined selection follows.
    if (future.slice(0, 7) !== today.slice(0, 7)) {
      fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    }
    fireEvent.click(dayCell(container, String(Number(future.slice(8)))));
    expect(
      container.querySelector(".cal-grid__cell--selected")?.getAttribute("data-day"),
    ).toBe(future);
  });
});
