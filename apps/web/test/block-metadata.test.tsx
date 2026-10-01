/**
 * Block-level metadata tests (2026-10-01 layout): classes ride the block
 * row's right-hand column, tags a dedicated row below (only when set), and
 * properties the collapsed "Properties N" section (hidden when empty). A
 * plain block shows none of the below-row chrome.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

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

async function seedClient(relay: MemoryRelay = new MemoryRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** The block's own metadata section element (null when absent). */
function blockMetadata(container: HTMLElement, blockId: string): HTMLElement | null {
  const block = container.querySelector(`[data-block-id="${blockId}"]`);
  expect(block).not.toBeNull();
  return block!.querySelector(":scope > .node-metadata-section");
}

describe("BlockRow metadata section", () => {
  it("shows no metadata section on a plain block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Plain" });
    const plainId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "nothing to see" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(blockMetadata(container, plainId)).toBeNull();
  });

  it("shows the metadata section when the block has a class", async () => {
    const client = await seedClient();
    const classId = await client.createObject({ nodeType: "class", name: "Highlight" });
    const pageId = await client.createObject({ nodeType: "page", name: "Blocks" });
    const classedId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "carry me" }],
    });
    const plainId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "plain sibling" }],
    });
    await client.assignClass(classedId, classId);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // Classes render in the row's right-hand column, not a metadata section.
    const block = container.querySelector(`[data-block-id="${classedId}"]`)!;
    expect(block.querySelector(":scope > .node-metadata-section")).toBeNull();
    expect(block.querySelector(".nt-block-classes")!.textContent).toContain("Highlight");
    // The plain sibling still shows nothing below its row.
    expect(blockMetadata(container, plainId)).toBeNull();
  });

  it("shows the metadata section when the block has an authored property", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "status", type: "text" });
    const pageId = await client.createObject({ nodeType: "page", name: "Props" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "propped" }],
    });
    await client.setProperty(blockId, schemaId, "done", 0);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const section = blockMetadata(container, blockId);
    expect(section).not.toBeNull();
    // The collapsed "Properties" section expands on click.
    expect(section!.textContent).toContain("Properties");
    const header = section!.querySelector(".node-view-section__header") as HTMLButtonElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(section!.textContent).toContain("status");
    // Scalar values render in a text input (defaultValue, not textContent).
    const input = section!.querySelector("input") as HTMLInputElement | null;
    expect(input?.value).toBe("done");
  });

  it("shows the metadata section when the block has a tag", async () => {
    // Tags are valid on blocks (owner rule): assignTag attaches any page.
    const client = await seedClient();
    const tagId = await client.createObject({ nodeType: "page", name: "review-later" });
    const pageId = await client.createObject({ nodeType: "page", name: "Tagged" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "tagged block" }],
    });
    await client.assignTag(blockId, tagId);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // Tags render in the dedicated row below the block row (no section).
    const block = container.querySelector(`[data-block-id="${blockId}"]`)!;
    expect(block.querySelector(":scope > .node-metadata-section")).toBeNull();
    expect(block.querySelector(".nt-block-tags")!.textContent).toContain("review-later");
  });

  it("the page-level metadata section still renders on its own", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Solo" });
    await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "block without metadata" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // Exactly one below-row section: the page's "Properties" (empty for this
    // page, so it still renders — the block carries nothing, so none for it).
    const sections = container.querySelectorAll(".node-metadata-section");
    expect(sections).toHaveLength(1);
  });
});
