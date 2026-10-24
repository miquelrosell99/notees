/**
 * TimeGrid + AgendaView tests (owner 2026-10-24, the Google time-grid
 * register): the all-day band membership (untimed chips + multi-day span
 * bars across their columns), the timed cards' placement math
 * (minutes → percentages of the 24h column, the 1h default for timed
 * points), the overlap clustering (side-by-side columns), the dblclick-
 * at-hour create prefill (day + hour), the red now-line on today's column,
 * and the Agenda zoom — days with events only, the windowed infinite
 * scroll (the IntersectionObserver mock extends the window), the Google
 * multi-day time labels ("15:00" / "All day" / "Until 18:00"), today's
 * filled-circle header, the row click open.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { CalendarView } from "../src/features/calendar/CalendarView.js";
import {
  addDaysIso,
  scheduledIsoOf,
  todayIsoLocal,
  weekDaysOfIso,
} from "../src/features/calendar/calendarViewUtils.js";

/** The deterministic day-node id for a local ISO day. */
function dayNodeOf(iso: string): string {
  return `00000000-0000-0000-00dd-${iso.replace(/-/g, "")}0000`;
}

/** The authored day of a node's first datetime value. */
function scheduledIsoOfClient(client: WorkspaceClient, nodeId: string): string | null {
  const row = client
    .getEffectiveProperties(nodeId)
    .find((prop) => prop.schema?.type === "datetime" && prop.source === "authored");
  return row === undefined ? null : scheduledIsoOf(row.value);
}

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

/** A mock IntersectionObserver that records observations and never fires
    until a test triggers it (the card-lazy-images register). */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  observed: Element[] = [];
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(target: Element): void {
    this.observed = this.observed.filter((entry) => entry !== target);
  }
  disconnect(): void {
    this.observed = [];
  }
  trigger(): void {
    this.callback(
      this.observed.map(
        (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry,
      ),
      this as unknown as IntersectionObserver,
    );
  }
}

beforeAll(async () => {
  sqlModule = await initSqlJs();
  // jsdom lacks ResizeObserver; the SelectionButton ladder uses it for the
  // sliding indicator.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  MockIntersectionObserver.instances = [];
  vi.restoreAllMocks();
});

/** Server-style seed op the relay holds before the client bootstraps. */
function seedEnvelope(
  opType: string,
  payload: Record<string, unknown>,
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

/** A real workspace is server-seeded: the task + event class nodes exist. */
function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.task, contentAst: [{ type: "text", text: "task" }], icon: "mdiCheckboxMarkedCircleOutline" },
      [SYSTEM_CLASS_UUIDS.task],
    ),
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.event, contentAst: [{ type: "text", text: "event" }] },
      [SYSTEM_CLASS_UUIDS.event],
    ),
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

/** A user class on the event family with a day-precision date binding. */
async function eventFamily(client: WorkspaceClient): Promise<{ classId: string; schemaId: string }> {
  const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
  const classId = await client.createClass("gathering");
  await client.setClassExtends(classId, [SYSTEM_CLASS_UUIDS.event]);
  await client.setClassProperty(classId, schemaId, {});
  return { classId, schemaId };
}

async function timedEvent(
  client: WorkspaceClient,
  classId: string,
  schemaId: string,
  name: string,
  iso: string,
  time: string,
): Promise<string> {
  const id = await client.createObject({ isEmbedded: false, name, classIds: [classId] });
  await client.ensureDateChain(iso);
  await client.setProperty(id, schemaId, { nodeId: dayNodeOf(iso), time }, 0);
  return id;
}

function renderCalendar(client: WorkspaceClient, onOpenPage = vi.fn()) {
  return { onOpenPage, ...render(<CalendarView client={client} onOpenPage={onOpenPage} />) };
}

describe("TimeGrid (the Day/Week zoom)", () => {
  it("the all-day band takes the untimed chip and the multi-day span; the span paints ONE bar across its columns", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { classId, schemaId } = await eventFamily(client);
    // Deterministic in-week days (whatever today's weekday): the visible
    // week of the selection covers a..c.
    const week = weekDaysOfIso(today, 1);
    const a = week[1]!;
    const b = week[2]!;
    const c = week[3]!;

    await client.ensureDateChain(today);
    const untimed = await client.createObject({
      isEmbedded: false,
      name: "Untimed picnic",
      classIds: [classId],
    });
    await client.setProperty(untimed, schemaId, { nodeId: dayNodeOf(today) }, 0);

    await client.ensureDateChain(a);
    await client.ensureDateChain(c);
    const span = await client.createObject({
      isEmbedded: false,
      name: "Offsite",
      classIds: [classId],
    });
    await client.setProperty(
      span,
      schemaId,
      { start: { nodeId: dayNodeOf(a) }, end: { nodeId: dayNodeOf(c) } },
      0,
    );

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("week"));
    const { container } = renderCalendar(client);
    const grid = await screen.findByLabelText("Calendar week view");
    await waitFor(() => {
      expect(grid.textContent).toContain("Untimed picnic");
      expect(grid.textContent).toContain("Offsite");
    });

    // The untimed event stacks as a chip in ITS day's band cell.
    const chip = grid.querySelector(".cal-timegrid__chip") as HTMLElement;
    expect(chip.textContent).toContain("Untimed picnic");
    expect(chip.closest(".cal-timegrid__band-cell")?.getAttribute("data-day")).toBe(today);

    // The span paints ONE continuous bar from its first covered column
    // (index 1) through the last (index 3) — not per-day chips.
    const spans = grid.querySelectorAll(".cal-timegrid__span");
    expect(spans).toHaveLength(1);
    const bar = spans[0] as HTMLElement;
    expect(bar.textContent).toContain("Offsite");
    expect(bar.getAttribute("data-span-from")).toBe("1");
    expect(bar.getAttribute("data-span-to")).toBe("3");
    // Nothing else rides the band.
    expect(container.querySelectorAll(".cal-timegrid__chip")).toHaveLength(1);
  });

  it("a timed event paints a card at its minutes (top/height math) with the 1h default; a same-day range paints the real duration", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { classId, schemaId } = await eventFamily(client);
    await client.ensureDateChain(today);

    // 10:30 point: top = 630/1440, the 1h default duration.
    await timedEvent(client, classId, schemaId, "Point sync", today, "10:30");
    // 14:00–15:30 range: top = 840/1440, height = 90/1440.
    const ranged = await client.createObject({
      isEmbedded: false,
      name: "Workshop",
      classIds: [classId],
    });
    await client.setProperty(
      ranged,
      schemaId,
      {
        start: { nodeId: dayNodeOf(today), time: "14:00" },
        end: { nodeId: dayNodeOf(today), time: "15:30" },
      },
      0,
    );

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("day"));
    renderCalendar(client);
    const grid = await screen.findByLabelText("Calendar day view");
    await waitFor(() => {
      expect(grid.querySelectorAll(".cal-timegrid__card")).toHaveLength(2);
    });

    const point = [...grid.querySelectorAll(".cal-timegrid__card")].find((el) =>
      el.textContent?.includes("Point sync"),
    ) as HTMLElement;
    expect(point.getAttribute("data-start")).toBe("630");
    expect(point.getAttribute("data-duration")).toBe("60");
    expect(point.style.top).toBe(`${(630 / 1440) * 100}%`);
    expect(point.style.height).toBe(`${(60 / 1440) * 100}%`);
    expect(point.textContent).toContain("10:30 – 11:30");

    const range = [...grid.querySelectorAll(".cal-timegrid__card")].find((el) =>
      el.textContent?.includes("Workshop"),
    ) as HTMLElement;
    expect(range.getAttribute("data-start")).toBe("840");
    expect(range.getAttribute("data-duration")).toBe("90");
    expect(range.style.top).toBe(`${(840 / 1440) * 100}%`);
    expect(range.style.height).toBe(`${(90 / 1440) * 100}%`);
    expect(range.textContent).toContain("14:00 – 15:30");

    // Single-day timed events never ride the all-day band.
    expect(grid.querySelectorAll(".cal-timegrid__chip")).toHaveLength(0);
  });

  it("overlapping events split into side-by-side columns; a lone event fills its column", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { classId, schemaId } = await eventFamily(client);
    await client.ensureDateChain(today);
    await timedEvent(client, classId, schemaId, "Overlap one", today, "10:00");
    await timedEvent(client, classId, schemaId, "Overlap two", today, "10:30");
    await timedEvent(client, classId, schemaId, "Solo later", today, "12:00");

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("day"));
    renderCalendar(client);
    const grid = await screen.findByLabelText("Calendar day view");
    await waitFor(() => {
      expect(grid.querySelectorAll(".cal-timegrid__card")).toHaveLength(3);
    });

    const cards = [...grid.querySelectorAll(".cal-timegrid__card")] as HTMLElement[];
    const byName = (name: string) => cards.find((el) => el.textContent?.includes(name))!;
    const one = byName("Overlap one");
    const two = byName("Overlap two");
    const solo = byName("Solo later");

    // The cluster of two splits 50/50; columns are distinct.
    expect(one.getAttribute("data-columns")).toBe("2");
    expect(two.getAttribute("data-columns")).toBe("2");
    expect(one.getAttribute("data-column")).not.toBe(two.getAttribute("data-column"));
    expect(one.style.width).toBe("calc(50% - 2px)");

    // The non-overlapping event is its own cluster: full column.
    expect(solo.getAttribute("data-columns")).toBe("1");
    expect(solo.getAttribute("data-column")).toBe("0");
    expect(solo.style.width).toBe("calc(100% - 2px)");
  });

  it("a dblclick on the hour grid opens the create modal prefilled with the day AND the dblclicked hour", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("day"));
    renderCalendar(client);
    const grid = await screen.findByLabelText("Calendar day view");

    // Geometry stub: the column is 1440px tall, so clientY maps 1:1 to
    // minutes (y=570 → 09:30 → the 09:00 hour row).
    const column = grid.querySelector(`.cal-timegrid__day[data-day="${today}"]`) as HTMLElement;
    column.getBoundingClientRect = (() =>
      ({
        top: 0,
        height: 1440,
        left: 0,
        width: 100,
        bottom: 1440,
        right: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect) as typeof column.getBoundingClientRect;

    fireEvent.doubleClick(column, { clientY: 570 });

    const dialog = await screen.findByRole("dialog", { name: "New event" });
    expect((within(dialog).getByLabelText("Start day") as HTMLInputElement).value).toBe(today);
    expect((within(dialog).getByLabelText("Start time") as HTMLInputElement).value).toBe("09:00");
  });

  it("the red now-line rides today's column at the current minutes", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("day"));
    renderCalendar(client);
    const grid = await screen.findByLabelText("Calendar day view");

    const column = grid.querySelector(`.cal-timegrid__day[data-day="${today}"]`) as HTMLElement;
    const line = column.querySelector(".cal-timegrid__now") as HTMLElement;
    expect(line).not.toBeNull();
    const now = new Date();
    expect(line.getAttribute("data-minutes")).toBe(String(now.getHours() * 60 + now.getMinutes()));
    expect(line.style.top).toBe(`${((now.getHours() * 60 + now.getMinutes()) / 1440) * 100}%`);
  });

  it("dropping a timed card on another day+hour rewrites the value preserving the duration", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const tomorrow = addDaysIso(today, 1);
    const { classId, schemaId } = await eventFamily(client);
    await client.ensureDateChain(today);
    const event = await timedEvent(client, classId, schemaId, "Move me", today, "10:15");
    // A same-day 45-minute range: the duration must survive the move.
    await client.setProperty(
      event,
      schemaId,
      {
        start: { nodeId: dayNodeOf(today), time: "10:15" },
        end: { nodeId: dayNodeOf(today), time: "11:00" },
      },
      0,
    );

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("week"));
    const { container } = renderCalendar(client);
    const grid = await screen.findByLabelText("Calendar week view");
    await waitFor(() => {
      expect(grid.querySelector(".cal-timegrid__card")).not.toBeNull();
    });

    const target = grid.querySelector(
      `.cal-timegrid__day[data-day="${tomorrow}"] [data-hour="14"]`,
    ) as HTMLElement;
    fireEvent.drop(target, {
      dataTransfer: { getData: () => `${event}|${today}` },
    });

    await waitFor(() => {
      const row = client
        .getEffectiveProperties(event)
        .find((prop) => prop.schema?.type === "datetime" && prop.source === "authored");
      expect(row).toBeDefined();
      expect(scheduledIsoOf(row!.value)).toBe(tomorrow);
      // The duration rides along: 14:00 → 14:45 on the new day.
      expect(row!.value).toMatchObject({
        start: { nodeId: dayNodeOf(tomorrow), time: "14:00" },
        end: { nodeId: dayNodeOf(tomorrow), time: "14:45" },
      });
    });
    expect(container).toBeDefined();
  });
});

describe("AgendaView (the Agenda zoom)", () => {
  it("lists days with events only — eventless days never render a group", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const later = addDaysIso(today, 10);
    const { classId, schemaId } = await eventFamily(client);
    await timedEvent(client, classId, schemaId, "Anchor event", today, "09:00");
    await timedEvent(client, classId, schemaId, "Later event", later, "09:00");

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("agenda"));
    const { container } = renderCalendar(client);
    const agenda = await screen.findByLabelText("Calendar agenda view");
    await waitFor(() => {
      expect(agenda.textContent).toContain("Anchor event");
      expect(agenda.textContent).toContain("Later event");
    });

    const days = [...container.querySelectorAll(".cal-agenda__day")].map((el) =>
      el.getAttribute("data-day"),
    );
    expect(days).toContain(today);
    expect(days).toContain(later);
    // The eventless day in between renders nothing.
    expect(days).not.toContain(addDaysIso(today, 5));
    expect(days).toHaveLength(2);
  });

  it("the window extends: an event past the initial window appears after the bottom sentinel fires", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const beyond = addDaysIso(today, 40);
    const { classId, schemaId } = await eventFamily(client);
    await timedEvent(client, classId, schemaId, "Anchor event", today, "09:00");
    await timedEvent(client, classId, schemaId, "Beyond event", beyond, "09:00");

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("agenda"));
    const { container } = renderCalendar(client);
    const agenda = await screen.findByLabelText("Calendar agenda view");
    await waitFor(() => {
      expect(agenda.textContent).toContain("Anchor event");
    });
    // The initial window (anchor ±30d) does not reach the +40d event.
    expect(container.querySelector(`.cal-agenda__day[data-day="${beyond}"]`)).toBeNull();

    // The bottom sentinel crossing extends the window (+30d) and re-scans.
    for (const instance of MockIntersectionObserver.instances) instance.trigger();
    await waitFor(() => {
      expect(container.querySelector(`.cal-agenda__day[data-day="${beyond}"]`)).not.toBeNull();
      expect(agenda.textContent).toContain("Beyond event");
    });
  });

  it("the multi-day register: '15:00' on the first day, 'All day' in the middle, 'Until 18:00' on the last", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const middle = addDaysIso(today, 1);
    const last = addDaysIso(today, 2);
    const { classId, schemaId } = await eventFamily(client);
    await client.ensureDateChain(today);
    await client.ensureDateChain(last);
    const span = await client.createObject({
      isEmbedded: false,
      name: "Conference",
      classIds: [classId],
    });
    await client.setProperty(
      span,
      schemaId,
      {
        start: { nodeId: dayNodeOf(today), time: "15:00" },
        end: { nodeId: dayNodeOf(last), time: "18:00" },
      },
      0,
    );

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("agenda"));
    const { container } = renderCalendar(client);
    const agenda = await screen.findByLabelText("Calendar agenda view");
    await waitFor(() => {
      expect(agenda.textContent).toContain("Conference");
    });

    const timeOf = (iso: string): string => {
      const group = container.querySelector(`.cal-agenda__day[data-day="${iso}"]`) as HTMLElement;
      expect(group, `day group ${iso}`).not.toBeNull();
      return group.querySelector(".cal-agenda__time")!.textContent!;
    };
    expect(timeOf(today)).toBe("15:00");
    expect(timeOf(middle)).toBe("All day");
    expect(timeOf(last)).toBe("Until 18:00");
  });

  it("today's group header rides the filled circle; a row click opens the event", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { classId, schemaId } = await eventFamily(client);
    const event = await timedEvent(client, classId, schemaId, "Openable", today, "09:00");

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("agenda"));
    const { container, onOpenPage } = renderCalendar(client);
    const agenda = await screen.findByLabelText("Calendar agenda view");
    await waitFor(() => {
      expect(agenda.textContent).toContain("Openable");
    });

    // The filled-circle marker is today's day number…
    const todayGroup = container.querySelector(
      `.cal-agenda__day[data-day="${today}"]`,
    ) as HTMLElement;
    expect(todayGroup.querySelector(".cal-agenda__daynum--today")).not.toBeNull();
    // …and the red now-line rides under today's header.
    expect(todayGroup.querySelector(".cal-agenda__now")).not.toBeNull();

    // A row click opens the event.
    fireEvent.click(todayGroup.querySelector(".cal-agenda__row") as HTMLElement);
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith(event));
  });

  it("a workspace with no events reads the honest empty line", async () => {
    const client = await seedClient();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("agenda"));
    renderCalendar(client);
    const agenda = await screen.findByLabelText("Calendar agenda view");
    expect(agenda.textContent).toContain("No events.");
  });
});
