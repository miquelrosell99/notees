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
  opts: { scheduled?: string; deadline?: string; done?: boolean } = {},
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
  it("renders the DayPageHeader: weekday flag above the date title, the Week flag after it — the stepping lives in the top bar now (owner pass 2026-10-24)", async () => {
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

  it("renders neither the bar nor the sections when embedded", async () => {
    const client = await seedClient();
    const iso = "2026-06-15";
    const { day } = await client.ensureDateChain(iso);
    await taskStatus(client);
    await createTask(client, "Embedded task", { scheduled: iso });
    await flushWrites();

    render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} embedded />);
    await flushWrites();
    // Embedded renders skip the day header entirely (they sit on aggregation
    // surfaces) — no flags line, no title, no sections.
    expect(document.querySelector(".day-page-header")).toBeNull();
    expect(screen.queryByRole("button", { name: /^tasks( \d+)?$/i })).toBeNull();
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
