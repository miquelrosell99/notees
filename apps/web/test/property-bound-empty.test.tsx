/**
 * Bound-but-empty rows: a class-bound property with no value and no default shows
 * in the panel as coming from the class — SCALAR types included (the
 * bound-empty panel pass used to cover grouped types only, leaving
 * url/email/number bindings invisible). The row renders the empty cell;
 * the first edit authors the value (de-facto realization); "Empty
 * property"/unrealize return it to this state.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PropertiesTable } from "../src/features/metadata/PropertiesTable.js";

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

describe("bound-but-empty rows — the virtual property shows", () => {
  it("a class-bound url with no value renders the empty cell with the from-class hint", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "URL", type: "url" });
    const classId = await client.createClass("Source");
    await client.setClassProperty(classId, schemaId, {});
    await client.assignClass(pageId, classId);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();
    // The empty scalar cell renders (the row the bound-empty pass used to
    // skip), and the from-class hint rides the label.
    const cell = container.querySelector<HTMLInputElement>('input[aria-label="Property URL"]');
    expect(cell).not.toBeNull();
    expect(container.querySelector('[data-property-schema-id] .nt-property-hint')).not.toBeNull();
    const row = client.getEffectiveProperties(pageId).find((r) => r.propertySchemaId === schemaId);
    expect(row).toMatchObject({ source: "bound", value: null, boundBy: classId });
  });

  it("an empty class-bound GROUPED property (text) renders the label with the from-class hint too", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Abstract", type: "text" });
    const classId = await client.createClass("Source");
    await client.setClassProperty(classId, schemaId, {});
    await client.assignClass(pageId, classId);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();
    // The grouped row's groupRows filter to authored/default only — the
    // empty bound row reduces away, so the hint rides the host's classBound.
    const hint = container.querySelector(`[data-property-schema-id="${schemaId}"] .nt-property-hint`);
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe("C");
    const row = client.getEffectiveProperties(pageId).find((r) => r.propertySchemaId === schemaId);
    expect(row).toMatchObject({ source: "bound", value: null, boundBy: classId });
  });

  it("an INACTIVE (soft-unbound) binding carries no from-class hint", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Abstract", type: "text" });
    const classId = await client.createClass("Source");
    await client.setClassProperty(classId, schemaId, {});
    await client.assignClass(pageId, classId);
    await client.setClassProperty(classId, schemaId, { active: false });

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();
    const hint = container.querySelector(`[data-property-schema-id="${schemaId}"] .nt-property-hint`);
    expect(hint).toBeNull();
  });

  it("typing into the cell authors the value — the bound row shadows into authored", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "URL", type: "url" });
    const classId = await client.createClass("Source");
    await client.setClassProperty(classId, schemaId, {});
    await client.assignClass(pageId, classId);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();
    const cell = container.querySelector<HTMLInputElement>('input[aria-label="Property URL"]')!;
    fireEvent.change(cell, { target: { value: "https://x.org" } });
    fireEvent.blur(cell);
    await flushWrites();
    await flushWrites();

    const rows = client.getEffectiveProperties(pageId).filter((r) => r.propertySchemaId === schemaId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "authored", value: "https://x.org", boundBy: classId });
  });

  it("unrealize returns the row to the bound-empty state (the class still supplies it)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "URL", type: "url" });
    const classId = await client.createClass("Source");
    await client.setClassProperty(classId, schemaId, {});
    await client.assignClass(pageId, classId);
    // Realize, then remove the property from the node (unset + unassign).
    await client.assignProperty(pageId, schemaId);
    await client.setProperty(pageId, schemaId, "https://x.org", 0);
    await client.unsetProperty(pageId, schemaId, 0);
    await client.unassignProperty(pageId, schemaId);
    await flushWrites();

    const rows = client.getEffectiveProperties(pageId).filter((r) => r.propertySchemaId === schemaId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "bound", value: null, boundBy: classId });
  });
});
