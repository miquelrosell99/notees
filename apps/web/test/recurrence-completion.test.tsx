/**
 * Per-occurrence completion for recurring tasks: the done-toggle on a
 * recurring task's occurrence (the calendar day view's checkbox before the
 * 2026-10-23 outline-collections pass retired it — the write path is
 * shared, still driven by the day page's Tasks section and the tasks hub)
 * records the DATE in the taskScheduled value's metadata
 * (`completedOccurrences`) instead of the node-level status — the occurrence
 * renders done on that day while every other occurrence stays open, and
 * reopening removes the date. Occurrences stay virtual (no nodes). A plain
 * task's toggle keeps the hub's exact status write. Harness: in-process
 * WorkspaceClient + MemoryRelay; the write path is exercised directly
 * (`setTaskDone`, the same call the checkbox surfaces make).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { addDaysIso, todayIsoLocal } from "../src/features/calendar/calendarViewUtils.js";
import { partitionOpenTasks } from "../src/features/calendar/calendarViewUtils.js";
import { setTaskDone, taskRowsOf } from "../src/features/calendar/calendarRows.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const relay = new MemoryRelay();
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  await ensureTaskFamily(client);
  return client;
}

/** A weekly task anchored two weeks ago (today is an occurrence). */
async function makeRecurringTask(client: WorkspaceClient, name: string): Promise<string> {
  const id = await client.createObject({
    isEmbedded: false,
    name,
    classIds: [SYSTEM_CLASS_UUIDS.task],
  });
  await client.setDatetimeProperty(
    id,
    SYSTEM_PROPERTY_UUIDS.taskScheduled,
    { iso: addDaysIso(todayIsoLocal(), -14) },
    0,
    { repeat: "weekly" },
  );
  return id;
}

function scheduledValueOf(client: WorkspaceClient, id: string) {
  return client
    .getEffectiveProperties(id)
    .find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled);
}

describe("per-occurrence completion", () => {
  it("partitionOpenTasks flags a done occurrence on its day, keeps other occurrences open", () => {
    const today = todayIsoLocal();
    const rows = [
      {
        id: "task-1",
        scheduledIso: addDaysIso(today, -14),
        closed: false,
        repeat: { freq: "weekly" as const, interval: 1 },
        completedOccurrences: [today],
        occurrenceDone: false,
      },
    ];
    // Today: the occurrence lists, flagged done.
    const onToday = partitionOpenTasks(rows, today);
    expect(onToday.scheduled).toHaveLength(1);
    expect(onToday.scheduled[0]!.occurrenceDone).toBe(true);
    // Tomorrow is not an occurrence at all.
    expect(partitionOpenTasks(rows, addDaysIso(today, 1)).scheduled).toHaveLength(0);
    // +7: the next occurrence is NOT done (only the recorded date was).
    const nextWeek = partitionOpenTasks(rows, addDaysIso(today, 7));
    expect(nextWeek.scheduled).toHaveLength(1);
    expect(nextWeek.scheduled[0]!.occurrenceDone).toBe(false);
  });

  it("the done-toggle on a recurring occurrence writes the date into metadata — not the status", async () => {
    const client = await seedClient();
    const id = await makeRecurringTask(client, "Water plants");
    const today = todayIsoLocal();
    const statusSchema = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);

    await setTaskDone(client, statusSchema, id, true, today);

    await waitFor(() => {
      expect(scheduledValueOf(client, id)?.metadata?.completedOccurrences).toEqual([today]);
    });
    // The repeat rule rides through; the node-level status stays untouched
    // (no status value authored at all).
    expect(scheduledValueOf(client, id)?.metadata?.repeat).toBe("weekly");
    // No AUTHORED status (the bound-empty virtual row may show — the
    // virtual/realized ruling; the assertion is about the value).
    expect(
      client
        .getEffectiveProperties(id)
        .some((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus && prop.source === "authored"),
    ).toBe(false);

    // The partition reads the recorded date as done on its day, and
    // reopening removes the date.
    expect(partitionOpenTasks(taskRowsOfId(client, id), today).scheduled[0]?.occurrenceDone).toBe(true);
    await setTaskDone(client, statusSchema, id, false, today);
    await waitFor(() => {
      expect(scheduledValueOf(client, id)?.metadata?.completedOccurrences).toBeUndefined();
    });
  });

  it("a plain task's toggle still writes the node-level status", async () => {
    const client = await seedClient();
    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    const pendingId = status.options!.find((option) => option.label === "Pending")!.id;
    const doneId = status.options!.find((option) => option.label === "Done")!.id;
    const id = await client.createObject({
      isEmbedded: false,
      name: "Plain task",
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskScheduled, { iso: todayIsoLocal() }, 0);
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, pendingId, 0);

    await setTaskDone(client, status, id, true, todayIsoLocal());

    await waitFor(() => {
      expect(
        client
          .getEffectiveProperties(id)
          .find((prop) => prop.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value,
      ).toBe(doneId);
    });
    expect(scheduledValueOf(client, id)?.metadata?.completedOccurrences).toBeUndefined();
  });

  it("a recurring task completes one occurrence at a time across days", async () => {
    const client = await seedClient();
    const id = await makeRecurringTask(client, "Weekly review");
    const today = todayIsoLocal();
    const nextWeek = addDaysIso(today, 7);
    const statusSchema = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);

    // Complete today's occurrence.
    await setTaskDone(client, statusSchema, id, true, today);
    await waitFor(() => {
      expect(scheduledValueOf(client, id)?.metadata?.completedOccurrences).toEqual([today]);
    });

    // A week out: the next occurrence is still open — one row per series,
    // its own toggle, no second entry.
    const nextRows = partitionOpenTasks(taskRowsOfId(client, id), nextWeek);
    expect(nextRows.scheduled).toHaveLength(1);
    expect(nextRows.scheduled[0]?.occurrenceDone).toBe(false);
    expect(nextWeek).not.toBe(today);
  });
});

/** The client's open-task rows for one node (the partition's input shape). */
function taskRowsOfId(client: WorkspaceClient, id: string) {
  return taskRowsOf(
    client,
    client.listPropertySchemas().find((s) => s.id === SYSTEM_PROPERTY_UUIDS.taskStatus),
    [id],
  );
}
