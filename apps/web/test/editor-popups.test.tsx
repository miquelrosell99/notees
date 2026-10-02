/**
 * Editor chrome popup tests: the ported FloatingToolbar's slash TriggerPopup
 * (quote / task / hard-break / text / Add URL), the find & replace widget
 * over the block tree, and the LinkEditModal for external_link tokens (both
 * the slash insert flow and read-mode chip clicks). Same harness as
 * capture.test.tsx: PageView over the in-process WorkspaceClient +
 * MemoryRelay (jsdom).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";
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
  vi.useRealTimers();
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

const slashPopup = () => screen.queryByRole("listbox", { name: "/ Commands" });

describe("slash trigger popup", () => {
  it("typing / at the block start opens the command list; Text strips the trigger", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/");
    expect(slashPopup()).not.toBeNull();
    // All five block-type actions, Text first.
    const options = within(slashPopup()!).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "TextPlain text block",
      "QuoteFormat this block as a quote",
      "TaskConvert block to task (checkbox)",
      "Line breakInsert a hard line break",
      "Add URLAdd a URL link to external website",
    ]);

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(slashPopup()).toBeNull();
    expect(editor.textContent).toBe("");
    expect(client.getNode(blockId)?.contentAst).toEqual([]);
  });

  it("filters by the typed query and ArrowDown moves the highlight", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/");
    typeWithCaret(editor, "/break");
    const options = within(slashPopup()!).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Line breakInsert a hard line break"]);

    // Back to the full list, then ArrowDown highlights the second row.
    typeWithCaret(editor, "/");
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    const rows = within(slashPopup()!).getAllByRole("option");
    expect(rows[0]?.getAttribute("aria-selected")).toBe("false");
    expect(rows[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(slashPopup()).toBeNull();

    // Leave the block cleanly: flush the pending debounced draft.
    fireEvent.blur(editor);
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "/" }]);
  });

  it("Quote wraps the block's inline tokens in a quote token", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/hello", 1);
    typeWithCaret(editor, "/quote hello", 7);
    expect(within(slashPopup()!).getByText("Quote")).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "quote", children: [{ type: "text", text: "hello" }] },
    ]);
    expect(editor.textContent).toBe("hello");
  });

  it("Task assigns the task system class (the grammar's checkbox) and strips the trigger", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/");
    typeWithCaret(editor, "/ch");
    fireEvent.keyDown(editor, { key: "Enter" });
    await act(async () => {});

    expect(client.getNode(blockId)?.classIds).toEqual([SYSTEM_CLASS_UUIDS.task]);
    expect(editor.textContent).toBe("");
  });

  it("Line break inserts a hard_break token and consumes the blank after the query", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "ab" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/ab", 1);
    typeWithCaret(editor, "/br ab", 4);
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "hard_break" },
      { type: "text", text: "ab" },
    ]);
    expect(editor.textContent).toBe("\nab");
  });

  it("Add URL strips the trigger and opens the LinkEditModal; Save inserts the external_link token", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/");
    typeWithCaret(editor, "/ur");
    fireEvent.keyDown(editor, { key: "Enter" });

    // Trigger stripped; the page-level modal opened (the editor stays mounted).
    expect(editor.textContent).toBe("");
    const dialog = screen.getByRole("dialog", { name: "Edit Link" });
    const urlInput = within(dialog).getByRole("textbox", { name: "URL" });
    fireEvent.change(urlInput, { target: { value: "https://example.com" } });
    fireEvent.change(within(dialog).getByLabelText("Display Label"), {
      target: { value: "Example" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "external_link", href: "https://example.com", text: "Example" },
    ]);
    // Read mode renders the chip as an external link.
    fireEvent.blur(editor);
    const anchor = container.querySelector("a.nt-external-link");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe("https://example.com");
    expect(anchor!.textContent).toBe("Example");
  });
});

describe("find & replace widget", () => {
  it("Ctrl+Shift+F opens the widget; searching highlights matching blocks; replace and replace-all write through the client", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Find" });
    const firstId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello world" }],
    });
    const secondId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "say hello twice hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    fireEvent.keyDown(document, { key: "f", ctrlKey: true, shiftKey: true });
    const widget = screen.getByRole("toolbar", { name: "Find and replace" });

    fireEvent.change(within(widget).getByLabelText("Find"), { target: { value: "hello" } });
    expect(within(widget).getByText("1/3")).toBeInTheDocument();
    // Both matching blocks carry the hit class; the current match is the first.
    expect(container.querySelectorAll(".find-replace-hit")).toHaveLength(2);
    expect(
      container.querySelector(`[data-block-id="${firstId}"]`)!.classList.contains("find-replace-current"),
    ).toBe(true);

    // Next moves the current highlight to the second block.
    fireEvent.click(within(widget).getByRole("button", { name: "Next match" }));
    expect(within(widget).getByText("2/3")).toBeInTheDocument();
    expect(
      container.querySelector(`[data-block-id="${secondId}"]`)!.classList.contains("find-replace-current"),
    ).toBe(true);

    // Expand replace, replace the current match.
    fireEvent.click(within(widget).getByRole("button", { name: "Show replace" }));
    fireEvent.change(within(widget).getByLabelText("Replace"), { target: { value: "hi" } });
    fireEvent.click(within(widget).getByRole("button", { name: "Replace" }));
    expect(client.getNode(secondId)?.contentAst).toEqual([
      { type: "text", text: "say hi twice hello" },
    ]);
    expect(within(widget).getByText("2/2")).toBeInTheDocument();

    // Replace All clears the remaining matches.
    fireEvent.click(within(widget).getByRole("button", { name: "Replace All" }));
    expect(client.getNode(firstId)?.contentAst).toEqual([{ type: "text", text: "hi world" }]);
    expect(client.getNode(secondId)?.contentAst).toEqual([
      { type: "text", text: "say hi twice hi" },
    ]);
    expect(within(widget).getByText("0/0")).toBeInTheDocument();
    expect(container.querySelectorAll(".find-replace-hit")).toHaveLength(0);

    // Escape closes and clears the highlight classes.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "Find and replace" })).toBeNull();
    expect(container.querySelectorAll(".find-replace-hit, .find-replace-current")).toHaveLength(0);
  });

  it("match case narrows the search", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Case" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Hello hello" }],
    });
    render(<PageView client={client} pageId={pageId} />);

    fireEvent.keyDown(document, { key: "f", ctrlKey: true, shiftKey: true });
    const widget = screen.getByRole("toolbar", { name: "Find and replace" });
    fireEvent.change(within(widget).getByLabelText("Find"), { target: { value: "hello" } });
    expect(within(widget).getByText("1/2")).toBeInTheDocument();
    fireEvent.click(within(widget).getByRole("button", { name: "Match case" }));
    expect(within(widget).getByText("1/1")).toBeInTheDocument();
  });
});

describe("link edit modal (external_link tokens)", () => {
  it("clicking an external-link chip in read mode opens the modal; Save rewrites the token", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Links" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        { type: "external_link", href: "https://a.example", text: "Alpha" },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const anchor = container.querySelector("a.nt-external-link")!;
    expect(anchor.getAttribute("href")).toBe("https://a.example");
    fireEvent.click(anchor);

    const dialog = screen.getByRole("dialog", { name: "Edit Link" });
    const urlInput = within(dialog).getByRole("textbox", { name: "URL" }) as HTMLInputElement;
    expect(urlInput.value).toBe("https://a.example");
    const labelInput = within(dialog).getByLabelText("Display Label") as HTMLInputElement;
    expect(labelInput.value).toBe("Alpha");

    fireEvent.change(urlInput, { target: { value: "https://b.example" } });
    fireEvent.change(labelInput, { target: { value: "Beta" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toEqual([
      { type: "text", text: "see " },
      { type: "external_link", href: "https://b.example", text: "Beta" },
    ]);
  });

  it("Cancel closes without touching the token; the mode toggle switches to a live node picker", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Links" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "external_link", href: "https://a.example", text: "Alpha" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    fireEvent.click(container.querySelector("a.nt-external-link")!);
    const dialog = screen.getByRole("dialog", { name: "Edit Link" });

    // The Page/Block modes render the archived toggle; the target section
    // hosts the real node picker (an external link has no node destination).
    fireEvent.click(within(dialog).getByRole("radio", { name: "Page" }));
    expect(within(dialog).getByText("No target selected")).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText("Search pages…")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: "URL" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "external_link", href: "https://a.example", text: "Alpha" },
    ]);
  });
});
