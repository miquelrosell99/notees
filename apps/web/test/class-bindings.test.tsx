/**
 * Class bindings list tests (owner ruling 2026-10-20): the class page is a
 * LIST — the row is identity-only (icon + name), the whole row click opens
 * the S2 base-definition modal (the default editor lives there now, at the
 * schema level; the class-level inline editor is gone with the global-default
 * move), the default is type-gated (text/number/boolean/select only —
 * boolean a true/false dropdown, select a dropdown of the schema's options,
 * node-typed schemas no editor at all), Remove from class is the row's
 * hover × behind a ConfirmationModal, the add popover offers eligible
 * schemas only and its "Create …" row opens the S1 creation modal pre-filled
 * (which binds on confirm via contextClassId). jsdom over the in-process
 * WorkspaceClient.
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

    fireEvent.click(screen.getByRole("button", { name: "Bind property" }));
    const dialog = screen.getByRole("dialog", { name: "Bind property" });
    fireEvent.click(within(dialog).getByText("priority"));
    await flushWrites();

    const bindings = client.getRegistryBindings(classId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ name: "priority" });
    // The popover no longer lists the bound schema.
    fireEvent.click(screen.getByRole("button", { name: "Bind property" }));
    const again = screen.getByRole("dialog", { name: "Bind property" });
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

    fireEvent.click(screen.getByRole("button", { name: "Bind property" }));
    const dialog = screen.getByRole("dialog", { name: "Bind property" });
    fireEvent.change(within(dialog).getByPlaceholderText("Search or create property…"), {
      target: { value: "impact" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: 'Create property "impact"' }));
    await flushWrites();

    // The popover closed and the S1 modal opened pre-filled (no instant
    // create-and-bind).
    expect(screen.queryByRole("dialog", { name: "Bind property" })).toBeNull();
    const createModal = screen.getByRole("dialog", { name: "Create property" });
    const nameInput = within(createModal).getByLabelText("Property name");
    expect(nameInput).toHaveProperty("value", "impact");

    fireEvent.click(within(createModal).getByRole("button", { name: "Create Property" }));
    await flushWrites();

    const bindings = client.getRegistryBindings(classId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ name: "impact", type: "text" });
  });

  it("edits the schema's global default through the row-opened definition modal (a dropdown of the select's options)", async () => {
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
    await client.setClassProperty(classId, schemaId, {});
    await client.updatePropertySchema(schemaId, { defaultValue: "opt-medium" });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    // The whole row opens the S2 base-definition modal; the default editor
    // lives there now (schema-level, the Logseq shape).
    fireEvent.click(screen.getByRole("button", { name: "Open property priority" }));
    const dialog = screen.getByRole("dialog");
    const defaultSelect = within(dialog).getByLabelText("Default value");
    expect(defaultSelect).toHaveProperty("value", "opt-medium");
    fireEvent.change(defaultSelect, { target: { value: "opt-high" } });
    await flushWrites();
    expect(client.listPropertySchemas().find((s) => s.id === schemaId)?.defaultValue).toBe("opt-high");
    // The binding is untouched (active-only — the default is schema config).
    expect(client.getRegistryBindings(classId)[0]).toMatchObject({ name: "priority", active: true });

    // Back to None clears the default (present-null — the keep/clear contract).
    fireEvent.change(within(dialog).getByLabelText("Default value"), { target: { value: "" } });
    await flushWrites();
    expect(client.listPropertySchemas().find((s) => s.id === schemaId)?.defaultValue).toBeNull();
  });

  it("boolean schemas get a true/false dropdown writing wire booleans", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "done", type: "boolean" });
    await client.setClassProperty(classId, schemaId, {});
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    fireEvent.click(screen.getByRole("button", { name: "Open property done" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Default value"), { target: { value: "true" } });
    await flushWrites();
    // The editor writes the wire BOOLEAN (a "true" string would fail PC2 and
    // leave the schema untouched); the decoded schema reads it back.
    expect(client.listPropertySchemas().find((s) => s.id === schemaId)?.defaultValue).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Default value"), { target: { value: "" } });
    await flushWrites();
    expect(client.listPropertySchemas().find((s) => s.id === schemaId)?.defaultValue).toBeNull();
  });

  it("number schemas write a numeric default", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "estimate", type: "number" });
    await client.setClassProperty(classId, schemaId, {});
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    fireEvent.click(screen.getByRole("button", { name: "Open property estimate" }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("Default value");
    expect(input).toHaveProperty("type", "number");
    fireEvent.blur(input, { target: { value: "42.5" } });
    await flushWrites();
    expect(client.listPropertySchemas().find((s) => s.id === schemaId)?.defaultValue).toBe(42.5);
  });

  it("node-typed schemas get NO default editor (owner ruling 2026-10-20)", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "link", type: "object" });
    await client.setClassProperty(classId, schemaId, {});
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    fireEvent.click(screen.getByRole("button", { name: "Open property link" }));
    // A default that links a node is meaningless (PC2): the definition modal
    // carries no default editor for object/asset/image/datetime schemas.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByLabelText("Default value")).toBeNull();
    expect(within(dialog).queryByText("Default value")).toBeNull();
  });

  it("renames through the definition modal (update {name})", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Task");
    const schemaId = await client.createPropertySchema({ name: "Priority", type: "select" });
    await client.setClassProperty(classId, schemaId, {});
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    // The whole row IS the definition-modal path (the cog is gone with the
    // inline editor — owner ruling 2026-10-20).
    fireEvent.click(screen.getByRole("button", { name: "Open property Priority" }));
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
    await client.setClassProperty(classId, schemaId, {});
    await client.updatePropertySchema(schemaId, { defaultValue: "medium" });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandDefinitions();

    expect(client.getRegistryBindings(classId)).toHaveLength(1);

    // The row's hover × (removal is a row action — no modal needed).
    fireEvent.click(screen.getByRole("button", { name: "Remove priority from class" }));
    // The danger action sits behind a ConfirmationModal.
    const confirm = screen.getByRole("dialog", { name: "Remove from class" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove from class" }));
    await flushWrites();

    expect(client.getRegistryBindings(classId)).toEqual([]);
    expect(screen.getByText("No property bindings.")).not.toBeNull();
    // The schema is picker-eligible again (the schema itself survives — its
    // default included).
    expect(client.listPropertySchemas().find((s) => s.id === schemaId)?.defaultValue).toBe("medium");
    fireEvent.click(screen.getByRole("button", { name: "Bind property" }));
    const dialog = screen.getByRole("dialog", { name: "Bind property" });
    expect(within(dialog).getByText("priority")).not.toBeNull();
  });

  it("lists inherited bindings attributed to the nearest source class", async () => {
    const client = await seedClient();
    const classA = await createTitledClass(client, "SourceA");
    const classB = await createTitledClass(client, "SourceB");
    const schemaX = await client.createPropertySchema({ name: "shared-x", type: "text" });
    const schemaY = await client.createPropertySchema({ name: "own-y", type: "text" });
    await client.setClassProperty(classA, schemaX, {});
    await client.setClassProperty(classB, schemaX, {});
    const classC = await createTitledClass(client, "ChildC");
    await client.setClassProperty(classC, schemaY, {});
    await client.setClassExtends(classC, [classB]);

    render(<NodeView client={client} nodeId={classC} onOpenNode={() => {}} />);
    await expandDefinitions();

    // Direct group: only own-y. The row is identity-only.
    expect(screen.getByRole("button", { name: "Open property own-y" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open property shared-x" })).toBeNull();
    // No chips on the row.
    const row = screen.getByRole("button", { name: "Open property own-y" });
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
