/**
 * S2 — the property's base-definition editor (PropertySettingsModal grown
 * per the proposal's S2; owner ruling 2026-10-20): every field writes
 * through client.updatePropertySchema with the keep/clear contract —
 * rename, icon, multi (+ the v1 danger confirm on multi→single with values
 * anywhere), options, targetClassFilter (now writable), scopeClassIds
 * (null = global), number formats, validationRules (number min/max,
 * text/url/email pattern — the regex must compile), the render contracts,
 * and the standalone Delete flow (v1's confirmation copy).
 *
 * The modal is rendered standalone here (no PageView parent subscription),
 * so each write is followed by an explicit rerender — in-app the page
 * tree re-renders through the client's change notification.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PropertySettingsModal } from "../src/features/metadata/PropertySettingsModal.js";

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

const schemaOf = (client: WorkspaceClient, id: string) =>
  client.listPropertySchemas().find((s) => s.id === id);

/** Render the modal standalone; `sync()` re-renders it (the in-app parent
 * subscription's role) after a store write. */
function renderModal(client: WorkspaceClient, schemaId: string, onClose = () => {}) {
  const view = render(
    <PropertySettingsModal client={client} propertySchemaId={schemaId} onClose={onClose} onOpenView={() => {}} />,
  );
  const sync = async () => {
    await flushWrites();
    view.rerender(
      <PropertySettingsModal client={client} propertySchemaId={schemaId} onClose={onClose} onOpenView={() => {}} />,
    );
  };
  return { ...view, sync };
}

describe("S2 PropertySettingsModal — the base-definition writes", () => {
  it("renames through update {name}", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Old", type: "text" });
    const { sync } = renderModal(client, schemaId);
    const input = screen.getByLabelText("Property name");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.blur(input);
    await sync();
    expect(schemaOf(client, schemaId)?.name).toBe("New");
  });

  it("readonly toggles write true and clear back to null (keep/clear)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Flag", type: "boolean" });
    const { sync } = renderModal(client, schemaId);
    fireEvent.click(screen.getByRole("switch", { name: /Read-only$/ }));
    await sync();
    expect(schemaOf(client, schemaId)?.readonly).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: /Read-only$/ }));
    await sync();
    expect(schemaOf(client, schemaId)?.readonly).toBeNull();
  });

  it("number formats: pad/decimals/rounding write and clear", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Price", type: "number" });
    const { sync } = renderModal(client, schemaId);
    const pad = screen.getByLabelText("Zero-pad digits");
    fireEvent.change(pad, { target: { value: "4" } });
    fireEvent.blur(pad);
    await sync();
    const decimals = screen.getByLabelText("Decimal digits");
    fireEvent.change(decimals, { target: { value: "2" } });
    fireEvent.blur(decimals);
    fireEvent.change(screen.getByLabelText("Rounding mode"), { target: { value: "floor" } });
    await sync();
    const schema = schemaOf(client, schemaId);
    expect(schema?.numberPad).toBe(4);
    expect(schema?.numberDecimals).toBe(2);
    expect(schema?.numberRounding).toBe("floor");
    // Clear: empty blur writes null.
    const pad2 = screen.getByLabelText("Zero-pad digits");
    fireEvent.change(pad2, { target: { value: "" } });
    fireEvent.blur(pad2);
    await sync();
    expect(schemaOf(client, schemaId)?.numberPad).toBeNull();
  });

  it("validationRules: number min/max write; values outside fail loud; clear writes null", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Score", type: "number" });
    const { sync } = renderModal(client, schemaId);
    const min = screen.getByLabelText("Minimum value");
    fireEvent.change(min, { target: { value: "0" } });
    fireEvent.blur(min);
    await sync();
    const max = screen.getByLabelText("Maximum value");
    fireEvent.change(max, { target: { value: "10" } });
    fireEvent.blur(max);
    await sync();
    expect(schemaOf(client, schemaId)?.validationRules).toEqual({ min: 0, max: 10 });
    // Clear both → null.
    const min2 = screen.getByLabelText("Minimum value");
    fireEvent.change(min2, { target: { value: "" } });
    fireEvent.blur(min2);
    await sync();
    const max2 = screen.getByLabelText("Maximum value");
    fireEvent.change(max2, { target: { value: "" } });
    fireEvent.blur(max2);
    await sync();
    expect(schemaOf(client, schemaId)?.validationRules).toBeNull();
  });

  it("validationRules: the pattern must compile before the write lands", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Site", type: "url" });
    const { sync } = renderModal(client, schemaId);
    const pattern = screen.getByLabelText("Validation pattern");
    fireEvent.change(pattern, { target: { value: "([broken" } });
    fireEvent.blur(pattern);
    await sync();
    // Not written; the inline error names the regex.
    expect(schemaOf(client, schemaId)?.validationRules?.pattern).toBeUndefined();
    expect(screen.getByRole("alert").textContent).toContain("valid regular expression");
    // A compiling pattern writes.
    fireEvent.change(pattern, { target: { value: "^https://" } });
    fireEvent.blur(pattern);
    await sync();
    expect(schemaOf(client, schemaId)?.validationRules?.pattern).toBe("^https://");
    // Clearing writes null.
    const cleared = screen.getByLabelText("Validation pattern");
    fireEvent.change(cleared, { target: { value: "" } });
    fireEvent.blur(cleared);
    await sync();
    expect(schemaOf(client, schemaId)?.validationRules).toBeNull();
  });

  it("scope: local reveals the picker and writes the class list; flipping back writes null (global)", async () => {
    const client = await seedClient();
    const fiction = await createTitledClass(client, "Fiction");
    const schemaId = await client.createPropertySchema({ name: "ISBN", type: "text" });
    const { sync } = renderModal(client, schemaId);
    // The toggle is optimistic: local reveals the picker BEFORE any write
    // (the empty scope list can't ride the wire).
    fireEvent.click(screen.getByRole("switch", { name: /Local to classes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Scope classes" }));
    const dialog = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(dialog).getByLabelText("Search classes"), {
      target: { value: "Fiction" },
    });
    fireEvent.click(within(dialog).getByText("Fiction"));
    await sync();
    expect(schemaOf(client, schemaId)?.scopeClassIds).toEqual([fiction]);
    fireEvent.click(screen.getByRole("switch", { name: /Global \(any node\)/ }));
    await sync();
    expect(schemaOf(client, schemaId)?.scopeClassIds).toBeNull();
  });

  it("targetClassFilter is writable: add a target class, remove it back to none", async () => {
    const client = await seedClient();
    const person = await createTitledClass(client, "Person");
    const schemaId = await client.createPropertySchema({ name: "Author", type: "object" });
    const { sync } = renderModal(client, schemaId);
    fireEvent.click(screen.getByRole("button", { name: "Target classes" }));
    const dialog = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(dialog).getByLabelText("Search classes"), {
      target: { value: "Person" },
    });
    fireEvent.click(within(dialog).getByText("Person"));
    await sync();
    expect(schemaOf(client, schemaId)?.targetClassFilter).toEqual([person]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Person" }));
    await sync();
    expect(schemaOf(client, schemaId)?.targetClassFilter).toEqual([]);
  });

  it("multi: multi→single with values anywhere shows the v1 danger confirm", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Tag", type: "text", multi: true });
    const page = await client.createObject({ isEmbedded: false, name: "Note" });
    await client.setProperty(page, schemaId, "one", 0);
    const { sync } = renderModal(client, schemaId);
    fireEvent.click(screen.getByRole("radio", { name: "Single value" }));
    // v1's danger confirm (values exist): the write waits for it. The copy
    // rides in the title AND the confirm button.
    await screen.findAllByText("Change to Single Value");
    expect(screen.getByText(/delete all extra values/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change to Single Value" }));
    await sync();
    expect(schemaOf(client, schemaId)?.multi).toBe(false);
  });

  it("multi→single on a value-free schema writes directly (no confirm)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Tag", type: "text", multi: true });
    const { sync } = renderModal(client, schemaId);
    fireEvent.click(screen.getByRole("radio", { name: "Single value" }));
    await sync();
    expect(schemaOf(client, schemaId)?.multi).toBe(false);
    expect(screen.queryByText(/delete all extra values/)).toBeNull();
  });

  it("options editor writes the wholesale options array (add + rename)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "State",
      type: "select",
      options: [{ id: "opt-1", label: "Open" }],
    });
    const { sync } = renderModal(client, schemaId);
    fireEvent.click(screen.getByRole("button", { name: /add option/i }));
    await sync();
    expect(schemaOf(client, schemaId)?.options).toHaveLength(2);
    // Rename the new option (the second row's input).
    const inputs = screen.getAllByLabelText(/^Option /);
    fireEvent.change(inputs[1]!, { target: { value: "Shut" } });
    fireEvent.blur(inputs[1]!);
    await sync();
    expect(schemaOf(client, schemaId)?.options?.map((o) => o.label)).toEqual(["Open", "Shut"]);
  });
});

describe("S2 Delete — the standalone flow (v1 copy)", () => {
  it("the footer Delete… confirms with v1's copy and soft-deletes the schema", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Score", type: "number" });
    const onClose = vi.fn();
    renderModal(client, schemaId, onClose);
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    // v1's confirmation copy rides verbatim.
    await screen.findByText("Delete Property");
    expect(
      screen.getByText(
        'Are you sure you want to delete the property "Score"? This will remove the property and all its values from all nodes.',
      ),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await flushWrites();
    expect(schemaOf(client, schemaId)).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });
});
