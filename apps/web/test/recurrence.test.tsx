/**
 * Recurrence web tests (compute-on-read engine):
 * the day time grid lists virtual occurrences (one chip per series, never
 * phantom rows), a repeating task schedules on occurrence days without ever
 * going overdue (asserted through the day page's Tasks section), the month
 * grid blocks every occurrence day, the repeat property carries the rule (as
 * a plain RRULE string or a {nodeId} carrier block's text) — re-picking the
 * scheduled day moves the anchor while the repeat value rides untouched;
 * non-recurring events stay plain, and a corrupt rule fails loud in the
 * read scan.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { CalendarView } from "../src/features/calendar/CalendarView.js";
import { PageView } from "../src/ui/PageView.js";
import { addDaysIso, todayIsoLocal } from "../src/features/calendar/calendarViewUtils.js";
import { recurringRowsOf, setTaskDone, taskRowFacts } from "../src/features/calendar/calendarRows.js";
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
  repeatMetadata?: Record<string, unknown>,
): Promise<string> {
  const id = await client.createObject({ isEmbedded: false, name, classIds: [classId] });
  await client.setDatetimeProperty(id, schemaId, { iso }, 0);
  // The rule lives on the dedicated Repeat property (a text value), never on
  // the date value's metadata.
  if (repeat !== undefined) {
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.repeat, repeat, 0, repeatMetadata);
  }
  return id;
}

function renderCalendar(client: WorkspaceClient, onOpenPage = vi.fn()) {
  // The zoom is each spec's own pin (day for the section specs, month for
  // the grid specs) — this helper stays neutral.
  return { onOpenPage, ...render(<CalendarView client={client} onOpenPage={onOpenPage} />) };
}

/** The grid CELL (background click selects) for the given day of month. */
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

const WEEKLY_RRULE = "RRULE:FREQ=WEEKLY";

describe("CalendarView recurrence", () => {
  it("lists a weekly event on virtual occurrence days in the day time grid — one chip, no phantoms", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    // Anchor on the 3rd: the 3rd/10th/13th navigation below stays
    // deterministic whatever day of the month today is.
    const [y, m] = todayIsoLocal().split("-");
    const anchorIso = `${y}-${m}-03`;
    await createEvent(client, classId, schemaId, "Standup", anchorIso, WEEKLY_RRULE);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = render(<CalendarView client={client} onOpenPage={vi.fn()} />);
    await screen.findByLabelText("Calendar month view");
    const selectAndOpenDay = (dayNumber: string): void => {
      fireEvent.click(dayCell(container, dayNumber));
      fireEvent.click(screen.getByRole("radio", { name: "Day" }));
    };

    // The anchor day lists the series as an all-day chip (untimed series).
    selectAndOpenDay("3");
    const anchorGrid = await screen.findByLabelText("Calendar day view");
    await waitFor(() => {
      expect(anchorGrid.textContent).toContain("Standup");
    });

    // +7 (the 10th) is a pure virtual occurrence: no backlink exists on
    // that day, the expansion puts it there — one chip, no phantoms.
    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    await screen.findByLabelText("Calendar month view");
    selectAndOpenDay("10");
    const occurrenceGrid = await screen.findByLabelText("Calendar day view");
    await waitFor(() => {
      expect(occurrenceGrid.textContent).toContain("Standup");
    });
    expect(
      occurrenceGrid.querySelectorAll(".cal-timegrid__chip"),
    ).toHaveLength(1);

    // The 13th is NOT an occurrence: the grid is still there, the event is not.
    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    await screen.findByLabelText("Calendar month view");
    selectAndOpenDay("13");
    const emptyGrid = await screen.findByLabelText("Calendar day view");
    expect(emptyGrid.textContent).not.toContain("Standup");
  });

  it("a repeating task schedules on occurrence days and never goes overdue (the day page's Tasks section)", async () => {
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
      await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, { iso }, 0);
      if (repeat !== undefined) {
        await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.repeat, repeat, 0);
      }
      await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, pendingId, 0);
      return id;
    };
    // Anchored two weeks ago: today is an occurrence; a plain task two days
    // past anchors the overdue contrast.
    await makeTask("Water plants", addDaysIso(today, -14), WEEKLY_RRULE);
    await makeTask("Plain overdue", addDaysIso(today, -2));

    // The surviving task-on-a-day surface is the day PAGE (the calendar's
    // day zoom is the agenda now): its Tasks section carries the partition.
    const { day } = await client.ensureDateChain(today);
    render(<PageView client={client} pageId={day} onOpenPage={vi.fn()} />);
    const toggle = await screen.findByRole("button", { name: /^tasks( \d+)?$/i });
    fireEvent.click(toggle);
    const section = toggle.closest("section") as HTMLElement;
    // The repeating task is Scheduled (not Overdue) on its occurrence day…
    await waitFor(() => {
      expect(within(section).getByText("Water plants")).toBeDefined();
    });
    expect(within(section).getByText("Scheduled")).toBeDefined();
    // …while the plain task two days past is honestly overdue, and the
    // repeating task never appears in that group.
    const overdueGroup = within(section)
      .getByText("Overdue")
      .closest("div") as HTMLElement;
    await waitFor(() => {
      expect(within(overdueGroup).getByText("Plain overdue")).toBeDefined();
    });
    expect(within(overdueGroup).queryByText("Water plants")).toBeNull();
  });

  it("dots every occurrence day on the month grid, even without a backlink", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    // Anchor on the 3rd: the +7/+10 probe cells always exist in the month.
    const [y, m] = todayIsoLocal().split("-");
    const anchorIso = `${y}-${m}-03`;
    await createEvent(client, classId, schemaId, "Standup", anchorIso, WEEKLY_RRULE);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = renderCalendar(client);
    await screen.findByLabelText("Calendar month view");
    // The anchor blocks via its real backlink; +7 (the 10th) blocks purely
    // from the virtual expansion; the 13th is not an occurrence and stays
    // plain (the grid blocks are the retired dots' register).
    await waitFor(() => {
      expect(dayCell(container, "10").querySelector(".cal-block")).not.toBeNull();
    });
    expect(dayCell(container, "3").querySelector(".cal-block")).not.toBeNull();
    expect(dayCell(container, "13").querySelector(".cal-block")).toBeNull();
  });

  it("a repeat value authored as a {nodeId} carrier reads the rule from the carrier block's text", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    // Anchor on the 3rd: the +7/+10 probe cells always exist in the month.
    const [y, m] = todayIsoLocal().split("-");
    const anchorIso = `${y}-${m}-03`;
    const id = await createEvent(client, classId, schemaId, "Standup", anchorIso);
    // The repeat value is a carrier: a block whose text IS the canonical rule.
    const ruleBlock = await client.createObject({
      isEmbedded: true,
      contentAst: [{ type: "text", text: WEEKLY_RRULE }],
    });
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.repeat, { nodeId: ruleBlock }, 0);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = renderCalendar(client);
    await screen.findByLabelText("Calendar month view");
    // The series expands exactly like a plain-string rule: the anchor blocks
    // via its backlink, +7 purely from the virtual expansion, the 13th plain.
    await waitFor(() => {
      expect(dayCell(container, "10").querySelector(".cal-block")).not.toBeNull();
    });
    expect(dayCell(container, "3").querySelector(".cal-block")).not.toBeNull();
    expect(dayCell(container, "13").querySelector(".cal-block")).toBeNull();
  });

  it("re-picking the task's scheduled day moves the series anchor — repeat value and completions untouched", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    const pendingId = status.options!.find((option) => option.label === "Pending")!.id;
    const today = todayIsoLocal();
    const id = await client.createObject({
      isEmbedded: false,
      name: "Water plants",
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await client.setDatetimeProperty(
      id,
      SYSTEM_PROPERTY_UUIDS.taskScheduled,
      { iso: addDaysIso(today, -14) },
      0,
    );
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, pendingId, 0);
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.repeat, WEEKLY_RRULE, 0);
    // One occurrence recorded done (the write path under test is shared with
    // the completion suite).
    const doneDay = addDaysIso(today, -7);
    await setTaskDone(client, status, id, true, doneDay);

    // Re-pick the scheduled day: the driving date moves, the repeat rides.
    const newAnchor = addDaysIso(today, 2);
    await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, { iso: newAnchor }, 0);

    // The facts read the new anchor with the rule + completion intact.
    const facts = taskRowFacts(client, status, id);
    expect(facts.scheduledIso).toBe(newAnchor);
    expect(facts.repeat).not.toBeNull();
    expect(facts.completedOccurrences).toEqual([doneDay]);
    // The stored repeat value is verbatim, the completion on its metadata.
    const repeatRow = client
      .getEffectiveProperties(id)
      .find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.repeat);
    expect(repeatRow?.value).toBe(WEEKLY_RRULE);
    expect(repeatRow?.metadata?.completedOccurrences).toEqual([doneDay]);
    // The series expands from the NEW anchor (the old day no longer occurs).
    const series = recurringRowsOf(client).find((row) => row.node.id === id);
    expect(series?.series.anchorIso).toBe(newAnchor);
  });

  it("non-recurring events stay plain: anchor day only, no extra dots", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    // Anchor on the 2nd: the +7 probe cell always exists in the month.
    const [y, m] = todayIsoLocal().split("-");
    const anchorIso = `${y}-${m}-02`;
    await createEvent(client, classId, schemaId, "One-off", anchorIso);

    window.localStorage.setItem("notees.settings.calendarZoom", JSON.stringify("month"));
    const { container } = renderCalendar(client);
    await screen.findByLabelText("Calendar month view");
    // Only the anchor day blocks (its real backlink); +7 (the 9th) has
    // nothing.
    await waitFor(() => {
      expect(dayCell(container, "2").querySelector(".cal-block")).not.toBeNull();
    });
    expect(dayCell(container, "9").querySelector(".cal-block")).toBeNull();
  });

  it("a corrupt rule fails loud in the read scan, never reads as plain", async () => {
    const client = await seedClient();
    const { classId, schemaId } = await eventFamily(client);
    // Not a canonical RRULE string — the parser throws, the scan never
    // reads the node as plain.
    await createEvent(client, classId, schemaId, "Broken", todayIsoLocal(), "whenever");
    expect(() => recurringRowsOf(client)).toThrow(/invalid recurrence rule/);
  });
});
