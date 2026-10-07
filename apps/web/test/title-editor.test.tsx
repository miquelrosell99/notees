/**
 * Page title row tests (jsdom): title-is-content — the page's title IS its
 * own content, and the header renders/edits it through the shared block-row
 * machinery (BlockRow variant="title" + BlockTextEditor): display mode
 * renders the content's inline tokens (external-link hyperlinks, mention
 * pills),
 * a click swaps in the full block editor, and the structural gestures that
 * would damage the page itself (Enter creating a body block, Backspace
 * deleting the page) are suppressed. Day pages keep the static date header.
 * Same harness as the other PageView suites: the in-process WorkspaceClient
 * + MemoryRelay.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

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

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** The header title row root (the page node's bullet-less BlockRow). */
function titleRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>(".nt-block--title");
  if (row === null) throw new Error("no title row rendered");
  return row;
}

/**
 * Enter edit mode on the title (click the title content) and return the
 * mounted block editor.
 */
function clickIntoTitle(container: HTMLElement): HTMLElement {
  const content = container.querySelector<HTMLElement>(".nt-title-content");
  if (content === null) throw new Error("no title content rendered");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("title editor did not mount after click");
  return editor;
}

/** Emulate typing/browsers mutating the contentEditable DOM + input event,
 *  with a collapsed caret at the end (the slash popup reads the selection). */
function typeInto(editor: HTMLElement, text: string): void {
  editor.textContent = text;
  const node = editor.firstChild;
  if (node !== null) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, text.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  fireEvent.input(editor);
}

describe("page title row", () => {
  it("renders the content-derived title as the page heading", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "The Structure of Scientific Revolutions" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const row = titleRow(container);
    // The header landmark survives: the row root IS the page heading.
    expect(row.getAttribute("role")).toBe("heading");
    expect(row.getAttribute("aria-level")).toBe("1");
    expect(row.textContent).toBe("The Structure of Scientific Revolutions");
    // The title content is NOT a body .nt-block-content — body-row
    // selectors must never match the header row.
    expect(container.querySelectorAll(".nt-block-content")).toHaveLength(0);
    expect(row.querySelector(".nt-block-grip")).toBeNull();
  });

  it("shows the Untitled placeholder while the page has no title text", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const content = container.querySelector<HTMLElement>(".nt-title-content")!;
    // The :empty::before placeholder (asserted through the CSS-free DOM
    // contract: the wrapper is empty in display mode).
    expect(content.textContent).toBe("");
    expect(client.getNode(pageId)!.contentAst).toEqual([]);
  });

  it("does not persist anything when edit mode opens and closes untouched", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "Derived from prose" }],
    });
    const updateSpy = vi.spyOn(client, "updateObject");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoTitle(container);
    fireEvent.blur(editor);
    await flushWrites();
    expect(updateSpy).not.toHaveBeenCalled();
    // The content is untouched — the title keeps tracking it.
    expect(client.getNode(pageId)!.contentAst).toEqual([
      { type: "text", text: "Derived from prose" },
    ]);
  });

  it("commits a typed title as the page's text content (blur flush)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "Derived from prose" }],
    });
    const updateSpy = vi.spyOn(client, "updateObject");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoTitle(container);
    typeInto(editor, "Authored Title");
    fireEvent.blur(editor);
    await flushWrites();
    expect(updateSpy).toHaveBeenCalledWith(pageId, {
      contentAst: [{ type: "text", text: "Authored Title" }],
    });
    // The header re-rendered from the committed content.
    expect(titleRow(container).textContent).toBe("Authored Title");
  });

  it("Enter commits the title and leaves edit mode without creating a body block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "Old Name" }],
    });
    const bodyId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "the only body block" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoTitle(container);
    typeInto(editor, "Committed Via Enter");
    fireEvent.keyDown(editor, { key: "Enter" });
    await flushWrites();

    // The commit landed on the page node's content…
    expect(client.getNode(pageId)!.contentAst).toEqual([
      { type: "text", text: "Committed Via Enter" },
    ]);
    // …edit mode ended (display mode renders the row again)…
    expect(container.querySelector(".nt-block-text")).toBeNull();
    // …and the body tree is untouched: Enter created NO block.
    expect(client.getChildren(pageId).map((child) => child.id)).toEqual([bodyId]);
  });

  it("Backspace on an empty title never deletes the page", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoTitle(container);
    typeInto(editor, "");
    fireEvent.keyDown(editor, { key: "Backspace" });
    fireEvent.blur(editor);
    await flushWrites();

    expect(client.getNode(pageId)).toBeDefined();
    expect(client.getNode(pageId)!.isActive).toBe(true);
  });

  it("typing a URL through the slash Add URL flow authors the token directly (no modal)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "Reading list" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoTitle(container);
    typeInto(editor, "Reading list /");
    typeInto(editor, "Reading list /url https://example.com");
    fireEvent.keyDown(editor, { key: "Enter" });
    await flushWrites();

    // The trigger consumed; the token lands directly — the node-link modal
    // (node-only) never opens for a URL.
    expect(screen.queryByRole("dialog", { name: "Edit Link" })).toBeNull();
    expect(client.getNode(pageId)!.contentAst).toEqual([
      { type: "text", text: "Reading list " },
      { type: "external_link", href: "https://example.com", text: "https://example.com" },
    ]);
    // Blur returns the row to display mode (the body-block contract,
    // unchanged)…
    fireEvent.blur(editor);
    await flushWrites();

    // …and display mode renders it as a plain hyperlink in the header
    // (no chip chrome).
    const anchor = titleRow(container).querySelector("a.nt-hyperlink");
    expect(anchor).not.toBeNull();
    expect(anchor!.classList.contains("nt-chip")).toBe(false);
    expect(anchor!.getAttribute("href")).toBe("https://example.com");
    expect(anchor!.textContent).toBe("https://example.com");
  });

  it("a title carrying a mention token renders the pill and opens the target", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "Target Page" }],
    });
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "see " }],
    });
    // Rich title content is authored through the content write (the page's
    // own contentAst may carry inline tokens; display derivation still
    // flattens to text).
    await client.updateObject(pageId, {
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: targetId, text: "Target Page", linkId: "l1" },
      ],
    });

    const onOpenPage = vi.fn();
    const { container } = render(
      <PageView client={client} pageId={pageId} onOpenPage={onOpenPage} />,
    );

    const pill = titleRow(container).querySelector<HTMLElement>(".nt-link");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toBe("Target Page");
    fireEvent.click(pill!);
    expect(onOpenPage).toHaveBeenCalledWith(targetId);

    // Display-name derivation still flattens (the label read is unchanged).
    expect(client.getDisplayName(pageId)).toBe("see Target Page");
  });

  it("right-click on the title area opens the page's node context menu", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "Menu Page" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const wrap = container.querySelector<HTMLElement>(".nt-page-title-wrap")!;
    fireEvent.contextMenu(wrap);
    // The page-level menu (isPage) offers Copy link among its items.
    expect(screen.getByRole("menuitem", { name: "Copy link" })).not.toBeNull();
  });

  it("renders no editable title row for embedded entries (the static link button)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "Feed Entry" }],
    });
    const onOpenPage = vi.fn();
    const { container } = render(
      <PageView client={client} pageId={pageId} embedded onOpenPage={onOpenPage} />,
    );

    expect(container.querySelector(".nt-block--title")).toBeNull();
    const link = container.querySelector<HTMLElement>(".nt-page-title-link")!;
    expect(link.textContent).toBe("Feed Entry");
    fireEvent.click(link);
    expect(onOpenPage).toHaveBeenCalledWith(pageId);
  });
});

describe("date pages", () => {
  it("render the static date header in the user's dateFormat — no editable title row", async () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("YYYY/MM/DD"));
    const client = await seedClient();
    // A real day page: the deterministic date id is the identity.
    const pageId = await client.createObject({
      id: "00000000-0000-0000-00dd-202606270000",
      presentAsMain: true,
      classIds: [SYSTEM_CLASS_UUIDS.day],
      contentAst: [{ type: "text", text: "20260627" }],
    });
    const updateSpy = vi.spyOn(client, "updateObject");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The day header IS the date header: static, formatted, no title row.
    expect(container.querySelector(".nt-block--title")).toBeNull();
    const heading = container.querySelector("h1")!;
    expect(heading.textContent).toContain("2026/06/27");
    expect(heading.getAttribute("contenteditable")).toBeNull();
    // Interacting with the static header never renames the date page.
    fireEvent.focus(heading);
    fireEvent.blur(heading);
    await flushWrites();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("an ordinary page whose title merely parses as a compact date stays an editable title row", async () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("YYYY-MM-DD"));
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "20261006" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The day/ordinary boundary is the node IDENTITY (the deterministic date
    // id), never the title text: a date-shaped title on an ordinary page is
    // a fully editable title row.
    const row = titleRow(container);
    expect(row.getAttribute("role")).toBe("heading");
    const editor = clickIntoTitle(container);
    typeInto(editor, "Quarterly plan");
    fireEvent.keyDown(editor, { key: "Enter" });
    await flushWrites();
    expect(client.getNode(pageId)!.contentAst).toEqual([
      { type: "text", text: "Quarterly plan" },
    ]);
  });
});
