/**
 * v1-level outliner key semantics (Roam/Logseq feel):
 * - Enter mid-text splits the block at the caret (head stays, tail moves to
 *   a new sibling right after).
 * - Enter at the start creates a new empty block BEFORE this one.
 * - Enter at the end of a block with children creates a new FIRST CHILD.
 * - Enter at the end (no children) creates a sibling after.
 * - Backspace at the start of text merges into the previous block when the
 *   v1 guard allows (same-parent childless / only-child into parent).
 * - Backspace on an empty block with children promotes the children into
 *   the block's place, then deletes it.
 * - Delete at the end merges a childless next sibling into this block.
 * - Shift+Tab logical outdent (default) drags subsequent siblings under the
 *   outdented block; "direct" mode moves only the block.
 *
 * Same harness as outliner-editor.test.tsx.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { writeDeviceSetting } from "../src/ui/components/modals/deviceSettings.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
});

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

/** Enter edit mode on the nth block (document order) and return its editor. */
function clickIntoBlock(container: HTMLElement, index = 0): HTMLElement {
  const contents = container.querySelectorAll<HTMLElement>(".nt-block-content");
  const target = contents[index];
  if (target === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(target);
  const editor = target.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/** Place a collapsed caret at a prose offset (walks runs and pills). */
function setProseCaret(editor: HTMLElement, proseOffset: number): void {
  let acc = 0;
  let target: Node | null = null;
  let inner = 0;
  for (const child of Array.from(editor.childNodes)) {
    const len = child.textContent?.length ?? 0;
    if (acc + len >= proseOffset) {
      target = child;
      inner = Math.max(0, proseOffset - acc);
      break;
    }
    acc += len;
  }
  const range = document.createRange();
  if (target === null) {
    range.selectNodeContents(editor);
    range.collapse(false);
  } else {
    const textNode = target instanceof HTMLElement ? (target.firstChild ?? target) : target;
    range.setStart(textNode, Math.min(inner, (textNode.textContent ?? "").length));
    range.collapse(true);
  }
  const selection = window.getSelection();
  if (selection === null) throw new Error("no selection");
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

const keyDown = (editor: HTMLElement, key: string, extra: Record<string, unknown> = {}) =>
  act(() => {
    fireEvent.keyDown(editor, { key, ...extra });
  });

const flushAsync = () => act(async () => {});

/** Ordered child ids of a parent. */
const childIds = (client: WorkspaceClient, parentId: string) =>
  client.getChildren(parentId).map((child) => child.id);

describe("outliner keys", () => {
  it("Enter mid-text splits the block; the tail lands in a new sibling right after", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Split" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello world" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    setProseCaret(editor, 6);
    keyDown(editor, "Enter");
    await flushAsync();

    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "hello " }]);
    const children = client.getChildren(pageId);
    expect(children).toHaveLength(2);
    expect(children[1]!.contentAst).toEqual([{ type: "text", text: "world" }]);
  });

  it("Enter at the start creates a new empty block BEFORE this one", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Before" });
    const aId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "A" }],
    });
    const bId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "B" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 1); // block B
    setProseCaret(editor, 0);
    keyDown(editor, "Enter");
    await flushAsync();

    const ids = childIds(client, pageId);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(aId);
    expect(ids[2]).toBe(bId);
    const created = client.getNode(ids[1]!);
    expect(created?.contentAst).toEqual([]);
  });

  it("Enter before the FIRST child uses the before-first placement", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "First" });
    const aId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "A" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 0);
    setProseCaret(editor, 0);
    keyDown(editor, "Enter");
    await flushAsync();

    const ids = childIds(client, pageId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(aId);
    expect(client.getNode(ids[0]!)?.contentAst).toEqual([]);
  });

  it("Enter at the end of a block with children creates a new FIRST CHILD", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Child" });
    const parentBlock = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    const kid = await client.createObject({
      parentId: parentBlock,
      contentAst: [{ type: "text", text: "kid" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 0); // the parent block
    setProseCaret(editor, 6); // end
    keyDown(editor, "Enter");
    await flushAsync();

    const ids = childIds(client, parentBlock);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(kid);
    expect(client.getNode(ids[0]!)?.contentAst).toEqual([]);
  });

  it("Backspace at the start of text merges into the previous sibling (guard passes)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Merge" });
    const aId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "first" }],
    });
    const bId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "second" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 1);
    setProseCaret(editor, 0);
    keyDown(editor, "Backspace");
    await flushAsync();

    expect(client.getNode(bId)).toBeUndefined(); // soft-deleted
    expect(client.getNode(aId)?.contentAst).toEqual([{ type: "text", text: "firstsecond" }]);
  });

  it("Backspace at the start is a no-op when the guard fails (previous has children)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Guard" });
    const aId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "A" }],
    });
    await client.createObject({ parentId: aId, contentAst: [{ type: "text", text: "child" }] });
    const bId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "B" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 1); // B (A has a child → guard fails)
    setProseCaret(editor, 0);
    keyDown(editor, "Backspace");
    await flushAsync();

    expect(childIds(client, pageId)).toEqual([aId, bId]);
    expect(client.getNode(bId)?.contentAst).toEqual([{ type: "text", text: "B" }]);
  });

  it("Backspace on an empty block with children promotes them, then deletes", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Promote" });
    const holder = await client.createObject({
      parentId: pageId,
      contentAst: [],
    });
    const k1 = await client.createObject({ parentId: holder, contentAst: [{ type: "text", text: "k1" }] });
    const k2 = await client.createObject({ parentId: holder, contentAst: [{ type: "text", text: "k2" }] });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 0);
    keyDown(editor, "Backspace");
    await flushAsync();

    expect(client.getNode(holder)).toBeUndefined();
    expect(childIds(client, pageId)).toEqual([k1, k2]);
  });

  it("Delete at the end merges a childless next sibling into this block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "DelMerge" });
    const aId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "one" }],
    });
    const bId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "two" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 0);
    setProseCaret(editor, 3); // end of "one"
    keyDown(editor, "Delete");
    await flushAsync();

    expect(client.getNode(bId)).toBeUndefined();
    expect(client.getNode(aId)?.contentAst).toEqual([{ type: "text", text: "onetwo" }]);
  });

  it("Shift+Tab (logical, default) outdents and drags subsequent siblings under the block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Logical" });
    const cat = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "cat" }] });
    const a = await client.createObject({ parentId: cat, contentAst: [{ type: "text", text: "a" }] });
    const b = await client.createObject({ parentId: cat, contentAst: [{ type: "text", text: "b" }] });
    const c = await client.createObject({ parentId: cat, contentAst: [{ type: "text", text: "c" }] });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 1); // block "a"
    keyDown(editor, "Tab", { shiftKey: true });
    await flushAsync();

    expect(childIds(client, pageId)).toEqual([cat, a]);
    expect(childIds(client, cat)).toEqual([]);
    expect(childIds(client, a)).toEqual([b, c]);
  });

  it("Shift+Tab (direct) moves only the block", async () => {
    const client = await seedClient();
    writeDeviceSetting("treeEditMode", "direct");
    const pageId = await client.createObject({ presentAsMain: true, name: "Direct" });
    const cat = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "cat" }] });
    const a = await client.createObject({ parentId: cat, contentAst: [{ type: "text", text: "a" }] });
    const b = await client.createObject({ parentId: cat, contentAst: [{ type: "text", text: "b" }] });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container, 1); // block "a"
    keyDown(editor, "Tab", { shiftKey: true });
    await flushAsync();

    expect(childIds(client, pageId)).toEqual([cat, a]);
    expect(childIds(client, cat)).toEqual([b]);
    expect(childIds(client, a)).toEqual([]);
    writeDeviceSetting("treeEditMode", "logical");
  });
});
