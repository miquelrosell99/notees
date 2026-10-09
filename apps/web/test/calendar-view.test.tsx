/**
 * CalendarView tests: the day header (Today marker only on today, prev/next
 * stepping), the quick-create chips (create + date-property + open), the
 * tasks section (scheduled/overdue partition, "N open", the checkbox done
 * toggle writing the status option id like the tasks hub), the daily-note
 * embed via ensureDateChain, the created-today list, and the MonthCalendar
 * day pick.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { CalendarView } from "../src/ui/components/CalendarView.js";
import { addDaysIso, todayIsoLocal } from "../src/ui/components/calendarViewUtils.js";
import { ensureTaskFamily } from "../src/ui/components/taskFamily.js";
import { writeQuickCreateClassesSetting } from "../src/ui/components/calendarQuickCreateSettings.js";

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

/** A real workspace is server-seeded: the task class node exists. */
function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.task, contentAst: [{ type: "text", text: "task" }], icon: "mdiCheckboxMarkedCircleOutline" },
      [SYSTEM_CLASS_UUIDS.task],
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
    fireEvent.click(dayNav().getByRole("button", { name: "Today" }));
    await waitFor(() => {
      expect(marker()).not.toBeNull();
      expect(screen.getByText(today)).toBeDefined();
    });
  });

  it("quick-create chips follow the per-workspace setting", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
    // A generic user class — "meeting" is system-class vocabulary.
    const classId = await client.createClass("gathering");
    await client.setClassProperty(classId, schemaId, {});
    // Explicit empty list for this workspace: no chips render.
    writeQuickCreateClassesSetting(WS, []);

    renderCalendar(client);
    await screen.findByText("Calendar");
    expect(screen.queryByLabelText("Quick create")).toBeNull();

    // Back to defaults (null): both eligible classes render again.
    writeQuickCreateClassesSetting(WS, null);
    const quickCreate = () => within(screen.getByLabelText("Quick create"));
    await waitFor(() => {
      expect(quickCreate().getByRole("button", { name: "gathering" })).toBeDefined();
    });
    expect(quickCreate().getByRole("button", { name: "task" })).toBeDefined();
  });

  it("quick-create chip authors a classed object with the date property and opens it", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
    // A generic user class — "meeting" is system-class vocabulary.
    const classId = await client.createClass("gathering");
    await client.setClassProperty(classId, schemaId, {});

    const { onOpenPage, container } = renderCalendar(client);
    const chip = await screen.findByRole("button", { name: "gathering" });
    fireEvent.click(chip);

    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(1));
    const newId = onOpenPage.mock.calls[0]![0] as string;
    const node = client.getNode(newId)!;
    expect(node.classIds).toContain(classId);
    const when = client
      .getEffectiveProperties(newId)
      .find((prop) => prop.propertySchemaId === schemaId);
    expect(when?.value).toBeDefined();
    void container;
  });

  it("partitions open tasks into Overdue/Scheduled with a count and toggles done like the hub", async () => {
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
        presentAsMain: true,
        name,
        classIds: [SYSTEM_CLASS_UUIDS.task],
      });
      await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, { iso });
      await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, statusId, 0);
      return id;
    };
    const todayOpen = await makeTask("Task today", today, pendingId);
    await makeTask("Task overdue", addDaysIso(today, -3), pendingId);
    await makeTask("Task done", today, doneId);

    renderCalendar(client);
    const section = await screen.findByRole("region", { name: "Tasks" });
    await waitFor(() => {
      expect(within(section).getByText("2 open")).toBeDefined();
    });
    expect(within(section).getByText("Overdue")).toBeDefined();
    expect(within(section).getByText("Task overdue")).toBeDefined();
    expect(within(section).getByText("Task today")).toBeDefined();
    expect(within(section).queryByText("Task done")).toBeNull();

    // The checkbox write mirrors the tasks hub's cell edit: the status
    // option id via property.set.
    const row = within(section).getByText("Task today").closest("li")!;
    fireEvent.click(within(row as HTMLElement).getByRole("checkbox"));
    await waitFor(() => {
      const value = client
        .getEffectiveProperties(todayOpen)
        .find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value;
      expect(value).toBe(doneId);
    });
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
    await client.createObject({ presentAsMain: true, name: "Fresh object" });

    renderCalendar(client);
    const section = await screen.findByRole("region", { name: "Created" });
    await waitFor(() => {
      expect(within(section).getByText("Fresh object")).toBeDefined();
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
    expect(within(created).getByText("task")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Daily note" })).toBeDefined();
    });
  });
});
