/**
 * Text-property blocks list (owner ruling): a multi/single text
 * property renders as ONE row whose values are the carrier blocks
 * themselves (a blocks list, never repeated label entries), and Enter
 * applies the property semantics — multi registers the new sibling as the
 * next value; single nests a child block under the carrier.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PropertiesTable } from "../src/ui/components/MetadataSection.js";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
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

/** Click into the nth editable block inside the container; return its editor. */
function clickIntoBlock(container: HTMLElement, index = 0): HTMLElement {
  const contents = container.querySelectorAll<HTMLElement>(".nt-block-content");
  const target = contents[index];
  if (target === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(target);
  const editor = target.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

const flushWrites = (): Promise<void> => act(async () => {});

function authoredTextRows(client: WorkspaceClient, nodeId: string, schemaId: string) {
  return client
    .getEffectiveProperties(nodeId)
    .filter((row) => row.propertySchemaId === schemaId && row.source === "authored");
}

describe("text properties as a blocks list", () => {
  it("multi values render as ONE row of editable carrier blocks", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Notes", type: "text", multi: true });
    const carrierA = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "first line" }] });
    const carrierB = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "second line" }] });
    await client.setProperty(pageId, schemaId, { nodeId: carrierA }, 0);
    await client.setProperty(pageId, schemaId, { nodeId: carrierB }, 1);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const rows = container.querySelectorAll(".nt-property-text");
    expect(rows.length).toBe(1);
    // The carriers render through the locked outline collection — one
    // collection per row, each carrier a root BlockRow.
    const collections = container.querySelectorAll(".nt-property-textcell .node-collection--outline");
    expect(collections.length).toBe(1);
    expect(
      container.querySelector(`.nt-property-textcell [data-block-id="${carrierA}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`.nt-property-textcell [data-block-id="${carrierB}"]`),
    ).not.toBeNull();
    // The label appears once — values are blocks, not repeated entries.
    expect(container.querySelectorAll(".nt-property-text .nt-property-name").length).toBe(1);
  });

  it("multi: Enter on a value registers the new sibling as the next value", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Notes", type: "text", multi: true });
    const carrierA = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "alpha" }] });
    await client.setProperty(pageId, schemaId, { nodeId: carrierA }, 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const editor = clickIntoBlock(container, 0);
    fireEvent.keyDown(editor, { key: "Enter" });
    await flushWrites();
    await flushWrites();

    const rows = authoredTextRows(client, pageId, schemaId);
    expect(rows.length).toBe(2);
    const newValue = rows.find((row) => row.idx === 1);
    expect(newValue).toBeDefined();
    const newId = (newValue!.value as { nodeId: string }).nodeId;
    // The new value's block is a SIBLING of the carrier (a child of the page).
    expect(client.getNode(newId)?.parentId).toBe(pageId);
  });

  it("single: Enter nests a child block under the carrier (no new value)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    const carrier = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "one value" }] });
    await client.setProperty(pageId, schemaId, { nodeId: carrier }, 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const editor = clickIntoBlock(container, 0);
    fireEvent.keyDown(editor, { key: "Enter" });
    await flushWrites();
    await flushWrites();

    // No second value row…
    expect(authoredTextRows(client, pageId, schemaId).length).toBe(1);
    // …and the carrier gained a child block (the value's new line).
    const children = client.getChildren(carrier);
    expect(children.length).toBe(1);
  });

  it("a dead carrier renders empty and re-authors a fresh carrier on edit", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    await client.setProperty(pageId, schemaId, { nodeId: "0192a000-0000-7000-8000-000000000099" }, 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const input = container.querySelector<HTMLInputElement>(".nt-property-textcell .nt-property-value");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("");

    fireEvent.change(input!, { target: { value: "resurrected" } });
    fireEvent.blur(input!);
    await flushWrites();
    await flushWrites();

    const rows = authoredTextRows(client, pageId, schemaId);
    expect(rows.length).toBe(1);
    const revived = (rows[0]!.value as { nodeId: string }).nodeId;
    expect(client.getNode(revived)?.parentId).toBe(pageId);
    // The revived carrier holds the typed text.
    const first = client.getNode(revived)?.contentAst[0] as { text?: string } | undefined;
    expect(first?.text).toBe("resurrected");
  });
});
