/**
 * Node-link clipboard tests: Ctrl/Cmd+C with no selection copies
 * `<origin>/<uuid>` (block editor and page title) with a confirmation
 * toast; pasting that link — or a bare uuid — inserts a mention token in a
 * block and the display name in a title, both with a toast. Text
 * selections and non-link clipboard text keep the browser default. The
 * jsdom harness mirrors outliner-editor.test.tsx.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { notificationStore } from "../src/ui/components/ui/notificationStore.js";
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    const blockId = await client.createObject({
      nodeType: "block",
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    const blockId = await client.createObject({
      nodeType: "block",
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    await client.createObject({
      nodeType: "block",
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    await client.createObject({
      nodeType: "block",
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target Page" });
    const blockId = await client.createObject({
      nodeType: "block",
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    const targetId = await client.createObject({ nodeType: "page", name: "Bare Target" });
    const blockId = await client.createObject({
      nodeType: "block",
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target" });
    const blockId = await client.createObject({
      nodeType: "block",
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    const blockId = await client.createObject({
      nodeType: "block",
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
    const pageId = await client.createObject({ nodeType: "page", name: "P" });
    const blockId = await client.createObject({
      nodeType: "block",
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

describe("title node-link clipboard", () => {
  it("Ctrl+C with no selection copies the page's node link + toasts", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Title Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = container.querySelector<HTMLElement>(".nt-title-editable");
    if (title === null) throw new Error("no editable title rendered");
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
    const pageId = await client.createObject({ nodeType: "page", name: "Title Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = container.querySelector<HTMLElement>(".nt-title-editable")!;
    selectContents(title, null);
    await act(async () => {
      fireEvent.keyDown(title, { key: "c", ctrlKey: true });
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(notificationStore.notifications).toHaveLength(0);
  });

  it("pasting a node link inserts the display name as plain text + toasts", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Title Page" });
    const targetId = await client.createObject({ nodeType: "page", name: "Target Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = container.querySelector<HTMLElement>(".nt-title-editable")!;
    selectContents(title, "end");
    let allowed = true;
    act(() => {
      allowed = pasteWithClipboard(title, nodeLinkUrl(targetId));
    });

    expect(allowed).toBe(false);
    expect(title.textContent).toBe("Title PageTarget Page");
    expect(notificationStore.notifications.map((n) => n.title)).toContain("Node link pasted");

    fireEvent.blur(title);
    expect(client.getNode(pageId)?.contentAst).toEqual([
      { type: "text", text: "Title PageTarget Page" },
    ]);
  });

  it("plain-text paste in the title keeps the default", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Title Page" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const title = container.querySelector<HTMLElement>(".nt-title-editable")!;
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
