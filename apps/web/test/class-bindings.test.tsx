/**
 * Class bindings editor tests (the S6 redesign): the collapsed row is identity-only (grip + icon +
 * name, click expands the config, the COG opens the definition modal), the
 * config panel writes ONLY binding fields (default/required — presence in
 * the list is the on/off, no active switch, no group labels), the default
 * editor is type-gated (text/number/boolean/select
 * only — boolean a true/false dropdown, select a dropdown of the schema's
 * options, node-typed schemas no editor at all), Remove from
 * class sits in the panel footer behind a ConfirmationModal, the add popover
 * offers eligible schemas only and its "Create …" row opens the S1 creation
 * modal pre-filled (which binds on confirm via contextClassId). jsdom over
 * the in-process WorkspaceClient.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PropertyCreateHost } from "../src/features/metadata/PropertyCreateHost.js";
import { NodeView } from "../src/ui/App.js";

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

async function createTitledClass(client: WorkspaceClient, name: string): Promise<string> {
  const id = await client.createClass(name);
  await client.updateObject(id, { contentAst: [{ type: "text", text: name }] });
  return id;
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
  it("adds a binding via the search popover over existing property schemas", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    await client.createPropertySchema({ name: "priority", type: "select" });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // Empty schema: the section starts expanded and invites setup.
    expect(screen.getByText("No property bindings.")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const dialog = screen.getByRole("dialog", { name: "Add property" });
    fireEvent.click(within(dialog).getByText("priority"));
    await flushWrites();

    const bindings = client.getRegistryBindings(classId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      name: "priority",
      sequence: 0,
      required: null,
      defaultValue: null,
    });
    // The popover no longer lists the bound schema.
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const again = screen.getByRole("dialog", { name: "Add property" });
    expect(within(again).queryByText("priority")).toBeNull();
  });

  it("routes the create row through the S1 creation modal (pre-filled, binds on confirm)", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    render(
      <>
        <NodeView client={client} nodeId={classId} onOpenNode={() => {}} />
        <PropertyCreateHost client={client} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const dialog = screen.getByRole("dialog", { name: "Add property" });
    fireEvent.change(within(dialog).getByPlaceholderText("Search or create property…"), {
      target: { value: "impact" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: 'Create property "impact"' }));
    await flushWrites();

    // The popover closed and the S1 modal opened pre-filled (no instant
    // create-and-bind).
    expect(screen.queryByRole("dialog", { name: "Add property" })).toBeNull();
    const createModal = screen.getByRole("dialog", { name: "Create property" });
    const nameInput = within(createModal).getByLabelText("Property name");
    expect(nameInput).toHaveProperty("value", "impact");

    fireEvent.click(within(createModal).getByRole("button", { name: "Create Property" }));
    await flushWrites();

    const bindings = client.getRegistryBindings(classId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ name: "impact", type: "text", sequence: 0 });
  });

  it("edits the select default (a dropdown of the schema's options) and Required", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({
      name: "priority",
      type: "select",
      options: [
        { id: "opt-low", label: "Low" },
        { id: "opt-medium", label: "Medium" },
        { id: "opt-high", label: "High" },
      ],
    });
    await client.setClassProperty(classId, schemaId, { sequence: 0, defaultValue: "opt-medium" });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    fireEvent.click(screen.getByRole("button", { name: "Configure priority" }));
    const defaultSelect = screen.getByLabelText("Default for priority");
    expect(defaultSelect).toHaveProperty("value", "opt-medium");
    fireEvent.change(defaultSelect, { target: { value: "opt-high" } });
    await flushWrites();
    expect(client.getRegistryBindings(classId)[0]).toMatchObject({
      defaultValue: "opt-high",
      sequence: 0,
      required: null,
    });

    // Back to None clears the default (explicit JSON null — the one default
    // shape PC2 accepts for every type); the remount lands on "None".
    fireEvent.change(screen.getByLabelText("Default for priority"), { target: { value: "" } });
    await flushWrites();
    expect(client.getRegistryBindings(classId)[0]!.defaultValue).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Required" }));
    await flushWrites();
    expect(client.getRegistryBindings(classId)[0]!.required).toBe(true);
  });

  it("boolean bindings get a true/false dropdown writing wire booleans", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "done", type: "boolean" });
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    fireEvent.click(screen.getByRole("button", { name: "Configure done" }));
    fireEvent.change(screen.getByLabelText("Default for done"), { target: { value: "true" } });
    await flushWrites();
    // The editor writes the wire BOOLEAN (a "true" string would fail PC2 and
    // leave the binding untouched); the decoded binding reads it back.
    expect(client.getRegistryBindings(classId)[0]!.defaultValue).toBe("true");

    fireEvent.change(screen.getByLabelText("Default for done"), { target: { value: "" } });
    await flushWrites();
    expect(client.getRegistryBindings(classId)[0]!.defaultValue).toBeNull();
  });

  it("number bindings write a numeric default", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "estimate", type: "number" });
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    fireEvent.click(screen.getByRole("button", { name: "Configure estimate" }));
    const input = screen.getByLabelText("Default for estimate");
    expect(input).toHaveProperty("type", "number");
    fireEvent.blur(input, { target: { value: "42.5" } });
    await flushWrites();
    expect(client.getRegistryBindings(classId)[0]!.defaultValue).toBe("42.5");
  });

  it("node-typed bindings get NO default editor", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "link", type: "object" });
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    fireEvent.click(screen.getByRole("button", { name: "Configure link" }));
    // A default that links a node is meaningless (PC2): no default editor —
    // Required is the only inline field.
    expect(screen.queryByLabelText("Default for link")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Required" })).not.toBeNull();
  });

  it("renames through the definition modal (update {name})", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "Priority", type: "select" });
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    fireEvent.click(screen.getByRole("button", { name: "Configure Priority" }));
    // R7 (2026-10-20): rename left the inline panel — the row's COG opens
    // the S2 modal directly, whose Name field owns the rename.
    fireEvent.click(screen.getByRole("button", { name: "Definition settings for Priority" }));
    const nameInput = screen.getByLabelText("Property name");
    fireEvent.blur(nameInput, { target: { value: "Importance" } });
    await flushWrites();

    expect(client.listPropertySchemas().find((s) => s.id === schemaId)?.name).toBe("Importance");
    // The binding follows the schema row (the row is the naming authority).
    expect(client.getRegistryBindings(classId)[0]!.name).toBe("Importance");
  });

  it("removes a binding via the row's hover × behind the confirm", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "priority", type: "select" });
    await client.setClassProperty(classId, schemaId, { defaultValue: "medium" });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    expect(client.getRegistryBindings(classId)).toHaveLength(1);

    // The row's hover × (no expansion needed — removal is a row action).
    fireEvent.click(screen.getByRole("button", { name: "Remove priority from class" }));
    // The danger action sits behind a ConfirmationModal.
    const confirm = screen.getByRole("dialog", { name: "Remove from class" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove from class" }));
    await flushWrites();

    expect(client.getRegistryBindings(classId)).toEqual([]);
    expect(screen.getByText("No property bindings.")).not.toBeNull();
    // The schema is picker-eligible again.
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const dialog = screen.getByRole("dialog", { name: "Add property" });
    expect(within(dialog).getByText("priority")).not.toBeNull();
  });

  it("lists inherited bindings attributed to the nearest source class", async () => {
    const client = await seedClient();
    const classA = await createTitledClass(client, "SourceA");
    const classB = await createTitledClass(client, "SourceB");
    const schemaX = await client.createPropertySchema({ name: "shared-x", type: "text" });
    const schemaY = await client.createPropertySchema({ name: "own-y", type: "text" });
    await client.setClassProperty(classA, schemaX, { sequence: 0 });
    await client.setClassProperty(classB, schemaX, { sequence: 0 });
    const classC = await createTitledClass(client, "ChildC");
    await client.setClassProperty(classC, schemaY, { sequence: 0 });
    await client.setClassExtends(classC, [classB]);

    render(<NodeView client={client} nodeId={classC} onOpenNode={() => {}} />);
    await expandDefinitions();

    // Direct group: only own-y. The collapsed row is identity-only.
    expect(screen.getByRole("button", { name: "Configure own-y" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Configure shared-x" })).toBeNull();
    // No chips on the collapsed row.
    const row = screen.getByRole("button", { name: "Configure own-y" });
    expect(within(row).queryByText(/default:|disabled/)).toBeNull();

    // Inherited group: shared-x attributed to SourceB (the NEAREST binder).
    const inherited = screen.getByRole("button", { name: /inherited/i });
    fireEvent.click(inherited);
    await flushWrites();
    const inheritedRow = screen.getByRole("button", { name: "Open property shared-x" });
    expect(within(inheritedRow).getByText("SourceB")).not.toBeNull();

    // Clicking the inherited row opens the base-definition editor (the
    // settings modal's dialog carries no title attribute — the heading
    // names it).
    fireEvent.click(inheritedRow);
    await flushWrites();
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", { name: "Property settings" }),
    ).not.toBeNull();
  });
});
