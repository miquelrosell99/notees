/**
 * EventCreateModal tests (the dblclick-to-create dialog): the field
 * register (Name, Start day prefilled, Start/End times, End day), the
 * fail-loud inline HH:MM validation, the end-before-start guard, the
 * unified date-union writes (bare point, timed point, cross-day range,
 * same-day timed range), the event class + name landing, and the
 * create-opens / cancel-closes contract.
 */

import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { EventCreateModal } from "../src/features/calendar/EventCreateModal.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";

/** The deterministic day-node id for a local ISO day. */
function dayNodeOf(iso: string): string {
  return `00000000-0000-0000-00dd-${iso.replace(/-/g, "")}0000`;
}

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
    deviceId: "test-device",
    client: "seed",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

/** A workspace with the system event class (its `eventDate` binding is
    self-seeded at bootstrap — the modal's driving schema, the drag-create
    register). */
async function seedClient(): Promise<{ client: WorkspaceClient; schemaId: string }> {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.event, contentAst: [{ type: "text", text: "event" }] },
      [SYSTEM_CLASS_UUIDS.event],
    ),
  ]);
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  // Materialize the event family (the eventDate schema + binding rows) —
  // without the ensure the seed manifest's binding is registry-only and the
  // schema-typed read-model joins see a null schema.
  const { ensureMeetingFamily } = await import("../src/features/classview/meetingFamily.js");
  await ensureMeetingFamily(client);
  // The driving schema is the system event class's FIRST binding — the
  // seeded eventDate (SYSTEM_PROPERTY_UUIDS.eventDate).
  const schemaId = SYSTEM_PROPERTY_UUIDS.eventDate;
  return { client, schemaId };
}

const START = "2026-10-10";

function renderModal(
  client: WorkspaceClient,
  handlers: { onClose?: Mock; onCreated?: Mock } = {},
) {
  const onClose: Mock = handlers.onClose ?? vi.fn();
  const onCreated: Mock = handlers.onCreated ?? vi.fn();
  const view = render(
    <EventCreateModal
      isOpen
      onClose={onClose}
      client={client}
      startIso={START}
      onCreated={onCreated}
    />,
  );
  return { onClose, onCreated, unmount: view.unmount };
}

/** Fill the name and submit; returns the created node's id. */

function authoredValue(client: WorkspaceClient, id: string, schemaId: string): unknown {
  return client
    .getEffectiveProperties(id)
    .find((prop) => prop.propertySchemaId === schemaId && prop.source === "authored")?.value;
}

describe("EventCreateModal", () => {
  it("prefills the dblclicked day and renders the field register", async () => {
    const { client } = await seedClient();
    renderModal(client);
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    expect((within(dialog).getByLabelText("Start day") as HTMLInputElement).value).toBe(START);
    for (const label of ["Name", "Start time", "End day", "End time"]) {
      expect(within(dialog).getByLabelText(label)).toBeDefined();
    }
  });

  it("creates a bare point when only the name is given; the event class + name land; create opens and closes", async () => {
    const { client, schemaId } = await seedClient();
    const onClose = vi.fn();
    const onCreated = vi.fn();
    renderModal(client, { onClose, onCreated });
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Dentist" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const id = onCreated.mock.calls[0]![0] as string;
    const node = client.getNode(id)!;
    expect(node.classIds).toEqual([SYSTEM_CLASS_UUIDS.event]);
    expect(node.contentAst).toEqual([{ type: "text", text: "Dentist" }]);
    expect(authoredValue(client, id, schemaId)).toEqual({ nodeId: dayNodeOf(START) });
    // The chain for the start day was ensured (the slot target resolves).
    expect(client.getNodeRaw(dayNodeOf(START))).toBeDefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("creates a timed point when only a start time is given", async () => {
    const { client, schemaId } = await seedClient();
    const onCreated = vi.fn();
    renderModal(client, { onCreated });
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Call" } });
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "09:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(authoredValue(client, onCreated.mock.calls[0]![0] as string, schemaId)).toEqual({
      nodeId: dayNodeOf(START),
      time: "09:30",
    });
  });

  it("creates a range across days when the end day differs", async () => {
    const { client, schemaId } = await seedClient();
    const onCreated = vi.fn();
    renderModal(client, { onCreated });
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Offsite" } });
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "14:30" } });
    fireEvent.change(within(dialog).getByLabelText("End day"), { target: { value: "2026-10-12" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(authoredValue(client, onCreated.mock.calls[0]![0] as string, schemaId)).toEqual({
      start: { nodeId: dayNodeOf(START), time: "14:30" },
      end: { nodeId: dayNodeOf("2026-10-12") },
    });
    expect(client.getNodeRaw(dayNodeOf("2026-10-12"))).toBeDefined();
  });

  it("creates a same-day range when both times are given without an end day", async () => {
    const { client, schemaId } = await seedClient();
    const onCreated = vi.fn();
    renderModal(client, { onCreated });
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Deep work" } });
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "14:30" } });
    fireEvent.change(within(dialog).getByLabelText("End time"), { target: { value: "16:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(authoredValue(client, onCreated.mock.calls[0]![0] as string, schemaId)).toEqual({
      start: { nodeId: dayNodeOf(START), time: "14:30" },
      end: { nodeId: dayNodeOf(START), time: "16:00" },
    });
  });

  it("fails loud inline on a malformed time — nothing is written", async () => {
    const { client } = await seedClient();
    const before = client.listPages().length;
    const onCreated = vi.fn();
    renderModal(client, { onCreated });
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Broken" } });
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "25:99" } });
    // The inline error rides the field (role alert), live while typing.
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Time must be HH:MM (24h).");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreated).not.toHaveBeenCalled();
    expect(client.listPages().length).toBe(before);
  });

  it("fails loud inline when the end day precedes the start day", async () => {
    const { client } = await seedClient();
    const onCreated = vi.fn();
    renderModal(client, { onCreated });
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Inverted" } });
    fireEvent.change(within(dialog).getByLabelText("End day"), { target: { value: "2026-10-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The end day cannot precede the start day.",
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("the Create button is disabled on a blank name; Cancel closes without writing", async () => {
    const { client } = await seedClient();
    const before = client.listPages().length;
    const onClose = vi.fn();
    const onCreated = vi.fn();
    renderModal(client, { onClose, onCreated });
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    expect(within(dialog).getByRole("button", { name: "Create" })).toHaveProperty("disabled", true);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(client.listPages().length).toBe(before);
  });

  it("the created event blocks its day in the calendar read model (point and range)", async () => {
    const { client } = await seedClient();
    const { eventRowsForDays, spannedRowsOf } = await import(
      "../src/features/calendar/calendarRows.js"
    );

    // Point: blocks its day via the events read model.
    const first = renderModal(client);
    const dialog1 = await screen.findByRole("dialog", { name: "New event" });
    fireEvent.change(within(dialog1).getByLabelText("Name"), {
      target: { value: "Read the register" },
    });
    fireEvent.click(within(dialog1).getByRole("button", { name: "Create" }));
    await vi.waitFor(() => expect(first.onCreated).toHaveBeenCalledTimes(1));
    const pointId = first.onCreated.mock.calls[0]![0] as string;
    expect(eventRowsForDays(client, [START], []).map((row) => row.node.id)).toContain(pointId);
    first.unmount();

    // A cross-day range blocks every covered day through spannedRowsOf.
    const second = renderModal(client);
    const dialog2 = await screen.findByRole("dialog", { name: "New event" });
    fireEvent.change(within(dialog2).getByLabelText("Name"), { target: { value: "Span" } });
    fireEvent.change(within(dialog2).getByLabelText("End day"), {
      target: { value: "2026-10-12" },
    });
    fireEvent.click(within(dialog2).getByRole("button", { name: "Create" }));
    await vi.waitFor(() => expect(second.onCreated).toHaveBeenCalledTimes(1));
    const spanId = second.onCreated.mock.calls[0]![0] as string;
    const spans = spannedRowsOf(client);
    expect(spans).toContainEqual({
      node: expect.objectContaining({ id: spanId }),
      startIso: START,
      endIso: "2026-10-12",
    });
    expect(eventRowsForDays(client, ["2026-10-11"], [], spans).map((r) => r.node.id)).toContain(
      spanId,
    );
  });
});
