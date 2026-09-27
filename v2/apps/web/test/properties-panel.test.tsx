/**
 * Properties panel tests (SCHEMA.md "Class properties"): Page/Block views
 * render the effective-properties panel — derived defaults dimmed with a
 * "default" hint, editing a default writes an authored property.set that
 * shadows it, multi-class conflicts show the first-applied winner, and
 * clearing the authored value lets the default resurface.
 * jsdom over the in-process WorkspaceClient.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** Seed priority-bound Task + Project classes (Task applied first by callers). */
async function seedPriorityClasses(client: WorkspaceClient) {
  const schemaId = await client.createPropertySchema({ name: "priority", type: "select" });
  const taskId = await client.createClass("Task");
  const projectId = await client.createClass("Project");
  await client.setClassProperty(taskId, schemaId, { sequence: 0, defaultValue: "medium" });
  await client.setClassProperty(projectId, schemaId, { sequence: 0, defaultValue: "high" });
  return { schemaId, taskId, projectId };
}

describe("Properties panel (effective values)", () => {
  it("shows a derived default dimmed with a 'default' hint", async () => {
    const client = await seedClient();
    const { schemaId, taskId } = await seedPriorityClasses(client);
    const pageId = await client.createObject({ nodeType: "page", name: "Ship it" });
    await client.assignClass(pageId, taskId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const row = container.querySelector(".nt-property")!;
    expect(row.className).toContain("nt-property-default");
    expect(row.textContent).toContain("priority");
    expect(row.textContent).toContain("default");
    const input = screen.getByLabelText("Property priority") as HTMLInputElement;
    expect(input.value).toBe("medium");
    // The read model agrees: derived, bound by Task, no authored row.
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "medium", source: "default", boundBy: taskId }),
    ]);
  });

  it("renders nothing when the node has no effective properties", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Plain" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(container.querySelector(".nt-properties-panel")).toBeNull();
  });

  it("editing a default writes an authored value that shadows it", async () => {
    const client = await seedClient();
    const { schemaId, taskId } = await seedPriorityClasses(client);
    const pageId = await client.createObject({ nodeType: "page", name: "Ship it" });
    await client.assignClass(pageId, taskId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    fireEvent.blur(screen.getByLabelText("Property priority"), { target: { value: "urgent" } });
    await flushWrites();

    const effective = client.getEffectiveProperties(pageId);
    expect(effective).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "urgent", source: "authored", boundBy: taskId }),
    ]);
    const row = container.querySelector(".nt-property")!;
    expect(row.className).not.toContain("nt-property-default");
    expect(row.textContent).not.toContain("default");

    // Clearing the authored value lets the derived default resurface.
    await act(async () => {
      await client.unsetProperty(pageId, schemaId);
    });
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ value: "medium", source: "default", boundBy: taskId }),
    ]);
  });

  it("multi-class conflict shows the first-applied class's value", async () => {
    const client = await seedClient();
    const { taskId, projectId } = await seedPriorityClasses(client);
    const pageId = await client.createObject({ nodeType: "page", name: "Ship it" });
    // Task is assigned first: its 'medium' beats Project's 'high'.
    await client.assignClass(pageId, taskId);
    await client.assignClass(pageId, projectId);
    render(<PageView client={client} pageId={pageId} />);

    const input = screen.getByLabelText("Property priority") as HTMLInputElement;
    expect(input.value).toBe("medium");
    expect(input.closest(".nt-property")!.textContent).toContain("default");

    // On a page where Project was applied first, Project's default wins.
    const otherId = await client.createObject({ nodeType: "page", name: "Other" });
    await client.assignClass(otherId, projectId);
    await client.assignClass(otherId, taskId);
    expect(client.getEffectiveProperties(otherId)).toEqual([
      expect.objectContaining({ value: "high", source: "default", boundBy: projectId }),
    ]);
  });
});
