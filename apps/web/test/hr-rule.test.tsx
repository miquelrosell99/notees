/**
 * Horizontal rule blocks (owner 2026-10-16): a block whose content is
 * EXACTLY "---" renders as a horizontal rule at display time — the node is
 * an ordinary text block on the wire and in the store (zero protocol
 * footprint; the domain `isRuleContent` derivation). The row stays a normal
 * citizen: clicking it enters edit and shows the raw dashes, children under
 * a rule never render, and the slash menu's Divider entry inserts the block
 * through the standard object.create path (sync + undo ride along).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, waitFor } from "@testing-library/react";

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
  localStorage.clear();
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

/** Enter edit mode on the first block and return its editor element. */
function clickIntoBlock(container: HTMLElement): HTMLElement {
  const content = container.querySelector<HTMLElement>(".nt-block-content");
  if (content === null) throw new Error("no .nt-block-content");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/** Emulate typing with the caret at `caret` (default: end), firing input. */
function typeWithCaret(editor: HTMLElement, text: string, caret?: number): void {
  editor.textContent = text;
  const offset = caret ?? text.length;
  const node = editor.firstChild;
  if (node !== null) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  fireEvent.input(editor);
}

describe("rule block rendering (display-time --- derivation)", () => {
  it("a block whose content is exactly --- renders an hr instead of bullet + text", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "above" }],
    });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "---" }],
    });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "below" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rule = container.querySelector<HTMLElement>(".nt-block-rule");
    expect(rule).not.toBeNull();
    expect(rule!.tagName).toBe("HR");
    expect(container.textContent).toContain("above");
    expect(container.textContent).toContain("below");
    // The rule row carries no bullet dot, and the dashes are not displayed.
    const ruleRow = rule!.closest<HTMLElement>(".nt-block-row")!;
    expect(ruleRow.querySelector(".nt-bullet-dot")).toBeNull();
    expect(ruleRow.textContent).not.toContain("---");
  });

  it("children of a rule block are not rendered — a rule terminates a section", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const ruleId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "---" }],
    });
    await client.createObject({
      parentId: ruleId,
      contentAst: [{ type: "text", text: "hidden child" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(container.querySelector(".nt-block-rule")).not.toBeNull();
    expect(container.textContent).not.toContain("hidden child");
  });

  it("near misses stay ordinary blocks (no whitespace tolerance, no partial match)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    for (const text of ["----", "--- x", "x ---", " ---" ]) {
      await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text }] });
    }

    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(container.querySelectorAll(".nt-block-rule")).toHaveLength(0);
    expect(container.textContent).toContain("----");
    expect(container.textContent).toContain("--- x");
  });

  it("clicking the rule enters edit and shows the raw dashes — the block is never trapped", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const ruleId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "---" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const ruleContent = container.querySelector<HTMLElement>(
      `[data-block-id="${ruleId}"] .nt-block-content`,
    )!;
    fireEvent.click(ruleContent);

    // Edit mode: the hr is gone, the editor shows the raw "---" text.
    expect(container.querySelector(".nt-block-rule")).toBeNull();
    const editor = ruleContent.querySelector<HTMLElement>(".nt-block-text")!;
    expect(editor.textContent).toBe("---");
  });
});

describe("/divider — the slash-menu insertion affordance", () => {
  it("inserts a new block whose content is exactly --- after the current block and focuses it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    // The trigger opens on "/", the query filters on the rest; Enter executes.
    typeWithCaret(editor, "/");
    typeWithCaret(editor, "/divider");
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => {
      const children = client.getChildren(pageId);
      expect(children.map((child) => child.contentAst)).toEqual([
        [],
        [{ type: "text", text: "---" }],
      ]);
    });
    // The trigger text was stripped from the current block.
    expect(client.getNode(blockId)?.contentAst).toEqual([]);
    // Focus moved into the rule block's editor: the raw dashes show (the
    // /table focus precedent — editing state, not a silent insert).
    await waitFor(() => {
      const ruleEditor = container.querySelector<HTMLElement>(
        `[data-block-id="${client.getChildren(pageId)[1]!.id}"] .nt-block-text`,
      );
      expect(ruleEditor?.textContent).toBe("---");
    });
  });

  it("undo removes the inserted rule block (the standard object.create path)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/");
    typeWithCaret(editor, "/divider");
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(client.getChildren(pageId)).toHaveLength(2));

    await client.undo();
    await waitFor(() => expect(client.getChildren(pageId)).toHaveLength(1));
  });
});
