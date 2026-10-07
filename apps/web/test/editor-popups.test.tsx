/**
 * Editor chrome popup tests: the ported FloatingToolbar's slash TriggerPopup
 * (quote / task / hard-break / text / Add URL), the find & replace widget
 * over the block tree, and the LinkEditModal for NODE links (owner ruling:
 * the modal is node-only — opened via a mention's "Edit link…", mode set
 * Page/Block/Verb; external links navigate and never open it, and the slash
 * "Add URL" flow authors the external_link token directly). Same harness as
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
    // All slash commands (the breadth rows post-lockstep), Text first.
    const options = within(slashPopup()!).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "TextPlain text block",
      "QuoteFormat this block as a quote",
      "TaskConvert block to task (checkbox)",
      "Line breakInsert a hard line break",
      "Add URLAdd a URL link to external website",
      "QueryInsert a live query block",
      "DateLink to a daily page (e.g. /date feb 14)",
      "TemplateCreate from a template at the caret",
      "TableInsert a table — cells are blocks (e.g. /table 5)",
      "CodeConvert block to a code block (e.g. /code python)",
      "DividerInsert a horizontal rule",
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

  it("Add URL strips the trigger and authors the external_link token directly (no modal)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/");
    typeWithCaret(editor, "/url https://example.com");
    fireEvent.keyDown(editor, { key: "Enter" });

    // The node-link modal never opens — the token is authored at the caret.
    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "external_link", href: "https://example.com", text: "https://example.com" },
    ]);
    // Read mode renders it as a plain hyperlink (no chip chrome).
    fireEvent.blur(editor);
    const anchor = container.querySelector("a.nt-hyperlink");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe("https://example.com");
    expect(anchor!.classList.contains("nt-chip")).toBe(false);
  });

  it("Add URL with a non-URL query falls back to plain prose (no token, no modal)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "/");
    typeWithCaret(editor, "/url not a url");
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    // The sigil is stripped, the typed query falls back to plain prose.
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "url not a url" }]);
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

/**
 * Open the node-link modal through the honest UI seam: edit mode on a block
 * holding a mention, right-click the pill, "Edit link…".
 */
function openModalViaMention(container: HTMLElement): HTMLElement {
  const editor = clickIntoBlock(container);
  const pill = editor.querySelector<HTMLElement>("[data-atom-key]");
  if (pill === null) throw new Error("no mention pill in the editor");
  fireEvent.contextMenu(pill, { clientX: 12, clientY: 12 });
  const menu = document.body.querySelector<HTMLElement>(".context-menu");
  if (menu === null) throw new Error("node-link menu did not open");
  fireEvent.click(within(menu).getByText("Edit link…"));
  return screen.getByRole("dialog", { name: "Edit Link" });
}

describe("link edit modal (node links only)", () => {
  it("clicking an external-link hyperlink in read mode does NOT open the modal", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Links" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        { type: "external_link", href: "https://a.example", text: "Alpha" },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const anchor = container.querySelector("a.nt-hyperlink")!;
    expect(anchor.getAttribute("href")).toBe("https://a.example");
    // Owner ruling: a plain hyperlink click navigates — the LinkEditModal is
    // node-only and never opens for external links.
    fireEvent.click(anchor);
    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Edit Link Verb" })).toBeNull();
  });

  it("Cancel closes without touching the mention; the mode toggle offers Page/Block only", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Links" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Target" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // Edit link… opens the node-link modal with the destination prefilled.
    const dialog = openModalViaMention(container);
    expect(within(dialog).getByRole("button", { name: "Page target" }).textContent).toContain("Target");

    // The mode toggle offers Page / Block — URL is gone (the modal is
    // node-only; external links navigate and are authored directly).
    expect(within(dialog).getByRole("radio", { name: "Page" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Block" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio", { name: "URL" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "mention", targetNodeId: targetId, text: "Target" },
    ]);
  });

  it("renders the mode tab row and the field regions as distinct, ordered elements (no collapsed overlap)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Links" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Target" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const dialog = openModalViaMention(container);

    // The mode selector is a radiogroup row of two tabs (Page/Block — the
    // modal is node-only, no URL tab); the target field is a separate
    // labelled region below it. The regression this guards: the tab row
    // collapsing into the field label/control — so the tab, the section
    // label, and the control must be DISTINCT elements, the label must not
    // live inside the tab row, and the tab row must precede the field
    // region in document order.
    const group = within(dialog).getByRole("radiogroup");
    const pageTab = within(group).getByRole("radio", { name: "Page" });
    const blockTab = within(group).getByRole("radio", { name: "Block" });
    expect(new Set([pageTab, blockTab]).size).toBe(2);
    expect(within(group).queryByRole("radio", { name: "URL" })).toBeNull();

    const pageLabel = within(dialog).getByText("Page", { selector: ".link-edit-modal__label" });
    const targetTrigger = within(dialog).getByRole("button", { name: "Page target" });
    // Distinct elements, none nested in the tab row.
    expect(pageLabel).not.toBe(pageTab);
    expect(targetTrigger).not.toBe(pageTab);
    expect(group.contains(pageLabel)).toBe(false);
    expect(group.contains(targetTrigger)).toBe(false);
    // The tab row sits in its own section, above the target field section.
    const tabSection = group.closest(".link-edit-modal__section")!;
    const fieldSection = pageLabel.closest(".link-edit-modal__section")!;
    expect(tabSection).not.toBe(fieldSection);
    expect(
      tabSection.compareDocumentPosition(fieldSection) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Clicking the trigger opens the anchored dropdown (portaled to the
    // body, outside the modal subtree).
    fireEvent.click(targetTrigger);
    expect(screen.getByPlaceholderText("Search pages…")).toBeInTheDocument();

    // Dismissal rides the kit Modal: Escape (overlay stack) and backdrop
    // click both close; Cancel reopens nothing.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();

    openModalViaMention(container);
    fireEvent.click(document.querySelector(".modal-backdrop")!);
    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
  });

  it("Page mode: ONE target control — clicking opens the anchored picker; picking replaces the selection", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Links" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Target" }],
    });
    const otherId = await client.createObject({ presentAsMain: true, name: "Target Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const dialog = openModalViaMention(container);

    // ONE target control: a single SelectTrigger reading the current
    // selection — no separate always-expanded search field below it.
    const trigger = within(dialog).getByRole("button", { name: "Page target" });
    expect(trigger.textContent).toContain("Target");
    expect(within(dialog).queryByPlaceholderText("Search pages…")).toBeNull();

    // Clicking it opens the anchored picker dropdown (portaled to the body).
    fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Select node" });
    const search = within(picker).getByPlaceholderText("Search pages…") as HTMLInputElement;
    expect(search).not.toBeNull();

    // Search + pick: the dropdown closes and the control updates in place.
    fireEvent.change(search, { target: { value: "Target Page" } });
    fireEvent.click(within(picker).getByText("Target Page").closest("button")!);
    expect(screen.queryByRole("dialog", { name: "Select node" })).toBeNull();
    expect(trigger.textContent).toContain("Target Page");

    // Save retargets the mention to the picked page.
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toMatchObject({ type: "mention", targetNodeId: otherId });
  });
});
