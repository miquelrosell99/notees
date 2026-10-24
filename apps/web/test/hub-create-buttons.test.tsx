/**
 * Hub header creation buttons — the shared collection hub's header carries
 * a creation affordance per mode:
 *
 *  - Pages hub: **New page** writes one main page (the command palette's
 *    New-page write) and opens it;
 *  - Whiteboards hub: **New whiteboard** writes a whiteboard-classed page
 *    (the sidebar New flow's write with the whiteboard system class picked)
 *    and opens it — the created node lists in the hub's members;
 *  - Inbox (a filtered view of the unclassed) offers no creation button.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { HubView } from "../src/ui/app/HubView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

/**
 * The Tasks hub's New flow (owner 2026-10-24 — the calendar's Tasks
 * section retired with the day view; the hub owns task creation now):
 * no bound templates -> a direct unscheduled task-classed create + open;
 * bound templates -> the picker opens and the pick instantiates through
 * the clone engine.
 */
describe("the Tasks hub's New task flow", () => {
  it("creates an unscheduled task directly when the class has no templates", async () => {
    const client = await seedClient();
    const { ensureTaskFamily } = await import("../src/features/classview/taskFamily.js");
    await ensureTaskFamily(client);
    const opened: string[] = [];
    render(<HubView client={client} nav="tasks" onOpenNode={(id) => opened.push(id)} />);

    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    await flushSync();

    expect(opened).toHaveLength(1);
    const created = client.getNode(opened[0]!)!;
    expect(created.classIds).toContain(SYSTEM_CLASS_UUIDS.task);
    // Unscheduled: no AUTHORED taskScheduled value (the bound-but-empty
    // virtual row synthesizes by design — value null is the honest read).
    const scheduled = client
      .getEffectiveProperties(created.id)
      .find(
        (row) =>
          row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskScheduled &&
          row.source === "authored" &&
          row.value != null,
      );
    expect(scheduled).toBeUndefined();
  });

  it("offers the template picker when the task class has bound templates; the pick instantiates", async () => {
    const client = await seedClient();
    const { ensureTaskFamily } = await import("../src/features/classview/taskFamily.js");
    const { ensureTemplateProperty } = await import("../src/features/templates/templateFamily.js");
    await ensureTaskFamily(client);
    await ensureTemplateProperty(client);
    const templateId = await client.createObject({
      isEmbedded: false,
      name: "Recurring checklist",
      classIds: [SYSTEM_CLASS_UUIDS.template],
    });
    await client.createObject({
      parentId: templateId,
      contentAst: [{ type: "text", text: "Step one" }],
    });
    await client.setProperty(
      SYSTEM_CLASS_UUIDS.task,
      SYSTEM_PROPERTY_UUIDS.hasTemplate,
      { nodeId: templateId },
      0,
    );

    const opened: string[] = [];
    render(<HubView client={client} nav="tasks" onOpenNode={(id) => opened.push(id)} />);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      (await screen.findAllByRole("button", { name: /Recurring checklist/i }))[0]!,
    );

    await flushSync();
    expect(opened).toHaveLength(1);
    const created = client.getNode(opened[0]!)!;
    expect(created.classIds).toContain(SYSTEM_CLASS_UUIDS.task);
    // Instantiated: the template's child cloned beneath the new task.
    const children = client.getChildren(created.id);
    expect(children.map((child) => child.contentAst)).toEqual([
      [{ type: "text", text: "Step one" }],
    ]);
  });
});

describe("hub header creation buttons", () => {
  it("the Pages hub's New page writes a main page and opens it", async () => {
    const client = await seedClient();
    const opened: string[] = [];
    render(<HubView client={client} nav="pages" onOpenNode={(id) => opened.push(id)} />);
    fireEvent.click(await screen.findByRole("button", { name: /new page/i }));
    await waitFor(() => expect(opened).toHaveLength(1));
    const page = client.getNode(opened[0]!);
    expect(page).not.toBeUndefined();
    expect(page!.isClass).toBe(false);
    expect(page!.isEmbedded).toBe(false);
    expect(page!.parentId).toBeNull();
    await flushSync();
  });

  it("the Whiteboards hub's New whiteboard writes a whiteboard-classed page and opens it", async () => {
    const client = await seedClient();
    const opened: string[] = [];
    render(
      <HubView client={client} nav="whiteboards" onOpenNode={(id) => opened.push(id)} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /new whiteboard/i }));
    await waitFor(() => expect(opened).toHaveLength(1));
    const page = client.getNode(opened[0]!);
    expect(page).not.toBeUndefined();
    expect(page!.isEmbedded).toBe(false);
    expect(page!.classIds).toContain(SYSTEM_CLASS_UUIDS.whiteboard);
    // The new whiteboard is a hub member.
    expect(
      client
        .roots()
        .filter((p) => p.classIds.includes(SYSTEM_CLASS_UUIDS.whiteboard))
        .map((p) => p.id),
    ).toContain(opened[0]);
    await flushSync();
  });

  it("the Inbox hub offers no creation button", async () => {
    const client = await seedClient();
    render(<HubView client={client} nav="inbox" onOpenNode={() => {}} />);
    await screen.findByText("Nothing here yet.");
    expect(screen.queryByRole("button", { name: /new /i })).toBeNull();
  });
});
