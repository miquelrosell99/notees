/**
 * ensureTaskFamily tests: a fresh workspace authors the six task
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
  TASK_PRIORITY_OPTION_UUIDS,
  TASK_STATUS_OPTIONS,
  TASK_STATUS_OPTION_UUIDS,
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
    // The …0003-… workflow block also carries the meeting family
    // (…007–…009) — those bind to the meeting class, not the task class.
    for (const id of [
      SYSTEM_PROPERTY_UUIDS.taskStatus,
      SYSTEM_PROPERTY_UUIDS.taskDeadline,
      SYSTEM_PROPERTY_UUIDS.taskScheduled,
      SYSTEM_PROPERTY_UUIDS.taskPriority,
      SYSTEM_PROPERTY_UUIDS.taskClosedDate,
      SYSTEM_PROPERTY_UUIDS.taskRecurrence,
    ] as const) {
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

  it("is safe on a workspace where the family already exists (migrated shape)", async () => {
    const client = await seedClient();
    // Pre-author with a different option id set (a migrated workspace carries
    // legacy option ids) — ensureTaskFamily must NOT overwrite the schema rows:
    // the stored option id is preserved, and the restyle pass only
    // adds the designed icon/color to the label-matching option.
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
    expect(status?.options).toEqual([
      { id: "v1-option-id", label: "Done", icon: "mdiCheckCircle", color: "green" },
    ]);
  });

  it("authors status/priority options at the deterministic designed ids with icons and colors", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);

    const schemas = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
    const statusByLabel = new Map(
      schemas.get(SYSTEM_PROPERTY_UUIDS.taskStatus)!.options!.map((option) => [option.label, option]),
    );
    const designedStatusIds: Record<string, string> = {
      Backlog: TASK_STATUS_OPTION_UUIDS.backlog,
      Pending: TASK_STATUS_OPTION_UUIDS.pending,
      Doing: TASK_STATUS_OPTION_UUIDS.doing,
      Reviewing: TASK_STATUS_OPTION_UUIDS.reviewing,
      Done: TASK_STATUS_OPTION_UUIDS.done,
      Cancelled: TASK_STATUS_OPTION_UUIDS.cancelled,
    };
    for (const designed of TASK_STATUS_OPTIONS) {
      const option = statusByLabel.get(designed.name)!;
      // Deterministic ids — the applier-side seed-ensure authors the same.
      expect(option.id).toBe(designedStatusIds[designed.name]);
      // The designed circle icon + preset color ride the option.
      expect(option.icon).toBe(designed.icon);
      expect(option.color).toBe(designed.color);
    }
    const priorityByLabel = new Map(
      schemas.get(SYSTEM_PROPERTY_UUIDS.taskPriority)!.options!.map((option) => [option.label, option]),
    );
    const designedPriorityIds: Record<string, string> = {
      Low: TASK_PRIORITY_OPTION_UUIDS.low,
      Medium: TASK_PRIORITY_OPTION_UUIDS.medium,
      High: TASK_PRIORITY_OPTION_UUIDS.high,
      Urgent: TASK_PRIORITY_OPTION_UUIDS.urgent,
    };
    for (const label of TASK_PRIORITY_OPTIONS) {
      expect(priorityByLabel.get(label)!.id).toBe(designedPriorityIds[label]);
    }
  });

  it("restyles stored status options missing the designed styles, preserving stored ids", async () => {
    const client = await seedClient();
    // Simulate the earlier web-authored shape: random option ids, no
    // icon/color — authored values reference those ids, so they must survive.
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.taskStatus,
      name: "Status",
      type: "select",
      options: TASK_STATUS_OPTIONS.map((option) => ({ id: `old-${option.name}`, label: option.name })),
    });
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.task, SYSTEM_PROPERTY_UUIDS.taskStatus, {});

    await ensureTaskFamily(client);

    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    const byLabel = new Map(status.options!.map((option) => [option.label, option]));
    for (const designed of TASK_STATUS_OPTIONS) {
      const option = byLabel.get(designed.name)!;
      expect(option.id).toBe(`old-${designed.name}`);
      expect(option.icon).toBe(designed.icon);
      expect(option.color).toBe(designed.color);
    }
    // The value display converges on the schema (property-level) —
    // the status rides the block bullet.
    expect(status.display).toBe("bullet");
  });

  it("moves the status value display to the schema when still panel-level", async () => {
    const client = await seedClient();
    // Fully converged styles, but the display never moved off the panel
    // default — ONE upgrade write sets it (options untouched → display-only
    // patch).
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.taskStatus,
      name: "Status",
      type: "select",
      options: TASK_STATUS_OPTIONS.map((option) => ({
        id: `old-${option.name}`,
        label: option.name,
        icon: option.icon,
        color: option.color,
      })),
    });
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.task, SYSTEM_PROPERTY_UUIDS.taskStatus, {});
    // vi.spyOn wraps and CALLS THROUGH — the write lands, the fields are captured.
    const spy = vi.spyOn(client, "updatePropertySchema");

    await ensureTaskFamily(client);

    expect(spy.mock.calls.map(([, fields]) => fields)).toEqual([{ display: "bullet" }]);
    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    expect(status.display).toBe("bullet");
    spy.mockRestore();
  });

  it("leaves user-renamed and user-added status options untouched", async () => {
    const client = await seedClient();
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.taskStatus,
      name: "Status",
      type: "select",
      options: [
        { id: "kept-done-id", label: "Done" },
        { id: "custom-id", label: "Blocked" },
      ],
    });
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.task, SYSTEM_PROPERTY_UUIDS.taskStatus, {});

    await ensureTaskFamily(client);

    const status = client
      .listPropertySchemas()
      .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
    // The designed label restyles; the user's own option passes through.
    expect(status.options).toEqual([
      { id: "kept-done-id", label: "Done", icon: "mdiCheckCircle", color: "green" },
      { id: "custom-id", label: "Blocked" },
    ]);
  });

  it("a converged family issues no updatePropertySchema write on re-run", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const spy = vi.spyOn(client, "updatePropertySchema");
    await ensureTaskFamily(client);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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
