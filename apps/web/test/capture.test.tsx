/**
 * Capture gesture tests: `@` mention insertion, `#` tag (auto-create +
 * assign / Shift+Enter chip), `+` class picker (assign / Shift+Enter chip),
 * the verb-on-selection typed-link popover, and candidateSpans. Editor tests
 * run PageView over the in-process WorkspaceClient + MemoryRelay (jsdom),
 * same harness as outliner-editor.test.tsx.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
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

const popup = () => screen.queryByRole("listbox", { name: "Capture suggestions" });

describe("capture: @ mention", () => {
  it("typing @ opens the popup; Enter inserts a mention token with a fresh linkId", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "see " }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    // Trigger detection is per-keystroke: the "@" input opens the popup…
    typeWithCaret(editor, "see @");
    expect(popup()).not.toBeNull();
    // Both workspace pages are candidates (the block's own page included).
    expect(screen.getByText("Target")).toBeInTheDocument();

    // …and further typing filters (by display name). "Home" also matches the
    // page title outside the popup — scope the query to the listbox.
    typeWithCaret(editor, "see @Tar");
    expect(screen.getByText("Target")).toBeInTheDocument();
    expect(within(popup()!).queryByText("Home")).toBeNull();

    fireEvent.keyDown(editor, { key: "Enter" });
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toHaveLength(2);
    expect(ast[0]).toEqual({ type: "text", text: "see " });
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId, text: "Target" });
    expect(typeof (ast[1] as { linkId?: unknown }).linkId).toBe("string");
    expect((ast[1] as { linkId: string }).linkId).toMatch(UUID_RE);
    // DOM re-synced to the new prose; popup closed.
    expect(editor.textContent).toBe("see Target");
    expect(popup()).toBeNull();
  });

  it("creates a backlinks edge to the target (mention edge, record-don't-resolve)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    typeWithCaret(editor, "@Tar");
    fireEvent.keyDown(editor, { key: "Enter" });

    const edges = client.getBacklinks(targetId);
    expect(edges.some((edge) => edge.type === "mention" && edge.sourceId === blockId)).toBe(true);
  });

  it("ArrowDown/ArrowUp move the selection before Enter picks", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const alphaId = await client.createObject({ nodeType: "page", name: "Alpha" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    // Deterministic order: Alpha < Home by name.
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    const rows = screen.getAllByRole("option");
    expect(rows[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(editor, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(editor, { key: "Enter" });

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[0]).toMatchObject({ type: "mention", targetNodeId: alphaId });
  });

  it("Esc closes the popup leaving the text; Enter with no match strips the trigger", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    expect(popup()).not.toBeNull();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(popup()).toBeNull();
    // Text untouched after Esc.
    expect(editor.textContent).toBe("@");

    // No-match Enter: plain-text fallback — "@zzz" becomes "zzz".
    typeWithCaret(editor, "@");
    typeWithCaret(editor, "@zzz");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.textContent).toBe("zzz");
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "zzz" }]);
  });
});

describe("capture: # tag (auto-create + assign) and + class picker", () => {
  it("# auto-creates a missing class on Enter and assigns it to the node", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeWithCaret(editor, "#Proj");
    expect(screen.getByText("No matches")).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Enter" });
    // class.create + assign ride a microtask (createObject promise).
    await act(async () => {});

    // The tag class was created…
    const classes = client.listClasses();
    expect(classes.map((c) => c.name)).toContain("Proj");
    // …and assigned to the edited node (OR-set add).
    expect(client.getNode(blockId)?.classIds).toEqual([classes[0]!.id]);
    // The trigger text is stripped (assignment is the gesture, not prose).
    expect(editor.textContent).toBe("");
  });

  it("# on an existing class assigns without duplicating", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const classId = await client.createObject({ nodeType: "class", name: "Project" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [],
      classIds: [classId],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeWithCaret(editor, "#Pro");
    expect(screen.getByText("Project")).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Enter" });
    await act(async () => {});
    fireEvent.blur(editor); // flush + exit; then edit again and re-assign

    const editor2 = clickIntoBlock(container);
    typeWithCaret(editor2, "#");
    typeWithCaret(editor2, "#Pro");
    fireEvent.keyDown(editor2, { key: "Enter" });
    await act(async () => {});

    const node = client.getNode(blockId)!;
    expect(node.classIds).toEqual([classId]); // still exactly one membership
  });

  it("# Shift+Enter inserts a class_chip token WITHOUT assignment", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const classId = await client.createObject({ nodeType: "class", name: "Project" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeWithCaret(editor, "#Pro");
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toEqual([{ type: "class_chip", classId }]);
    expect(client.getNode(blockId)?.classIds).toEqual([]); // render-only
    // The chip is prose-less: the edit-mode draft drops the trigger text.
    expect(editor.textContent).toBe("");
    // Read mode renders the resolved class name.
    fireEvent.blur(editor);
    const chip = container.querySelector(".nt-class-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("Project");
  });

  it("+ assigns an existing class and never creates", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const classId = await client.createObject({ nodeType: "class", name: "Project" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    typeWithCaret(editor, "+Pro");
    fireEvent.keyDown(editor, { key: "Enter" });
    await act(async () => {});

    expect(client.getNode(blockId)?.classIds).toEqual([classId]);
    expect(client.listClasses().map((c) => c.id)).toEqual([classId]); // no new class
    expect(editor.textContent).toBe("");

    // No-match + Enter on "+" strips the sigil (plain fallback) without
    // creating anything.
    const editor2 = clickIntoBlock(container);
    typeWithCaret(editor2, "+");
    typeWithCaret(editor2, "+Nope");
    fireEvent.keyDown(editor2, { key: "Enter" });
    expect(editor2.textContent).toBe("Nope");
    expect(client.listClasses()).toHaveLength(1);
  });

  it("+ Shift+Enter inserts the chip without assignment", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const classId = await client.createObject({ nodeType: "class", name: "Project" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "wrap " }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "wrap +");
    typeWithCaret(editor, "wrap +Pro");
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toEqual([{ type: "text", text: "wrap " }, { type: "class_chip", classId }]);
    expect(client.getNode(blockId)?.classIds).toEqual([]);
  });
});

describe("capture: verb-on-selection typed link", () => {
  it("Cmd+K opens the popover; commit wraps the selection in a typed_link with verb + locator", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const blockId = await client.createObject({
      nodeType: "block",
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

  it("the MarkToolbar verb button opens the same popover; Esc cancels without changes", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello world" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    selectRange(editor, 0, 5);
    const toolbar = screen.getByRole("toolbar", { name: "Text marks" });
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
    const pageId = await client.createObject({ nodeType: "page", name: "Home" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "see " }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "see @");
    typeWithCaret(editor, "see @Tar");
    fireEvent.keyDown(editor, { key: "Enter" });
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
