/**
 * Create-with-template flow tests: the Calendar day view's Tasks New
 * affordance offers the TemplatePickerModal only when the class has bound
 * templates; picking one instantiates through the clone engine (fresh
 * object, grafted root, cloned children, template-authored values beating
 * binding defaults per SCHEMA.md D2); the Blank row and template-less
 * classes create directly, exactly as before.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { CalendarView } from "../src/features/calendar/CalendarView.js";
import { dayNodeId, todayIsoLocal } from "../src/features/calendar/calendarViewUtils.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";
import { ensureTemplateProperty } from "../src/features/templates/templateFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000b1";
const ACTOR = "0192a000-0000-7000-8000-0000000000b2";

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
  window.localStorage.clear();
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

function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope(
      "class.create",
      {
        classId: SYSTEM_CLASS_UUIDS.template,
        contentAst: [{ type: "text", text: "template" }],
        icon: "mdiFileDocumentOutline",
      },
      [SYSTEM_CLASS_UUIDS.template],
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

/**
 * The task family with a Priority binding whose SCHEMA-level default "low"
 * a template overrides with "high" (D2), and the "Sync template" bound via
 * has-template with one child block.
 */
async function setupTaskWithTemplate(client: WorkspaceClient) {
  await ensureTaskFamily(client);
  const prioId = await client.createPropertySchema({ name: "Priority", type: "select" });
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.task, prioId, {});
  await client.updatePropertySchema(prioId, { defaultValue: "low" });

  const templateId = await client.createObject({
    isEmbedded: false,
    name: "Sync template",
    classIds: [SYSTEM_CLASS_UUIDS.template],
  });
  await client.createObject({
    parentId: templateId,
    contentAst: [{ type: "text", text: "Recurring checklist" }],
  });
  await client.setProperty(templateId, prioId, "high", 0);

  await ensureTemplateProperty(client);
  await client.setProperty(
    SYSTEM_CLASS_UUIDS.task,
    SYSTEM_PROPERTY_UUIDS.hasTemplate,
    { nodeId: templateId },
    0,
  );
  return { prioId, templateId };
}

describe("CalendarView create-with-template", () => {
  it("offers the picker for a class with templates; picking instantiates via the clone engine", async () => {
    const client = await seedClient();
    const { prioId, templateId } = await setupTaskWithTemplate(client);
    const onOpenPage = vi.fn();
    render(<CalendarView client={client} onOpenPage={onOpenPage} />);

    const tasks = await screen.findByRole("region", { name: "Tasks" });
    fireEvent.click(within(tasks).getByRole("button", { name: "New" }));

    // The picker names the picked class and lists blank + the bound template.
    // (Scoped within the dialog: a template created today also rows in the
    // calendar's Created section with the same name.)
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("New Task");
    const options = within(dialog);
    expect(options.getByRole("button", { name: "Blank Task" })).toBeDefined();
    expect(options.getByRole("button", { name: "Sync template" })).toBeDefined();

    fireEvent.click(options.getByRole("button", { name: "Sync template" }));

    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(1));
    const newId = onOpenPage.mock.calls[0]![0] as string;
    const created = client.getNode(newId);
    expect(created).toBeDefined();
    expect(created!.classIds).toEqual([SYSTEM_CLASS_UUIDS.task]);
    expect(created!.classIds).not.toContain(SYSTEM_CLASS_UUIDS.template);
    // Grafted root content (the template's title IS its content).
    expect(created!.contentAst).toEqual([{ type: "text", text: "Sync template" }]);
    // Children cloned beneath in order; the template itself is untouched.
    const children = client.getChildren(newId);
    expect(children.map((child) => child.contentAst)).toEqual([
      [{ type: "text", text: "Recurring checklist" }],
    ]);
    expect(client.getChildren(templateId)).toHaveLength(1);
    // The calendar flow's date write landed on the selected day.
    const when = client
      .getEffectiveProperties(newId)
      .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled);
    expect(when?.value).toEqual({ nodeId: dayNodeId(todayIsoLocal()) });
    // D2: the template-authored Priority beats the binding default.
    const prio = client
      .getEffectiveProperties(newId)
      .find((entry) => entry.propertySchemaId === prioId);
    expect(prio?.value).toBe("high");
    expect(prio?.source).toBe("authored");
  });

  it("creates directly (no picker) when the class has no templates", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const onOpenPage = vi.fn();
    render(<CalendarView client={client} onOpenPage={onOpenPage} />);

    const tasks = await screen.findByRole("region", { name: "Tasks" });
    fireEvent.click(within(tasks).getByRole("button", { name: "New" }));

    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    const created = client.getNode(onOpenPage.mock.calls[0]![0] as string);
    expect(created!.classIds).toEqual([SYSTEM_CLASS_UUIDS.task]);
    expect(client.getChildren(created!.id)).toEqual([]);
  });

  it("the Blank row creates a fresh object without instantiation", async () => {
    const client = await seedClient();
    const { prioId } = await setupTaskWithTemplate(client);
    const onOpenPage = vi.fn();
    render(<CalendarView client={client} onOpenPage={onOpenPage} />);

    const tasks = await screen.findByRole("region", { name: "Tasks" });
    fireEvent.click(within(tasks).getByRole("button", { name: "New" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Blank Task" }));

    await waitFor(() => expect(onOpenPage).toHaveBeenCalledTimes(1));
    const created = client.getNode(onOpenPage.mock.calls[0]![0] as string);
    expect(client.getChildren(created!.id)).toEqual([]);
    expect(created!.contentAst).toEqual([]);
    // No template values: the binding default surfaces as derived (D2).
    const prio = client
      .getEffectiveProperties(created!.id)
      .find((entry) => entry.propertySchemaId === prioId);
    expect(prio?.value).toBe("low");
    expect(prio?.source).toBe("default");
  });
});
