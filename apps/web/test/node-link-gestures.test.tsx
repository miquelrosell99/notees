/**
 * Node-link gesture tests: typing `@` over a text selection and the
 * node-link right-click context menu.
 *
 * @-over-selection: the selected text is NOT replaced by the sigil — the
 * node picker opens with it as the search query; a pick replaces the
 * selection with the mention, Ctrl/Cmd+Enter keeps the text as a custom
 * label (displayText), Escape restores the selection.
 *
 * Context menu (edit mode, right-click a mention): Remove link keeps the
 * visible text, Delete link drops the token, Edit link… opens the
 * LinkEditModal to retarget the link and set/edit an optional custom label.
 *
 * Same harness as capture.test.tsx (PageView over the in-process
 * WorkspaceClient + MemoryRelay, jsdom).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeLinkMenuHost } from "../src/ui/components/NodeLinkContextMenu.js";
import { selectionOffsets } from "../src/editor/selection.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>).caretRangeFromPoint;
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

/** Set a non-collapsed selection (prose offsets) inside the editor. */
function selectProseRange(editor: HTMLElement, start: number, end: number): void {
  const node = editor.firstChild;
  if (node === null) throw new Error("editor has no text node");
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  if (selection === null) throw new Error("no selection");
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

// ── Node-picker popup helpers (same contract as capture.test.tsx) ────────────

const picker = () => screen.queryByRole("dialog", { name: "Select node" });

function searchBox(): HTMLElement {
  const panel = picker();
  if (panel === null) throw new Error("picker is not open");
  return within(panel).getByRole("textbox");
}

function pickerRows(): HTMLElement[] {
  const panel = picker();
  if (panel === null) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(".node-result-item"));
}

/**
 * Right-click hit test: caretRangeFromPoint answers `offset` (a PROSE
 * offset) in the editor — walks text runs and atomic pill elements the same
 * way the editor's prose mapping does.
 */
function mockCaretAt(editor: HTMLElement, proseOffset: number): void {
  const doc = document as Document & { caretRangeFromPoint?: unknown };
  doc.caretRangeFromPoint = () => {
    const range = document.createRange();
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
    if (target === null) {
      range.selectNodeContents(editor);
      range.collapse(false);
      return range;
    }
    const textNode =
      target instanceof HTMLElement ? (target.firstChild ?? target) : target;
    const max = (textNode.textContent ?? "").length;
    range.setStart(textNode, Math.min(inner, max));
    range.setEnd(textNode, Math.min(inner, max));
    return range;
  };
}

/** The open node-link context menu (portaled). */
const linkMenu = () => document.body.querySelector<HTMLElement>(".context-menu");

function menuItem(label: string): HTMLElement {
  const menu = linkMenu();
  if (menu === null) throw new Error("context menu is not open");
  const item = within(menu)
    .getAllByRole("menuitem")
    .find((el) => el.textContent === label);
  if (item === undefined) throw new Error(`menu item "${label}" not found`);
  return item;
}

describe("capture: @ over a selection", () => {
  it("opens the picker prefilled with the selected text; the draft is untouched", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "see Tar now" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectProseRange(editor, 4, 7); // "Tar"
    fireEvent.keyDown(editor, { key: "@" });

    // The picker opened with the selected text as its query…
    expect(picker()).not.toBeNull();
    expect(searchBox()).toHaveValue("Tar");
    expect(within(picker()!).getByText("Target")).toBeInTheDocument();
    // …and the selection was NOT replaced by the sigil (no "@" in the draft).
    expect(editor.textContent).toBe("see Tar now");
    expect(client.listPages().map((p) => p.id)).toContain(targetId);
  });

  it("Enter replaces the selected text with the mention (target name resolved)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "see Tar now" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectProseRange(editor, 4, 7);
    fireEvent.keyDown(editor, { key: "@" });
    fireEvent.keyDown(searchBox(), { key: "Enter" });

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toHaveLength(3);
    expect(ast[0]).toEqual({ type: "text", text: "see " });
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId, text: "Target" });
    expect((ast[1] as { displayText?: string }).displayText).toBeUndefined();
    expect(ast[2]).toEqual({ type: "text", text: " now" });
    expect(editor.textContent).toBe("see Target now");
    expect(picker()).toBeNull();
  });

  it("Ctrl+Enter inserts the link with the selected text as a custom label", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "see Tar now" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectProseRange(editor, 4, 7);
    fireEvent.keyDown(editor, { key: "@" });
    fireEvent.keyDown(searchBox(), { key: "Enter", ctrlKey: true });

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[1]).toMatchObject({
      type: "mention",
      targetNodeId: targetId,
      text: "Tar",
      displayText: "Tar",
    });
    expect(editor.textContent).toBe("see Tar now");
  });

  it("Cmd+Enter is treated the same", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "see Tar now" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectProseRange(editor, 4, 7);
    fireEvent.keyDown(editor, { key: "@" });
    fireEvent.keyDown(searchBox(), { key: "Enter", metaKey: true });

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId, displayText: "Tar" });
  });

  it("Escape closes the picker and restores the selection", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "see Tar now" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectProseRange(editor, 4, 7);
    fireEvent.keyDown(editor, { key: "@" });
    expect(picker()).not.toBeNull();
    fireEvent.keyDown(searchBox(), { key: "Escape" });

    expect(picker()).toBeNull();
    expect(editor.textContent).toBe("see Tar now");
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see Tar now" }]);
    // The original selection is back.
    expect(selectionOffsets(editor)).toEqual({ start: 4, end: 7 });
  });

  it("the create row replaces the selection with a link to the new page", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "see zzz now" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectProseRange(editor, 4, 7);
    fireEvent.keyDown(editor, { key: "@" });
    // Only the create row matches "zzz".
    expect(pickerRows()).toHaveLength(1);
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});

    const created = client.listPages().filter((p) => p.id !== pageId);
    expect(created).toHaveLength(1);
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toEqual({ type: "text", text: "see " });
    expect(ast[1]).toMatchObject({
      type: "mention",
      targetNodeId: created[0]!.id,
      text: "zzz",
    });
    expect(editor.textContent).toBe("see zzz now");
  });

  it("without a word boundary the default runs (no picker)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "alpha beta" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectProseRange(editor, 1, 5); // inside "alpha" — no boundary before it
    fireEvent.keyDown(editor, { key: "@" });

    expect(picker()).toBeNull();
  });
});

describe("node-link context menu", () => {
  async function seedLinkedBlock(displayText?: string) {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const otherId = await client.createObject({ nodeType: "page", name: "Elsewhere" });
    const mention: Record<string, unknown> = {
      type: "mention",
      targetNodeId: targetId,
      text: "Target",
      linkId: "0192a000-0000-7000-8000-0000000000aa",
    };
    if (displayText !== undefined) mention.displayText = displayText;
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        mention as ContentAst[number],
        { type: "text", text: " again" },
      ],
    });
    return { client, pageId, targetId, otherId, blockId };
  }

  function openMenu(container: HTMLElement, proseOffset = 6): HTMLElement {
    const editor = clickIntoBlock(container);
    mockCaretAt(editor, proseOffset); // inside "Target" ([4, 10))
    fireEvent.contextMenu(editor, { clientX: 12, clientY: 12 });
    const menu = linkMenu();
    if (menu === null) throw new Error("context menu did not open");
    return menu;
  }

  it("right-click on a mention opens the menu (open / edit / remove / delete)", async () => {
    const { client, pageId } = await seedLinkedBlock();
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const menu = openMenu(container);
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual([
      "Open page",
      "Open in sidebar",
      "Edit link…",
      "Remove link",
      "Delete link",
    ]);
  });

  it("right-click on plain text opens nothing", async () => {
    const { client, pageId } = await seedLinkedBlock();
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    mockCaretAt(editor, 2); // inside "see "
    fireEvent.contextMenu(editor, { clientX: 4, clientY: 4 });
    expect(linkMenu()).toBeNull();
  });

  it("Remove link keeps the visible text (mention → text run)", async () => {
    const { client, pageId, blockId } = await seedLinkedBlock();
    const { container } = render(<PageView client={client} pageId={pageId} />);

    openMenu(container);
    fireEvent.click(menuItem("Remove link"));

    expect(linkMenu()).toBeNull();
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see Target again" }]);
  });

  it("Remove link keeps a custom label when one is set", async () => {
    const { client, pageId, blockId } = await seedLinkedBlock("the Republic");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    openMenu(container);
    fireEvent.click(menuItem("Remove link"));

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "see the Republic again" },
    ]);
  });

  it("Delete link removes the mention from the block entirely", async () => {
    const { client, pageId, blockId } = await seedLinkedBlock();
    const { container } = render(<PageView client={client} pageId={pageId} />);

    openMenu(container);
    fireEvent.click(menuItem("Delete link"));

    expect(linkMenu()).toBeNull();
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see  again" }]);
  });

  it("Edit link… retargets the mention and sets a custom label", async () => {
    const { client, pageId, blockId, otherId } = await seedLinkedBlock();
    const { container } = render(<PageView client={client} pageId={pageId} />);

    openMenu(container);
    fireEvent.click(menuItem("Edit link…"));

    // The page-level LinkEditModal opened in node mode, destination prefilled.
    const modal = document.body.querySelector<HTMLElement>(".link-edit-modal");
    if (modal === null) throw new Error("link edit modal did not open");
    expect(modal.querySelector(".link-edit-modal__target")?.textContent).toBe("Target");

    // Pick a different destination in the embedded picker.
    const pickerInput = modal.querySelector<HTMLElement>(".node-selector__search");
    if (pickerInput === null) throw new Error("no picker in the modal");
    fireEvent.change(pickerInput, { target: { value: "Else" } });
    const row = modal.querySelector<HTMLElement>(".node-result-item");
    if (row === null) throw new Error("no picker rows in the modal");
    fireEvent.click(row);

    // Set the custom label and save.
    const labelInput = modal.querySelector<HTMLInputElement>("#link-label-input");
    if (labelInput === null) throw new Error("no label input in the modal");
    fireEvent.change(labelInput, { target: { value: "that page" } });
    const save = Array.from(modal.querySelectorAll<HTMLButtonElement>("button.btn--primary")).find(
      (b) => b.textContent === "Save",
    );
    if (save === undefined) throw new Error("no Save button in the modal");
    fireEvent.click(save);

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    const mention = ast[1] as { targetNodeId: string; text: string; displayText?: string; linkId?: string };
    expect(mention.targetNodeId).toBe(otherId);
    expect(mention.text).toBe("that page");
    expect(mention.displayText).toBe("that page");
    // A retarget mints a fresh linkId.
    expect(mention.linkId).toMatch(UUID_RE);
    expect(mention.linkId).not.toBe("0192a000-0000-7000-8000-0000000000aa");
  });

  it("Edit link… with the label cleared removes the custom label (target kept, linkId kept)", async () => {
    const { client, pageId, blockId, targetId } = await seedLinkedBlock("the Republic");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    openMenu(container);
    fireEvent.click(menuItem("Edit link…"));

    const modal = document.body.querySelector<HTMLElement>(".link-edit-modal");
    if (modal === null) throw new Error("link edit modal did not open");
    const labelInput = modal.querySelector<HTMLInputElement>("#link-label-input");
    if (labelInput === null) throw new Error("no label input in the modal");
    // The current custom label is prefilled; clearing it removes the override.
    expect(labelInput.value).toBe("the Republic");
    fireEvent.change(labelInput, { target: { value: "" } });
    const save = Array.from(modal.querySelectorAll<HTMLButtonElement>("button.btn--primary")).find(
      (b) => b.textContent === "Save",
    );
    if (save === undefined) throw new Error("no Save button in the modal");
    fireEvent.click(save);

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[1]).toEqual({
      type: "mention",
      targetNodeId: targetId,
      text: "Target",
      linkId: "0192a000-0000-7000-8000-0000000000aa",
    });
  });
});

describe("node-link context menu (read mode)", () => {
  async function seededReadonly() {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: targetId, text: "Target", linkId: "0192a000-0000-7000-8000-0000000000aa" },
        { type: "text", text: " again" },
      ],
    });
    return { client, pageId, targetId, blockId };
  }

  /** Render under the app-shell host, exactly like App.tsx mounts it. */
  function renderHosted(client: WorkspaceClient, pageId: string) {
    return render(
      <NodeLinkMenuHost client={client} openNode={() => {}} openInSidebar={() => {}}>
        <PageView client={client} pageId={pageId} />
      </NodeLinkMenuHost>,
    );
  }

  function openReadMenu(container: HTMLElement): HTMLElement {
    const link = container.querySelector<HTMLElement>("button.nt-link");
    if (link === null) throw new Error("no read-mode mention link rendered");
    fireEvent.contextMenu(link, { clientX: 20, clientY: 20 });
    const menu = linkMenu();
    if (menu === null) throw new Error("context menu did not open in read mode");
    return menu;
  }

  it("right-clicking the read-mode link opens the same menu", async () => {
    const { client, pageId } = await seededReadonly();
    const { container } = renderHosted(client, pageId);
    const menu = openReadMenu(container);
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual(["Open page", "Open in sidebar", "Edit link…", "Remove link", "Delete link"]);
  });

  it("Remove link unlinks in place (text survives)", async () => {
    const { client, pageId, blockId } = await seededReadonly();
    const { container } = renderHosted(client, pageId);
    openReadMenu(container);
    fireEvent.click(menuItem("Remove link"));
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see Target again" }]);
  });

  it("Delete link drops the mention from the block", async () => {
    const { client, pageId, blockId } = await seededReadonly();
    const { container } = renderHosted(client, pageId);
    openReadMenu(container);
    fireEvent.click(menuItem("Delete link"));
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "see  again" }]);
  });

  it("Edit link… opens the modal from read mode and retargets", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const otherId = await client.createObject({ nodeType: "page", name: "Elsewhere" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [
        { type: "mention", targetNodeId: targetId, text: "Target", linkId: "0192a000-0000-7000-8000-0000000000aa" },
      ],
    });
    const { container } = renderHosted(client, pageId);
    openReadMenu(container);
    fireEvent.click(menuItem("Edit link…"));

    const modal = document.body.querySelector<HTMLElement>(".link-edit-modal");
    if (modal === null) throw new Error("link edit modal did not open from read mode");
    const pickerInput = modal.querySelector<HTMLElement>(".node-selector__search");
    if (pickerInput === null) throw new Error("no picker in the modal");
    fireEvent.change(pickerInput, { target: { value: "Else" } });
    fireEvent.click(modal.querySelector<HTMLElement>(".node-result-item")!);
    const save = Array.from(modal.querySelectorAll<HTMLButtonElement>("button.btn--primary")).find(
      (b) => b.textContent === "Save",
    );
    if (save === undefined) throw new Error("no Save button in the modal");
    fireEvent.click(save);

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toMatchObject({ type: "mention", targetNodeId: otherId, text: "Elsewhere" });
  });
});
