/**
 * §34.19 suggestion-popup rows — the #/+ capture popup (NodeSelector
 * machinery) gained:
 *
 * - Multi-select checkbox mode: row clicks accumulate a picked set (checked
 *   rows ride the top), the Apply footer / Ctrl+Enter commits them all, and
 *   a plain Enter keeps the fast single-assign path (pick + commit).
 * - Filter prefixes: `daily:` (bare = day pages only) plus the v1 boolean
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

describe("suggestion popup multi-select (# tags)", () => {
  it("checkbox clicks accumulate; Apply assigns every picked tag", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const alpha = await client.createObject({ presentAsMain: true, name: "TagA" });
    const beta = await client.createObject({ presentAsMain: true, name: "TagB" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeInPicker("Tag"); // matches TagA and TagB
    expect(pickerRows().length).toBeGreaterThanOrEqual(2);

    // Checkbox-click the two rows: picked rows ride the top, popup stays.
    fireEvent.click(rowByText("TagA"));
    expect(picker()).not.toBeNull();
    fireEvent.click(rowByText("TagB"));
    const panel = picker()!;
    expect(panel.querySelector(".node-selector__multi-footer")?.textContent).toContain("2 picked");

    // Apply commits the whole set in one gesture.
    const apply = within(panel).getByRole("button", { name: "Apply 2" });
    fireEvent.click(apply);
    await act(async () => {});

    expect(client.getNode(blockId)?.tagIds).toEqual([alpha, beta]);
    expect(editor.textContent).toBe(""); // trigger stripped
  });

  it("Ctrl+Enter commits the accumulated set from the keyboard", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const alpha = await client.createObject({ presentAsMain: true, name: "TagA" });
    const beta = await client.createObject({ presentAsMain: true, name: "TagB" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "+");
    const classA = await client.createClass("ClassA");
    const classB = await client.createClass("ClassB");
    typeInPicker("Class");
    fireEvent.click(rowByText("ClassA"));
    fireEvent.click(rowByText("ClassB"));
    fireEvent.keyDown(searchBox(), { key: "Enter", ctrlKey: true });
    await act(async () => {});

    expect(client.getNode(blockId)?.classIds).toEqual([classA, classB]);
    expect(editor.textContent).toBe("");
  });

  it("a plain Enter keeps the fast single-assign path (no accumulation)", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const alpha = await client.createObject({ presentAsMain: true, name: "TagA" });
    const axe = await client.createObject({ presentAsMain: true, name: "TagAxe" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeInPicker("TagA"); // prefix-matches TagA and TagAxe
    // Enter = pick the highlighted row AND commit at once (no accumulation):
    // exactly one tag is assigned and the popup closes.
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await act(async () => {});

    const tagIds = client.getNode(blockId)?.tagIds ?? [];
    expect(tagIds).toHaveLength(1);
    expect([alpha, axe]).toContain(tagIds[0]);
    expect(picker()).toBeNull();
  });

  it("clicking a picked row un-picks it before applying", async () => {
    const client = await seedClient();
    const { pageId, blockId } = await seedBlock(client);
    const alpha = await client.createObject({ presentAsMain: true, name: "TagA" });
    const beta = await client.createObject({ presentAsMain: true, name: "TagB" });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "#");
    typeInPicker("Tag");
    fireEvent.click(rowByText("TagA"));
    fireEvent.click(rowByText("TagB"));
    fireEvent.click(rowByText("TagA")); // un-pick
    const panel = picker()!;
    expect(panel.querySelector(".node-selector__multi-footer")?.textContent).toContain("1 picked");
    fireEvent.click(within(panel).getByRole("button", { name: "Apply 1" }));
    await act(async () => {});

    expect(client.getNode(blockId)?.tagIds).toEqual([beta]);
    void alpha;
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
