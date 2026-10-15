/**
 * Suggestion-popup rows — the #/+ capture popup (NodeSelector
 * machinery):
 *
 * - Single-pick contract (owner 2026-10-15): a row click or Enter assigns
 *   THE picked node and closes — the same picker behavior as the @ mention
 *   picker, no checkboxes / picked set / Apply footer. Ctrl/Cmd+Enter picks
 *   the highlighted row too (for #/+ the label context is inert; the pick
 *   assigns like a plain Enter).
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
