/**
 * CalendarView tests: the day zoom's date line (Today marker only on today),
 * the day AGENDA (the selected day's events as colored cards — timed first
 * by start time, the clock prefix, the empty-state line, the card open),
 * the month grid (event-family blocking — dated in or embedded, never mere
 * date carriers — block colors, drag/drop rewrites and the recurring scope
 * dialog, the timed blocks' clock prefix), the top-bar period navigator,
 * the day-number → day page register, the zoom ladder, and the
 * dblclick-to-create flow (the event modal opens on the cell, the create
 * lands an event-classed named node and opens it).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { parseDateNodeId, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { CalendarView } from "../src/features/calendar/CalendarView.js";
import {
  addDaysIso,
  scheduledIsoOf,
  todayIsoLocal,
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

/** A fresh datetime schema id (keeps tests independent). */
async function dateSchemaOf(client: WorkspaceClient): Promise<string> {
  return client.createPropertySchema({ name: "When", type: "datetime" });
}

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

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

describe("CalendarView", () => {
  it("shows the Today marker and the local date only for today", async () => {
    const client = await seedClient();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("day"));
    const { container } = render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const today = todayIsoLocal();

    expect(screen.getByText("Calendar")).toBeDefined();
    const marker = () => container.querySelector(".calendar-view__today-marker");
    expect(marker()).not.toBeNull();
    expect(screen.getByText(today)).toBeDefined();
  });

  // --- the day agenda (the Day zoom's body, owner 2026-10-24) --------------

  it("the day agenda lists the day's events as cards — timed first, with the clock prefix; a card click opens the event", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const schemaId = await dateSchemaOf(client);
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(gatheringClass, schemaId, {});

    // Untimed (full-day) event, alphabetic winner by name…
    await client.ensureDateChain(today);
    const allDay = await client.createObject({
      isEmbedded: false,
      name: "Aardvark picnic",
      classIds: [gatheringClass],
    });
    await client.setProperty(allDay, schemaId, { nodeId: dayNodeOf(today) }, 0);
    // …and a TIMED event that must list FIRST despite the name (timed-first).
    const timed = await client.createObject({
      isEmbedded: false,
      name: "Zebra sync",
      classIds: [gatheringClass],
    });
    await client.setProperty(timed, schemaId, { nodeId: dayNodeOf(today), time: "14:30" }, 0);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("day"));
    const onOpenPage = vi.fn();
    render(<CalendarView client={client} onOpenPage={onOpenPage} />);

    const agenda = await screen.findByLabelText("Day agenda");
    await waitFor(() => {
      expect(agenda.textContent).toContain("14:30 Zebra sync");
      expect(agenda.textContent).toContain("Aardvark picnic");
    });
    // Timed first, then untimed alphabetically.
    const texts = [...agenda.querySelectorAll(".cal-agenda__card")].map(
      (el) => el.textContent ?? "",
    );
    expect(texts[0]).toContain("14:30 Zebra sync");
    expect(texts[1]).toContain("Aardvark picnic");

    // A card click opens the event.
    fireEvent.click(agenda.querySelector(".cal-agenda__card") as HTMLElement);
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith(timed));
  });

  it("the day agenda renders a same-day timed range as '14:30–16:00 Title'", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const schemaId = await dateSchemaOf(client);
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(gatheringClass, schemaId, {});

    await client.ensureDateChain(today);
    const id = await client.createObject({
      isEmbedded: false,
      name: "Deep work",
      classIds: [gatheringClass],
    });
    await client.setProperty(
      id,
      schemaId,
      {
        start: { nodeId: dayNodeOf(today), time: "14:30" },
        end: { nodeId: dayNodeOf(today), time: "16:00" },
      },
      0,
    );

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("day"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const agenda = await screen.findByLabelText("Day agenda");
    await waitFor(() => {
      expect(agenda.textContent).toContain("14:30–16:00 Deep work");
    });
  });

  it("the day agenda shows the honest empty line on an eventless day", async () => {
    const client = await seedClient();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    await screen.findByLabelText("Calendar month view");
    // A day of the visible month guaranteed to carry no events (the seed
    // authors nothing dated).
    const otherDay = new Date().getDate() === 20 ? "21" : "20";
    fireEvent.click(dayCell(container, otherDay));
    fireEvent.click(screen.getByRole("radio", { name: "Day" }));
    expect(await screen.findByText("No events this day.")).toBeDefined();
    // The day view's retired sections stay gone — the agenda is the body.
    expect(screen.queryByRole("region", { name: "Daily note" })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  // --- dblclick-to-create (owner 2026-10-24) --------------------------------

  it("a cell dblclick opens the create modal prefilled with the day; creating lands an event-classed named node and opens it", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const onOpenPage = vi.fn();
    const { container } = render(<CalendarView client={client} onOpenPage={onOpenPage} />);
    await screen.findByLabelText("Calendar month view");

    fireEvent.doubleClick(dayCell(container, String(new Date().getDate())));
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    // The dblclicked day prefills the start day.
    const startDay = within(dialog).getByLabelText("Start day") as HTMLInputElement;
    expect(startDay.value).toBe(today);

    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Roadmap review" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(1));
    const id = onOpenPage.mock.calls[0]![0] as string;
    const created = client.getNode(id)!;
    expect(created.classIds).toEqual([SYSTEM_CLASS_UUIDS.event]);
    expect(created.contentAst).toEqual([{ type: "text", text: "Roadmap review" }]);
    // The modal closed with the create.
    expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
  });

  it("a dblclick on a block or the day number does not open the create modal", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const schemaId = await dateSchemaOf(client);
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(gatheringClass, schemaId, {});
    await client.ensureDateChain(today);
    const id = await client.createObject({
      isEmbedded: false,
      name: "Occupied day",
      classIds: [gatheringClass],
    });
    await client.setProperty(id, schemaId, { nodeId: dayNodeOf(today) }, 0);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => expect(grid.querySelector(".cal-block")).not.toBeNull());

    const todayCell = dayCell(container, String(new Date().getDate()));
    // On the block: no modal (the block owns its own click).
    fireEvent.doubleClick(todayCell.querySelector(".cal-block") as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
    // On the day number: no modal (the open-page affordance).
    fireEvent.doubleClick(todayCell.querySelector(".cal-grid__daynum") as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
  });

  // --- the grids ------------------------------------------------------------

  it("the month grid blocks event-family nodes dated into the scope, not mere date carriers", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
    // A generic user class — "meeting" is system-class vocabulary — on the
    // event family; and a class that merely carries a date property.
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(gatheringClass, schemaId, {});
    const plainClass = await client.createClass("anime");
    await client.setClassProperty(plainClass, schemaId, {});

    const gathering = await client.createObject({
      isEmbedded: false,
      name: "Launch party",
      classIds: [gatheringClass],
    });
    await client.setDatetimeProperty(gathering, schemaId, { iso: today }, 0);
    const anime = await client.createObject({
      isEmbedded: false,
      name: "Episode 12",
      classIds: [plainClass],
    });
    await client.setDatetimeProperty(anime, schemaId, { iso: today }, 0);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => {
      expect(grid.textContent).toContain("Launch party");
    });
    expect(grid.textContent).not.toContain("Episode 12");
  });

  it("the month grid blocks event-family blocks embedded at any depth inside the day page", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const { day } = await client.ensureDateChain(today);
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);

    const block = await client.createObject({
      isEmbedded: true,
      parentId: day,
      name: "Embedded gathering",
      classIds: [gatheringClass],
    });
    // Depth two: a nested block under the embedded block.
    await client.createObject({
      isEmbedded: true,
      parentId: block,
      name: "Nested gathering",
      classIds: [gatheringClass],
    });
    // A plain block with no class: never an event row.
    await client.createObject({
      isEmbedded: true,
      parentId: day,
      contentAst: [{ type: "text", text: "Plain note" }],
    });

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => {
      expect(grid.textContent).toContain("Embedded gathering");
      expect(grid.textContent).toContain("Nested gathering");
    });
    expect(grid.textContent).not.toContain("Plain note");
  });

  it("a timed block prefixes the label with the clock time; a same-day range shows both", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const schemaId = await dateSchemaOf(client);
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(gatheringClass, schemaId, {});

    await client.ensureDateChain(today);
    const timed = await client.createObject({
      isEmbedded: false,
      name: "Timed sync",
      classIds: [gatheringClass],
    });
    await client.setProperty(timed, schemaId, { nodeId: dayNodeOf(today), time: "09:15" }, 0);
    const ranged = await client.createObject({
      isEmbedded: false,
      name: "Workshop",
      classIds: [gatheringClass],
    });
    await client.setProperty(
      ranged,
      schemaId,
      {
        start: { nodeId: dayNodeOf(today), time: "14:30" },
        end: { nodeId: dayNodeOf(today), time: "16:00" },
      },
      0,
    );

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => {
      expect(grid.textContent).toContain("09:15 Timed sync");
      expect(grid.textContent).toContain("14:30–16:00 Workshop");
    });
  });

  it("a multi-day range value blocks every covered day (the canonical span register)", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const plusOne = addDaysIso(today, 1);
    const plusTwo = addDaysIso(today, 2);
    const schemaId = await dateSchemaOf(client);
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(gatheringClass, schemaId, {});

    await client.ensureDateChain(today);
    await client.ensureDateChain(plusTwo);
    const id = await client.createObject({
      isEmbedded: false,
      name: "Offsite",
      classIds: [gatheringClass],
    });
    await client.setProperty(
      id,
      schemaId,
      { start: { nodeId: dayNodeOf(today) }, end: { nodeId: dayNodeOf(plusTwo) } },
      0,
    );

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => {
      // The start day blocks from its real backlink; the middle and end
      // days block from the client-side span expansion.
      expect(
        dayCell(container, String(new Date().getDate())).querySelector(".cal-block"),
      ).not.toBeNull();
      expect(grid.textContent).toContain("Offsite");
    });
    expect(
      (container.querySelector(`[data-day="${plusOne}"]`) as HTMLElement).querySelector(
        ".cal-block",
      ),
    ).not.toBeNull();
    expect(
      (container.querySelector(`[data-day="${plusTwo}"]`) as HTMLElement).querySelector(
        ".cal-block",
      ),
    ).not.toBeNull();
  });

  it("month-grid day pick updates the selected day", async () => {
    const client = await seedClient();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const today = todayIsoLocal();
    const marker = () => container.querySelector(".calendar-view__today-marker");
    // A day of the visible month guaranteed to differ from today.
    const target = new Date().getDate() === 20 ? "21" : "20";
    const targetIso = (() => {
      const [y, m] = today.split("-").map(Number);
      return `${y}-${String(m).padStart(2, "0")}-${target.padStart(2, "0")}`;
    })();

    fireEvent.click(dayCell(container, target));
    await waitFor(() => {
      // The grid cell carries the selected ring.
      expect(
        container.querySelector(".cal-grid__cell--selected")?.getAttribute("data-day"),
      ).toBe(targetIso);
    });
    // The day zoom's date line follows the selection.
    fireEvent.click(screen.getByRole("radio", { name: "Day" }));
    await waitFor(() => {
      expect(marker()).toBeNull();
      expect(screen.getByText(targetIso)).toBeDefined();
    });
  });

  it("lands on the month grid (grid-first) and renders event blocks colored by effective color", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.setClassProperty(gatheringClass, schemaId, {});
    const gathering = await client.createObject({
      isEmbedded: false,
      name: "Launch party",
      classIds: [gatheringClass],
    });
    await client.ensureDateChain(today);
    await client.setDatetimeProperty(gathering, schemaId, { iso: today }, 0);
    await client.updateObject(gatheringClass, { color: "#ff0000" });

    // No Day pin — the calendar defaults to the grid.
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    // The event block renders in the today's cell with the class color.
    const block = await (async () => {
      await waitFor(() => {
        const found = grid.querySelector(".cal-block");
        expect(found).not.toBeNull();
      });
      return grid.querySelector(".cal-block") as HTMLElement;
    })();
    expect(block.textContent).toContain("Launch party");
    expect(block.style.background).toContain("rgb(255, 0, 0)");
    // The agenda is not rendered in the month zoom.
    expect(screen.queryByLabelText("Day agenda")).toBeNull();
    // The ladder is present with Month pressed.
    expect(
      screen.getByRole("radio", { name: "Month" }),
    ).toBeDefined();
  });

  it("an event whose content is only an inline class chip wears the class's current name", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.updateObject(gatheringClass, {
      contentAst: [{ type: "text", text: "gathering" }],
    });
    // The event is an EMBEDDED block (the day-page events register): blocks
    // keep the rich stream, so its whole content can be the inline class
    // chip — an inline class link IS content (a bare class pill/assignment
    // is not): the card excerpts to the class's current name.
    const { day } = await client.ensureDateChain(today);
    const gathering = await client.createObject({
      isEmbedded: true,
      parentId: day,
      contentAst: [{ type: "class_link", classId: gatheringClass }],
      classIds: [gatheringClass],
    });
    await client.setDatetimeProperty(gathering, await dateSchemaOf(client), { iso: today }, 0);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => expect(grid.querySelector(".cal-block")).not.toBeNull());
    expect(grid.querySelector(".cal-block")!.textContent).toContain("gathering");
    // Rename the class: the card follows the CURRENT name (chip resolves
    // live, not a stored snapshot).
    await client.updateObject(gatheringClass, {
      contentAst: [{ type: "text", text: "assembly" }],
    });
    await waitFor(() => {
      expect(grid.querySelector(".cal-block")!.textContent).toContain("assembly");
    });
  });

  it("an event with only a class pill (membership, no inline chip) reads Untitled", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    await client.updateObject(gatheringClass, {
      contentAst: [{ type: "text", text: "gathering" }],
    });
    const { day } = await client.ensureDateChain(today);
    // Membership only: classIds, empty content, no inline class_link token.
    const gathering = await client.createObject({
      isEmbedded: true,
      parentId: day,
      classIds: [gatheringClass],
    });
    await client.setDatetimeProperty(gathering, await dateSchemaOf(client), { iso: today }, 0);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => expect(grid.querySelector(".cal-block")).not.toBeNull());
    expect(grid.querySelector(".cal-block")!.textContent).toContain("Untitled");
    expect(grid.querySelector(".cal-block")!.textContent).not.toContain("gathering");
  });

  it("the top-bar period navigator steps the month and its title buttons open the date-chain pages", async () => {
    const client = await seedClient();
    const onOpenPage = vi.fn();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={onOpenPage} />);
    await screen.findByLabelText("Calendar month view");
    const nav = document.querySelector(".calendar-view__period-nav") as HTMLElement;
    expect(nav).not.toBeNull();
    // The labels ride the environment's locale — compute, never hardcode.
    const monthLabel = (year: number, month0: number): string =>
      new Date(year, month0, 1).toLocaleDateString(undefined, { month: "long" });
    const thisMonth = monthLabel(new Date().getFullYear(), new Date().getMonth());
    const year = () => nav.querySelector('.calendar-title-btn[title="Open yearly page"]') as HTMLElement;

    // The month button opens the monthly date-chain page.
    fireEvent.click(
      nav.querySelector(".calendar-title-btn--month") as HTMLElement,
    );
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(1));
    const monthId = onOpenPage.mock.calls[0]![0] as string;
    expect(parseDateNodeId(monthId)?.precision).toBe("month");
    // The year button opens the yearly page.
    fireEvent.click(year());
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(2));
    expect(parseDateNodeId(onOpenPage.mock.calls[1]![0] as string)?.precision).toBe("year");

    // The chevrons step the visible period (the navigator's title follows).
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    fireEvent.click(screen.getByRole("button", { name: "Next period" }));
    await waitFor(() => {
      expect(nav.textContent).toContain(monthLabel(next.getFullYear(), next.getMonth()));
    });
    // Today jumps back.
    fireEvent.click(screen.getByRole("button", { name: "Jump to today" }));
    await waitFor(() => {
      expect(nav.textContent).toContain(thisMonth);
    });
  });

  it("the day number opens the day page; the ladder reaches week and year", async () => {
    const client = await seedClient();
    const onOpenPage = vi.fn();
    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={onOpenPage} />);
    const grid = await screen.findByLabelText("Calendar month view");

    // Day-number register: opens the day page (chain ensured on demand).
    fireEvent.click(grid.querySelector(".cal-grid__daynum") as HTMLElement);
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(1));
    const opened = onOpenPage.mock.calls[0]![0] as string;
    expect(client.getNodeRaw(opened)?.id).toBe(opened);

    // Week zoom: seven tall columns.
    fireEvent.click(screen.getByRole("radio", { name: "Week" }));
    await screen.findByLabelText("Calendar week view");
    expect(document.querySelectorAll(".cal-grid__cells--week > div")).toHaveLength(7);

    // Year zoom: twelve compact months.
    fireEvent.click(screen.getByRole("radio", { name: "Year" }));
    await screen.findByLabelText("Calendar year view");
    expect(document.querySelectorAll(".cal-year__month")).toHaveLength(12);
  });

  it("a dropped block on another day rewrites a plain event's date", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const tomorrow = addDaysIso(today, 1);
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    const gathering = await client.createObject({
      isEmbedded: false,
      name: "Move me",
      classIds: [gatheringClass],
    });
    await client.ensureDateChain(today);
    await client.setDatetimeProperty(gathering, await dateSchemaOf(client), { iso: today }, 0);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => expect(grid.querySelector(".cal-block")).not.toBeNull());

    const target = grid.querySelector(`[data-day="${tomorrow}"]`) as HTMLElement;
    fireEvent.drop(target, {
      dataTransfer: { getData: () => `${gathering}|${today}` },
    });

    await waitFor(() => {
      expect(scheduledIsoOfClient(client, gathering)).toBe(tomorrow);
    });
  });

  it("dropping a recurring block asks the scope; 'Only this event' detaches it", async () => {
    const client = await seedClient();
    const today = todayIsoLocal();
    const tomorrow = addDaysIso(today, 1);
    const gatheringClass = await client.createClass("gathering");
    await client.setClassExtends(gatheringClass, [SYSTEM_CLASS_UUIDS.event]);
    const gathering = await client.createObject({
      isEmbedded: false,
      name: "Weekly sync",
      classIds: [gatheringClass],
    });
    await client.ensureDateChain(today);
    const schemaId = await dateSchemaOf(client);
    await client.setProperty(gathering, schemaId, { nodeId: dayNodeOf(today) }, 0, {
      repeat: "weekly",
    });

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    const grid = await screen.findByLabelText("Calendar month view");
    await waitFor(() => expect(grid.querySelector(".cal-block")).not.toBeNull());

    const target = grid.querySelector(`[data-day="${tomorrow}"]`) as HTMLElement;
    fireEvent.drop(target, {
      dataTransfer: { getData: () => `${gathering}|${today}` },
    });

    // The scope sheet asks the Google register.
    const dialog = await screen.findByRole("dialog", { name: "Recurring event" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" })); // "Only this event" is default

    await waitFor(() => {
      // The exception landed on tomorrow; the series exdates today.
      const exception = client
        .listPages()
        .find((node) => node.id !== gathering && node.classIds.includes(gatheringClass));
      expect(exception).toBeDefined();
      expect(scheduledIsoOfClient(client, exception!.id)).toBe(tomorrow);
      const row = client
        .getEffectiveProperties(gathering)
        .find((prop) => prop.schema?.type === "datetime");
      expect(row?.metadata).toMatchObject({ repeat: "weekly", exdates: [today] });
    });
  });
});
