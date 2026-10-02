/**
 * Marks editing tests: structural edit application (applyTextEdit) and the
 * mark commands (applyMarkToRange / removeMarkFromRange, plus the editor
 * wiring: Ctrl/Cmd shortcuts, the floating formatting bar, and the `**`
 * selection shortcut). Editor tests run PageView over the in-process
 * WorkspaceClient + MemoryRelay (jsdom), same harness as
 * outliner-editor.test.tsx.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { proseFromAst } from "../src/editor/prose.js";
import { applyTextEdit } from "../src/editor/edit-apply.js";
import { applyMarkToRange, marksOnRange, removeMarkFromRange } from "../src/editor/marks.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const TARGET = "0192a000-0000-7000-8000-000000000099";

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

/** Enter edit mode on the first block and return its editor element. */
function clickIntoBlock(container: HTMLElement): HTMLElement {
  const content = container.querySelector<HTMLElement>(".nt-block-content");
  if (content === null) throw new Error("no .nt-block-content");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/**
 * Set a prose-offset selection inside the editor and fire selectionchange.
 * The editable DOM holds one text node per token (and atomic pill
 * elements), so prose offsets must be walked, not applied to firstChild.
 */
function selectRange(editor: HTMLElement, start: number, end: number): void {
  const locate = (offset: number): { node: Node; offset: number } => {
    let acc = 0;
    for (const child of Array.from(editor.childNodes)) {
      const len = child.textContent?.length ?? 0;
      if (acc + len >= offset) {
        const inner = Math.max(0, offset - acc);
        if (child instanceof Text) return { node: child, offset: inner };
        const text = child.firstChild;
        if (text !== null) return { node: text, offset: Math.min(inner, (text.textContent ?? "").length) };
        return { node: editor, offset: 0 };
      }
      acc += len;
    }
    const last = editor.lastChild;
    if (last !== null && last instanceof Text) {
      return { node: last, offset: (last.textContent ?? "").length };
    }
    return { node: editor, offset: 0 };
  };
  const range = document.createRange();
  const s = locate(start);
  const e = locate(end);
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  const selection = window.getSelection();
  if (selection === null) throw new Error("no selection");
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

describe("structural edit application", () => {
  it("keeps untouched runs intact when editing the plain run next to a marked run", () => {
    const previous = [
      { type: "text", text: "hello ", marks: ["bold"] },
      { type: "text", text: "world" },
    ];
    const next = applyTextEdit(previous, "hello world!");
    expect(next).toEqual([
      { type: "text", text: "hello ", marks: ["bold"] },
      { type: "text", text: "world!" },
    ]);
    // Identity: the untouched bold run object is reused as-is.
    expect(next[0]).toBe(previous[0]);
    expect(proseFromAst(next)).toBe("hello world!");
  });

  it("typing at the edge of a single marked run extends it (marks survive edits)", () => {
    const previous = [{ type: "text", text: "hello", marks: ["bold"] }];
    expect(applyTextEdit(previous, "hello world")).toEqual([
      { type: "text", text: "hello world", marks: ["bold"] },
    ]);
    // Typing inside the run keeps one bold run.
    expect(applyTextEdit(previous, "heXXo")).toEqual([
      { type: "text", text: "heXXo", marks: ["bold"] },
    ]);
  });

  it("hard_break survives edits on both sides", () => {
    const previous = [{ type: "text", text: "a" }, { type: "hard_break" }, { type: "text", text: "b" }];
    expect(applyTextEdit(previous, "Xa\nb")).toEqual([
      { type: "text", text: "Xa" },
      { type: "hard_break" },
      { type: "text", text: "b" },
    ]);
    expect(applyTextEdit(previous, "a\nb!")).toEqual([
      { type: "text", text: "a" },
      { type: "hard_break" },
      { type: "text", text: "b!" },
    ]);
  });

  it("mention token survives an edit before it (captured text may go stale)", () => {
    const mention = { type: "mention", targetNodeId: TARGET, text: "Target" };
    const previous = [{ type: "text", text: "see " }, mention];
    const next = applyTextEdit(previous, "see the Target");
    expect(next).toEqual([
      { type: "text", text: "see the " },
      { type: "mention", targetNodeId: TARGET, text: "Target" },
    ]);
    expect(next[1]).toBe(mention);
  });

  it("a change spanning a mention flattens only the covered span", () => {
    const previous = [
      { type: "text", text: "a " },
      { type: "mention", targetNodeId: TARGET, text: "M" },
      { type: "text", text: " z", marks: ["bold"] },
    ];
    const next = applyTextEdit(previous, "a X z");
    // The mention is flattened to plain text; the marked tail run survives.
    expect(next).toEqual([
      { type: "text", text: "a X" },
      { type: "text", text: " z", marks: ["bold"] },
    ]);
    expect(proseFromAst(next)).toBe("a X z");
  });
});

describe("mark range operations", () => {
  it("splits boundary runs and marks exactly the covered range", () => {
    const ast = [
      { type: "text", text: "hello ", marks: ["bold"] },
      { type: "text", text: "world", marks: ["italic"] },
    ];
    // Cover "lo wor" (3..9): spans both runs.
    expect(applyMarkToRange(ast, 3, 9, "bold")).toEqual([
      { type: "text", text: "hello ", marks: ["bold"] },
      { type: "text", text: "wor", marks: ["bold", "italic"] },
      { type: "text", text: "ld", marks: ["italic"] },
    ]);
  });

  it("removeMark merges the split runs back to the original shape", () => {
    const ast = [
      { type: "text", text: "hello ", marks: ["bold"] },
      { type: "text", text: "world", marks: ["italic"] },
    ];
    // Apply+remove over a range that started mark-free round-trips exactly.
    const marked = applyMarkToRange(ast, 6, 9, "bold");
    expect(removeMarkFromRange(marked, 6, 9, "bold")).toEqual(ast);
    // Removing over the already-bold prefix leaves the rest untouched.
    expect(removeMarkFromRange(ast, 0, 6, "bold")).toEqual([
      { type: "text", text: "hello " },
      { type: "text", text: "world", marks: ["italic"] },
    ]);
  });

  it("marksOnRange intersects the covered runs for toggle/active state", () => {
    const ast = [
      { type: "text", text: "hello ", marks: ["bold"] },
      { type: "text", text: "world", marks: ["italic"] },
    ];
    expect([...marksOnRange(ast, 0, 6)].sort()).toEqual(["bold"]);
    expect([...marksOnRange(ast, 0, 11)].sort()).toEqual([]);
    expect(marksOnRange(ast, 4, 4).size).toBe(0);
  });
});

describe("marks editing in the editor", () => {
  it("Ctrl+B bolds the selection; read mode renders <strong> over exactly that text", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Marks" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello world" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectRange(editor, 0, 5);
    fireEvent.keyDown(editor, { key: "b", ctrlKey: true });

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "hello", marks: ["bold"] },
      { type: "text", text: " world" },
    ]);

    fireEvent.blur(editor);
    const content = container.querySelector(".nt-block-content")!;
    expect(content.textContent).toBe("hello world");
    // <strong> covers exactly "hello"; " world" stays unmarked.
    expect(content.querySelector("strong")!.textContent).toBe("hello");
  });

  it("a selection spanning two runs splits them correctly; Ctrl+B again merges back", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Split" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "hello " },
        { type: "text", text: "world", marks: ["italic"] },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectRange(editor, 3, 9); // "lo wor" — spans both runs
    fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "hel" },
      { type: "text", text: "lo ", marks: ["bold"] },
      { type: "text", text: "wor", marks: ["bold", "italic"] },
      { type: "text", text: "ld", marks: ["italic"] },
    ]);

    // Read mode: <strong> covers exactly "lo " and "wor".
    fireEvent.blur(editor);
    const strongs = [...container.querySelectorAll("strong")].map((el) => el.textContent);
    expect(strongs).toEqual(["lo ", "wor"]);

    // Ctrl+B over the new bold range removes it; runs merge back to the seed.
    const editor2 = clickIntoBlock(container);
    selectRange(editor2, 3, 9);
    fireEvent.keyDown(editor2, { key: "b", ctrlKey: true });
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "hello " },
      { type: "text", text: "world", marks: ["italic"] },
    ]);
  });

  it("Ctrl+I and Ctrl+Shift+X apply italic and strike via shortcuts", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Keys" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectRange(editor, 0, 5);
    fireEvent.keyDown(editor, { key: "i", metaKey: true });
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "hello", marks: ["italic"] },
    ]);

    selectRange(editor, 0, 5);
    fireEvent.keyDown(editor, { key: "X", ctrlKey: true, shiftKey: true });
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "hello", marks: ["italic", "strike"] },
    ]);

    fireEvent.blur(editor);
    expect(container.querySelector("s")!.textContent).toBe("hello");
  });

  it("the floating toolbar toggles marks and reflects active state", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Toolbar" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello world" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectRange(editor, 0, 5);

    // The toolbar appears after the archived 150 ms show debounce — poll for
    // it instead of sleeping a fixed margin (flaky under suite load).
    const toolbar = await screen.findByRole("toolbar", { name: "Text formatting" }, { timeout: 3000 });
    const bold = toolbar.querySelector<HTMLButtonElement>('button[title="Bold (Ctrl+B)"]')!;
    expect(bold.getAttribute("aria-pressed")).toBe("false");

    // mousedown must not blur the editor (the click would unmount it).
    fireEvent.mouseDown(bold);
    expect(document.activeElement).toBe(editor);
    fireEvent.click(bold);
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "hello", marks: ["bold"] },
      { type: "text", text: " world" },
    ]);
    expect(bold.getAttribute("aria-pressed")).toBe("true");

    // Clicking the active button removes the mark again.
    fireEvent.click(bold);
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "hello world" }]);
    expect(bold.getAttribute("aria-pressed")).toBe("false");
  });

  it("typing ** over a selection toggles bold without storing asterisks", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Stars" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello world" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectRange(editor, 6, 11); // "world"
    fireEvent.keyDown(editor, { key: "*" });
    fireEvent.keyDown(editor, { key: "*" });

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "hello " },
      { type: "text", text: "world", marks: ["bold"] },
    ]);
    expect(editor.textContent).toBe("hello world");
  });
});
