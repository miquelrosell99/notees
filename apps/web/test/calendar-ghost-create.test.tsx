/**
 * TimeGrid click-to-create ghost tests (owner 2026-10-24, refining the
 * Google click-to-create register): a plain click on an empty hour area
 * spawns the inline ghost card (1-hour span; the divider hit zone gives the
 * HH:30 – HH+1:30 half-hour offset), the autofocused title confirms on
 * Enter (empty = cancel), Escape or clicking elsewhere dismisses, the
 * ghost's button opens the detailed EventCreateModal prefilled with the
 * span, the top/bottom borders resize at the 30-minute snap, and grid-body
 * clicks no longer select the day column (the header day-number button owns
 * selection). Geometry mirrors calendar-timegrid.test.tsx: the column
 * rect is stubbed to 1440px tall so clientY maps 1:1 to minutes.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { TimeGrid } from "../src/features/calendar/TimeGrid.js";
import { todayIsoLocal } from "../src/features/calendar/calendarViewUtils.js";

/** The deterministic day-node id for a local ISO day. */
function dayNodeOf(iso: string): string {
  return `00000000-0000-0000-00dd-${iso.replace(/-/g, "")}0000`;
}

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
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

function renderTimeGrid(client: WorkspaceClient, iso: string) {
  const onSelectDay = vi.fn();
  const onOpenEvent = vi.fn();
  const onOpenDayPage = vi.fn();
  render(
    <TimeGrid
      client={client}
      days={[iso]}
      selectedIso={iso}
      recurringRows={[]}
      spannedRows={[]}
      onSelectDay={onSelectDay}
      onOpenEvent={onOpenEvent}
      onOpenDayPage={onOpenDayPage}
    />,
  );
  return { onSelectDay, onOpenEvent, onOpenDayPage };
}

/** The 1px-per-minute geometry stub: the column is 1440px tall. */
function stubColumn(grid: HTMLElement, iso: string): HTMLElement {
  const column = grid.querySelector(`.cal-timegrid__day[data-day="${iso}"]`) as HTMLElement;
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
  return column;
}

describe("TimeGrid click-to-create ghost (owner 2026-10-24)", () => {
  it("a click at an hour spawns the ghost with the 1-hour span — and does NOT select the day column", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { onSelectDay } = renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    fireEvent.click(column, { clientY: 570 });

    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    expect(ghost).not.toBeNull();
    // 09:00 – 10:00 (y=570 → the 09:00 hour row).
    expect(ghost.getAttribute("data-start")).toBe("540");
    expect(ghost.getAttribute("data-end")).toBe("600");
    expect(ghost.style.top).toBe(`${(540 / 1440) * 100}%`);
    expect(ghost.style.height).toBe(`${(60 / 1440) * 100}%`);
    // The span label rides the ghost.
    expect(ghost.textContent).toContain("09:00 – 10:00");
    // The title field is autofocused.
    const field = ghost.querySelector("input")!;
    expect(document.activeElement).toBe(field);
    // The grid-body click no longer selects the day.
    expect(onSelectDay).not.toHaveBeenCalled();
  });

  it("a click on the hour divider anchors the half-hour span (HH:30 – HH+1:30)", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    // y=600 is exactly the 10:00 boundary (1440px / 24h = 60px per hour).
    fireEvent.click(column, { clientY: 600 });

    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    expect(ghost).not.toBeNull();
    expect(ghost.getAttribute("data-start")).toBe("630");
    expect(ghost.getAttribute("data-end")).toBe("690");
    expect(ghost.textContent).toContain("10:30 – 11:30");
  });

  it("Enter creates the event-classed node with the span and opens it", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { onOpenEvent } = renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    fireEvent.click(column, { clientY: 570 });
    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    const field = ghost.querySelector("input")!;
    fireEvent.change(field, { target: { value: "Coffee sync" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(onOpenEvent).toHaveBeenCalledTimes(1));
    const id = onOpenEvent.mock.calls[0]![0] as string;

    const node = client.getNode(id);
    expect(node).toBeDefined();
    expect(node!.classIds).toContain(SYSTEM_CLASS_UUIDS.event);
    // Title-is-content: the text IS the node's content.
    expect(node!.contentAst).toEqual([{ type: "text", text: "Coffee sync" }]);
    // The same-day timed range on the system event class's first binding.
    const row = client
      .getEffectiveProperties(id)
      .find((prop) => prop.source === "authored");
    expect(row).toBeDefined();
    expect(row!.value).toEqual({
      start: { nodeId: dayNodeOf(today), time: "09:00" },
      end: { nodeId: dayNodeOf(today), time: "10:00" },
    });
    // The ghost is gone (the card paints on the host's next subscription
    // tick — CalendarView subscribes; this direct render does not).
    expect(column.querySelector(".cal-timegrid__ghost")).toBeNull();
  });

  it("an empty-text Enter cancels — nothing is created", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { onOpenEvent } = renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    fireEvent.click(column, { clientY: 570 });
    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    fireEvent.keyDown(ghost.querySelector("input")!, { key: "Enter" });

    await waitFor(() => {
      expect(column.querySelector(".cal-timegrid__ghost")).toBeNull();
    });
    expect(onOpenEvent).not.toHaveBeenCalled();
    expect(column.querySelector(".cal-timegrid__card")).toBeNull();
  });

  it("Escape cancels the ghost — nothing is created", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { onOpenEvent } = renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    fireEvent.click(column, { clientY: 570 });
    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    const field = ghost.querySelector("input")!;
    fireEvent.change(field, { target: { value: "Abandoned" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(column.querySelector(".cal-timegrid__ghost")).toBeNull();
    expect(onOpenEvent).not.toHaveBeenCalled();
    expect(column.querySelector(".cal-timegrid__card")).toBeNull();
  });

  it("clicking elsewhere on the grid re-anchors (cancels and respawns) the ghost", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    fireEvent.click(column, { clientY: 570 });
    expect(column.querySelector(".cal-timegrid__ghost")?.getAttribute("data-start")).toBe("540");
    // A click in another hour replaces the ghost.
    fireEvent.click(column, { clientY: 810 });
    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    expect(ghost.getAttribute("data-start")).toBe("780");
    expect(ghost.getAttribute("data-end")).toBe("840");
  });

  it("the ghost's more-button opens the detailed modal prefilled with the span", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    fireEvent.click(column, { clientY: 570 });
    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    fireEvent.click(ghost.querySelector("button")!);

    const dialog = await screen.findByRole("dialog", { name: "New event" });
    expect((dialog.querySelector("input") as HTMLInputElement).value).toBe("");
    // The modal carries the ghost's day + start/end times.
    const labels = [...dialog.querySelectorAll("input")].map((el) => el.value);
    expect(labels).toContain(today);
    expect(labels).toContain("09:00");
    expect(labels).toContain("10:00");
    // The ghost dismissed itself for the modal.
    expect(column.querySelector(".cal-timegrid__ghost")).toBeNull();
  });

  it("dragging the ghost's bottom border resizes the end at the 30-minute snap", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    fireEvent.click(column, { clientY: 570 });
    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    const bottom = ghost.querySelector(".cal-timegrid__ghost-handle--bottom") as HTMLElement;

    fireEvent.mouseDown(bottom, { clientY: 600 });
    fireEvent.mouseMove(window, { clientY: 745 });
    fireEvent.mouseUp(window);

    // 745 minutes snaps to 12:30 (750); the start holds at 09:00.
    expect(ghost.getAttribute("data-start")).toBe("540");
    expect(ghost.getAttribute("data-end")).toBe("750");
    expect(ghost.textContent).toContain("09:00 – 12:30");
  });

  it("dragging the ghost's top border resizes the start, guarding start < end", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");
    const column = stubColumn(grid, today);

    fireEvent.click(column, { clientY: 570 });
    const ghost = column.querySelector(".cal-timegrid__ghost") as HTMLElement;
    const top = ghost.querySelector(".cal-timegrid__ghost-handle--top") as HTMLElement;

    // Drag below the end: the 30-minute floor holds the start before 10:00.
    fireEvent.mouseDown(top, { clientY: 540 });
    fireEvent.mouseMove(window, { clientY: 900 });
    fireEvent.mouseUp(window);
    expect(ghost.getAttribute("data-start")).toBe("570");
    expect(ghost.getAttribute("data-end")).toBe("600");

    // A genuine upward drag moves the start to the snap.
    fireEvent.mouseDown(top, { clientY: 570 });
    fireEvent.mouseMove(window, { clientY: 479 });
    fireEvent.mouseUp(window);
    expect(ghost.getAttribute("data-start")).toBe("480");
    expect(ghost.getAttribute("data-end")).toBe("600");
  });

  it("the day number opens the day page; the header's empty space selects (owner register)", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { onSelectDay, onOpenDayPage } = renderTimeGrid(client, today);
    const grid = screen.getByLabelText("Calendar day view");

    // The number: opens the page, does NOT select.
    fireEvent.click(grid.querySelector(".cal-timegrid__daynum") as HTMLElement);
    expect(onOpenDayPage).toHaveBeenCalledWith(today);
    expect(onSelectDay).not.toHaveBeenCalled();

    // The header cell around the number: selects, does NOT open.
    fireEvent.click(grid.querySelector(".cal-timegrid__head") as HTMLElement);
    expect(onSelectDay).toHaveBeenCalledWith(today);
    expect(onOpenDayPage).toHaveBeenCalledTimes(1);
  });
});
