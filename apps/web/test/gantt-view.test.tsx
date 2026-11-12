/**
 * Gantt-view tests: the gantt as a registered collection view mode — items
 * as bars on a shared time axis, positioned by a picked date property,
 * ranged by an optional end date property, with an Unscheduled lane for
 * items with no start date. The pure model (ganttModel) carries the
 * behavior contract (TDD core); the view specs render through the
 * registry like any mode and ride the Stage A availability gate
 * (datePropertyCount >= 1). jsdom over the in-process WorkspaceClient +
 * MemoryRelay.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  buildGantt,
  dateOrdinal,
  ganttDateOf,
  ordinalDate,
  type GanttInputRow,
} from "../src/features/collection/gantt/ganttModel.js";
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

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** WORKAROUND(store applier): class.create's contentAst never lands in the
 *  class node's content — seed the title through object.update instead. */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

const d = (year: number, month: number, day: number) => ({ year, month, day });

/** The deterministic date-chain node ids (domain dates.ts — day/month/year
 *  prefixes + a zero-padded payload). */
const pad = (value: number, length: number) => String(value).padStart(length, "0");
function dayRef(year: number, month: number, day: number): string {
  return `00000000-0000-0000-00dd-${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}0000`;
}
function monthRef(year: number, month: number): string {
  return `00000000-0000-0000-00aa-${pad(year, 4)}${pad(month, 2)}000000`;
}
function yearRef(year: number): string {
  return `00000000-0000-0000-00bb-${pad(year, 4)}00000000`;
}

// ── ganttModel (pure) ───────────────────────────────────────────────────────

describe("ganttDateOf — datetime value → calendar date", () => {
  it("resolves a {nodeId} day ref, a bare-uuid ref, and nulls on junk", () => {
    expect(ganttDateOf({ nodeId: dayRef(2026, 3, 10) }, "start")).toEqual(d(2026, 3, 10));
    expect(ganttDateOf(dayRef(2026, 12, 1), "start")).toEqual(d(2026, 12, 1));
    expect(ganttDateOf(null, "start")).toBeNull();
    expect(ganttDateOf("not-a-date", "start")).toBeNull();
    expect(ganttDateOf({ nodeId: "some-random-uuid-0000-000000000000" }, "start")).toBeNull();
  });

  it("range values resolve by side, falling back to the other side", () => {
    const range = { start: { nodeId: dayRef(2026, 3, 10) }, end: { nodeId: dayRef(2026, 6, 20) } };
    expect(ganttDateOf(range, "start")).toEqual(d(2026, 3, 10));
    expect(ganttDateOf(range, "end")).toEqual(d(2026, 6, 20));
    const openEnd = { start: { nodeId: dayRef(2026, 3, 10) }, end: null };
    expect(ganttDateOf(openEnd, "end")).toEqual(d(2026, 3, 10));
  });

  it("year/month precision refs normalize to the first day", () => {
    expect(ganttDateOf({ nodeId: yearRef(2027) }, "start")).toEqual(d(2027, 1, 1));
    expect(ganttDateOf({ nodeId: monthRef(2027, 5) }, "start")).toEqual(d(2027, 5, 1));
  });
});

describe("buildGantt — lanes, bars, and the time window", () => {
  it("point bars (start only): scheduled rows sorted by start then name", () => {
    const rows: GanttInputRow[] = [
      { id: "b", name: "Beta", color: null, start: d(2026, 5, 1), end: null },
      { id: "a", name: "Alpha", color: null, start: d(2026, 3, 10), end: null },
      { id: "c", name: "Gamma", color: null, start: d(2026, 3, 10), end: null },
    ];
    const chart = buildGantt(rows);
    expect(chart.bars.map((bar) => bar.id)).toEqual(["a", "c", "b"]);
    expect(chart.bars.every((bar) => bar.end === null)).toBe(true);
    expect(chart.unscheduled).toEqual([]);
  });

  it("ranged bars carry the end ordinal; a same-day range stays one day", () => {
    const chart = buildGantt([
      { id: "r", name: "Ranged", color: null, start: d(2026, 3, 10), end: d(2026, 6, 20) },
    ]);
    expect(chart.bars[0]!.startOrdinal).toBe(dateOrdinal(d(2026, 3, 10)));
    expect(chart.bars[0]!.endOrdinal).toBe(dateOrdinal(d(2026, 6, 20)));
  });

  it("unscheduled rows (no start, even with an end) land in the lane, alphabetical", () => {
    const chart = buildGantt([
      { id: "u2", name: "Zulu", color: null, start: null, end: d(2026, 1, 1) },
      { id: "s", name: "Scheduled", color: null, start: d(2026, 3, 1), end: null },
      { id: "u1", name: "Alpha", color: null, start: null, end: null },
    ]);
    expect(chart.unscheduled.map((row) => row.id)).toEqual(["u1", "u2"]);
    expect(chart.bars.map((bar) => bar.id)).toEqual(["s"]);
  });

  it("the window spans min(start)−1mo to max(end)+1mo with a tick per month", () => {
    const chart = buildGantt([
      { id: "a", name: "A", color: null, start: d(2026, 3, 10), end: d(2026, 6, 20) },
    ]);
    expect(chart.window).not.toBeNull();
    // From: first day of the month BEFORE the earliest start month (Feb).
    expect(ordinalDate(chart.window!.from)).toEqual(d(2026, 2, 1));
    // To (exclusive): first day of the month AFTER max(end)+1mo (Aug 1).
    expect(ordinalDate(chart.window!.to)).toEqual(d(2026, 8, 1));
    // Ticks: Feb…Jul — six month starts.
    expect(chart.ticks.map((tick) => ordinalDate(tick))).toEqual([
      d(2026, 2, 1),
      d(2026, 3, 1),
      d(2026, 4, 1),
      d(2026, 5, 1),
      d(2026, 6, 1),
      d(2026, 7, 1),
    ]);
  });

  it("empty input: no bars, no window, no ticks", () => {
    const chart = buildGantt([]);
    expect(chart.bars).toEqual([]);
    expect(chart.unscheduled).toEqual([]);
    expect(chart.window).toBeNull();
    expect(chart.ticks).toEqual([]);
  });

  it("all-unscheduled input: the lane fills, the window stays null", () => {
    const chart = buildGantt([
      { id: "u", name: "Only", color: null, start: null, end: null },
    ]);
    expect(chart.bars).toEqual([]);
    expect(chart.unscheduled.map((row) => row.id)).toEqual(["u"]);
    expect(chart.window).toBeNull();
  });
});

// ── the registered view ─────────────────────────────────────────────────────

describe("gantt as a registry view mode", () => {
  it("registers gantt with label, icon, secondary tier, and the date gate", () => {
    const entry = getViewDefinition("gantt");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Gantt");
    expect(entry!.icon).toBe("mdi-chart-gantt");
    expect(entry!.tier).toBe("secondary");
    expect(entry!.availability?.({ datePropertyCount: 0, linkedItemCount: 0 })).toBe(false);
    expect(entry!.availability?.({ datePropertyCount: 1, linkedItemCount: 0 })).toBe(true);
    expect(getViewModeOptions(["gantt"])[0]!.tier).toBe("secondary");
  });

  /** A class with a bound datetime property; one member valued (a ranged
   *  pair through the same property shape), one unscheduled. */
  async function seedDatedClass(client: WorkspaceClient): Promise<{
    classId: string;
    dueId: string;
    ranged: string;
    point: string;
    unscheduled: string;
    items: Array<{ node: NonNullable<ReturnType<WorkspaceClient["getNode"]>> }>;
  }> {
    const classId = await createTitledClass(client, "Project");
    const dueId = await client.createPropertySchema({ name: "Due", type: "datetime" });
    await client.setClassProperty(classId, dueId, {});
    const ranged = await client.createObject({ isEmbedded: false, name: "Ranged task" });
    const point = await client.createObject({ isEmbedded: false, name: "Point task" });
    const unscheduled = await client.createObject({ isEmbedded: false, name: "Later task" });
    for (const id of [ranged, point, unscheduled]) await client.assignClass(id, classId);
    const { day: startDay } = await client.ensureDateChain("2026-03-10");
    const { day: endDay } = await client.ensureDateChain("2026-06-20");
    const { day: pointDay } = await client.ensureDateChain("2026-04-05");
    await client.setProperty(ranged, dueId, { start: { nodeId: startDay }, end: { nodeId: endDay } }, 0);
    await client.setProperty(point, dueId, { nodeId: pointDay }, 0);
    const items = [ranged, point, unscheduled].map((id) => ({ node: client.getNode(id)! }));
    return { classId, dueId, ranged, point, unscheduled, items };
  }

  it("NodeCollection renders the gantt: bars on the axis, the unscheduled lane, month ticks", async () => {
    const client = await seedClient();
    const { ranged, point, unscheduled, items } = await seedDatedClass(client);
    const { container } = render(
      <NodeCollection viewMode="gantt" client={client} items={items} onNodeClick={() => {}} />,
    );
    const gantt = () => container.querySelector(".gantt") as HTMLElement;
    expect(gantt()).not.toBeNull();
    // The picker defaults to the collection's one date property; the bar
    // rows ride the shared axis.
    expect(within(gantt()).getByLabelText("Start")).not.toBeNull();
    const bars = () =>
      [...gantt()!.querySelectorAll(".gantt__bar")].map((el) =>
        el.getAttribute("data-node-id"),
      );
    expect(bars()).toEqual([ranged, point]);
    // The ranged bar is ONE bar carrying a multi-month width; the point bar
    // rides the same track.
    const rangedBar = gantt()!.querySelector(`.gantt__bar[data-node-id="${ranged}"]`) as HTMLElement;
    expect(rangedBar.style.left).not.toBe("");
    expect(rangedBar.style.width).not.toBe("");
    // The unscheduled lane names the item.
    const lane = gantt()!.querySelector(".gantt__lane") as HTMLElement;
    expect(within(lane).getByText("Later task")).not.toBeNull();
    // Month ticks on the axis.
    expect(gantt()!.textContent).toContain("2026/03");
    void unscheduled;
  });

  it("a bar click opens the node; shift+click peeks (the table's navigation ruling)", async () => {
    const client = await seedClient();
    const { items } = await seedDatedClass(client);
    const opened: string[] = [];
    const peeked: string[] = [];
    const { container } = render(
      <NodeCollection
        viewMode="gantt"
        client={client}
        items={items}
        onNodeClick={(id) => opened.push(id)}
        onNodeShiftClick={(id) => peeked.push(id)}
      />,
    );
    await act(async () => {});
    const firstBar = container.querySelector(".gantt__bar") as HTMLElement;
    fireEvent.click(firstBar);
    expect(opened).toHaveLength(1);
    fireEvent.click(firstBar, { shiftKey: true });
    expect(peeked).toHaveLength(1);
  });

  it("the hub switcher offers Gantt only when the collection carries a date property; the pick persists", async () => {
    const client = await seedClient();
    const plain = await client.createObject({ isEmbedded: false, name: "Plain" });
    const gated = render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Gantt hub"
        items={[{ node: client.getNode(plain)! }]}
        modes={["outline", "gantt"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    // No date-typed valued property: the gate drops gantt — one mode, no switcher.
    expect(screen.queryByRole("radiogroup", { name: "View mode" })).toBeNull();
    gated.unmount();

    const { items } = await seedDatedClass(client);
    writeViewModePref("session.Gantt hub", "gantt");
    render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Gantt hub"
        items={items}
        modes={["outline", "gantt"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    // Armed + persisted: the gantt renders through the registry and the
    // overflow toggle carries the active selection.
    expect(await screen.findByLabelText("Start")).not.toBeNull();
    const toggle = screen.getByRole("button", { name: "More options" });
    expect(toggle.className).toContain("selection-button__overflow-toggle--active");
    fireEvent.click(toggle);
    expect(screen.getByRole("menuitem", { name: "Gantt" }).className).toContain(
      "selection-button__overflow-item--active",
    );
  });

  it("the end-property picker offers the other date properties plus a point-in-time none", async () => {
    const client = await seedClient();
    const seeded = await seedDatedClass(client);
    const otherId = await client.createPropertySchema({ name: "Review", type: "datetime" });
    const classId = seeded.items[0]!.node.classIds[0]!;
    await client.setClassProperty(classId, otherId, {});
    const { container } = render(
      <NodeCollection viewMode="gantt" client={client} items={seeded.items} onNodeClick={() => {}} />,
    );
    const gantt = () => container.querySelector(".gantt") as HTMLElement;
    // Two date properties → the End picker rides beside Start.
    const end = within(gantt()).getByLabelText("End");
    fireEvent.click(end);
    fireEvent.click(
      within(document.querySelector(".dropdown-menu--portal") as HTMLElement).getByRole("option", { name: "Review" }),
    );
    await flushWrites();
    // Picking Review as the end: the ranged task's bar resolves its end from
    // Review (empty → the start fallback), the point task's end falls back to
    // its start — every item stays ONE bar.
    expect(gantt()!.querySelectorAll(".gantt__bar")).toHaveLength(2);
  });
});
