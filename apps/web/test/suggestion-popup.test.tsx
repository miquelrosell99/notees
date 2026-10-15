/**
 * Suggestion-popup rows — the #/+ capture popup (NodeSelector
 * machinery):
 *
 * - Single-pick contract (owner 2026-10-15): a row click or Enter assigns
 *   THE picked node and closes — the same picker behavior as the @ mention
 *   picker, no checkboxes / picked set / Apply footer. Ctrl/Cmd+Enter picks
 *   the highlighted row too (on `@` it keeps the query as a custom label).
 * - The `+` popup's assigned-class rows (owner 2026-10-15): they hide from
 *   the empty-query browse and resurface checkmark-marked under a matching
 *   query — a plain pick REMOVES the class (the toggle), a Ctrl/Cmd pick
 *   (Enter or click) splices the inline class link (`class_link` token).
 *   Membership stays: the classes pills are a derived view that hides
 *   inline-referenced classes, and the edge index never treats the token as
 *   a link (no backlinks/graph edges).
 * - Filter prefixes: `daily:` (bare = day pages only) plus the boolean
 *   family `is_daily:` / `is_page:` / `is_class:` refine the candidates;
 *   the tokens strip from the search text (never a created title) and a
 *   bare filter lists its pool.
 *
 * Same harness as capture.test.tsx.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
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

function clickIntoBlock(container: HTMLElement): HTMLElement {
  const content = container.querySelector<HTMLElement>(".nt-block-content");
  if (content === null) throw new Error("no .nt-block-content");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

function typeWithCaret(editor: HTMLElement, text: string): void {
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

const picker = () => screen.queryByRole("dialog", { name: "Select node" });

function searchBox(): HTMLElement {
  const panel = picker();
  if (panel === null) throw new Error("picker is not open");
  return within(panel).getByRole("textbox");
}

function typeInPicker(text: string): void {
  fireEvent.change(searchBox(), { target: { value: text } });
}

function pickerRows(): HTMLElement[] {
  const panel = picker();
  if (panel === null) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(".node-result-item"));
}

/** Result rows only (the create row is chrome, not a candidate). */
function resultRows(): HTMLElement[] {
  return pickerRows().filter((el) => !el.classList.contains("node-result-item--create"));
}

function rowByText(text: string): HTMLElement {
  const row = pickerRows().find((el) => el.textContent?.includes(text));
  if (row === undefined) throw new Error(`no picker row for ${text}`);
  return row;
}

/** Seed a page with one empty block; returns ids. */
async function seedBlock(client: WorkspaceClient): Promise<{ pageId: string; blockId: string }> {
  const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
  const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
  return { pageId, blockId };
}

describe("suggestion popup single-pick (# tags, + classes)", () => {
  it("a row click assigns exactly that node and closes the popup", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const alpha = await client.createObject({ presentAsMain: true, name: "TagA" });
    await client.createObject({ presentAsMain: true, name: "TagB" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeInPicker("Tag"); // matches TagA and TagB
    fireEvent.click(rowByText("TagA"));
    await act(async () => {});

    expect(client.getNode(blockId)?.tagIds).toEqual([alpha]);
    expect(editor.textContent).toBe(""); // trigger stripped
    expect(picker()).toBeNull(); // no accumulation — the popup is gone
  });

  it("Ctrl+Enter picks the highlighted row and assigns the class", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    await client.createClass("ClassB");
    const classA = await client.createClass("ClassA");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    typeInPicker("ClassA");
    // The query pins exactly one row; Ctrl+Enter must assign it (the
    // multi-select era swallowed this: apply with an empty picked set).
    fireEvent.keyDown(searchBox(), { key: "Enter", ctrlKey: true });
    await act(async () => {});

    expect(client.getNode(blockId)?.classIds).toEqual([classA]);
    expect(editor.textContent).toBe("");
    expect(picker()).toBeNull();
  });

  it("a plain Enter assigns the highlighted row and closes", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const alpha = await client.createObject({ presentAsMain: true, name: "TagA" });
    const axe = await client.createObject({ presentAsMain: true, name: "TagAxe" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeInPicker("TagA"); // prefix-matches TagA and TagAxe
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});

    const tagIds = client.getNode(blockId)?.tagIds ?? [];
    expect(tagIds).toHaveLength(1);
    expect([alpha, axe]).toContain(tagIds[0]);
    expect(picker()).toBeNull();
  });

  it("no checkbox chrome: the popup renders no multi footer", async () => {
    const client = await seedClient();
    const { pageId } = await seedBlock(client);
    await client.createClass("ClassA");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    typeInPicker("ClassA");

    const panel = picker()!;
    expect(panel.querySelector(".node-selector__multi-footer")).toBeNull();
    expect(panel.querySelector(".node-selector__multi-check")).toBeNull();
  });
});

describe("suggestion popup assigned-class gestures (+ popup)", () => {
  it("assigned classes hide from the empty-query browse", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const assigned = await client.createClass("Assigned");
    const free = await client.createClass("Free");
    await client.assignClass(blockId, assigned);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    // Empty query: the browse lists only the addable pool…
    const labels = resultRows().map((row) => row.textContent ?? "");
    expect(labels.some((l) => l.includes("Free"))).toBe(true);
    expect(labels.some((l) => l.includes("Assigned"))).toBe(false);
  });

  it("a plain pick on an assigned class REMOVES it (the toggle)", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const classId = await client.createClass("correo");
    await client.assignClass(blockId, classId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    typeInPicker("correo");
    // The assigned row resurfaces with the checkmark…
    const row = rowByText("correo");
    expect(row.querySelector(".node-result-item__check")).not.toBeNull();

    // …and a plain Enter toggles the class OFF.
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});

    expect(client.getNode(blockId)?.classIds).toEqual([]);
    expect(editor.textContent).toBe(""); // trigger stripped
    expect(picker()).toBeNull();
  });

  it("Ctrl+Enter on an assigned class splices the inline link — membership stays", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const classId = await client.createClass("correo");
    await client.assignClass(blockId, classId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    typeInPicker("correo");
    fireEvent.keyDown(searchBox(), { key: "Enter", ctrlKey: true });
    await act(async () => {});

    // The `+` drops and a class_link token splices at the trigger; the
    // MEMBERSHIP stays (owner ruling: the pill row hides inline-referenced
    // classes — the link IS the marker).
    const ast = client.getNode(blockId)?.contentAst;
    expect(ast).toEqual([{ type: "class_link", classId }]);
    expect(editor.textContent).toBe("correo"); // the link renders the label
    expect(client.getNode(blockId)?.classIds).toEqual([classId]);
    expect(picker()).toBeNull();
  });

  it("Ctrl+click on the assigned row splices the inline link too — membership stays", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const classId = await client.createClass("correo");
    await client.assignClass(blockId, classId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    typeInPicker("correo");
    fireEvent.click(rowByText("correo"), { ctrlKey: true });
    await act(async () => {});

    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "class_link", classId }]);
    expect(client.getNode(blockId)?.classIds).toEqual([classId]);
    expect(picker()).toBeNull();
  });

  it("the classes pills hide a class that is referenced inline (membership untouched)", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const inline = await client.createClass("correo");
    const pillOnly = await client.createClass("proyecto");
    await client.assignClass(blockId, inline);
    await client.assignClass(blockId, pillOnly);
    // The block references `correo` inline; `proyecto` rides the pill row.
    await client.updateObject(blockId, {
      contentAst: [{ type: "class_link", classId: inline }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // Only the non-inline class wears a pill (the block row's classes
    // column); the inline-referenced class is still assigned (the picker's
    // checkmarked toggle still removes it).
    const pills = container.querySelectorAll(".nt-block-classes .pill:not(.pill--add)");
    expect(pills.length).toBe(1);
    expect(client.getNode(blockId)?.classIds).toEqual([inline, pillOnly]);
  });

  it("an exact-name query offers NO create row — the class already exists", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const classId = await client.createClass("correo");
    await client.assignClass(blockId, classId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    typeInPicker("correo");

    // Only the checkmarked class row — creating would duplicate the class.
    expect(rowByText("correo")).not.toBeNull();
    expect(pickerRows().some((row) => row.classList.contains("node-result-item--create"))).toBe(
      false,
    );
  });

  it("the gesture hint rides the picker while a checkmarked row is on screen", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const classId = await client.createClass("correo");
    await client.assignClass(blockId, classId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    // Unassigned-only results: no hint.
    typeInPicker("dirección");
    expect(picker()!.querySelector(".node-selector__assigned-hint")).toBeNull();

    // The checkmarked row appears: the hint names both gestures.
    typeInPicker("correo");
    const hint = picker()!.querySelector(".node-selector__assigned-hint");
    expect(hint?.textContent).toContain("remove");
    expect(hint?.textContent).toContain("⌃");
  });

  it("the unassigned path is unchanged: Enter assigns, Ctrl+Enter assigns", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const classId = await client.createClass("correo");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    typeInPicker("correo");
    // No checkmark — the class is not assigned yet.
    expect(rowByText("correo").querySelector(".node-result-item__check")).toBeNull();
    fireEvent.keyDown(searchBox(), { key: "Enter", ctrlKey: true });
    await act(async () => {});

    expect(client.getNode(blockId)?.classIds).toEqual([classId]);
    expect(editor.textContent).toBe("");
    expect(picker()).toBeNull();
  });
});

describe("suggestion popup filter prefixes", () => {
  it("`daily:` alone lists only day-precision pages", async () => {
    const client = await seedClient();
    const { pageId } = await seedBlock(client);
    await client.createObject({ presentAsMain: true, name: "Daily habits" });
    await client.ensureDateChain("2026-02-14");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    typeInPicker("daily:");

    const labels = resultRows().map((row) => row.textContent ?? "");
    expect(labels.length).toBeGreaterThan(0);
    // Only the deterministic day page matches — the plain "Daily habits"
    // page is filtered out despite the name overlap.
    const dayPage = client
      .listPages()
      .find((p) => p.id.startsWith("00000000-0000-0000-00dd-"));
    expect(dayPage).not.toBeUndefined();
    expect(labels.some((l) => l.includes("Daily habits"))).toBe(false);
  });

  it("`daily:` combined with text filters the name inside the daily pool", async () => {
    const client = await seedClient();
    const { pageId } = await seedBlock(client);
    await client.ensureDateChain("2026-02-14");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    // The day page's label is the formatted date ("Feb 14, 2026"-ish).
    typeInPicker("daily: feb");
    const labels = resultRows().map((row) => row.textContent ?? "");
    expect(labels).toHaveLength(1);
    expect(labels[0]!.toLowerCase()).toContain("feb");
  });

  it("`is_page:` / `is_class:` refine the candidate set", async () => {
    const client = await seedClient();
    const { pageId } = await seedBlock(client);
    await client.createObject({ presentAsMain: true, name: "Some page" });
    await client.createClass("Some class");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");
    typeInPicker("some is_class:true");
    let labels = resultRows().map((row) => row.textContent ?? "");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("Some class");

    typeInPicker("some is_page:true");
    labels = resultRows().map((row) => row.textContent ?? "");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("Some page");
  });
});
