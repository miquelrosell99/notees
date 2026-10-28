/**
 * Calendar-collection-view tests: the calendar as a registered COLLECTION
 * view mode (features/collection/calendar/CalendarView — not the calendar
 * feature's own surface, whose spec is calendar-view.test.tsx) — the
 * collection's items placed on a month grid by a picked date property,
 * with an agenda strip for the selected day. The pure model
 * (calendarModel) carries the behavior contract (TDD core); the view specs
 * render through the registry like any mode and ride the Stage A
 * availability gate (datePropertyCount >= 1). Unlike the gantt there is NO
 * Unscheduled lane: an item with no date value stays off the grid (a point
 * in time IS the calendar's unit). jsdom over the in-process
 * WorkspaceClient + MemoryRelay.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  buildCalendarMonth,
  calendarMonthBounds,
  clampCalendarMonth,
  shiftCalendarMonth,
  type CalendarInputRow,
} from "../src/features/collection/calendar/calendarModel.js";
import { dateOrdinal } from "../src/features/collection/dateValue.js";
import {
  getViewDefinition,
  getViewModeOptions,
  NodeCollection,
} from "../src/features/collection/index.js";
import { CollectionHub } from "../src/features/collection/CollectionHub.js";
import { writeViewModePref } from "../src/ui/viewPrefs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** WORKAROUND(store applier): class.create's contentAst never lands in the
 *  class node's content — seed the title through object.update instead. */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

const d = (year: number, month: number, day: number) => ({ year, month, day });
const row = (id: string, day: { year: number; month: number; day: number } | null): CalendarInputRow => ({
  id,
  name: id,
  color: null,
  day,
});

// ── calendarModel (pure) ────────────────────────────────────────────────────

describe("buildCalendarMonth — items onto the month grid", () => {
  it("places items in their day cells; a multi-item day carries both, name-sorted", () => {
    const grid = buildCalendarMonth(
      [row("zeta", d(2026, 3, 10)), row("alpha", d(2026, 3, 10)), row("solo", d(2026, 3, 20))],
      2026,
      3,
      { firstDayOfWeek: 1 },
    );
    const cells = grid.weeks.flat();
    const ten = cells.find((cell) => cell.iso === "2026-03-10")!;
    expect(ten.inMonth).toBe(true);
    expect(ten.items.map((item) => item.id)).toEqual(["alpha", "zeta"]);
    const twenty = cells.find((cell) => cell.iso === "2026-03-20")!;
    expect(twenty.items.map((item) => item.id)).toEqual(["solo"]);
  });

  it("items with no date value are excluded — the calendar has no unscheduled lane", () => {
    const grid = buildCalendarMonth(
      [row("dated", d(2026, 3, 10)), row("undated", null)],
      2026,
      3,
      { firstDayOfWeek: 1 },
    );
    const all = grid.weeks.flat().flatMap((cell) => cell.items.map((item) => item.id));
    expect(all).toEqual(["dated"]);
  });

  it("month window: Monday-first padding before/after, in-month flags", () => {
    // March 2026 starts on a Sunday; Monday-first → the grid opens Monday
    // Feb 23 and closes Sunday Apr 5 (six weeks).
    const grid = buildCalendarMonth([], 2026, 3, { firstDayOfWeek: 1 });
    const cells = grid.weeks.flat();
    expect(grid.weeks).toHaveLength(6);
    expect(cells[0]!.iso).toBe("2026-02-23");
    expect(cells[0]!.inMonth).toBe(false);
    expect(cells.at(-1)!.iso).toBe("2026-04-05");
    expect(cells.at(-1)!.inMonth).toBe(false);
    expect(cells.find((cell) => cell.iso === "2026-03-01")!.inMonth).toBe(true);
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
  });

  it("flags today when it is on the grid", () => {
    const today = dateOrdinal(d(2026, 3, 15));
    const grid = buildCalendarMonth([], 2026, 3, { firstDayOfWeek: 1, today });
    const cell = grid.weeks.flat().find((candidate) => candidate.isToday);
    expect(cell?.iso).toBe("2026-03-15");
  });
});

describe("month navigation bounds", () => {
  const rows = [row("a", d(2026, 3, 10)), row("b", d(2026, 5, 1)), row("c", null)];

  it("bounds span the dated items' months (undated ignored)", () => {
    expect(calendarMonthBounds(rows)).toEqual({
      earliest: { year: 2026, month: 3 },
      latest: { year: 2026, month: 5 },
    });
    expect(calendarMonthBounds([row("x", null)])).toEqual({ earliest: null, latest: null });
  });

  it("shiftCalendarMonth strides whole months across year boundaries", () => {
    expect(shiftCalendarMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftCalendarMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftCalendarMonth(2026, 3, 2)).toEqual({ year: 2026, month: 5 });
  });

  it("clampCalendarMonth keeps the visible month inside the data's span", () => {
    const bounds = { earliest: { year: 2026, month: 3 }, latest: { year: 2026, month: 5 } };
    expect(clampCalendarMonth(2026, 1, bounds)).toEqual({ year: 2026, month: 3 });
    expect(clampCalendarMonth(2026, 8, bounds)).toEqual({ year: 2026, month: 5 });
    expect(clampCalendarMonth(2026, 4, bounds)).toEqual({ year: 2026, month: 4 });
    // No dated items: nothing to clamp to — the requested month stands.
    const empty = { earliest: null, latest: null };
    expect(clampCalendarMonth(2027, 2, empty)).toEqual({ year: 2027, month: 2 });
  });
});

// ── the registered view ─────────────────────────────────────────────────────

describe("calendar as a registry view mode", () => {
  it("registers calendar with label, icon, secondary tier, and the date gate", () => {
    const entry = getViewDefinition("calendar");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Calendar");
    expect(entry!.icon).toBe("mdi-calendar-month");
    expect(entry!.tier).toBe("secondary");
    expect(entry!.availability?.({ datePropertyCount: 0, linkedItemCount: 0 })).toBe(false);
    expect(entry!.availability?.({ datePropertyCount: 1, linkedItemCount: 0 })).toBe(true);
    expect(getViewModeOptions(["calendar"])[0]!.tier).toBe("secondary");
  });

  /** A class with a bound datetime property; two dated members and one
   *  undated (the calendar drops it — no lane). */
  async function seedDatedClass(client: WorkspaceClient): Promise<{
    dueId: string;
    first: string;
    second: string;
    undated: string;
    items: Array<{ node: NonNullable<ReturnType<WorkspaceClient["getNode"]>> }>;
  }> {
    const classId = await createTitledClass(client, "Event");
    const dueId = await client.createPropertySchema({ name: "When", type: "datetime" });
    await client.setClassProperty(classId, dueId, {});
    const first = await client.createObject({ isEmbedded: false, name: "First thing" });
    const second = await client.createObject({ isEmbedded: false, name: "Second thing" });
    const undated = await client.createObject({ isEmbedded: false, name: "Someday thing" });
    for (const id of [first, second, undated]) await client.assignClass(id, classId);
    const { day: dayA } = await client.ensureDateChain("2026-03-10");
    const { day: dayB } = await client.ensureDateChain("2026-03-10");
    await client.setProperty(first, dueId, { nodeId: dayA }, 0);
    await client.setProperty(second, dueId, { nodeId: dayB }, 0);
    const items = [first, second, undated].map((id) => ({ node: client.getNode(id)! }));
    return { dueId, first, second, undated, items };
  }

  it("NodeCollection renders the month grid: chips in the right cells, the undated item absent", async () => {
    const client = await seedClient();
    const { first, second, undated, items } = await seedDatedClass(client);
    const { container } = render(
      <NodeCollection viewMode="calendar" client={client} items={items} onNodeClick={() => {}} />,
    );
    const grid = () => container.querySelector(".collection-calendar") as HTMLElement;
    expect(grid()).not.toBeNull();
    // March 2026 is outside the data's month bounds (nothing in Oct 2026) —
    // the visible month clamps to the data.
    expect(within(grid()).getByText("March 2026")).not.toBeNull();
    const cell = grid()!.querySelector('.collection-calendar__cell[data-iso="2026-03-10"]') as HTMLElement;
    expect(cell).not.toBeNull();
    const chips = [...cell.querySelectorAll(".collection-calendar__chip")].map((el) =>
      el.getAttribute("data-node-id"),
    );
    expect(chips.sort()).toEqual([first, second].sort());
    // The undated item rides neither the grid nor an agenda line.
    expect(grid()!.textContent).not.toContain("Someday thing");
    void undated;
  });

  it("the agenda strip lists the selected day; clicking a cell selects it", async () => {
    const client = await seedClient();
    const { first, items } = await seedDatedClass(client);
    const { container } = render(
      <NodeCollection viewMode="calendar" client={client} items={items} onNodeClick={() => {}} />,
    );
    const agenda = () => container.querySelector(".collection-calendar__agenda") as HTMLElement;
    expect(agenda()).not.toBeNull();
    // Click the populated day cell → the agenda lists the day's items.
    const cell = container.querySelector('.collection-calendar__cell[data-iso="2026-03-10"]') as HTMLElement;
    fireEvent.click(cell);
    expect(within(agenda()).getByText("First thing")).not.toBeNull();
    // A day with nothing reads its honest empty line.
    const empty = container.querySelector('.collection-calendar__cell[data-iso="2026-03-12"]') as HTMLElement;
    fireEvent.click(empty);
    expect(agenda().textContent).toContain("Nothing scheduled");
    void first;
  });

  it("chip click opens the node; shift+click peeks", async () => {
    const client = await seedClient();
    const { items } = await seedDatedClass(client);
    const opened: string[] = [];
    const peeked: string[] = [];
    const { container } = render(
      <NodeCollection
        viewMode="calendar"
        client={client}
        items={items}
        onNodeClick={(id) => opened.push(id)}
        onNodeShiftClick={(id) => peeked.push(id)}
      />,
    );
    await act(async () => {});
    const chip = container.querySelector(".collection-calendar__chip") as HTMLElement;
    fireEvent.click(chip);
    expect(opened).toHaveLength(1);
    fireEvent.click(chip, { shiftKey: true });
    expect(peeked).toHaveLength(1);
  });

  it("month navigation: prev/next stride within the data's bounds", async () => {
    const client = await seedClient();
    const { items } = await seedDatedClass(client);
    // Second dated month so the bounds span two months.
    const classId = items[0]!.node.classIds[0]!;
    const otherId = await client.createObject({ isEmbedded: false, name: "Later thing" });
    await client.assignClass(otherId, classId);
    const { day } = await client.ensureDateChain("2026-05-20");
    const dueId = client.getClassBindings(classId)[0]!.propertySchemaId;
    await client.setProperty(otherId, dueId, { nodeId: day }, 0);
    const allItems = [...items, { node: client.getNode(otherId)! }];

    render(
      <NodeCollection viewMode="calendar" client={client} items={allItems} onNodeClick={() => {}} />,
    );
    // Data spans March–May: today (outside) opens clamped at the NEAREST
    // bound (May); prev strides down to the earliest, where it disables.
    expect(screen.getByText("May 2026")).not.toBeNull();
    const next = screen.getByRole("button", { name: "Next month" });
    expect(next).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("April 2026")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("March 2026")).not.toBeNull();
    const prev = screen.getByRole("button", { name: "Previous month" });
    expect(prev).toHaveProperty("disabled", true);
  });

  it("the hub switcher offers Calendar only when the collection carries a date property; the pick persists", async () => {
    const client = await seedClient();
    const plain = await client.createObject({ isEmbedded: false, name: "Plain" });
    const gated = render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Calendar hub"
        items={[{ node: client.getNode(plain)! }]}
        modes={["outline", "calendar"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    expect(screen.queryByRole("radiogroup", { name: "View mode" })).toBeNull();
    gated.unmount();

    const { items } = await seedDatedClass(client);
    writeViewModePref("session.Calendar hub", "calendar");
    render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Calendar hub"
        items={items}
        modes={["outline", "calendar"]}
        defaultMode="outline"
        onOpenNode={() => {}} 
      />,
    );
    // Armed + persisted: the grid renders through the registry; the overflow
    // toggle carries the active selection.
    expect(await screen.findByText("March 2026")).not.toBeNull();
    const toggle = screen.getByRole("button", { name: "More options" });
    expect(toggle.className).toContain("selection-button__overflow-toggle--active");
    fireEvent.click(toggle);
    expect(screen.getByRole("menuitem", { name: "Calendar" }).className).toContain(
      "selection-button__overflow-item--active",
    );
  });
});
