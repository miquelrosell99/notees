/**
 * cycleTaskState tests (the Cmd/Ctrl+Enter task-state toggle): the
 * three-state cycle — not a task -> task + Pending -> task + Done ->
 * not a task (any closed status clears). Writes ride the canonical client
 * paths: the stored option id at the status row's existing idx (never the
 * designed UUIDs), the task class preferred live-over-seed, and the family
 * self-healed on first status write.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { cycleTaskState } from "../src/ui/components/taskCycle.js";
import { ensureTaskFamily } from "../src/ui/components/taskFamily.js";

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

function statusOptionId(client: WorkspaceClient, label: string): string {
  const schema = client
    .listPropertySchemas()
    .find((s) => s.id === SYSTEM_PROPERTY_UUIDS.taskStatus);
  const option = schema?.options?.find((o) => o.label === label);
  if (option === undefined) throw new Error(`no "${label}" option`);
  return option.id;
}

function statusValue(client: WorkspaceClient, id: string): unknown {
  return client
    .getEffectiveProperties(id)
    .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value;
}

describe("cycleTaskState", () => {
  it("not-a-task -> assigns the task class and sets Pending (first non-Backlog option)", async () => {
    const client = await seedClient();
    const id = await client.createObject({ contentAst: [{ type: "text", text: "Buy milk" }] });

    await cycleTaskState(client, id);

    expect(client.getNode(id)?.classIds).toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, id)).toBe(statusOptionId(client, "Pending"));
    // The family was self-healed on first status write.
    const status = client
      .listPropertySchemas()
      .find((s) => s.id === SYSTEM_PROPERTY_UUIDS.taskStatus);
    expect(status?.options?.map((o) => o.label)).toEqual([
      "Backlog",
      "Pending",
      "Doing",
      "Reviewing",
      "Done",
      "Cancelled",
    ]);
  });

  it("task with an open status -> sets Done by the stored option id (never a hardcoded designed UUID)", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    // Simulate an old (migrated) workspace: the status options carry
    // random stored ids, NOT the designed TASK_STATUS_OPTION_UUIDS.
    const statusSchema = client
      .listPropertySchemas()
      .find((s) => s.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    const relabeled = statusSchema.options!.map((option, i) => ({
      ...option,
      id: `random-id-${i}-${option.label}`,
    }));
    await client.updatePropertySchema(statusSchema.id, { options: relabeled });
    const storedId = (label: string): string =>
      relabeled.find((option) => option.label === label)!.id;

    const id = await client.createObject({
      contentAst: [{ type: "text", text: "Buy milk" }],
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, storedId("Doing"), 0);

    await cycleTaskState(client, id);

    expect(client.getNode(id)?.classIds).toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, id)).toBe(storedId("Done"));
  });

  it("task with Done -> clears: unsets the status and drops the class", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const id = await client.createObject({
      contentAst: [{ type: "text", text: "Buy milk" }],
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, statusOptionId(client, "Done"), 0);

    await cycleTaskState(client, id);

    expect(client.getNode(id)?.classIds).not.toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, id)).toBeUndefined();
  });

  it("task with Cancelled (the other closed status) -> clears too", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const id = await client.createObject({
      contentAst: [{ type: "text", text: "Buy milk" }],
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, statusOptionId(client, "Cancelled"), 0);

    await cycleTaskState(client, id);

    expect(client.getNode(id)?.classIds).not.toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, id)).toBeUndefined();
  });

  it("writes the resolved option id at the status row's idx (the single-value schema's 0)", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const id = await client.createObject({
      contentAst: [{ type: "text", text: "Buy milk" }],
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    const doingId = statusOptionId(client, "Doing");
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.taskStatus, doingId, 0);
    const setProperty = vi.spyOn(client, "setProperty");

    await cycleTaskState(client, id);

    // The write address is the row's existing idx (0 — the Status schema is
    // single-value; the store rejects idx > 0), never a hardcoded designed
    // option id: the stored label-resolved id goes in.
    expect(setProperty).toHaveBeenCalledWith(
      id,
      SYSTEM_PROPERTY_UUIDS.taskStatus,
      statusOptionId(client, "Done"),
      0,
    );
  });

  it("prefers a live class named 'task' over the designed seed id (the /checkbox precedent)", async () => {
    // The reachable case: the workspace's system task class was RENAMED (its
    // content no longer reads "task") and a user-authored class carries the
    // name — the cycle assigns THAT class. (When both read "task", the
    // designed class sorts first by id and wins the find — also named
    // "task", so the outcome is equivalent.)
    const relay = new MemoryRelay();
    relay.ingest([
      seedEnvelope(
        "class.create",
        { classId: SYSTEM_CLASS_UUIDS.task, contentAst: [{ type: "text", text: "todo" }], icon: "mdiCheckboxMarkedCircleOutline" },
        [SYSTEM_CLASS_UUIDS.task],
      ),
    ]);
    const client = await seedClient(relay);
    const liveTask = await client.createClass("task");
    const id = await client.createObject({ contentAst: [{ type: "text", text: "Buy milk" }] });

    await cycleTaskState(client, id);

    expect(client.getNode(id)?.classIds).toContain(liveTask);
    expect(client.getNode(id)?.classIds).not.toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, id)).toBe(statusOptionId(client, "Pending"));
  });

  it("full round-trip: none -> Pending -> Done -> cleared", async () => {
    const client = await seedClient();
    const id = await client.createObject({ contentAst: [{ type: "text", text: "Buy milk" }] });

    await cycleTaskState(client, id);
    expect(statusValue(client, id)).toBe(statusOptionId(client, "Pending"));

    await cycleTaskState(client, id);
    expect(statusValue(client, id)).toBe(statusOptionId(client, "Done"));

    await cycleTaskState(client, id);
    expect(client.getNode(id)?.classIds).not.toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, id)).toBeUndefined();
  });

  it("no-ops on an unknown node id", async () => {
    const client = await seedClient();
    const assignClass = vi.spyOn(client, "assignClass");
    await cycleTaskState(client, "0192a000-0000-7000-8000-00000000dead");
    expect(assignClass).not.toHaveBeenCalled();
  });
});
