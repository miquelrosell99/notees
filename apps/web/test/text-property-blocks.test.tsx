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

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PropertiesTable } from "../src/features/metadata/index.js";

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
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
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
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
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
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
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

  it("a dead carrier whose node is gone auto-unsets (the slot returns to empty)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    await client.setProperty(pageId, schemaId, { nodeId: "0192a000-0000-7000-8000-000000000099" }, 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();
    await flushWrites();

    // No lingering dead cell — the value is unset. (The table host re-renders
    // on its own subscription; here we assert the client state, the truth the
    // next render reflects.)
    expect(authoredTextRows(client, pageId, schemaId).length).toBe(0);
  });

  it("a dead ref to a node that still exists keeps the re-author cell", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    // A page (is_embedded) is a real node that no longer renders as an
    // inline block — the recovery cell, not auto-unset.
    const promoted = await client.createObject({ isEmbedded: false, name: "Promoted" });
    await client.setProperty(pageId, schemaId, { nodeId: promoted }, 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();

    expect(authoredTextRows(client, pageId, schemaId).length).toBe(1);
    const input = container.querySelector<HTMLInputElement>(".nt-property-textcell .nt-property-value");
    expect(input).not.toBeNull();
    expect(input!.placeholder).not.toBe("Type something");

    fireEvent.change(input!, { target: { value: "resurrected" } });
    fireEvent.blur(input!);
    await flushWrites();
    await flushWrites();

    const rows = authoredTextRows(client, pageId, schemaId);
    expect(rows.length).toBe(1);
    const revived = (rows[0]!.value as { nodeId: string }).nodeId;
    expect(revived).not.toBe(promoted);
    expect(client.getNode(revived)?.parentId).toBe(pageId);
    const first = client.getNode(revived)?.contentAst[0] as { text?: string } | undefined;
    expect(first?.text).toBe("resurrected");
  });
});

describe("auto-unset of contentless text values", () => {
  it("a carrier with no content and no children is unset when the row renders over it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    const carrier = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "" }] });
    await client.setProperty(pageId, schemaId, { nodeId: carrier }, 0);

    render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();
    await flushWrites();

    expect(authoredTextRows(client, pageId, schemaId).length).toBe(0);
    // The unset trashes the now-unreferenced carrier (getNode hides trashed).
    expect(client.getNode(carrier)).toBeUndefined();
  });

  it("a carrier with content keeps its value", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    const carrier = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "kept" }] });
    await client.setProperty(pageId, schemaId, { nodeId: carrier }, 0);

    render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();

    expect(authoredTextRows(client, pageId, schemaId).length).toBe(1);
  });

  it("a carrier with empty content but a child keeps its value", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    const carrier = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "" }] });
    await client.createObject({ parentId: carrier, contentAst: [{ type: "text", text: "child line" }] });
    await client.setProperty(pageId, schemaId, { nodeId: carrier }, 0);

    render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();

    expect(authoredTextRows(client, pageId, schemaId).length).toBe(1);
  });

  it("a carrier emptied while its editor holds the caret is kept; leaving the row unsets it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    const carrier = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "soon gone" }] });
    await client.setProperty(pageId, schemaId, { nodeId: carrier }, 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    const editor = clickIntoBlock(container, 0);
    expect(document.activeElement).toBe(editor);

    // The flush lands (select-all + delete): the carrier is now contentless,
    // but the caret is still in the row — the value survives.
    await act(async () => {
      await client.updateObject(carrier, { contentAst: [{ type: "text", text: "" }] });
    });
    expect(authoredTextRows(client, pageId, schemaId).length).toBe(1);

    // Leaving the row (focus moves outside) runs the pass: the value is
    // unset and the carrier trashed.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
    });
    await flushWrites();
    await flushWrites();

    expect(authoredTextRows(client, pageId, schemaId).length).toBe(0);
    expect(client.getNode(carrier)).toBeUndefined();
  });

  it("an empty scalar value auto-unsets", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Citekey", type: "text" });
    await client.setProperty(pageId, schemaId, "", 0);

    render(<PropertiesTable client={client} nodeId={pageId} />);
    await flushWrites();
    await flushWrites();

    expect(authoredTextRows(client, pageId, schemaId).length).toBe(0);
  });

  it("the Add pill's fresh empty carrier survives while the row holds focus", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Notes", type: "text", multi: true });
    const carrierA = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "first" }] });
    await client.setProperty(pageId, schemaId, { nodeId: carrierA }, 0);

    const { container } = render(<PropertiesTable client={client} nodeId={pageId} />);
    // TextPropertyRow's Add pill (a direct child of the textcell — buttons
    // inside the carrier rows are block chrome).
    const addButton = container.querySelector<HTMLButtonElement>(
      ".nt-property-text .nt-property-textcell > button.pill--add",
    );
    expect(addButton).not.toBeNull();
    // A real click focuses the button — inside the row — so the pass must
    // not unset the empty value the click is about to mint.
    act(() => {
      addButton!.focus();
    });
    fireEvent.click(addButton!);
    await flushWrites();
    await flushWrites();

    expect(authoredTextRows(client, pageId, schemaId).length).toBe(2);
  });
});

describe("the '+ Add property' assignment (unbound text)", () => {
  /** Drive the real panel flow: open the picker, pick the schema. The host
   *  table carries no store subscription of its own (the rows do), so the
   *  rerender stands in for the surrounding view re-rendering — the moment
   *  the new TextPropertyRow mounts. */
  async function addViaPanel(
    container: HTMLElement,
    /** Re-render the mounted host with current client state (the host table
     *  has no store subscription of its own — the rows do); this is the
     *  moment the new TextPropertyRow mounts. */
    rerenderHost: () => void,
    label: string,
  ): Promise<void> {
    const addButton = container.querySelector<HTMLButtonElement>(".nt-add-property .pill--add");
    expect(addButton).not.toBeNull();
    fireEvent.click(addButton!);
    const option = [...container.querySelectorAll<HTMLButtonElement>(".nt-add-property-popup li button")].find(
      (button) => button.querySelector(".nt-add-property-name")?.textContent === label,
    );
    expect(option).toBeDefined();
    fireEvent.click(option!);
    await flushWrites();
    await flushWrites();
    rerenderHost();
  }

  function assignedRows(client: Awaited<ReturnType<typeof seedClient>>, pageId: string, schemaId: string) {
    return client.getEffectiveProperties(pageId).filter(
      (row) => row.propertySchemaId === schemaId && row.source === "assigned",
    );
  }

  it("a text add ASSIGNS the schema without a value — the row renders the empty cell (owner ruling 2026-10-23)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });

    const { container, rerender } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await addViaPanel(container, () => rerender(<PropertiesTable client={client} nodeId={pageId} />), "Summary");

    // No value was authored (no placeholder carrier exists at all) — the
    // declaration alone renders the row.
    expect(authoredTextRows(client, pageId, schemaId).length).toBe(0);
    const assigned = assignedRows(client, pageId, schemaId);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.value).toBeNull();
    // The empty cell reads as a field, awaiting the first value.
    const cell = container.querySelector<HTMLInputElement>('.nt-property-textcell input[placeholder="Type something"]');
    expect(cell).not.toBeNull();
  });

  it("typing into the empty cell authors the first carrier — the value lands later", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });

    const { container, rerender } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await addViaPanel(container, () => rerender(<PropertiesTable client={client} nodeId={pageId} />), "Summary");

    const cell = container.querySelector<HTMLInputElement>('.nt-property-textcell input[placeholder="Type something"]')!;
    fireEvent.change(cell, { target: { value: "the first line" } });
    fireEvent.blur(cell);
    await flushWrites();
    await flushWrites();
    rerender(<PropertiesTable client={client} nodeId={pageId} />);

    const rows = authoredTextRows(client, pageId, schemaId);
    expect(rows).toHaveLength(1);
    const carrier = (rows[0]!.value as { nodeId: string }).nodeId;
    expect(client.getNode(carrier)).toBeDefined();
    // The assigned-empty shadow row is gone — the authored row wins.
    expect(assignedRows(client, pageId, schemaId)).toHaveLength(0);
  });

  it("leaving the empty cell empty keeps the assignment — no fabricated value", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });

    const { container, rerender } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await addViaPanel(container, () => rerender(<PropertiesTable client={client} nodeId={pageId} />), "Summary");

    const cell = container.querySelector<HTMLInputElement>('.nt-property-textcell input[placeholder="Type something"]')!;
    fireEvent.change(cell, { target: { value: "" } });
    fireEvent.blur(cell);
    await flushWrites();
    await flushWrites();

    // The declaration stands; nothing was authored.
    expect(authoredTextRows(client, pageId, schemaId).length).toBe(0);
    expect(assignedRows(client, pageId, schemaId)).toHaveLength(1);
  });

  it("the class-bound add flow keeps working (the binding's empty row appears; the add assigns idempotently)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const schemaId = await client.createPropertySchema({ name: "Summary", type: "text" });
    const classId = await client.createClass("Document");
    await client.setClassProperty(classId, schemaId, {});
    await client.assignClass(pageId, classId);

    const { container, rerender } = render(<PropertiesTable client={client} nodeId={pageId} />);
    await addViaPanel(container, () => rerender(<PropertiesTable client={client} nodeId={pageId} />), "Summary");

    // Still no value anywhere — the bound-empty row renders (via the
    // assignment or the binding, either way the cell awaits the first value).
    expect(authoredTextRows(client, pageId, schemaId).length).toBe(0);
    const cell = container.querySelector<HTMLInputElement>('.nt-property-textcell input[placeholder="Type something"]');
    expect(cell).not.toBeNull();
  });
});
