/**
 * ensureTaskFamily tests (§34.28 #2): a fresh workspace authors the six task
 * property schemas at their reserved ids plus the task-class bindings on
 * first call, with canonical status/priority options; the call is a complete
 * no-op once present (no extra schemas, no extra bindings, safe to re-run).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_PRIORITY_OPTIONS,
  TASK_STATUS_OPTIONS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ensureTaskFamily, taskFamilyPresent } from "../src/ui/components/taskFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000c1";
const ACTOR = "0192a000-0000-7000-8000-0000000000c2";
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

describe("ensureTaskFamily", () => {
  it("authors the six schemas at the reserved ids with canonical shapes", async () => {
    const client = await seedClient();
    expect(taskFamilyPresent(client)).toBe(false);

    await ensureTaskFamily(client);

    const schemas = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
    const status = schemas.get(SYSTEM_PROPERTY_UUIDS.taskStatus);
    expect(status?.name).toBe("Status");
    expect(status?.type).toBe("select");
    expect(status?.options?.map((option) => option.label)).toEqual(
      TASK_STATUS_OPTIONS.map((option) => option.name),
    );
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.taskScheduled)?.type).toBe("date");
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.taskDeadline)?.type).toBe("date");
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.taskClosedDate)?.type).toBe("date");
    expect(
      schemas.get(SYSTEM_PROPERTY_UUIDS.taskPriority)?.options?.map((option) => option.label),
    ).toEqual([...TASK_PRIORITY_OPTIONS]);
    expect(schemas.get(SYSTEM_PROPERTY_UUIDS.taskRecurrence)?.type).toBe("select");

    const bound = client
      .getClassBindings(SYSTEM_CLASS_UUIDS.task)
      .map((binding) => binding.propertySchemaId);
    for (const id of Object.values(SYSTEM_PROPERTY_UUIDS).filter((id) =>
      id.startsWith("00000000-0000-0000-0003-"),
    )) {
      expect(bound).toContain(id);
    }
    expect(taskFamilyPresent(client)).toBe(true);
  });

  it("is idempotent: a second call authors nothing", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const schemasAfterFirst = client.listPropertySchemas().length;
    const bindingsAfterFirst = client.getClassBindings(SYSTEM_CLASS_UUIDS.task).length;

    await ensureTaskFamily(client);
    await ensureTaskFamily(client);

    expect(client.listPropertySchemas()).toHaveLength(schemasAfterFirst);
    expect(client.getClassBindings(SYSTEM_CLASS_UUIDS.task)).toHaveLength(bindingsAfterFirst);
  });

  it("self-heals the task class node at the reserved id when the workspace was never seeded", async () => {
    // Unseeded (offline-first) relay: no system classes at all.
    const client = await seedClient(new MemoryRelay());
    await ensureTaskFamily(client);

    const taskClass = client.getNode(SYSTEM_CLASS_UUIDS.task);
    expect(taskClass?.isClass).toBe(true);
    expect(taskFamilyPresent(client)).toBe(true);

    // Stable no-op from here: a second open authors nothing.
    const schemas = client.listPropertySchemas().length;
    await ensureTaskFamily(client);
    expect(client.listPropertySchemas()).toHaveLength(schemas);
  });

  it("is safe on a workspace where the family already exists (v1-migrated shape)", async () => {
    const client = await seedClient();
    // Pre-author with a different option id set (a migrated workspace carries
    // v1 option ids) — ensureTaskFamily must NOT overwrite the schema.
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.taskStatus,
      name: "Status",
      type: "select",
      options: [{ id: "v1-option-id", label: "Done" }],
    });
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.task, SYSTEM_PROPERTY_UUIDS.taskStatus, {});

    await ensureTaskFamily(client);

    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus);
    expect(status?.options).toEqual([{ id: "v1-option-id", label: "Done" }]);
  });

  it("a task scheduled via the authored family answers the open-task query", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    const doneId = status.options!.find((option) => option.label === "Done")!.id;

    const open = await client.createObject({
      presentAsMain: true,
      name: "Write the register entry",
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await client.setDateProperty(open, SYSTEM_PROPERTY_UUIDS.taskScheduled, "2026-10-02");
    await client.setProperty(open, SYSTEM_PROPERTY_UUIDS.taskStatus, status.options![0]!.id, 0);

    const closed = await client.createObject({
      presentAsMain: true,
      name: "Ship it",
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    await client.setDateProperty(closed, SYSTEM_PROPERTY_UUIDS.taskScheduled, "2026-10-02");
    await client.setProperty(closed, SYSTEM_PROPERTY_UUIDS.taskStatus, doneId, 0);

    const { buildOpenTasksAst, closedStatusOptionIds } = await import(
      "../src/ui/components/calendarViewUtils.js"
    );
    const result = client.runQueryAst(buildOpenTasksAst(closedStatusOptionIds(status)));
    expect(result.ids).toContain(open);
    expect(result.ids).not.toContain(closed);
  });
});
