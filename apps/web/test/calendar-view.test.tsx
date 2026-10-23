/**
 * CalendarView tests: the day header (Today marker only on today, prev/next
 * stepping), the events element (event-family nodes dated into the scope or
 * embedded in the scope day pages, the day/week/month zoom), the tasks
 * section (scheduled/overdue partition, "N open", the checkbox done toggle
 * writing the status option id like the tasks hub), the daily-note embed via
 * ensureDateChain, the created-today list, and the MonthCalendar day pick.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { CalendarView } from "../src/features/calendar/CalendarView.js";
import { addDaysIso, todayIsoLocal } from "../src/features/calendar/calendarViewUtils.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  // jsdom lacks ResizeObserver; Tabs.List uses it for the active indicator.
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

function renderCalendar(client: WorkspaceClient, onOpenPage = vi.fn()) {
  return { onOpenPage, ...render(<CalendarView client={client} onOpenPage={onOpenPage} />) };
}

/** The `.calendar-day` cell (button) showing the given day number. */
function dayCell(container: HTMLElement, dayNumber: string): HTMLElement {
  const cell = Array.from(container.querySelectorAll(".calendar-day")).find(
    (el) => el.textContent?.trim() === dayNumber,
  );
  expect(cell, `day cell ${dayNumber}`).toBeDefined();
  return cell as HTMLElement;
}

/** The outline-collection row texts under a root (BlockRow machinery). */
function rowTitles(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".nt-block-content")].map((el) => el.textContent ?? "");
}

describe("CalendarView", () => {
  it("shows the Today marker and the local date only for today", async () => {
    const client = await seedClient();
    const { container } = renderCalendar(client);
    const today = todayIsoLocal();

    expect(screen.getByText("Calendar")).toBeDefined();
    const marker = () => container.querySelector(".calendar-view__today-marker");
    expect(marker()).not.toBeNull();
    expect(screen.getByText(today)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => {
      expect(marker()).toBeNull();
      expect(screen.getByText(addDaysIso(today, -1))).toBeDefined();
    });

    const dayNav = () => within(container.querySelector(".calendar-view__nav") as HTMLElement);
    // The outline-variant register (the Journals view's): the accessible
    // name is "Jump to today", not the bare label.
    fireEvent.click(dayNav().getByRole("button", { name: "Jump to today" }));
    await waitFor(() => {
      expect(marker()).not.toBeNull();
      expect(screen.getByText(today)).toBeDefined();
    });
  });

  it("the events element lists event-family nodes dated into the scope, not mere date carriers", async () => {
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

    renderCalendar(client);
    const events = await screen.findByLabelText("Events");
    await waitFor(() => {
      expect(rowTitles(events)).toContain("Launch party");
    });
    expect(rowTitles(events)).not.toContain("Episode 12");
  });

  it("the events element lists event-family blocks embedded at any depth inside the day page", async () => {
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

    renderCalendar(client);
    const events = await screen.findByLabelText("Events");
    await waitFor(() => {
      expect(rowTitles(events)).toContain("Embedded gathering");
      expect(rowTitles(events)).toContain("Nested gathering");
    });
    expect(rowTitles(events)).not.toContain("Plain note");
  });

  it("the events zoom switches the scope: day follows the selected day, month widens to it", async () => {
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
    await client.setDatetimeProperty(gathering, schemaId, { iso: today }, 0);

    const { container } = renderCalendar(client);
    const events = await screen.findByLabelText("Events");
    // Week zoom (the default) contains today: the row lists.
    await waitFor(() => {
      expect(rowTitles(events)).toContain("Launch party");
    });

    // Day zoom + a different selected day of the same month: the row leaves.
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    const otherDay = new Date().getDate() === 20 ? "21" : "20";
    fireEvent.click(dayCell(container, otherDay));
    await waitFor(() => {
      expect(within(events).getByText("No events this day.")).toBeDefined();
    });

    // Month zoom widens the scope back over the whole month: the row returns.
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    await waitFor(() => {
      expect(rowTitles(events)).toContain("Launch party");
    });
  });

  it("partitions open tasks into Overdue/Scheduled groups with a count", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    const pendingId = status.options!.find((option) => option.label === "Pending")!.id;
    const doneId = status.options!.find((option) => option.label === "Done")!.id;
    const today = todayIsoLocal();

    const makeTask = async (name: string, iso: string, statusId: string) => {
      const id = await client.createObject({
        isEmbedded: false,
        name,
        classIds: [SYSTEM_CLASS_UUIDS.task],
      });
      await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, { iso });
      await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, statusId, 0);
      return id;
    };
    await makeTask("Task today", today, pendingId);
    await makeTask("Task overdue", addDaysIso(today, -3), pendingId);
    await makeTask("Task done", today, doneId);

    renderCalendar(client);
    const section = await screen.findByRole("region", { name: "Tasks" });
    await waitFor(() => {
      expect(within(section).getByText("2 open")).toBeDefined();
    });
    expect(within(section).getByText("Overdue")).toBeDefined();
    // Plain editable outline rows (owner 2026-10-23): the title rides the
    // BlockRow machinery, no checkbox or status chrome.
    const titles = () => rowTitles(section);
    await waitFor(() => {
      expect(titles()).toContain("Task overdue");
      expect(titles()).toContain("Task today");
    });
    expect(titles()).not.toContain("Task done");
  });

  it("creates the daily note in place via the empty-state button", async () => {
    const client = await seedClient();
    const { container } = renderCalendar(client);
    const today = todayIsoLocal();

    const section = screen.getByRole("region", { name: "Daily note" });
    const create = within(section).getByRole("button", { name: "Daily Note" });
    fireEvent.click(create);

    const dayId = `00000000-0000-0000-00dd-${today.replace(/-/g, "")}0000`;
    await waitFor(() => expect(client.getNodeRaw(dayId)).not.toBeUndefined());
    // The embed replaces the empty state once the chain exists.
    await waitFor(() => {
      expect(within(screen.getByRole("region", { name: "Daily note" })).queryByRole("button", { name: "Daily Note" })).toBeNull();
    });
    void container;
  });

  it("lists objects created on the selected day, newest first, excluding the date chain", async () => {
    const client = await seedClient();
    // Ensure the chain exists (created-at writes) — its nodes must NOT list.
    const today = todayIsoLocal();
    await client.ensureDateChain(today);
    await client.createObject({ isEmbedded: false, name: "Fresh object" });

    renderCalendar(client);
    const section = await screen.findByRole("region", { name: "Created" });
    await waitFor(() => {
      expect(rowTitles(section)).toContain("Fresh object");
    });
    expect(within(section).queryByText(today.replace(/-/g, ""))).toBeNull();
  });

  it("month-grid day pick updates the selected day", async () => {
    const client = await seedClient();
    const { container } = renderCalendar(client);
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
      expect(marker()).toBeNull();
      expect(screen.getByText(targetIso)).toBeDefined();
    });
  });

  it("the created filter shows the EmptyState copy on an empty day", async () => {
    const client = await seedClient(new MemoryRelay());
    renderCalendar(client);
    // The view's own task-family authoring creates nodes *today*, so pick an
    // uncreated day: yesterday.
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Created" }));
    expect(await screen.findByText("There's nothing here (yet).")).toBeDefined();
  });

  it("filter tabs switch the rendered sections", async () => {
    const client = await seedClient();
    renderCalendar(client);
    expect(await screen.findByRole("region", { name: "Daily note" })).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Created" }));
    const created = await screen.findByRole("region", { name: "Created" });
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Daily note" })).toBeNull();
    });
    // The seed-authored task class node was created today, so it lists here.
    await waitFor(() => {
      expect(rowTitles(created)).toContain("task");
    });

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Daily note" })).toBeDefined();
    });
  });
});
