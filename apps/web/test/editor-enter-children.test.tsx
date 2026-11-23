/**
 * Enter on a block WITH children — the browser-case spec (the ghost-fix
 * act() trap shape): under the WorkerClient the editor's structural reads
 * ride a render cache whose cold keys answer the [] default, and an
 * end-of-text Enter on a block with children would wrongly take the
 * SIBLING branch. The in-process client's reads are always fresh, so a
 * plain spec could never see it — this suite mounts PageView over a PROXY
 * client whose CACHED getChildren answers [] (the cold-cache simulation)
 * while getChildrenFresh/getNodeRawFresh delegate to the real fresh reads.
 * Red against the old code (cached read → sibling), green with the
 * getChildrenFresh contract.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192c000-0000-7000-8000-000000000001";
const ACTOR = "0192c000-0000-7000-8000-000000000002";

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

/** The cold-cache simulation: cached reads that would be cold in the worker
 *  answer their empty default; the *Fresh write-time reads stay real. */
function coldCacheClient(real: WorkspaceClient): WorkspaceClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "getChildren") return () => [];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as WorkspaceClient;
}

function clickIntoBlock(container: HTMLElement, index = 0): HTMLElement {
  const contents = container.querySelectorAll<HTMLElement>(".nt-block-content");
  const target = contents[index];
  if (target === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(target);
  const editor = target.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

describe("Enter on a block with children (the cold-cache browser case)", () => {
  it("at end-of-text creates the new block as the FIRST CHILD, not a sibling", async () => {
    const real = await seedClient();
    const client = coldCacheClient(real);
    const pageId = await real.createObject({ isEmbedded: false, name: "Home" });
    const parent = await real.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    await real.createObject({ parentId: parent, contentAst: [{ type: "text", text: "kid1" }] });
    await real.createObject({ parentId: parent, contentAst: [{ type: "text", text: "kid2" }] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0); // the "parent" block
    // Caret at end of text.
    fireEvent.keyDown(editor, { key: "End" });
    await act(async () => {});
    fireEvent.keyDown(editor, { key: "Enter" });
    await act(async () => {});
    await act(async () => {});

    // The page keeps ONE child (the parent block) — no sibling was added.
    const pageKids = real.getChildren(pageId);
    expect(pageKids.map((n) => n.id)).toEqual([parent]);
    // The new block landed UNDER the parent, BEFORE the existing children.
    const parentKids = real.getChildren(parent);
    expect(parentKids).toHaveLength(3);
    expect((parentKids[1]!.contentAst[0] as { text?: string }).text).toBe("kid1");
    expect((parentKids[2]!.contentAst[0] as { text?: string }).text).toBe("kid2");
    expect(parentKids[0]!.contentAst).toEqual([]);
  });

  it("mid-text on a block with children nests the tail as the FIRST CHILD", async () => {
    const real = await seedClient();
    const client = coldCacheClient(real);
    const pageId = await real.createObject({ isEmbedded: false, name: "Home" });
    const parent = await real.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    await real.createObject({ parentId: parent, contentAst: [{ type: "text", text: "kid1" }] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    // jsdom has no contentEditable caret: place the collapsed range at
    // offset 3 ("par|ent") directly. (Synthetic ArrowRight keydowns would
    // instead trigger the contract's at-end hand-off and move the edit
    // session — the caret must be set as a real selection.)
    const editable = editor.closest("[contenteditable='true']") ?? editor;
    const textNode = editable.firstChild;
    if (textNode === null) throw new Error("editor has no text node");
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.collapse(true);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.keyDown(editable, { key: "Enter" });
    await act(async () => {});
    await act(async () => {});

    const parentKids = real.getChildren(parent);
    expect(parentKids).toHaveLength(2);
    expect((parentKids[1]!.contentAst[0] as { text?: string }).text).toBe("kid1");
    expect((parentKids[0]!.contentAst[0] as { text?: string }).text).toBe("ent");
    // The head stayed in the parent block.
    const head = real.getNode(parent)!;
    expect((head.contentAst[0] as { text?: string }).text).toBe("par");
  });
});
