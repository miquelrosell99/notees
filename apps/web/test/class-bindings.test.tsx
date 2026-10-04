/**
 * Class bindings editor tests: the class page's Class properties section
 * is editable — the search/create add popup writes class.property.set, the
 * expanded row's default editor patches the row (missing fields keep their
 * values), the collapsed-row flag toggles write required, and remove writes
 * class.property.unset. jsdom over the in-process WorkspaceClient.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ClassView } from "../src/ui/ClassView.js";

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

/** Expand the Class properties section (collapsed once non-empty). */
async function expandDefinitions(): Promise<void> {
  const header = screen.getByRole("button", { name: /class properties/i });
  if (header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
    await flushWrites();
  }
}

describe("Class View class properties editor", () => {
  it("adds a binding via the search popup over existing property schemas", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Task");
    await client.createPropertySchema({ name: "priority", type: "select" });
    render(<ClassView client={client} classId={classId} />);

    // Empty schema: the section starts expanded and invites setup.
    expect(screen.getByText("No property bindings.")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const dialog = screen.getByRole("dialog", { name: "Add property" });
    fireEvent.click(within(dialog).getByText("priority"));
    await flushWrites();

    const bindings = client.getClassBindings(classId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      name: "priority",
      sequence: 0,
      required: null,
      readonly: null,
      hideWhenEmpty: null,
      defaultValue: null,
    });
    // The popup no longer lists the bound schema.
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const again = screen.getByRole("dialog", { name: "Add property" });
    expect(within(again).queryByText("priority")).toBeNull();
  });

  it("creates a new schema from the popup and binds it", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Task");
    render(<ClassView client={client} classId={classId} />);

    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const dialog = screen.getByRole("dialog", { name: "Add property" });
    fireEvent.change(within(dialog).getByPlaceholderText("Search or create property…"), {
      target: { value: "impact" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: 'Create property "impact"' }));
    await flushWrites();

    const bindings = client.getClassBindings(classId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ name: "impact", type: "text", sequence: 0 });
    expect(client.listPropertySchemas().some((s) => s.name === "impact")).toBe(true);
  });

  it("edits the default in the expanded row and toggles required on the collapsed row", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Task");
    const schemaA = await client.createPropertySchema({ name: "priority", type: "select" });
    await client.setClassProperty(classId, schemaA, { sequence: 0, defaultValue: "medium" });
    render(<ClassView client={client} classId={classId} />);
    await expandDefinitions();

    // Patch only the default: required/sequence keep their existing values.
    fireEvent.click(screen.getByRole("button", { name: "Configure priority" }));
    const defaultInput = screen.getByLabelText("Default for priority");
    expect(defaultInput).toHaveProperty("value", "medium");
    fireEvent.blur(defaultInput, { target: { value: "high" } });
    await flushWrites();
    expect(client.getClassBindings(classId)[0]).toMatchObject({
      defaultValue: "high",
      sequence: 0,
      required: null,
    });

    fireEvent.click(screen.getByLabelText("Required for priority"));
    await flushWrites();
    expect(client.getClassBindings(classId)[0]!.required).toBe(true);
  });

  it("removes a binding via the row's remove button", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Task");
    const schemaId = await client.createPropertySchema({ name: "priority", type: "select" });
    await client.setClassProperty(classId, schemaId, { defaultValue: "medium" });
    render(<ClassView client={client} classId={classId} />);
    await expandDefinitions();

    expect(client.getClassBindings(classId)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove binding priority" }));
    await flushWrites();

    expect(client.getClassBindings(classId)).toEqual([]);
    expect(screen.getByText("No property bindings.")).not.toBeNull();
    // The schema is picker-eligible again.
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const dialog = screen.getByRole("dialog", { name: "Add property" });
    expect(within(dialog).getByText("priority")).not.toBeNull();
  });
});
