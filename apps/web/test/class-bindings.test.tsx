/**
 * Class bindings editor tests: the Class View's property-bindings section is
 * editable — the add-binding picker over existing property schemas writes
 * class.property.set, per-binding default/required/sequence editors patch
 * the row (missing fields keep their values), and remove writes
 * class.property.unset. jsdom over the in-process WorkspaceClient.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

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

describe("Class View property bindings editor", () => {
  it("adds a binding via the picker over existing property schemas", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Task");
    await client.createPropertySchema({ name: "priority", type: "select" });
    render(<ClassView client={client} classId={classId} />);

    expect(screen.getByText("No property bindings.")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Add property binding"), {
      target: { value: client.listPropertySchemas()[0]!.id },
    });
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
    // The picker no longer lists the bound schema.
    expect(screen.queryByRole("option", { name: "priority" })).toBeNull();
  });

  it("edits the default, toggles required, and reorders by sequence", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Task");
    const schemaA = await client.createPropertySchema({ name: "priority", type: "select" });
    const schemaB = await client.createPropertySchema({ name: "effort", type: "text" });
    await client.setClassProperty(classId, schemaA, { sequence: 0, defaultValue: "medium" });
    await client.setClassProperty(classId, schemaB, { sequence: 1 });
    render(<ClassView client={client} classId={classId} />);

    // Patch only the default: required/sequence keep their existing values.
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

    // Swap the sequence numbers: effort (was 1) renders before priority.
    fireEvent.blur(screen.getByLabelText("Sequence for effort"), { target: { value: "0" } });
    await flushWrites();
    const names = client.getClassBindings(classId).map((b) => b.name);
    expect(names).toEqual(["effort", "priority"]);
  });

  it("removes a binding via the row's remove button", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Task");
    const schemaId = await client.createPropertySchema({ name: "priority", type: "select" });
    await client.setClassProperty(classId, schemaId, { defaultValue: "medium" });
    render(<ClassView client={client} classId={classId} />);

    expect(client.getClassBindings(classId)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove binding priority" }));
    await flushWrites();

    expect(client.getClassBindings(classId)).toEqual([]);
    expect(screen.getByText("No property bindings.")).not.toBeNull();
    // The schema is picker-eligible again.
    expect(screen.getByRole("option", { name: "priority" })).not.toBeNull();
  });
});
