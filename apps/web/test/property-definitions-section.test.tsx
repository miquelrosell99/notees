/**
 * S6 section-level tests (PropertyDefinitionsSection, rendered directly):
 * the add popover's class-context eligibility (R1/R2 — global + schemas
 * scoped to this class or its extends-ancestors), the list-only surface
 * (the class-level inline editor is gone — the
 * identity-only row click opens the S2 modal, where the schema-level default
 * (type-gated, no editor for node-typed schemas) + target-class editing and
 * the unresolved-targets hint live; no chevron, no inline fields, no
 * Required — the hover-revealed row affordances are the COG, definition
 * settings, and the REMOVE ×), the system-schema
 * remove lock, and the keyboard-navigable popover. jsdom
 * over the in-process WorkspaceClient.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PropertyDefinitionsSection } from "../src/features/classview/PropertyDefinitionsSection.js";

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

async function flushWrites(): Promise<void> {
  await act(async () => {});
}

async function createTitledClass(client: WorkspaceClient, name: string): Promise<string> {
  const id = await client.createClass(name);
  await client.updateObject(id, { contentAst: [{ type: "text", text: name }] });
  return id;
}

function renderSection(client: WorkspaceClient, classId: string) {
  const view = render(<PropertyDefinitionsSection client={client} classId={classId} />);
  const sync = async () => {
    await flushWrites();
    view.rerender(<PropertyDefinitionsSection client={client} classId={classId} />);
  };
  return { ...view, sync };
}

/** The section starts collapsed once it has bindings — expand it. */
async function expandSection() {
  const header = screen.getByRole("button", { name: /class properties/i });
  if (header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
    await flushWrites();
  }
}

async function openPopover() {
  await expandSection();
  fireEvent.click(screen.getByRole("button", { name: "Bind property" }));
  return screen.getByRole("dialog", { name: "Bind property" });
}

describe("S6 PropertyDefinitionsSection", () => {
  it("offers global schemas + schemas scoped to this class or its ancestors", async () => {
    const client = await seedClient();
    const classA = await createTitledClass(client, "A");
    const classB = await createTitledClass(client, "B");
    const classC = await createTitledClass(client, "C");
    await client.setClassExtends(classC, [classB]);
    await client.createPropertySchema({ name: "global-prop", type: "text" });
    await client.createPropertySchema({ name: "scoped-a", type: "text", scopeClassIds: [classA] });
    await client.createPropertySchema({ name: "scoped-b", type: "text", scopeClassIds: [classB] });
    renderSection(client, classC);

    const dialog = await openPopover();
    expect(within(dialog).getByText("global-prop")).not.toBeNull();
    // scoped-b rides through the extends edge (R2).
    expect(within(dialog).getByText("scoped-b")).not.toBeNull();
    // scoped-a is local to an unrelated class — not offered.
    expect(within(dialog).queryByText("scoped-a")).toBeNull();
  });

  it("excludes schemas bound directly on this class from the popover", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "A");
    const schemaId = await client.createPropertySchema({ name: "bound-here", type: "text" });
    await client.setClassProperty(classId, schemaId, {});
    const schemaInherited = await client.createPropertySchema({ name: "bound-elsewhere", type: "text" });
    const other = await createTitledClass(client, "B");
    await client.setClassProperty(other, schemaInherited, {});
    renderSection(client, classId);

    const dialog = await openPopover();
    expect(within(dialog).queryByText("bound-here")).toBeNull();
    // A schema bound only on an ancestor-class level stays offerable (a
    // direct binding would be an override).
    expect(within(dialog).getByText("bound-elsewhere")).not.toBeNull();
  });

  it("keyboard navigation cycles the listbox and activates on Enter", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "A");
    await client.createPropertySchema({ name: "alpha", type: "text" });
    renderSection(client, classId);

    const dialog = await openPopover();
    expect(within(dialog).getByRole("option", { name: /alpha/ })).not.toBeNull();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    await flushWrites();
    expect(client.getRegistryBindings(classId).map((b) => b.name)).toEqual(["alpha"]);
  });

  it("Escape closes the popover", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "A");
    renderSection(client, classId);
    const dialog = await openPopover();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Bind property" })).toBeNull();
  });

  it("edits target classes through the definition modal (update {targetClassFilter})", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "A");
    const target = await createTitledClass(client, "Target");
    const schemaId = await client.createPropertySchema({ name: "link", type: "object" });
    await client.setClassProperty(classId, schemaId, {});
    renderSection(client, classId);
    await expandSection();

    // The whole row opens the S2 modal directly (the inline panel is gone —
    //); its Target classes field writes
    // update {targetClassFilter}.
    fireEvent.click(screen.getByRole("button", { name: "Open property link" }));
    const dialog = screen.getByRole("dialog");
    // The ClassMultiPickField's SelectTrigger adds the class.
    fireEvent.click(within(dialog).getByRole("button", { name: "Target classes" }));
    await flushWrites();
    fireEvent.click(screen.getByText("Target"));
    await flushWrites();

    expect(client.listPropertySchemas().find((s) => s.id === schemaId)?.targetClassFilter).toEqual([
      target,
    ]);
  });

  it("surfaces unresolved target classes in the definition modal", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "A");
    // A filter entry naming a class this workspace never deployed (a
    // dangling id — the stored rows are id-keyed) — the hint moved here
    // from the inline panel (R7).
    const GHOST = "0192a000-0000-7000-8000-000000000099";
    const schemaId = await client.createPropertySchema({
      name: "link",
      type: "object",
      targetClassFilter: [GHOST],
    });
    await client.setClassProperty(classId, schemaId, {});
    renderSection(client, classId);
    await expandSection();

    fireEvent.click(screen.getByRole("button", { name: "Open property link" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(`Unresolved targets (kept until edited): ${GHOST}`),
    ).not.toBeNull();
  });

  it("the row is the whole surface: click opens the definition modal; no inline editor", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "A");
    const schemaId = await client.createPropertySchema({ name: "link", type: "object" });
    await client.setClassProperty(classId, schemaId, {});
    renderSection(client, classId);
    await expandSection();

    const row = screen.getByRole("button", { name: "Open property link" });
    // Identity-only main button: no chevron/expansion, no inline fields.
    expect(within(row).queryByLabelText("Default for link")).toBeNull();
    expect(within(row).queryByLabelText("Default value")).toBeNull();
    expect(within(row).queryByRole("checkbox", { name: "Required" })).toBeNull();
    // The row's hover affordances: the COG (definition settings) + the ×.
    const item = row.closest(".nt-propdef") as HTMLElement;
    expect(within(item).getByRole("button", { name: "Definition settings for link" })).not.toBeNull();
    expect(within(item).getByRole("button", { name: "Remove link from class" })).not.toBeNull();

    // The click opens the S2 definition modal (object-typed → no default
    // editor there either).
    fireEvent.click(row);
    await flushWrites();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Property settings" })).not.toBeNull();
    expect(within(dialog).queryByLabelText("Default value")).toBeNull();
  });

  it("the hover-revealed cog opens the same definition modal as the row click", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "A");
    const schemaId = await client.createPropertySchema({ name: "link", type: "object" });
    await client.setClassProperty(classId, schemaId, {});
    renderSection(client, classId);
    await expandSection();

    const item = screen
      .getByRole("button", { name: "Open property link" })
      .closest(".nt-propdef") as HTMLElement;
    fireEvent.click(within(item).getByRole("button", { name: "Definition settings for link" }));
    await flushWrites();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Property settings" })).not.toBeNull();
  });

  it("hides Remove from class for system property schemas", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "A");
    // `alias` is a global system schema (…0028) — author the schema row at
    // the reserved id (as the workspace seed would), bind it manually
    // (scope-legal: global), and the row must carry no remove affordance
    // (non-removable = hidden, not disabled — no caption).
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.alias,
      name: "Aliases",
      type: "text",
      multi: true,
    });
    await client.setClassProperty(classId, SYSTEM_PROPERTY_UUIDS.alias, {});
    renderSection(client, classId);
    await expandSection();

    // Neither a panel footer action nor the row's hover × exists; the
    // definition-settings cog rides even system rows (only REMOVE is
    // system-locked).
    expect(screen.queryByRole("button", { name: "Remove from class" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Aliases from class" })).toBeNull();
    expect(screen.getByRole("button", { name: "Definition settings for Aliases" })).not.toBeNull();
    expect(screen.queryByText(/System properties stay/)).toBeNull();
  });

  it("keeps the inherited group read-only — no grip, no config toggle", async () => {
    const client = await seedClient();
    const parent = await createTitledClass(client, "Parent");
    const child = await createTitledClass(client, "Child");
    await client.setClassExtends(child, [parent]);
    const schemaId = await client.createPropertySchema({ name: "inherited-one", type: "text" });
    await client.setClassProperty(parent, schemaId, {});
    renderSection(client, child);

    fireEvent.click(screen.getByRole("button", { name: /inherited/i }));
    await flushWrites();
    // Clicking the inherited row opens the definition directly — no Configure toggle.
    expect(screen.queryByRole("button", { name: "Configure inherited-one" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open property inherited-one" }));
    await flushWrites();
    // The settings modal's dialog carries no title attribute — the heading
    // names it.
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", { name: "Property settings" }),
    ).not.toBeNull();
  });
});
