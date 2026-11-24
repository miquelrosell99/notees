/**
 * Task reminders (the Google Tasks model):
 *
 *  - pure logic: taskReminderMomentOf (timed/all-day/deadline-fallback/
 *    closed/past-day/recurring arms), dueReminders + nextReminderDelay +
 *    the device-local fired store (round-trip, prune).
 *  - useTaskReminders over a seeded client: a due moment fires ONE
 *    persistent toast (no re-fire on remount), a future moment arms the
 *    timer and fires on time, the enable setting gates everything, and a
 *    Done task never reminds.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  dayNodeId,
  type RecurrenceRule,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { notificationStore } from "../src/components/ui/kit/notificationStore.js";
import {
  DEFAULT_ALL_DAY_REMINDER_TIME,
  dueReminders,
  isValidTimeOfDay,
  markReminderFired,
  nextReminderDelay,
  readFiredReminders,
  reminderFireMs,
  reminderKeyOf,
  taskReminderMomentOf,
  type TaskReminderFacts,
  type TaskReminderMoment,
} from "../src/features/calendar/taskReminders.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";
import { scheduledIsoOf, timeOfValue } from "../src/features/calendar/calendarViewUtils.js";
import { useTaskReminders } from "../src/ui/app/useTaskReminders.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  window.localStorage.clear();
  notificationStore.clearAll();
});

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- pure logic -----------------------------------------------------------------

const TODAY = "2026-11-24";

function facts(overrides: Partial<TaskReminderFacts> = {}): TaskReminderFacts {
  return {
    taskId: "task-1",
    closed: false,
    scheduledValue: null,
    deadlineValue: null,
    scheduledIso: null,
    deadlineIso: null,
    repeat: null,
    completedOccurrences: [],
    ...overrides,
  };
}

/** A datetime point value at a day-node ref (the store's shape). */
function point(iso: string, time?: string): unknown {
  return time === undefined ? { nodeId: dayNodeId(iso) } : { nodeId: dayNodeId(iso), time };
}

describe("taskReminderMomentOf", () => {
  it("a timed scheduled value fires at its own clock time", () => {
    const moment = taskReminderMomentOf(
      facts({ scheduledValue: point(TODAY, "14:30"), scheduledIso: TODAY }),
      TODAY,
      DEFAULT_ALL_DAY_REMINDER_TIME,
    );
    expect(moment).toEqual({
      taskId: "task-1",
      kind: "scheduled",
      dayIso: TODAY,
      time: "14:30",
      allDay: false,
    });
  });

  it("an all-day value fires at the device default (malformed default falls back to 09:00)", () => {
    const moment = taskReminderMomentOf(
      facts({ scheduledValue: point(TODAY), scheduledIso: TODAY }),
      TODAY,
      "not-a-time",
    );
    expect(moment).toMatchObject({ time: "09:00", allDay: true });
    const custom = taskReminderMomentOf(
      facts({ scheduledValue: point(TODAY), scheduledIso: TODAY }),
      TODAY,
      "07:15",
    );
    expect(custom).toMatchObject({ time: "07:15", allDay: true });
  });

  it("deadline drives only when scheduled is absent; scheduled wins otherwise", () => {
    const deadlineOnly = taskReminderMomentOf(
      facts({ deadlineValue: point(TODAY, "18:00"), deadlineIso: TODAY }),
      TODAY,
      DEFAULT_ALL_DAY_REMINDER_TIME,
    );
    expect(deadlineOnly).toMatchObject({ kind: "deadline", time: "18:00" });
    const both = taskReminderMomentOf(
      facts({
        scheduledValue: point(TODAY, "09:30"),
        scheduledIso: TODAY,
        deadlineValue: point(TODAY, "18:00"),
        deadlineIso: TODAY,
      }),
      TODAY,
      DEFAULT_ALL_DAY_REMINDER_TIME,
    );
    expect(both).toMatchObject({ kind: "scheduled", time: "09:30" });
  });

  it("closed, undated, and past-day tasks never remind", () => {
    expect(
      taskReminderMomentOf(
        facts({ closed: true, scheduledValue: point(TODAY, "10:00"), scheduledIso: TODAY }),
        TODAY,
        DEFAULT_ALL_DAY_REMINDER_TIME,
      ),
    ).toBeNull();
    expect(
      taskReminderMomentOf(facts(), TODAY, DEFAULT_ALL_DAY_REMINDER_TIME),
    ).toBeNull();
    expect(
      taskReminderMomentOf(
        facts({ scheduledValue: point("2026-11-23", "10:00"), scheduledIso: "2026-11-23" }),
        TODAY,
        DEFAULT_ALL_DAY_REMINDER_TIME,
      ),
    ).toBeNull();
  });

  it("a future day arms its own moment", () => {
    const moment = taskReminderMomentOf(
      facts({ scheduledValue: point("2026-11-27", "08:00"), scheduledIso: "2026-11-27" }),
      TODAY,
      DEFAULT_ALL_DAY_REMINDER_TIME,
    );
    expect(moment).toMatchObject({ dayIso: "2026-11-27", time: "08:00" });
  });

  it("a recurring task reminds on today's open occurrence only", () => {
    const daily: RecurrenceRule = { freq: "daily", interval: 1 };
    const anchor = "2026-11-20";
    const open = taskReminderMomentOf(
      facts({
        scheduledValue: point(anchor, "10:00"),
        scheduledIso: anchor,
        repeat: daily,
      }),
      TODAY,
      DEFAULT_ALL_DAY_REMINDER_TIME,
    );
    expect(open).toMatchObject({ dayIso: TODAY, time: "10:00" });
    // The completed occurrence stays silent.
    expect(
      taskReminderMomentOf(
        facts({
          scheduledValue: point(anchor, "10:00"),
          scheduledIso: anchor,
          repeat: daily,
          completedOccurrences: [TODAY],
        }),
        TODAY,
        DEFAULT_ALL_DAY_REMINDER_TIME,
      ),
    ).toBeNull();
    // A day the series does not occur on stays silent (weekly anchored Monday).
    const weekly: RecurrenceRule = { freq: "weekly", interval: 1 }; // 2026-11-20 is a Friday
    expect(
      taskReminderMomentOf(
        facts({ scheduledValue: point(anchor), scheduledIso: anchor, repeat: weekly }),
        TODAY, // 2026-11-24 is a Tuesday
        DEFAULT_ALL_DAY_REMINDER_TIME,
      ),
    ).toBeNull();
    // A series anchors on Scheduled — a deadline-only "recurring" task never reminds.
    expect(
      taskReminderMomentOf(
        facts({ deadlineValue: point(TODAY), deadlineIso: TODAY, repeat: daily }),
        TODAY,
        DEFAULT_ALL_DAY_REMINDER_TIME,
      ),
    ).toBeNull();
  });
});

describe("due/fired scheduling", () => {
  const at = (dayIso: string, time: string): TaskReminderMoment => ({
    taskId: `task-${dayIso}-${time}`,
    kind: "scheduled",
    dayIso,
    time,
    allDay: false,
  });

  it("isValidTimeOfDay accepts 24h HH:MM only", () => {
    expect(isValidTimeOfDay("00:00")).toBe(true);
    expect(isValidTimeOfDay("23:59")).toBe(true);
    expect(isValidTimeOfDay("24:00")).toBe(false);
    expect(isValidTimeOfDay("9:00")).toBe(false);
    expect(isValidTimeOfDay("")).toBe(false);
  });

  it("dueReminders fires reached, unfired, same-day moments in order — never a past day", () => {
    const nowMs = reminderFireMs({ dayIso: TODAY, time: "12:00" });
    const moments = [
      at(TODAY, "09:00"), // due
      at(TODAY, "08:00"), // due, earlier — sorts first
      at(TODAY, "13:00"), // future
      at("2026-11-23", "10:00"), // past day — never fires
    ];
    const fired = new Set([reminderKeyOf(at(TODAY, "09:00"))]);
    const due = dueReminders(moments, nowMs, fired, TODAY);
    expect(due.map((moment) => moment.time)).toEqual(["08:00"]);
  });

  it("nextReminderDelay arms the earliest unfired future moment", () => {
    const nowMs = reminderFireMs({ dayIso: TODAY, time: "12:00" });
    expect(nextReminderDelay([at(TODAY, "11:00")], nowMs, new Set())).toBeNull();
    expect(nextReminderDelay([at(TODAY, "13:30"), at(TODAY, "13:00")], nowMs, new Set())).toBe(
      60 * 60 * 1000,
    );
    expect(
      nextReminderDelay([at(TODAY, "13:00")], nowMs, new Set([reminderKeyOf(at(TODAY, "13:00"))])),
    ).toBeNull();
  });

  it("the fired store round-trips and prunes entries older than two days", () => {
    const nowMs = reminderFireMs({ dayIso: TODAY, time: "12:00" });
    markReminderFired("a@2026-11-24T09:00", nowMs);
    markReminderFired("b@2026-11-24T10:00", nowMs);
    expect(readFiredReminders(nowMs).map((entry) => entry.key)).toEqual([
      "a@2026-11-24T09:00",
      "b@2026-11-24T10:00",
    ]);
    // Three days later the entries prune away.
    const laterMs = nowMs + 3 * 24 * 60 * 60 * 1000;
    expect(readFiredReminders(laterMs)).toEqual([]);
    // Corrupt storage reads as empty, never throws.
    window.localStorage.setItem("notees.reminders.fired", "{not json");
    expect(readFiredReminders(nowMs)).toEqual([]);
  });
});

// --- the hook over a seeded client ------------------------------------------------

function seedEnvelope(opType: string, payload: Record<string, unknown>, affected: string[]): Envelope {
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

function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.task, contentAst: [{ type: "text", text: "task" }] },
      [SYSTEM_CLASS_UUIDS.task],
    ),
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.day, contentAst: [{ type: "text", text: "day" }] },
      [SYSTEM_CLASS_UUIDS.day],
    ),
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.month, contentAst: [{ type: "text", text: "month" }] },
      [SYSTEM_CLASS_UUIDS.month],
    ),
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.year, contentAst: [{ type: "text", text: "year" }] },
      [SYSTEM_CLASS_UUIDS.year],
    ),
  ]);
  return relay;
}

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(seededRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  await ensureTaskFamily(client);
  return client;
}

async function createTask(
  client: WorkspaceClient,
  name: string,
  opts: { iso: string; time?: string; done?: boolean },
): Promise<string> {
  const id = await client.createObject({ isEmbedded: false, name, classIds: [SYSTEM_CLASS_UUIDS.task] });
  await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, {
    iso: opts.iso,
    ...(opts.time !== undefined ? { time: opts.time } : {}),
  });
  if (opts.done === true) {
    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    await client.setProperty(id, status.id, status.options!.find((o) => o.label === "Done")!.id);
  }
  return id;
}

function Probe({ client, onOpenNode }: { client: WorkspaceClient; onOpenNode: (id: string) => void }) {
  useTaskReminders({ client, onOpenNode });
  return null;
}

describe("useTaskReminders", () => {
  // 2026-11-24 14:00 local — moments before it are due, after it pending.
  const NOW = new Date(2026, 10, 24, 14, 0, 0);

  it("fires a due moment once (persistent toast + fired state), never re-firing on remount", async () => {
    const client = await seedClient();
    const id = await createTask(client, "Call the bank", { iso: "2026-11-24", time: "09:00" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const { unmount } = render(<Probe client={client} onOpenNode={vi.fn()} />);
    await act(async () => {});
    expect(notificationStore.notifications).toHaveLength(1);
    expect(notificationStore.notifications[0]).toMatchObject({
      type: "info",
      title: "Call the bank",
      message: "Scheduled at 09:00",
      duration: 0,
    });
    expect(readFiredReminders(Date.now()).map((entry) => entry.key)).toEqual([
      `${id}@2026-11-24T09:00`,
    ]);

    unmount();
    render(<Probe client={client} onOpenNode={vi.fn()} />);
    await act(async () => {});
    expect(notificationStore.notifications).toHaveLength(1);
  });

  it("arms the timer to a future moment and fires on time", async () => {
    const client = await seedClient();
    await createTask(client, "Standup", { iso: "2026-11-24", time: "15:00" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(<Probe client={client} onOpenNode={vi.fn()} />);
    await act(async () => {});
    expect(notificationStore.notifications).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1000 + 1000); // past 15:00
    });
    expect(notificationStore.notifications).toHaveLength(1);
    expect(notificationStore.notifications[0]).toMatchObject({
      title: "Standup",
      message: "Scheduled at 15:00",
    });
  });

  it("the toast's Open action navigates to the task", async () => {
    const client = await seedClient();
    const id = await createTask(client, "Open me", { iso: "2026-11-24", time: "09:00" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onOpenNode = vi.fn();

    render(<Probe client={client} onOpenNode={onOpenNode} />);
    await act(async () => {});
    notificationStore.notifications[0]!.action!.onClick();
    expect(onOpenNode).toHaveBeenCalledWith(id);
  });

  it("the toast's Tomorrow action postpones the task (scheduled moments only)", async () => {
    const client = await seedClient();
    const id = await createTask(client, "Push me", { iso: "2026-11-24", time: "09:00" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(<Probe client={client} onOpenNode={vi.fn()} />);
    await act(async () => {});
    const toast = notificationStore.notifications[0]!;
    expect(toast.secondaryAction?.label).toBe("Tomorrow");
    toast.secondaryAction!.onClick();
    await act(async () => {});
    const value = client
      .getPropertyRowShells(id)
      .find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled)?.value;
    expect(scheduledIsoOf(value)).toBe("2026-11-25");
    expect(timeOfValue(value)).toBe("09:00");

    // A deadline-driven moment carries no Tomorrow action (deadlines are
    // never one-tap postponed).
    notificationStore.clearAll();
    window.localStorage.removeItem("notees.reminders.fired");
    const second = await seedClient();
    const deadlineTask = await second.createObject({
      isEmbedded: false,
      name: "Deadline moment",
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await ensureTaskFamily(second);
    await second.setDatetimeProperty(deadlineTask, SYSTEM_PROPERTY_UUIDS.taskDeadline, {
      iso: "2026-11-24",
      time: "10:00",
    });
    render(<Probe client={second} onOpenNode={vi.fn()} />);
    await act(async () => {});
    expect(notificationStore.notifications).toHaveLength(1);
    expect(notificationStore.notifications[0]!.secondaryAction).toBeUndefined();
  });

  it("the enable setting gates the scheduler; a Done task never reminds", async () => {
    window.localStorage.setItem("notees.settings.tasks.remindersEnabled", "false");
    const client = await seedClient();
    await createTask(client, "Gated", { iso: "2026-11-24", time: "09:00" });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<Probe client={client} onOpenNode={vi.fn()} />);
    await act(async () => {});
    expect(notificationStore.notifications).toHaveLength(0);

    window.localStorage.setItem("notees.settings.tasks.remindersEnabled", "true");
    notificationStore.clearAll();
    const second = await seedClient();
    await createTask(second, "Already done", { iso: "2026-11-24", time: "09:00", done: true });
    render(<Probe client={second} onOpenNode={vi.fn()} />);
    await act(async () => {});
    expect(notificationStore.notifications).toHaveLength(0);
  });
});
