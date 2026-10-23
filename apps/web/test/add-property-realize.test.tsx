/**
 * The REALIZE affordance (owner ruling 2026-10-23 — the virtual/realized
 * assessment): a class-bound property is VIRTUAL on a classed node until
 * realized (pinned by property.assign, or carrying an authored value). The
 * "+ Add property" picker surfaces the bound-but-unrealized set as
 * "Realize … · from <class>" entries (nearest binder — own bindings before
 * extends-ancestors) and drops REALIZED schemas entirely (their rows
 * already render; re-adding would be a no-op). Picking a Realize entry
 * authors the same property.assign as Add — the declaration survives class
 * removal on its own.
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

/** Open the "+ Add property" popup and return its container. */
async function openPicker(container: HTMLElement): Promise<HTMLElement> {
  const addButton = container.querySelector<HTMLButtonElement>(".nt-add-property .pill--add")!;
  fireEvent.click(addButton);
  await flushWrites();
  return container.querySelector<HTMLElement>(".nt-add-property-popup")!;
}

function popupEntries(popup: HTMLElement): Array<{ name: string; tag: string }> {
  return [...popup.querySelectorAll("li button")].map((button) => ({
    name: button.querySelector(".nt-add-property-name")!.textContent!,
    tag: button.querySelector(".nt-add-property-type")!.textContent!,
  }));
}

describe("the Realize entries (virtual → realized)", () => {
  it("bound-but-unrealized properties lead the picker, tagged with their binder; unbound properties stay plain Add entries", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const boundId = await client.createPropertySchema({ name: "Summary", type: "text" });
    const freeId = await client.createPropertySchema({ name: "Mood", type: "text" });
    const classId = await client.createClass("Document");
    await client.setClassProperty(classId, boundId, {});
    await client.assignClass(pageId, classId);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const popup = await openPicker(container);
    const entries = popupEntries(popup);
    // The realize entry leads and names its class; the unbound schema rides
    // as a plain Add entry with its type.
    expect(entries[0]).toEqual({ name: "Summary", tag: "realize · from Document" });
    expect(entries).toContainEqual({ name: "Mood", tag: "text" });
    expect(entries.find((e) => e.name === "Mood")!.tag).toBe("text");
    expect(freeId).toBeDefined();
  });

  it("the nearest EXTENDS-ancestor binder names the tag (own bindings win)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Provenance", type: "text" });
    const baseId = await client.createClass("Source");
    const subId = await client.createClass("Book");
    await client.setClassExtends(subId, [baseId]);
    await client.setClassProperty(baseId, schemaId, {});
    await client.assignClass(pageId, subId);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const popup = await openPicker(container);
    const entries = popupEntries(popup);
    expect(entries).toContainEqual({ name: "Provenance", tag: "realize · from Source" });
  });

  it("picking Realize assigns the property — the row renders; and the schema drops out of the picker (realized)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    const classId = await client.createClass("Document");
    await client.setClassProperty(classId, schemaId, {});
    await client.assignClass(pageId, classId);

    const { container, rerender } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const popup = await openPicker(container);
    const realizeButton = [...popup.querySelectorAll<HTMLButtonElement>("li button")].find(
      (button) => button.querySelector(".nt-add-property-name")?.textContent === "Summary",
    )!;
    fireEvent.click(realizeButton);
    await flushWrites();
    await flushWrites();

    // The declaration landed — the assigned-empty row renders.
    const rows = client.getEffectiveProperties(pageId).filter((r) => r.propertySchemaId === schemaId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "assigned", value: null });

    // Reopen the picker: the schema is realized — it no longer appears.
    rerender(<PropertiesTable client={client} nodeId={pageId} />);
    const popupAgain = await openPicker(container);
    expect(
      popupEntries(popupAgain).some((entry) => entry.name === "Summary"),
    ).toBe(false);
  });

  it("a valued property is realized too — it drops out of the picker (no no-op re-add)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "URL", type: "url" });
    await client.setProperty(pageId, schemaId, "https://x.org", 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const popup = await openPicker(container);
    expect(popupEntries(popup).some((entry) => entry.name === "URL")).toBe(false);
  });
});
