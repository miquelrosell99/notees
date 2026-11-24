/**
 * task-closed-sync tests — the taskStatus ↔ taskClosedDate write-time
 * invariant at the WorkspaceClient facade seam. The family's `Closed`
 * datetime (…0003-…0005) is auto-maintained: entering a closed status
 * (Done/Cancelled) stamps it with the transition's local day + wall-clock
 * time; leaving the closed set (reopen, unset, empty) clears it. The status
 * write and the compensating Closed write are ONE undo entry. Guards: no
 * family schemas / unknown option ids are honest no-ops, and rewriting the
 * SAME closed option keeps the original stamp (a transition is what stamps,
 * never a rewrite).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  dayNodeId,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_STATUS_OPTION_UUIDS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.useRealTimers();
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

/** A family-authored client with one task node; time frozen at `at`. */
async function taskClient(at: string): Promise<{ client: WorkspaceClient; id: string }> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  const client = await seedClient();
  await ensureTaskFamily(client);
  const id = await client.createObject({
    isEmbedded: false,
    classIds: [SYSTEM_CLASS_UUIDS.task],
  });
  return { client, id };
}

function closedRow(client: WorkspaceClient, id: string) {
  return client
    .getPropertyRowShells(id)
    .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskClosedDate);
}

function statusValue(client: WorkspaceClient, id: string): unknown {
  return client
    .getPropertyRowShells(id)
    .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value;
}

describe("Closed-date auto-set", () => {
  it("stamps Closed with the local day + wall-clock time on Done", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);

    expect(statusValue(client, id)).toBe(TASK_STATUS_OPTION_UUIDS.done);
    expect(closedRow(client, id)?.value).toEqual({
      nodeId: dayNodeId("2026-11-24"),
      time: "15:42",
    });
  });

  it("stamps Closed on Cancelled too — one timestamp for both closed states", async () => {
    const { client, id } = await taskClient("2026-11-24T09:05:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.cancelled, 0);

    expect(closedRow(client, id)?.value).toEqual({
      nodeId: dayNodeId("2026-11-24"),
      time: "09:05",
    });
  });

  it("restamps Closed when the closed STATUS changes (Done → Cancelled)", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);
    vi.setSystemTime(new Date("2026-11-25T09:05:00"));
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.cancelled, 0);

    expect(closedRow(client, id)?.value).toEqual({
      nodeId: dayNodeId("2026-11-25"),
      time: "09:05",
    });
  });

  it("clears Closed on reopen (Done → Pending)", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);
    expect(closedRow(client, id)?.value).not.toBeNull();

    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.pending, 0);

    expect(closedRow(client, id)?.value ?? null).toBeNull();
  });

  it("a rewrite of the SAME closed option keeps the original stamp (no transition, no bump)", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);
    vi.setSystemTime(new Date("2026-11-24T16:10:00"));
    // Same option id re-committed (a panel rewrite, a sync echo) — the stamp
    // must stay the transition's, never "now".
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);

    expect(closedRow(client, id)?.value).toEqual({
      nodeId: dayNodeId("2026-11-24"),
      time: "15:42",
    });
  });

  it("unset of the status row clears Closed (the not-a-task arm)", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);

    await client.unsetProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, 0);

    // The authored status row is gone; the schema's Pending default
    // resurfaces at the shell (the unset contract) — the invariant's claim
    // is the Closed stamp clearing with it.
    expect(statusValue(client, id)).toBe(TASK_STATUS_OPTION_UUIDS.pending);
    expect(closedRow(client, id)?.value ?? null).toBeNull();
  });

  it("empty of the status property clears Closed", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);

    await client.emptyProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus);

    expect(closedRow(client, id)?.value ?? null).toBeNull();
  });

  it("undo of the close reverts BOTH writes as one entry; redo restores them", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);
    expect(closedRow(client, id)?.value).toEqual({
      nodeId: dayNodeId("2026-11-24"),
      time: "15:42",
    });

    expect(await client.undo()).toBe(true);
    // Both writes revert as ONE entry: the authored status row is gone (the
    // Pending default resurfaces at the shell) and the Closed stamp clears.
    expect(statusValue(client, id)).toBe(TASK_STATUS_OPTION_UUIDS.pending);
    expect(closedRow(client, id)?.value ?? null).toBeNull();

    expect(await client.redo()).toBe(true);
    expect(statusValue(client, id)).toBe(TASK_STATUS_OPTION_UUIDS.done);
    expect(closedRow(client, id)?.value).toEqual({
      nodeId: dayNodeId("2026-11-24"),
      time: "15:42",
    });
  });

  it("leaves other properties alone (a Deadline write authors no Closed row)", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setDatetimeProperty(id, SYSTEM_PROPERTY_UUIDS.taskDeadline, { iso: "2026-11-30" }, 0);

    expect(closedRow(client, id)?.value ?? null).toBeNull();
  });
});

describe("Closed-date guards", () => {
  it("no-ops when the family schemas are absent (nothing to write against)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T15:42:00"));
    const client = await seedClient();
    const id = await client.createObject({
      isEmbedded: false,
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });

    // Unknown schema id — the applier stores unchecked; the sync must not
    // throw and must not author a Closed row.
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, TASK_STATUS_OPTION_UUIDS.done, 0);

    expect(closedRow(client, id)?.value ?? null).toBeNull();
  });

  it("no-ops when the written value is not a stored status option", async () => {
    const { client, id } = await taskClient("2026-11-24T15:42:00");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, "not-a-real-option", 0);

    expect(closedRow(client, id)?.value ?? null).toBeNull();
  });
});
