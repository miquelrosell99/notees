/**
 * Node-link clipboard tests: Ctrl/Cmd+C with no selection copies
 * `<origin>/<uuid>` (block editor and page title) with a confirmation
 * toast; pasting that link — or a bare uuid — inserts a mention token (the
 * title row edits with the full block editor, so block and title share the
 * contract), both with a toast. Multi-line plain text paste splits into
 * sibling blocks at the caret (first line joins the head, last line
 * absorbs the tail); single-line text, the title row, and unresolvable
 * links keep the browser default. The jsdom harness mirrors
 * outliner-editor.test.tsx.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { notificationStore } from "../src/components/ui/fleet/notificationStore.js";
import { nodeLinkUrl, parseNodeLink } from "../src/ui/nodeLink.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const UNKNOWN_ID = "0192a000-0000-7000-8000-000000000099";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  notificationStore.clearAll();
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
function clickIntoBlock(container: HTMLElement, index: number): HTMLElement {
  const contents = container.querySelectorAll<HTMLElement>(".nt-block-content");
  const target = contents[index];
  if (target === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(target);
  const editor = target.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/** Put a real (collapsed or ranged) selection inside an element. */
function selectContents(el: HTMLElement, collapse: "start" | "end" | null): void {
  el.focus();
  const selection = window.getSelection();
  if (selection === null) throw new Error("no window selection in jsdom");
  const range = document.createRange();
  range.selectNodeContents(el);
  if (collapse !== null) range.collapse(collapse === "start");
  selection.removeAllRanges();
  selection.addRange(range);
}

function pasteWithClipboard(el: HTMLElement, text: string): boolean {
  return fireEvent.paste(el, {
    clipboardData: { getData: (kind: string) => (kind === "text/plain" ? text : "") },
  });
}

describe("parseNodeLink", () => {
  it("accepts an origin link, a bare uuid, and rejects everything else", () => {
    const id = "0192a000-0000-7000-8000-000000000042";
    expect(parseNodeLink(`${window.location.origin}/${id}`)).toBe(id);
    expect(parseNodeLink(`https://other.host.example/${id}`)).toBe(id);
    expect(parseNodeLink(id.toUpperCase())).toBe(id.toUpperCase());
    expect(parseNodeLink(id)).toBe(id);
    expect(parseNodeLink(`  ${id}\n`)).toBe(id);
    expect(parseNodeLink("hello world")).toBeNull();
    expect(parseNodeLink(`https://host/${id}/extra`)).toBeNull();
    expect(parseNodeLink("https://host/not-a-uuid")).toBeNull();
    expect(parseNodeLink("")).toBeNull();
  });

  it("ignores query and hash on link URLs", () => {
    const id = "0192a000-0000-7000-8000-000000000042";
    // A shared address-bar URL carrying view params still identifies the node.
    expect(parseNodeLink(`https://host/${id}?tab=refs`)).toBe(id);
    expect(parseNodeLink(`https://host/${id}#section`)).toBe(id);
  });
});

describe("block editor node-link clipboard", () => {
  it("Ctrl+C with no selection copies the block's node link + toasts", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    await act(async () => {
      fireEvent.keyDown(editor, { key: "c", ctrlKey: true });
    });

    expect(writeText).toHaveBeenCalledWith(nodeLinkUrl(blockId));
    expect(writeText).toHaveBeenCalledTimes(1);
    const toast = notificationStore.notifications;
    expect(toast).toHaveLength(1);
    expect(toast[0]!.type).toBe("success");
    expect(toast[0]!.title).toBe("Node link copied");
    expect(toast[0]!.message).toBe("hello");
  });

  it("Cmd+C (metaKey) is treated the same", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hi" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    await act(async () => {
      fireEvent.keyDown(editor, { key: "c", metaKey: true });
    });

    expect(writeText).toHaveBeenCalledWith(nodeLinkUrl(blockId));
    expect(notificationStore.notifications.map((n) => n.title)).toContain("Node link copied");
  });

  it("Ctrl+C with a text selection falls through to the browser copy", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, null); // a ranged selection
    await act(async () => {
      fireEvent.keyDown(editor, { key: "c", ctrlKey: true });
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(notificationStore.notifications).toHaveLength(0);
  });

  it("Ctrl+Shift+C is not intercepted", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    await act(async () => {
      fireEvent.keyDown(editor, { key: "c", ctrlKey: true, shiftKey: true });
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(notificationStore.notifications).toHaveLength(0);
  });

  it("pasting a node link splices a mention token at the caret + toasts", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const targetId = await client.createObject({ isEmbedded: false, name: "Target Page" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "see " }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(editor, nodeLinkUrl(targetId));
    });

    expect(allowed).toBe(false); // the default paste was prevented
    expect(editor.textContent).toBe("see Target Page");
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: targetId, text: "Target Page", linkId: expect.any(String) },
    ]);
    const toast = notificationStore.notifications;
    expect(toast).toHaveLength(1);
    expect(toast[0]!.title).toBe("Node link pasted");
    expect(toast[0]!.message).toBe("Target Page");
  });

  it("pasting a bare uuid links it too", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const targetId = await client.createObject({ isEmbedded: false, name: "Bare Target" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    act(() => {
      pasteWithClipboard(editor, targetId);
    });

    expect(editor.textContent).toBe("Bare Target");
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "mention", targetNodeId: targetId, text: "Bare Target", linkId: expect.any(String) },
    ]);
  });

  it("pasting a node link over a selection replaces it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const targetId = await client.createObject({ isEmbedded: false, name: "Target" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "see here" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    // Select only "here" — the mention must replace exactly that range.
    selectContents(editor, null);
    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0);
    range.setStart(editor.firstChild!, 4);
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => {
      pasteWithClipboard(editor, nodeLinkUrl(targetId));
    });

    expect(editor.textContent).toBe("see Target");
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: targetId, text: "Target", linkId: expect.any(String) },
    ]);
  });

  it("plain-text paste keeps the default (no interception, no toast)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(editor, "just some text");
    });

    expect(allowed).toBe(true);
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "hello" }]);
    expect(notificationStore.notifications).toHaveLength(0);
  });

  it("a node link whose id is unknown locally keeps the default paste", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(editor, nodeLinkUrl(UNKNOWN_ID));
    });

    expect(allowed).toBe(true);
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "hello" }]);
    expect(notificationStore.notifications).toHaveLength(0);
  });
});

/** Place a collapsed caret at a PROSE offset (walks runs and pill elements). */
function setProseCaret(el: HTMLElement, proseOffset: number): void {
  let acc = 0;
  let target: Node | null = null;
  let inner = 0;
  for (const child of Array.from(el.childNodes)) {
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
    range.selectNodeContents(el);
    range.collapse(false);
  } else {
    const textNode = target instanceof HTMLElement ? (target.firstChild ?? target) : target;
    const max = (textNode.textContent ?? "").length;
    range.setStart(textNode, Math.min(inner, max));
    range.collapse(true);
  }
  const selection = window.getSelection();
  if (selection === null) throw new Error("no window selection in jsdom");
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("multi-line paste splits into sibling blocks", () => {
  it("pastes each line as its own block after the current one", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(editor, "one\ntwo\nthree");
    });
    await act(async () => {});

    expect(allowed).toBe(false); // the default paste was prevented
    const tree = client.getBlockTree(pageId);
    expect(tree.map((row) => row.node.id)).toEqual([blockId, expect.any(String), expect.any(String)]);
    expect(tree[0]!.node.contentAst).toEqual([{ type: "text", text: "helloone" }]);
    expect(tree[1]!.node.contentAst).toEqual([{ type: "text", text: "two" }]);
    expect(tree[2]!.node.contentAst).toEqual([{ type: "text", text: "three" }]);
    // The caret took over the last pasted block (the empty tail sits at
    // offset 0 of it — here that's the end of "three").
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(active!.classList.contains("nt-block-text")).toBe(true);
    expect(active!.textContent).toBe("three");
    expect(notificationStore.notifications).toHaveLength(0);
  });

  it("mid-text: the head keeps the first line, the last line absorbs the tail", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "abcdef" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    setProseCaret(editor, 3); // "abc|def"
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(editor, "X\nY");
    });
    await act(async () => {});

    expect(allowed).toBe(false);
    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(2);
    expect(tree[0]!.node.contentAst).toEqual([{ type: "text", text: "abcX" }]);
    expect(tree[1]!.node.contentAst).toEqual([{ type: "text", text: "Ydef" }]);
    // Caret at the start of the absorbed tail inside the last block.
    const active = document.activeElement;
    expect(active).not.toBeNull();
    expect(active!.textContent).toBe("Ydef");
  });

  it("an empty middle line becomes an empty block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    act(() => {
      pasteWithClipboard(editor, "a\n\nb");
    });
    await act(async () => {});

    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(3);
    expect(tree[0]!.node.contentAst).toEqual([{ type: "text", text: "a" }]);
    expect(tree[1]!.node.contentAst).toEqual([]);
    expect(tree[2]!.node.contentAst).toEqual([{ type: "text", text: "b" }]);
  });

  it("trailing blank lines are copy noise, not empty blocks", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(editor, "one\ntwo\n\n");
    });
    await act(async () => {});

    expect(allowed).toBe(false);
    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(2);
    expect(tree[0]!.node.contentAst).toEqual([{ type: "text", text: "helloone" }]);
    expect(tree[1]!.node.contentAst).toEqual([{ type: "text", text: "two" }]);
    expect(tree[1]!.node.id).not.toBe(blockId);
  });

  it("a single trailing newline on one line keeps the default paste", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "hello" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    selectContents(editor, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(editor, "only\n");
    });

    expect(allowed).toBe(true); // nothing to split — the browser default runs
    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "hello" }]);
  });

  it("multi-line paste in the title row keeps the default", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Title Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = clickIntoTitle(container);
    selectContents(title, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(title, "a\nb");
    });

    expect(allowed).toBe(true);
    expect(client.getBlockTree(pageId)).toHaveLength(0);
    expect(notificationStore.notifications).toHaveLength(0);
  });
});

/** Enter edit mode on the title row and return its editor. */
function clickIntoTitle(container: HTMLElement): HTMLElement {
  const content = container.querySelector<HTMLElement>(".nt-title-content");
  if (content === null) throw new Error("no title content rendered");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("title editor did not mount after click");
  return editor;
}

describe("title node-link clipboard", () => {
  it("Ctrl+C with no selection copies the page's node link + toasts", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Title Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = clickIntoTitle(container);
    selectContents(title, "end");
    await act(async () => {
      fireEvent.keyDown(title, { key: "c", ctrlKey: true });
    });

    expect(writeText).toHaveBeenCalledWith(nodeLinkUrl(pageId));
    const toast = notificationStore.notifications;
    expect(toast).toHaveLength(1);
    expect(toast[0]!.title).toBe("Node link copied");
    expect(toast[0]!.message).toBe("Title Page");
  });

  it("Ctrl+C with a text selection falls through to the browser copy", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Title Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = clickIntoTitle(container);
    selectContents(title, null);
    await act(async () => {
      fireEvent.keyDown(title, { key: "c", ctrlKey: true });
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(notificationStore.notifications).toHaveLength(0);
  });

  it("pasting a node link inserts a mention token + toasts", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Title Page" });
    const targetId = await client.createObject({ isEmbedded: false, name: "Target Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = clickIntoTitle(container);
    selectContents(title, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(title, nodeLinkUrl(targetId));
    });

    // The paste is intercepted: a mention pill replaces the link text.
    expect(allowed).toBe(false);
    expect(notificationStore.notifications.map((n) => n.title)).toContain("Node link pasted");

    fireEvent.blur(title);
    await act(async () => {});
    const ast = client.getNode(pageId)!.contentAst;
    expect(ast[0]).toMatchObject({ type: "text", text: "Title Page" });
    expect(ast[1]).toMatchObject({ type: "mention", targetNodeId: targetId });
    // Display mode renders the pill in the header.
    const pill = container
      .querySelector<HTMLElement>(".nt-block--title")!
      .querySelector<HTMLElement>(".nt-link");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toBe("Target Page");
  });

  it("plain-text paste in the title keeps the default", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Title Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = clickIntoTitle(container);
    selectContents(title, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(title, "plain words");
    });

    expect(allowed).toBe(true);
    expect(title.textContent).toBe("Title Page");
    expect(notificationStore.notifications).toHaveLength(0);
  });
});

describe("notification stacking", () => {
  it("multiple toasts stack and re-flow as older ones are removed", () => {
    const first = notificationStore.success("Node link copied", "A");
    const second = notificationStore.success("Node link pasted", "B");
    const third = notificationStore.info("Something else");

    expect(notificationStore.notifications.map((n) => n.id)).toEqual([first, second, third]);

    notificationStore.removeNotification(first);
    expect(notificationStore.notifications.map((n) => n.id)).toEqual([second, third]);

    notificationStore.removeNotification(second);
    expect(notificationStore.notifications.map((n) => n.id)).toEqual([third]);

    notificationStore.removeNotification(third);
    expect(notificationStore.notifications).toEqual([]);
  });
});
