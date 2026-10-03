/**
 * Capture gesture tests: `@` mention insertion (node-picker popup), `#` tag
 * assign/create, `+` class picker (assign/create), the verb-on-selection
 * typed-link popover, and candidateSpans. Editor tests run PageView over the
 * in-process WorkspaceClient + MemoryRelay (jsdom), same harness as
 * outliner-editor.test.tsx.
 *
 * Popup contract (v1 parity): typing the trigger char opens the ported
 * NodeSelector popup anchored at the caret with its OWN search input (focus
 * moves there); the trigger char stays in the block as a placeholder. Enter
 * on a result row (or the create row) commits; Escape / click-outside keeps
 * the trigger char as plain text and hands focus back to the block.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { proseFromAst } from "../src/editor/prose.js";
import { computeCandidateSpans, withCandidateSpans } from "../src/editor/capture.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  // jsdom lacks ResizeObserver; Tabs.List (the picker's scope tabs) uses it
  // for the active indicator.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
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

/** Set a non-collapsed selection (prose offsets) inside the editor. */
function selectRange(editor: HTMLElement, start: number, end: number): void {
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

// ── Node-picker popup helpers ──────────────────────────────────────────────

/** The open @/#/+ picker (portaled dialog). */
const picker = () => screen.queryByRole("dialog", { name: "Select node" });

/** The picker's own search input (focus lands here when the popup opens). */
function searchBox(): HTMLElement {
  const panel = picker();
  if (panel === null) throw new Error("picker is not open");
  return within(panel).getByRole("textbox");
}

/** Type the popup query (the block only holds the trigger placeholder). */
function typeInPicker(text: string): void {
  fireEvent.change(searchBox(), { target: { value: text } });
}

/** All result/create rows of the open picker. */
function pickerRows(): HTMLElement[] {
  const panel = picker();
  if (panel === null) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(".node-result-item"));
}

describe("capture: @ mention", () => {
  it("typing @ opens the picker; typing in its search box filters; Enter inserts a mention token", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "see " }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    // Trigger detection is per-keystroke: the "@" input opens the picker…
    typeWithCaret(editor, "see @");
    expect(picker()).not.toBeNull();
    // …and moves focus to the picker's own search box.
    expect(searchBox()).toHaveFocus();

    // The query types into the popup (the block keeps just the placeholder).
    typeInPicker("Tar");
    expect(editor.textContent).toBe("see @");
    expect(within(picker()!).getByText("Target")).toBeInTheDocument();
    expect(within(picker()!).queryByText("Home")).toBeNull();

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toHaveLength(2);
    expect(ast[0]).toEqual({ type: "text", text: "see " });
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId, text: "Target" });
    expect(typeof (ast[1] as { linkId?: unknown }).linkId).toBe("string");
    expect((ast[1] as { linkId: string }).linkId).toMatch(UUID_RE);
    // DOM re-synced to the new prose; picker closed.
    expect(editor.textContent).toBe("see Target");
    expect(picker()).toBeNull();
  });

  it("Main/Blocks scope tabs filter the search (Main first, blocks behind a tab)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({ presentAsMain: true, name: "Target" });
    // The edited block must stay the FIRST child (clickIntoBlock edits the
    // first .nt-block-content in the page).
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "see " }],
    });
    await client.createObject({ parentId: pageId, name: "Hidden needle" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "see @");
    const panel = picker()!;

    // Main is the active tab by default.
    expect(within(panel).getByRole("tab", { name: "Main" })).toHaveAttribute("aria-selected", "true");

    // Main scope: document-chrome nodes match; inline child blocks don't
    // (the no-match create row is the fallback affordance).
    typeInPicker("needle");
    expect(within(panel).queryByText("Hidden needle")).toBeNull();
    expect(within(panel).getByText('Create "needle"')).not.toBeNull();

    // Blocks scope: the inline child block matches, pages don't.
    fireEvent.click(within(panel).getByRole("tab", { name: "Blocks" }));
    expect(within(panel).getByRole("tab", { name: "Blocks" })).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByText("Hidden needle")).not.toBeNull();
    expect(within(panel).queryByText("Target")).toBeNull();
    // The tab click keeps typing in the search box.
    expect(searchBox()).toHaveFocus();

    // Back on Main with a page query: the page matches, the block doesn't.
    fireEvent.click(within(panel).getByRole("tab", { name: "Main" }));
    typeInPicker("Target");
    expect(within(panel).getByText("Target")).not.toBeNull();
    fireEvent.click(within(panel).getByRole("tab", { name: "Blocks" }));
    expect(within(panel).queryByText("Target")).toBeNull();

    // Picking from the Blocks tab inserts the mention of the block.
    typeInPicker("needle");
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    const needle = client.getChildren(pageId).find((n) => deriveDisplayName(n) === "Hidden needle");
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: needle!.id });
  });

  it("classes are mentionable from the Main tab", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const classId = await client.createClass("Genretab");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Genretab" }] });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    typeInPicker("Genre");
    expect(within(picker()!).getByText("Genretab")).not.toBeNull();

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toMatchObject({ type: "mention", targetNodeId: classId });
  });

  it("the typed-date row offers 'Link to daily page' for an existing day node, 'Create' otherwise", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    // No day node yet: the suggestion authors one.
    typeInPicker("today");
    expect(within(picker()!).getByText(/Create daily page: /)).not.toBeNull();

    // Author the chain: the suggestion becomes a link offer.
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await act(async () => {
      await client.ensureDateChain(iso);
    });
    expect(within(picker()!).getByText(/Link to daily page: /)).not.toBeNull();
    expect(within(picker()!).queryByText(/Create daily page: /)).toBeNull();

    // Enter on the row links the (existing) day node as a mention.
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});
    const chain = await client.ensureDateChain(iso);
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toMatchObject({ type: "mention", targetNodeId: chain.day });
  });

  it("creates a backlinks edge to the target (mention edge, record-don't-resolve)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    typeInPicker("Tar");
    fireEvent.keyDown(searchBox(), { key: "Enter" });

    const edges = client.getBacklinks(targetId);
    expect(edges.some((edge) => edge.type === "mention" && edge.sourceId === blockId)).toBe(true);
  });

  it("ArrowDown/ArrowUp move the selection before Enter picks", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const alphaId = await client.createObject({ presentAsMain: true, name: "Alpha" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    typeInPicker("Alp");
    // One result row (Alpha) + the create row: ArrowDown highlights create…
    expect(pickerRows()).toHaveLength(2);
    fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
    expect(pickerRows()[1]?.className).toContain("node-result-item--highlighted");
    fireEvent.keyDown(searchBox(), { key: "ArrowUp" });
    expect(pickerRows()[0]?.className).toContain("node-result-item--highlighted");
    fireEvent.keyDown(searchBox(), { key: "Enter" });

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toMatchObject({ type: "mention", targetNodeId: alphaId });
  });

  it("Esc closes the picker leaving the trigger char; Enter on the create row links a new page", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    expect(picker()).not.toBeNull();
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(picker()).toBeNull();
    // Text untouched after Esc; the trigger char stays as plain text.
    expect(editor.textContent).toBe("@");

    // No-match Enter commits the create row: a page titled by the query is
    // created and linked (the v1 create-from-query contract).
    typeWithCaret(editor, "@");
    typeInPicker("zzz");
    expect(pickerRows()).toHaveLength(1); // only "Create \"zzz\""
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});
    const created = client.listPages().filter((p) => deriveDisplayName(p) === "zzz");
    expect(created).toHaveLength(1);
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toMatchObject({
      type: "mention",
      targetNodeId: created[0]!.id,
      text: "zzz",
    });
    expect(editor.textContent).toBe("zzz");
  });
});

describe("capture: # tag (auto-create + assign) and + class picker", () => {
  it("# auto-creates a missing tag page on Enter and assigns it to the node", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeInPicker("Proj");
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    // page.create + assignTag ride a microtask (createObject promise).
    await act(async () => {});

    // The tag PAGE was created…
    const tagPages = client.listPages().filter((p) => deriveDisplayName(p) === "Proj");
    expect(tagPages).toHaveLength(1);
    // …and assigned to the edited node's Tags (OR-set add).
    expect(client.getNode(blockId)?.tagIds).toEqual([tagPages[0]!.id]);
    // No class was created — "#" is tag semantics, "+" owns classes.
    expect(client.listClasses()).toHaveLength(0);
    // The trigger text is stripped (assignment is the gesture, not prose).
    expect(editor.textContent).toBe("");
  });

  it("# on an existing page assigns the tag without duplicating", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const tagId = await client.createObject({ presentAsMain: true, name: "Project" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [],
      tagIds: [tagId],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeInPicker("Pro");
    // Scope to the picker: the tagged block's own metadata section also
    // renders a "Project" pill below the block.
    expect(within(picker()!).getByText("Project")).toBeInTheDocument();
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});

    // Still editing: assign + strip kept the session; re-assign is a no-op.
    typeWithCaret(editor, "#");
    typeInPicker("Pro");
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});

    const node = client.getNode(blockId)!;
    expect(node.tagIds).toEqual([tagId]); // still exactly one membership
  });

  it("+ assigns an existing class; no-match Enter creates the class and assigns it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const classId = await client.createClass("Project");
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    // The class picker lists the class vocabulary on an empty query.
    expect(within(picker()!).getByText("Project")).toBeInTheDocument();
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});

    expect(client.getNode(blockId)?.classIds).toEqual([classId]);
    expect(editor.textContent).toBe("");

    // No-match Enter on "+" runs the create row: class.create + assign.
    typeWithCaret(editor, "+");
    typeInPicker("Nope");
    expect(pickerRows()).toHaveLength(1); // only "Create \"Nope\""
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});
    const created = client.listClasses().filter((c) => deriveDisplayName(c) === "Nope");
    expect(created).toHaveLength(1);
    expect(client.getNode(blockId)?.classIds).toEqual([classId, created[0]!.id]);
  });
});

describe("capture: verb-on-selection typed link", () => {
  it("Cmd+K opens the popover; commit wraps the selection in a typed_link with verb + locator", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello world" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectRange(editor, 6, 11); // "world"
    fireEvent.keyDown(editor, { key: "k", metaKey: true });

    const verbInput = screen.getByLabelText("Verb");
    expect(verbInput).toBeInTheDocument();
    // The editor stays mounted (focus moved within the component root).
    expect(container.querySelector(".nt-block-text")).not.toBeNull();

    fireEvent.change(verbInput, { target: { value: "cites" } });
    fireEvent.change(screen.getByLabelText("Locator"), { target: { value: "p. 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toEqual([
      { type: "text", text: "hello " },
      {
        type: "typed_link",
        verb: "cites",
        text: "world",
        metadata: { locator: "p. 3", candidateSpans: [] },
      },
    ]);
    expect(editor.textContent).toBe("hello world");
  });

  it("the floating toolbar verb button opens the same popover; Esc cancels without changes", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello world" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectRange(editor, 0, 5);
    // The toolbar appears after the archived 150 ms show debounce.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const toolbar = screen.getByRole("toolbar", { name: "Text formatting" });
    fireEvent.click(toolbar.querySelector('button[title="Link verb (Cmd+K)"]')!);
    expect(screen.getByLabelText("Verb")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText("Verb"), { key: "Escape" });
    expect(screen.queryByLabelText("Verb")).toBeNull();
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "hello world" }]);
    // Caret restored at the range end; still editing.
    expect(container.querySelector(".nt-block-text")).not.toBeNull();
  });
});

describe("candidateSpans (record-don't-resolve)", () => {
  it("is nearest-first by prose distance, deduped, capped at 8", () => {
    const mention = (targetNodeId: string, text: string) => ({ type: "mention", targetNodeId, text });
    const near = "0192a000-0000-7000-8000-0000000000a1";
    const mid = "0192a000-0000-7000-8000-0000000000a2";
    const far = "0192a000-0000-7000-8000-0000000000a3";
    const ast = [
      { type: "text", text: "alpha " },
      mention(far, "Far"),
      { type: "text", text: " beta " },
      mention(near, "Near"),
      { type: "text", text: " gamma " },
      mention(mid, "Mid"),
      { type: "text", text: " target" },
      { type: "typed_link", verb: "cites", text: "target", metadata: {} },
    ];
    const computed = computeCandidateSpans(ast);
    expect(computed.get(7)).toEqual([mid, near, far]);

    // Dedupe + cap: the same target mentioned twice right before the mark is
    // nearest and recorded once; with 10 further mentions only 8 survive.
    const many = Array.from({ length: 10 }, (_, i) =>
      mention(`0192a000-0000-7000-8000-000000000b${String(i).padStart(2, "0")}`, `m${i}`),
    );
    const dupAst = [
      ...many.flatMap((m) => [m, { type: "text", text: " " }]),
      mention(near, "Near"),
      mention(near, "Near again"),
      { type: "typed_link", verb: "v", text: "x", metadata: {} },
    ];
    const spans = computeCandidateSpans(dupAst).get(dupAst.length - 1)!;
    expect(spans[0]).toBe(near); // nearest, deduped to one entry
    expect(spans).toHaveLength(8); // cap
    expect(new Set(spans).size).toBe(spans.length); // no duplicates
  });

  it("withCandidateSpans attaches the lists on save and leaves other tokens intact", () => {
    const target = "0192a000-0000-7000-8000-0000000000a1";
    const ast = [
      { type: "mention", targetNodeId: target, text: "T" },
      { type: "text", text: " cites " },
      { type: "typed_link", verb: "cites", text: "x", metadata: { locator: "p. 1" } },
    ];
    const next = withCandidateSpans(ast);
    expect(next[2]).toEqual({
      type: "typed_link",
      verb: "cites",
      text: "x",
      metadata: { locator: "p. 1", candidateSpans: [target] },
    });
    expect(next[0]).toBe(ast[0]); // untouched by reference
  });
});

describe("capture tokens survive editing", () => {
  it("a mention inserted via @ survives a subsequent text edit", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "see " }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "see @");
    typeInPicker("Tar");
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(client.getNode(blockId)?.contentAst[1]).toMatchObject({
      type: "mention",
      targetNodeId: targetId,
    });

    // Type more text after the mention and flush via blur.
    typeWithCaret(editor, "see Target and more");
    fireEvent.blur(editor);

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toEqual({ type: "text", text: "see " });
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId, text: "Target" });
    expect(ast[2]).toEqual({ type: "text", text: " and more" });
    expect(proseFromAst(ast)).toBe("see Target and more");
  });
});
