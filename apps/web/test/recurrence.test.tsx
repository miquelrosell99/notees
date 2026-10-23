/**
 * Recurrence web tests (compute-on-read engine):
 * the day view lists virtual occurrences (one row per series, never phantom
 * rows; the sections render through the shared outline collections since
 * 2026-10-23 — row texts via the BlockRow machinery, no repeats marker), a
 * repeating task schedules on occurrence days without ever going overdue,
 * the month grid dots every occurrence day, the property-panel picker
 * writes the `repeat` metadata (and a date re-pick preserves it; the
 * quick-create bar's repeat stamping retired the same day), non-recurring
 * events stay plain, and a corrupt rule fails loud in the read scan.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { CalendarView } from "../src/features/calendar/CalendarView.js";
import { PropertiesSection } from "../src/features/metadata/index.js";
import { addDaysIso, todayIsoLocal } from "../src/features/calendar/calendarViewUtils.js";
import { recurringRowsOf } from "../src/features/calendar/calendarRows.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";
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

/** A user class on the event family with a day-precision date binding ("gathering" — meeting is system vocabulary). */
async function eventFamily(client: WorkspaceClient): Promise<{ classId: string; schemaId: string }> {
  const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
  const classId = await client.createClass("gathering");
  await client.setClassExtends(classId, [SYSTEM_CLASS_UUIDS.event]);
  await client.setClassProperty(classId, schemaId, {});
  return { classId, schemaId };
}

async function createEvent(
  client: WorkspaceClient,
  classId: string,
  schemaId: string,
  name: string,
  iso: string,
  repeat?: string,
): Promise<string> {
  const id = await client.createObject({ isEmbedded: false, name, classIds: [classId] });
  await client.setDatetimeProperty(id, schemaId, { iso }, 0, repeat !== undefined ? { repeat } : undefined);
  return id;
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

/** The section element carrying an aria-label. */
function labeledSection(label: string): HTMLElement {
  const el = screen.queryByLabelText(label);
  expect(el, `section ${label}`).not.toBeNull();
  return el as HTMLElement;
}

/** The outline-collection row texts under a root (BlockRow machinery). */
function rowTexts(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".nt-block-content")].map((el) => el.textContent ?? "");
}

const repeatPickerOption = async (label: string) => {
  const option = await screen.findByText(label);
  fireEvent.click(option);
};

describe("CalendarView recurrence", () => {
  it("lists a weekly event on virtual occurrence days — one row, no phantoms", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    const today = todayIsoLocal();
    await createEvent(client, classId, schemaId, "Standup", today, "weekly");

    renderCalendar(client);
    await screen.findByLabelText("Dated");
    const anchorSection = labeledSection("Dated");
    await waitFor(() => {
      expect(rowTexts(anchorSection)).toContain("Standup");
    });

    // +7 is a pure virtual occurrence: no backlink exists on that day, the
    // expansion puts it there.
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Dated")).toBeDefined();
    });
    const occurrenceSection = labeledSection("Dated");
    await waitFor(() => {
      expect(rowTexts(occurrenceSection)).toContain("Standup");
    });
    expect(rowTexts(occurrenceSection).filter((t) => t === "Standup")).toHaveLength(1);

    // +3 more is NOT an occurrence: the series does not list.
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Dated")).toBeNull();
    });
  });

  it("a repeating task schedules on occurrence days and never goes overdue", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    const pendingId = status.options!.find((option) => option.label === "Pending")!.id;
    const today = todayIsoLocal();

    const makeTask = async (name: string, iso: string, repeat?: string) => {
      const id = await client.createObject({
        isEmbedded: false,
        name,
        classIds: [SYSTEM_CLASS_UUIDS.task],
      });
      await client.setDatetimeProperty(
        id,
        SYSTEM_PROPERTY_UUIDS.taskScheduled,
        { iso },
        0,
        repeat !== undefined ? { repeat } : undefined,
      );
      await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, pendingId, 0);
      return id;
    };
    // Anchored two weeks ago: today is an occurrence; a plain task two days
    // past anchors the overdue contrast.
    await makeTask("Water plants", addDaysIso(today, -14), "weekly");
    await makeTask("Plain overdue", addDaysIso(today, -2));

    renderCalendar(client);
    const section = await screen.findByRole("region", { name: "Tasks" });
    await waitFor(() => {
      expect(within(section).getByText("2 open")).toBeDefined();
    });
    // The repeating task is Scheduled (not Overdue) on its occurrence day…
    expect(within(section).getByText("Scheduled")).toBeDefined();
    await waitFor(() => {
      expect(rowTexts(section)).toContain("Water plants");
    });
    // …while the plain task two days past is honestly overdue, and the
    // repeating task never appears in that group.
    const overdueGroup = within(section)
      .getByText("Overdue")
      .closest("div") as HTMLElement;
    await waitFor(() => {
      expect(rowTexts(overdueGroup)).toContain("Plain overdue");
    });
    expect(rowTexts(overdueGroup)).not.toContain("Water plants");
  });

  it("dots every occurrence day on the month grid, even without a backlink", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    // Anchor on the 3rd: the +7/+10 probe cells always exist in the month.
    const [y, m] = todayIsoLocal().split("-");
    const anchorIso = `${y}-${m}-03`;
    await createEvent(client, classId, schemaId, "Standup", anchorIso, "weekly");

    const { container } = renderCalendar(client);
    await screen.findByText("Calendar");
    fireEvent.click(dayCell(container, "3"));
    await screen.findByLabelText("Dated");
    // The anchor dots via its real backlink; +7 dots purely from the virtual
    // expansion; +10 is not an occurrence and stays plain.
    await waitFor(() => {
      expect(dayCell(container, "10").classList.contains("dated")).toBe(true);
    });
    expect(dayCell(container, "13").classList.contains("dated")).toBe(false);
  });

  it("the property panel picker writes the rule and a date re-pick preserves it", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    const today = todayIsoLocal();
    const id = await createEvent(client, classId, schemaId, "Review", addDaysIso(today, 5));

    render(<PropertiesSection client={client} nodeId={id} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Properties/ }));
    // The single-value date renders the selection dropdown (owner
    // 2026-10-09); the repeat picker rides the cell's trailing chrome.
    const cell = (await screen.findByRole("button", { name: "Set When" })).closest(
      ".nt-property-select",
    ) as HTMLElement;

    // Pick Monthly through the cell's repeat picker.
    fireEvent.click(within(cell).getByText("Repeat for When"));
    await repeatPickerOption("Monthly");
    await waitFor(() => {
      expect(
        client
          .getEffectiveProperties(id)
          .find((prop) => prop.propertySchemaId === schemaId)?.metadata?.repeat,
      ).toBe("monthly");
    });

    // Re-pick the date (Today in the popup) — the rule survives the commit.
    fireEvent.click(within(cell).getByRole("button", { name: "Set When" }));
    fireEvent.click(await screen.findByRole("button", { name: "Go to today" }));
    await waitFor(() => {
      const when = client
        .getEffectiveProperties(id)
        .find((prop) => prop.propertySchemaId === schemaId);
      expect(when?.metadata?.repeat).toBe("monthly");
    });
  });

  it("non-recurring events stay plain: anchor day only, no extra dots", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    // Anchor on the 2nd: the +7 probe cell always exists in the month.
    const [y, m] = todayIsoLocal().split("-");
    const anchorIso = `${y}-${m}-02`;
    await createEvent(client, classId, schemaId, "One-off", anchorIso);

    const { container } = renderCalendar(client);
    await screen.findByText("Calendar");
    fireEvent.click(dayCell(container, "2"));
    const section = labeledSection("Dated");
    await waitFor(() => {
      expect(rowTexts(section)).toContain("One-off");
    });

    // Only the anchor day dots (its real backlink); +7 has nothing.
    await waitFor(() => {
      expect(dayCell(container, "2").classList.contains("dated")).toBe(true);
    });
    expect(dayCell(container, "9").classList.contains("dated")).toBe(false);
  });

  it("a corrupt rule fails loud in the read scan, never reads as plain", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    await createEvent(client, classId, schemaId, "Broken", todayIsoLocal(), "whenever");
    expect(() => recurringRowsOf(client)).toThrow(/invalid recurrence rule/);
  });
});
