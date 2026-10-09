/**
 * Block-level metadata tests (2026-10-01 layout): classes ride the block
 * row's right-hand column, tags a dedicated row below (only when set), and
 * properties the collapsed "Metadata N" section (hidden when empty). A
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
    const pageId = await client.createObject({ presentAsMain: true, name: "Plain" });
    const plainId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "nothing to see" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(blockMetadata(container, plainId)).toBeNull();
  });

  it("shows the metadata section when the block has a class", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Highlight");
    const pageId = await client.createObject({ presentAsMain: true, name: "Blocks" });
    const classedId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "carry me" }],
    });
    const plainId = await client.createObject({
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
    const pageId = await client.createObject({ presentAsMain: true, name: "Props" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "propped" }],
    });
    await client.setProperty(blockId, schemaId, "done", 0);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const section = blockMetadata(container, blockId);
    expect(section).not.toBeNull();
    // The collapsed "Metadata" section expands on click.
    expect(section!.textContent).toContain("Metadata");
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
    const tagId = await client.createObject({ presentAsMain: true, name: "review-later" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Tagged" });
    const blockId = await client.createObject({
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

  it("the page-level properties render on their own (side panel in the default layout, in-flow section in compact)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Solo" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "block without metadata" }],
    });

    // Default (panelled) layout: the page properties ride the left side
    // panel; no in-flow metadata section, none for the plain block either.
    const panelled = render(<PageView client={client} pageId={pageId} />);
    expect(panelled.container.querySelector(".nt-page-side-panel")).not.toBeNull();
    expect(panelled.container.querySelectorAll(".node-metadata-section")).toHaveLength(0);
    panelled.unmount();

    // Compact layout: the in-flow "Metadata" section renders under the
    // header (exactly one — the page's; the block carries nothing).
    const compact = render(<PageView client={client} pageId={pageId} layout="compact" />);
    const sections = compact.container.querySelectorAll(".node-metadata-section");
    expect(sections).toHaveLength(1);
  });
});

describe("BlockRow value-display buttons", () => {
  /** A block whose class binds a select schema at the given display
   *  position (display is property-level — set on the schema). */
  async function seedDisplayBlock(display: "bullet" | "inline" | "panel") {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "status",
      type: "select",
      options: [{ id: "opt-1", label: "Doing", icon: "mdiCircleHalfFull", color: "orange" }],
    });
    const classId = await client.createClass("Taskish");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    if (display !== "panel") {
      await client.updatePropertySchema(schemaId, { display });
    }
    const pageId = await client.createObject({ presentAsMain: true, name: "Tasks" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "task" }],
    });
    await client.assignClass(blockId, classId);
    return { client, pageId, blockId };
  }

  it("a bullet-displayed binding renders the icon button and omits the properties section", async () => {
    const { client, pageId, blockId } = await seedDisplayBlock("bullet");

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const block = container.querySelector(`[data-block-id="${blockId}"]`)!;
    // The button rides the row between the grip and the content — a sibling
    // after .nt-block-grip, never inside .nt-block-content.
    const bulletProps = block.querySelector(":scope > .nt-block-row > .nt-block-bullet-props");
    expect(bulletProps).not.toBeNull();
    const row = block.querySelector(":scope > .nt-block-row")!;
    const grip = row.querySelector(":scope > .nt-block-grip")!;
    const content = row.querySelector(":scope > .nt-block-content")!;
    expect(grip.compareDocumentPosition(bulletProps!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bulletProps!.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(content.querySelector(".nt-propicon")).toBeNull();
    // The value is set from the unset button, so the collapsed panel would
    // duplicate nothing — it is omitted entirely here (no other properties).
    expect(block.querySelector(":scope > .node-metadata-section")).toBeNull();
  });

  it("an inline-displayed binding renders in the inline group before the content", async () => {
    const { client, pageId, blockId } = await seedDisplayBlock("inline");

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const block = container.querySelector(`[data-block-id="${blockId}"]`)!;
    const inlineProps = block.querySelector(":scope > .nt-block-row > .nt-block-inline-props");
    expect(inlineProps).not.toBeNull();
    expect(inlineProps!.querySelector(".nt-propicon")).not.toBeNull();
    expect(block.querySelector(":scope > .node-metadata-section")).toBeNull();
  });

  it("a panel-displayed (default) binding renders no button and keeps the section", async () => {
    const { client, pageId, blockId } = await seedDisplayBlock("panel");

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const block = container.querySelector(`[data-block-id="${blockId}"]`)!;
    expect(block.querySelector(".nt-propicon")).toBeNull();
    // The panel still carries the bound property's add affordance.
    const section = blockMetadata(container, blockId);
    expect(section).not.toBeNull();
    fireEvent.click(section!.querySelector(".node-view-section__header") as HTMLElement);
    expect(section!.textContent).toContain("status");
  });

  it("a bullet-displayed boolean binding renders the button and omits the section", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "reviewed", type: "boolean" });
    const classId = await client.createClass("Reviewable");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    await client.updatePropertySchema(schemaId, { display: "bullet" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Review" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "check me" }],
    });
    await client.assignClass(blockId, classId);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const block = container.querySelector(`[data-block-id="${blockId}"]`)!;
    // The unset affordance renders for the bound-but-empty boolean…
    const button = block.querySelector(
      ":scope > .nt-block-row > .nt-block-bullet-props .nt-propicon",
    );
    expect(button).not.toBeNull();
    expect(button!.getAttribute("title")).toBe("reviewed: none");
    // …and the panel omits the row-positioned property.
    expect(block.querySelector(":scope > .node-metadata-section")).toBeNull();
  });
});
