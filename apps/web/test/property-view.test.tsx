/**
 * PropertyView (§34.32 PG12) — web level, jsdom over the in-process
 * WorkspaceClient:
 *
 *  - the inspector renders the schema's metadata (type/multi/scope line),
 *    its bound classes, and the references section — the nodes carrying an
 *    AUTHORED value for the schema (the store's propertyValueCarriers
 *    read); nodes with only an unvalued binding never list, and trashed
 *    carriers drop out;
 *  - clicking a reference row navigates through onOpenPage;
 *  - the entry point: clicking a property label in the metadata table opens
 *    the settings modal, whose "Open property" button swaps to the
 *    PropertyView.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { PropertyView } from "../src/ui/components/PropertyView.js";

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

/** The inspector's seed: one bound schema, two carriers, one unvalued member. */
async function seedInspector(client: WorkspaceClient): Promise<{
  schemaId: string;
  classId: string;
  carriers: string[];
  unvalued: string;
}> {
  const schemaId = await client.createPropertySchema({ name: "code", type: "text" });
  const classId = await client.createClass("Shelf");
  // WORKAROUND(store applier): class.create's contentAst never lands — seed
  // the title through object.update (same pattern as pickers.test.tsx).
  await client.updateObject(classId, { contentAst: [{ type: "text", text: "Shelf" }] });
  await client.setClassProperty(classId, schemaId, { sequence: 0 });
  const carriers: string[] = [];
  for (const name of ["Alpha", "Beta"]) {
    const id = await client.createObject({ presentAsMain: true, name });
    await client.assignClass(id, classId);
    await client.setProperty(id, schemaId, `value-${name}`, 0);
    carriers.push(id);
  }
  const unvalued = await client.createObject({ presentAsMain: true, name: "Gamma" });
  await client.assignClass(unvalued, classId);
  return { schemaId, classId, carriers, unvalued };
}

describe("PropertyView (§34.32 PG12)", () => {
  it("shows schema metadata, bound classes, and the authored-value references", async () => {
    const client = await seedClient();
    const { schemaId, carriers } = await seedInspector(client);

    const onOpenPage = vi.fn();
    const onClose = vi.fn();
    render(
      <PropertyView
        client={client}
        propertySchemaId={schemaId}
        onClose={onClose}
        onOpenPage={onOpenPage}
      />,
    );

    expect(screen.getByRole("heading", { name: "code" })).not.toBeNull();
    expect(screen.getByText("text · global")).not.toBeNull();

    // Bound classes: the one class binding the schema.
    const boundSection = screen.getByRole("button", { name: /^Bound classes / }).closest(".node-view-section")!;
    expect(boundSection.textContent).toContain("Shelf");

    // References: exactly the two carriers — Gamma (bound but unvalued)
    // never lists.
    const refsSection = screen.getByRole("button", { name: /^References / }).closest(".node-view-section")!;
    const table = within(refsSection as HTMLElement);
    expect(table.getByText("Alpha")).not.toBeNull();
    expect(table.getByText("Beta")).not.toBeNull();
    expect(table.queryByText("Gamma")).toBeNull();
    expect(table.getByText("value-Alpha")).not.toBeNull();

    // Row click navigates; Close closes.
    fireEvent.click(table.getByText("Alpha"));
    expect(onOpenPage).toHaveBeenCalledWith(carriers[0]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("opens from the property settings modal (the property-label entry point)", async () => {
    const client = await seedClient();
    const { schemaId, classId } = await seedInspector(client);
    const hostId = await client.createObject({ presentAsMain: true, name: "Host" });
    await client.assignClass(hostId, classId);
    await client.setProperty(hostId, schemaId, "mine", 0);

    render(<PageView client={client} pageId={hostId} />);
    const header = screen.queryByRole("button", { name: /^Properties / });
    if (header !== null && header.getAttribute("aria-expanded") === "false") {
      fireEvent.click(header);
    }

    // Click the property label → settings modal → "Open property".
    fireEvent.click(screen.getByText("code"));
    expect(screen.getByRole("heading", { name: "Property settings" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open property" }));

    // The inspector replaced the settings modal.
    expect(screen.queryByRole("heading", { name: "Property settings" })).toBeNull();
    expect(screen.getByRole("heading", { name: "code" })).not.toBeNull();
    const refsSection = screen.getByRole("button", { name: /^References / }).closest(".node-view-section")!;
    expect(within(refsSection as HTMLElement).getByText("Host")).not.toBeNull();
  });
});
