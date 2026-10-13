/**
 * Block multi-selection — the standalone register rows:
 *
 * - shift+click extends a range from the anchor; Ctrl/Cmd+click toggles;
 *   a drag-over rows ("arches") extends from the press anchor once the
 *   pointer exits the pressed block's borders (in edit mode the in-block
 *   text selection hands over to the block range at the same border); the
 *   trailing click after a drag never enters edit mode.
 * - Escape / outside click clear the selection.
 * - The floating action bar offers the group ops through the existing
 *   client batch paths: bulk class assign/unassign, bulk tag, bulk move to
 *   page, bulk delete (danger confirmation). Unassigning a non-removable
 *   system/journal class is refused up front with the honest toast.
 * - The non-removable rule also guards the block-row classes column
 *   (NodePills lock) and the page classes row.
 * - The ghost trailing block renders for a body whose last child is
 *   non-empty; one click creates a real empty block and focuses it.
 *
 * Same harness as capture.test.tsx (PageView over the in-process
 * WorkspaceClient + MemoryRelay, jsdom).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { notificationStore } from "../src/ui/components/ui/notificationStore.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
  notificationStore.clearAll();
});

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

/** A page with `texts` as sibling blocks; returns the page id. */
async function seedPage(client: WorkspaceClient, texts: string[]): Promise<string> {
  const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
  for (const text of texts) {
    await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text }] });
  }
  return pageId;
}

function blockContents(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".nt-block-content"));
}

function selectedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".nt-block--selected")).map(
    (el) => el.getAttribute("data-block-id")!,
  );
}

function selectionBar(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".nt-selection-bar");
}

function barButton(name: string): HTMLElement {
  const bar = selectionBar();
  if (bar === null) throw new Error("no selection bar");
  const btn = within(bar).getByRole("button", { name });
  return btn;
}

/** The portaled picker inside the selection bar flow. */
function pickerPanel(): HTMLElement {
  const panel = document.body.querySelector<HTMLElement>(".node-selector__picker");
  if (panel === null) throw new Error("no picker panel");
  return panel;
}

async function pickRowByText(text: string): Promise<void> {
  const panel = pickerPanel();
  const row = Array.from(panel.querySelectorAll<HTMLElement>(".node-result-item")).find((el) =>
    el.textContent?.includes(text),
  );
  if (row === undefined) throw new Error(`no picker row for ${text}`);
  fireEvent.click(row);
  await act(async () => {});
}

function searchPicker(query: string): void {
  const input = pickerPanel().querySelector<HTMLInputElement>(".search-field__input");
  if (input === null) throw new Error("no picker search");
  fireEvent.change(input, { target: { value: query } });
}

describe("block multi-selection gestures", () => {
  it("shift+click extends the range from the anchor across rows", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two", "three"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.click(rows[0]!, { shiftKey: true });
    expect(selectedIds(container)).toEqual([ids[0]]);
    fireEvent.click(rows[2]!, { shiftKey: true });
    expect(selectedIds(container)).toEqual(ids);

    const bar = selectionBar();
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain("3 selected");
  });

  it("Ctrl+click toggles single rows", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two", "three"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.click(rows[0]!, { ctrlKey: true });
    fireEvent.click(rows[2]!, { ctrlKey: true });
    expect(selectedIds(container)).toEqual([ids[0], ids[2]]);
    fireEvent.click(rows[0]!, { ctrlKey: true });
    expect(selectedIds(container)).toEqual([ids[2]]);
  });

  it("dragging over rows selects the range and the trailing click does not edit", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two", "three"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.mouseDown(rows[0]!, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(rows[2]!, { clientX: 10, clientY: 40 });
    fireEvent.mouseUp(document, { clientX: 10, clientY: 40 });

    expect(selectedIds(container)).toEqual(ids);

    // The click that follows the drag must not swap the row into edit mode.
    fireEvent.click(rows[2]!, { clientX: 10, clientY: 40 });
    expect(container.querySelector(".nt-block-text")).toBeNull();
    expect(selectedIds(container)).toEqual(ids);
  });

  it("Escape clears the selection", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);

    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    expect(selectionBar()).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(selectionBar()).toBeNull();
    expect(selectedIds(container)).toEqual([]);
  });

  it("clicking outside the tree clears the selection", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    const rows = blockContents(container);
    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    expect(selectionBar()).not.toBeNull();

    fireEvent.mouseDown(outside);
    expect(selectionBar()).toBeNull();
    outside.remove();
  });

  it("a plain click clears the selection and edits as usual", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);

    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    expect(selectionBar()).not.toBeNull();

    fireEvent.click(rows[1]!);
    expect(selectionBar()).toBeNull();
    expect(rows[1]!.querySelector(".nt-block-text")).not.toBeNull();
  });

  it("a read-mode drag arms only when the pointer exits the pressed block's borders", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two", "three"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    // Real borders for the press block: it occupies y 0..20.
    const pressRow = rows[0]!.closest("[data-block-id]") as HTMLElement;
    vi.spyOn(pressRow, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 20, width: 400, height: 20,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseDown(rows[0]!, { clientX: 10, clientY: 10 });
    // Inside the borders: nothing is selected (read-mode text is
    // user-select:none — the gesture is not a text selection).
    fireEvent.mouseMove(rows[0]!, { clientX: 30, clientY: 18 });
    expect(selectedIds(container)).toEqual([]);
    // Crossing the bottom border arms the drag; arching over the next row
    // extends the range from the anchor.
    fireEvent.mouseMove(rows[1]!, { clientX: 30, clientY: 40 });
    expect(selectedIds(container)).toEqual([ids[0], ids[1]]);
    fireEvent.mouseUp(document);
  });

  it("an edit-mode drag keeps text selection inside the block; exiting its borders switches to block select", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    // Enter edit mode on the first block and select its text "one".
    fireEvent.click(rows[0]!);
    const editor = rows[0]!.querySelector<HTMLElement>(".nt-block-text");
    if (editor === null) throw new Error("editor did not mount after click");
    const textNode = editor.firstChild;
    if (textNode === null) throw new Error("editor has no text node");
    const textRange = document.createRange();
    textRange.setStart(textNode, 0);
    textRange.setEnd(textNode, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(textRange);
    expect(selection.toString()).toBe("one");

    // The editing block's borders: it occupies y 0..20.
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 20, width: 400, height: 20,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseDown(editor, { clientX: 5, clientY: 5 });
    // Still inside the borders: no block selection, the text selection survives.
    fireEvent.mouseMove(editor, { clientX: 8, clientY: 8 });
    expect(selectedIds(container)).toEqual([]);
    expect(window.getSelection()!.toString()).toBe("one");

    // Exit the borders over the second row: block select takes over from
    // the anchor block and the native text selection is dropped.
    const secondRow = Array.from(
      container.querySelectorAll<HTMLElement>(".nt-block-content"),
    )[1]!;
    fireEvent.mouseMove(secondRow, { clientX: 8, clientY: 40 });
    expect(selectedIds(container)).toEqual(ids);
    expect(window.getSelection()!.toString()).toBe("");
    fireEvent.mouseUp(document);

    // The trailing click after the drag does not enter edit mode.
    fireEvent.click(secondRow);
    expect(container.querySelectorAll(".nt-block-text")).toHaveLength(1);
  });
});

describe("selection card: whole-subtree closure + card outline", () => {
  /** Page with a parent block (two children) followed by a lone block. */
  async function seedNestedPage(client: WorkspaceClient): Promise<string> {
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const parentId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    await client.createObject({
      parentId,
      contentAst: [{ type: "text", text: "kid one" }],
    });
    await client.createObject({
      parentId,
      contentAst: [{ type: "text", text: "kid two" }],
    });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "other" }],
    });
    return pageId;
  }

  function outlineCards(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(".nt-selection-outline"));
  }

  it("Ctrl+clicking a block also selects its children (the whole subtree)", async () => {
    const client = await seedClient();
    const pageId = await seedNestedPage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.click(rows[0]!, { ctrlKey: true });
    // parent + kid one + kid two — the subtree closes, "other" stays out.
    expect(selectedIds(container)).toEqual([ids[0], ids[1], ids[2]]);
  });

  it("the selection renders as ONE card per contiguous run (subtree = one rectangle)", async () => {
    const client = await seedClient();
    const pageId = await seedNestedPage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);

    fireEvent.click(rows[0]!, { ctrlKey: true });
    // The parent's subtree is one contiguous run — one card, even though it
    // wraps children at a deeper indent.
    expect(outlineCards(container)).toHaveLength(1);

    // A disjoint selection (an unselected row between two selected ones)
    // opens a second card.
    const flatPageId = await seedPage(client, ["one", "two", "three"]);
    const flat = render(<PageView client={client} pageId={flatPageId} />);
    const flatRows = blockContents(flat.container);
    fireEvent.click(flatRows[0]!, { ctrlKey: true });
    fireEvent.click(flatRows[2]!, { ctrlKey: true });
    expect(outlineCards(flat.container)).toHaveLength(2);

    // Escape clears the selection and the cards.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(outlineCards(flat.container)).toHaveLength(0);
    expect(outlineCards(container)).toHaveLength(0);
  });

  it("shift+click range arms whole-subtree from the anchor too", async () => {
    const client = await seedClient();
    const pageId = await seedNestedPage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.click(rows[0]!, { shiftKey: true });
    // Anchoring on the parent selects its subtree immediately.
    expect(selectedIds(container)).toEqual([ids[0], ids[1], ids[2]]);
    expect(outlineCards(container)).toHaveLength(1);
  });
});

describe("selection action bar group ops", () => {
  it("bulk assign class applies to every selected block", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two", "three"]);
    const projectId = await client.createClass("Project");
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    fireEvent.click(barButton("Assign class"));
    searchPicker("Proj");
    await pickRowByText("Project");

    const project = client.listClasses().find((c) => c.id === projectId)!;
    expect(client.getNode(ids[0]!)?.classIds).toContain(project.id);
    expect(client.getNode(ids[1]!)?.classIds).toContain(project.id);
    expect(client.getNode(ids[2]!)?.classIds ?? []).not.toContain(project.id);
    // Selection survives the op (the set drives the next gesture).
    expect(selectionBar()).not.toBeNull();
  });

  it("bulk unassign class removes the membership from every selected block", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Project");
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const a = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "one" }], classIds: [classId] });
    const b = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "two" }], classIds: [classId] });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);

    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    fireEvent.click(barButton("Unassign class"));
    searchPicker("Proj");
    await pickRowByText("Project");

    expect(client.getNode(a)?.classIds).toEqual([]);
    expect(client.getNode(b)?.classIds).toEqual([]);
  });

  it("bulk unassign of a non-removable system class is refused with a toast", async () => {
    const client = await seedClient();
    // The test relay starts empty (production seeds ride the server) —
    // declare the day class at its reserved seed id.
    await client.createClass("Day", { id: SYSTEM_CLASS_UUIDS.day });
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const a = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "one" }],
      classIds: [SYSTEM_CLASS_UUIDS.day],
    });
    const unassign = vi.spyOn(client, "unassignClass");
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);

    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(barButton("Unassign class"));
    searchPicker("Day");
    await pickRowByText("Day");

    expect(unassign).not.toHaveBeenCalled();
    expect(client.getNode(a)?.classIds).toEqual([SYSTEM_CLASS_UUIDS.day]);
    expect(notificationStore.notifications.some((n) => n.title === "Class can't be removed")).toBe(true);
  });

  it("bulk tag assigns the picked page as a tag on every selected block", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two"]);
    await client.createObject({ presentAsMain: true, name: "Project" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    fireEvent.click(barButton("Add tag"));
    searchPicker("Proj");
    await pickRowByText("Project");

    const tag = client.listPages().find((p) => p.id !== pageId)!;
    expect(client.getNode(ids[0]!)?.tagIds).toContain(tag.id);
    expect(client.getNode(ids[1]!)?.tagIds).toContain(tag.id);
  });

  it("bulk move reparents every selected block under the picked page", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two", "three"]);
    const targetId = await client.createObject({ presentAsMain: true, name: "Elsewhere" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    fireEvent.click(barButton("Move to page"));
    searchPicker("Else");
    await pickRowByText("Elsewhere");

    expect(client.getNode(ids[0]!)?.parentId).toBe(targetId);
    expect(client.getNode(ids[1]!)?.parentId).toBe(targetId);
    expect(client.getNode(ids[2]!)?.parentId).toBe(pageId);
  });

  it("bulk delete asks in the danger confirmation, then trashes every selected block", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["one", "two", "three"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const rows = blockContents(container);
    const ids = rows.map((r) => r.closest("[data-block-id]")!.getAttribute("data-block-id")!);

    fireEvent.click(rows[0]!, { shiftKey: true });
    fireEvent.click(rows[1]!, { shiftKey: true });
    fireEvent.click(barButton("Delete"));

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Delete 2 blocks?");

    const confirm = Array.from(dialog!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Delete",
    );
    if (confirm === undefined) throw new Error("no confirm button");
    fireEvent.click(confirm);
    await act(async () => {});

    expect(client.getNode(ids[0]!)).toBeUndefined();
    expect(client.getNode(ids[1]!)).toBeUndefined();
    expect(client.getNode(ids[2]!)).not.toBeUndefined();
    expect(selectionBar()).toBeNull();
  });
});

describe("non-removable class rules (block-row column)", () => {
  it("the system/journal class pill shows a lock: the click refuses with a toast and no write", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "journaled" }],
      classIds: [SYSTEM_CLASS_UUIDS.day],
    });
    const unassign = vi.spyOn(client, "unassignClass");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const lock = container.querySelector<HTMLButtonElement>(".pill__right-button--locked");
    expect(lock).not.toBeNull();
    expect(lock!.getAttribute("aria-label")).toContain("can't be removed");

    fireEvent.click(lock!);
    expect(unassign).not.toHaveBeenCalled();
    expect(client.getNode(blockId)?.classIds).toEqual([SYSTEM_CLASS_UUIDS.day]);
    expect(notificationStore.notifications.some((n) => n.type === "warning")).toBe(true);
  });

  it("a user class pill keeps its working × on the block-row column", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Project");
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "classified" }],
      classIds: [classId],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const remove = container.querySelector<HTMLButtonElement>(".pill__right-button:not(.pill__right-button--locked)");
    if (remove === null) throw new Error("no × on the user class pill");
    fireEvent.click(remove);
    await act(async () => {});

    expect(client.getNode(blockId)?.classIds).toEqual([]);
  });
});

describe("ghost trailing block", () => {
  it("renders after a non-empty last child; one click creates and focuses a block", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["only content"]);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The page-root ghost is the trailing "+ Add block" row (parity:
    // exactly one per page — blocks no longer trail their own).
    const ghost = container.querySelector<HTMLElement>(
      `[data-ghost="__ghost-${pageId}"]`,
    )?.querySelector<HTMLButtonElement>("button");
    expect(ghost).not.toBeNull();
    expect(ghost!.textContent).toContain("Add block");
    const before = client.getChildren(pageId).length;

    fireEvent.click(ghost!);
    await act(async () => {});

    const children = client.getChildren(pageId);
    expect(children).toHaveLength(before + 1);
    expect(children[children.length - 1]!.contentAst).toEqual([]);
    // The new block entered edit mode (focus hand-off through the outliner).
    expect(container.querySelector(".nt-block-text")).not.toBeNull();
  });

  it("shows even when the last child is already empty (owner refinement: the ghost is always the add affordance)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    expect(container.querySelector(`[data-ghost="__ghost-${pageId}"]`)).not.toBeNull();
  });

  it("embedded renders skip the ghost", async () => {
    const client = await seedClient();
    const pageId = await seedPage(client, ["feed content"]);
    const { container } = render(<PageView client={client} pageId={pageId} embedded />);

    expect(container.querySelector("[data-ghost]")).toBeNull();
  });
});
