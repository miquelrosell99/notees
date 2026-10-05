/**
 * Outliner editor tests: PageView/BlockRow/BlockTextEditor over the
 * in-process WorkspaceClient + MemoryRelay (jsdom). Covers the editable
 * slice: debounced prose saves (flush points), the Enter / Shift+Enter /
 * Backspace keyboard contract, Enter sibling placement (afterId), title
 * commit, the empty-page affordance, and the Tab / Shift+Tab reparent
 * gestures (object.move).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { SAVE_DEBOUNCE_MS } from "../src/ui/BlockTextEditor.js";
import { astFromProse, proseFromAst } from "../src/editor/prose.js";
import { buildOutlinePositions } from "../src/editor/outline.js";
import type { BlockTreeNode } from "../src/core/workspace-client.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

/** Enter edit mode on the nth block (document order) and return its editor. */
function clickIntoBlock(container: HTMLElement, index: number): HTMLElement {
  const contents = container.querySelectorAll<HTMLElement>(".nt-block-content");
  const target = contents[index];
  if (target === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(target);
  const editor = target.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/** Emulate typing/browsers mutating the contentEditable DOM + input event. */
function typeInto(editor: HTMLElement, text: string): void {
  editor.textContent = text;
  fireEvent.input(editor);
}

function node(id: string, children: BlockTreeNode[] = []): BlockTreeNode {
  return {
    node: {
      id,
      workspaceId: WS,
      isClass: false,
      presentAsMain: false,
      parentId: null,
      classIds: [],
      tagIds: [],
      name: null,
      contentAst: [],
      icon: null,
      color: null,
      isActive: true,
      createdAt: null,
      updatedAt: null,
    },
    children,
  };
}

describe("prose projection helpers", () => {
  it("round-trips plain runs and hard breaks", () => {
    expect(proseFromAst([{ type: "text", text: "a" }, { type: "hard_break" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(astFromProse("a\nb", [])).toEqual([
      { type: "text", text: "a" },
      { type: "hard_break" },
      { type: "text", text: "b" },
    ]);
    expect(astFromProse("a\n\nb", [])).toEqual([
      { type: "text", text: "a" },
      { type: "hard_break" },
      { type: "hard_break" },
      { type: "text", text: "b" },
    ]);
    expect(astFromProse("", [])).toEqual([]);
  });

  it("preserves marks of a single text run that stays single-run", () => {
    const previous = [{ type: "text", text: "hello", marks: ["bold"] }];
    expect(astFromProse("hello world", previous)).toEqual([
      { type: "text", text: "hello world", marks: ["bold"] },
    ]);
    // A split drops marks (documented slice limitation).
    expect(astFromProse("hello\nworld", previous)).toEqual([
      { type: "text", text: "hello" },
      { type: "hard_break" },
      { type: "text", text: "world" },
    ]);
  });

  it("buildOutlinePositions records sibling and grandparent facts", () => {
    const a = node("a");
    const b = node("b", [node("b1"), node("b2")]);
    const positions = buildOutlinePositions([a, b]);
    expect(positions.get("a")).toEqual({ parentId: null, previousSiblingId: null, grandParentId: null });
    expect(positions.get("b")).toEqual({ parentId: null, previousSiblingId: "a", grandParentId: null });
    expect(positions.get("b1")).toEqual({ parentId: "b", previousSiblingId: null, grandParentId: null });
    expect(positions.get("b2")).toEqual({ parentId: "b", previousSiblingId: "b1", grandParentId: null });
  });

  it("buildOutlinePositions threads the root parent (page) into grandparent facts", () => {
    const page = "0192a000-0000-7000-8000-000000000020";
    const positions = buildOutlinePositions([node("a", [node("a1")])], page);
    expect(positions.get("a")).toEqual({ parentId: page, previousSiblingId: null, grandParentId: null });
    // Outdent target for a child of a top-level block IS the page.
    expect(positions.get("a1")).toEqual({ parentId: "a", previousSiblingId: null, grandParentId: page });
  });
});

describe("outliner editor", () => {
  it("typing saves the block via the 400 ms debounce flush", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Edit Me" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    vi.useFakeTimers();
    const editor = clickIntoBlock(container, 0);
    expect(document.activeElement).toBe(editor);

    typeInto(editor, "hello world");
    // Not saved before the debounce elapses.
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "hello" }]);

    act(() => {
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    });
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "hello world" }]);
    vi.useRealTimers();

    // Blur after the debounced save is a no-op second write; read mode
    // renders the saved tokens again.
    fireEvent.blur(editor);
    expect(container.querySelector(".nt-block-text")).toBeNull();
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("flushes a dirty draft on blur (no fake timers)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Blur Flush" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "draft" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    typeInto(editor, "draft saved on blur");
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "draft" }]);

    fireEvent.blur(editor);
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "draft saved on blur" }]);
  });

  it("shift+Enter newlines save as hard_break tokens", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Breaks" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "old" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    // The keydown is allowed through (no preventDefault); the browser then
    // inserts the newline — emulated here by the DOM mutation + input event.
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    typeInto(editor, "line1\nline2");
    fireEvent.blur(editor);

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "line1" },
      { type: "hard_break" },
      { type: "text", text: "line2" },
    ]);
    // Read mode renders the break back as a <br>.
    expect(container.querySelector("br")).not.toBeNull();
    expect(screen.getByText("line1")).toBeInTheDocument();
  });

  it("Enter creates an empty sibling block and moves the caret to it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Split" });
    const firstId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "first" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter" });
    });

    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(2);
    const secondId = tree[1]!.node.id;
    expect(secondId).not.toBe(firstId);
    // Both are children of the page; Enter placement lands the new sibling
    // right after the current block via object.move (afterId).
    expect(tree[0]!.node.parentId).toBe(pageId);
    expect(tree[1]!.node.parentId).toBe(pageId);
    expect(tree[0]!.node.contentAst).toEqual([{ type: "text", text: "first" }]);
    expect(tree[1]!.node.contentAst).toEqual([]);

    // The new block took over edit mode and the focus.
    const editors = container.querySelectorAll<HTMLElement>(".nt-block-text");
    expect(editors).toHaveLength(1);
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(active!.classList.contains("nt-block-text")).toBe(true);
    expect(active!.textContent).toBe("");
  });

  it("Enter lands the new sibling immediately AFTER the current block, not at the end", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Placement" });
    const firstId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "first" }],
    });
    const secondId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "second" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter" });
    });

    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(3);
    expect(tree[0]!.node.id).toBe(firstId);
    expect(tree[2]!.node.id).toBe(secondId);
    const newId = tree[1]!.node.id;
    expect(newId).not.toBe(firstId);
    expect(newId).not.toBe(secondId);
    expect(tree[1]!.node.parentId).toBe(pageId);
    // The new block took over edit mode and the focus.
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(active!.classList.contains("nt-block-text")).toBe(true);
    expect(active!.textContent).toBe("");
  });

  it("Backspace on an empty block deletes it and focuses the previous block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Delete" });
    const firstId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "first" }],
    });
    const secondId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(client.getBlockTree(pageId)).toHaveLength(2);

    // The second (empty) block: content div with no text to click on.
    const editor = clickIntoBlock(container, 1);
    expect(editor.textContent).toBe("");
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Backspace" });
    });

    expect(client.getNode(secondId)).toBeUndefined();
    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.node.id).toBe(firstId);
    // Caret handed to the previous block, which entered edit mode at its end.
    const editors = container.querySelectorAll<HTMLElement>(".nt-block-text");
    expect(editors).toHaveLength(1);
    expect(editors[0]!.textContent).toBe("first");
    expect(document.activeElement).toBe(editors[0]!);
  });

  it("Tab indents under the previous sibling (object.move)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Indent" });
    const firstId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "one" }],
    });
    const secondId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "two" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const editor = clickIntoBlock(container, 1);
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Tab" });
    });

    expect(warn).not.toHaveBeenCalled();
    const tree = client.getBlockTree(pageId);
    expect(tree.map((t) => t.node.id)).toEqual([firstId]);
    expect(tree[0]!.children.map((t) => t.node.id)).toEqual([secondId]);
    expect(client.getNode(secondId)?.parentId).toBe(firstId);
  });

  it("Shift+Tab outdents to the grandparent, placed right after the parent", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Outdent" });
    const parentId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    const childId = await client.createObject({
      parentId,
      contentAst: [{ type: "text", text: "child" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Document order: the parent block, then its nested child.
    const editor = clickIntoBlock(container, 1);
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Tab", shiftKey: true });
    });

    expect(warn).not.toHaveBeenCalled();
    const tree = client.getBlockTree(pageId);
    expect(tree.map((t) => t.node.id)).toEqual([parentId, childId]);
    expect(tree[1]!.node.parentId).toBe(pageId);
  });

  it("typing on a marks block preserves the run's marks", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Marks" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello", marks: ["bold"] }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    typeInto(editor, "hello world");
    fireEvent.blur(editor);

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "hello world", marks: ["bold"] },
    ]);
    expect(screen.getByText("hello world").tagName).toBe("STRONG");
  });

  it("touching a mention-bearing block without changing its text does not flatten it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Rich" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: targetId, text: "Target" },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    expect(editor.textContent).toBe("see Target");
    // No text change — the flush must skip and keep the mention token.
    fireEvent.blur(editor);

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toHaveLength(2);
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId });
  });

  it("editing the page title commits the content on Enter and on blur", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Old Name" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = container.querySelector<HTMLElement>(".nt-page-title");
    if (title === null) throw new Error("title heading missing");
    expect(title.textContent).toBe("Old Name");

    title.textContent = "Committed Via Enter";
    fireEvent.keyDown(title, { key: "Enter" });
    expect(client.getPage(pageId)?.contentAst).toEqual([{ type: "text", text: "Committed Via Enter" }]);

    title.textContent = "Committed Via Blur";
    fireEvent.blur(title);
    expect(client.getPage(pageId)?.contentAst).toEqual([{ type: "text", text: "Committed Via Blur" }]);

    // The header re-renders from the committed content.
    expect(container.querySelector(".nt-page-title")!.textContent).toBe("Committed Via Blur");
  });

  it("an empty page offers the ghost add-block affordance that creates the first block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Blank" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(client.getBlockTree(pageId)).toHaveLength(0);

    const add = screen.getByRole("button", { name: /click to add a block/i });
    await act(async () => {
      fireEvent.click(add);
    });

    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.node.parentId).toBe(pageId);
    // The ghost stays (owner refinement: it is the always-on add affordance)
    // and the new block takes the focus.
    expect(screen.queryByRole("button", { name: /click to add a block/i })).not.toBeNull();
    const editor = container.querySelector<HTMLElement>(".nt-block-text");
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
  });
});
