/**
 * Find-in-page (Capacities parity) — jsdom over the in-process
 * WorkspaceClient:
 *
 *  - Ctrl/Cmd+F opens the find bar over the OPEN page's whole block tree,
 *    searching the DATA (findInPage.ts), so matches inside collapsed/hidden
 *    blocks count exactly like rendered ones;
 *  - the match counter honors the case-sensitive and whole-word toggles;
 *  - prev/next cycles the highlight; the current match's block row scrolls
 *    into view (scrollIntoView stub) and carries the flash class;
 *  - replace writes one object.update per affected block (span swapped inside
 *    the single text token, marks preserved) and the search re-counts;
 *  - a match spanning tokens ("hot dog" across two text tokens, a mention
 *    boundary) is counted for navigation but skipped by replace with a
 *    console-free no-op (the v1 scope, documented in findInPage.ts);
 *  - the honest-handoff rule: Ctrl/Cmd+F keyed while focus sits in an input
 *    that isn't the find bar's own is left to the platform.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { plainTextExcerpt } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import {
  applyReplace,
  buildFindInPageBlock,
  collectSubtreeBlocks,
  findMatchesInBlocks,
  planReplace,
} from "../src/ui/components/findInPage.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  // jsdom never implemented scrollIntoView — stub it so navigation is
  // observable (the bar guards with a typeof check for the same reason).
  Element.prototype.scrollIntoView = vi.fn();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
  vi.clearAllMocks();
});

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

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

interface FindWorld {
  client: WorkspaceClient;
  pageId: string;
  blockA: string;
  toggle: string;
  nested: string;
  capital: string;
  pair: string;
  mentionBlock: string;
}

/**
 * The fixture page: a plain block, a toggle with a nested child (the
 * collapsed-subtree probe), a capitalized block, a two-token "hot"/"dog"
 * block (the cross-token match), and a "con" + mention("cat") block (the
 * mention-boundary probe). "cat" occurrences (case-insensitive): blockA 1,
 * toggle 1, nested 2 ("cat" + "category"), capital 1, mention 1 → 6.
 */
async function seedFindWorld(): Promise<FindWorld> {
  const client = await seedClient();
  const pageId = await client.createObject({ isEmbedded: false, name: "Find Page" });
  const blockA = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "The cat sat on the mat.", marks: ["bold"] }],
  });
  const toggle = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "Toggle cat" }],
  });
  const nested = await client.createObject({
    parentId: toggle,
    contentAst: [{ type: "text", text: "Nested cat category" }],
  });
  const capital = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "Cat napped" }],
  });
  const pair = await client.createObject({
    parentId: pageId,
    contentAst: [
      { type: "text", text: "hot" },
      { type: "text", text: "dog" },
    ],
  });
  const mentionBlock = await client.createObject({
    parentId: pageId,
    contentAst: [
      { type: "text", text: "con" },
      { type: "mention", targetNodeId: blockA, text: "cat" },
    ],
  });
  await flushSync();
  return { client, pageId, blockA, toggle, nested, capital, pair, mentionBlock };
}

function openFindBar(container: HTMLElement): HTMLElement {
  fireEvent.keyDown(container, { key: "f", metaKey: true });
  return screen.getByRole("toolbar", { name: "Find in page" });
}

function countText(container: HTMLElement): string {
  return container.querySelector(".find-in-page__count")!.textContent!;
}

function blockRow(container: HTMLElement, blockId: string): HTMLElement | null {
  return container.querySelector(`[data-block-id="${blockId}"]`);
}

describe("findInPage core", () => {
  it("composes the searchable text exactly like plainTextExcerpt", () => {
    const ast = [
      { type: "text", text: "  hello " },
      { type: "hard_break" },
      { type: "text", text: "world" },
      { type: "mention", targetNodeId: "0192a000-0000-7000-8000-000000000099", text: "M" },
      { type: "quote", children: [{ type: "text", text: "quoted" }] },
      { type: "text", text: "tail" },
    ] as never;
    const block = buildFindInPageBlock("b1", ast);
    expect(block.text).toBe(plainTextExcerpt(ast));
    expect(block.text).toBe("hello world M quoted tail");
    expect(block.provenance.length).toBe(block.text.length);
  });

  it("walks the subtree data-depth-first: nested children included, document order", async () => {
    const { client, pageId, blockA, toggle, nested } = await seedFindWorld();
    const blocks = collectSubtreeBlocks(client, pageId);
    const ids = blocks.map((b) => b.blockId);
    expect(ids).toContain(nested);
    expect(ids.indexOf(blockA)).toBeLessThan(ids.indexOf(toggle));
    expect(ids.indexOf(toggle)).toBeLessThan(ids.indexOf(nested));
  });

  it("finds matches with case and whole-word options; plans single-token replaces only", async () => {
    const { client, pageId, nested, pair } = await seedFindWorld();
    const blocks = collectSubtreeBlocks(client, pageId);
    const all = findMatchesInBlocks(blocks, "cat");
    expect(all.length).toBe(6);

    const sensitive = findMatchesInBlocks(blocks, "cat", { caseSensitive: true });
    expect(sensitive.length).toBe(5);

    const whole = findMatchesInBlocks(blocks, "cat", { wholeWord: true });
    expect(whole.length).toBe(5);
    // "category" drops out; the mention-boundary "cat" is still bounded.
    expect(whole.some((m) => m.blockId === nested && m.end - m.start === 3)).toBe(true);

    const both = findMatchesInBlocks(blocks, "cat", { caseSensitive: true, wholeWord: true });
    expect(both.length).toBe(4);

    // Replace plans: single-text-token matches resolve; cross-token don't.
    const nestedBlock = blocks.find((b) => b.blockId === nested)!;
    const nestedMatch = all.find((m) => m.blockId === nested && m.replaceable)!;
    expect(nestedMatch.replaceable).toBe(true);
    const plan = planReplace(nestedBlock, nestedMatch);
    expect(plan).not.toBeNull();

    const pairBlock = blocks.find((b) => b.blockId === pair)!;
    const pairMatch = findMatchesInBlocks(blocks, "hot dog")[0]!;
    expect(pairMatch.blockId).toBe(pair);
    expect(pairMatch.replaceable).toBe(false);
    expect(planReplace(pairBlock, pairMatch)).toBeNull();

    // The write: span swapped inside the one text token, marks preserved.
    const replaced = applyReplace(nestedBlock.ast, plan!, "dog");
    expect((replaced[0] as { text: string }).text).toBe("Nested dog category");
  });
});

describe("find-in-page bar (Ctrl/Cmd+F)", () => {
  it("opens on Ctrl/Cmd+F, autofocused; mod+F again focuses + selects the input", async () => {
    const { client, pageId } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();

    const bar = openFindBar(container);
    const input = screen.getByRole("textbox", { name: "Find in page" });
    expect(bar.contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);

    // The browser habit: mod+F while open refocuses (and selects) the input.
    fireEvent.change(input, { target: { value: "cat" } });
    act(() => input.blur());
    fireEvent.keyDown(container, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe(3);
  });

  it("hands mod+F off to the platform when focus sits in a foreign field", async () => {
    const { client, pageId } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();

    const foreign = document.createElement("input");
    foreign.setAttribute("aria-label", "foreign");
    document.body.appendChild(foreign);
    act(() => foreign.focus());
    fireEvent.keyDown(foreign, { key: "f", metaKey: true });
    expect(screen.queryByRole("toolbar", { name: "Find in page" })).toBeNull();
    foreign.remove();
  });

  it("counts matches inside collapsed subtrees (the DATA walk)", async () => {
    const { client, pageId, toggle, nested } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    const bar = openFindBar(container);
    const input = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(input, { target: { value: "cat" } });
    expect(countText(bar)).toBe("1/6");

    // Collapse the toggle: the nested row leaves the DOM, the match stays.
    const toggleRow = blockRow(container, toggle)!;
    fireEvent.click(within(toggleRow).getByRole("button", { name: "Collapse block" }));
    expect(blockRow(container, nested)).toBeNull();
    expect(countText(bar)).toBe("1/6");
  });

  it("case-sensitive and whole-word toggles change the count", async () => {
    const { client, pageId } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    const bar = openFindBar(container);
    const input = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(input, { target: { value: "cat" } });
    expect(countText(bar)).toBe("1/6");

    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    expect(countText(bar)).toBe("1/5");
    fireEvent.click(screen.getByRole("button", { name: "Match whole word" }));
    expect(countText(bar)).toBe("1/4");
  });

  it("prev/next cycles; the current match's row scrolls into view and flashes", async () => {
    const { client, pageId, blockA, toggle } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    const bar = openFindBar(container);
    const input = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(input, { target: { value: "cat" } });
    expect(countText(bar)).toBe("1/6");

    // First match: blockA's row is the scroll target and carries the flash.
    expect(blockRow(container, blockA)!.classList.contains("nt-block--flash")).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(countText(bar)).toBe("2/6");
    // Match 2 is the toggle's own "cat": its row flashes, blockA's doesn't.
    expect(blockRow(container, toggle)!.classList.contains("nt-block--flash")).toBe(true);
    expect(blockRow(container, blockA)!.classList.contains("nt-block--flash")).toBe(false);

    // Wrap-around on both ends.
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(countText(bar)).toBe("1/6");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(countText(bar)).toBe("6/6");
  });

  it("replace swaps the span inside the block's text token and re-counts", async () => {
    const { client, pageId, blockA } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    const bar = openFindBar(container);
    const input = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(input, { target: { value: "cat" } });

    fireEvent.click(screen.getByRole("button", { name: "Show replace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replace" }), { target: { value: "dog" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await flushSync();

    const token = client.getNode(blockA)!.contentAst[0] as { text: string; marks?: string[] };
    expect(token.text).toBe("The dog sat on the mat.");
    expect(token.marks).toEqual(["bold"]);
    // The search re-ran off the write's notification: 6 → 5.
    expect(countText(bar)).toBe("1/5");
  });

  it("replace all groups by block; the mention-boundary match is skipped", async () => {
    const { client, pageId, nested, capital, mentionBlock } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    const bar = openFindBar(container);
    const input = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(input, { target: { value: "cat" } });

    fireEvent.click(screen.getByRole("button", { name: "Show replace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replace" }), { target: { value: "dog" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await flushSync();

    const textOf = (id: string) =>
      (client.getNode(id)!.contentAst[0] as { text: string }).text;
    // Both nested matches are single-token → "category" becomes "dogegory".
    expect(textOf(nested)).toBe("Nested dog dogegory");
    // The capitalized "Cat" matched case-insensitively and is rewritten with
    // the replacement verbatim (standard find/replace semantics)…
    expect(textOf(capital)).toBe("dog napped");
    // …and the mention block is untouched: its match spans the token
    // boundary ("con" + mention), the v1 no-op.
    const mentionAst = client.getNode(mentionBlock)!.contentAst;
    expect((mentionAst[0] as { text: string }).text).toBe("con");
    expect((mentionAst[1] as { type: string }).type).toBe("mention");

    // Re-count: only the mention match remains (still navigable) → 1.
    expect(countText(bar)).toBe("1/1");
  });

  it("a cross-token match is counted but not replaceable (disabled, no-op)", async () => {
    const { client, pageId, pair } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    const bar = openFindBar(container);
    const input = screen.getByRole("textbox", { name: "Find in page" });
    fireEvent.change(input, { target: { value: "hot dog" } });
    expect(countText(bar)).toBe("1/1");

    fireEvent.click(screen.getByRole("button", { name: "Show replace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replace" }), { target: { value: "x" } });
    // The current match spans two tokens → replace disabled, replace-all too.
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replace all" })).toBeDisabled();

    // Even driven directly, the write is a console-free no-op (block intact).
    const blocks = collectSubtreeBlocks(client, pageId);
    const match = findMatchesInBlocks(blocks, "hot dog")[0]!;
    const block = blocks.find((b) => b.blockId === pair)!;
    expect(planReplace(block, match)).toBeNull();
  });

  it("Escape closes the bar", async () => {
    const { client, pageId } = await seedFindWorld();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    openFindBar(container);
    expect(screen.getByRole("toolbar", { name: "Find in page" })).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "Find in page" })).toBeNull();
  });
});
