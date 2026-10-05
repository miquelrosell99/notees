/**
 * Atomic node-link pill tests (edit mode): mentions render as
 * contenteditable="false" single units, identical in look to read mode;
 * arrows select the pill when the caret reaches it; Backspace/Delete with
 * the pill selected — or with the caret adjacent — deletes the whole link;
 * first click selects, second click places the caret, double-click opens.
 *
 * Same harness as capture.test.tsx (PageView over the in-process
 * WorkspaceClient + MemoryRelay, jsdom).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

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
 * Place a real (collapsed) caret at a PROSE offset — walks text runs and
 * pill elements the way the editor's prose mapping does.
 */
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
    const max = (textNode.textContent ?? "").length;
    range.setStart(textNode, Math.min(inner, max));
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

/** Seed a block "see Target again" holding a mention of the Target page. */
async function seeded() {
  const client = await seedClient();
  const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
  const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
  const blockId = await client.createObject({
    parentId: pageId,
    contentAst: [
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: targetId, text: "Target", linkId: "0192a000-0000-7000-8000-0000000000aa" },
      { type: "text", text: " again" },
    ],
  });
  return { client, pageId, targetId, blockId };
}

function pillOf(editor: HTMLElement): HTMLElement {
  const pill = editor.querySelector<HTMLElement>(".nt-atom");
  if (pill === null) throw new Error("no pill rendered");
  return pill;
}

const keyDown = (editor: HTMLElement, key: string, extra: Record<string, unknown> = {}) =>
  act(() => {
    fireEvent.keyDown(editor, { key, ...extra });
  });

describe("editor atoms", () => {
  it("renders the mention as a contenteditable=false pill, prose intact", async () => {
    const { client, pageId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    const pill = pillOf(editor);
    expect(pill.contentEditable).toBe("false");
    expect(pill.textContent).toBe("Target");
    expect(editor.textContent).toBe("see Target again");
  });

  it("ArrowRight onto the pill selects it; a second ArrowRight moves past", async () => {
    const { client, pageId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 4); // right before the pill
    keyDown(editor, "ArrowRight");
    expect(pillOf(editor).className).toContain("nt-atom--selected");

    keyDown(editor, "ArrowRight");
    expect(pillOf(editor).className).not.toContain("nt-atom--selected");
    // Caret landed right after the pill (prose offset 10).
    const selection = window.getSelection()!;
    expect(selection.isCollapsed).toBe(true);
  });

  it("ArrowLeft onto the pill selects it; a second ArrowLeft moves before", async () => {
    const { client, pageId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 10); // right after the pill
    keyDown(editor, "ArrowLeft");
    expect(pillOf(editor).className).toContain("nt-atom--selected");

    keyDown(editor, "ArrowLeft");
    expect(pillOf(editor).className).not.toContain("nt-atom--selected");
  });

  it("Backspace with the caret right after the pill deletes the whole link", async () => {
    const { client, pageId, blockId, targetId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 10);
    keyDown(editor, "Backspace");

    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see  again" }]);
    expect(editor.textContent).toBe("see  again");
    expect(targetId).not.toBeNull();
  });

  it("Delete with the caret right before the pill deletes the whole link", async () => {
    const { client, pageId, blockId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 4);
    keyDown(editor, "Delete");

    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see  again" }]);
  });

  it("Backspace with the pill selected deletes the whole link", async () => {
    const { client, pageId, blockId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 4);
    keyDown(editor, "ArrowRight"); // select
    keyDown(editor, "Backspace"); // delete selected

    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see  again" }]);
  });

  it("Delete with the pill selected deletes the whole link", async () => {
    const { client, pageId, blockId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 10);
    keyDown(editor, "ArrowLeft"); // select
    keyDown(editor, "Delete"); // delete selected

    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see  again" }]);
  });

  it("typing with the pill selected keeps the link and clears the selection", async () => {
    const { client, pageId, blockId, targetId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 4);
    keyDown(editor, "ArrowRight"); // select
    expect(pillOf(editor).className).toContain("nt-atom--selected");
    // A plain keystroke clears the flash; the browser inserts at the caret.
    keyDown(editor, "x");

    expect(pillOf(editor).className).not.toContain("nt-atom--selected");
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: targetId, text: "Target", linkId: "0192a000-0000-7000-8000-0000000000aa" },
      { type: "text", text: " again" },
    ]);
  });

  it("Enter with the pill selected clears the selection and keeps the link", async () => {
    const { client, pageId, blockId, targetId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 4);
    keyDown(editor, "ArrowRight");
    keyDown(editor, "Enter");

    expect(pillOf(editor).className).not.toContain("nt-atom--selected");
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId });
  });

  it("first click selects the pill, a second click clears it", async () => {
    const { client, pageId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    const pill = pillOf(editor);

    fireEvent.mouseDown(pill);
    fireEvent.click(pill);
    expect(pill.className).toContain("nt-atom--selected");

    fireEvent.mouseDown(pill);
    fireEvent.click(pill);
    expect(pill.className).not.toContain("nt-atom--selected");
  });

  it("double-click clears the selection and does not corrupt the block", async () => {
    const { client, pageId, blockId, targetId } = await seeded();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    const pill = pillOf(editor);

    fireEvent.mouseDown(pill);
    fireEvent.click(pill);
    fireEvent.doubleClick(pill);

    expect(pill.className).not.toContain("nt-atom--selected");
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId });
  });

  it("arrows walk through consecutive pills in both directions", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const t1 = await client.createObject({ presentAsMain: true, name: "One" });
    const t2 = await client.createObject({ presentAsMain: true, name: "Two" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "mention", targetNodeId: t1, text: "One", linkId: "0192a000-0000-7000-8000-0000000000b1" },
        { type: "mention", targetNodeId: t2, text: "Two", linkId: "0192a000-0000-7000-8000-0000000000b2" },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    const pills = () =>
      Array.from(editor.querySelectorAll<HTMLElement>(".nt-atom")).map((p) =>
        p.className.includes("nt-atom--selected"),
      );

    setProseCaret(editor, 0);
    keyDown(editor, "ArrowRight");
    expect(pills()).toEqual([true, false]);
    keyDown(editor, "ArrowRight"); // off the first pill (caret at its end)
    expect(pills()).toEqual([false, false]);
    keyDown(editor, "ArrowRight"); // onto the second pill
    expect(pills()).toEqual([false, true]);
    keyDown(editor, "ArrowRight"); // off the second pill
    expect(pills()).toEqual([false, false]);

    setProseCaret(editor, 6);
    keyDown(editor, "ArrowLeft");
    expect(pills()).toEqual([false, true]);
    keyDown(editor, "ArrowLeft"); // off the second pill (caret at its start)
    expect(pills()).toEqual([false, false]);
    keyDown(editor, "ArrowLeft"); // onto the first pill
    expect(pills()).toEqual([true, false]);
  });
});

/** Seed a block "this is <chip:task> work" (the chip references a live class). */
async function seededChip() {
  const client = await seedClient();
  const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
  const classId = await client.createClass("task");
  const blockId = await client.createObject({
    parentId: pageId,
    contentAst: [
      { type: "text", text: "this is " },
      { type: "class_chip", classId },
      { type: "text", text: " work" },
    ],
  });
  return { client, pageId, classId, blockId };
}

function chipPillOf(editor: HTMLElement): HTMLElement {
  const pill = editor.querySelector<HTMLElement>(".nt-atom--chip");
  if (pill === null) throw new Error("no class chip pill rendered");
  return pill;
}

describe("editor atoms — class chips", () => {
  it("renders the chip as a contenteditable=false pill with the resolved class name", async () => {
    const { client, pageId } = await seededChip();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    const pill = chipPillOf(editor);
    expect(pill.contentEditable).toBe("false");
    // v1 parity hook: the inline-class mark wore a wavy underline.
    expect(pill.className).toContain("nt-atom--chip");
    expect(pill.textContent).toBe("task");
    // The pill text rides the prose projection (one coordinate system).
    expect(editor.textContent).toBe("this is task work");
  });

  it("typing after the chip preserves it (the issue #2 edit-mode drop)", async () => {
    const { client, pageId, blockId, classId } = await seededChip();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    // Emulate the browser appending text at the end (the pill stays a unit).
    editor.appendChild(document.createTextNode("!"));
    fireEvent.input(editor);
    fireEvent.blur(editor);
    await act(async () => {});

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "this is " },
      { type: "class_chip", classId },
      { type: "text", text: " work!" },
    ]);
  });

  it("typing before the chip preserves it", async () => {
    const { client, pageId, blockId, classId } = await seededChip();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    editor.insertBefore(document.createTextNode("my "), editor.firstChild);
    fireEvent.input(editor);
    fireEvent.blur(editor);
    await act(async () => {});

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "my this is " },
      { type: "class_chip", classId },
      { type: "text", text: " work" },
    ]);
  });

  it("replacing text across the whole chip preserves the chip as an atom", async () => {
    const { client, pageId, blockId, classId } = await seededChip();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    // The draft drops the chip's label ("this is  work" — the pill text is
    // gone): the chip must NOT silently flatten away; it rides through as
    // the atomic token it is (its label re-resolves at render).
    editor.textContent = "this is  work";
    fireEvent.input(editor);
    fireEvent.blur(editor);
    await act(async () => {});

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "this is " },
      { type: "class_chip", classId },
      { type: "text", text: " work" },
    ]);
  });

  it("Backspace with the caret right after the chip deletes the whole chip", async () => {
    const { client, pageId, blockId } = await seededChip();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 12); // right after "task"
    keyDown(editor, "Backspace");

    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "this is  work" }]);
  });

  it("ArrowRight onto the chip selects it as one unit", async () => {
    const { client, pageId } = await seededChip();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);

    setProseCaret(editor, 8); // right before the chip
    keyDown(editor, "ArrowRight");
    expect(chipPillOf(editor).className).toContain("nt-atom--selected");
  });

  it("an unresolvable chip (zero prose) survives an edit in the block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const missing = "0192a000-0000-7000-8000-00000000beef";
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "keep " },
        { type: "class_chip", classId: missing },
        { type: "text", text: " typing" },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    // Nothing renders for the dead chip (consistent: zero prose).
    expect(editor.querySelector(".nt-atom--chip")).toBeNull();
    expect(editor.textContent).toBe("keep  typing");

    editor.appendChild(document.createTextNode("!"));
    fireEvent.input(editor);
    fireEvent.blur(editor);
    await act(async () => {});

    // The dead chip token is NOT silently flattened away by the edit.
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "keep " },
      { type: "class_chip", classId: missing },
      { type: "text", text: " typing!" },
    ]);
  });
});
